import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Scan of Claude Code / Codex home directories on an environment, surfacing
 * project candidates for the welcome wizard's import step. The scan walks the
 * filesystem server-side, so results are cached briefly and refreshed when the
 * import step remounts.
 */
export const agentSessionScan = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:scan",
  tag: WS_METHODS.agentSessionsScan,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

export const agentSessionImport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:import",
  tag: WS_METHODS.agentSessionsImport,
});

/** Recent Claude / Codex sessions for a project, raised in page-limit steps. */
export const agentSessionList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:list",
  tag: WS_METHODS.agentSessionsList,
  // Server also caches descriptor polish on disk; keep the client warm across
  // dialog closes without forcing a full rescan on every open.
  staleTimeMs: 5 * 60_000,
  idleTtlMs: 30 * 60_000,
});

export const agentSessionAttach = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:attach",
  tag: WS_METHODS.agentSessionsAttach,
});
