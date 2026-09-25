import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionAttachDeletedThreadError,
  AgentSessionImportBlockedError,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
  AgentSessionUnavailableError,
  EventId,
  isImportedAgentSessionMessageId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type AgentSessionAttachInput,
  type AgentSessionAttachResult,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type AgentSessionImportSource,
  type AgentSessionListInput,
  type AgentSessionListResult,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_SESSION_LIST_LIMIT = 15;

/** Serialize concurrent attaches of the same session so only one thread.create lands. */
const attachLocks = new Map<string, Semaphore.Semaphore>();

const lockForAttach = (key: string): Semaphore.Semaphore => {
  const existing = attachLocks.get(key);
  if (existing !== undefined) return existing;
  const created = Effect.runSync(Semaphore.make(1));
  attachLocks.set(key, created);
  return created;
};

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: Schema.Literals(["claudeAgent", "codex", "cursor"]),
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' changed before its history import completed.`;
  }
}

function hasImportedHistory(thread: OrchestrationThread): boolean {
  return thread.messages.some((message) => isImportedAgentSessionMessageId(message.id));
}

function hasImportBlockingActivity(
  thread: OrchestrationThread,
  importedHistoryPresent: boolean,
): boolean {
  return (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.latestTurn !== null ||
    thread.session !== null ||
    thread.messages.some((message) => !isImportedAgentSessionMessageId(message.id)) ||
    thread.proposedPlans.length > 0 ||
    thread.activities.length > 0 ||
    thread.checkpoints.length > 0 ||
    thread.snoozedUntil != null ||
    thread.snoozedAt != null ||
    thread.pinnedAt != null ||
    thread.pinOrderKey != null ||
    thread.titleRegeneration != null ||
    thread.linkedPullRequest != null ||
    thread.unsettledAt != null ||
    (importedHistoryPresent
      ? thread.settledOverride !== "settled"
      : thread.settledOverride !== null || thread.settledAt !== null)
  );
}

/** Independent context fields from a session descriptor — never cross-derive percent ↔ tokens. */
type ImportContextWindowSeed = {
  readonly contextUsedTokens?: number;
  readonly contextMaxTokens?: number;
  readonly contextUsagePercent?: number;
};

function buildImportContextWindowPayload(
  context: ImportContextWindowSeed | undefined,
): Record<string, number> | null {
  if (context === undefined) return null;
  const payload: Record<string, number> = {
    ...(context.contextUsedTokens !== undefined ? { usedTokens: context.contextUsedTokens } : {}),
    ...(context.contextMaxTokens !== undefined ? { maxTokens: context.contextMaxTokens } : {}),
    // Native provider percent only — map to activity usedPercentage for the client meter.
    ...(context.contextUsagePercent !== undefined
      ? { usedPercentage: context.contextUsagePercent }
      : {}),
  };
  return Object.keys(payload).length > 0 ? payload : null;
}

const resolveImportProject = Effect.fn("resolveImportProject")(function* (input: {
  readonly projectId: ProjectId;
  readonly expectedWorkspaceRoot?: string;
}) {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const project = yield* snapshots.getProjectShellById(input.projectId).pipe(
    Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
        onSome: Effect.succeed,
      }),
    ),
  );
  if (
    input.expectedWorkspaceRoot !== undefined &&
    normalizeProjectPathForComparison(project.workspaceRoot) !==
      normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
  ) {
    return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
  }
  return project;
});

/**
 * Import one discovered session into a project thread. Shared by bulk import and
 * single-session attach so resume cursors and history commands stay identical.
 */
const importDiscoveredSession = Effect.fn("importDiscoveredSession")(function* (input: {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly thread: AgentSessionScanner.AgentSessionThread;
  readonly source: AgentSessionImportSource;
  readonly context?: ImportContextWindowSeed;
}) {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;
  const thread = input.thread;
  const threadId = ThreadId.make(`import:${thread.providerInstanceId}:${thread.providerSessionId}`);
  const provider = ProviderDriverKind.make(thread.source);
  const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
  const existingThread = yield* snapshots.getThreadDetailById(threadId);
  const existingBinding = yield* directory.getBinding(threadId);

  if (
    thread.source === "claudeAgent" &&
    !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
  ) {
    return yield* new AgentSessionUnresumableSessionError({
      source: thread.source,
      providerSessionId: thread.providerSessionId,
    });
  }

  if (Option.isSome(existingThread) && existingThread.value.projectId !== input.projectId) {
    return yield* new AgentSessionThreadProjectConflictError({
      threadId,
      expectedProjectId: input.projectId,
      actualProjectId: existingThread.value.projectId,
    });
  }

  const importedHistoryPresent = Option.isSome(existingThread)
    ? hasImportedHistory(existingThread.value)
    : false;
  // Cursor IDE/CLI chat ids are not proven to load via ACP session/load, so
  // imports are history-only: create the thread + messages without a resume
  // binding. Already-imported Cursor threads therefore have history and no
  // binding, unlike Claude/Codex which install a resume cursor first.
  const historyOnlyImport = thread.source === "cursor";
  if (
    Option.isSome(existingThread) &&
    importedHistoryPresent &&
    (Option.isSome(existingBinding) || historyOnlyImport)
  ) {
    yield* directory.recordImportedTranscript({ threadId, source: input.source });
    return { threadId, created: false } as const;
  }

  if (
    Option.isSome(existingThread) &&
    hasImportBlockingActivity(existingThread.value, importedHistoryPresent)
  ) {
    return yield* new AgentSessionThreadModifiedError({ threadId });
  }

  if (
    Option.isSome(existingBinding) &&
    (existingBinding.value.provider !== provider ||
      existingBinding.value.providerInstanceId !== thread.providerInstanceId ||
      existingBinding.value.status !== "stopped")
  ) {
    return yield* new AgentSessionThreadModifiedError({ threadId });
  }

  // Install the cursor before the thread becomes visible. A concurrent
  // real session can replace it, while insert-ignore keeps this import
  // from replacing that newer binding. Cursor skips this: ACP cannot
  // reliably resume chats/<md5>/<agentId> ids, and a false takeover claim
  // is worse than history-only.
  if (Option.isNone(existingBinding) && !historyOnlyImport) {
    yield* directory.upsert(
      {
        threadId,
        provider,
        providerInstanceId: thread.providerInstanceId,
        status: "stopped",
        runtimeMode: DEFAULT_RUNTIME_MODE,
        resumeCursor:
          thread.source === "codex"
            ? { threadId: thread.providerSessionId }
            : { threadId, resume: thread.providerSessionId },
        runtimePayload: { cwd: input.workspaceRoot },
      },
      { onConflict: "ignore" },
    );
  }

  let created = false;
  if (Option.isNone(existingThread)) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      threadId,
      projectId: input.projectId,
      title: thread.title,
      modelSelection: { instanceId: thread.providerInstanceId, model },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: thread.createdAt,
      historyImport: true,
    });
    created = true;
  }

  if (!importedHistoryPresent) {
    yield* engine.dispatch({
      type: "thread.history.import",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      threadId,
      messages: thread.messages.map((message, index) => ({
        messageId: MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`),
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
      })),
    });

    // Seed a turnless context-window activity from known descriptor fields only —
    // never derive percent from used/max or invent tokens from a native percent.
    const contextPayload = buildImportContextWindowPayload(input.context);
    if (contextPayload !== null) {
      const createdAt = new Date().toISOString();
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        threadId,
        activity: {
          id: EventId.make(yield* crypto.randomUUIDv4),
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload: contextPayload,
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    }
  }

  yield* directory.recordImportedTranscript({ threadId, source: input.source });

  return { threadId, created } as const;
});

/** Import recent transcript text and persist the cursor needed to resume its provider session. */
export const importRecentAgentThreads = Effect.fn("importRecentAgentThreads")(function* (
  input: AgentSessionImportInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const project = yield* resolveImportProject(input);
  const workspaceRoot = project.workspaceRoot;
  const completedSources = yield* snapshots
    .getImportedAgentSessionSources(input.projectId)
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  const threads = scanner.recentThreads(
    workspaceRoot,
    completedSources.map((entry) => entry.source),
  );
  const importedThreadIds = new Set<ThreadId>();
  let importedCount = 0;
  let skippedCount = 0;

  yield* Stream.runForEach(threads, (outcome) =>
    Effect.gen(function* () {
      if (outcome._tag === "Skipped") {
        skippedCount += 1;
        return;
      }
      if (outcome._tag === "AlreadyImported" || outcome._tag === "Duplicate") {
        const threadId = ThreadId.make(
          `import:${outcome.source.providerInstanceId}:${outcome.source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (importedThreadIds.has(threadId)) {
          const recorded = yield* directory
            .recordImportedTranscript({ threadId, source: outcome.source })
            .pipe(Effect.result);
          if (recorded._tag === "Failure") {
            skippedCount += 1;
            yield* Effect.logWarning("Could not record an imported transcript copy", {
              threadId,
              cause: recorded.failure,
            });
          }
        }
        return;
      }
      const imported = yield* importDiscoveredSession({
        projectId: input.projectId,
        workspaceRoot,
        thread: outcome.thread,
        source: outcome.source,
      }).pipe(
        Effect.map(() => true),
        Effect.catch((cause) =>
          Effect.logWarning("Could not import an agent session", {
            provider: outcome.thread.source,
            sessionId: outcome.thread.providerSessionId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

      if (imported) {
        importedThreadIds.add(
          ThreadId.make(
            `import:${outcome.thread.providerInstanceId}:${outcome.thread.providerSessionId}`,
          ),
        );
        importedCount += 1;
      } else {
        skippedCount += 1;
      }
    }),
  );

  return { importedCount, skippedCount } satisfies AgentSessionImportResult;
});

type ListedSessionProject = {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
};

type ProjectSessionPage = {
  readonly entries: AgentSessionListResult["entries"];
  readonly filteredAlreadyImportedCount: number;
  readonly providerErrors: AgentSessionListResult["providerErrors"];
  readonly truncated: boolean;
  readonly discoveredCount: number;
};

const listSessionsForProject = Effect.fn("listSessionsForProject")(function* (input: {
  readonly project: ListedSessionProject;
  readonly limit: number;
  readonly historyMode: "compaction" | "full";
  readonly scanner: AgentSessionScanner.AgentSessionScanner["Service"];
  readonly snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"];
}) {
  const knownSessionKeys = yield* collectKnownProviderSessionKeys({
    projectId: input.project.id,
    snapshots: input.snapshots,
    directory: input.directory,
  });

  // Inflate the discovery window so already-owned sessions don't eat the page.
  const scanLimit = Math.min(200, input.limit + knownSessionKeys.size);
  const page = yield* input.scanner.listRecentSessionDescriptors(
    input.project.workspaceRoot,
    scanLimit,
    { historyMode: input.historyMode },
  );

  const entries: Array<AgentSessionListResult["entries"][number]> = [];
  let filteredAlreadyImportedCount = 0;
  for (const descriptor of page.descriptors) {
    const sessionKey = `${descriptor.providerInstanceId}\0${descriptor.providerSessionId}`;
    const threadId = ThreadId.make(
      `import:${descriptor.providerInstanceId}:${descriptor.providerSessionId}`,
    );
    const existingImport = yield* input.snapshots
      .getThreadDetailById(threadId)
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const alreadyOwned =
      knownSessionKeys.has(sessionKey) ||
      (Option.isSome(existingImport) && existingImport.value.deletedAt === null);

    if (alreadyOwned) {
      filteredAlreadyImportedCount += 1;
      continue;
    }
    if (entries.length >= input.limit) {
      continue;
    }
    entries.push({
      provider: descriptor.source,
      providerInstanceId: descriptor.providerInstanceId,
      providerSessionId: descriptor.providerSessionId,
      title: descriptor.title,
      promptPreview: descriptor.promptPreview,
      lastActiveAt: descriptor.lastActiveAt,
      createdAt: descriptor.createdAt ?? descriptor.lastActiveAt,
      lastMessageAt: descriptor.lastMessageAt ?? descriptor.lastActiveAt,
      cwd: descriptor.cwd,
      projectId: input.project.id,
      projectTitle: input.project.title,
      alreadyImported: false,
      ...(descriptor.contextMaxTokens !== undefined
        ? { contextMaxTokens: descriptor.contextMaxTokens }
        : {}),
      ...(descriptor.contextUsedTokens !== undefined
        ? { contextUsedTokens: descriptor.contextUsedTokens }
        : {}),
      ...(descriptor.contextUsagePercent !== undefined
        ? { contextUsagePercent: descriptor.contextUsagePercent }
        : {}),
      importable: descriptor.importable ?? true,
      ...(descriptor.importBlockedReason !== undefined
        ? { importBlockedReason: descriptor.importBlockedReason }
        : {}),
      hasCompactionSummary: descriptor.hasCompactionSummary ?? false,
    });
  }

  const truncated =
    page.truncated || page.descriptors.length > entries.length + filteredAlreadyImportedCount;

  return {
    entries,
    filteredAlreadyImportedCount,
    providerErrors: page.providerErrors.map((failure) => ({
      provider: failure.source,
      message: failure.message,
    })),
    truncated,
    discoveredCount: page.descriptors.length,
  } satisfies ProjectSessionPage;
});

function mergeProviderErrors(
  pages: ReadonlyArray<Pick<ProjectSessionPage, "providerErrors">>,
): AgentSessionListResult["providerErrors"] {
  const byProvider = new Map<string, AgentSessionListResult["providerErrors"][number]>();
  for (const page of pages) {
    for (const error of page.providerErrors) {
      if (!byProvider.has(error.provider)) {
        byProvider.set(error.provider, error);
      }
    }
  }
  return [...byProvider.values()];
}

/** Newest first; when tied, stable by provider session key. */
function compareSessionsByRecency(
  left: AgentSessionListResult["entries"][number],
  right: AgentSessionListResult["entries"][number],
): number {
  if (left.lastActiveAt !== right.lastActiveAt) {
    return right.lastActiveAt.localeCompare(left.lastActiveAt);
  }
  const leftKey = `${left.providerInstanceId}\0${left.providerSessionId}`;
  const rightKey = `${right.providerInstanceId}\0${right.providerSessionId}`;
  return leftKey.localeCompare(rightKey);
}

/**
 * Keep the newest row per provider session when the same transcript appears
 * under more than one project root.
 */
function dedupeSessionsByProviderSession(
  entries: ReadonlyArray<AgentSessionListResult["entries"][number]>,
): AgentSessionListResult["entries"] {
  const sorted = [...entries].sort(compareSessionsByRecency);
  const seen = new Set<string>();
  const deduped: Array<AgentSessionListResult["entries"][number]> = [];
  for (const entry of sorted) {
    const key = `${entry.providerInstanceId}\0${entry.providerSessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

/** List recent provider sessions for a project (or all projects), newest first. */
export const listAgentSessions = Effect.fn("listAgentSessions")(function* (
  input: AgentSessionListInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const limit = input.limit ?? DEFAULT_SESSION_LIST_LIMIT;
  const historyMode = input.historyMode ?? "compaction";

  const projects: ListedSessionProject[] = [];
  if (input.projectId !== undefined) {
    const project = yield* resolveImportProject({
      projectId: input.projectId,
      ...(input.expectedWorkspaceRoot !== undefined
        ? { expectedWorkspaceRoot: input.expectedWorkspaceRoot }
        : {}),
    });
    projects.push({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
    });
  } else {
    // Automatic: every active shell project on this environment.
    const shellSnapshot = yield* snapshots
      .getShellSnapshot()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    for (const project of shellSnapshot.projects) {
      projects.push({
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      });
    }
  }

  const pages: ProjectSessionPage[] = [];
  for (const project of projects) {
    pages.push(
      yield* listSessionsForProject({
        project,
        limit,
        historyMode,
        scanner,
        snapshots,
        directory,
      }),
    );
  }

  const mergedEntries = dedupeSessionsByProviderSession(pages.flatMap((page) => page.entries));
  const entries = mergedEntries.slice(0, limit);
  const filteredAlreadyImportedCount = pages.reduce(
    (sum, page) => sum + page.filteredAlreadyImportedCount,
    0,
  );
  const providerErrors = mergeProviderErrors(pages);
  const truncated =
    pages.some((page) => page.truncated) ||
    mergedEntries.length > limit ||
    pages.some(
      (page) => page.discoveredCount > page.entries.length + page.filteredAlreadyImportedCount,
    );

  return {
    entries,
    providerErrors,
    ...(filteredAlreadyImportedCount > 0 ? { filteredAlreadyImportedCount } : {}),
    ...(truncated ? { truncated: true } : {}),
  } satisfies AgentSessionListResult;
});

function providerSessionIdFromResumeCursor(resumeCursor: unknown): string | null {
  if (typeof resumeCursor !== "object" || resumeCursor === null) return null;
  const record = resumeCursor as Record<string, unknown>;
  if (typeof record.sessionId === "string" && record.sessionId.trim().length > 0) {
    return record.sessionId.trim();
  }
  if (typeof record.resume === "string" && record.resume.trim().length > 0) {
    return record.resume.trim();
  }
  // Codex stores the native thread id as `threadId` with no `resume` field.
  if (
    typeof record.threadId === "string" &&
    record.threadId.trim().length > 0 &&
    record.resume === undefined &&
    record.sessionId === undefined
  ) {
    return record.threadId.trim();
  }
  return null;
}

const collectKnownProviderSessionKeys = Effect.fn("collectKnownProviderSessionKeys")(
  function* (input: {
    readonly projectId: ProjectId;
    readonly snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    readonly directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"];
  }) {
    const keys = new Set<string>();
    const imported = yield* input.snapshots
      .getImportedAgentSessionSources(input.projectId)
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    for (const entry of imported) {
      keys.add(`${entry.source.providerInstanceId}\0${entry.source.providerSessionId}`);
    }

    const bindings = yield* input.directory
      .listBindings()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    for (const binding of bindings) {
      const sessionId = providerSessionIdFromResumeCursor(binding.resumeCursor);
      if (sessionId === null) continue;
      keys.add(`${binding.providerInstanceId}\0${sessionId}`);
    }
    return keys;
  },
);

/** Attach one provider session as a project thread, or navigate to it if already imported. */
export const attachAgentSession = Effect.fn("attachAgentSession")(function* (
  input: AgentSessionAttachInput,
) {
  const lock = lockForAttach(`${input.providerInstanceId}\0${input.providerSessionId}`);
  return yield* lock.withPermits(1)(
    Effect.gen(function* () {
      const scanner = yield* AgentSessionScanner.AgentSessionScanner;
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const crypto = yield* Crypto.Crypto;
      const project = yield* resolveImportProject(input);
      const workspaceRoot = project.workspaceRoot;
      const threadId = ThreadId.make(
        `import:${input.providerInstanceId}:${input.providerSessionId}`,
      );

      const existingThread = yield* snapshots
        .getThreadDetailById(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
          ),
        );

      if (Option.isSome(existingThread) && hasImportedHistory(existingThread.value)) {
        // Includes Cursor history-only imports, which deliberately omit a resume binding.
        if (existingThread.value.deletedAt !== null) {
          return yield* new AgentSessionAttachDeletedThreadError({ threadId });
        }
        if (existingThread.value.archivedAt !== null) {
          yield* engine.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
          });
        }
        return { threadId, created: false } satisfies AgentSessionAttachResult;
      }

      const historyMode = input.historyMode ?? "compaction";
      const page = yield* scanner.listRecentSessionDescriptors(workspaceRoot, 10_000, {
        historyMode,
      });
      const matchingDescriptor = page.descriptors.find(
        (descriptor) =>
          descriptor.providerInstanceId === input.providerInstanceId &&
          descriptor.providerSessionId === input.providerSessionId,
      );
      if (matchingDescriptor === undefined) {
        return yield* new AgentSessionUnavailableError({
          providerInstanceId: input.providerInstanceId,
          providerSessionId: input.providerSessionId,
        });
      }
      if (matchingDescriptor.importable === false) {
        return yield* new AgentSessionImportBlockedError({
          providerInstanceId: input.providerInstanceId,
          providerSessionId: input.providerSessionId,
          importBlockedReason:
            matchingDescriptor.importBlockedReason ??
            "Session transcript exceeds the import record limit",
        });
      }

      const outcomes = yield* scanner.recentThreads(workspaceRoot, undefined, { historyMode }).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
      const importable = outcomes.find(
        (outcome) =>
          outcome._tag === "Importable" &&
          outcome.thread.providerInstanceId === input.providerInstanceId &&
          outcome.thread.providerSessionId === input.providerSessionId,
      );
      if (importable === undefined || importable._tag !== "Importable") {
        return yield* new AgentSessionUnavailableError({
          providerInstanceId: input.providerInstanceId,
          providerSessionId: input.providerSessionId,
        });
      }

      return yield* importDiscoveredSession({
        projectId: input.projectId,
        workspaceRoot,
        thread: importable.thread,
        source: importable.source,
        // Re-read from the list descriptor: recentThreads carries messages, not context meta.
        context: {
          ...(matchingDescriptor.contextUsedTokens !== undefined
            ? { contextUsedTokens: matchingDescriptor.contextUsedTokens }
            : {}),
          ...(matchingDescriptor.contextMaxTokens !== undefined
            ? { contextMaxTokens: matchingDescriptor.contextMaxTokens }
            : {}),
          ...(matchingDescriptor.contextUsagePercent !== undefined
            ? { contextUsagePercent: matchingDescriptor.contextUsagePercent }
            : {}),
        },
      });
    }),
  );
});
