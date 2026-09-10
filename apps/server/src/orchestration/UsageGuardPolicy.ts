import { DateTime } from "effect";
import type { OrchestrationUsageGuard, ServerProviderUsageWindow } from "@t3tools/contracts";

/**
 * Pure decision rules for the usage-window guard: which window to react to,
 * which threshold a percentage crosses, and when a paused thread may resume.
 *
 * The guard is preemptive (read from the provider windows #9507 streams into
 * each instance snapshot — Claude's `rate_limit_event`, Codex's
 * `account/rateLimits/updated`) and reactive (a provider stop classed
 * `usage_limit`, #10550). Providers that publish neither windows nor a
 * limitable error get no guard; that is a per-adapter decision recorded in
 * the plan, not a fallback guess.
 *
 * @module orchestration/UsageGuardPolicy
 */

/**
 * Hardcoded by design (plan: usage-window guard): 90% prompts the user to
 * wait or compact, 95% acts. No settings UI; users who always want to ride a
 * window out press "don't compact, keep going", which suppresses both.
 */
export const USAGE_GUARD_PROMPT_PERCENT = 90;
export const USAGE_GUARD_SETTLE_PERCENT = 95;

/**
 * Cap on how far out an auto-resume may be scheduled. Providers' reported
 * resets are usually 5h or less; anything longer (a weekly window) waits for
 * the user instead of silently resuming days later.
 */
export const USAGE_GUARD_MAX_RESUME_MS = 5 * 60 * 60 * 1000;

/**
 * The windows whose exhaustion the guard acts on, most-consumed first. Only
 * session-shaped windows drive the thresholds: a billing-cycle meter
 * (`monthly`/`other`) has no reset the thread can wait out, and a weekly
 * window may only schedule a pause (never an unattended multi-day resume).
 * A daily/other window acts like a session when the provider reports a
 * reset time for it.
 */
export function guardWindowFor(windows: ReadonlyArray<ServerProviderUsageWindow>):
  | {
      readonly window: ServerProviderUsageWindow;
      readonly usedPercent: number;
    }
  | undefined {
  let best: ServerProviderUsageWindow | undefined;
  for (const window of windows) {
    if (window.kind === "weekly" || window.kind === "monthly") continue;
    if (best === undefined || window.usedPercent > best.usedPercent) best = window;
  }
  return best === undefined ? undefined : { window: best, usedPercent: best.usedPercent };
}

export type UsageGuardEvaluation =
  | { readonly action: "none" }
  | {
      readonly action: "prompt";
      readonly window: ServerProviderUsageWindow;
      readonly usedPercent: number;
    }
  | {
      readonly action: "settle";
      readonly window: ServerProviderUsageWindow;
      readonly usedPercent: number;
    };

/**
 * One evaluation per (window period, threshold): the guard record answers for
 * its window period — id plus reset time, the pair that survives resets on
 * the same window id — so a warning is never re-prompted every tick and a
 * suppressed window never re-arms until it resets.
 */
export function evaluateUsageGuard(input: {
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly guard: OrchestrationUsageGuard | null;
  readonly nowMs: number;
}): UsageGuardEvaluation {
  const selected = guardWindowFor(input.windows);
  if (selected === undefined) {
    return { action: "none" };
  }
  const { window, usedPercent } = selected;
  const guard = input.guard;
  if (guard !== null && sameGuardPeriod(guard, window)) {
    // Suppressed windows ride until their reset (or, without a known reset,
    // until a different period arrives) — the user's keep-going press covers
    // both thresholds for this window.
    if (
      guard.phase === "suppressed" &&
      (guard.suppressUntil === null ||
        guard.suppressUntil === undefined ||
        Date.parse(guard.suppressUntil) > input.nowMs)
    ) {
      return { action: "none" };
    }
    if (guard.phase === "prompted" || guard.phase === "paused") {
      // Already answered this period; only a strictly later threshold may
      // escalate (prompted → settle). A paused thread is settled and waits
      // for its schedule; the thresholds no longer apply.
      if (guard.phase === "prompted" && usedPercent >= USAGE_GUARD_SETTLE_PERCENT) {
        return { action: "settle", window, usedPercent };
      }
      return { action: "none" };
    }
  }
  if (usedPercent >= USAGE_GUARD_SETTLE_PERCENT) {
    return { action: "settle", window, usedPercent };
  }
  if (usedPercent >= USAGE_GUARD_PROMPT_PERCENT) {
    return { action: "prompt", window, usedPercent };
  }
  return { action: "none" };
}

/** The guard record's window period against a live window's. */
export function sameGuardPeriod(
  guard: Pick<OrchestrationUsageGuard, "windowId" | "windowResetsAt">,
  window: Pick<ServerProviderUsageWindow, "id" | "resetsAt">,
): boolean {
  return (
    guard.windowId === window.id && (guard.windowResetsAt ?? null) === (window.resetsAt ?? null)
  );
}

/**
 * The auto-resume time for a settled thread. Session windows (and error
 * stops without window data) resume at the window's reset, capped 5h out so
 * a misreported reset can never park a thread for days; weekly windows do
 * not auto-resume at all — the user decides when days-long work is still
 * worth relaunching.
 */
export function resolveGuardResumeAt(input: {
  readonly window: Pick<ServerProviderUsageWindow, "kind" | "resetsAt">;
  readonly nowMs: number;
}): string | null {
  if (input.window.kind === "weekly" || input.window.kind === "monthly") {
    return null;
  }
  const resetMs = input.window.resetsAt === undefined ? null : Date.parse(input.window.resetsAt);
  const targetMs =
    resetMs !== null && Number.isFinite(resetMs) && resetMs > input.nowMs
      ? Math.min(resetMs, input.nowMs + USAGE_GUARD_MAX_RESUME_MS)
      : input.nowMs + USAGE_GUARD_MAX_RESUME_MS;
  return DateTime.formatIso(DateTime.makeUnsafe(targetMs));
}

/**
 * The continuation message the guard's resume turns into the thread's next
 * user message. The model must decide for itself whether the waited-out work
 * is still relevant — and end the turn with the perceived blocker when it
 * is not — so the note informs about the pause rather than instructing a
 * blind continuation.
 */
export function usageGuardContinuationText(input: {
  readonly guard: Pick<OrchestrationUsageGuard, "summary" | "reason">;
  readonly waitedMs: number;
  readonly now: string;
}): string {
  const waited = describeGuardWait(input.waitedMs);
  const cause =
    input.guard.summary ??
    (input.guard.reason === "provider_error"
      ? "the provider reported that its usage limit was reached"
      : "the provider's usage window was nearly exhausted");
  return [
    `[T3 auto-resume] This thread was paused ${waited} ago because ${cause}; the usage window has now reset.`,
    "Before continuing, judge whether the work you were doing is still relevant after the wait — the context may have moved on while the thread was paused.",
    "If it is, continue where you left off. If it is not, end your turn and explain to the user what the blocker is instead of continuing blindly.",
  ].join(" ");
}

function describeGuardWait(waitedMs: number): string {
  if (waitedMs < 60_000) return "less than a minute";
  const minutes = Math.round(waitedMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${hours}h ${remainder}m`;
}
