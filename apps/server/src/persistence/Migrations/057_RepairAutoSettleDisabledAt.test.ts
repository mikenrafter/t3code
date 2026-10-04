import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

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

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "057_RepairAutoSettleDisabledAt",
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

          assert.deepStrictEqual(
            executed.map(([id]) => id),
            [55, 56, 57],
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
            yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 57`,
            [{ name: "RepairAutoSettleDisabledAt" }],
          );
        }),
    );

    it.effect("keeps the column and its values when it is already present", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 56 });
        yield* insertThread;
        const disabledAt = "2026-02-02T00:00:00.000Z";
        yield* sql`UPDATE projection_threads SET auto_settle_disabled_at = ${disabledAt}`;
        assert.include(yield* columnNames, "auto_settle_disabled_at");

        const executed = yield* runMigrations();

        assert.deepStrictEqual(executed, [[57, "RepairAutoSettleDisabledAt"]]);
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
