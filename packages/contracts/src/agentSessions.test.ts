import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AgentSessionAttachInput,
  AgentSessionAttachResult,
  AgentSessionListInput,
  AgentSessionListResult,
  AgentSessionScanResult,
} from "./agentSessions.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodeScanResult = Schema.decodeUnknownSync(AgentSessionScanResult);
const decodeListInput = Schema.decodeUnknownSync(AgentSessionListInput);
const decodeListResult = Schema.decodeUnknownSync(AgentSessionListResult);
const decodeAttachInput = Schema.decodeUnknownSync(AgentSessionAttachInput);
const decodeAttachResult = Schema.decodeUnknownSync(AgentSessionAttachResult);

const candidate = {
  path: "/projects/repo",
  title: "repo",
  sources: ["codex"],
  threadCount: 3,
  lastActiveAt: "2026-08-20T12:00:00.000Z",
  alreadyImported: false,
} as const;

const entry = {
  provider: "codex",
  providerInstanceId: "codex",
  providerSessionId: "codex-session",
  title: "Fix the bug",
  promptPreview: "Fix the bug in the importer",
  lastActiveAt: "2026-08-24T10:00:00.000Z",
  cwd: "/projects/repo",
  alreadyImported: false,
} as const;

describe("AgentSessionScanResult", () => {
  it("decodes candidates from servers that predate the git scan", () => {
    const result = decodeScanResult({
      candidates: [candidate],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toBeUndefined();
  });

  it("preserves reported git identity", () => {
    const git = { remoteKey: "github.com/pingdotgg/t3code", repository: "pingdotgg/t3code" };
    const result = decodeScanResult({
      candidates: [{ ...candidate, git }],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toEqual(git);
  });
});

describe("AgentSessionListInput", () => {
  it("requires the project whose sessions are listed", () => {
    expect(() => decodeListInput({ limit: 15 })).toThrow();
  });

  it("accepts the paging limits the client steps through and ignores a provider filter", () => {
    // Paging is the only server-side knob: filtering stays in the client so a
    // narrowed search never changes which transcripts the server reads.
    for (const limit of [15, 45, 90, 200]) {
      expect(decodeListInput({ projectId: "project-1", limit, providers: ["codex"] })).toEqual({
        projectId: "project-1",
        limit,
      });
    }
  });

  it("rejects a limit that cannot page anything", () => {
    expect(() => decodeListInput({ projectId: "project-1", limit: 0 })).toThrow();
    expect(() => decodeListInput({ projectId: "project-1", limit: 1.5 })).toThrow();
  });
});

describe("AgentSessionListResult", () => {
  it("flags an already imported session instead of dropping its transcript path", () => {
    const result = decodeListResult({
      entries: [
        {
          ...entry,
          alreadyImported: true,
          filePath: "/home/dev/.codex/sessions/2026/08/24/rollout-codex-session.jsonl",
        },
      ],
      providerErrors: [],
    });

    expect(result).toEqual({
      entries: [{ ...entry, alreadyImported: true }],
      providerErrors: [],
    });
  });

  it("requires every entry to say whether it is already imported", () => {
    const { alreadyImported: _alreadyImported, ...unflagged } = entry;
    expect(() => decodeListResult({ entries: [unflagged], providerErrors: [] })).toThrow();
  });

  it("requires the provider error list, so a partial failure is never silently empty", () => {
    expect(() => decodeListResult({ entries: [entry] })).toThrow();
  });

  it("rejects entries from providers the scanner cannot read in v1", () => {
    expect(() =>
      decodeListResult({
        entries: [{ ...entry, provider: "cursorAgent" }],
        providerErrors: [],
      }),
    ).toThrow();
  });

  it("reports a per-provider failure beside the entries that did load", () => {
    const result = decodeListResult({
      entries: [entry],
      providerErrors: [
        { provider: "claudeAgent", message: "Could not read ~/.claude", cause: { errno: -13 } },
      ],
      truncated: true,
    });

    expect(result).toEqual({
      entries: [entry],
      providerErrors: [{ provider: "claudeAgent", message: "Could not read ~/.claude" }],
      truncated: true,
    });
  });
});

describe("AgentSessionAttachInput", () => {
  it("identifies a session by project and provider session, nothing else", () => {
    // The server derives the provider kind and the transcript path from its own
    // discovery. A client that could name either would choose what gets read.
    const decoded = decodeAttachInput({
      projectId: "project-1",
      providerInstanceId: "codex",
      providerSessionId: "codex-session",
      provider: "claudeAgent",
      filePath: "/etc/passwd",
    });

    expect(decoded).toEqual({
      projectId: "project-1",
      providerInstanceId: "codex",
      providerSessionId: "codex-session",
    });
  });

  it("requires the provider session to attach", () => {
    expect(() =>
      decodeAttachInput({ projectId: "project-1", providerInstanceId: "codex" }),
    ).toThrow();
  });
});

describe("AgentSessionAttachResult", () => {
  it("decodes a freshly created thread", () => {
    expect(
      decodeAttachResult({
        threadId: "import:codex:codex-session",
        created: true,
        importedCount: 1,
      }),
    ).toEqual({ threadId: "import:codex:codex-session", created: true });
  });

  it("requires the created flag, so the client can tell import from navigation", () => {
    expect(() => decodeAttachResult({ threadId: "import:codex:codex-session" })).toThrow();
  });
});

describe("agent session RPCs", () => {
  it("registers listing and attaching on the server group", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.agentSessionsList)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.agentSessionsAttach)).toBe(true);
  });
});
