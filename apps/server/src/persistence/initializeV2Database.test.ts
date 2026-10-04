// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "./Layers/Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import { layer as providerSessionRuntimeLayer } from "./ProviderSessionRuntime.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

it.effect(
  "snapshots V1, imports transcripts lazily, and preserves both databases across switches",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v1-v2-"));
    const sourcePath = NodePath.join(directory, "state.sqlite");
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    const threadId = ThreadId.make("legacy-thread");
    const seed = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/tmp/project', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, 'project', 'V1 thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      for (let index = 0; index < 6; index++) {
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`message-${index}`}, ${threadId}, ${index % 2 ? "assistant" : "user"}, ${`Text ${index}`}, 0, ${`2026-01-0${index + 1}T00:00:00.000Z`}, ${`2026-01-0${index + 1}T00:00:00.000Z`})`;
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));

    return Effect.gen(function* () {
      yield* seed;
      const original = NodeFS.readFileSync(sourcePath);
      const config = yield* ServerConfig.ServerConfig;
      const databaseLayer = SqlitePersistence.layerConfig.pipe(
        Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
      );
      const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(databaseLayer),
      );
      const sink = EventSink.layer.pipe(Layer.provide(stores));
      const runtimes = providerSessionRuntimeLayer.pipe(Layer.provide(databaseLayer));
      const importer = LegacyV1ThreadImporter.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(stores, sink, runtimes)),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const legacy = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        yield* legacy.reconcileShells;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const shell = yield* projections.getThreadProjection(threadId);
        assert.equal(shell.thread.id, threadId);
        assert.deepEqual(
          shell.messages.map((message) => message.text),
          ["Text 4", "Text 5"],
        );
        const pending =
          yield* sql`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports`;
        assert.equal(pending[0]?.transcript_imported_at, null);
        yield* legacy.ensureTranscript(threadId);
        const transcript = yield* projections.getThreadProjection(threadId);
        assert.deepEqual(
          transcript.messages.map((message) => message.text),
          ["Text 0", "Text 1", "Text 2", "Text 3", "Text 4", "Text 5"],
        );
        const imported =
          yield* sql`SELECT imported_message_count, transcript_imported_at FROM orchestration_v2_legacy_imports`;
        assert.equal(imported[0]?.imported_message_count, 6);
        assert.isNotNull(imported[0]?.transcript_imported_at);
        yield* sql`CREATE TABLE v2_work (text TEXT)`;
        yield* sql`INSERT INTO v2_work VALUES ('Keep V2 work')`;
      }).pipe(Effect.provide(importer));
      assert.deepEqual(NodeFS.readFileSync(sourcePath), original);
      const v1 = new NodeSqlite.DatabaseSync(sourcePath);
      try {
        assert.equal(
          v1.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()?.id,
          52,
        );
        assert.equal(
          v1
            .prepare(
              "SELECT count(*) AS count FROM sqlite_master WHERE name = 'orchestration_v2_legacy_imports'",
            )
            .get()?.count,
          0,
        );
        v1.exec("UPDATE projection_threads SET title = 'Continued in V1'");
      } finally {
        v1.close();
      }
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "Keep V2 work");
        assert.equal((yield* sql`SELECT title FROM projection_threads`)[0]?.title, "V1 thread");
      }).pipe(Effect.provide(databaseLayer));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);

it.effect("includes committed WAL data and does not publish a failed snapshot", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-snapshot-"));
  const sourcePath = NodePath.join(directory, "state.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  return Effect.gen(function* () {
    NodeFS.writeFileSync(sourcePath, "invalid SQLite");
    assert.isTrue((yield* Effect.result(initializeV2Database(destinationPath)))._tag === "Failure");
    assert.isFalse(NodeFS.existsSync(destinationPath));
    NodeFS.unlinkSync(sourcePath);
    const source = new NodeSqlite.DatabaseSync(sourcePath);
    try {
      source.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('committed'); BEGIN; INSERT INTO messages VALUES ('uncommitted');",
      );
      yield* initializeV2Database(destinationPath);
      const copy = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
      try {
        assert.deepEqual(
          copy
            .prepare("SELECT text FROM messages")
            .all()
            .map((row) => row.text),
          ["committed"],
        );
      } finally {
        copy.close();
      }
      source.exec("ROLLBACK");
    } finally {
      source.close();
    }
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("uses statev2.sqlite for default and explicit development paths", () =>
  Effect.gen(function* () {
    for (const devUrl of [undefined, new URL("http://localhost:5173")]) {
      for (const baseDirIsExplicit of [false, true]) {
        const paths = yield* ServerConfig.deriveServerPaths("/tmp/t3", devUrl, {
          baseDirIsExplicit,
        });
        assert.equal(NodePath.basename(paths.dbPath), "statev2.sqlite");
        assert.equal(paths.settingsPath, NodePath.join(paths.stateDir, "settings.json"));
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("starts fresh without V1 and never imports over existing V2 state", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-fresh-"));
  const destinationPath = NodePath.join(directory, "userdata", "statev2.sqlite");
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const database = SqlitePersistence.layerConfig.pipe(
      Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE v2_work (text TEXT)`;
      yield* sql`INSERT INTO v2_work VALUES ('fresh V2 work')`;
    }).pipe(Effect.provide(database));
    const sourcePath = NodePath.join(NodePath.dirname(destinationPath), "state.sqlite");
    assert.isFalse(NodeFS.existsSync(sourcePath));
    NodeFS.writeFileSync(sourcePath, "This source must never be opened once V2 exists");
    yield* initializeV2Database(destinationPath);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "fresh V2 work");
    }).pipe(Effect.provide(database));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect(
  "carries V1 runtime rows and cursors into V2 and adds the resume bridge table there only",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v1-v2-runtime-"));
    const sourcePath = NodePath.join(directory, "state.sqlite");
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    const claudeCursor =
      '{"threadId":"thread-claude","resume":"3f2b8c1e-7d4a-4e6b-9a5c-0d1e2f3a4b5c","resumeSessionAt":"9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d","turnCount":2,"turnStartMessageIds":["m1",null]}';
    const codexCursor = '{"threadId":"019e3f5a-codex-native-thread"}';
    const cursorCursor = '{"schemaVersion":1,"sessionId":"0b9d4a52-6c7e-4f18-a3b2-5d6e7f8091a2"}';
    const seed = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      for (const [threadId, providerName, instanceId, cursor, status] of [
        ["thread-claude", "claudeAgent", "claudeAgent", claudeCursor, "running"],
        ["thread-codex", "codex", null, codexCursor, "stopped"],
        ["thread-cursor", "cursor", "cursor", cursorCursor, "running"],
      ] as const) {
        yield* sql`INSERT INTO provider_session_runtime (
        thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
        last_seen_at, resume_cursor_json, runtime_payload_json
      ) VALUES (
        ${threadId}, ${providerName}, ${instanceId}, ${providerName}, 'full-access', ${status},
        '2026-01-02T03:04:05.000Z', ${cursor}, '{"cwd":"/tmp/project","model":"m"}'
      )`;
        yield* sql`INSERT INTO projection_thread_sessions (
        thread_id, status, provider_name, provider_session_id, provider_thread_id,
        active_turn_id, last_error, updated_at
      ) VALUES (${threadId}, ${status === "running" ? "running" : "ready"}, ${providerName},
        NULL, NULL, NULL, NULL, '2026-01-02T03:04:05.000Z')`;
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));

    return Effect.gen(function* () {
      yield* seed;
      const original = NodeFS.readFileSync(sourcePath);
      const config = yield* ServerConfig.ServerConfig;
      const databaseLayer = SqlitePersistence.layerConfig.pipe(
        Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
      );
      yield* initializeV2Database(destinationPath);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Cursors are byte-for-byte what V1 stored: the bridge reads them as written.
        assert.deepStrictEqual(
          yield* sql`
          SELECT thread_id, provider_name, provider_instance_id, status, last_seen_at,
            resume_cursor_json, runtime_payload_json
          FROM provider_session_runtime ORDER BY thread_id
        `,
          [
            {
              thread_id: "thread-claude",
              provider_name: "claudeAgent",
              provider_instance_id: "claudeAgent",
              status: "running",
              last_seen_at: "2026-01-02T03:04:05.000Z",
              resume_cursor_json: claudeCursor,
              runtime_payload_json: '{"cwd":"/tmp/project","model":"m"}',
            },
            {
              thread_id: "thread-codex",
              provider_name: "codex",
              provider_instance_id: null,
              status: "stopped",
              last_seen_at: "2026-01-02T03:04:05.000Z",
              resume_cursor_json: codexCursor,
              runtime_payload_json: '{"cwd":"/tmp/project","model":"m"}',
            },
            {
              thread_id: "thread-cursor",
              provider_name: "cursor",
              provider_instance_id: "cursor",
              status: "running",
              last_seen_at: "2026-01-02T03:04:05.000Z",
              resume_cursor_json: cursorCursor,
              runtime_payload_json: '{"cwd":"/tmp/project","model":"m"}',
            },
          ],
        );
        // The V1 session status survives too: it decides which threads resume on upgrade.
        assert.deepStrictEqual(
          (yield* sql`SELECT thread_id, status FROM projection_thread_sessions ORDER BY thread_id`).map(
            (row) => [row.thread_id, row.status],
          ),
          [
            ["thread-claude", "running"],
            ["thread-codex", "ready"],
            ["thread-cursor", "running"],
          ],
        );
        const bridgeTable = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fork_v1_resume_bridge'
      `;
        assert.lengthOf(bridgeTable, 1);
        assert.deepStrictEqual(yield* sql`SELECT COUNT(*) AS count FROM fork_v1_resume_bridge`, [
          { count: 0 },
        ]);
      }).pipe(Effect.provide(databaseLayer));

      // V1 stays exactly as it was, so the user can still go back to it.
      assert.deepEqual(NodeFS.readFileSync(sourcePath), original);
      const v1 = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
      try {
        assert.equal(
          v1
            .prepare(
              "SELECT count(*) AS count FROM sqlite_master WHERE name = 'fork_v1_resume_bridge'",
            )
            .get()?.count,
          0,
        );
        assert.equal(
          v1.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()?.id,
          52,
        );
      } finally {
        v1.close();
      }
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);
