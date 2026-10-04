import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionAttachDeletedThreadError,
  AgentSessionImportBlockedError,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionSource,
  AgentSessionUnavailableError,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionAttachInput,
  type AgentSessionAttachResult,
  type AgentSessionHistoryMode,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type AgentSessionListInput,
  type AgentSessionListResult,
  type ThreadTokenUsageSnapshot,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const DEFAULT_SESSION_LIST_LIMIT = 15;
/** Largest page the list RPC may ask the scanner for; owned sessions inflate the window up to this. */
const MAX_SESSION_SCAN_LIMIT = 200;
const DEFAULT_BLOCKED_REASON = "Session transcript exceeds the import record limit";
const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
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
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

/** Context fields known for a listed session. Percent and tokens are never derived from each other. */
type ImportContextSeed = Pick<
  ThreadTokenUsageSnapshot,
  "usedTokens" | "maxTokens" | "usedPercentage"
>;

/** Seed the imported provider thread's context meter with the descriptor's known fields only. */
function contextSeedForHistoryMode(
  descriptor: AgentSessionScanner.AgentSessionDescriptor,
  historyMode: AgentSessionHistoryMode,
): ImportContextSeed {
  const usedTokens =
    historyMode === "full"
      ? (descriptor.contextUsedTokensFull ?? descriptor.contextUsedTokens)
      : descriptor.contextUsedTokens;
  return {
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    // The snapshot schema wants a positive window size.
    ...(descriptor.contextMaxTokens !== undefined && descriptor.contextMaxTokens > 0
      ? { maxTokens: descriptor.contextMaxTokens }
      : {}),
    ...(descriptor.contextUsagePercent !== undefined
      ? { usedPercentage: descriptor.contextUsagePercent }
      : {}),
  };
}

function providerSessionIdFromResumeCursor(resumeCursor: unknown): string | null {
  if (typeof resumeCursor !== "object" || resumeCursor === null) return null;
  const record = resumeCursor as Record<string, unknown>;
  for (const key of ["sessionId", "resume"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
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

const isDeclaredAttachError = Schema.is(
  Schema.Union([
    AgentSessionAttachDeletedThreadError,
    AgentSessionImportBlockedError,
    AgentSessionUnavailableError,
    AgentSessionImportProjectChangedError,
    AgentSessionImportProjectNotFoundError,
    AgentSessionScanError,
  ]),
);

const sessionKey = (providerInstanceId: string, providerSessionId: string) =>
  `${providerInstanceId}\0${providerSessionId}`;

type ListedEntry = AgentSessionListResult["entries"][number];

/** Newest first; ties break on the provider session key so pages are stable. */
function compareSessionsByRecency(left: ListedEntry, right: ListedEntry): number {
  if (left.lastActiveAt !== right.lastActiveAt) {
    return right.lastActiveAt.localeCompare(left.lastActiveAt);
  }
  return sessionKey(left.providerInstanceId, left.providerSessionId).localeCompare(
    sessionKey(right.providerInstanceId, right.providerSessionId),
  );
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

  const toScanError = (cause: unknown) =>
    new AgentSessionScanError({ operation: "read-projects", cause });

  const resolveProject = Effect.fn("resolveAgentSessionProject")(function* (input: {
    readonly projectId: ProjectId;
    readonly expectedWorkspaceRoot?: string | undefined;
  }) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(toScanError),
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
   * Create one imported thread: the shared path behind bulk import and the picker's attach.
   * Claude and Codex also get a stopped runtime row whose resume cursor lets the provider
   * continue the session. Cursor chat ids are not proven resumable as a runtime session,
   * so Cursor gets history and its native identity only.
   */
  const importDiscoveredSession = Effect.fn("importDiscoveredSessionV2")(function* (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly thread: AgentSessionScanner.AgentSessionThread;
    readonly source: AgentSessionImportSource;
    readonly context?: ImportContextSeed;
  }) {
    const thread = input.thread;
    const threadId = ThreadId.make(
      `import:${thread.providerInstanceId}:${thread.providerSessionId}`,
    );
    if (
      thread.source === "claudeAgent" &&
      !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
    ) {
      return yield* new AgentSessionUnresumableSessionError({
        source: thread.source,
        providerSessionId: thread.providerSessionId,
      });
    }
    const resumable = thread.source !== "cursor";
    const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
    if (Option.isSome(existing)) {
      if (existing.value.thread.projectId !== input.projectId) {
        return yield* new AgentSessionThreadProjectConflictError({
          threadId,
          expectedProjectId: input.projectId,
          actualProjectId: existing.value.thread.projectId,
        });
      }
      if (existing.value.thread.historyOrigin !== "v1_import") {
        return yield* new AgentSessionThreadModifiedError({ threadId });
      }
      if (resumable) {
        yield* runtimes.recordImportedTranscript({ threadId, source: input.source });
      }
      return { threadId, created: false } as const;
    }

    const driver = ProviderDriverKind.make(thread.source);
    const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
    const providerThreadId = idAllocator.derive.providerThread({
      driver,
      nativeThreadId: thread.providerSessionId,
    });
    const createdAt = dateTime(thread.createdAt);
    const updatedAt = dateTime(thread.updatedAt);
    const appThread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId: input.projectId,
      title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
      providerInstanceId: thread.providerInstanceId,
      modelSelection: { instanceId: thread.providerInstanceId, model },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: providerThreadId,
      historyOrigin: "v1_import",
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt,
      updatedAt,
      archivedAt: null,
      settledOverride: "settled",
      settledAt: updatedAt,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const hasContext = input.context !== undefined && Object.keys(input.context).length > 0;
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId: thread.providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: {
        driver,
        nativeId: thread.providerSessionId,
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      ...(hasContext ? { contextUsage: input.context } : {}),
      createdAt,
      updatedAt,
    };

    if (resumable) {
      yield* runtimes.upsert(
        {
          threadId,
          providerName: driver,
          providerInstanceId: thread.providerInstanceId,
          adapterKey: driver,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          status: "stopped",
          lastSeenAt: thread.updatedAt,
          resumeCursor:
            thread.source === "codex"
              ? { threadId: thread.providerSessionId }
              : { threadId, resume: thread.providerSessionId },
          runtimePayload: { cwd: input.workspaceRoot },
        },
        { onConflict: "ignore" },
      );
    }
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
          type: "thread.created",
          threadId,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: createdAt,
          payload: appThread,
        },
        ...thread.messages.flatMap((message, index) => messageEvents({ threadId, index, message })),
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: updatedAt,
          payload: providerThread,
        },
      ],
    });
    if (resumable) {
      yield* runtimes.recordImportedTranscript({ threadId, source: input.source });
    }
    return { threadId, created: true } as const;
  });

  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* resolveProject(input);
    const runtimeRows = yield* runtimes.list().pipe(Effect.mapError(toScanError));
    const completedSources = runtimeRows.flatMap((runtime) => {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return [];
      }
      return payload.value.importedTranscripts ?? [];
    });
    const outcomes = scanner.recentThreads(project.workspaceRoot, completedSources, {
      includeCursor: false,
    });
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          skippedCount += 1;
          return;
        }
        const source = outcome.source;
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* importDiscoveredSession({
          projectId: input.projectId,
          workspaceRoot: project.workspaceRoot,
          thread: outcome.thread,
          source,
        }).pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (imported) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else {
          skippedCount += 1;
        }
      }),
    );

    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  /** Sessions T3 already holds a runtime row or imported transcript for, keyed by instance + session. */
  const collectKnownSessionKeys = Effect.fn("collectKnownAgentSessionKeys")(function* () {
    const keys = new Set<string>();
    const rows = yield* runtimes.list().pipe(Effect.mapError(toScanError));
    for (const row of rows) {
      if (row.providerInstanceId !== null) {
        const sessionId = providerSessionIdFromResumeCursor(row.resumeCursor);
        if (sessionId !== null) keys.add(sessionKey(row.providerInstanceId, sessionId));
      }
      const payload = decodeImportedTranscriptPayload(row.runtimePayload);
      if (Option.isSome(payload)) {
        for (const source of payload.value.importedTranscripts ?? []) {
          keys.add(sessionKey(source.providerInstanceId, source.providerSessionId));
        }
      }
    }
    return keys;
  });

  const listAgentSessions = Effect.fn("listAgentSessionsV2")(function* (
    input: AgentSessionListInput,
  ) {
    const limit = input.limit ?? DEFAULT_SESSION_LIST_LIMIT;
    const listed =
      input.projectId !== undefined
        ? [
            yield* resolveProject({
              projectId: input.projectId,
              expectedWorkspaceRoot: input.expectedWorkspaceRoot,
            }),
          ]
        : // Automatic: every active project in this environment.
          yield* projects.listShells().pipe(Effect.mapError(toScanError));
    const knownKeys = yield* collectKnownSessionKeys();
    // Inflate the window so owned sessions do not eat the page.
    const scanLimit = Math.min(MAX_SESSION_SCAN_LIMIT, limit + knownKeys.size);

    const entries: Array<ListedEntry> = [];
    const providerErrors = new Map<string, AgentSessionListResult["providerErrors"][number]>();
    let filteredAlreadyImportedCount = 0;
    let truncated = false;
    for (const project of listed) {
      const page = yield* scanner
        .listRecentSessionDescriptors(project.workspaceRoot, scanLimit)
        .pipe(Effect.mapError(toScanError));
      truncated ||= page.truncated;
      for (const failure of page.providerErrors) {
        if (!providerErrors.has(failure.source)) {
          providerErrors.set(failure.source, {
            provider: failure.source,
            message: failure.message,
          });
        }
      }
      for (const descriptor of page.descriptors) {
        const threadId = ThreadId.make(
          `import:${descriptor.providerInstanceId}:${descriptor.providerSessionId}`,
        );
        // An archived import still owns the session; a deleted one frees it for a fresh attach.
        const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
        const owned =
          knownKeys.has(sessionKey(descriptor.providerInstanceId, descriptor.providerSessionId)) ||
          (Option.isSome(existing) && !Predicate.isNotNullish(existing.value.thread.deletedAt));
        if (owned) {
          filteredAlreadyImportedCount += 1;
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
          projectId: project.id,
          projectTitle: project.title,
          alreadyImported: false,
          ...(descriptor.contextMaxTokens !== undefined
            ? { contextMaxTokens: descriptor.contextMaxTokens }
            : {}),
          ...(descriptor.contextUsedTokens !== undefined
            ? { contextUsedTokens: descriptor.contextUsedTokens }
            : {}),
          ...(descriptor.contextUsedTokensFull !== undefined
            ? { contextUsedTokensFull: descriptor.contextUsedTokensFull }
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
    }

    // The same transcript can show up under two project roots: keep the newest row.
    const seen = new Set<string>();
    const unique = entries.toSorted(compareSessionsByRecency).filter((entry) => {
      const key = sessionKey(entry.providerInstanceId, entry.providerSessionId);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const page = unique.slice(0, limit);
    return {
      entries: page,
      providerErrors: [...providerErrors.values()],
      ...(filteredAlreadyImportedCount > 0 ? { filteredAlreadyImportedCount } : {}),
      ...(truncated || unique.length > page.length ? { truncated: true } : {}),
    } satisfies AgentSessionListResult;
  });

  /** One attach at a time per provider session, so concurrent clicks land one thread. */
  const attachLocks = new Map<string, Semaphore.Semaphore>();
  const lockForAttach = (key: string) => {
    const existing = attachLocks.get(key);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    attachLocks.set(key, created);
    return created;
  };

  const attachAgentSession = Effect.fn("attachAgentSessionV2")(function* (
    input: AgentSessionAttachInput,
  ) {
    const lock = lockForAttach(sessionKey(input.providerInstanceId, input.providerSessionId));
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          const project = yield* resolveProject(input);
          const workspaceRoot = project.workspaceRoot;
          const threadId = ThreadId.make(
            `import:${input.providerInstanceId}:${input.providerSessionId}`,
          );

          const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
          if (Option.isSome(existing)) {
            if (Predicate.isNotNullish(existing.value.thread.deletedAt)) {
              return yield* new AgentSessionAttachDeletedThreadError({ threadId });
            }
            if (Predicate.isNotNullish(existing.value.thread.archivedAt)) {
              const commandId = yield* idAllocator.allocate.command({
                fixtureName: "agent-session-attach",
                commandName: "thread.unarchive",
              });
              yield* orchestrator.dispatch({ type: "thread.unarchive", commandId, threadId });
            }
            return { threadId, created: false } satisfies AgentSessionAttachResult;
          }

          const historyMode = input.historyMode ?? "compaction";
          const page = yield* scanner.listRecentSessionDescriptors(workspaceRoot, 10_000);
          const descriptor = page.descriptors.find(
            (candidate) =>
              candidate.providerInstanceId === input.providerInstanceId &&
              candidate.providerSessionId === input.providerSessionId,
          );
          if (descriptor === undefined) {
            return yield* new AgentSessionUnavailableError({
              providerInstanceId: input.providerInstanceId,
              providerSessionId: input.providerSessionId,
            });
          }
          if (descriptor.importable === false) {
            return yield* new AgentSessionImportBlockedError({
              providerInstanceId: input.providerInstanceId,
              providerSessionId: input.providerSessionId,
              importBlockedReason: descriptor.importBlockedReason ?? DEFAULT_BLOCKED_REASON,
            });
          }

          const outcomes = yield* scanner
            .recentThreads(workspaceRoot, undefined, { historyMode })
            .pipe(Stream.runCollect);
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
            context: contextSeedForHistoryMode(descriptor, historyMode),
          });
        }),
      )
      .pipe(
        Effect.catchTags({
          AgentSessionUnresumableSessionError: (error) =>
            Effect.fail(
              new AgentSessionImportBlockedError({
                providerInstanceId: input.providerInstanceId,
                providerSessionId: input.providerSessionId,
                importBlockedReason: error.message,
              }),
            ),
        }),
        // Anything outside the RPC's declared errors (persistence, dispatch, id allocation) is a scan failure.
        Effect.catch((error) =>
          isDeclaredAttachError(error)
            ? Effect.fail(error)
            : Effect.fail(new AgentSessionScanError({ operation: "attach-session", cause: error })),
        ),
      );
  });

  return { importRecentAgentThreads, listAgentSessions, attachAgentSession };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
