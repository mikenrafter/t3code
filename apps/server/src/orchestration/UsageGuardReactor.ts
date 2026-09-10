import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { evaluateUsageGuard, resolveGuardResumeAt } from "./UsageGuardPolicy.ts";

export class UsageGuardReactor extends Context.Service<
  UsageGuardReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/UsageGuardReactor") {}

/**
 * Watches the provider usage windows (#9507) against each thread's guard
 * record: at 90% of a session window it persists a prompt, at 95% it settles
 * the thread into a paused guard with a 5h-capped resume schedule, and when a
 * paused schedule comes due it fires the continuation turn.
 *
 * Providers that publish no windows (Cursor, Grok, OpenCode, Antigravity)
 * never trigger this reactor; their limit stops reach the guard through the
 * provider-error path instead.
 *
 * Claude and Codex push window updates outside turn events, so a mid-turn
 * crossing is caught by the minute sweep rather than the moment it happens;
 * the provider-error path covers the turn that actually gets rate-limited.
 *
 * @module orchestration/UsageGuardReactor
 */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const registry = yield* ProviderInstanceRegistry;
  const crypto = yield* Crypto.Crypto;

  const windowsForInstance = Effect.fn("UsageGuardReactor.windowsForInstance")(function* (
    shell: OrchestrationThreadShell,
  ) {
    // The running session's instance wins over the thread's model selection:
    // a turn mid-flight reports against the instance actually serving it.
    const instanceId = shell.session?.providerInstanceId ?? shell.modelSelection.instanceId;
    const instance = yield* registry.getInstance(instanceId);
    if (instance === undefined) return undefined;
    const snapshot = yield* instance.snapshot.getSnapshot;
    return snapshot.usageLimits?.windows ?? [];
  });

  const evaluateThread = Effect.fn("UsageGuardReactor.evaluateThread")(function* (
    shell: OrchestrationThreadShell,
    snapshotSequence: number,
  ) {
    if (shell.archivedAt !== null) return;
    const windows = yield* windowsForInstance(shell);
    if (windows === undefined || windows.length === 0) return;
    const nowMs = Date.parse(DateTime.formatIso(yield* DateTime.now));
    const evaluation = evaluateUsageGuard({
      windows,
      guard: shell.usageGuard ?? null,
      nowMs,
    });
    if (evaluation.action === "none") return;
    const now = DateTime.formatIso(yield* DateTime.now);
    const uuid = yield* crypto.randomUUIDv4;
    const guard = {
      windowId: evaluation.window.id,
      windowKind: evaluation.window.kind,
      usedPercent: evaluation.usedPercent,
      windowResetsAt: evaluation.window.resetsAt ?? null,
      reason: "threshold" as const,
      updatedAt: now,
      ...(evaluation.action === "prompt"
        ? { phase: "prompted" as const }
        : {
            phase: "paused" as const,
            resumeAt: resolveGuardResumeAt({ window: evaluation.window, nowMs }),
            scheduledAt: now,
          }),
    };
    yield* engine.dispatch({
      type: "thread.usage-guard.settle",
      commandId: CommandId.make(`server:usage-guard:${shell.id}:${uuid}`),
      threadId: shell.id,
      guard,
      snapshotSequence,
      createdAt: now,
    });
  });

  const resumeDueThread = Effect.fn("UsageGuardReactor.resumeDueThread")(function* (
    shell: OrchestrationThreadShell,
  ) {
    const guard = shell.usageGuard;
    if (guard === null || guard === undefined || guard.phase !== "paused") return;
    if (guard.scheduledAt === null || guard.scheduledAt === undefined) return;
    const resumeAt = guard.resumeAt;
    // A paused guard without a schedule (a weekly window's stop) waits for the
    // user; with one, wait until it comes due.
    const nowMs = Date.parse(DateTime.formatIso(yield* DateTime.now));
    if (resumeAt === null || resumeAt === undefined || Date.parse(resumeAt) > nowMs) return;
    const uuid = yield* crypto.randomUUIDv4;
    yield* engine.dispatch({
      type: "thread.usage-guard.resume",
      commandId: CommandId.make(`server:usage-guard-resume:${shell.id}:${uuid}`),
      threadId: shell.id,
      scheduledAt: guard.scheduledAt,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
    });
  });

  const runItem = (threadId: ThreadId | null) =>
    Effect.gen(function* () {
      const snapshot = yield* snapshots.getShellSnapshot();
      const shells = snapshot.threads.filter((shell) => shell.archivedAt === null);
      if (threadId !== null) {
        const shell = shells.find((entry) => entry.id === threadId);
        if (shell === undefined) return;
        yield* evaluateThread(shell, snapshot.snapshotSequence);
        return;
      }
      // Sweep: catch window updates that arrive outside turn boundaries
      // (provider probes, mid-turn pushes), plus every paused schedule that
      // has come due.
      for (const shell of shells) {
        const paused = shell.usageGuard?.phase === "paused";
        const active = shell.session?.status === "running" || shell.session?.status === "starting";
        if (paused) {
          yield* resumeDueThread(shell);
        } else if (active) {
          yield* evaluateThread(shell, snapshot.snapshotSequence);
        }
      }
    });

  const runItemSafely = (threadId: ThreadId | null) =>
    runItem(threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("usage guard evaluation failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(runItemSafely);

  const start: UsageGuardReactor["Service"]["start"] = Effect.fn("UsageGuardReactor.start")(
    function* () {
      const events = yield* engine.subscribeDomainEvents;
      const processEvent = (event: OrchestrationEvent) => {
        // Turn boundaries are the spec's evaluation points: before each model
        // request (turn start) and after one completes (diff completion).
        // Settled events are this reactor's own output — reacting would loop.
        if (
          event.type === "thread.turn-start-requested" ||
          event.type === "thread.turn-diff-completed"
        ) {
          return worker.enqueue(event.payload.threadId);
        }
        return Effect.void;
      };
      yield* forkParked(Stream.runForEach(events, processEvent));
      yield* forkParked(
        Effect.gen(function* () {
          yield* worker.enqueue(null);
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
      );
    },
  );

  return { start, drain: worker.drain } satisfies UsageGuardReactor["Service"];
});

export const layer = Layer.effect(UsageGuardReactor, make);
