import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import * as contracts from "./index.ts";
import {
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadShell,
} from "./orchestrationV2.ts";

// `ExternalThreadStatus` lives in the new `threadExternalStatus.ts` module and
// is re-exported from the package barrel. Reading it off the namespace keeps a
// missing export a per-test failure rather than a file-level import error.
const ExternalThreadStatus = contracts.ExternalThreadStatus;
const decodeStatus = (input: unknown) => Schema.decodeUnknownSync(ExternalThreadStatus)(input);
const encodeStatus = (input: contracts.ExternalThreadStatus) =>
  Schema.encodeSync(ExternalThreadStatus)(input);

const now = DateTime.makeUnsafe("2026-09-22T11:55:00.000Z");
const statusInput = {
  source: "usagewindow",
  key: "compacting",
  text: "Compacting",
  icon: "shrink",
  color: "amber",
  notifyUser: true,
  expiresAt: "2026-09-22T12:00:00.000Z",
  clearsOn: "work",
  updatedAt: "2026-09-22T11:55:00.000Z",
} as const;

describe("ExternalThreadStatus", () => {
  it("decodes an expiring status with notification metadata", () => {
    const status = decodeStatus(statusInput);
    expect(status).toEqual(statusInput);
  });

  it("defaults clearsOn to null when the producer omits it", () => {
    const { clearsOn: _omitted, ...withoutClearsOn } = statusInput;
    expect(decodeStatus(withoutClearsOn).clearsOn).toBeNull();
    expect(decodeStatus({ ...withoutClearsOn, expiresAt: null }).expiresAt).toBeNull();
  });

  it.each(["work", "error", "done"] as const)("accepts the native clear event %s", (clearsOn) => {
    expect(decodeStatus({ ...statusInput, clearsOn }).clearsOn).toBe(clearsOn);
  });

  it("accepts producer-defined custom: clear events", () => {
    expect(decodeStatus({ ...statusInput, clearsOn: "custom:resume-complete" }).clearsOn).toBe(
      "custom:resume-complete",
    );
  });

  it.each(["custom:", "custom", "bogus", "WORK", ""])("rejects clearsOn %j", (clearsOn) => {
    // Guard against rejecting only because the schema does not exist yet.
    expect(decodeStatus(statusInput).key).toBe("compacting");
    expect(() => decodeStatus({ ...statusInput, clearsOn })).toThrow();
  });

  it("requires non-empty display fields and a valid timestamp", () => {
    expect(decodeStatus(statusInput).key).toBe("compacting");
    expect(() => decodeStatus({ ...statusInput, text: "  " })).toThrow();
    expect(() => decodeStatus({ ...statusInput, source: "" })).toThrow();
    expect(() => decodeStatus({ ...statusInput, updatedAt: "yesterday" })).toThrow();
    expect(() => decodeStatus({ ...statusInput, expiresAt: "soon" })).toThrow();
  });

  it("round-trips through encode so persisted payloads keep clearsOn", () => {
    const status = decodeStatus({ ...statusInput, clearsOn: "custom:resume-complete" });
    expect(decodeStatus(encodeStatus(status))).toEqual(status);
  });
});

describe("externalStatus on V2 thread contracts", () => {
  const appThread = {
    createdBy: "user",
    creationSource: "web",
    id: "thread-1",
    projectId: "project-1",
    title: "Thread",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };

  const shell = {
    createdBy: "user",
    creationSource: "web",
    id: "thread-1",
    projectId: "project-1",
    title: "Thread",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  };

  it("carries an optional externalStatus on the app thread, absent by default", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2AppThread);
    expect(decode({ ...appThread, externalStatus: statusInput }).externalStatus).toEqual(
      decodeStatus(statusInput),
    );
    expect(decode({ ...appThread, externalStatus: null }).externalStatus).toBeNull();
    expect(decode(appThread).externalStatus).toBeUndefined();
  });

  it("carries an optional externalStatus on the thread shell, absent by default", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);
    expect(decode({ ...shell, externalStatus: statusInput }).externalStatus).toEqual(
      decodeStatus(statusInput),
    );
    expect(decode({ ...shell, externalStatus: null }).externalStatus).toBeNull();
    expect(decode(shell).externalStatus).toBeUndefined();
  });

  it("carries externalStatus on thread.metadata-updated events", () => {
    const event = Schema.decodeUnknownSync(OrchestrationV2DomainEvent)({
      id: "event-1",
      type: "thread.metadata-updated",
      threadId: "thread-1",
      occurredAt: now,
      payload: { ...appThread, externalStatus: statusInput },
    });
    if (event.type !== "thread.metadata-updated") throw new Error("expected metadata event");
    expect(event.payload.externalStatus).toEqual(decodeStatus(statusInput));
  });

  it("lets thread.metadata.update set, clear, or leave the status alone", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2Command);
    const base = { type: "thread.metadata.update", commandId: "command-1", threadId: "thread-1" };
    const set = decode({ ...base, externalStatus: statusInput });
    const cleared = decode({ ...base, externalStatus: null });
    const untouched = decode(base);
    if (
      set.type !== "thread.metadata.update" ||
      cleared.type !== "thread.metadata.update" ||
      untouched.type !== "thread.metadata.update"
    ) {
      throw new Error("expected thread.metadata.update");
    }
    expect(set.externalStatus).toEqual(decodeStatus(statusInput));
    expect(cleared.externalStatus).toBeNull();
    expect("externalStatus" in untouched).toBe(false);
  });
});
