import type { AgentSessionEntry, AgentSessionSource } from "@t3tools/contracts";

import { normalizeSearchText } from "../../lib/utils";

/** Raised in steps as the user asks for more history. Filtering stays client-side. */
export const PAGE_LIMITS = [15, 45, 90, 200] as const;
export type PageLimit = (typeof PAGE_LIMITS)[number];

export type ProviderFilter = "all" | AgentSessionSource;

export type ImportThreadEmptyState =
  | { readonly kind: "no-recent" }
  | { readonly kind: "all-imported" }
  | { readonly kind: "no-matches" }
  | { readonly kind: "provider-empty"; readonly provider: AgentSessionSource };

/**
 * Next page size above `current`, or `null` when already at the largest limit.
 * Accepts values outside PAGE_LIMITS so a stale/custom limit still advances.
 */
export function nextPageLimit(current: number): number | null {
  for (const limit of PAGE_LIMITS) {
    if (limit > current) return limit;
  }
  return null;
}

export function providerLabel(provider: AgentSessionSource): string {
  switch (provider) {
    case "claudeAgent":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
  }
}

export function filterImportThreadEntries(
  entries: ReadonlyArray<AgentSessionEntry>,
  options: { readonly query: string; readonly provider: ProviderFilter },
): AgentSessionEntry[] {
  const normalizedQuery = normalizeSearchText(options.query);
  return entries.filter((entry) => {
    if (options.provider !== "all" && entry.provider !== options.provider) {
      return false;
    }
    if (normalizedQuery.length === 0) return true;
    const haystack = normalizeSearchText(
      `${entry.title} ${entry.promptPreview} ${providerLabel(entry.provider)}`,
    );
    return haystack.includes(normalizedQuery);
  });
}

/**
 * Empty copy when the filtered list is vacant. The server omits sessions already
 * in T3; `filteredAlreadyImportedCount` drives the "all imported" empty state.
 */
export function computeImportThreadEmptyState(input: {
  readonly serverEntryCount: number;
  readonly filteredAlreadyImportedCount?: number;
  readonly filteredEntries: ReadonlyArray<AgentSessionEntry>;
  readonly query: string;
  readonly provider: ProviderFilter;
}): ImportThreadEmptyState | null {
  if (input.filteredEntries.length > 0) return null;

  if (normalizeSearchText(input.query).length > 0) {
    return { kind: "no-matches" };
  }
  if (input.provider !== "all") {
    return { kind: "provider-empty", provider: input.provider };
  }
  if ((input.filteredAlreadyImportedCount ?? 0) > 0) {
    return { kind: "all-imported" };
  }
  return { kind: "no-recent" };
}

export function importThreadEmptyStateMessage(state: ImportThreadEmptyState): string {
  switch (state.kind) {
    case "no-recent":
      return "No recent Claude, Codex, or Cursor sessions for this project.";
    case "all-imported":
      return "Every recent session for this project is already in T3.";
    case "no-matches":
      return "No sessions match your search.";
    case "provider-empty":
      return `No recent ${providerLabel(state.provider)} sessions for this project.`;
  }
}

/**
 * Project to list against: caller's scope, else the active thread's project,
 * else the first project in the caller's ordered list.
 */
export function resolveDefaultImportProject<T>(input: {
  readonly preferred: T | null;
  readonly activeThreadProject: T | null;
  readonly projects: ReadonlyArray<T>;
}): T | null {
  return input.preferred ?? input.activeThreadProject ?? input.projects[0] ?? null;
}
