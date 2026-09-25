/**
 * Read Cursor IDE `composerData:<sessionId>` context usage from global state.vscdb.
 *
 * Source of truth for live Cursor sessions: table `cursorDiskKV`, field
 * `contextUsagePercent` (0–100). Missing row / unreadable DB / invalid percent
 * → no signal (null), never an error and never invented token counts.
 */

import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export type CursorComposerContextUsage = {
  readonly contextUsagePercent: number;
};

/** Resolve Cursor's global `state.vscdb` (`CURSOR_STATE_DB` wins when set). */
export function resolveCursorStateDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CURSOR_STATE_DB;
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME;
  const home =
    typeof env.HOME === "string" && env.HOME.trim().length > 0 ? env.HOME.trim() : NodeOs.homedir();
  const configHome =
    typeof xdgConfigHome === "string" && xdgConfigHome.trim().length > 0
      ? xdgConfigHome.trim()
      : NodePath.join(home, ".config");
  return NodePath.join(configHome, "Cursor", "User", "globalStorage", "state.vscdb");
}

function parseContextUsagePercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

/**
 * Read native `contextUsagePercent` for an ACP/transcript session id.
 * Returns null when the row is missing or the percent is absent/invalid.
 */
export function readCursorComposerContextUsage(
  sessionId: string,
  options?: {
    readonly stateDbPath?: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): CursorComposerContextUsage | null {
  const trimmed = sessionId.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const dbPath = options?.stateDbPath ?? resolveCursorStateDbPath(options?.env ?? process.env);

  try {
    const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
        .get(`composerData:${trimmed}`) as { readonly value: string | Uint8Array } | undefined;
      if (row === undefined) {
        return null;
      }
      const raw =
        typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
      const parsed = JSON.parse(raw) as { readonly contextUsagePercent?: unknown };
      const contextUsagePercent = parseContextUsagePercent(parsed.contextUsagePercent);
      return contextUsagePercent === null ? null : { contextUsagePercent };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
