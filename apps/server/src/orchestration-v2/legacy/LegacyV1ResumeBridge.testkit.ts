/**
 * Shared fixtures for the V1 resume bridge tests: V1 rows as the fork's V1
 * server wrote them, a recording provider adapter, and one in-memory stack that
 * holds the importer, the orchestrator and the settings the bridge reads.
 */
import {
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type ServerSettings,
} from "@t3tools/contracts";
import { type DeepPartial } from "@t3tools/shared/Struct";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { layer as providerSessionRuntimeLayer } from "../../persistence/ProviderSessionRuntime.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { CursorProviderCapabilitiesV2 } from "../Adapters/CursorAdapterV2.ts";
import * as CommandReceiptStore from "../CommandReceiptStore.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectStore from "../ProjectStore.ts";
import {
  ProviderAdapterProtocolError,
  ProviderAdapterResumeThreadError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
} from "../ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";

/** Test rows are asserted field by field, so the parsed value is left untyped. */
export const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any));
export const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// ---------------------------------------------------------------------------
// V1 rows
// ---------------------------------------------------------------------------

export const CLAUDE_SESSION_UUID = "3f2b8c1e-7d4a-4e6b-9a5c-0d1e2f3a4b5c";
export const CLAUDE_ASSISTANT_UUID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
export const CURSOR_SESSION_UUID = "0b9d4a52-6c7e-4f18-a3b2-5d6e7f8091a2";

/** Cursors exactly as V1's provider adapters persisted them. */
export const v1Cursors = {
  claudeAgent: (t3ThreadId: string) => ({
    threadId: t3ThreadId,
    resume: CLAUDE_SESSION_UUID,
    resumeSessionAt: CLAUDE_ASSISTANT_UUID,
    turnCount: 2,
    turnStartMessageIds: [CLAUDE_ASSISTANT_UUID, null],
  }),
  codex: (nativeThreadId: string) => ({ threadId: nativeThreadId }),
  cursor: (sessionId: string) => ({ schemaVersion: 1, sessionId }),
} as const;

export type V1SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "ready"
  | "interrupted"
  | "stopped"
  | "error";

export interface SeedV1ThreadInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly title?: string;
  readonly modelSelection?: { readonly instanceId: string; readonly model: string };
  readonly archivedAt?: string;
  readonly deletedAt?: string;
  /** Number of alternating user/assistant messages, user first. */
  readonly messageCount?: number;
  /** Omit for a thread that never had a provider session. */
  readonly runtime?: {
    readonly providerName: string;
    /** null models rows persisted before the driver/instance split. */
    readonly providerInstanceId: string | null;
    /** A string is stored verbatim, so tests can persist malformed JSON. */
    readonly cursor: unknown;
    readonly status?: "starting" | "running" | "stopped" | "error";
    readonly lastSeenAt?: string;
    readonly runtimeMode?: string;
    readonly payload?: unknown;
  };
  /** V1 `projection_thread_sessions.status`; omit for no row. */
  readonly sessionStatus?: V1SessionStatus;
}

export const DEFAULT_PROJECT_ID = "project:bridge";

export const seedV1Project = (input: { readonly projectId: string; readonly deletedAt?: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        ${input.projectId}, 'Bridge project', '/tmp/bridge-project', '[]',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${input.deletedAt ?? null}
      )
      ON CONFLICT (project_id) DO NOTHING
    `;
  });

export const seedV1Thread = (input: SeedV1ThreadInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = input.projectId ?? DEFAULT_PROJECT_ID;
    const modelSelection = input.modelSelection ?? { instanceId: "codex", model: "gpt-5.4" };
    yield* seedV1Project({ projectId });
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES (
        ${input.threadId}, ${projectId}, ${input.title ?? "Migrated conversation"},
        ${toJson(modelSelection)}, 'full-access', 'default',
        '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z',
        ${input.archivedAt ?? null}, ${input.deletedAt ?? null}
      )
    `;
    for (let index = 0; index < (input.messageCount ?? 4); index += 1) {
      const at = `2026-01-0${index + 1}T01:00:00.000Z`;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json, is_streaming,
          created_at, updated_at
        ) VALUES (
          ${`message:${input.threadId}:${index + 1}`}, ${input.threadId}, NULL,
          ${index % 2 === 0 ? "user" : "assistant"}, ${`V1 history ${index + 1} of ${input.threadId}`},
          '[]', 0, ${at}, ${at}
        )
      `;
    }
    if (input.runtime !== undefined) {
      const { cursor, payload } = input.runtime;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
          last_seen_at, resume_cursor_json, runtime_payload_json
        ) VALUES (
          ${input.threadId}, ${input.runtime.providerName}, ${input.runtime.providerInstanceId},
          ${input.runtime.providerName}, ${input.runtime.runtimeMode ?? "full-access"},
          ${input.runtime.status ?? "running"},
          ${input.runtime.lastSeenAt ?? "2026-01-04T02:00:00.000Z"},
          ${typeof cursor === "string" ? cursor : toJson(cursor)},
          ${payload === undefined ? '{"cwd":"/tmp/bridge-project"}' : toJson(payload)}
        )
      `;
    }
    if (input.sessionStatus !== undefined) {
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id, provider_thread_id,
          active_turn_id, last_error, updated_at
        ) VALUES (
          ${input.threadId}, ${input.sessionStatus}, ${input.runtime?.providerName ?? null},
          NULL, NULL, NULL, NULL, '2026-01-04T02:00:00.000Z'
        )
      `;
    }
  });

// ---------------------------------------------------------------------------
// Reading results
// ---------------------------------------------------------------------------

export interface BridgeRowView {
  readonly thread_id: string;
  readonly source_runtime_json: string | null;
  readonly source_session_status: string | null;
  readonly source_model_selection_json: string | null;
  readonly provider_thread_id: string | null;
  readonly binding_status: string;
  readonly continuation_status: string;
  readonly reason: string | null;
}

export const readBridgeRow = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<BridgeRowView>`
      SELECT thread_id, source_runtime_json, source_session_status, source_model_selection_json,
        provider_thread_id, binding_status, continuation_status, reason
      FROM fork_v1_resume_bridge WHERE thread_id = ${threadId}
    `;
    return rows[0];
  });

export const readRuntimeRow = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly provider_name: string;
      readonly provider_instance_id: string | null;
      readonly adapter_key: string;
      readonly runtime_mode: string;
      readonly status: string;
      readonly last_seen_at: string;
      readonly resume_cursor_json: string | null;
      readonly runtime_payload_json: string | null;
    }>`
      SELECT provider_name, provider_instance_id, adapter_key, runtime_mode, status, last_seen_at,
        resume_cursor_json, runtime_payload_json
      FROM provider_session_runtime WHERE thread_id = ${threadId}
    `;
    return rows[0];
  });

/** Event ids and types of one thread's V2 stream, in commit order. */
export const readThreadEvents = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly event_id: string; readonly event_type: string }>`
      SELECT event_id, event_type FROM orchestration_events
      WHERE application_event_version = 2 AND stream_id = ${threadId}
      ORDER BY sequence
    `;
  });

export const countAllV2Events = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_events WHERE application_event_version = 2
  `;
  return rows[0]?.count ?? 0;
});

export const countRuns = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
    `;
    return rows[0]?.count ?? 0;
  });

// ---------------------------------------------------------------------------
// The binding every adapter test starts from
// ---------------------------------------------------------------------------

/** The provider thread the bridge binds for a migrated V1 thread. */
export const migratedProviderThread = (input: {
  readonly driver: string;
  readonly threadId: string;
  readonly nativeId: string;
  readonly providerInstanceId?: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread => {
  const driver = ProviderDriverKind.make(input.driver);
  return {
    id: ProviderThreadId.make(`provider-thread:migration:v1:${input.threadId}`),
    driver,
    providerInstanceId: ProviderInstanceId.make(input.providerInstanceId ?? input.driver),
    providerSessionId: null,
    appThreadId: ThreadId.make(input.threadId),
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: input.nativeId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
};

// ---------------------------------------------------------------------------
// Recording provider adapter
// ---------------------------------------------------------------------------

export interface FakeAdapterLog {
  openedSessions: number;
  /** App thread ids that asked for a brand new native thread. */
  ensuredThreads: Array<string>;
  /** Native ids handed to `resumeThread`, in call order. */
  resumedNativeIds: Array<string | null>;
  turns: Array<{
    readonly threadId: string;
    readonly providerThreadId: string;
    readonly nativeId: string | null;
    readonly text: string;
  }>;
}

export const makeFakeAdapterLog = (): FakeAdapterLog => ({
  openedSessions: 0,
  ensuredThreads: [],
  resumedNativeIds: [],
  turns: [],
});

const capabilitiesFor = (driver: string): OrchestrationV2ProviderCapabilities =>
  driver === "claudeAgent"
    ? ClaudeProviderCapabilitiesV2
    : driver === "cursor"
      ? CursorProviderCapabilitiesV2
      : CodexProviderCapabilitiesV2;

export const makeFakeProviderAdapter = (input: {
  readonly driver: string;
  readonly instanceId?: string;
  readonly log: FakeAdapterLog;
  /** `fail` makes every resume reject, as a missing native session does. */
  readonly resume?: "succeed" | "fail";
  /** `openSession` waits on this before returning, like a slow provider process. */
  readonly openGate?: Deferred.Deferred<void>;
}): ProviderAdapterV2Shape => {
  const driver = ProviderDriverKind.make(input.driver);
  const instanceId = ProviderInstanceId.make(input.instanceId ?? input.driver);
  const capabilities = capabilitiesFor(input.driver);
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        input.log.openedSessions += 1;
        if (input.openGate !== undefined) yield* Deferred.await(input.openGate);
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              input.log.ensuredThreads.push(threadInput.threadId);
              const createdAt = yield* DateTime.now;
              const nativeId = `${input.driver}:fresh:${threadInput.threadId}`;
              return {
                // Adopt the row the orchestrator already holds, as real adapters do.
                id:
                  threadInput.existingProviderThread?.id ??
                  ProviderThreadId.make(`provider-thread:${nativeId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: threadInput.existingProviderThread?.firstRunOrdinal ?? null,
                lastRunOrdinal: threadInput.existingProviderThread?.lastRunOrdinal ?? null,
                handoffIds: threadInput.existingProviderThread?.handoffIds ?? [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) =>
            Effect.gen(function* () {
              input.log.resumedNativeIds.push(providerThread.nativeThreadRef?.nativeId ?? null);
              if (input.resume === "fail") {
                return yield* new ProviderAdapterResumeThreadError({
                  driver,
                  providerSessionId: sessionInput.providerSessionId,
                  providerThreadId: providerThread.id,
                  cause: "The native session no longer exists.",
                });
              }
              return {
                ...providerThread,
                providerSessionId: sessionInput.providerSessionId,
                status: "idle" as const,
                updatedAt: yield* DateTime.now,
              };
            }),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              input.log.turns.push({
                threadId: turnInput.threadId,
                providerThreadId: turnInput.providerThread.id,
                nativeId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
                text: turnInput.message.text,
              });
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              yield* PubSub.publishAll(events, [
                {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: "fake provider response",
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ] satisfies ReadonlyArray<ProviderAdapterV2Event>);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            Effect.fail(new ProviderAdapterProtocolError({ driver, detail: "unused" })),
          rollbackThread: () =>
            Effect.fail(new ProviderAdapterProtocolError({ driver, detail: "unused" })),
          forkThread: () =>
            Effect.fail(new ProviderAdapterProtocolError({ driver, detail: "unused" })),
        };
      }),
  };
};

export interface RegistryEntry {
  readonly adapter: ProviderAdapterV2Shape;
  /** Defaults to true. A disabled instance stays registered but must not be resumed. */
  readonly enabled?: boolean;
}

/** A registry that, like production, answers `getMetadata` with enabled state and driver. */
export const makeRegistryLayer = (entries: ReadonlyArray<RegistryEntry>) =>
  Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: (instanceId) => {
        const entry = entries.find((candidate) => candidate.adapter.instanceId === instanceId);
        return entry === undefined
          ? Effect.fail(
              new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
            )
          : Effect.succeed(entry.adapter);
      },
      list: () => Effect.succeed(entries.map((entry) => entry.adapter.instanceId)),
      getMetadata: (instanceId) => {
        const entry = entries.find((candidate) => candidate.adapter.instanceId === instanceId);
        return entry === undefined
          ? Effect.fail(
              new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
            )
          : Effect.succeed({
              driver: entry.adapter.driver,
              continuationKey: String(entry.adapter.instanceId),
              enabled: entry.enabled ?? true,
              capabilities: capabilitiesFor(entry.adapter.driver),
            });
      },
    }),
  );

// ---------------------------------------------------------------------------
// One stack for importer, orchestrator, settings and registry
// ---------------------------------------------------------------------------

/**
 * A fresh in-memory V2 database with the real importer (including its runtime
 * repository), the real orchestrator over the given adapters, and test
 * settings. The effect worker daemon runs, so a dispatched turn finishes on its
 * own; tests wait for it with `settleCompletedRuns`, never on a sleep.
 *
 * Services a bridge may depend on, and so the full set provided here: SqlClient,
 * LegacyV1ThreadImporter, OrchestratorV2, ProjectionStoreV2, ProjectStoreV2,
 * CommandReceiptStore, ProviderSessionRuntimeRepository, ServerSettingsService,
 * ProviderAdapterRegistryV2.
 */
export const makeBridgeStack = (options: {
  readonly name: string;
  readonly adapters: ReadonlyArray<RegistryEntry>;
  readonly settings?: DeepPartial<ServerSettings>;
  /** Defaults to true. False leaves every outbox effect queued until `worker.drain()`. */
  readonly runEffectWorker?: boolean;
}) => {
  const databaseLayer = SqlitePersistenceMemory;
  const eventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(databaseLayer));
  const projectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(databaseLayer));
  const storesProvided = Layer.mergeAll(databaseLayer, eventStoreProvided, projectionStoreProvided);
  const eventSinkProvided = EventSink.layer.pipe(Layer.provide(storesProvided));
  const runtimeRepository = providerSessionRuntimeLayer.pipe(Layer.provide(databaseLayer));
  const importerProvided = LegacyV1ThreadImporter.layer.pipe(
    Layer.provide(Layer.mergeAll(storesProvided, eventSinkProvided, runtimeRepository)),
  );
  const registryLayer = makeRegistryLayer(options.adapters);
  const orchestratorProvided = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: options.name },
    registryLayer,
    { databaseLayer, runEffectWorker: options.runEffectWorker ?? true },
  );
  return Layer.mergeAll(
    storesProvided,
    eventSinkProvided,
    runtimeRepository,
    importerProvided,
    orchestratorProvided,
    registryLayer,
    ProjectStore.layer.pipe(Layer.provide(databaseLayer)),
    CommandReceiptStore.layer.pipe(Layer.provide(databaseLayer)),
    ServerSettingsService.layerTest(options.settings ?? {}).pipe(Layer.orDie),
  );
};

/**
 * Run `action`, then drain the effect worker until `count` runs have completed.
 * Subscribes before acting and waits on domain events, never on a timer.
 */
export const settleCompletedRuns = <A, E, R>(count: number, action: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const completed = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) => event.type === "run.updated" && event.payload.status === "completed",
        ),
        Stream.take(count),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const result = yield* action;
      yield* worker.drain();
      // The timeout only bounds a failing test: a run that never completes would
      // otherwise hang until the test runner gives up without saying why.
      yield* Fiber.join(completed).pipe(
        Effect.timeoutOrElse({
          duration: "6 seconds",
          orElse: () =>
            Effect.die(new Error(`Expected ${count} run(s) to complete, but they did not.`)),
        }),
      );
      yield* worker.drain();
      return result;
    }),
  );

// ---------------------------------------------------------------------------
// Pieces shared by the orchestrator-level tests
// ---------------------------------------------------------------------------

export const CONTINUATION_TEXT = "Continue where you left off.";

/** The exact startup command the bridge submits for one migrated thread. */
export const legacyContinuationCommand = (
  threadId: string,
  modelSelection: ModelSelection,
): Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }> => ({
  type: "message.dispatch",
  commandId: CommandId.make(`command:migration:v1:continue:${threadId}`),
  messageId: MessageId.make(`message:migration:v1:continue:${threadId}`),
  threadId: ThreadId.make(threadId),
  text: CONTINUATION_TEXT,
  attachments: [],
  modelSelection,
  dispatchMode: { type: "start_immediately" },
  createdBy: "agent",
  creationSource: "server",
});

export const readReceiptStatus = (commandId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM orchestration_command_receipts WHERE command_id = ${commandId}
    `;
    return rows[0]?.status;
  });

/**
 * Bind a provider thread to an imported shell the way the bridge does, without
 * the bridge: for tests of what the orchestrator does with such a binding.
 */
export const bindNativeThreadManually = (input: {
  readonly threadId: string;
  readonly driver: string;
  readonly nativeId: string;
  readonly strength?: "strong" | "weak";
  readonly providerInstanceId?: string;
}) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const projection = yield* projections.getThreadProjection(ThreadId.make(input.threadId));
    const now = yield* DateTime.now;
    const binding = migratedProviderThread({
      driver: input.driver,
      threadId: input.threadId,
      nativeId: input.nativeId,
      ...(input.providerInstanceId === undefined
        ? {}
        : { providerInstanceId: input.providerInstanceId }),
      now,
    });
    const providerThread: OrchestrationV2ProviderThread =
      input.strength === "weak" && binding.nativeThreadRef !== null
        ? { ...binding, nativeThreadRef: { ...binding.nativeThreadRef, strength: "weak" } }
        : binding;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:manual-binding:${input.threadId}:provider-thread`),
          type: "provider-thread.updated",
          threadId: ThreadId.make(input.threadId),
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          occurredAt: now,
          payload: providerThread,
        },
        {
          id: EventId.make(`event:manual-binding:${input.threadId}:select`),
          type: "thread.metadata-updated",
          threadId: ThreadId.make(input.threadId),
          providerInstanceId: projection.thread.providerInstanceId,
          occurredAt: now,
          payload: {
            ...projection.thread,
            activeProviderThreadId: providerThread.id,
            updatedAt: now,
          },
        },
      ],
    });
    return providerThread;
  });

/** Await a test milestone; the timeout only turns a missed milestone into a clear failure. */
export const awaitMilestone = (milestone: Deferred.Deferred<void>, description: string) =>
  Deferred.await(milestone).pipe(
    Effect.timeoutOrElse({
      duration: "6 seconds",
      orElse: () => Effect.die(new Error(`Expected ${description}, but it never happened.`)),
    }),
  );
