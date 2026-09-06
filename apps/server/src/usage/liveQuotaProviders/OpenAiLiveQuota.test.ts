import { describe, expect, it } from "@effect/vitest";

import { buildOpenAiSnapshot } from "./OpenAiLiveQuota.ts";

describe("OpenAiLiveQuota", () => {
  it("maps Codex's primary and secondary rolling limits to the 5h and weekly meters", () => {
    const snapshot = buildOpenAiSnapshot(
      {
        rateLimits: {
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
        },
      },
      "person@example.com",
      1_799_982_000_000,
    );

    expect(snapshot.provider).toBe("openai");
    expect(snapshot.primary.windowMinutes).toBe(300);
    expect(snapshot.primary.displayValue).toBe("25%");
    expect(snapshot.secondary?.windowMinutes).toBe(10_080);
    expect(snapshot.secondary?.displayValue).toBe("50%");
    expect(snapshot.secondary?.resetDescription).toBe("Resets in 7d");
  });

  it("formats sub-day windows with hours and minutes", () => {
    const snapshot = buildOpenAiSnapshot(
      { rateLimits: { primary: { usedPercent: 25, resetsAt: 1_800_000_000 } } },
      null,
      1_799_982_000_000,
    );

    expect(snapshot.primary.resetDescription).toBe("Resets in 5h 0m");
  });
});
