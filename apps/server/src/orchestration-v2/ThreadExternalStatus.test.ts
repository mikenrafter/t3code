import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * An external status overlay (usagewindow, ...) is stored on the thread
 * payload. When a native run transition matches the status's `clearsOn`, the
 * projection itself drops the overlay, so every client and a projection
 * rebuild agree without the UI having to guess.
 */
const SqlLayer = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const layers = [
  ["sql", SqlLayer],
  ["memory", ProjectionStore.layerMemory],
] as const;

const at = DateTime.makeUnsafe("2026-09-22T11:00:00Z");
const later = DateTime.makeUnsafe("2026-09-22T12:00:00Z");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "test-model" };

type ClearsOn = "work" | "error" | "done" | `custom:${string}` | null;
const externalStatus = (clearsOn: ClearsOn) =>
  ({
    source: "usagewindow",
    key: "compacting",
    text: "Compacting",
    icon: "shrink",
    color: "amber",
    notifyUser: true,
    expiresAt: null,
    clearsOn,
    updatedAt: "2026-09-22T11:30:00.000Z",
  }) as const;

const createThread = Effect.fn(function* (name: string) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:external-status:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:external-status"),
    title: name,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* store.apply({
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: at,
    payload: thread,
  });
  return threadId;
});

let eventCounter = 0;
const nextEventId = (label: string) =>
  EventId.make(`event:external-status:${label}:${eventCounter++}`);

/** Writes the overlay the way a committed `thread.metadata-updated` event folds it. */
const writeStatus = Effect.fn(function* (
  threadId: ThreadId,
  status: ReturnType<typeof externalStatus> | null,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const thread = yield* store.getThread(threadId);
  yield* store.apply({
    id: nextEventId("metadata"),
    type: "thread.metadata-updated",
    threadId,
    occurredAt: later,
    payload: { ...thread, externalStatus: status, updatedAt: later },
  });
});

const runPayload = (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
  ordinal = 1,
): OrchestrationV2Run => {
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  const terminal = ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
    status,
  );
  return {
    id: runId,
    threadId,
    ordinal,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${runId}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: at,
    startedAt: status === "queued" ? null : at,
    completedAt: terminal ? later : null,
    checkpointId: null,
    contextHandoffId: null,
  };
};

/** `created` is a new run; otherwise the event updates an existing one. */
const writeRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
  options: { readonly created?: boolean; readonly ordinal?: number } = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: nextEventId("run"),
    type: options.created ? "run.created" : "run.updated",
    threadId,
    occurredAt: later,
    payload: runPayload(threadId, status, options.ordinal ?? 1),
  });
});

const visibleStatus = Effect.fn(function* (threadId: ThreadId) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const thread = yield* store.getThread(threadId);
  const shell = yield* store.getThreadShell(threadId);
  assert.isNotNull(shell);
  const snapshot = yield* store.getShellSnapshot({ location: "active" });
  const listed = snapshot.threads.find((candidate) => candidate.id === threadId);
  assert.deepEqual(
    listed?.externalStatus,
    shell.externalStatus,
    "the shell list and the point read agree",
  );
  assert.deepEqual(shell.externalStatus, thread.externalStatus);
  return thread.externalStatus;
});

it.effect.each(layers)(
  "%s: projects a set status into the thread and shell, null clears",
  ([, layer]) =>
    Effect.gen(function* () {
      const threadId = yield* createThread("set-clear");
      assert.isUndefined(yield* visibleStatus(threadId));

      yield* writeStatus(threadId, externalStatus("custom:resume-complete"));
      assert.deepEqual(yield* visibleStatus(threadId), externalStatus("custom:resume-complete"));

      yield* writeStatus(threadId, null);
      assert.isNull(yield* visibleStatus(threadId));
    }).pipe(Effect.provide(layer)),
);

// [clearsOn, run event applied after the status was set, whether the overlay is cleared]
type Case = readonly [
  clearsOn: ClearsOn,
  label: string,
  seed: ReadonlyArray<OrchestrationV2Run["status"]>,
  event: OrchestrationV2Run["status"],
  options: { readonly created?: boolean; readonly ordinal?: number },
  cleared: boolean,
];
const cases: ReadonlyArray<Case> = [
  // "work": a run starts doing work.
  ["work", "new run starting", [], "starting", { created: true }, true],
  ["work", "new run preparing", [], "preparing", { created: true }, true],
  ["work", "new run running", [], "running", { created: true }, true],
  [
    "work",
    "a run after a completed one",
    ["completed"],
    "starting",
    { created: true, ordinal: 2 },
    true,
  ],
  ["work", "a queued run does not start work", [], "queued", { created: true }, false],
  ["work", "queued run later starting", ["queued"], "starting", {}, true],
  ["work", "completion of work that began before the status", ["running"], "completed", {}, false],
  ["work", "a repeat of the running state", ["running"], "running", {}, false],
  ["work", "running run waiting on the user", ["running"], "waiting", {}, false],
  ["work", "failure does not count as starting", [], "failed", { created: true }, false],
  // "error": a run fails.
  ["error", "run failing", ["running"], "failed", {}, true],
  ["error", "run completing", ["running"], "completed", {}, false],
  ["error", "run starting", [], "starting", { created: true }, false],
  // "done": a run completes.
  ["done", "run completing", ["running"], "completed", {}, true],
  ["done", "run failing", ["running"], "failed", {}, false],
  ["done", "run cancelled", ["running"], "cancelled", {}, false],
  ["done", "run interrupted", ["running"], "interrupted", {}, false],
  ["done", "a repeat of an earlier completion", ["completed"], "completed", {}, false],
  // Producer-owned: native transitions never clear them.
  [null, "run starting", [], "starting", { created: true }, false],
  [null, "run failing", ["running"], "failed", {}, false],
  [null, "run completing", ["running"], "completed", {}, false],
  ["custom:resume-complete", "run starting", [], "starting", { created: true }, false],
  ["custom:resume-complete", "run failing", ["running"], "failed", {}, false],
  ["custom:resume-complete", "run completing", ["running"], "completed", {}, false],
];

for (const [name, layer] of layers) {
  for (const [clearsOn, label, seed, event, options, cleared] of cases) {
    it.effect(
      `${name}: clearsOn ${String(clearsOn)} ${cleared ? "clears" : "keeps"} the overlay on ${label}`,
      () =>
        Effect.gen(function* () {
          const threadId = yield* createThread(`matrix:${String(clearsOn)}:${label}`);
          // Runs that already exist when the producer sets its status.
          for (const [index, status] of seed.entries()) {
            yield* writeRun(threadId, status, { created: index === 0 });
          }
          yield* writeStatus(threadId, externalStatus(clearsOn));
          assert.deepEqual(yield* visibleStatus(threadId), externalStatus(clearsOn));

          yield* writeRun(threadId, event, options);

          const after = yield* visibleStatus(threadId);
          if (cleared) {
            assert.isNull(after);
          } else {
            assert.deepEqual(after, externalStatus(clearsOn));
          }
        }).pipe(Effect.provide(layer)),
    );
  }
}

it.effect.each(layers)("%s: a later status replaces the one a transition cleared", ([, layer]) =>
  Effect.gen(function* () {
    const threadId = yield* createThread("replace-after-clear");
    yield* writeStatus(threadId, externalStatus("work"));
    yield* writeRun(threadId, "starting", { created: true });
    assert.isNull(yield* visibleStatus(threadId));

    yield* writeStatus(threadId, externalStatus("done"));
    assert.deepEqual(yield* visibleStatus(threadId), externalStatus("done"));
    yield* writeRun(threadId, "completed");
    assert.isNull(yield* visibleStatus(threadId));
  }).pipe(Effect.provide(layer)),
);
