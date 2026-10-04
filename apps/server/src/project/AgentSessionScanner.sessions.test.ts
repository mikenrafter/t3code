/**
 * Session listing for the Import thread picker: per-project descriptors for
 * Claude, Codex, and Cursor, compacted versus full history, and the persisted
 * descriptor cache. The onboarding scan keeps its own tests in
 * AgentSessionScanner.test.ts.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { type OrchestrationProjectShell, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const nowMs = Date.parse("2026-08-24T12:00:00.000Z");

const projectShell = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: ProjectId.make("project-1"),
  title: "Imported",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

interface ScannerTestInput {
  readonly claudeHomePath: string;
  readonly codexHomePath: string;
  /** Overrides CURSOR_HOME, the root of Cursor's `projects/` and `chats/` trees. */
  readonly cursorHomePath?: string;
  /** Overrides CURSOR_STATE_DB, the global `state.vscdb` holding composerData. */
  readonly cursorStateDbPath?: string;
  /** Shared across scanner instances so the persisted descriptor cache survives a "restart". */
  readonly configBaseDir?: string;
}

const makeScannerTestLayer = (input: ScannerTestInput) =>
  AgentSessionScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          providers: {
            claudeAgent: { homePath: input.claudeHomePath },
            codex: { homePath: input.codexHomePath },
          },
        }),
        ServerConfig.layerTest(
          input.claudeHomePath,
          input.configBaseDir ?? { prefix: "t3code-session-list-config-" },
        ),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([projectShell("/never-a-candidate")]),
        }),
        Layer.succeed(HostProcessEnvironment, {
          ...(input.cursorHomePath === undefined ? {} : { CURSOR_HOME: input.cursorHomePath }),
          ...(input.cursorStateDbPath === undefined
            ? {}
            : { CURSOR_STATE_DB: input.cursorStateDbPath }),
        }),
      ),
    ),
  );

const runDescriptors = (input: ScannerTestInput & { workspaceRoot: string; limit?: number }) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    return yield* scanner.listRecentSessionDescriptors(input.workspaceRoot, input.limit ?? 15);
  }).pipe(Effect.provide(makeScannerTestLayer(input)));

const runRecentThreads = (
  input: ScannerTestInput & {
    workspaceRoot: string;
    historyMode?: "compaction" | "full";
  },
) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    const outcomes = yield* scanner
      .recentThreads(
        input.workspaceRoot,
        undefined,
        input.historyMode === undefined ? undefined : { historyMode: input.historyMode },
      )
      .pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
    return outcomes.flatMap((outcome) => (outcome._tag === "Importable" ? [outcome.thread] : []));
  }).pipe(Effect.provide(makeScannerTestLayer(input)));

const makeTempDir = Effect.fn("AgentSessionScanner.sessions.test.makeTempDir")(function* (
  prefix: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTranscript = Effect.fn("AgentSessionScanner.sessions.test.writeTranscript")(
  function* (input: {
    readonly filePath: string;
    readonly contents: string;
    readonly mtimeMs: number;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(input.filePath), { recursive: true });
    yield* fileSystem.writeFileString(input.filePath, input.contents);
    const seconds = input.mtimeMs / 1000;
    yield* fileSystem.utimes(input.filePath, seconds, seconds);
  },
);

const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const claudeTranscript = (cwd: string, sessionId: string, prompt: string) =>
  `${encode({
    type: "user",
    cwd,
    sessionId,
    timestamp: "2026-08-24T10:00:00.000Z",
    message: { role: "user", content: prompt },
  })}\n`;

const codexRollout = (cwd: string, sessionId: string, prompt: string) =>
  [
    encode({ type: "session_meta", payload: { id: sessionId, cwd } }),
    encode({ type: "event_msg", payload: { type: "user_message", message: prompt } }),
  ].join("\n");

const writeCursorChatMeta = Effect.fn("AgentSessionScanner.sessions.test.writeCursorChatMeta")(
  function* (input: {
    readonly storeDbPath: string;
    readonly meta: {
      readonly agentId: string;
      readonly name: string;
      readonly createdAt: number;
      readonly lastUpdatedAt?: number;
      readonly subagentInfo?: Record<string, string>;
    };
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(input.storeDbPath), { recursive: true });
    yield* Effect.sync(() => {
      const db = new NodeSqlite.DatabaseSync(input.storeDbPath);
      try {
        db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        const hex = Buffer.from(JSON.stringify(input.meta), "utf8").toString("hex");
        db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("0", hex);
      } finally {
        db.close();
      }
    });
  },
);

const writeCursorComposerPercent = Effect.fn(
  "AgentSessionScanner.sessions.test.writeCursorComposerPercent",
)(function* (input: {
  readonly stateDbPath: string;
  readonly sessionId: string;
  readonly contextUsagePercent: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(input.stateDbPath), { recursive: true });
  yield* Effect.sync(() => {
    const db = new NodeSqlite.DatabaseSync(input.stateDbPath);
    try {
      db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
      db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
        `composerData:${input.sessionId}`,
        JSON.stringify({ contextUsagePercent: input.contextUsagePercent }),
      );
    } finally {
      db.close();
    }
  });
});

const cursorTranscript = (prompt: string, reply = "Working on it") =>
  [
    encode({
      role: "user",
      message: { content: [{ type: "text", text: `<user_query>\n${prompt}\n</user_query>` }] },
    }),
    encode({ role: "assistant", message: { content: [{ type: "text", text: reply }] } }),
  ].join("\n");

const cursorTranscriptPath = (
  path: Path.Path,
  cursorHomePath: string,
  workspace: string,
  agentId: string,
) =>
  path.join(
    cursorHomePath,
    "projects",
    AgentSessionScanner.cursorProjectSlug(workspace),
    "agent-transcripts",
    agentId,
    `${agentId}.jsonl`,
  );

const cursorStoreDbPath = (
  path: Path.Path,
  cursorHomePath: string,
  workspace: string,
  agentId: string,
) =>
  path.join(
    cursorHomePath,
    "chats",
    AgentSessionScanner.cursorChatDirectoryHash(workspace),
    agentId,
    "store.db",
  );

const claudeCompactionFixture = (cwd: string) =>
  [
    encode({
      type: "user",
      cwd,
      sessionId: "claude-compact",
      timestamp: "2026-08-24T10:00:00.000Z",
      message: { role: "user", content: "First prompt" },
    }),
    encode({
      type: "assistant",
      sessionId: "claude-compact",
      timestamp: "2026-08-24T10:01:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Old reply" }] },
    }),
    encode({
      type: "user",
      sessionId: "claude-compact",
      timestamp: "2026-08-24T10:02:00.000Z",
      message: { role: "user", content: "Second prompt" },
    }),
    encode({
      type: "user",
      sessionId: "claude-compact",
      timestamp: "2026-08-24T10:03:00.000Z",
      isCompactSummary: true,
      message: { role: "user", content: "Summary of earlier work" },
    }),
    encode({
      type: "user",
      sessionId: "claude-compact",
      timestamp: "2026-08-24T10:04:00.000Z",
      message: { role: "user", content: "Continue after compact" },
    }),
    encode({
      type: "assistant",
      sessionId: "claude-compact",
      timestamp: "2026-08-24T10:05:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Continuing" }] },
    }),
  ].join("\n");

it.layer(NodeServices.layer)("AgentSessionScanner session listing", (it) => {
  describe("listRecentSessionDescriptors", () => {
    it.effect("describes this project's recent sessions newest first", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3-list-claude-");
        const codexHomePath = yield* makeTempDir("t3-list-codex-");
        const workspace = yield* makeTempDir("t3-list-workspace-");
        const otherWorkspace = yield* makeTempDir("t3-list-other-");

        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-selected", "claude-recent.jsonl"),
          contents: claudeTranscript(workspace, "claude-recent", "Fix the flaky test"),
          mtimeMs: Date.parse("2026-08-24T11:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: path.join(codexHomePath, "sessions", "2026", "08", "24", "rollout-a.jsonl"),
          contents: codexRollout(workspace, "codex-recent", "Ship the importer"),
          mtimeMs: Date.parse("2026-08-24T10:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: path.join(codexHomePath, "sessions", "2026", "08", "24", "rollout-b.jsonl"),
          contents: codexRollout(otherWorkspace, "codex-elsewhere", "Different project"),
          mtimeMs: Date.parse("2026-08-24T11:30:00.000Z"),
        });

        const page = yield* runDescriptors({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });

        expect(page.descriptors).toMatchObject([
          {
            source: "claudeAgent",
            providerInstanceId: "claudeAgent",
            providerSessionId: "claude-recent",
            title: "Fix the flaky test",
            promptPreview: "Fix the flaky test",
            lastActiveAt: "2026-08-24T11:00:00.000Z",
            cwd: workspace,
            importable: true,
            hasCompactionSummary: false,
          },
          {
            source: "codex",
            providerInstanceId: "codex",
            providerSessionId: "codex-recent",
            title: "Ship the importer",
            lastActiveAt: "2026-08-24T10:00:00.000Z",
            cwd: workspace,
          },
        ]);
        expect(page.providerErrors).toEqual([]);
        expect(page.truncated).toBe(false);
      }),
    );

    it.effect("stops at the requested limit and says the page is truncated", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3-limit-claude-");
        const codexHomePath = yield* makeTempDir("t3-limit-codex-");
        const workspace = yield* makeTempDir("t3-limit-workspace-");
        for (const index of [0, 1, 2]) {
          yield* writeTranscript({
            filePath: path.join(
              codexHomePath,
              "sessions",
              "2026",
              "08",
              "24",
              `rollout-codex-${index}.jsonl`,
            ),
            contents: codexRollout(workspace, `codex-${index}`, `Prompt ${index}`),
            mtimeMs: nowMs - index * 60_000,
          });
        }

        const page = yield* runDescriptors({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
          limit: 2,
        });

        expect(page.descriptors.map((descriptor) => descriptor.providerSessionId)).toEqual([
          "codex-0",
          "codex-1",
        ]);
        expect(page.truncated).toBe(true);
      }),
    );

    it.effect("lists a transcript too large to import as blocked, with its first prompt", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3-big-claude-");
        const codexHomePath = yield* makeTempDir("t3-big-codex-");
        const workspace = yield* makeTempDir("t3-big-workspace-");
        const records =
          [
            encode({
              type: "session_meta",
              payload: { id: "record-limit-session", cwd: workspace },
            }),
            encode({
              type: "event_msg",
              payload: { type: "user_message", message: "First prompt" },
            }),
          ].join("\n") +
          "\n" +
          "{}\n".repeat(99_998) +
          "\n" +
          encode({ type: "event_msg", payload: { type: "user_message", message: "Overflow" } }) +
          "\n";
        yield* writeTranscript({
          filePath: path.join(codexHomePath, "sessions", "2026", "08", "24", "rollout-big.jsonl"),
          contents: records,
          mtimeMs: nowMs,
        });

        const page = yield* runDescriptors({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });

        expect(page.descriptors).toMatchObject([
          {
            providerSessionId: "record-limit-session",
            promptPreview: "First prompt",
            importable: false,
            importBlockedReason: expect.stringMatching(/record|limit|oversized|too large/i),
          },
        ]);
      }),
    );

    it.effect("reports an unreadable provider home beside the sessions that loaded", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3-partial-claude-");
        const codexHomePath = yield* makeTempDir("t3-partial-codex-");
        const workspace = yield* makeTempDir("t3-partial-workspace-");
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-selected", "claude-readable.jsonl"),
          contents: claudeTranscript(workspace, "claude-readable", "Still listed"),
          mtimeMs: nowMs,
        });
        yield* writeTranscript({
          filePath: path.join(codexHomePath, "sessions", "2026", "08", "24", "rollout-x.jsonl"),
          contents: codexRollout(workspace, "codex-unreadable", "Never read"),
          mtimeMs: nowMs,
        });
        const unreadableFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          readDirectory: (directory, options) =>
            directory.startsWith(path.join(codexHomePath, "sessions"))
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readDirectory",
                    pathOrDescriptor: directory,
                  }),
                )
              : fileSystem.readDirectory(directory, options),
        });

        const page = yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          return yield* scanner.listRecentSessionDescriptors(workspace, 15);
        }).pipe(
          Effect.provide(makeScannerTestLayer({ claudeHomePath, codexHomePath })),
          Effect.provideService(FileSystem.FileSystem, unreadableFileSystem),
        );

        expect(page.descriptors.map((descriptor) => descriptor.providerSessionId)).toEqual([
          "claude-readable",
        ]);
        expect(page.providerErrors.map((failure) => failure.source)).toEqual(["codex"]);
        expect(page.providerErrors[0]?.message).not.toBe("");
      }),
    );

    it.effect("marks a Claude compaction and carries createdAt plus lastMessageAt", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3-compact-claude-");
        const codexHomePath = yield* makeTempDir("t3-compact-codex-");
        const workspace = yield* makeTempDir("t3-compact-workspace-");
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-selected", "compact-session.jsonl"),
          contents: [
            encode({
              type: "user",
              cwd: workspace,
              sessionId: "compact-session",
              timestamp: "2026-08-24T10:00:00.000Z",
              message: { role: "user", content: "First prompt" },
            }),
            encode({
              type: "assistant",
              sessionId: "compact-session",
              timestamp: "2026-08-24T10:01:00.000Z",
              message: { role: "assistant", content: [{ type: "text", text: "Old reply" }] },
            }),
            encode({
              type: "user",
              sessionId: "compact-session",
              timestamp: "2026-08-24T10:02:00.000Z",
              isCompactSummary: true,
              message: { role: "user", content: "Summary of earlier work" },
            }),
            encode({
              type: "assistant",
              sessionId: "compact-session",
              timestamp: "2026-08-24T10:04:00.000Z",
              message: { role: "assistant", content: [{ type: "text", text: "Continuing" }] },
            }),
          ].join("\n"),
          mtimeMs: Date.parse("2026-08-24T11:00:00.000Z"),
        });

        const page = yield* runDescriptors({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });

        expect(page.descriptors).toMatchObject([
          {
            providerSessionId: "compact-session",
            hasCompactionSummary: true,
            createdAt: "2026-08-24T10:00:00.000Z",
            lastMessageAt: "2026-08-24T10:04:00.000Z",
            importable: true,
          },
        ]);
      }),
    );

    it.effect("lists both pre- and post-compaction Claude usage from one scan", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3-usage-claude-");
        const codexHomePath = yield* makeTempDir("t3-usage-codex-");
        const workspace = yield* makeTempDir("t3-usage-workspace-");
        const assistant = (timestamp: string, usage: Record<string, number>, text: string) =>
          encode({
            type: "assistant",
            sessionId: "claude-mode",
            timestamp,
            message: {
              role: "assistant",
              model: "claude-sonnet-5",
              content: [{ type: "text", text }],
              usage,
            },
          });
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-selected", "claude-mode.jsonl"),
          contents: [
            encode({
              type: "user",
              cwd: workspace,
              sessionId: "claude-mode",
              timestamp: "2026-08-24T10:00:00.000Z",
              message: { role: "user", content: "Before compact" },
            }),
            assistant(
              "2026-08-24T10:01:00.000Z",
              {
                input_tokens: 1,
                cache_creation_input_tokens: 80_000,
                cache_read_input_tokens: 20_000,
                output_tokens: 100,
              },
              "Big context",
            ),
            encode({
              type: "user",
              sessionId: "claude-mode",
              timestamp: "2026-08-24T10:02:00.000Z",
              isCompactSummary: true,
              message: { role: "user", content: "Compact summary" },
            }),
            assistant(
              "2026-08-24T10:03:00.000Z",
              {
                input_tokens: 1,
                cache_creation_input_tokens: 5_000,
                cache_read_input_tokens: 3_000,
                output_tokens: 50,
              },
              "Smaller context",
            ),
          ].join("\n"),
          mtimeMs: Date.parse("2026-08-24T11:00:00.000Z"),
        });

        const page = yield* runDescriptors({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });

        // Used tokens follow ClaudeAdapter's active-usage sum: input + cache + output.
        expect(page.descriptors[0]?.contextUsedTokens).toBe(1 + 5_000 + 3_000 + 50);
        expect(page.descriptors[0]?.contextUsedTokensFull).toBe(1 + 80_000 + 20_000 + 100);
        expect(page.descriptors[0]?.contextMaxTokens).toBeUndefined();
        expect(page.descriptors[0]?.contextUsagePercent).toBeUndefined();
      }),
    );

    it.effect("reads Codex token_count used and max without inventing a percent", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3-codex-ctx-claude-");
        const codexHomePath = yield* makeTempDir("t3-codex-ctx-codex-");
        const workspace = yield* makeTempDir("t3-codex-ctx-workspace-");
        yield* writeTranscript({
          filePath: path.join(codexHomePath, "sessions", "2026", "08", "24", "rollout-ctx.jsonl"),
          contents: [
            encode({
              type: "session_meta",
              timestamp: "2026-08-24T10:00:00.000Z",
              payload: { id: "codex-ctx", cwd: workspace },
            }),
            encode({
              type: "event_msg",
              timestamp: "2026-08-24T10:00:02.000Z",
              payload: { type: "user_message", message: "Meter Codex import context" },
            }),
            encode({
              type: "event_msg",
              timestamp: "2026-08-24T10:00:04.000Z",
              payload: {
                type: "token_count",
                info: {
                  last_token_usage: { total_tokens: 14_288 },
                  model_context_window: 258_400,
                },
              },
            }),
          ].join("\n"),
          mtimeMs: Date.parse("2026-08-24T11:00:00.000Z"),
        });

        const page = yield* runDescriptors({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });

        expect(page.descriptors[0]).toMatchObject({
          source: "codex",
          providerSessionId: "codex-ctx",
          contextUsedTokens: 14_288,
          contextMaxTokens: 258_400,
        });
        expect(page.descriptors[0]?.contextUsagePercent).toBeUndefined();
      }),
    );

    it.effect("lists Cursor sessions for this cwd, skipping subagents and other projects", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3-cursor-claude-");
        const codexHomePath = yield* makeTempDir("t3-cursor-codex-");
        const cursorHomePath = yield* makeTempDir("t3-cursor-home-");
        const workspace = yield* makeTempDir("t3-cursor-workspace-");
        const otherWorkspace = yield* makeTempDir("t3-cursor-other-");
        const parentId = "11111111-1111-4111-8111-111111111111";
        const subagentId = "22222222-2222-4222-8222-222222222222";
        const otherId = "33333333-3333-4333-8333-333333333333";

        yield* writeTranscript({
          filePath: cursorTranscriptPath(path, cursorHomePath, workspace, parentId),
          contents: cursorTranscript("Fix the Cursor import"),
          mtimeMs: Date.parse("2026-08-24T11:00:00.000Z"),
        });
        yield* writeCursorChatMeta({
          storeDbPath: cursorStoreDbPath(path, cursorHomePath, workspace, parentId),
          meta: {
            agentId: parentId,
            name: "Cursor import fix",
            createdAt: Date.parse("2026-08-24T10:55:00.000Z"),
          },
        });
        yield* writeTranscript({
          filePath: cursorTranscriptPath(path, cursorHomePath, workspace, subagentId),
          contents: cursorTranscript("Subagent work"),
          mtimeMs: Date.parse("2026-08-24T11:30:00.000Z"),
        });
        yield* writeCursorChatMeta({
          storeDbPath: cursorStoreDbPath(path, cursorHomePath, workspace, subagentId),
          meta: {
            agentId: subagentId,
            name: "Subagent",
            createdAt: Date.parse("2026-08-24T11:25:00.000Z"),
            subagentInfo: {
              parentAgentId: parentId,
              rootParentAgentId: parentId,
              toolCallId: "call-1",
              typeName: "generalPurpose",
            },
          },
        });
        yield* writeTranscript({
          filePath: cursorTranscriptPath(path, cursorHomePath, otherWorkspace, otherId),
          contents: cursorTranscript("Other project"),
          mtimeMs: Date.parse("2026-08-24T11:45:00.000Z"),
        });
        yield* writeCursorChatMeta({
          storeDbPath: cursorStoreDbPath(path, cursorHomePath, otherWorkspace, otherId),
          meta: {
            agentId: otherId,
            name: "Elsewhere",
            createdAt: Date.parse("2026-08-24T11:40:00.000Z"),
          },
        });

        const page = yield* runDescriptors({
          claudeHomePath,
          codexHomePath,
          cursorHomePath,
          workspaceRoot: workspace,
        });

        expect(page.descriptors).toMatchObject([
          {
            source: "cursor",
            providerInstanceId: "cursor",
            providerSessionId: parentId,
            title: "Cursor import fix",
            promptPreview: "Working on it",
            lastActiveAt: "2026-08-24T11:00:00.000Z",
            cwd: workspace,
          },
        ]);
        expect(page.providerErrors).toEqual([]);
      }),
    );

    it.effect("reads Cursor's native composerData percent without inventing token counts", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3-cursor-pct-claude-");
        const codexHomePath = yield* makeTempDir("t3-cursor-pct-codex-");
        const cursorHomePath = yield* makeTempDir("t3-cursor-pct-home-");
        const stateDir = yield* makeTempDir("t3-cursor-pct-state-");
        const cursorStateDbPath = path.join(stateDir, "state.vscdb");
        const workspace = yield* makeTempDir("t3-cursor-pct-workspace-");
        const agentId = "66666666-6666-4666-8666-666666666666";

        yield* writeTranscript({
          filePath: cursorTranscriptPath(path, cursorHomePath, workspace, agentId),
          contents: cursorTranscript("Meter the import", "Noted"),
          mtimeMs: Date.parse("2026-08-24T11:00:00.000Z"),
        });
        yield* writeCursorChatMeta({
          storeDbPath: cursorStoreDbPath(path, cursorHomePath, workspace, agentId),
          meta: {
            agentId,
            name: "Cursor percent",
            createdAt: Date.parse("2026-08-24T10:50:00.000Z"),
            lastUpdatedAt: Date.parse("2026-08-24T11:05:00.000Z"),
          },
        });
        yield* writeCursorComposerPercent({
          stateDbPath: cursorStateDbPath,
          sessionId: agentId,
          contextUsagePercent: 37,
        });

        const page = yield* runDescriptors({
          claudeHomePath,
          codexHomePath,
          cursorHomePath,
          cursorStateDbPath,
          workspaceRoot: workspace,
        });

        expect(page.descriptors).toHaveLength(1);
        expect(page.descriptors[0]).toMatchObject({
          providerSessionId: agentId,
          contextUsagePercent: 37,
          createdAt: "2026-08-24T10:50:00.000Z",
          lastMessageAt: "2026-08-24T11:05:00.000Z",
        });
        expect(page.descriptors[0]?.contextUsedTokens).toBeUndefined();
        expect(page.descriptors[0]?.contextMaxTokens).toBeUndefined();
      }),
    );

    it.effect("titles Cursor sessions from the first real prompt, not harness scaffolding", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3-cursor-title-claude-");
        const codexHomePath = yield* makeTempDir("t3-cursor-title-codex-");
        const cursorHomePath = yield* makeTempDir("t3-cursor-title-home-");
        const workspace = yield* makeTempDir("t3-cursor-title-workspace-");
        const agentId = "88888888-8888-4888-8888-888888888888";
        yield* writeTranscript({
          filePath: cursorTranscriptPath(path, cursorHomePath, workspace, agentId),
          contents: [
            encode({
              role: "user",
              message: {
                content: [
                  {
                    type: "text",
                    text: "<timestamp>Friday, Sep 25, 2026, 2:52 AM (UTC-6)</timestamp>\n<user_query>\nPolish Cursor import titles\n</user_query>",
                  },
                ],
              },
            }),
            encode({
              role: "assistant",
              message: { content: [{ type: "text", text: "Working through the title polish." }] },
            }),
            encode({
              role: "assistant",
              message: {
                content: [{ type: "text", text: "Give the user an update on progress." }],
              },
            }),
          ].join("\n"),
          mtimeMs: Date.parse("2026-08-24T11:00:00.000Z"),
        });
        // Cursor's default chat name carries no information.
        yield* writeCursorChatMeta({
          storeDbPath: cursorStoreDbPath(path, cursorHomePath, workspace, agentId),
          meta: {
            agentId,
            name: "New Agent",
            createdAt: Date.parse("2026-08-24T10:50:00.000Z"),
          },
        });

        const page = yield* runDescriptors({
          claudeHomePath,
          codexHomePath,
          cursorHomePath,
          workspaceRoot: workspace,
        });

        expect(page.descriptors[0]?.title).toBe("Polish Cursor import titles");
        expect(page.descriptors[0]?.promptPreview).toBe("Working through the title polish.");
      }),
    );
  });

  describe("recentThreads", () => {
    it.effect("imports Cursor transcript history", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3-cursor-import-claude-");
        const codexHomePath = yield* makeTempDir("t3-cursor-import-codex-");
        const cursorHomePath = yield* makeTempDir("t3-cursor-import-home-");
        const workspace = yield* makeTempDir("t3-cursor-import-workspace-");
        const agentId = "44444444-4444-4444-8444-444444444444";
        yield* writeTranscript({
          filePath: cursorTranscriptPath(path, cursorHomePath, workspace, agentId),
          contents: cursorTranscript("Ship the Cursor attach path", "Imported history"),
          mtimeMs: Date.parse("2026-08-24T11:00:00.000Z"),
        });
        yield* writeCursorChatMeta({
          storeDbPath: cursorStoreDbPath(path, cursorHomePath, workspace, agentId),
          meta: {
            agentId,
            name: "Cursor attach",
            createdAt: Date.parse("2026-08-24T10:50:00.000Z"),
          },
        });

        const threads = yield* runRecentThreads({
          claudeHomePath,
          codexHomePath,
          cursorHomePath,
          workspaceRoot: workspace,
        });

        expect(threads).toHaveLength(1);
        expect(threads[0]).toMatchObject({
          source: "cursor",
          providerInstanceId: "cursor",
          providerSessionId: agentId,
          title: "Cursor attach",
          messages: [
            { role: "user", text: "Ship the Cursor attach path" },
            { role: "assistant", text: "Imported history" },
          ],
        });
      }),
    );

    it.effect("keeps the compact summary and drops earlier history in compaction mode", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3-mode-claude-");
        const codexHomePath = yield* makeTempDir("t3-mode-codex-");
        const workspace = yield* makeTempDir("t3-mode-workspace-");
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-selected", "claude-compact.jsonl"),
          contents: claudeCompactionFixture(workspace),
          mtimeMs: Date.parse("2026-08-24T11:00:00.000Z"),
        });
        const input = { claudeHomePath, codexHomePath, workspaceRoot: workspace };

        const compacted = yield* runRecentThreads({ ...input, historyMode: "compaction" });
        const full = yield* runRecentThreads({ ...input, historyMode: "full" });

        expect(compacted[0]?.messages.map((message) => message.text)).toEqual([
          "First prompt",
          "Summary of earlier work",
          "Continue after compact",
          "Continuing",
        ]);
        expect(full[0]?.messages.map((message) => message.text)).toEqual([
          "First prompt",
          "Old reply",
          "Second prompt",
          "Continue after compact",
          "Continuing",
        ]);
      }),
    );
  });

  describe("persisted descriptor cache", () => {
    const sessionPath = (path: Path.Path, claudeHomePath: string) =>
      path.join(claudeHomePath, "projects", "-selected", "cached-session.jsonl");
    const transcript = (workspace: string, prompt: string) =>
      claudeTranscript(workspace, "cached-session", prompt);
    const mtimeMs = Date.parse("2026-08-24T11:00:00.000Z");

    it.effect("serves an unchanged transcript from disk after the scanner restarts", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3-cache-claude-");
        const codexHomePath = yield* makeTempDir("t3-cache-codex-");
        const configBaseDir = yield* makeTempDir("t3-cache-config-");
        const workspace = yield* makeTempDir("t3-cache-workspace-");
        const input = { claudeHomePath, codexHomePath, configBaseDir, workspaceRoot: workspace };

        yield* writeTranscript({
          filePath: sessionPath(path, claudeHomePath),
          contents: transcript(workspace, "alpha first prompt"),
          mtimeMs,
        });
        expect((yield* runDescriptors(input)).descriptors[0]?.title).toBe("alpha first prompt");

        // Same size and mtime, different text: only a cache can still answer "alpha".
        yield* writeTranscript({
          filePath: sessionPath(path, claudeHomePath),
          contents: transcript(workspace, "omega first prompt"),
          mtimeMs,
        });
        expect((yield* runDescriptors(input)).descriptors[0]?.title).toBe("alpha first prompt");
      }),
    );

    it.effect("re-reads a transcript whose size or mtime changed", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3-cache-change-claude-");
        const codexHomePath = yield* makeTempDir("t3-cache-change-codex-");
        const configBaseDir = yield* makeTempDir("t3-cache-change-config-");
        const workspace = yield* makeTempDir("t3-cache-change-workspace-");
        const input = { claudeHomePath, codexHomePath, configBaseDir, workspaceRoot: workspace };

        yield* writeTranscript({
          filePath: sessionPath(path, claudeHomePath),
          contents: transcript(workspace, "alpha first prompt"),
          mtimeMs,
        });
        expect((yield* runDescriptors(input)).descriptors[0]?.title).toBe("alpha first prompt");

        yield* writeTranscript({
          filePath: sessionPath(path, claudeHomePath),
          contents: transcript(workspace, "a longer replacement prompt"),
          mtimeMs,
        });
        expect((yield* runDescriptors(input)).descriptors[0]?.title).toBe(
          "a longer replacement prompt",
        );

        yield* writeTranscript({
          filePath: sessionPath(path, claudeHomePath),
          contents: transcript(workspace, "a longer replacement PROMPT"),
          mtimeMs: mtimeMs + 60_000,
        });
        expect((yield* runDescriptors(input)).descriptors[0]?.title).toBe(
          "a longer replacement PROMPT",
        );
      }),
    );

    it.effect("ignores a corrupt cache file instead of failing the list", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3-cache-bad-claude-");
        const codexHomePath = yield* makeTempDir("t3-cache-bad-codex-");
        const configBaseDir = yield* makeTempDir("t3-cache-bad-config-");
        const workspace = yield* makeTempDir("t3-cache-bad-workspace-");
        const input = { claudeHomePath, codexHomePath, configBaseDir, workspaceRoot: workspace };
        yield* writeTranscript({
          filePath: sessionPath(path, claudeHomePath),
          contents: transcript(workspace, "alpha first prompt"),
          mtimeMs,
        });
        yield* runDescriptors(input);
        // Whatever the cache wrote, replace every file it may have created under the config dir.
        const cacheFiles = (yield* fileSystem.readDirectory(configBaseDir, {
          recursive: true,
        })).filter((entry) => entry.endsWith("agent-session-descriptors.json"));
        expect(cacheFiles).toHaveLength(1);
        yield* fileSystem.writeFileString(path.join(configBaseDir, cacheFiles[0]!), "{not json");

        const page = yield* runDescriptors(input);

        expect(page.descriptors[0]?.title).toBe("alpha first prompt");
      }),
    );
  });
});

describe("parseAgentSessionTranscript history modes", () => {
  const parse = (historyMode?: "compaction" | "full") =>
    AgentSessionScanner.parseAgentSessionTranscript({
      contents: claudeCompactionFixture("/project"),
      source: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
      ...(historyMode === undefined ? {} : { historyMode }),
    });

  it("compaction keeps the first prompt, the compact summary, and everything after it", () => {
    expect(parse("compaction")?.messages.map((message) => message.text)).toEqual([
      "First prompt",
      "Summary of earlier work",
      "Continue after compact",
      "Continuing",
    ]);
  });

  it("full drops the synthetic summary and keeps the earlier turns", () => {
    expect(parse("full")?.messages.map((message) => message.text)).toEqual([
      "First prompt",
      "Old reply",
      "Second prompt",
      "Continue after compact",
      "Continuing",
    ]);
  });

  it("behaves as full when no mode is given, as the onboarding import always has", () => {
    expect(parse()?.messages.map((message) => message.text)).toEqual(
      parse("full")?.messages.map((message) => message.text),
    );
    expect(parse("compaction")?.messages).not.toEqual(parse()?.messages);
  });
});
