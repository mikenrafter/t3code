import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  contextWindowReachedThreadLimit,
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
  formatThreadCacheNotice,
  threadCacheFreshness,
} from "./contextWindow";

function makeActivity(
  id: string,
  kind: string,
  payload: unknown,
  options: { readonly sequence?: number; readonly createdAt?: string } = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    ...(options.sequence === undefined ? {} : { sequence: options.sequence }),
    createdAt: options.createdAt ?? "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
        autoCompactThreshold: 200_000,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
    expect(snapshot?.autoCompactThreshold).toBe(200_000);
    expect(snapshot?.estimated).toBe(false);
  });

  it("carries the estimated flag from derived snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 12_000,
        estimated: true,
      }),
    ]);

    expect(snapshot?.estimated).toBe(true);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("uses canonical activity order after compaction instead of array order", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity(
        "activity-current",
        "context-window.updated",
        { usedTokens: 20_000, maxTokens: 250_000 },
        { sequence: 12, createdAt: "2026-03-23T00:02:00.000Z" },
      ),
      makeActivity(
        "activity-stale",
        "context-window.updated",
        { usedTokens: 250_000, maxTokens: 250_000 },
        { sequence: 11, createdAt: "2026-03-23T00:01:00.000Z" },
      ),
    ]);

    expect(snapshot?.usedTokens).toBe(20_000);
    expect(contextWindowReachedThreadLimit(snapshot)).toBe(false);
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });

  it("recognizes the hard thread limit from the latest snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 250_000,
        maxTokens: 400_000,
      }),
    ]);

    expect(contextWindowReachedThreadLimit(snapshot)).toBe(true);
    expect(contextWindowReachedThreadLimit(snapshot, 300_000)).toBe(false);
  });

  describe("threadCacheFreshness", () => {
    const updatedAt = "2026-03-23T00:00:00.000Z";
    const snapshot = { usedTokens: 14_000, updatedAt };

    it("reports cache life remaining inside the TTL", () => {
      expect(threadCacheFreshness(snapshot, Date.parse(updatedAt) + 2 * 60_000)).toEqual({
        cached: true,
        minutesRemaining: 3,
        uncachedTokens: 14_000,
      });
    });

    it("reports uncached once the TTL lapses", () => {
      expect(threadCacheFreshness(snapshot, Date.parse(updatedAt) + 5 * 60_000)).toEqual({
        cached: false,
        minutesRemaining: 0,
        uncachedTokens: 14_000,
      });
    });

    it("hides the notice for the last seconds of cache life", () => {
      expect(
        threadCacheFreshness(snapshot, Date.parse(updatedAt) + 4 * 60_000 + 30_000),
      ).toBeNull();
    });

    it("reads a client clock behind the server as freshly cached", () => {
      expect(threadCacheFreshness(snapshot, Date.parse(updatedAt) - 60_000)).toEqual({
        cached: true,
        minutesRemaining: 5,
        uncachedTokens: 14_000,
      });
    });

    it("skips threads without usage", () => {
      expect(threadCacheFreshness(null, Date.parse(updatedAt))).toBeNull();
      expect(threadCacheFreshness({ usedTokens: 0, updatedAt }, Date.parse(updatedAt))).toBeNull();
    });
  });

  describe("formatThreadCacheNotice", () => {
    it("formats the cached copy", () => {
      expect(
        formatThreadCacheNotice({ cached: true, minutesRemaining: 3, uncachedTokens: 14_000 }),
      ).toBe("This thread is cached for the next 3 minutes.");
      expect(
        formatThreadCacheNotice({ cached: true, minutesRemaining: 1, uncachedTokens: 14_000 }),
      ).toBe("This thread is cached for the next 1 minute.");
    });

    it("formats the uncached copy with the token count", () => {
      expect(
        formatThreadCacheNotice({ cached: false, minutesRemaining: 0, uncachedTokens: 82_000 }),
      ).toBe("This thread is uncached at 82k tokens.");
    });

    it("suggests a new thread above 100k uncached tokens", () => {
      expect(
        formatThreadCacheNotice({ cached: false, minutesRemaining: 0, uncachedTokens: 100_001 }),
      ).toBe("This thread is uncached at 100k tokens. Consider starting a new thread.");
      expect(
        formatThreadCacheNotice({ cached: false, minutesRemaining: 0, uncachedTokens: 100_000 }),
      ).toBe("This thread is uncached at 100k tokens.");
    });
  });
});
