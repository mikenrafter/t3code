import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationUsageGuard,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
// The decider's clock is the Effect test clock, pinned to the epoch, so
// timestamps the decider stamps itself land at 1970-01-01T00:00:00.000Z.
const SETTLED_AT = "2026-01-04T00:00:00.000Z";
const RESUME_NOW = "2026-01-05T00:00:00.000Z";

function makeGuard(input: {
  readonly phase: OrchestrationUsageGuard["phase"];
  readonly windowId?: string;
  readonly windowResetsAt?: string | null;
  readonly scheduledAt?: string | null;
}): OrchestrationUsageGuard {
  return {
    windowId: input.windowId ?? "five_hour",
    windowKind: "session",
    usedPercent: 92,
    windowResetsAt: input.windowResetsAt ?? null,
    phase: input.phase,
    reason: "threshold",
    ...(input.scheduledAt === undefined ? {} : { scheduledAt: input.scheduledAt }),
    updatedAt: NOW,
  };
}

function makeReadModel(input: {
  readonly usageGuard?: OrchestrationUsageGuard | null;
  readonly archivedAt?: string | null;
  readonly snapshotSequence?: number;
  readonly sessionStatus?: "idle" | "running" | "starting";
}): OrchestrationReadModel {
  return {
    snapshotSequence: input.snapshotSequence ?? 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input.archivedAt ?? null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        usageGuard: input.usageGuard ?? null,
        session:
          input.sessionStatus === undefined
            ? null
            : {
                threadId: ThreadId.make("thread-1"),
                status: input.sessionStatus,
                providerName: null,
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: NOW,
              },
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("usage-guard decider", (it) => {
  it.effect("suppresses a prompted guard for its window's reset", () =>
    Effect.gen(function* () {
      const resetsAt = "2026-01-01T05:00:00.000Z";
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-guard.suppress",
          commandId: CommandId.make("cmd-suppress"),
          threadId: ThreadId.make("thread-1"),
          windowId: "five_hour",
          createdAt: NOW,
        },
        readModel: makeReadModel({
          usageGuard: makeGuard({ phase: "prompted", windowResetsAt: resetsAt }),
        }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event?.type === "thread.usage-guard.suppressed") {
        expect(event.payload.guard.phase).toBe("suppressed");
        expect(event.payload.guard.suppressUntil).toBe(resetsAt);
        expect(event.payload.guard.resumeAt ?? null).toBeNull();
        expect(event.payload.guard.scheduledAt ?? null).toBeNull();
      }
    }),
  );

  it("rejects suppressing without a guard for the named window", () =>
    Effect.gen(function* () {
      const noGuard = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.usage-guard.suppress",
            commandId: CommandId.make("cmd-suppress-none"),
            threadId: ThreadId.make("thread-1"),
            windowId: "five_hour",
            createdAt: NOW,
          },
          readModel: makeReadModel({}),
        }),
      );
      expect(noGuard._tag).toBe("OrchestrationCommandInvariantError");

      const staleWindow = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.usage-guard.suppress",
            commandId: CommandId.make("cmd-suppress-stale"),
            threadId: ThreadId.make("thread-1"),
            windowId: "five_hour",
            createdAt: NOW,
          },
          readModel: makeReadModel({
            usageGuard: makeGuard({ phase: "prompted", windowId: "primary" }),
          }),
        }),
      );
      expect(staleWindow._tag).toBe("OrchestrationCommandInvariantError");
    }));

  it("re-emits suppression idempotently without churning timestamps", () =>
    Effect.gen(function* () {
      const resetsAt = "2026-01-01T05:00:00.000Z";
      const existing = {
        ...makeGuard({ phase: "suppressed" as const, windowResetsAt: resetsAt }),
        suppressUntil: resetsAt,
        updatedAt: NOW,
      } satisfies OrchestrationUsageGuard;
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-guard.suppress",
          commandId: CommandId.make("cmd-suppress-again"),
          threadId: ThreadId.make("thread-1"),
          windowId: "five_hour",
          createdAt: NOW,
        },
        readModel: makeReadModel({ usageGuard: existing }),
      });
      const events = Array.isArray(result) ? result : [result];
      const event = events[0];
      if (event?.type === "thread.usage-guard.suppressed") {
        expect(event.payload.guard).toEqual(existing);
        expect(event.payload.updatedAt).toBe(NOW);
      }
    }));

  it("rejects suppressing an archived thread", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.usage-guard.suppress",
            commandId: CommandId.make("cmd-suppress-archived"),
            threadId: ThreadId.make("thread-1"),
            windowId: "five_hour",
            createdAt: NOW,
          },
          readModel: makeReadModel({
            archivedAt: NOW,
            usageGuard: makeGuard({ phase: "prompted" }),
          }),
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }));

  it("settles with the reactor-computed guard at the command's time", () =>
    Effect.gen(function* () {
      const settledGuard = makeGuard({ phase: "paused", scheduledAt: SETTLED_AT });
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-guard.settle",
          commandId: CommandId.make("cmd-settle"),
          threadId: ThreadId.make("thread-1"),
          guard: settledGuard,
          snapshotSequence: 0,
          createdAt: RESUME_NOW,
        },
        readModel: makeReadModel({ usageGuard: makeGuard({ phase: "prompted" }) }),
      });
      const events = Array.isArray(result) ? result : [result];
      const event = events[0];
      if (event?.type === "thread.usage-guard.settled") {
        expect(event.payload.guard).toEqual(settledGuard);
        expect(event.payload.updatedAt).toBe(RESUME_NOW);
      }
    }));

  it("rejects a settle computed from a stale snapshot", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.usage-guard.settle",
            commandId: CommandId.make("cmd-settle-stale"),
            threadId: ThreadId.make("thread-1"),
            guard: makeGuard({ phase: "paused", scheduledAt: SETTLED_AT }),
            snapshotSequence: 3,
            createdAt: RESUME_NOW,
          },
          readModel: makeReadModel({ snapshotSequence: 5 }),
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }));

  it("re-emits a settle without churning when the thread already paused", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-guard.settle",
          commandId: CommandId.make("cmd-settle-again"),
          threadId: ThreadId.make("thread-1"),
          guard: makeGuard({ phase: "paused", scheduledAt: SETTLED_AT }),
          snapshotSequence: 0,
          createdAt: RESUME_NOW,
        },
        readModel: makeReadModel({
          usageGuard: makeGuard({ phase: "paused", scheduledAt: SETTLED_AT }),
        }),
      });
      const events = Array.isArray(result) ? result : [result];
      const event = events[0];
      if (event?.type === "thread.usage-guard.settled") {
        expect(event.payload.updatedAt).toBe(NOW);
      }
    }));

  it("resumes a paused guard with its continuation turn", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-guard.resume",
          commandId: CommandId.make("cmd-resume"),
          threadId: ThreadId.make("thread-1"),
          scheduledAt: SETTLED_AT,
          createdAt: RESUME_NOW,
        },
        readModel: makeReadModel({
          usageGuard: makeGuard({
            phase: "paused",
            windowResetsAt: RESUME_NOW,
            scheduledAt: SETTLED_AT,
          }),
        }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((entry) => entry.type)).toEqual([
        "thread.usage-guard.resumed",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const resumed = events[0];
      const message = events[1];
      const turnStart = events[2];
      if (
        resumed?.type === "thread.usage-guard.resumed" &&
        message?.type === "thread.message-sent" &&
        turnStart?.type === "thread.turn-start-requested"
      ) {
        expect(resumed.payload.waitedMs).toBe(24 * 60 * 60 * 1000);
        expect(resumed.payload.scheduledAt).toBe(SETTLED_AT);
        expect(message.causationEventId).toBe(resumed.eventId);
        expect(message.payload.text).toContain("paused 24 hours ago");
        expect(turnStart.causationEventId).toBe(resumed.eventId);
        expect(turnStart.payload.messageId).toBe(message.payload.messageId);
        expect(turnStart.payload.messageId).toBe(
          MessageId.make(`usage-guard-resume:${CommandId.make("cmd-resume")}`),
        );
      }
    }));

  it("no-ops a stale resume instead of starting a surprise turn", () =>
    Effect.gen(function* () {
      const wrongSchedule = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-guard.resume",
          commandId: CommandId.make("cmd-resume-wrong"),
          threadId: ThreadId.make("thread-1"),
          scheduledAt: SETTLED_AT,
          createdAt: RESUME_NOW,
        },
        readModel: makeReadModel({
          usageGuard: {
            ...makeGuard({ phase: "paused", scheduledAt: SETTLED_AT }),
            scheduledAt: "2026-01-03T00:00:00.000Z",
          },
        }),
      });
      expect(Array.isArray(wrongSchedule) ? wrongSchedule : [wrongSchedule]).toHaveLength(0);

      const prompted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-guard.resume",
          commandId: CommandId.make("cmd-resume-prompted"),
          threadId: ThreadId.make("thread-1"),
          scheduledAt: SETTLED_AT,
          createdAt: RESUME_NOW,
        },
        readModel: makeReadModel({
          usageGuard: makeGuard({ phase: "prompted", scheduledAt: null }),
        }),
      });
      expect(Array.isArray(prompted) ? prompted : [prompted]).toHaveLength(0);

      const noGuard = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-guard.resume",
          commandId: CommandId.make("cmd-resume-none"),
          threadId: ThreadId.make("thread-1"),
          scheduledAt: SETTLED_AT,
          createdAt: RESUME_NOW,
        },
        readModel: makeReadModel({}),
      });
      expect(Array.isArray(noGuard) ? noGuard : [noGuard]).toHaveLength(0);
    }));

  it("no-ops a resume when the user already started their own turn", () =>
    Effect.gen(function* () {
      const resumeWithSession = (sessionStatus: "running" | "starting") =>
        decideOrchestrationCommand({
          command: {
            type: "thread.usage-guard.resume",
            commandId: CommandId.make(`cmd-resume-${sessionStatus}`),
            threadId: ThreadId.make("thread-1"),
            scheduledAt: SETTLED_AT,
            createdAt: RESUME_NOW,
          },
          readModel: makeReadModel({
            usageGuard: makeGuard({ phase: "paused", scheduledAt: SETTLED_AT }),
            sessionStatus,
          }),
        });

      const running = yield* resumeWithSession("running");
      expect(Array.isArray(running) ? running : [running]).toHaveLength(0);

      const starting = yield* resumeWithSession("starting");
      expect(Array.isArray(starting) ? starting : [starting]).toHaveLength(0);
    }));
});
