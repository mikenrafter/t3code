import type { OrchestrationUsageGuard, ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  USAGE_GUARD_MAX_RESUME_MS,
  USAGE_GUARD_PROMPT_PERCENT,
  USAGE_GUARD_SETTLE_PERCENT,
  evaluateUsageGuard,
  guardWindowFor,
  resolveGuardResumeAt,
  sameGuardPeriod,
  usageGuardContinuationText,
} from "./UsageGuardPolicy.ts";

const NOW_MS = Date.parse("2026-09-10T12:00:00.000Z");

function sessionWindow(input: {
  readonly usedPercent: number;
  readonly id?: string;
  readonly resetsAt?: string;
  readonly kind?: ServerProviderUsageWindow["kind"];
}): ServerProviderUsageWindow {
  return {
    id: input.id ?? "five_hour",
    kind: input.kind ?? "session",
    label: "Session",
    usedPercent: input.usedPercent,
    ...(input.resetsAt === undefined ? {} : { resetsAt: input.resetsAt }),
  };
}

function guard(input: {
  readonly phase: OrchestrationUsageGuard["phase"];
  readonly windowId?: string;
  readonly windowResetsAt?: string | null;
  readonly suppressUntil?: string | null;
  readonly scheduledAt?: string | null;
  readonly reason?: OrchestrationUsageGuard["reason"];
  readonly summary?: string | null;
}): OrchestrationUsageGuard {
  return {
    windowId: input.windowId ?? "five_hour",
    windowKind: "session",
    usedPercent: 90,
    windowResetsAt: input.windowResetsAt ?? null,
    phase: input.phase,
    reason: input.reason ?? "threshold",
    ...(input.suppressUntil === undefined ? {} : { suppressUntil: input.suppressUntil }),
    ...(input.scheduledAt === undefined ? {} : { scheduledAt: input.scheduledAt }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    updatedAt: "2026-09-10T11:00:00.000Z",
  };
}

describe("guardWindowFor", () => {
  it("picks the most-consumed session-shaped window", () => {
    const selected = guardWindowFor([
      sessionWindow({ usedPercent: 40, id: "five_hour" }),
      sessionWindow({ usedPercent: 72, id: "primary", resetsAt: "2026-09-10T17:00:00.000Z" }),
    ]);
    expect(selected?.window.id).toBe("primary");
    expect(selected?.usedPercent).toBe(72);
  });

  it("skips weekly and monthly windows entirely", () => {
    expect(
      guardWindowFor([sessionWindow({ usedPercent: 95, kind: "weekly", id: "seven_day" })]),
    ).toBeUndefined();
    expect(
      guardWindowFor([sessionWindow({ usedPercent: 95, kind: "monthly", id: "cycle" })]),
    ).toBeUndefined();
  });

  it("returns undefined without windows", () => {
    expect(guardWindowFor([])).toBeUndefined();
  });
});

describe("evaluateUsageGuard", () => {
  it("does nothing below the prompt threshold", () => {
    expect(
      evaluateUsageGuard({
        windows: [sessionWindow({ usedPercent: 89 })],
        guard: null,
        nowMs: NOW_MS,
      }),
    ).toEqual({ action: "none" });
  });

  it("prompts at the prompt threshold without a guard record", () => {
    const evaluation = evaluateUsageGuard({
      windows: [sessionWindow({ usedPercent: USAGE_GUARD_PROMPT_PERCENT })],
      guard: null,
      nowMs: NOW_MS,
    });
    expect(evaluation.action).toBe("prompt");
  });

  it("settles at the settle threshold without a guard record", () => {
    const evaluation = evaluateUsageGuard({
      windows: [sessionWindow({ usedPercent: USAGE_GUARD_SETTLE_PERCENT })],
      guard: null,
      nowMs: NOW_MS,
    });
    expect(evaluation.action).toBe("settle");
  });

  it("does not re-prompt a window period already answered", () => {
    const windows = [sessionWindow({ usedPercent: 91, resetsAt: "2026-09-10T17:00:00.000Z" })];
    const evaluation = evaluateUsageGuard({
      windows,
      guard: guard({ phase: "prompted", windowResetsAt: "2026-09-10T17:00:00.000Z" }),
      nowMs: NOW_MS,
    });
    expect(evaluation).toEqual({ action: "none" });
  });

  it("escalates a prompted window to settle once the settle threshold crosses", () => {
    const evaluation = evaluateUsageGuard({
      windows: [sessionWindow({ usedPercent: 96, resetsAt: "2026-09-10T17:00:00.000Z" })],
      guard: guard({ phase: "prompted", windowResetsAt: "2026-09-10T17:00:00.000Z" }),
      nowMs: NOW_MS,
    });
    expect(evaluation.action).toBe("settle");
  });

  it("leaves a paused window alone — it waits for its schedule", () => {
    const evaluation = evaluateUsageGuard({
      windows: [sessionWindow({ usedPercent: 97, resetsAt: "2026-09-10T17:00:00.000Z" })],
      guard: guard({ phase: "paused", windowResetsAt: "2026-09-10T17:00:00.000Z" }),
      nowMs: NOW_MS,
    });
    expect(evaluation).toEqual({ action: "none" });
  });

  it("a suppressed window stays quiet until its suppression lapses", () => {
    const resetsAt = "2026-09-10T17:00:00.000Z";
    const evaluation = evaluateUsageGuard({
      windows: [sessionWindow({ usedPercent: 95, resetsAt })],
      guard: guard({ phase: "suppressed", windowResetsAt: resetsAt, suppressUntil: resetsAt }),
      nowMs: NOW_MS,
    });
    expect(evaluation).toEqual({ action: "none" });
  });

  it("re-arms after a suppressed window's suppression lapses", () => {
    const evaluation = evaluateUsageGuard({
      windows: [sessionWindow({ usedPercent: 95, resetsAt: "2026-09-10T17:00:00.000Z" })],
      guard: guard({
        phase: "suppressed",
        windowResetsAt: "2026-09-10T17:00:00.000Z",
        suppressUntil: "2026-09-10T11:00:00.000Z",
      }),
      nowMs: NOW_MS,
    });
    expect(evaluation.action).toBe("settle");
  });

  it("a window reset makes the thresholds fresh again despite an answered guard", () => {
    // Same window id, later reset: the pair distinguishes the period, so the
    // previous window's suppression cannot silence the new one.
    const evaluation = evaluateUsageGuard({
      windows: [sessionWindow({ usedPercent: 91, resetsAt: "2026-09-10T22:00:00.000Z" })],
      guard: guard({
        phase: "suppressed",
        windowResetsAt: "2026-09-10T17:00:00.000Z",
        suppressUntil: "2026-09-10T17:00:00.000Z",
      }),
      nowMs: NOW_MS,
    });
    expect(evaluation.action).toBe("prompt");
  });
});

describe("sameGuardPeriod", () => {
  it("matches id and reset time together", () => {
    const window = { id: "five_hour", resetsAt: "2026-09-10T17:00:00.000Z" } as const;
    expect(
      sameGuardPeriod({ windowId: "five_hour", windowResetsAt: window.resetsAt }, window),
    ).toBe(true);
    expect(sameGuardPeriod({ windowId: "five_hour", windowResetsAt: null }, window)).toBe(false);
    expect(sameGuardPeriod({ windowId: "primary", windowResetsAt: window.resetsAt }, window)).toBe(
      false,
    );
  });
});

describe("resolveGuardResumeAt", () => {
  it("resumes at the window's reset when it is within the cap", () => {
    const resetsAt = "2026-09-10T13:30:00.000Z";
    expect(resolveGuardResumeAt({ window: { kind: "session", resetsAt }, nowMs: NOW_MS })).toBe(
      resetsAt,
    );
  });

  it("caps the resume at five hours out", () => {
    const cap = new Date(NOW_MS + USAGE_GUARD_MAX_RESUME_MS).toISOString();
    expect(
      resolveGuardResumeAt({
        window: { kind: "session", resetsAt: "2026-09-10T23:00:00.000Z" },
        nowMs: NOW_MS,
      }),
    ).toBe(cap);
  });

  it("falls back to the five-hour cap without a reset time", () => {
    const cap = new Date(NOW_MS + USAGE_GUARD_MAX_RESUME_MS).toISOString();
    expect(resolveGuardResumeAt({ window: { kind: "session" }, nowMs: NOW_MS })).toBe(cap);
  });

  it("never resumes a weekly or monthly window", () => {
    expect(
      resolveGuardResumeAt({
        window: { kind: "weekly", resetsAt: "2026-09-10T13:00:00.000Z" },
        nowMs: NOW_MS,
      }),
    ).toBeNull();
    expect(resolveGuardResumeAt({ window: { kind: "monthly" }, nowMs: NOW_MS })).toBeNull();
  });
});

describe("usageGuardContinuationText", () => {
  it("reports the wait, the cause, and the relevance decision", () => {
    const text = usageGuardContinuationText({
      guard: { reason: "threshold", summary: "Claude's five-hour window reached 95%" },
      waitedMs: 90 * 60_000,
      now: "2026-09-10T17:00:00.000Z",
    });
    expect(text).toContain("1h 30m ago");
    expect(text).toContain("Claude's five-hour window reached 95%");
    expect(text).toContain("judge whether the work you were doing is still relevant");
    expect(text).toContain("explain to the user what the blocker is");
  });

  it("falls back to a generic cause per trigger kind", () => {
    const errorText = usageGuardContinuationText({
      guard: { reason: "provider_error" },
      waitedMs: 30_000,
      now: "2026-09-10T17:00:00.000Z",
    });
    expect(errorText).toContain("the provider reported that its usage limit was reached");
    expect(errorText).toContain("less than a minute ago");

    const thresholdText = usageGuardContinuationText({
      guard: { reason: "threshold" },
      waitedMs: 2 * 60_000,
      now: "2026-09-10T17:00:00.000Z",
    });
    expect(thresholdText).toContain("the provider's usage window was nearly exhausted");
    expect(thresholdText).toContain("2 minutes ago");
  });
});
