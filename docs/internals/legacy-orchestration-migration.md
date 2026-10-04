# Legacy orchestration migration

Orchestration v2 snapshots `state.sqlite` into `statev2.sqlite` before opening writable persistence
on its first launch. Only the copy receives v2 migrations; the original remains available to v1.
Subsequent launches reuse the copy without refreshing it from v1. It creates v2 thread shell events first and imports
the complete user and assistant transcript lazily when a client reads or continues the thread. The
v1 projection tables remain the import source and provide a read-only recovery source if an import
needs investigation.

## Imported data

The shell import preserves the project and thread identifiers, title, provider and model selection,
runtime and interaction modes, branch, worktree path, creation and update times, archive and delete
times, settlement override and timestamps, snooze timestamps, pin timestamp and order, and linked
pull request. The metadata repair path fills snooze, pin order, `unsettledAt`, and linked pull request
fields for threads imported before those fields were covered.

Transcript import reads user and assistant rows from `projection_thread_messages`. It preserves
message identifiers, text, supported attachments, timestamps, role, and ordering. A message that was
still streaming becomes an interrupted turn item.

The importer does not translate native provider runs, checkpoints and diffs, activities and tool
calls, approvals, or proposed plans. V2 therefore must not present those records as migrated
history. Provider session identity is the exception: see the next section.

## Resuming the native session

This fork bridges V1 provider sessions into V2. The shell import reads the V1 resume cursor in
`provider_session_runtime` and binds the thread to a strong provider thread for the same native
session ([`LegacyV1ResumeCursor.ts`](../../apps/server/src/orchestration-v2/legacy/LegacyV1ResumeCursor.ts),
[`LegacyV1ThreadImporter.ts`](../../apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts)).
V2 adapters never read the cursor, so the binding is what makes the first turn resume the session
instead of starting a new one. A thread with an unusable cursor stays unbound.

A bound thread's first turn sends only the user's text. The 32,000-character legacy handoff is built
only when the thread has no native resume target, from user and assistant messages (the newest
transcript suffix, including section labels and the import notice). That budget is separate from
portable provider handoffs. If native resume fails, V2's usual fresh-session fallback applies.

A thread whose V1 session status was `running` at the upgrade is continued once, with the message
"Continue where you left off.", when `continueThreadsAfterServerUpdate` is enabled for its project
([`LegacyV1ResumeBridge.ts`](../../apps/server/src/orchestration-v2/legacy/LegacyV1ResumeBridge.ts)).
The decision is recorded as `submitted` or `skipped` and never revisited, so enabling the setting
later does not revive old work. The runtime row's `running` is not enough: V1 maps both `ready` and
`running` sessions to it, which is why the bridge captures the session status. A thread that already
has a V2 run, was archived or deleted, or whose instance is unavailable or disabled, or whose native session
another thread also names, is skipped. The continuation runs after command readiness and never
delays startup.

The bridge keeps its state in `fork_v1_resume_bridge`, created by
[`ForkV1ResumeBridgeSchema.ts`](../../apps/server/src/persistence/ForkV1ResumeBridgeSchema.ts)
through `forkSchemaRepairs` rather than the migration ledger (see "Divergent migration ids").

## Client and server cutover

Clients and servers must agree on `ORCHESTRATION_PROTOCOL_VERSION` (currently 2). The client
runtime appends `orchestrationProtocol=2` to the socket URL, and the `/ws` route rejects a missing
or mismatched version with HTTP 426 (`orchestration_protocol_incompatible`) before any RPC or auth
work runs. The client checks the environment descriptor the same way: a missing version means the
host predates protocol 2, and a different version means both sides need updating. Either direction
blocks the connection as `unsupported` with a message naming the machine to update rather than
running half-upgraded. See `packages/client-runtime/src/connection/compatibility.ts` and
`apps/server/src/ws.ts`.

## Divergent migration ids

`effect_sql_migrations` records `migration_id` and `name`, but the migrator compares ids only:
rows at or below the recorded maximum are skipped without checking names. A database that ran a
local or fork migration under an id this build later assigns to a different migration therefore
never receives this build's migration at that id. `runMigrations` logs each recorded id whose name
differs from the manifest so the skipped schema change is diagnosable. There is no safe id range
for a fork inside this ledger: any id at or below a future upstream id masks it forever, so fork
schema changes belong in a separate migration table or outside the migrator entirely.

## Recovery

There is no supported whole-thread export API. Recovery uses an untouched copy of the environment's
`userdata` directory and opens that copy with SQLite's read-only mode. The user guide documents the
queries against `projection_threads` and `projection_thread_messages`. Never start a server against
the recovery copy because startup can run migrations and write new state.
