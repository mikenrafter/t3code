import migrateAutoSettleDisabledAt from "./054_ProjectionThreadsAutoSettleDisabledAt.ts";

/**
 * Fork databases recorded ledger id 54 as another migration, so upstream 054
 * never ran there and `projection_threads.auto_settle_disabled_at` is missing.
 * 054 is idempotent (it only adds a missing column), so replaying it as a
 * normal ledger entry repairs those databases and is a no-op everywhere else.
 */
export default migrateAutoSettleDisabledAt;
