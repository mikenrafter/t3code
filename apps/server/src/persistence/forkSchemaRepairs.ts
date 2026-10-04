import * as Effect from "effect/Effect";

import migrateAutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

/**
 * Idempotent schema repairs for databases from fork builds, run after the
 * migration ledger on every startup. They stay out of `effect_sql_migrations`
 * because any fork id there masks the upstream migration that later takes it
 * (docs/internals/legacy-orchestration-migration.md, "Divergent migration ids").
 *
 * Fork builds recorded ledger id 54 as another migration, so upstream 054 never
 * ran there and `projection_threads.auto_settle_disabled_at` is missing. 054
 * only adds the column when absent, so replaying it is a no-op elsewhere.
 */
export const runForkSchemaRepairs = Effect.fn("runForkSchemaRepairs")(function* () {
  yield* migrateAutoSettleDisabledAt;
});
