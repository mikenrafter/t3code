import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CommandId,
  ContextHandoffId,
  MessageId,
  NodeId,
  OrchestrationV2Command,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";

import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import {
  CONTINUATION_TEXT,
  bindNativeThreadManually,
  countRuns,
  legacyContinuationCommand,
  makeBridgeStack,
  makeFakeAdapterLog,
  makeFakeProviderAdapter,
  readReceiptStatus,
  seedV1Thread,
  settleCompletedRuns,
} from "./legacy/LegacyV1ResumeBridge.testkit.ts";
import {
  appendContextHandoffId,
  canReplayCommandReceipt,
  hasNativeResumeTarget,
  shouldPrepareLegacyImportHandoff,
} from "./Orchestrator.ts";
import * as Orchestrator from "./Orchestrator.ts";

it("reissues imported context until a V2 run completes", () => {
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
      hasNativeResumeTarget: false,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: true,
      legacyImportItemCount: 2,
      hasNativeResumeTarget: false,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: undefined,
      hasCompletedRun: false,
      legacyImportItemCount: 2,
      hasNativeResumeTarget: false,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 0,
      hasNativeResumeTarget: false,
    }),
  );
});

it("skips the imported-context handoff when the thread resumes its native session", () => {
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
      hasNativeResumeTarget: true,
    }),
  );
});

const codexDriver = ProviderDriverKind.make("codex");
const codexInstance = ProviderInstanceId.make("codex");
const targetThreadId = ThreadId.make("thread:native-target");

type ActiveProviderThread = Pick<
  OrchestrationV2ProviderThread,
  "driver" | "providerInstanceId" | "appThreadId" | "ownerNodeId" | "nativeThreadRef" | "status"
>;

const providerThreadFixture = (
  overrides: Partial<OrchestrationV2ProviderThread> = {},
): ActiveProviderThread => ({
  driver: codexDriver,
  providerInstanceId: codexInstance,
  appThreadId: targetThreadId,
  ownerNodeId: null,
  nativeThreadRef: { driver: codexDriver, nativeId: "native-codex-thread", strength: "strong" },
  status: "idle",
  ...overrides,
});

const nativeTarget = (
  activeProviderThread: ActiveProviderThread | undefined,
  selected: { instance?: string; driver?: string } = {},
) =>
  hasNativeResumeTarget({
    threadId: targetThreadId,
    activeProviderThread,
    providerInstanceId: ProviderInstanceId.make(selected.instance ?? "codex"),
    driver: ProviderDriverKind.make(selected.driver ?? "codex"),
  });

it("treats a strong, matching, usable root provider thread as a native resume target", () => {
  for (const status of ["idle", "active", "not_loaded"] as const) {
    assert.isTrue(nativeTarget(providerThreadFixture({ status })), status);
  }
});

it("keeps the legacy handoff when the native target is absent, weak, or for another provider", () => {
  assert.isFalse(nativeTarget(undefined));
  assert.isFalse(nativeTarget(providerThreadFixture({ nativeThreadRef: null })));
  for (const strength of ["weak", "none"] as const) {
    assert.isFalse(
      nativeTarget(
        providerThreadFixture({
          nativeThreadRef: { driver: codexDriver, nativeId: "native-codex-thread", strength },
        }),
      ),
      strength,
    );
  }
  assert.isFalse(
    nativeTarget(
      providerThreadFixture({
        nativeThreadRef: { driver: codexDriver, nativeId: null, strength: "strong" },
      }),
    ),
  );
  // The selected instance or driver is not the one that owns the native session.
  assert.isFalse(nativeTarget(providerThreadFixture(), { instance: "codex-work" }));
  assert.isFalse(nativeTarget(providerThreadFixture(), { driver: "claudeAgent" }));
  assert.isFalse(
    nativeTarget(
      providerThreadFixture({
        nativeThreadRef: {
          driver: ProviderDriverKind.make("claudeAgent"),
          nativeId: "native-codex-thread",
          strength: "strong",
        },
      }),
    ),
  );
  // Only the thread's own root provider thread counts, never a subagent's or another thread's.
  assert.isFalse(nativeTarget(providerThreadFixture({ ownerNodeId: NodeId.make("node:child") })));
  assert.isFalse(
    nativeTarget(providerThreadFixture({ appThreadId: ThreadId.make("thread:somewhere-else") })),
  );
  for (const status of ["closed", "archived", "error"] as const) {
    assert.isFalse(nativeTarget(providerThreadFixture({ status })), status);
  }
});

it("records a reissued legacy handoff on an existing provider thread", () => {
  const existingHandoffId = ContextHandoffId.make("handoff:legacy-import:existing");
  const retryHandoffId = ContextHandoffId.make("handoff:legacy-import:retry");

  assert.deepEqual(appendContextHandoffId([existingHandoffId], retryHandoffId), [
    existingHandoffId,
    retryHandoffId,
  ]);
  assert.deepEqual(appendContextHandoffId([existingHandoffId], existingHandoffId), [
    existingHandoffId,
  ]);
  assert.deepEqual(appendContextHandoffId([existingHandoffId], null), [existingHandoffId]);
});

it("only replays a command receipt for the thread it was recorded against", () => {
  const threadA = ThreadId.make("thread-a");
  const threadB = ThreadId.make("thread-b");

  assert.strictEqual(canReplayCommandReceipt(threadA, threadA), true);
  // A reused command id aimed at another thread must not report the first
  // thread's success as this thread's (v1 #5246).
  assert.strictEqual(canReplayCommandReceipt(threadA, threadB), false);
});

it("links and unlinks a pull request through thread.metadata.update (#8160)", () => {
  // The fold is exercised through the schema: a command carrying the link
  // must round-trip, and one without it must leave the field untouched.
  const decode = Schema.decodeUnknownSync(OrchestrationV2Command);
  const linked = decode({
    type: "thread.metadata.update",
    commandId: "command-link",
    threadId: "thread-1",
    linkedPullRequest: {
      projectId: "project-1",
      repository: "pingdotgg/t3code",
      number: 8160,
      url: "https://github.com/pingdotgg/t3code/pull/8160",
    },
  });
  assert.deepStrictEqual(
    (linked as Extract<typeof linked, { type: "thread.metadata.update" }>).linkedPullRequest,
    {
      projectId: "project-1",
      repository: "pingdotgg/t3code",
      number: 8160,
      url: "https://github.com/pingdotgg/t3code/pull/8160",
    },
  );
  const unlinked = decode({
    type: "thread.metadata.update",
    commandId: "command-unlink",
    threadId: "thread-1",
    linkedPullRequest: null,
  });
  assert.strictEqual(
    (unlinked as Extract<typeof unlinked, { type: "thread.metadata.update" }>).linkedPullRequest,
    null,
  );
});

const nativeBindingId = (threadId: string) =>
  ProviderThreadId.make(`provider-thread:migration:v1:${threadId}`);

/** A codex adapter with a recording log, over a fresh in-memory V2 stack. */
const makeCodexStack = (name: string, options: { readonly resume?: "succeed" | "fail" } = {}) => {
  const log = makeFakeAdapterLog();
  const adapter = makeFakeProviderAdapter({
    driver: "codex",
    log,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
  });
  return { log, layer: makeBridgeStack({ name, adapters: [{ adapter }] }) };
};

/** An imported V1 shell with its full transcript, optionally already bound to a native session. */
const prepareImportedThread = (
  threadId: string,
  binding?: { readonly nativeId: string; readonly strength?: "strong" | "weak" },
) =>
  Effect.gen(function* () {
    yield* seedV1Thread({ threadId });
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    yield* importer.reconcileShells;
    yield* importer.ensureTranscript(ThreadId.make(threadId));
    if (binding !== undefined) {
      yield* bindNativeThreadManually({ threadId, driver: "codex", ...binding });
    }
  });

const sendUserMessage = (threadId: string, text: string) =>
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

it.live("resumes the bound native session on the first turn without a legacy handoff", () => {
  const threadId = "thread:migration:resume-no-handoff";
  const { log, layer } = makeCodexStack("migration-resume-no-handoff");
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* prepareImportedThread(threadId, { nativeId: "native-from-v1" });

    yield* settleCompletedRuns(1, sendUserMessage(threadId, "carry on"));

    assert.deepStrictEqual(log.resumedNativeIds, ["native-from-v1"]);
    assert.deepStrictEqual(log.ensuredThreads, []);
    // The provider already holds the conversation: nothing is replayed into the prompt.
    assert.deepStrictEqual(
      log.turns.map((turn) => [turn.nativeId, turn.text]),
      [["native-from-v1", "carry on"]],
    );
    const projection = yield* orchestrator.getThreadProjection(ThreadId.make(threadId));
    assert.isEmpty(projection.contextHandoffs);
    assert.deepStrictEqual(
      projection.providerThreads.map((thread) => thread.id),
      [nativeBindingId(threadId)],
    );
    assert.equal(projection.runs.at(-1)?.status, "completed");
    assert.isNull(projection.runs.at(-1)?.contextHandoffId);
  }).pipe(Effect.provide(layer));
});

it.live("keeps the legacy handoff for an imported thread without a native binding", () => {
  const threadId = "thread:migration:unbound-handoff";
  const { log, layer } = makeCodexStack("migration-unbound-handoff");
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* prepareImportedThread(threadId);

    yield* settleCompletedRuns(1, sendUserMessage(threadId, "carry on"));

    assert.deepStrictEqual(log.resumedNativeIds, []);
    assert.deepStrictEqual(log.ensuredThreads, [threadId]);
    const projection = yield* orchestrator.getThreadProjection(ThreadId.make(threadId));
    assert.lengthOf(projection.contextHandoffs, 1);
    assert.include(log.turns[0]?.text ?? "", "Context handoff (manual_context):");
    assert.include(log.turns[0]?.text ?? "", `V1 history 1 of ${threadId}`);
  }).pipe(Effect.provide(layer));
});

it.live("keeps the legacy handoff when the native reference is weak", () => {
  const threadId = "thread:migration:weak-handoff";
  const { log, layer } = makeCodexStack("migration-weak-handoff");
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* prepareImportedThread(threadId, { nativeId: "native-weak", strength: "weak" });

    yield* settleCompletedRuns(1, sendUserMessage(threadId, "carry on"));

    const projection = yield* orchestrator.getThreadProjection(ThreadId.make(threadId));
    assert.lengthOf(projection.contextHandoffs, 1);
    assert.include(log.turns[0]?.text ?? "", "Context handoff (manual_context):");
  }).pipe(Effect.provide(layer));
});

const modelSelection = { instanceId: codexInstance, model: "gpt-5.4" };

it.live("submits the one-time continuation once and treats a repeat as already submitted", () => {
  const threadId = "thread:migration:continue-once";
  const { log, layer } = makeCodexStack("migration-continue-once");
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* prepareImportedThread(threadId, { nativeId: "native-continue" });
    const command = legacyContinuationCommand(threadId, modelSelection);
    const input = { command, expectedProviderThreadId: nativeBindingId(threadId) };

    const first = yield* settleCompletedRuns(1, orchestrator.dispatchLegacyV1Continuation(input));
    assert.equal(first.outcome, "submitted");
    assert.equal(yield* readReceiptStatus(command.commandId), "accepted");

    const projection = yield* orchestrator.getThreadProjection(ThreadId.make(threadId));
    assert.equal(projection.runs.length, 1);
    const run = projection.runs[0]!;
    assert.equal(run.status, "completed");
    assert.equal(run.userMessageId, command.messageId);
    // A normal dispatch: nothing pretends a cancelled source run existed.
    assert.isUndefined(run.restartContinuationOfRunId);
    const message = projection.messages.find((candidate) => candidate.id === command.messageId);
    assert.equal(message?.text, CONTINUATION_TEXT);
    assert.equal(message?.createdBy, "agent");
    assert.equal(message?.creationSource, "server");
    assert.deepStrictEqual(run.modelSelection, modelSelection);
    assert.deepStrictEqual(log.resumedNativeIds, ["native-continue"]);
    assert.deepStrictEqual(log.ensuredThreads, []);
    assert.isEmpty(projection.contextHandoffs);
    assert.deepStrictEqual(
      log.turns.map((turn) => turn.text),
      [CONTINUATION_TEXT],
    );

    // A user turn runs after it, so the thread is no longer untouched; the receipt still answers first.
    yield* settleCompletedRuns(1, sendUserMessage(threadId, "and now me"));
    const repeat = yield* orchestrator.dispatchLegacyV1Continuation(input);
    assert.equal(repeat.outcome, "submitted");
    assert.equal(yield* countRuns(threadId), 2);
    assert.lengthOf(log.turns, 2);
  }).pipe(Effect.provide(layer));
});

it.live("skips the continuation when a V2 run already exists", () => {
  const threadId = "thread:migration:continue-after-user";
  const { log, layer } = makeCodexStack("migration-continue-after-user");
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* prepareImportedThread(threadId, { nativeId: "native-after-user" });
    yield* settleCompletedRuns(1, sendUserMessage(threadId, "user first"));
    const command = legacyContinuationCommand(threadId, modelSelection);

    const result = yield* orchestrator.dispatchLegacyV1Continuation({
      command,
      expectedProviderThreadId: nativeBindingId(threadId),
    });

    assert.equal(result.outcome, "skipped");
    assert.equal(yield* countRuns(threadId), 1);
    assert.isUndefined(yield* readReceiptStatus(command.commandId));
    const projection = yield* orchestrator.getThreadProjection(ThreadId.make(threadId));
    assert.notInclude(
      projection.messages.map((message) => message.id),
      command.messageId,
    );
    assert.deepStrictEqual(
      log.turns.map((turn) => turn.text),
      ["user first"],
    );
  }).pipe(Effect.provide(layer));
});

it.live("skips the continuation when the thread is archived", () => {
  const threadId = "thread:migration:continue-archived";
  const { log, layer } = makeCodexStack("migration-continue-archived");
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* prepareImportedThread(threadId, { nativeId: "native-archived" });
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("command:migration:archive"),
      threadId: ThreadId.make(threadId),
    });

    const result = yield* orchestrator.dispatchLegacyV1Continuation({
      command: legacyContinuationCommand(threadId, modelSelection),
      expectedProviderThreadId: nativeBindingId(threadId),
    });

    assert.equal(result.outcome, "skipped");
    assert.equal(yield* countRuns(threadId), 0);
    assert.isEmpty(log.turns);
  }).pipe(Effect.provide(layer));
});

it.live("skips the continuation when the binding is not the one the bridge captured", () => {
  const boundId = "thread:migration:continue-rebound";
  const unboundId = "thread:migration:continue-unbound";
  const { log, layer } = makeCodexStack("migration-continue-binding");
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* prepareImportedThread(boundId, { nativeId: "native-rebound" });
    yield* prepareImportedThread(unboundId);

    const mismatched = yield* orchestrator.dispatchLegacyV1Continuation({
      command: legacyContinuationCommand(boundId, modelSelection),
      expectedProviderThreadId: ProviderThreadId.make("provider-thread:somewhere-else"),
    });
    const unbound = yield* orchestrator.dispatchLegacyV1Continuation({
      command: legacyContinuationCommand(unboundId, modelSelection),
      expectedProviderThreadId: nativeBindingId(unboundId),
    });

    assert.equal(mismatched.outcome, "skipped");
    assert.equal(unbound.outcome, "skipped");
    assert.equal(yield* countRuns(boundId), 0);
    assert.equal(yield* countRuns(unboundId), 0);
    assert.isEmpty(log.turns);
  }).pipe(Effect.provide(layer));
});

it.live("skips the continuation when the thread now selects another model instance", () => {
  const threadId = "thread:migration:continue-switched";
  const { log, layer } = makeCodexStack("migration-continue-switched");
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* prepareImportedThread(threadId, { nativeId: "native-switched" });

    // The captured selection no longer matches the thread's own selection.
    const result = yield* orchestrator.dispatchLegacyV1Continuation({
      command: legacyContinuationCommand(threadId, {
        instanceId: ProviderInstanceId.make("codex-work"),
        model: "gpt-5.4",
      }),
      expectedProviderThreadId: nativeBindingId(threadId),
    });

    assert.equal(result.outcome, "skipped");
    assert.equal(yield* countRuns(threadId), 0);
    assert.isEmpty(log.turns);
  }).pipe(Effect.provide(layer));
});

it.live("does not hold the thread's command lock after a continuation", () => {
  const threadId = "thread:migration:continue-lock";
  const { layer } = makeCodexStack("migration-continue-lock");
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* prepareImportedThread(threadId, { nativeId: "native-lock" });
    yield* settleCompletedRuns(
      1,
      orchestrator.dispatchLegacyV1Continuation({
        command: legacyContinuationCommand(threadId, modelSelection),
        expectedProviderThreadId: nativeBindingId(threadId),
      }),
    );

    // Any ordinary command on the same thread must still get through.
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("command:migration:lock:archive"),
      threadId: ThreadId.make(threadId),
    });
    const projection = yield* orchestrator.getThreadProjection(ThreadId.make(threadId));
    assert.isNotNull(projection.thread.archivedAt);
  }).pipe(Effect.provide(layer));
});
