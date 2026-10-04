import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Records, per migrated V1 thread, what the V1 runtime row held before it was
 * bound into V2 and whether a one-time continuation is still owed. Created
 * outside the migration ledger (see forkSchemaRepairs.ts) and safe to replay.
 */
export const ensureForkV1ResumeBridgeSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_v1_resume_bridge (
      thread_id TEXT PRIMARY KEY,
      source_runtime_json TEXT,
      source_session_status TEXT,
      source_model_selection_json TEXT,
      provider_thread_id TEXT,
      binding_status TEXT NOT NULL,
      continuation_status TEXT NOT NULL,
      reason TEXT,
      captured_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_v1_resume_bridge_continuation_idx
    ON fork_v1_resume_bridge(continuation_status, thread_id)
  `;
});
