import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionAttachDeletedThreadError,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
  AgentSessionUnavailableError,
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

/** List recent provider sessions for a project, newest first. */
export const listAgentSessions = Effect.fn("listAgentSessions")(function* (
  input: AgentSessionListInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const project = yield* resolveImportProject(input);
  const limit = input.limit ?? DEFAULT_SESSION_LIST_LIMIT;

  const knownSessionKeys = yield* collectKnownProviderSessionKeys({
    projectId: project.id,
    snapshots,
    directory,
  });

  // Inflate the discovery window so already-owned sessions don't eat the page.
  const scanLimit = Math.min(200, limit + knownSessionKeys.size);
  const page = yield* scanner.listRecentSessionDescriptors(project.workspaceRoot, scanLimit);

  const entries: AgentSessionListResult["entries"] = [];
  let filteredAlreadyImportedCount = 0;
  for (const descriptor of page.descriptors) {
    const sessionKey = `${descriptor.providerInstanceId}\0${descriptor.providerSessionId}`;
    const threadId = ThreadId.make(
      `import:${descriptor.providerInstanceId}:${descriptor.providerSessionId}`,
    );
    const existingImport = yield* snapshots
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
    if (entries.length >= limit) {
      continue;
    }
    entries.push({
      provider: descriptor.source,
      providerInstanceId: descriptor.providerInstanceId,
      providerSessionId: descriptor.providerSessionId,
      title: descriptor.title,
      promptPreview: descriptor.promptPreview,
      lastActiveAt: descriptor.lastActiveAt,
      cwd: descriptor.cwd,
      alreadyImported: false,
    });
  }

  const truncated =
    page.truncated || page.descriptors.length > entries.length + filteredAlreadyImportedCount;

  return {
    entries,
    providerErrors: page.providerErrors.map((failure) => ({
      provider: failure.source,
      message: failure.message,
    })),
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

      const page = yield* scanner.listRecentSessionDescriptors(workspaceRoot, 10_000);
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

      const outcomes = yield* scanner.recentThreads(workspaceRoot).pipe(
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
      });
    }),
  );
});
