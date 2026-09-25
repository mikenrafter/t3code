import type {
  AgentSessionEntry,
  AgentSessionSource,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";

import { formatContextWindowTokens } from "../../lib/contextWindow";
import { normalizeSearchText } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";

/** Raised in steps as the user asks for more history. Filtering stays client-side. */
export const PAGE_LIMITS = [15, 45, 90, 200] as const;
export type PageLimit = (typeof PAGE_LIMITS)[number];

export type ProviderFilter = "all" | AgentSessionSource;

/** ImportThreadSheet-local: list sessions across every project on the server. */
export const IMPORT_THREAD_PROJECT_AUTOMATIC = "automatic" as const;

export type ImportThreadProjectSelection =
  | typeof IMPORT_THREAD_PROJECT_AUTOMATIC
  | `${EnvironmentId}:${ProjectId}`;

export function isAutomaticImportProjectSelection(
  selection: string | null,
): selection is typeof IMPORT_THREAD_PROJECT_AUTOMATIC {
  return selection === IMPORT_THREAD_PROJECT_AUTOMATIC;
}

/**
 * Environment used for the Automatic list RPC: primary when set, else the first
 * project's environment.
 */
export function resolveImportListEnvironmentId(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly projects: ReadonlyArray<{ readonly environmentId: EnvironmentId }>;
}): EnvironmentId | null {
  return input.primaryEnvironmentId ?? input.projects[0]?.environmentId ?? null;
}

/**
 * Destination project for attach: entry's project when Automatic, else the
 * picker selection.
 */
export function resolveImportAttachProject<T extends { readonly id: ProjectId }>(input: {
  readonly automatic: boolean;
  readonly entryProjectId: ProjectId;
  readonly projects: ReadonlyArray<T>;
  readonly selectedProject: T | null;
}): T | null {
  if (input.automatic) {
    return input.projects.find((project) => project.id === input.entryProjectId) ?? null;
  }
  return input.selectedProject;
}

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

/** How much history attach imports. Server defaults to compaction when omitted. */
export type ImportHistoryMode = "compaction" | "full";

/** Client default until Settings / sheet control overrides it. */
export const DEFAULT_IMPORT_HISTORY_MODE: ImportHistoryMode = "compaction";

/**
 * Reason a listed row cannot be attached, or null when the row is importable.
 */
export function importThreadRowBlockedReason(entry: AgentSessionEntry): string | null {
  if (entry.importable) return null;
  const reason = entry.importBlockedReason?.trim();
  return reason && reason.length > 0 ? reason : "This session cannot be imported.";
}

/** True when the row should render disabled / non-clickable. */
export function isImportThreadRowDisabled(entry: AgentSessionEntry): boolean {
  return importThreadRowBlockedReason(entry) !== null;
}

/**
 * Independent context chips for the import row: max, used, and native percent
 * each format on their own when present (no derived percent from used/max).
 */
export function formatImportThreadContextParts(
  entry: Pick<AgentSessionEntry, "contextMaxTokens" | "contextUsedTokens" | "contextUsagePercent">,
): {
  readonly maxLabel: string | null;
  readonly usedLabel: string | null;
  readonly percentLabel: string | null;
} {
  const maxLabel =
    entry.contextMaxTokens !== undefined
      ? `${formatContextWindowTokens(entry.contextMaxTokens)} max`
      : null;
  const usedLabel =
    entry.contextUsedTokens !== undefined
      ? `${formatContextWindowTokens(entry.contextUsedTokens)} used`
      : null;
  const percentLabel =
    entry.contextUsagePercent !== undefined ? `${Math.round(entry.contextUsagePercent)}%` : null;
  return { maxLabel, usedLabel, percentLabel };
}

/** Short relative labels for created and last-message times. */
export function formatImportThreadTimeParts(
  entry: Pick<AgentSessionEntry, "createdAt" | "lastMessageAt">,
): {
  readonly createdLabel: string | null;
  readonly lastMessageLabel: string | null;
} {
  const createdLabel = formatRelativeTimeLabel(entry.createdAt);
  const lastMessageLabel = formatRelativeTimeLabel(entry.lastMessageAt);
  return {
    createdLabel: createdLabel && createdLabel.length > 0 ? createdLabel : null,
    lastMessageLabel: lastMessageLabel && lastMessageLabel.length > 0 ? lastMessageLabel : null,
  };
}
