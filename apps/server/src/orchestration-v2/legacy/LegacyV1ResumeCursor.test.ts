import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Result from "effect/Result";

import { decodeLegacyV1ResumeCursor } from "./LegacyV1ResumeCursor.ts";

const CLAUDE_T3_THREAD_ID = "thread:cursor:claude";
const CLAUDE_SESSION_UUID = "3f2b8c1e-7d4a-4e6b-9a5c-0d1e2f3a4b5c";
const CLAUDE_ASSISTANT_UUID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const CURSOR_SESSION_UUID = "0b9d4a52-6c7e-4f18-a3b2-5d6e7f8091a2";

const decoded = (providerName: string, cursor: unknown) => {
  const result = decodeLegacyV1ResumeCursor(providerName, cursor);
  assert.isTrue(Result.isSuccess(result), `expected ${providerName} cursor to decode`);
  return Result.getOrThrow(result);
};

const rejected = (providerName: string, cursor: unknown) => {
  const result = decodeLegacyV1ResumeCursor(providerName, cursor);
  assert.isTrue(Result.isFailure(result), `expected ${providerName} cursor to be rejected`);
  return Result.isFailure(result) ? result.failure : undefined;
};

it("decodes the three V1 cursor shapes into a driver and native id", () => {
  assert.deepStrictEqual(
    decoded("claudeAgent", { threadId: CLAUDE_T3_THREAD_ID, resume: CLAUDE_SESSION_UUID }),
    { driver: ProviderDriverKind.make("claudeAgent"), nativeId: CLAUDE_SESSION_UUID },
  );
  assert.deepStrictEqual(decoded("codex", { threadId: "019e3f5a-codex-native-thread" }), {
    driver: ProviderDriverKind.make("codex"),
    nativeId: "019e3f5a-codex-native-thread",
  });
  assert.deepStrictEqual(decoded("cursor", { schemaVersion: 1, sessionId: CURSOR_SESSION_UUID }), {
    driver: ProviderDriverKind.make("cursor"),
    nativeId: CURSOR_SESSION_UUID,
  });
});

it("never mistakes the T3 thread id in a Claude cursor for the native session", () => {
  // The T3 id is deliberately UUID-shaped: only `resume` names the Claude session.
  const t3ThreadId = "11111111-2222-4333-8444-555555555555";
  const full = decoded("claudeAgent", {
    threadId: t3ThreadId,
    resume: CLAUDE_SESSION_UUID,
    resumeSessionAt: CLAUDE_ASSISTANT_UUID,
    turnCount: 2,
    turnStartMessageIds: [CLAUDE_ASSISTANT_UUID, null],
  });
  assert.equal(full.nativeId, CLAUDE_SESSION_UUID);
  assert.notEqual(full.nativeId, t3ThreadId);

  // A cursor that only carries the T3 thread id has no native session to resume.
  assert.equal(rejected("claudeAgent", { threadId: t3ThreadId }), "missing-native-id");
});

it("ignores the optional Claude fields when choosing the native id", () => {
  // resumeSessionAt, turnCount and turnStartMessageIds stay in the stored cursor;
  // they must never become the native id.
  const cursor = {
    threadId: CLAUDE_T3_THREAD_ID,
    resume: CLAUDE_SESSION_UUID,
    resumeSessionAt: CLAUDE_ASSISTANT_UUID,
    turnCount: 3,
    turnStartMessageIds: ["a", null, "c"],
  };
  assert.equal(decoded("claudeAgent", cursor).nativeId, CLAUDE_SESSION_UUID);
  assert.equal(
    decoded("claudeAgent", { ...cursor, resumeSessionAt: undefined, turnCount: undefined })
      .nativeId,
    CLAUDE_SESSION_UUID,
  );
});

it("accepts the historical Claude sessionId alias only when it is a UUID", () => {
  assert.equal(
    decoded("claudeAgent", { threadId: CLAUDE_T3_THREAD_ID, sessionId: CLAUDE_SESSION_UUID })
      .nativeId,
    CLAUDE_SESSION_UUID,
  );
  // `resume` wins when both are present.
  assert.equal(
    decoded("claudeAgent", {
      resume: CLAUDE_SESSION_UUID,
      sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    }).nativeId,
    CLAUDE_SESSION_UUID,
  );
  assert.equal(
    rejected("claudeAgent", { threadId: CLAUDE_T3_THREAD_ID, sessionId: "not-a-uuid" }),
    "missing-native-id",
  );
});

it("accepts a cursor stored as JSON text", () => {
  assert.deepStrictEqual(decoded("codex", JSON.stringify({ threadId: "native-from-json" })), {
    driver: ProviderDriverKind.make("codex"),
    nativeId: "native-from-json",
  });
});

it("rejects malformed JSON, null and non-object cursors", () => {
  assert.equal(rejected("codex", "{not json"), "malformed-json");
  assert.equal(rejected("codex", ""), "malformed-json");
  for (const cursor of [null, undefined, "null", 7, ["threadId"], '"just text"']) {
    assert.equal(rejected("codex", cursor), "missing-cursor");
  }
});

it("rejects empty and non-string native ids", () => {
  assert.equal(rejected("codex", {}), "missing-native-id");
  assert.equal(rejected("codex", { threadId: "" }), "missing-native-id");
  assert.equal(rejected("codex", { threadId: "   " }), "missing-native-id");
  assert.equal(rejected("codex", { threadId: 42 }), "missing-native-id");
  assert.equal(rejected("claudeAgent", { resume: "" }), "missing-native-id");
  assert.equal(rejected("cursor", { schemaVersion: 1, sessionId: "" }), "missing-native-id");
  assert.equal(rejected("cursor", { schemaVersion: 1 }), "missing-native-id");
});

it("rejects providers V1 never stored a resumable cursor for", () => {
  for (const providerName of ["opencode", "grok", "gemini", "", "Codex"]) {
    assert.equal(
      rejected(providerName, {
        threadId: "native",
        sessionId: CURSOR_SESSION_UUID,
        schemaVersion: 1,
      }),
      "unsupported-provider",
    );
  }
});

it("rejects Cursor cursors that are not schema version 1", () => {
  assert.equal(
    rejected("cursor", { schemaVersion: 2, sessionId: CURSOR_SESSION_UUID }),
    "unsupported-cursor-version",
  );
  assert.equal(
    rejected("cursor", { schemaVersion: "1", sessionId: CURSOR_SESSION_UUID }),
    "unsupported-cursor-version",
  );
  assert.equal(
    rejected("cursor", { sessionId: CURSOR_SESSION_UUID }),
    "unsupported-cursor-version",
  );
});
