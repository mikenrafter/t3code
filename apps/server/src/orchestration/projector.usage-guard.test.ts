import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationUsageGuard,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: NOW,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

function makeGuard(input: {
  readonly phase: OrchestrationUsageGuard["phase"];
}): OrchestrationUsageGuard {
  return {
    windowId: "five_hour",
    windowKind: "session",
    usedPercent: 92,
    windowResetsAt: "2026-01-01T05:00:00.000Z",
    phase: input.phase,
    reason: "threshold",
    updatedAt: NOW,
  };
}

it.effect("projects the usage guard lifecycle onto the thread", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(NOW),
      makeEvent({
        sequence: 1,
        type: "thread.created",
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );
    expect(created.threads[0]?.usageGuard ?? null).toBeNull();

    const settledGuard = {
      ...makeGuard({ phase: "paused" }),
      scheduledAt: NOW,
    } satisfies OrchestrationUsageGuard;
    const settled = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.usage-guard.settled",
        payload: { threadId: ThreadId.make("thread-1"), guard: settledGuard, updatedAt: NOW },
      }),
    );
    expect(settled.threads[0]?.usageGuard).toEqual(settledGuard);

    const suppressedGuard = makeGuard({ phase: "suppressed" });
    const suppressed = yield* projectEvent(
      settled,
      makeEvent({
        sequence: 3,
        type: "thread.usage-guard.suppressed",
        payload: { threadId: ThreadId.make("thread-1"), guard: suppressedGuard, updatedAt: NOW },
      }),
    );
    expect(suppressed.threads[0]?.usageGuard).toEqual(suppressedGuard);

    const resumed = yield* projectEvent(
      suppressed,
      makeEvent({
        sequence: 4,
        type: "thread.usage-guard.resumed",
        payload: {
          threadId: ThreadId.make("thread-1"),
          scheduledAt: NOW,
          waitedMs: 60_000,
          updatedAt: NOW,
        },
      }),
    );
    expect(resumed.threads[0]?.usageGuard ?? null).toBeNull();
  }),
);
