import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { layer as providerSessionRuntimeLayer } from "../../persistence/ProviderSessionRuntime.ts";
import { listLinkedPullRequestThreads } from "../../pullRequest/linkedThreads.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import {
  CLAUDE_SESSION_UUID,
  CURSOR_SESSION_UUID,
  countAllV2Events,
  parseJson,
  toJson,
  readBridgeRow,
  readRuntimeRow,
  readThreadEvents,
  seedV1Thread,
  v1Cursors,
} from "./LegacyV1ResumeBridge.testkit.ts";

const databaseLayer = SqlitePersistenceMemory;
const eventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(databaseLayer));
const projectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(databaseLayer));
const storesProvided = Layer.mergeAll(databaseLayer, eventStoreProvided, projectionStoreProvided);
const eventSinkProvided = EventSink.layer.pipe(Layer.provide(storesProvided));
const runtimeRepositoryProvided = providerSessionRuntimeLayer.pipe(Layer.provide(databaseLayer));
const importerProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(Layer.mergeAll(storesProvided, eventSinkProvided, runtimeRepositoryProvided)),
);
const projectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(storesProvided),
);
const TestLayer = Layer.mergeAll(
  storesProvided,
  eventSinkProvided,
  runtimeRepositoryProvided,
  importerProvided,
  projectionMaintenanceProvided,
);

it.layer(TestLayer)("LegacyV1ThreadImporter", (it) => {
  it.effect("uses the created-thread index for startup migration checks", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const statements: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            const query = span.attributes.get("db.query.text");
            if (
              typeof query === "string" &&
              query.includes("FROM projection_threads AS thread") &&
              query.includes("FROM orchestration_events AS event")
            ) {
              statements.push(query);
            }
          };
          return span;
        },
      });

      assert.equal(yield* importer.pendingThreadCount.pipe(Effect.withTracer(tracer)), 0);
      assert.deepStrictEqual(yield* importer.reconcileShells.pipe(Effect.withTracer(tracer)), {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      assert.lengthOf(statements, 2);
      for (const statement of statements) {
        const plan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${statement}`,
        );
        assert.match(
          plan.map((row) => row.detail).join("\n"),
          /SEARCH event USING INDEX orchestration_events_v2_created_threads_idx \(stream_id=\?\)/,
        );
      }
    }),
  );

  it.effect("imports lightweight shells, hydrates transcripts, and remains idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:legacy-import");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          'project:legacy-import',
          'Legacy project',
          '/tmp/legacy-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          unsettled_at,
          snoozed_until,
          snoozed_at,
          pinned_at,
          pin_order_key,
          linked_pull_request_json,
          deleted_at
        ) VALUES (
          ${threadId},
          'project:legacy-import',
          'Migrated conversation',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          ' main ',
          ' /tmp/legacy-project ',
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          '2026-01-03T12:00:00.000Z',
          '2026-02-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          'm',
          '{"projectId":"project:legacy-import","repository":"pingdotgg/t3code","number":9000,"url":"https://github.com/pingdotgg/t3code/pull/9000"}',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:legacy:1',
            ${threadId},
            NULL,
            'user',
            'First question',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:legacy:2',
            ${threadId},
            NULL,
            'assistant',
            'First answer',
            '[]',
            0,
            '2026-01-02T01:00:00.000Z',
            '2026-01-02T01:00:00.000Z'
          ),
          (
            'message:legacy:3',
            ${threadId},
            NULL,
            'user',
            'Follow-up question',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          ),
          (
            'message:legacy:4',
            ${threadId},
            NULL,
            'assistant',
            'Partial answer',
            '[]',
            1,
            '2026-01-04T01:00:00.000Z',
            '2026-01-04T01:00:00.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_pull_requests (
          thread_id, host, repository, number, url, source, linked_at, snapshot_json
        ) VALUES
          (${threadId}, 'github.com', 'pingdotgg/t3code', 9002,
            'https://github.com/pingdotgg/t3code/pull/9002', 'created',
            '2026-01-03T00:00:00.000Z',
            '{"state":"open","title":"Second PR","headBranch":"feature-two","baseBranch":"main","isDraft":false,"updatedAt":"2026-01-03T00:00:00.000Z","syncedAt":"2026-01-03T00:00:00.000Z"}'),
          (${threadId}, 'github.com', 'pingdotgg/t3code', 9003,
            'https://github.com/pingdotgg/t3code/pull/9003', 'manual',
            '2026-01-04T00:00:00.000Z', NULL)
      `;

      assert.equal(yield* importer.pendingThreadCount, 1);
      const shellImport = yield* importer.reconcileShells;
      assert.equal(yield* importer.pendingThreadCount, 1);
      assert.deepStrictEqual(shellImport, {
        importedThreadCount: 1,
        importedMessageCount: 2,
      });
      const shellEventCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(shellEventCount[0]?.count, 6);

      assert.isTrue((yield* maintenance.verify).valid);
      const shellProjection = yield* projections.getThreadProjection(threadId);
      assert.equal(shellProjection.thread.historyOrigin, "v1_import");
      assert.equal(shellProjection.thread.branch, "main");
      assert.equal(shellProjection.thread.worktreePath, "/tmp/legacy-project");
      assert.deepEqual(
        shellProjection.thread.pinnedAt,
        DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.pinOrderKey, "m");
      assert.deepEqual(
        shellProjection.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        shellProjection.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.linkedPullRequest?.number, 9000);
      assert.deepStrictEqual(
        (shellProjection.thread.pullRequests ?? []).map((link) => link.number),
        [9002, 9003, 9000],
      );
      assert.equal(shellProjection.thread.pullRequests?.[0]?.snapshot?.title, "Second PR");
      assert.deepStrictEqual(
        (yield* listLinkedPullRequestThreads({
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 9002,
        })).threads.map((thread) => thread.id),
        [threadId],
      );
      const shellSnapshot = yield* projections.getShellSnapshot();
      assert.equal(
        shellSnapshot.threads.find((thread) => thread.id === threadId)?.historyOrigin,
        "v1_import",
      );
      assert.deepStrictEqual(
        shellProjection.messages.map((message) => message.id),
        ["message:legacy:3", "message:legacy:4"],
      );

      const renamedAt = DateTime.makeUnsafe("2026-01-05T00:00:00.000Z");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:metadata-after-shell"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: shellProjection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: {
              ...shellProjection.thread,
              title: "Renamed after shell import",
              runtimeMode: "approval-required",
              interactionMode: "plan",
              archivedAt: renamedAt,
              settledOverride: "settled",
              settledAt: renamedAt,
              updatedAt: renamedAt,
            },
          },
        ],
      });

      const transcriptImport = yield* importer.ensureTranscript(threadId);
      assert.equal(yield* importer.pendingThreadCount, 0);
      assert.deepStrictEqual(transcriptImport, {
        importedThreadCount: 1,
        importedMessageCount: 2,
      });
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Renamed after shell import");
      assert.equal(projection.thread.runtimeMode, "approval-required");
      assert.equal(projection.thread.interactionMode, "plan");
      assert.deepEqual(projection.thread.archivedAt, renamedAt);
      assert.equal(projection.thread.settledOverride, "settled");
      assert.deepEqual(projection.thread.settledAt, renamedAt);
      assert.deepStrictEqual(
        projection.messages.map((message) => message.id),
        ["message:legacy:1", "message:legacy:2", "message:legacy:3", "message:legacy:4"],
      );
      assert.deepStrictEqual(
        projection.turnItems
          .filter(
            (
              item,
            ): item is Extract<
              (typeof projection.turnItems)[number],
              { readonly type: "user_message" | "assistant_message" }
            > => item.type === "user_message" || item.type === "assistant_message",
          )
          .map((item) => [item.messageId, item.ordinal, item.status]),
        [
          ["message:legacy:1", 1, "completed"],
          ["message:legacy:2", 2, "completed"],
          ["message:legacy:3", 3, "completed"],
          ["message:legacy:4", 4, "interrupted"],
        ],
      );

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:explicit-unpin"),
            type: "thread.unpinned",
            threadId,
            providerInstanceId: projection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: { ...projection.thread, pinnedAt: null, pinOrderKey: null },
          },
        ],
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_remove(
          payload_json,
          '$.snoozedUntil',
          '$.snoozedAt',
          '$.unsettledAt',
          '$.linkedPullRequest',
          '$.pullRequests'
        )
        WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.isNull(repaired.thread.pinnedAt);
      assert.isNull(repaired.thread.pinOrderKey);
      assert.deepEqual(
        repaired.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        repaired.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(repaired.thread.linkedPullRequest?.number, 9000);
      assert.deepStrictEqual(
        (repaired.thread.pullRequests ?? []).map((link) => link.number),
        [9002, 9003, 9000],
      );
      assert.equal(repaired.thread.pullRequests?.[0]?.snapshot?.title, "Second PR");
      const eventCountBeforeRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      assert.deepStrictEqual(yield* importer.ensureTranscript(threadId), {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      const eventCountAfterRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(eventCountAfterRetry[0]?.count, eventCountBeforeRetry[0]?.count);
    }),
  );

  it.effect("repairs newly added metadata after an earlier metadata repair", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:legacy-metadata-upgrade");
      const previousRepairId = EventId.make(`migration:v1:thread:${threadId}:metadata-repair`);

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project:legacy-metadata-upgrade',
          'Legacy project',
          '/tmp/legacy-metadata-upgrade',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, pinned_at, pin_order_key,
          linked_pull_request_json, branch_pull_request_json, active_order_key
        ) VALUES (
          ${threadId},
          'project:legacy-metadata-upgrade',
          'Original v1 title',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          'm',
          '{"projectId":"project:legacy-metadata-upgrade","repository":"pingdotgg/t3code","number":9000,"url":"https://github.com/pingdotgg/t3code/pull/9000"}',
          '{"projectId":"project:legacy-metadata-upgrade","repository":"pingdotgg/t3code","number":9001,"url":"https://github.com/pingdotgg/t3code/pull/9001"}',
          'az'
        )
      `;
      yield* importer.reconcileShells;
      yield* maintenance.rebuild;
      const shellProjection = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(
        (shellProjection.thread.pullRequests ?? []).map((link) => link.number),
        [9000],
      );
      const previousRepairThread = {
        ...shellProjection.thread,
        title: "Renamed in v2",
        pinnedAt: null,
        pinOrderKey: null,
        linkedPullRequest: null,
        pullRequests: [],
      };
      delete previousRepairThread.branchPullRequest;
      delete previousRepairThread.activeOrderKey;
      yield* eventSink.write({
        events: [
          {
            id: previousRepairId,
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: previousRepairThread.providerInstanceId,
            occurredAt: DateTime.makeUnsafe("2026-01-03T00:00:00.000Z"),
            payload: previousRepairThread,
          },
        ],
      });

      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.equal(repaired.thread.title, "Renamed in v2");
      assert.isNull(repaired.thread.pinnedAt);
      assert.isNull(repaired.thread.pinOrderKey);
      assert.isNull(repaired.thread.linkedPullRequest);
      assert.deepStrictEqual(repaired.thread.pullRequests, []);
      assert.equal(repaired.thread.branchPullRequest?.number, 9001);
      assert.equal(repaired.thread.activeOrderKey, "az");

      const eventsBeforeRetry = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
        ORDER BY sequence
      `;
      assert.equal(eventsBeforeRetry.length, 4);
      assert.isTrue(eventsBeforeRetry.some((event) => event.event_id === previousRepairId));
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });

      assert.isTrue((yield* maintenance.rebuild).valid);
      const replayed = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(replayed.thread, repaired.thread);
      assert.deepStrictEqual(
        yield* Effect.gen(function* () {
          const restartedImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          return yield* restartedImporter.reconcileShells;
        }).pipe(Effect.provide(LegacyV1ThreadImporter.layer)),
        { importedThreadCount: 0, importedMessageCount: 0 },
      );
      const eventsAfterRestart = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
        ORDER BY sequence
      `;
      assert.deepStrictEqual(eventsAfterRestart, eventsBeforeRetry);
    }),
  );

  // -------------------------------------------------------------------------
  // V1 resume bridge: native provider-thread bindings
  // -------------------------------------------------------------------------

  const providerThreadEventId = (threadId: string) =>
    `migration:v1:thread:${threadId}:native-provider-thread`;
  const bindingSelectedEventId = (threadId: string) =>
    `migration:v1:thread:${threadId}:native-binding-selected`;
  const bindingId = (threadId: string) => `provider-thread:migration:v1:${threadId}`;

  const readProjection = (threadId: string) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      return yield* projections.getThreadProjection(ThreadId.make(threadId));
    });

  it.effect("binds a strong native provider thread for each supported V1 provider", () =>
    Effect.gen(function* () {
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const claudeId = "thread:bind:claude";
      const codexId = "thread:bind:codex";
      const cursorId = "thread:bind:cursor";
      yield* seedV1Thread({
        threadId: claudeId,
        modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
        runtime: {
          providerName: "claudeAgent",
          providerInstanceId: null,
          cursor: v1Cursors.claudeAgent(claudeId),
          payload: { cwd: "/tmp/bridge-project", model: "claude-sonnet-4-6" },
        },
        sessionStatus: "running",
      });
      yield* seedV1Thread({
        threadId: codexId,
        runtime: {
          providerName: "codex",
          providerInstanceId: "codex",
          cursor: v1Cursors.codex("019e3f5a-native-codex"),
          runtimeMode: "approval-required",
          lastSeenAt: "2026-01-03T09:08:07.000Z",
        },
        sessionStatus: "running",
      });
      yield* seedV1Thread({
        threadId: cursorId,
        modelSelection: { instanceId: "cursor", model: "composer-2.5" },
        runtime: {
          providerName: "cursor",
          providerInstanceId: null,
          cursor: v1Cursors.cursor(CURSOR_SESSION_UUID),
        },
        sessionStatus: "running",
      });

      const summary = yield* importer.reconcileShells;
      assert.equal(summary.importedThreadCount, 3);

      const expected = [
        [claudeId, "claudeAgent", "claudeAgent", CLAUDE_SESSION_UUID],
        [codexId, "codex", "codex", "019e3f5a-native-codex"],
        [cursorId, "cursor", "cursor", CURSOR_SESSION_UUID],
      ] as const;
      const assertBound = (
        projection: OrchestrationV2ThreadProjection,
        [threadId, driver, instanceId, nativeId]: (typeof expected)[number],
      ) => {
        assert.lengthOf(projection.providerThreads, 1);
        const bound = projection.providerThreads[0]!;
        assert.equal(bound.id, ProviderThreadId.make(bindingId(threadId)));
        assert.equal(bound.driver, ProviderDriverKind.make(driver));
        assert.equal(bound.providerInstanceId, ProviderInstanceId.make(instanceId));
        assert.deepStrictEqual(bound.nativeThreadRef, {
          driver: ProviderDriverKind.make(driver),
          nativeId,
          strength: "strong",
        });
        // The V1 cursor's own `resumeSessionAt` is a diagnostic: mapping it here would
        // make V2 rewind the Claude session to that message.
        assert.isNull(bound.nativeConversationHeadRef);
        assert.isNull(bound.providerSessionId);
        assert.equal(bound.appThreadId, ThreadId.make(threadId));
        assert.isNull(bound.ownerNodeId);
        assert.equal(bound.status, "idle");
        assert.isNull(bound.firstRunOrdinal);
        assert.isNull(bound.lastRunOrdinal);
        assert.deepStrictEqual(bound.handoffIds, []);
        assert.isNull(bound.forkedFrom);
        assert.deepStrictEqual(bound.pendingBackgroundTasks, []);
        assert.equal(projection.thread.activeProviderThreadId, bound.id);
      };
      for (const entry of expected) {
        assertBound(yield* readProjection(entry[0]), entry);
      }

      // The selected model and instance are the thread's own; binding never rewrites them.
      const codex = yield* readProjection(codexId);
      assert.deepStrictEqual(codex.thread.modelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
      assert.equal(codex.thread.historyOrigin, "v1_import");

      // Cold import writes the binding with the shell: one provider-thread event and no
      // separate selection event, because thread.created already carries the pointer.
      for (const [threadId] of expected) {
        const events = yield* readThreadEvents(threadId);
        assert.equal(events[0]?.event_type, "thread.created");
        assert.deepStrictEqual(
          events.filter((event) => event.event_type === "provider-thread.updated"),
          [{ event_id: providerThreadEventId(threadId), event_type: "provider-thread.updated" }],
        );
        assert.notInclude(
          events.map((event) => event.event_id),
          bindingSelectedEventId(threadId),
        );
      }

      // Replaying the log reproduces the same bindings.
      assert.isTrue((yield* maintenance.rebuild).valid);
      for (const entry of expected) {
        assertBound(yield* readProjection(entry[0]), entry);
      }
    }),
  );

  it.effect("normalizes the runtime row to stopped and keeps its cursor and metadata", () =>
    Effect.gen(function* () {
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const threadId = "thread:runtime:normalized";
      const cursor = v1Cursors.claudeAgent(threadId);
      yield* seedV1Thread({
        threadId,
        modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
        runtime: {
          providerName: "claudeAgent",
          providerInstanceId: null,
          cursor,
          status: "running",
          runtimeMode: "auto-accept-edits",
          lastSeenAt: "2026-01-03T09:08:07.000Z",
          payload: { cwd: "/tmp/bridge-project", model: "claude-sonnet-4-6", threadId },
        },
        sessionStatus: "running",
      });

      yield* importer.reconcileShells;

      const runtime = yield* readRuntimeRow(threadId);
      assert.equal(runtime?.status, "stopped");
      // A concrete instance id replaces the pre-split null.
      assert.equal(runtime?.provider_instance_id, "claudeAgent");
      assert.equal(runtime?.provider_name, "claudeAgent");
      assert.equal(runtime?.adapter_key, "claudeAgent");
      assert.equal(runtime?.runtime_mode, "auto-accept-edits");
      assert.equal(runtime?.last_seen_at, "2026-01-03T09:08:07.000Z");
      // The complete V1 cursor stays, including the fields V2 does not read.
      assert.deepStrictEqual(parseJson(runtime?.resume_cursor_json ?? "null"), cursor);
      assert.deepStrictEqual(parseJson(runtime?.runtime_payload_json ?? "null"), {
        cwd: "/tmp/bridge-project",
        model: "claude-sonnet-4-6",
        threadId,
      });

      const bridge = yield* readBridgeRow(threadId);
      assert.equal(bridge?.binding_status, "bound");
      assert.equal(bridge?.provider_thread_id, bindingId(threadId));
      // Captured before the row was normalized.
      assert.equal(bridge?.source_session_status, "running");
      const source = parseJson(bridge?.source_runtime_json ?? "null");
      assert.equal(source.status, "running");
      assert.isNull(source.providerInstanceId);
      assert.deepStrictEqual(source.resumeCursor, cursor);
      assert.deepStrictEqual(parseJson(bridge?.source_model_selection_json ?? "null"), {
        instanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      });
      assert.equal(bridge?.continuation_status, "pending");
    }),
  );

  it.effect("keeps an explicit runtime instance and routes a null one to the driver default", () =>
    Effect.gen(function* () {
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const explicitId = "thread:instance:explicit";
      const defaultedId = "thread:instance:defaulted";
      yield* seedV1Thread({
        threadId: explicitId,
        modelSelection: { instanceId: "codex-work", model: "gpt-5.4" },
        runtime: {
          providerName: "codex",
          providerInstanceId: "codex-work",
          cursor: v1Cursors.codex("native-work"),
        },
        sessionStatus: "running",
      });
      yield* seedV1Thread({
        threadId: defaultedId,
        runtime: {
          providerName: "codex",
          providerInstanceId: null,
          cursor: v1Cursors.codex("native-default"),
        },
        sessionStatus: "running",
      });

      yield* importer.reconcileShells;

      const explicit = yield* readProjection(explicitId);
      assert.equal(explicit.providerThreads[0]?.providerInstanceId, "codex-work");
      assert.equal((yield* readRuntimeRow(explicitId))?.provider_instance_id, "codex-work");
      const defaulted = yield* readProjection(defaultedId);
      assert.equal(defaulted.providerThreads[0]?.providerInstanceId, "codex");
      assert.equal((yield* readRuntimeRow(defaultedId))?.provider_instance_id, "codex");
    }),
  );

  it.effect("keeps the binding but never resumes automatically across a provider switch", () =>
    Effect.gen(function* () {
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const threadId = "thread:instance:switched";
      // The user moved this thread to Claude after its last Codex session.
      yield* seedV1Thread({
        threadId,
        modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
        runtime: {
          providerName: "codex",
          providerInstanceId: "codex",
          cursor: v1Cursors.codex("native-before-switch"),
        },
        sessionStatus: "running",
      });

      yield* importer.reconcileShells;

      const projection = yield* readProjection(threadId);
      assert.equal(projection.thread.modelSelection.instanceId, "claudeAgent");
      assert.equal(projection.thread.providerInstanceId, "claudeAgent");
      assert.equal(projection.providerThreads[0]?.providerInstanceId, "codex");
      assert.equal(
        projection.providerThreads[0]?.nativeThreadRef?.nativeId,
        "native-before-switch",
      );
      const bridge = yield* readBridgeRow(threadId);
      assert.equal(bridge?.binding_status, "bound");
      assert.equal(bridge?.continuation_status, "skipped");
    }),
  );

  it.effect("continues only threads whose V1 session was running", () =>
    Effect.gen(function* () {
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const cases = [
        ["thread:eligible:running", "running", "pending"],
        // V1 maps both session `ready` and `running` to a running runtime row.
        ["thread:eligible:ready", "ready", "skipped"],
        ["thread:eligible:stopped", "stopped", "skipped"],
        ["thread:eligible:interrupted", "interrupted", "skipped"],
        ["thread:eligible:error", "error", "skipped"],
        ["thread:eligible:no-session-row", undefined, "skipped"],
      ] as const;
      for (const [threadId, sessionStatus] of cases) {
        yield* seedV1Thread({
          threadId,
          runtime: {
            providerName: "codex",
            providerInstanceId: "codex",
            cursor: v1Cursors.codex(`native:${threadId}`),
            status: "running",
          },
          ...(sessionStatus === undefined ? {} : { sessionStatus }),
        });
      }

      yield* importer.reconcileShells;

      for (const [threadId, sessionStatus, continuation] of cases) {
        const bridge = yield* readBridgeRow(threadId);
        assert.equal(bridge?.binding_status, "bound", threadId);
        assert.equal(bridge?.continuation_status, continuation, threadId);
        assert.equal(bridge?.source_session_status, sessionStatus ?? null, threadId);
        // Every one of them still resumes natively on the next manual turn.
        assert.equal((yield* readProjection(threadId)).providerThreads.length, 1, threadId);
      }
    }),
  );

  it.effect("binds archived and deleted threads for restoration but never continues them", () =>
    Effect.gen(function* () {
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const archivedId = "thread:retired:archived";
      const deletedId = "thread:retired:deleted";
      for (const [threadId, retired] of [
        [archivedId, { archivedAt: "2026-01-05T00:00:00.000Z" }],
        [deletedId, { deletedAt: "2026-01-05T00:00:00.000Z" }],
      ] as const) {
        yield* seedV1Thread({
          threadId,
          ...retired,
          runtime: {
            providerName: "codex",
            providerInstanceId: "codex",
            cursor: v1Cursors.codex(`native:${threadId}`),
          },
          sessionStatus: "running",
        });
      }

      yield* importer.reconcileShells;

      for (const threadId of [archivedId, deletedId]) {
        const bridge = yield* readBridgeRow(threadId);
        assert.equal(bridge?.binding_status, "bound", threadId);
        assert.equal(bridge?.continuation_status, "skipped", threadId);
        const projection = yield* readProjection(threadId);
        assert.equal(
          projection.providerThreads[0]?.nativeThreadRef?.nativeId,
          `native:${threadId}`,
        );
        assert.equal(projection.thread.activeProviderThreadId, bindingId(threadId));
      }
    }),
  );

  it.effect("leaves a thread unbound when its V1 cursor cannot name a native session", () =>
    Effect.gen(function* () {
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const cases = [
        // Claude cursor with only the T3 thread id.
        [
          "thread:unbound:claude-no-session",
          "claudeAgent",
          { threadId: "thread:unbound" },
          "missing-native-id",
        ],
        ["thread:unbound:codex-empty", "codex", { threadId: "" }, "missing-native-id"],
        [
          "thread:unbound:cursor-version",
          "cursor",
          { schemaVersion: 2, sessionId: "abc" },
          "unsupported-cursor-version",
        ],
        ["thread:unbound:provider", "opencode", { threadId: "native" }, "unsupported-provider"],
        ["thread:unbound:null-cursor", "codex", null, "missing-cursor"],
      ] as const;
      for (const [threadId, providerName, cursor] of cases) {
        yield* seedV1Thread({
          threadId,
          runtime: { providerName, providerInstanceId: null, cursor },
          sessionStatus: "running",
        });
      }
      const malformedId = "thread:unbound:malformed-json";
      yield* seedV1Thread({
        threadId: malformedId,
        runtime: { providerName: "codex", providerInstanceId: null, cursor: "{not json" },
        sessionStatus: "running",
      });
      const noRuntimeId = "thread:unbound:no-runtime";
      yield* seedV1Thread({ threadId: noRuntimeId, sessionStatus: "running" });

      const summary = yield* importer.reconcileShells;
      // Unusable cursors never stop the import of the thread itself.
      assert.equal(summary.importedThreadCount, cases.length + 2);

      for (const [threadId, , , reason] of cases) {
        const projection = yield* readProjection(threadId);
        assert.isEmpty(projection.providerThreads, threadId);
        assert.isNull(projection.thread.activeProviderThreadId, threadId);
        const bridge = yield* readBridgeRow(threadId);
        assert.equal(bridge?.binding_status, "unavailable", threadId);
        assert.equal(bridge?.reason, reason, threadId);
        assert.isNull(bridge?.provider_thread_id, threadId);
        assert.equal(bridge?.continuation_status, "skipped", threadId);
        // The runtime row is left exactly as V1 wrote it.
        assert.equal((yield* readRuntimeRow(threadId))?.status, "running", threadId);
        assert.isNull((yield* readRuntimeRow(threadId))?.provider_instance_id, threadId);
      }
      for (const threadId of [malformedId, noRuntimeId]) {
        const projection = yield* readProjection(threadId);
        assert.isEmpty(projection.providerThreads, threadId);
        assert.isNull(projection.thread.activeProviderThreadId, threadId);
        const events = yield* readThreadEvents(threadId);
        assert.notInclude(
          events.map((event) => event.event_type),
          "provider-thread.updated",
        );
      }
      assert.equal((yield* readBridgeRow(malformedId))?.binding_status, "unavailable");
    }),
  );

  it.effect(
    "binds shells imported before the bridge existed, once, with a separate selection event",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const threadId = "thread:repair:prebridge";
        const cursor = v1Cursors.codex("native-repaired");
        // The shell is imported while V1 has no runtime row, as the earlier build did.
        yield* seedV1Thread({ threadId });
        yield* importer.reconcileShells;
        yield* sql`DELETE FROM fork_v1_resume_bridge WHERE thread_id = ${threadId}`;
        yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
          last_seen_at, resume_cursor_json, runtime_payload_json
        ) VALUES (
          ${threadId}, 'codex', NULL, 'codex', 'full-access', 'running',
          '2026-01-04T02:00:00.000Z', ${toJson(cursor)}, '{"cwd":"/tmp/bridge-project"}'
        )
      `;
        yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id, provider_thread_id,
          active_turn_id, last_error, updated_at
        ) VALUES (${threadId}, 'running', 'codex', NULL, NULL, NULL, NULL, '2026-01-04T02:00:00.000Z')
      `;
        const before = yield* readProjection(threadId);
        assert.isNull(before.thread.activeProviderThreadId);
        const eventsBefore = yield* readThreadEvents(threadId);

        yield* importer.reconcileShells;

        const projection = yield* readProjection(threadId);
        assert.equal(projection.providerThreads[0]?.id, bindingId(threadId));
        assert.deepStrictEqual(projection.providerThreads[0]?.nativeThreadRef, {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "native-repaired",
          strength: "strong",
        });
        assert.equal(projection.thread.activeProviderThreadId, bindingId(threadId));
        // Nothing else about the thread changes.
        assert.equal(projection.thread.title, before.thread.title);
        assert.deepStrictEqual(projection.thread.modelSelection, before.thread.modelSelection);
        assert.deepStrictEqual((yield* readThreadEvents(threadId)).slice(eventsBefore.length), [
          { event_id: providerThreadEventId(threadId), event_type: "provider-thread.updated" },
          { event_id: bindingSelectedEventId(threadId), event_type: "thread.metadata-updated" },
        ]);
        const runtime = yield* readRuntimeRow(threadId);
        assert.equal(runtime?.status, "stopped");
        assert.equal(runtime?.provider_instance_id, "codex");
        assert.deepStrictEqual(parseJson(runtime?.resume_cursor_json ?? "null"), cursor);
        const bridge = yield* readBridgeRow(threadId);
        assert.equal(bridge?.binding_status, "bound");
        assert.equal(bridge?.source_session_status, "running");
        assert.equal(parseJson(bridge?.source_runtime_json ?? "null").status, "running");
        assert.equal(bridge?.continuation_status, "pending");
      }),
  );

  it.effect("emits nothing when reconciliation repeats", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const coldId = "thread:repeat:cold";
      const repairedId = "thread:repeat:repaired";
      yield* seedV1Thread({
        threadId: coldId,
        runtime: { providerName: "codex", providerInstanceId: null, cursor: v1Cursors.codex("n1") },
        sessionStatus: "running",
      });
      yield* seedV1Thread({ threadId: repairedId });
      yield* importer.reconcileShells;
      yield* sql`DELETE FROM fork_v1_resume_bridge WHERE thread_id = ${repairedId}`;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
          last_seen_at, resume_cursor_json, runtime_payload_json
        ) VALUES (${repairedId}, 'codex', NULL, 'codex', 'full-access', 'running',
          '2026-01-04T02:00:00.000Z', ${toJson(v1Cursors.codex("n2"))}, NULL)
      `;
      yield* importer.reconcileShells;
      const bridgeRows = sql`SELECT * FROM fork_v1_resume_bridge ORDER BY thread_id`;
      const runtimeRows = sql`SELECT * FROM provider_session_runtime ORDER BY thread_id`;
      const bridgeBefore = yield* bridgeRows;
      const runtimeBefore = yield* runtimeRows;
      const eventsBefore = yield* countAllV2Events;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.deepStrictEqual(yield* importer.reconcileShells, {
          importedThreadCount: 0,
          importedMessageCount: 0,
        });
      }

      assert.equal(yield* countAllV2Events, eventsBefore);
      assert.deepStrictEqual(yield* bridgeRows, bridgeBefore);
      assert.deepStrictEqual(yield* runtimeRows, runtimeBefore);
      // A fresh importer (a restart) is just as quiet.
      assert.deepStrictEqual(
        yield* Effect.gen(function* () {
          const restarted = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          return yield* restarted.reconcileShells;
        }).pipe(Effect.provide(LegacyV1ThreadImporter.layer)),
        { importedThreadCount: 0, importedMessageCount: 0 },
      );
      assert.equal(yield* countAllV2Events, eventsBefore);
    }),
  );

  it.effect("does not touch shells that already have a V2 provider thread or V2 runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const eventSink = yield* EventSink.EventSinkV2;
      const boundId = "thread:v2-used:bound";
      const ranId = "thread:v2-used:ran";
      yield* seedV1Thread({ threadId: boundId });
      yield* seedV1Thread({ threadId: ranId });
      yield* importer.reconcileShells;
      for (const threadId of [boundId, ranId]) {
        yield* sql`DELETE FROM fork_v1_resume_bridge WHERE thread_id = ${threadId}`;
      }

      // V2 already gave the first thread its own native thread.
      const now = DateTime.makeUnsafe("2026-02-01T00:00:00.000Z");
      const bound = yield* readProjection(boundId);
      const v2ProviderThreadId = ProviderThreadId.make("provider-thread:v2:own");
      const driver = ProviderDriverKind.make("codex");
      const instanceId = ProviderInstanceId.make("codex");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:v2-used:provider-thread"),
            type: "provider-thread.updated",
            threadId: ThreadId.make(boundId),
            driver,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: {
              id: v2ProviderThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: ThreadId.make(boundId),
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-v2-own", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("event:v2-used:select"),
            type: "thread.metadata-updated",
            threadId: ThreadId.make(boundId),
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: {
              ...bound.thread,
              activeProviderThreadId: v2ProviderThreadId,
              updatedAt: now,
            },
          },
        ],
      });

      // V2 already ran, and failed, on the second thread before it ever bound a provider thread.
      const ranThread = yield* readProjection(ranId);
      const run: OrchestrationV2Run = {
        id: RunId.make("run:v2-used:failed"),
        threadId: ThreadId.make(ranId),
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: ranThread.thread.modelSelection,
        providerThreadId: ProviderThreadId.make("provider-thread:pending:run:v2-used:failed"),
        userMessageId: MessageId.make("message:v2-used:user"),
        rootNodeId: NodeId.make("node:v2-used:root"),
        activeAttemptId: null,
        status: "failed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:v2-used:run"),
            type: "run.created",
            threadId: ThreadId.make(ranId),
            runId: run.id,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: run,
          },
        ],
      });

      // V1 runtime rows for both appear only now, as a pre-bridge database would have them.
      for (const threadId of [boundId, ranId]) {
        yield* sql`
          INSERT INTO provider_session_runtime (
            thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
            last_seen_at, resume_cursor_json, runtime_payload_json
          ) VALUES (${threadId}, 'codex', NULL, 'codex', 'full-access', 'running',
            '2026-01-04T02:00:00.000Z', ${toJson(v1Cursors.codex(`v1:${threadId}`))}, NULL)
        `;
        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id, status, provider_name, provider_session_id, provider_thread_id,
            active_turn_id, last_error, updated_at
          ) VALUES (${threadId}, 'running', 'codex', NULL, NULL, NULL, NULL, '2026-01-04T02:00:00.000Z')
        `;
      }
      const runtimeBefore = yield* sql`SELECT * FROM provider_session_runtime
        WHERE thread_id IN (${boundId}, ${ranId}) ORDER BY thread_id`;
      const eventsBefore = yield* countAllV2Events;

      yield* importer.reconcileShells;

      assert.equal(yield* countAllV2Events, eventsBefore);
      const boundAfter = yield* readProjection(boundId);
      assert.equal(boundAfter.thread.activeProviderThreadId, v2ProviderThreadId);
      assert.deepStrictEqual(
        boundAfter.providerThreads.map((thread) => thread.id),
        [v2ProviderThreadId],
      );
      const ranAfter = yield* readProjection(ranId);
      assert.isEmpty(ranAfter.providerThreads);
      assert.isNull(ranAfter.thread.activeProviderThreadId);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM provider_session_runtime
          WHERE thread_id IN (${boundId}, ${ranId}) ORDER BY thread_id`,
        runtimeBefore,
      );
      for (const threadId of [boundId, ranId]) {
        const bridge = yield* readBridgeRow(threadId);
        assert.notEqual(bridge?.binding_status, "bound", threadId);
        assert.notEqual(bridge?.continuation_status, "pending", threadId);
      }
    }),
  );

  it.effect("rolls back the whole thread, including its bridge record, when the import fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const threadId = "thread:rollback";
      const cursor = v1Cursors.codex("native-rollback");
      yield* seedV1Thread({
        threadId,
        runtime: { providerName: "codex", providerInstanceId: null, cursor },
        sessionStatus: "running",
      });
      const runtimeBefore = yield* readRuntimeRow(threadId);
      const eventsBefore = yield* countAllV2Events;
      // The import marker is the last write of the shell transaction.
      yield* sql`
        CREATE TRIGGER fail_rollback_import BEFORE INSERT ON orchestration_v2_legacy_imports
        WHEN NEW.thread_id = 'thread:rollback'
        BEGIN SELECT RAISE(ABORT, 'simulated import failure'); END
      `;

      const failed = yield* Effect.result(importer.reconcileShells);
      yield* sql`DROP TRIGGER fail_rollback_import`;

      assert.equal(failed._tag, "Failure");
      assert.equal(yield* countAllV2Events, eventsBefore);
      assert.isUndefined(yield* readBridgeRow(threadId));
      assert.deepStrictEqual(yield* readRuntimeRow(threadId), runtimeBefore);
      assert.deepStrictEqual(yield* readThreadEvents(threadId), []);

      // The next startup retries from scratch and completes the binding.
      yield* importer.reconcileShells;
      const bridge = yield* readBridgeRow(threadId);
      assert.equal(bridge?.binding_status, "bound");
      assert.equal(bridge?.continuation_status, "pending");
      assert.equal((yield* readProjection(threadId)).providerThreads[0]?.id, bindingId(threadId));
      assert.equal((yield* readRuntimeRow(threadId))?.status, "stopped");
    }),
  );
});
