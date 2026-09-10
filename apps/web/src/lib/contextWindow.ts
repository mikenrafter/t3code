import {
  DEFAULT_THREAD_CONTEXT_TOKEN_LIMIT,
  type OrchestrationThreadActivity,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  let latest:
    | { readonly activity: OrchestrationThreadActivity; readonly usedTokens: number }
    | undefined;
  for (const activity of activities) {
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    if (latest === undefined || compareContextWindowActivityOrder(latest.activity, activity) <= 0) {
      latest = { activity, usedTokens };
    }
  }

  if (latest !== undefined) {
    const { activity, usedTokens } = latest;
    const payload = asRecord(activity.payload);

    const maxTokens = asFiniteNumber(payload?.maxTokens);
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: asFiniteNumber(payload?.inputTokens),
      cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
      outputTokens: asFiniteNumber(payload?.outputTokens),
      reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
      lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(payload?.toolUses),
      durationMs: asFiniteNumber(payload?.durationMs),
      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
      autoCompactThreshold: asFiniteNumber(payload?.autoCompactThreshold),
      estimated: asBoolean(payload?.estimated) ?? false,
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

function compareContextWindowActivityOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  const sequenceComparison =
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
  if (sequenceComparison !== 0) return sequenceComparison;

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) return createdAtComparison;

  return left.id.localeCompare(right.id);
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function contextWindowReachedThreadLimit(
  snapshot: ContextWindowSnapshot | null,
  tokenLimit = DEFAULT_THREAD_CONTEXT_TOKEN_LIMIT,
): boolean {
  return snapshot !== null && snapshot.usedTokens >= tokenLimit;
}

export const THREAD_CACHE_TTL_MS = 5 * 60_000;
const CACHE_NEW_THREAD_TOKENS = 100_000;

export type ThreadCacheFreshness = {
  /** False once the snapshot is older than the prompt-cache TTL. */
  readonly cached: boolean;
  /** Whole minutes of cache life left; only meaningful while cached. */
  readonly minutesRemaining: number;
  readonly uncachedTokens: number;
};

/**
 * Prompt-cache freshness from the usage snapshot alone. The provider refreshes
 * its prompt cache on every model request, so the latest snapshot's age is the
 * cache's age; past Claude's 5-minute TTL the next turn re-reads the whole
 * context. Only the providers whose caches we can see (Claude, Codex) feed this.
 */
export function threadCacheFreshness(
  snapshot: Pick<ContextWindowSnapshot, "usedTokens" | "updatedAt"> | null,
  nowMs: number,
): ThreadCacheFreshness | null {
  if (snapshot === null || snapshot.usedTokens <= 0) return null;
  const updatedAtMs = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return null;
  // A client clock behind the server's reads as a just-refreshed cache, never
  // as negative cache life.
  const elapsedMs = Math.max(0, nowMs - updatedAtMs);
  if (elapsedMs >= THREAD_CACHE_TTL_MS) {
    return { cached: false, minutesRemaining: 0, uncachedTokens: snapshot.usedTokens };
  }
  const minutesRemaining = Math.floor((THREAD_CACHE_TTL_MS - elapsedMs) / 60_000);
  // Under a minute of life left is not worth a notice; the uncached copy takes
  // over when the TTL lapses.
  if (minutesRemaining < 1) return null;
  return { cached: true, minutesRemaining, uncachedTokens: snapshot.usedTokens };
}

export function formatThreadCacheNotice(freshness: ThreadCacheFreshness): string {
  if (freshness.cached) {
    return `This thread is cached for the next ${freshness.minutesRemaining} ${
      freshness.minutesRemaining === 1 ? "minute" : "minutes"
    }.`;
  }
  const notice = `This thread is uncached at ${formatContextWindowTokens(freshness.uncachedTokens)} tokens.`;
  return freshness.uncachedTokens > CACHE_NEW_THREAD_TOKENS
    ? `${notice} Consider starting a new thread.`
    : notice;
}
