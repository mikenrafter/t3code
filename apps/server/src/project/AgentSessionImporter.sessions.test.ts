/**
 * Picker flow of the session importer: list recent sessions (one project or
 * Automatic across all of them) and attach one chosen session as a V2 thread.
 * The bulk onboarding import keeps its own tests in AgentSessionImporter.test.ts.
 */
import { expect, it } from "@effect/vitest";
import {
  AgentSessionAttachDeletedThreadError,
  AgentSessionImportBlockedError,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionUnavailableError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const alpha = { id: ProjectId.make("project-alpha"), title: "Alpha", workspaceRoot: "/work/alpha" };
const beta = { id: ProjectId.make("project-beta"), title: "Beta", workspaceRoot: "/work/beta" };

const claudeInstance = ProviderInstanceId.make("claudeAgent");
const codexInstance = ProviderInstanceId.make("codex");
const cursorInstance = ProviderInstanceId.make("cursor");

const threadIdFor = (instance: ProviderInstanceId, sessionId: string) =>
  ThreadId.make(`import:${instance}:${sessionId}`);

type Descriptor = AgentSessionScanner.AgentSessionDescriptor;
const descriptor = (
  overrides: Partial<Descriptor> &
    Pick<Descriptor, "source" | "providerInstanceId" | "providerSessionId" | "cwd">,
): Descriptor => ({
  title: overrides.providerSessionId,
  promptPreview: `prompt of ${overrides.providerSessionId}`,
  lastActiveAt: "2026-09-20T10:00:00.000Z",
  ...overrides,
});

const importSource = (descriptor: Descriptor) => ({
  provider: descriptor.source,
  providerInstanceId: descriptor.providerInstanceId,
  providerSessionId: descriptor.providerSessionId,
  filePath: `/home/.sessions/${descriptor.providerSessionId}.jsonl`,
  size: 100,
  mtimeMs: 2,
  device: 3,
  inode: 4,
  birthtimeMs: 1,
});

interface Harness {
  readonly descriptorsByRoot: Record<string, ReadonlyArray<Descriptor>>;
  readonly providerErrorsByRoot?: Record<
    string,
    ReadonlyArray<{ readonly source: Descriptor["source"]; readonly message: string }>
  >;
  readonly messagesBySession?: Record<
    string,
    ReadonlyArray<{ role: "user" | "assistant"; text: string; createdAt: string }>
  >;
  /** Threads the projection already holds, keyed by thread id. */
  readonly existingThreads?: Record<
    string,
    {
      readonly projectId: ProjectId;
      readonly historyOrigin?: "v1_import" | "native";
      readonly archivedAt?: string | null;
      readonly deletedAt?: string | null;
    }
  >;
  readonly runtimeRows?: ReadonlyArray<unknown>;
  readonly projects?: ReadonlyArray<typeof alpha>;
}

const makeHarness = (harness: Harness) => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const dispatched: Array<unknown> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  const descriptorQueries: Array<{ workspaceRoot: string; limit: number }> = [];
  const recentThreadRequests: Array<{ workspaceRoot: string; historyMode: unknown }> = [];
  const created = new Set<string>();
  const projects = harness.projects ?? [alpha, beta];

  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    listRecentSessionDescriptors: (workspaceRoot, limit) =>
      Effect.sync(() => {
        descriptorQueries.push({ workspaceRoot, limit });
        const descriptors = harness.descriptorsByRoot[workspaceRoot] ?? [];
        return {
          descriptors: descriptors.slice(0, limit),
          providerErrors: harness.providerErrorsByRoot?.[workspaceRoot] ?? [],
          truncated: descriptors.length > limit,
        };
      }),
    recentThreads: (workspaceRoot, _completed, options) => {
      recentThreadRequests.push({ workspaceRoot, historyMode: options?.historyMode });
      const rootDescriptors = harness.descriptorsByRoot[workspaceRoot] ?? [];
      return Stream.fromIterable(
        rootDescriptors.map((entry) => ({
          _tag: "Importable" as const,
          source: importSource(entry),
          thread: {
            source: entry.source,
            providerInstanceId: entry.providerInstanceId,
            providerSessionId: entry.providerSessionId,
            title: entry.title,
            model: null,
            createdAt: "2026-09-01T10:00:00.000Z",
            updatedAt: entry.lastActiveAt,
            messages: harness.messagesBySession?.[entry.providerSessionId] ?? [
              { role: "user", text: "Hello", createdAt: "2026-09-01T10:00:00.000Z" },
            ],
          },
        })),
      );
    },
  });

  const layer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: (projectId) =>
            Effect.succeed(
              Option.fromNullishOr(projects.find((project) => project.id === projectId) as never),
            ),
          listShells: () => Effect.succeed(projects as never),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: (threadId) => {
            const existing = harness.existingThreads?.[threadId];
            if (existing !== undefined) {
              return Effect.succeed({ thread: { id: threadId, ...existing } } as never);
            }
            return created.has(threadId)
              ? Effect.succeed({
                  thread: { id: threadId, projectId: alpha.id, historyOrigin: "v1_import" },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId }));
          },
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              for (const event of input.events) {
                if (event.type === "thread.created") created.add(event.payload.id);
              }
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed((harness.runtimeRows ?? []) as never),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        IdAllocator.layer,
      ),
    ),
  );
  return {
    layer,
    writes,
    dispatched,
    upserts,
    recorded,
    descriptorQueries,
    recentThreadRequests,
  };
};

const claudeSession = (id: string, cwd: string, overrides: Partial<Descriptor> = {}) =>
  descriptor({
    source: "claudeAgent",
    providerInstanceId: claudeInstance,
    providerSessionId: id,
    cwd,
    ...overrides,
  });
const codexSession = (id: string, cwd: string, overrides: Partial<Descriptor> = {}) =>
  descriptor({
    source: "codex",
    providerInstanceId: codexInstance,
    providerSessionId: id,
    cwd,
    ...overrides,
  });
const cursorSession = (id: string, cwd: string, overrides: Partial<Descriptor> = {}) =>
  descriptor({
    source: "cursor",
    providerInstanceId: cursorInstance,
    providerSessionId: id,
    cwd,
    ...overrides,
  });

const CLAUDE_UUID = "11111111-1111-4111-8111-111111111111";

it.effect(
  "lists one project's sessions newest first with project labels and context metadata",
  () => {
    const harness = makeHarness({
      descriptorsByRoot: {
        [alpha.workspaceRoot]: [
          codexSession("codex-older", alpha.workspaceRoot, {
            lastActiveAt: "2026-09-19T10:00:00.000Z",
            createdAt: "2026-09-19T09:00:00.000Z",
            lastMessageAt: "2026-09-19T10:05:00.000Z",
            contextUsedTokens: 14_000,
            contextMaxTokens: 200_000,
            importable: false,
            importBlockedReason: "Session transcript exceeds the import record limit",
          }),
          cursorSession("cursor-newer", alpha.workspaceRoot, {
            lastActiveAt: "2026-09-21T10:00:00.000Z",
            contextUsagePercent: 42,
            hasCompactionSummary: false,
          }),
        ],
        [beta.workspaceRoot]: [claudeSession("not-listed", beta.workspaceRoot)],
      },
    });

    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      const result = yield* importer.listAgentSessions({
        projectId: alpha.id,
        expectedWorkspaceRoot: alpha.workspaceRoot,
      });

      expect(result.entries.map((entry) => entry.providerSessionId)).toEqual([
        "cursor-newer",
        "codex-older",
      ]);
      expect(result.entries[0]).toMatchObject({
        provider: "cursor",
        providerInstanceId: "cursor",
        projectId: alpha.id,
        projectTitle: "Alpha",
        cwd: alpha.workspaceRoot,
        alreadyImported: false,
        importable: true,
        hasCompactionSummary: false,
        contextUsagePercent: 42,
        // Without descriptors for them, created/last-message fall back to last activity.
        createdAt: "2026-09-21T10:00:00.000Z",
        lastMessageAt: "2026-09-21T10:00:00.000Z",
      });
      // Native percent stands alone; no token counts are made up for it.
      expect(result.entries[0]?.contextUsedTokens).toBeUndefined();
      expect(result.entries[0]?.contextMaxTokens).toBeUndefined();
      expect(result.entries[1]).toMatchObject({
        createdAt: "2026-09-19T09:00:00.000Z",
        lastMessageAt: "2026-09-19T10:05:00.000Z",
        contextUsedTokens: 14_000,
        contextMaxTokens: 200_000,
        importable: false,
        importBlockedReason: "Session transcript exceeds the import record limit",
      });
      expect(result.entries[1]?.contextUsagePercent).toBeUndefined();
      expect(result.providerErrors).toEqual([]);
      expect(harness.descriptorQueries.map((query) => query.workspaceRoot)).toEqual([
        alpha.workspaceRoot,
      ]);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("lists across every active project when no project is named (Automatic)", () => {
  const harness = makeHarness({
    descriptorsByRoot: {
      [alpha.workspaceRoot]: [
        claudeSession(CLAUDE_UUID, alpha.workspaceRoot, {
          lastActiveAt: "2026-09-18T10:00:00.000Z",
        }),
      ],
      [beta.workspaceRoot]: [
        codexSession("codex-beta", beta.workspaceRoot, {
          lastActiveAt: "2026-09-20T10:00:00.000Z",
        }),
        cursorSession("cursor-beta", beta.workspaceRoot, {
          lastActiveAt: "2026-09-19T10:00:00.000Z",
        }),
      ],
    },
    providerErrorsByRoot: {
      [alpha.workspaceRoot]: [{ source: "codex", message: "Could not read ~/.codex" }],
      [beta.workspaceRoot]: [{ source: "codex", message: "Could not read ~/.codex" }],
    },
  });

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const result = yield* importer.listAgentSessions({});

    expect(
      result.entries.map((entry) => [entry.providerSessionId, entry.projectId, entry.projectTitle]),
    ).toEqual([
      ["codex-beta", beta.id, "Beta"],
      ["cursor-beta", beta.id, "Beta"],
      [CLAUDE_UUID, alpha.id, "Alpha"],
    ]);
    // One provider failure is reported once, not once per project.
    expect(result.providerErrors).toEqual([
      { provider: "codex", message: "Could not read ~/.codex" },
    ]);
    expect(harness.descriptorQueries.map((query) => query.workspaceRoot).toSorted()).toEqual([
      alpha.workspaceRoot,
      beta.workspaceRoot,
    ]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("keeps only the newest row when a session shows up under two project roots", () => {
  const shared = (cwd: string, lastActiveAt: string) =>
    codexSession("codex-shared", cwd, { lastActiveAt });
  const harness = makeHarness({
    descriptorsByRoot: {
      [alpha.workspaceRoot]: [shared(alpha.workspaceRoot, "2026-09-18T10:00:00.000Z")],
      [beta.workspaceRoot]: [shared(beta.workspaceRoot, "2026-09-20T10:00:00.000Z")],
    },
  });

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const result = yield* importer.listAgentSessions({});

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ projectId: beta.id });
  }).pipe(Effect.provide(harness.layer));
});

it.effect("hides sessions T3 already has and counts them", () => {
  const imported = codexSession("codex-imported", alpha.workspaceRoot);
  const deleted = codexSession("codex-deleted", alpha.workspaceRoot);
  const bound = claudeSession(CLAUDE_UUID, alpha.workspaceRoot);
  const archived = cursorSession("cursor-archived", alpha.workspaceRoot);
  const fresh = codexSession("codex-fresh", alpha.workspaceRoot, {
    lastActiveAt: "2026-09-01T10:00:00.000Z",
  });
  const harness = makeHarness({
    descriptorsByRoot: {
      [alpha.workspaceRoot]: [imported, deleted, bound, archived, fresh],
    },
    existingThreads: {
      [threadIdFor(codexInstance, "codex-imported")]: {
        projectId: alpha.id,
        historyOrigin: "v1_import",
      },
      // A deleted import no longer occupies the session: it can be attached again.
      [threadIdFor(codexInstance, "codex-deleted")]: {
        projectId: alpha.id,
        historyOrigin: "v1_import",
        deletedAt: "2026-09-10T00:00:00.000Z",
      },
      [threadIdFor(cursorInstance, "cursor-archived")]: {
        projectId: alpha.id,
        historyOrigin: "v1_import",
        archivedAt: "2026-09-10T00:00:00.000Z",
      },
    },
    // A live native thread already bound to this Claude session.
    runtimeRows: [
      {
        threadId: "native-thread-bound",
        providerName: "claudeAgent",
        providerInstanceId: claudeInstance,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-09-20T00:00:00.000Z",
        resumeCursor: { resume: CLAUDE_UUID },
        runtimePayload: null,
      },
    ],
  });

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const result = yield* importer.listAgentSessions({ projectId: alpha.id });

    expect(result.entries.map((entry) => entry.providerSessionId).toSorted()).toEqual([
      "codex-deleted",
      "codex-fresh",
    ]);
    expect(result.filteredAlreadyImportedCount).toBe(3);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("omits the filtered count when nothing was hidden", () => {
  const harness = makeHarness({
    descriptorsByRoot: {
      [alpha.workspaceRoot]: [codexSession("codex-fresh", alpha.workspaceRoot)],
    },
  });
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const result = yield* importer.listAgentSessions({ projectId: alpha.id });
    expect(result.entries).toHaveLength(1);
    expect(result.filteredAlreadyImportedCount).toBeUndefined();
  }).pipe(Effect.provide(harness.layer));
});

it.effect("pages by limit, reports truncation, and defaults to 15 rows", () => {
  const sessions = Array.from({ length: 20 }, (_, index) =>
    codexSession(`codex-${String(index).padStart(2, "0")}`, alpha.workspaceRoot, {
      lastActiveAt: `2026-09-${String(30 - index).padStart(2, "0")}T10:00:00.000Z`,
    }),
  );
  const harness = makeHarness({ descriptorsByRoot: { [alpha.workspaceRoot]: sessions } });

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const page = yield* importer.listAgentSessions({ projectId: alpha.id, limit: 3 });
    expect(page.entries.map((entry) => entry.providerSessionId)).toEqual([
      "codex-00",
      "codex-01",
      "codex-02",
    ]);
    expect(page.truncated).toBe(true);

    const defaulted = yield* importer.listAgentSessions({ projectId: alpha.id });
    expect(defaulted.entries).toHaveLength(15);
    expect(defaulted.truncated).toBe(true);

    const everything = yield* importer.listAgentSessions({ projectId: alpha.id, limit: 200 });
    expect(everything.entries).toHaveLength(20);
    expect(everything.truncated).toBeUndefined();
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects an unknown project and a project that moved directories", () => {
  const harness = makeHarness({ descriptorsByRoot: {} });
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;

    const missing = yield* Effect.flip(
      importer.listAgentSessions({ projectId: ProjectId.make("missing") }),
    );
    expect(missing).toBeInstanceOf(AgentSessionImportProjectNotFoundError);

    const moved = yield* Effect.flip(
      importer.listAgentSessions({ projectId: alpha.id, expectedWorkspaceRoot: "/work/elsewhere" }),
    );
    expect(moved).toBeInstanceOf(AgentSessionImportProjectChangedError);
  }).pipe(Effect.provide(harness.layer));
});

const attachedSession = codexSession("codex-attach", alpha.workspaceRoot, {
  lastActiveAt: "2026-09-21T10:01:00.000Z",
  contextUsedTokens: 8_000,
  contextUsedTokensFull: 100_000,
  contextMaxTokens: 258_000,
});

it.effect("attaches one session as a V2 thread with its native identity, idempotently", () => {
  const harness = makeHarness({
    descriptorsByRoot: {
      [alpha.workspaceRoot]: [codexSession("codex-other", alpha.workspaceRoot), attachedSession],
    },
    messagesBySession: {
      "codex-attach": [
        { role: "user", text: "Fix it", createdAt: "2026-09-21T10:00:00.000Z" },
        { role: "assistant", text: "Fixed", createdAt: "2026-09-21T10:01:00.000Z" },
      ],
    },
  });
  const threadId = threadIdFor(codexInstance, "codex-attach");

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const first = yield* importer.attachAgentSession({
      projectId: alpha.id,
      providerInstanceId: codexInstance,
      providerSessionId: "codex-attach",
    });
    const retry = yield* importer.attachAgentSession({
      projectId: alpha.id,
      providerInstanceId: codexInstance,
      providerSessionId: "codex-attach",
    });

    expect(first).toEqual({ threadId, created: true });
    expect(retry).toEqual({ threadId, created: false });

    // Only the chosen session is written, and only once.
    expect(harness.writes).toHaveLength(1);
    const events = harness.writes[0]!;
    const created = events.find((event) => event.type === "thread.created");
    const providerThread = events.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      projectId: alpha.id,
      activeProviderThreadId: providerThread?.payload.id,
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: { driver: "codex", nativeId: "codex-attach", strength: "strong" },
    });
    expect(
      events.filter((event) => event.type === "message.updated").map((e) => e.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(harness.upserts).toEqual([
      expect.objectContaining({ threadId, resumeCursor: { threadId: "codex-attach" } }),
    ]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("asks the scanner for compaction history unless the client picks full", () => {
  const harness = makeHarness({
    descriptorsByRoot: { [alpha.workspaceRoot]: [attachedSession] },
  });
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    yield* importer.attachAgentSession({
      projectId: alpha.id,
      providerInstanceId: codexInstance,
      providerSessionId: "codex-attach",
    });
    expect(harness.recentThreadRequests.map((request) => request.historyMode)).toEqual([
      "compaction",
    ]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("passes an explicit full history mode through to the scanner", () => {
  const harness = makeHarness({
    descriptorsByRoot: { [alpha.workspaceRoot]: [attachedSession] },
  });
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    yield* importer.attachAgentSession({
      projectId: alpha.id,
      providerInstanceId: codexInstance,
      providerSessionId: "codex-attach",
      historyMode: "full",
    });
    expect(harness.recentThreadRequests.map((request) => request.historyMode)).toEqual(["full"]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each([
  ["compaction", { usedTokens: 8_000, maxTokens: 258_000 }],
  ["full", { usedTokens: 100_000, maxTokens: 258_000 }],
] as const)(
  "seeds the imported provider thread's context usage from the %s history mode",
  ([historyMode, expected]) => {
    const harness = makeHarness({
      descriptorsByRoot: { [alpha.workspaceRoot]: [attachedSession] },
    });
    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      yield* importer.attachAgentSession({
        projectId: alpha.id,
        providerInstanceId: codexInstance,
        providerSessionId: "codex-attach",
        historyMode,
      });
      const providerThread = harness.writes[0]?.find(
        (event) => event.type === "provider-thread.updated",
      );
      expect(providerThread?.payload).toMatchObject({ contextUsage: expected });
      // The scanner reported no native percent, so none is invented.
      expect(
        (providerThread?.payload as { contextUsage?: { usedPercentage?: number } } | undefined)
          ?.contextUsage?.usedPercentage,
      ).toBeUndefined();
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "imports a Cursor session with a percent-only context meter and no resume binding",
  () => {
    const cursorId = "44444444-4444-4444-8444-444444444444";
    const harness = makeHarness({
      descriptorsByRoot: {
        [alpha.workspaceRoot]: [
          cursorSession(cursorId, alpha.workspaceRoot, { contextUsagePercent: 37 }),
        ],
      },
      messagesBySession: {
        [cursorId]: [
          {
            role: "user",
            text: "Ship the Cursor attach path",
            createdAt: "2026-09-21T10:00:00.000Z",
          },
          { role: "assistant", text: "Imported history", createdAt: "2026-09-21T10:01:00.000Z" },
        ],
      },
    });
    const threadId = threadIdFor(cursorInstance, cursorId);

    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      const result = yield* importer.attachAgentSession({
        projectId: alpha.id,
        providerInstanceId: cursorInstance,
        providerSessionId: cursorId,
      });

      expect(result).toEqual({ threadId, created: true });
      const events = harness.writes[0]!;
      const providerThread = events.find((event) => event.type === "provider-thread.updated");
      expect(providerThread?.payload).toMatchObject({
        appThreadId: threadId,
        nativeThreadRef: { driver: "cursor", nativeId: cursorId, strength: "strong" },
        contextUsage: { usedPercentage: 37 },
      });
      expect(
        (providerThread?.payload as { contextUsage?: { usedTokens?: number } }).contextUsage
          ?.usedTokens,
      ).toBeUndefined();
      expect(
        events.filter((event) => event.type === "message.updated").map((e) => e.payload.text),
      ).toEqual(["Ship the Cursor attach path", "Imported history"]);
      // Cursor chat ids are not proven to resume as a runtime session: history and identity only.
      expect(harness.upserts).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("navigates to an already imported thread and restores it when archived", () => {
  const harness = makeHarness({
    descriptorsByRoot: { [alpha.workspaceRoot]: [attachedSession] },
    existingThreads: {
      [threadIdFor(codexInstance, "codex-attach")]: {
        projectId: alpha.id,
        historyOrigin: "v1_import",
        archivedAt: "2026-09-10T00:00:00.000Z",
      },
    },
  });
  const threadId = threadIdFor(codexInstance, "codex-attach");

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const result = yield* importer.attachAgentSession({
      projectId: alpha.id,
      providerInstanceId: codexInstance,
      providerSessionId: "codex-attach",
    });

    expect(result).toEqual({ threadId, created: false });
    expect(harness.writes).toEqual([]);
    expect(harness.dispatched).toEqual([
      expect.objectContaining({ type: "thread.unarchive", threadId }),
    ]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses to import a session over a thread the user deleted", () => {
  const harness = makeHarness({
    descriptorsByRoot: { [alpha.workspaceRoot]: [attachedSession] },
    existingThreads: {
      [threadIdFor(codexInstance, "codex-attach")]: {
        projectId: alpha.id,
        historyOrigin: "v1_import",
        deletedAt: "2026-09-10T00:00:00.000Z",
      },
    },
  });
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const error = yield* Effect.flip(
      importer.attachAgentSession({
        projectId: alpha.id,
        providerInstanceId: codexInstance,
        providerSessionId: "codex-attach",
      }),
    );
    expect(error).toBeInstanceOf(AgentSessionAttachDeletedThreadError);
    expect(harness.writes).toEqual([]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reports a session that vanished and one too large to import", () => {
  const harness = makeHarness({
    descriptorsByRoot: {
      [alpha.workspaceRoot]: [
        codexSession("codex-too-big", alpha.workspaceRoot, {
          importable: false,
          importBlockedReason: "Session transcript exceeds the import record limit",
        }),
      ],
    },
  });
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;

    const gone = yield* Effect.flip(
      importer.attachAgentSession({
        projectId: alpha.id,
        providerInstanceId: codexInstance,
        providerSessionId: "codex-gone",
      }),
    );
    expect(gone).toBeInstanceOf(AgentSessionUnavailableError);

    const blocked = yield* Effect.flip(
      importer.attachAgentSession({
        projectId: alpha.id,
        providerInstanceId: codexInstance,
        providerSessionId: "codex-too-big",
      }),
    );
    expect(blocked).toBeInstanceOf(AgentSessionImportBlockedError);
    expect(blocked).toMatchObject({
      importBlockedReason: "Session transcript exceeds the import record limit",
    });
    expect(harness.writes).toEqual([]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects an unknown project or moved directory before reading any session", () => {
  const harness = makeHarness({ descriptorsByRoot: { [alpha.workspaceRoot]: [attachedSession] } });
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const base = { providerInstanceId: codexInstance, providerSessionId: "codex-attach" };

    expect(
      yield* Effect.flip(
        importer.attachAgentSession({ ...base, projectId: ProjectId.make("missing") }),
      ),
    ).toBeInstanceOf(AgentSessionImportProjectNotFoundError);
    expect(
      yield* Effect.flip(
        importer.attachAgentSession({
          ...base,
          projectId: alpha.id,
          expectedWorkspaceRoot: "/work/elsewhere",
        }),
      ),
    ).toBeInstanceOf(AgentSessionImportProjectChangedError);
    expect(harness.descriptorQueries).toEqual([]);
    expect(harness.writes).toEqual([]);
  }).pipe(Effect.provide(harness.layer));
});
