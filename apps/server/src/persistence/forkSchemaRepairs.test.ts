import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";

const columnNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  return columns.map((column) => column.name);
});

const insertThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = "2026-01-01T00:00:00.000Z";
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      created_at, updated_at
    ) VALUES (
      'thread-1', 'project-1', 'Existing thread',
      '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
    )
  `;
});

// Each case needs its own database: `it.layer` shares one connection per block.
it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "fork schema repairs on a fork database",
  (it) => {
    it.effect(
      "adds auto_settle_disabled_at to a fork database that recorded migration 54 as another migration",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 53 });
          // The fork shipped its own migration 54, so this build's 054 never runs.
          yield* sql`ALTER TABLE projection_threads ADD COLUMN external_status_json TEXT`;
          yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (54, 'ProjectionThreadExternalStatus')
        `;
          yield* insertThread;
          assert.notInclude(yield* columnNames, "auto_settle_disabled_at");

          const executed = yield* runMigrations();

          // The repair runs outside the ledger so it never claims an id upstream may assign.
          assert.deepStrictEqual(
            executed.map(([id]) => id),
            [55, 56],
          );
          const columns = yield* columnNames;
          assert.include(columns, "auto_settle_disabled_at");
          // The fork's own column is left as it was.
          assert.include(columns, "external_status_json");
          assert.deepStrictEqual(
            yield* sql`
            SELECT title, auto_settle_disabled_at AS "autoSettleDisabledAt"
            FROM projection_threads WHERE thread_id = 'thread-1'
          `,
            [{ title: "Existing thread", autoSettleDisabledAt: null }],
          );
          assert.deepStrictEqual(yield* runMigrations(), []);
          assert.deepStrictEqual(
            yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id > 56`,
            [],
          );
        }),
    );
  },
);

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "fork schema repairs on an upstream database",
  (it) => {
    it.effect("keeps the column and its values when it is already present", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 56 });
        yield* insertThread;
        const disabledAt = "2026-02-02T00:00:00.000Z";
        yield* sql`UPDATE projection_threads SET auto_settle_disabled_at = ${disabledAt}`;
        assert.include(yield* columnNames, "auto_settle_disabled_at");

        const executed = yield* runMigrations();

        assert.deepStrictEqual(executed, []);
        assert.deepStrictEqual(
          yield* sql`
          SELECT auto_settle_disabled_at AS "autoSettleDisabledAt" FROM projection_threads
        `,
          [{ autoSettleDisabledAt: disabledAt }],
        );
      }),
    );
  },
);

// Loaded where it is used so this file's other tests do not depend on the module.
const loadBridgeSchema = Effect.promise(() => import("./ForkV1ResumeBridgeSchema.ts"));

const BRIDGE_COLUMNS = [
  "thread_id",
  "source_runtime_json",
  "source_session_status",
  "source_model_selection_json",
  "provider_thread_id",
  "binding_status",
  "continuation_status",
  "reason",
  "captured_at",
];

const bridgeColumnNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(fork_v1_resume_bridge)`;
  return columns.map((column) => column.name);
});

const bridgeIndexColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const indexes = yield* sql<{ readonly name: string }>`PRAGMA index_list(fork_v1_resume_bridge)`;
  const columnsByIndex: Array<ReadonlyArray<string>> = [];
  for (const index of indexes) {
    const info = yield* sql.unsafe<{ readonly name: string }>(`PRAGMA index_info("${index.name}")`);
    columnsByIndex.push(info.map((column) => column.name));
  }
  return columnsByIndex;
});

const ledgerSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly id: number; readonly name: string }>`
    SELECT migration_id AS id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
});

const insertBridgeRow = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO fork_v1_resume_bridge (
        thread_id, source_runtime_json, source_session_status,
        source_model_selection_json, provider_thread_id, binding_status,
        continuation_status, reason, captured_at
      ) VALUES (
        ${threadId}, '{"status":"running"}', 'running',
        '{"instanceId":"codex","model":"gpt-5.4"}', NULL, 'bound',
        'pending', NULL, '2026-01-01T00:00:00.000Z'
      )
    `;
  });

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "fork V1 resume bridge schema repair",
  (it) => {
    it.effect(
      "creates the bridge table on a database that predates it without a ledger entry",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 53 });
          const before = yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master WHERE name = 'fork_v1_resume_bridge'
          `;
          assert.deepStrictEqual(before, []);
          const ledgerBefore = yield* ledgerSnapshot;

          yield* runMigrations();

          assert.sameMembers(yield* bridgeColumnNames, BRIDGE_COLUMNS);
          // The pending scan reads this index; it must lead with the status.
          assert.deepInclude(yield* bridgeIndexColumns, ["continuation_status", "thread_id"]);
          // Repairs never claim a migration id that upstream may assign later.
          const ledgerAfter = yield* ledgerSnapshot;
          assert.deepStrictEqual(
            ledgerAfter.filter((entry) => entry.id <= 53),
            ledgerBefore,
          );
          assert.deepStrictEqual(
            ledgerAfter.filter((entry) => /resume.?bridge/i.test(entry.name)),
            [],
          );
        }),
    );
  },
);

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "fork V1 resume bridge schema repair on repeat",
  (it) => {
    it.effect("is repeatable and keeps captured rows", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        const ledger = yield* ledgerSnapshot;
        yield* insertBridgeRow("thread-bridge-1");

        const { ensureForkV1ResumeBridgeSchema } = yield* loadBridgeSchema;
        yield* ensureForkV1ResumeBridgeSchema;
        yield* ensureForkV1ResumeBridgeSchema;
        assert.deepStrictEqual(yield* runMigrations(), []);

        assert.sameMembers(yield* bridgeColumnNames, BRIDGE_COLUMNS);
        assert.deepStrictEqual(yield* ledgerSnapshot, ledger);
        assert.deepStrictEqual(
          yield* sql`
            SELECT thread_id AS "threadId", source_session_status AS "sourceStatus",
              binding_status AS "bindingStatus", continuation_status AS "continuationStatus",
              provider_thread_id AS "providerThreadId", reason
            FROM fork_v1_resume_bridge
          `,
          [
            {
              threadId: "thread-bridge-1",
              sourceStatus: "running",
              bindingStatus: "bound",
              continuationStatus: "pending",
              providerThreadId: null,
              reason: null,
            },
          ],
        );
        // One record per thread: the primary key is what makes capture idempotent.
        const duplicate = yield* Effect.result(insertBridgeRow("thread-bridge-1"));
        assert.equal(duplicate._tag, "Failure");
      }),
    );
  },
);

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "fork V1 resume bridge schema repair after the table is lost",
  (it) => {
    it.effect("recreates the table on the next startup", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`DROP TABLE fork_v1_resume_bridge`;

        assert.deepStrictEqual(yield* runMigrations(), []);

        assert.sameMembers(yield* bridgeColumnNames, BRIDGE_COLUMNS);
        assert.deepInclude(yield* bridgeIndexColumns, ["continuation_status", "thread_id"]);
      }),
    );
  },
);
