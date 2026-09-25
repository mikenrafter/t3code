import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Coding agent home directories the scanner knows how to read. */
export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex", "cursor"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

/** File identity saved with an imported session so bounded retries can skip unchanged history. */
export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  inode: Schema.NullOr(Schema.Number),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

/** Imported message ids retain their origin after event metadata is projected into SQLite. */
export function isImportedAgentSessionMessageId(messageId: string): boolean {
  return messageId.startsWith("import:");
}

/**
 * Empty for now. Kept as a struct so future scan options (source filters,
 * explicit roots) can be added without a new method.
 */
export const AgentSessionScanInput = Schema.Struct({});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

/**
 * A directory that at least one agent CLI has run in, suitable for import as a
 * T3 Code project. `alreadyImported` marks candidates that already have an
 * active project rooted at the same path.
 */
/**
 * Git identity of a candidate directory, read from `.git/config` without
 * spawning git. `remoteKey` is the normalized origin URL, shared by every
 * clone of the same repository so the client can group them. `repository`
 * is the GitHub `owner/name` when the origin is on GitHub.
 */
export const AgentSessionProjectGit = Schema.Struct({
  remoteKey: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
});
export type AgentSessionProjectGit = typeof AgentSessionProjectGit.Type;

export const AgentSessionProjectCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  /**
   * `null` when the directory is not the root of a git repository. Missing on
   * servers that predate the git scan, where the client cannot tell repositories
   * from plain folders and should treat every candidate as a standalone project.
   */
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedError<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedError<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

/**
 * Raised in steps as the user asks for more history. Filtering stays client-side.
 * Omit `projectId` for Automatic: list recent sessions across every active project.
 */
/** How much pre-compaction history to retain when attaching a session. */
export const AgentSessionHistoryMode = Schema.Literals(["compaction", "full"]);
export type AgentSessionHistoryMode = typeof AgentSessionHistoryMode.Type;

export const AgentSessionListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(PositiveInt),
});
export type AgentSessionListInput = typeof AgentSessionListInput.Type;

/** Native provider percent (0–100). Never derived from used/max on the wire. */
export const AgentSessionContextUsagePercent = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 100 }),
);
export type AgentSessionContextUsagePercent = typeof AgentSessionContextUsagePercent.Type;

export const AgentSessionEntry = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  promptPreview: TrimmedNonEmptyString,
  lastActiveAt: IsoDateTime,
  /** When the session was created, when the provider exposes it. */
  createdAt: IsoDateTime,
  /** Timestamp of the latest retained message (or last activity). */
  lastMessageAt: IsoDateTime,
  cwd: TrimmedNonEmptyString,
  /** Project this session belongs to (always set, including single-project lists). */
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  alreadyImported: Schema.Boolean,
  /** Max context window size when the provider reports it. */
  contextMaxTokens: Schema.optional(NonNegativeInt),
  /**
   * Used tokens for compacted-history view (post-summary when a compact summary
   * exists; otherwise the latest usage). Prefer this when "Use compacted chats"
   * is on.
   */
  contextUsedTokens: Schema.optional(NonNegativeInt),
  /**
   * Used tokens for full-history view (pre-summary peak when a compact summary
   * exists; otherwise same as `contextUsedTokens`). Listed beside the compact
   * value so the client can toggle without re-scanning.
   */
  contextUsedTokensFull: Schema.optional(NonNegativeInt),
  /**
   * Native context usage percent from the provider (e.g. Cursor
   * `composerData.contextUsagePercent`). Present alone without used/max is valid;
   * used+max without percent is also valid. Do not derive this from used/max.
   */
  contextUsagePercent: Schema.optional(AgentSessionContextUsagePercent),
  /** False when the row is listed but cannot be attached (e.g. oversized). */
  importable: Schema.Boolean,
  /** Present when `importable === false`. */
  importBlockedReason: Schema.optional(TrimmedNonEmptyString),
  /** True when the transcript contains Claude `isCompactSummary` records. */
  hasCompactionSummary: Schema.Boolean,
});
export type AgentSessionEntry = typeof AgentSessionEntry.Type;

export const AgentSessionProviderError = Schema.Struct({
  provider: AgentSessionSource,
  message: TrimmedNonEmptyString,
});
export type AgentSessionProviderError = typeof AgentSessionProviderError.Type;

export const AgentSessionListResult = Schema.Struct({
  entries: Schema.Array(AgentSessionEntry),
  providerErrors: Schema.Array(AgentSessionProviderError),
  /**
   * Sessions discovery found but omitted because T3 already has them (imported
   * threads or a live binding to the same provider session). Drives the empty
   * "all already in T3" copy when `entries` is empty.
   */
  filteredAlreadyImportedCount: Schema.optional(NonNegativeInt),
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionListResult = typeof AgentSessionListResult.Type;

export const AgentSessionAttachInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  /** Server defaults to `compaction` when omitted. */
  historyMode: Schema.optional(AgentSessionHistoryMode),
});
export type AgentSessionAttachInput = typeof AgentSessionAttachInput.Type;

export const AgentSessionAttachResult = Schema.Struct({
  threadId: ThreadId,
  created: Schema.Boolean,
});
export type AgentSessionAttachResult = typeof AgentSessionAttachResult.Type;

export class AgentSessionUnavailableError extends Schema.TaggedError<AgentSessionUnavailableError>()(
  "AgentSessionUnavailableError",
  {
    providerInstanceId: ProviderInstanceId,
    providerSessionId: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' is no longer available from '${this.providerInstanceId}'.`;
  }
}

/** Listed session that cannot be attached (oversized transcript, etc.). */
export class AgentSessionImportBlockedError extends Schema.TaggedError<AgentSessionImportBlockedError>()(
  "AgentSessionImportBlockedError",
  {
    providerInstanceId: ProviderInstanceId,
    providerSessionId: TrimmedNonEmptyString,
    importBlockedReason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return this.importBlockedReason;
  }
}

export class AgentSessionAttachDeletedThreadError extends Schema.TaggedError<AgentSessionAttachDeletedThreadError>()(
  "AgentSessionAttachDeletedThreadError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' was deleted. Restore it instead of importing the session again.`;
  }
}

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to scan agent sessions during ${this.operation}.`;
  }
}
