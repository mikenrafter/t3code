import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSettingsService from "../../serverSettings.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as LegacyV1ResumeBridge from "./LegacyV1ResumeBridge.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import {
  CONTINUATION_TEXT,
  awaitMilestone,
  countRuns,
  makeBridgeStack,
  makeFakeAdapterLog,
  makeFakeProviderAdapter,
  readBridgeRow,
  readReceiptStatus,
  type RegistryEntry,
  type SeedV1ThreadInput,
  seedV1Project,
  seedV1Thread,
  settleCompletedRuns,
  v1Cursors,
} from "./LegacyV1ResumeBridge.testkit.ts";

/** A thread V1 was still running when the user upgraded. */
const runningThread = (
  threadId: string,
  overrides: Partial<SeedV1ThreadInput> = {},
): SeedV1ThreadInput => ({
  threadId,
  runtime: {
    providerName: "codex",
    providerInstanceId: "codex",
    cursor: v1Cursors.codex(`native:${threadId}`),
  },
  sessionStatus: "running",
  ...overrides,
});

const continuationMessageId = (threadId: string) =>
  MessageId.make(`message:migration:v1:continue:${threadId}`);
const continuationCommandId = (threadId: string) =>
  CommandId.make(`command:migration:v1:continue:${threadId}`);

const makeStack = (
  name: string,
  options: {
    readonly continueAfterUpdate?: boolean;
    readonly settings?: Parameters<typeof makeBridgeStack>[0]["settings"];
    readonly extraAdapters?: ReadonlyArray<RegistryEntry>;
  } = {},
) => {
  const log = makeFakeAdapterLog();
  const codex = makeFakeProviderAdapter({ driver: "codex", log });
  return {
    log,
    layer: makeBridgeStack({
      name,
      adapters: [{ adapter: codex }, ...(options.extraAdapters ?? [])],
      settings: options.settings ?? {
        continueThreadsAfterServerUpdate: options.continueAfterUpdate ?? true,
      },
    }),
  };
};

/** Seed V1 rows and run the startup shell import, as the first V2 boot does. */
const importThreads = (inputs: ReadonlyArray<SeedV1ThreadInput>) =>
  Effect.gen(function* () {
    for (const input of inputs) yield* seedV1Thread(input);
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    yield* importer.reconcileShells;
  });

/** A bridge as a freshly started server builds it. */
const startBridge = LegacyV1ResumeBridge.make;

const transcriptImported = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly transcript_imported_at: string | null }>`
      SELECT transcript_imported_at FROM orchestration_v2_legacy_imports
      WHERE thread_id = ${threadId}
    `;
    return rows[0]?.transcript_imported_at !== null && rows[0] !== undefined;
  });

const projectionOf = (threadId: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.getThreadProjection(ThreadId.make(threadId));
  });

const dispatchUserMessage = (threadId: string, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${threadId}:${text}`),
      threadId: ThreadId.make(threadId),
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
  });

it.live("continues a thread V1 was running exactly once, resuming its native session", () => {
  const { log, layer } = makeStack("bridge-continue-once");
  const threadId = "thread:bridge:running";
  const readyId = "thread:bridge:ready";
  return Effect.gen(function* () {
    yield* importThreads([
      runningThread(threadId),
      // V1 maps session `ready` to a running runtime row too, but the user was not mid-turn.
      runningThread(readyId, { sessionStatus: "ready" }),
    ]);
    const bridge = yield* startBridge;

    yield* settleCompletedRuns(1, bridge.continuePending);

    assert.equal((yield* readBridgeRow(threadId))?.continuation_status, "submitted");
    assert.equal(yield* readReceiptStatus(continuationCommandId(threadId)), "accepted");
    const projection = yield* projectionOf(threadId);
    assert.lengthOf(projection.runs, 1);
    assert.equal(projection.runs[0]?.status, "completed");
    assert.isUndefined(projection.runs[0]?.restartContinuationOfRunId);
    assert.deepStrictEqual(projection.runs[0]?.modelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    });
    const message = projection.messages.find(
      (candidate) => candidate.id === continuationMessageId(threadId),
    );
    assert.equal(message?.text, CONTINUATION_TEXT);
    assert.equal(message?.createdBy, "agent");
    assert.equal(message?.creationSource, "server");
    // Native resume: the first turn is the bare prompt on the V1 session, no 32k replay.
    assert.deepStrictEqual(log.resumedNativeIds, [`native:${threadId}`]);
    assert.deepStrictEqual(log.ensuredThreads, []);
    assert.deepStrictEqual(
      log.turns.map((turn) => [turn.threadId, turn.nativeId, turn.text]),
      [[threadId, `native:${threadId}`, CONTINUATION_TEXT]],
    );
    assert.isEmpty(projection.contextHandoffs);
    // The full transcript is hydrated for the continued thread only.
    assert.isTrue(yield* transcriptImported(threadId));
    assert.isFalse(yield* transcriptImported(readyId));
    assert.equal(yield* countRuns(readyId), 0);
    assert.equal((yield* readBridgeRow(readyId))?.continuation_status, "skipped");

    // A restarted server never prompts again.
    const restarted = yield* startBridge;
    yield* restarted.continuePending;
    assert.equal(yield* countRuns(threadId), 1);
    assert.lengthOf(log.turns, 1);
    assert.equal((yield* readBridgeRow(threadId))?.continuation_status, "submitted");
  }).pipe(Effect.provide(layer));
});

it.live("honors a project override that enables the setting over a disabled default", () => {
  const optedIn = ProjectId.make("project:bridge:opted-in");
  const other = ProjectId.make("project:bridge:other");
  const { log, layer } = makeStack("bridge-override-on", {
    settings: {
      continueThreadsAfterServerUpdate: false,
      projectSettingsOverrides: { [optedIn]: { continueThreadsAfterServerUpdate: true } },
    },
  });
  return Effect.gen(function* () {
    yield* importThreads([
      runningThread("thread:override-on:in", { projectId: optedIn }),
      runningThread("thread:override-on:out", { projectId: other }),
    ]);
    const bridge = yield* startBridge;

    yield* settleCompletedRuns(1, bridge.continuePending);

    assert.equal(yield* countRuns("thread:override-on:in"), 1);
    assert.equal(yield* countRuns("thread:override-on:out"), 0);
    assert.equal((yield* readBridgeRow("thread:override-on:in"))?.continuation_status, "submitted");
    assert.equal((yield* readBridgeRow("thread:override-on:out"))?.continuation_status, "skipped");
    assert.lengthOf(log.turns, 1);
  }).pipe(Effect.provide(layer));
});

it.live("honors a project override that disables the setting over an enabled default", () => {
  const optedOut = ProjectId.make("project:bridge:opted-out");
  const other = ProjectId.make("project:bridge:inherits");
  const { log, layer } = makeStack("bridge-override-off", {
    settings: {
      continueThreadsAfterServerUpdate: true,
      projectSettingsOverrides: { [optedOut]: { continueThreadsAfterServerUpdate: false } },
    },
  });
  return Effect.gen(function* () {
    yield* importThreads([
      runningThread("thread:override-off:out", { projectId: optedOut }),
      runningThread("thread:override-off:in", { projectId: other }),
    ]);
    const bridge = yield* startBridge;

    yield* settleCompletedRuns(1, bridge.continuePending);

    assert.equal(yield* countRuns("thread:override-off:in"), 1);
    assert.equal(yield* countRuns("thread:override-off:out"), 0);
    assert.equal((yield* readBridgeRow("thread:override-off:out"))?.continuation_status, "skipped");
    assert.lengthOf(log.turns, 1);
  }).pipe(Effect.provide(layer));
});

it.live("keeps a thread skipped when the setting is enabled after the first startup", () => {
  const threadId = "thread:bridge:disabled-then-enabled";
  const { log, layer } = makeStack("bridge-toggle", { continueAfterUpdate: false });
  return Effect.gen(function* () {
    yield* importThreads([runningThread(threadId)]);
    const settings = yield* ServerSettingsService.ServerSettingsService;

    yield* (yield* startBridge).continuePending;
    assert.equal((yield* readBridgeRow(threadId))?.continuation_status, "skipped");
    assert.equal(yield* countRuns(threadId), 0);

    // Old V1 work must not come back to life because the user later opts in.
    yield* settings.updateSettings({ continueThreadsAfterServerUpdate: true });
    yield* (yield* startBridge).continuePending;

    assert.equal((yield* readBridgeRow(threadId))?.continuation_status, "skipped");
    assert.equal(yield* countRuns(threadId), 0);
    assert.isEmpty(log.turns);
    assert.isFalse(yield* transcriptImported(threadId));
  }).pipe(Effect.provide(layer));
});

it.live("fails closed when settings cannot be read", () => {
  const threadId = "thread:bridge:settings-unreadable";
  const { log, layer } = makeStack("bridge-settings-unreadable");
  return Effect.gen(function* () {
    yield* importThreads([runningThread(threadId)]);
    const settings = yield* ServerSettingsService.ServerSettingsService;
    const bridge = yield* startBridge.pipe(
      Effect.provideService(ServerSettingsService.ServerSettingsService, {
        ...settings,
        getSettings: Effect.fail(
          new ServerSettingsError({ settingsPath: "/tmp/settings.json", operation: "read-file" }),
        ),
      }),
    );

    yield* bridge.continuePending;

    assert.equal(yield* countRuns(threadId), 0);
    assert.isEmpty(log.turns);
  }).pipe(Effect.provide(layer));
});

it.live("never continues archived, deleted or project-deleted threads", () => {
  const { log, layer } = makeStack("bridge-retired");
  const deletedProject = ProjectId.make("project:bridge:deleted");
  return Effect.gen(function* () {
    yield* seedV1Project({ projectId: deletedProject, deletedAt: "2026-01-05T00:00:00.000Z" });
    yield* importThreads([
      // Retired before the upgrade: captured as ineligible.
      runningThread("thread:retired:archived-before", { archivedAt: "2026-01-05T00:00:00.000Z" }),
      runningThread("thread:retired:deleted-before", { deletedAt: "2026-01-05T00:00:00.000Z" }),
      runningThread("thread:retired:project-deleted-before", { projectId: deletedProject }),
      // Retired between the import and the continuation: rechecked at dispatch time.
      runningThread("thread:retired:archived-after"),
      runningThread("thread:retired:deleted-after"),
      runningThread("thread:retired:project-deleted-after", {
        projectId: ProjectId.make("project:bridge:deleted-later"),
      }),
      runningThread("thread:retired:control"),
    ]);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("command:retired:archive"),
      threadId: ThreadId.make("thread:retired:archived-after"),
    });
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("command:retired:delete"),
      threadId: ThreadId.make("thread:retired:deleted-after"),
    });
    yield* sql`
      UPDATE projection_projects SET deleted_at = '2026-02-01T00:00:00.000Z'
      WHERE project_id = 'project:bridge:deleted-later'
    `;
    const bridge = yield* startBridge;

    yield* settleCompletedRuns(1, bridge.continuePending);

    const retired = [
      "thread:retired:archived-before",
      "thread:retired:deleted-before",
      "thread:retired:project-deleted-before",
      "thread:retired:archived-after",
      "thread:retired:deleted-after",
      "thread:retired:project-deleted-after",
    ];
    for (const threadId of retired) {
      assert.equal(yield* countRuns(threadId), 0, threadId);
      assert.equal((yield* readBridgeRow(threadId))?.continuation_status, "skipped", threadId);
    }
    assert.equal(yield* countRuns("thread:retired:control"), 1);
    assert.deepStrictEqual(
      log.turns.map((turn) => turn.threadId),
      ["thread:retired:control"],
    );
  }).pipe(Effect.provide(layer));
});

it.live("skips threads whose provider instance is missing, disabled or the wrong driver", () => {
  const offLog = makeFakeAdapterLog();
  const offAdapter = makeFakeProviderAdapter({
    driver: "codex",
    instanceId: "codex-off",
    log: offLog,
  });
  const { log, layer } = makeStack("bridge-instances", {
    extraAdapters: [{ adapter: offAdapter, enabled: false }],
  });
  return Effect.gen(function* () {
    yield* importThreads([
      runningThread("thread:instance:missing", {
        modelSelection: { instanceId: "codex-gone", model: "gpt-5.4" },
        runtime: {
          providerName: "codex",
          providerInstanceId: "codex-gone",
          cursor: v1Cursors.codex("native-gone"),
        },
      }),
      runningThread("thread:instance:disabled", {
        modelSelection: { instanceId: "codex-off", model: "gpt-5.4" },
        runtime: {
          providerName: "codex",
          providerInstanceId: "codex-off",
          cursor: v1Cursors.codex("native-off"),
        },
      }),
      // The runtime row names the Claude driver but a Codex instance.
      runningThread("thread:instance:wrong-driver", {
        runtime: {
          providerName: "claudeAgent",
          providerInstanceId: "codex",
          cursor: v1Cursors.claudeAgent("thread:instance:wrong-driver"),
        },
      }),
      runningThread("thread:instance:control"),
    ]);
    const bridge = yield* startBridge;

    yield* settleCompletedRuns(1, bridge.continuePending);

    for (const threadId of [
      "thread:instance:missing",
      "thread:instance:disabled",
      "thread:instance:wrong-driver",
    ]) {
      assert.equal(yield* countRuns(threadId), 0, threadId);
      assert.equal((yield* readBridgeRow(threadId))?.continuation_status, "skipped", threadId);
      // Never substituted by another instance, and the binding stays for a manual turn.
      assert.lengthOf((yield* projectionOf(threadId)).providerThreads, 1, threadId);
    }
    assert.equal(yield* countRuns("thread:instance:control"), 1);
    assert.deepStrictEqual(
      log.turns.map((turn) => turn.threadId),
      ["thread:instance:control"],
    );
    assert.equal(offLog.openedSessions, 0);
    assert.isEmpty(offLog.turns);
  }).pipe(Effect.provide(layer));
});

it.live("lets a user turn that arrives first win over the startup continuation", () => {
  const threadId = "thread:bridge:user-wins";
  const { log, layer } = makeStack("bridge-user-wins");
  return Effect.gen(function* () {
    yield* importThreads([runningThread(threadId)]);
    const base = yield* Orchestrator.OrchestratorV2;
    // The user's message lands after the bridge chose the thread but before it submits.
    const racing = {
      ...base,
      dispatchLegacyV1Continuation: (
        input: Parameters<typeof base.dispatchLegacyV1Continuation>[0],
      ) =>
        settleCompletedRuns(1, dispatchUserMessage(threadId, "user got there first")).pipe(
          Effect.andThen(base.dispatchLegacyV1Continuation(input)),
        ),
    } satisfies typeof base;
    const bridge = yield* startBridge.pipe(
      Effect.provideService(Orchestrator.OrchestratorV2, racing),
    );

    yield* bridge.continuePending;

    assert.equal((yield* readBridgeRow(threadId))?.continuation_status, "skipped");
    assert.equal(yield* countRuns(threadId), 1);
    assert.deepStrictEqual(
      log.turns.map((turn) => turn.text),
      ["user got there first"],
    );
    assert.notInclude(
      (yield* projectionOf(threadId)).messages.map((message) => message.id),
      continuationMessageId(threadId),
    );
    assert.isUndefined(yield* readReceiptStatus(continuationCommandId(threadId)));
  }).pipe(Effect.provide(layer));
});

it.live("skips threads that share a native session instead of resuming it twice", () => {
  const { log, layer } = makeStack("bridge-aliases");
  return Effect.gen(function* () {
    const sharedCursor = v1Cursors.codex("native-shared-by-two");
    const shared = (threadId: string) =>
      runningThread(threadId, {
        runtime: { providerName: "codex", providerInstanceId: "codex", cursor: sharedCursor },
      });
    yield* importThreads([
      shared("thread:alias:a"),
      shared("thread:alias:b"),
      runningThread("thread:alias:unique"),
    ]);
    const bridge = yield* startBridge;

    yield* settleCompletedRuns(1, bridge.continuePending);

    for (const threadId of ["thread:alias:a", "thread:alias:b"]) {
      assert.equal(yield* countRuns(threadId), 0, threadId);
      assert.equal((yield* readBridgeRow(threadId))?.continuation_status, "skipped", threadId);
    }
    assert.equal(yield* countRuns("thread:alias:unique"), 1);
    assert.deepStrictEqual(
      log.turns.map((turn) => turn.threadId),
      ["thread:alias:unique"],
    );
  }).pipe(Effect.provide(layer));
});

it.live("submits once when the server stops before it dispatches", () => {
  const threadId = "thread:bridge:crash-before";
  const { log, layer } = makeStack("bridge-crash-before");
  return Effect.gen(function* () {
    yield* importThreads([runningThread(threadId)]);
    const base = yield* Orchestrator.OrchestratorV2;
    const entered = yield* Deferred.make<void>();
    const dying = {
      ...base,
      dispatchLegacyV1Continuation: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    } satisfies typeof base;
    const interrupted = yield* startBridge.pipe(
      Effect.provideService(Orchestrator.OrchestratorV2, dying),
    );
    const fiber = yield* Effect.forkChild(interrupted.continuePending);
    yield* awaitMilestone(entered, "the bridge to submit the continuation");
    yield* Fiber.interrupt(fiber);

    assert.equal((yield* readBridgeRow(threadId))?.continuation_status, "pending");
    assert.equal(yield* countRuns(threadId), 0);
    assert.isUndefined(yield* readReceiptStatus(continuationCommandId(threadId)));

    yield* settleCompletedRuns(1, (yield* startBridge).continuePending);

    assert.equal((yield* readBridgeRow(threadId))?.continuation_status, "submitted");
    assert.equal(yield* countRuns(threadId), 1);
    assert.lengthOf(log.turns, 1);
  }).pipe(Effect.provide(layer));
});

it.live("does not prompt again when the server stops after the command was accepted", () => {
  const threadId = "thread:bridge:crash-after";
  const { log, layer } = makeStack("bridge-crash-after");
  return Effect.gen(function* () {
    yield* importThreads([runningThread(threadId)]);
    const base = yield* Orchestrator.OrchestratorV2;
    const accepted = yield* Deferred.make<void>();
    const dying = {
      ...base,
      // The receipt commits, then the process dies before the bridge records `submitted`.
      dispatchLegacyV1Continuation: (
        input: Parameters<typeof base.dispatchLegacyV1Continuation>[0],
      ) =>
        base
          .dispatchLegacyV1Continuation(input)
          .pipe(
            Effect.andThen(Deferred.succeed(accepted, undefined)),
            Effect.andThen(Effect.never),
          ),
    } satisfies typeof base;
    const interrupted = yield* startBridge.pipe(
      Effect.provideService(Orchestrator.OrchestratorV2, dying),
    );
    yield* settleCompletedRuns(
      1,
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(interrupted.continuePending);
        yield* awaitMilestone(accepted, "the continuation to be accepted");
        yield* Fiber.interrupt(fiber);
      }),
    );

    assert.equal((yield* readBridgeRow(threadId))?.continuation_status, "pending");
    assert.equal(yield* readReceiptStatus(continuationCommandId(threadId)), "accepted");

    yield* (yield* startBridge).continuePending;

    assert.equal((yield* readBridgeRow(threadId))?.continuation_status, "submitted");
    assert.equal(yield* countRuns(threadId), 1);
    assert.lengthOf(log.turns, 1);
  }).pipe(Effect.provide(layer));
});

it.live(
  "leaves a thread pending after a transient persistence failure and still serves the rest",
  () => {
    const failingId = "thread:bridge:transient-a";
    const healthyId = "thread:bridge:transient-b";
    const { log, layer } = makeStack("bridge-transient");
    return Effect.gen(function* () {
      yield* importThreads([runningThread(failingId), runningThread(healthyId)]);
      const base = yield* Orchestrator.OrchestratorV2;
      let failedOnce = false;
      const flaky = {
        ...base,
        dispatchLegacyV1Continuation: (
          input: Parameters<typeof base.dispatchLegacyV1Continuation>[0],
        ) =>
          input.command.threadId === failingId && !failedOnce
            ? Effect.sync(() => {
                failedOnce = true;
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new Orchestrator.OrchestratorDispatchError({
                      commandId: input.command.commandId,
                      commandType: input.command.type,
                      cause: "database is locked",
                    }),
                  ),
                ),
              )
            : base.dispatchLegacyV1Continuation(input),
      } satisfies typeof base;
      const bridge = yield* startBridge.pipe(
        Effect.provideService(Orchestrator.OrchestratorV2, flaky),
      );

      // Startup never fails because of one thread.
      yield* settleCompletedRuns(1, bridge.continuePending);

      assert.equal((yield* readBridgeRow(failingId))?.continuation_status, "pending");
      assert.equal(yield* countRuns(failingId), 0);
      assert.equal((yield* readBridgeRow(healthyId))?.continuation_status, "submitted");

      // The next pass picks the pending thread up again.
      yield* settleCompletedRuns(1, bridge.continuePending);

      assert.equal((yield* readBridgeRow(failingId))?.continuation_status, "submitted");
      assert.equal(yield* countRuns(failingId), 1);
      assert.equal(yield* countRuns(healthyId), 1);
      assert.deepStrictEqual(log.turns.map((turn) => turn.threadId).toSorted(), [
        failingId,
        healthyId,
      ]);
    }).pipe(Effect.provide(layer));
  },
);

it.live("records a rejected continuation as skipped and never retries it", () => {
  const threadId = "thread:bridge:rejected";
  const { log, layer } = makeStack("bridge-rejected");
  return Effect.gen(function* () {
    yield* importThreads([runningThread(threadId)]);
    const base = yield* Orchestrator.OrchestratorV2;
    let attempts = 0;
    const rejecting = {
      ...base,
      dispatchLegacyV1Continuation: (
        input: Parameters<typeof base.dispatchLegacyV1Continuation>[0],
      ) =>
        Effect.suspend(() => {
          attempts += 1;
          return Effect.fail(
            new Orchestrator.OrchestratorCommandRejectedError({
              commandId: input.command.commandId,
              commandType: input.command.type,
              cause: "policy rejected the command",
            }),
          );
        }),
    } satisfies typeof base;
    const bridge = yield* startBridge.pipe(
      Effect.provideService(Orchestrator.OrchestratorV2, rejecting),
    );

    yield* bridge.continuePending;
    yield* bridge.continuePending;

    assert.equal((yield* readBridgeRow(threadId))?.continuation_status, "skipped");
    assert.equal(attempts, 1);
    assert.equal(yield* countRuns(threadId), 0);
    assert.isEmpty(log.turns);
  }).pipe(Effect.provide(layer));
});
