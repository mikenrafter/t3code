/**
 * Read Cursor IDE `composerData:<sessionId>` context usage from global state.vscdb.
 *
 * Source of truth for live Cursor sessions: table `cursorDiskKV`, field
 * `contextUsagePercent` (0–100). `composer.composerHeaders` (ItemTable) is a
 * secondary index that often carries the same percent when the KV row is
 * missing. Missing row / unreadable DB / invalid percent → no signal (null),
 * never an error and never invented token counts.
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

function decodeSqliteText(value: string | Uint8Array): string {
  return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
}

function readPercentFromComposerDataJson(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { readonly contextUsagePercent?: unknown };
    return parseContextUsagePercent(parsed.contextUsagePercent);
  } catch {
    return null;
  }
}

function readPercentsFromComposerHeadersJson(raw: string, into: Map<string, number>): void {
  try {
    const parsed = JSON.parse(raw) as {
      readonly allComposers?: ReadonlyArray<{
        readonly composerId?: unknown;
        readonly contextUsagePercent?: unknown;
      }>;
    };
    const composers = parsed.allComposers;
    if (!Array.isArray(composers)) return;
    for (const composer of composers) {
      const id =
        typeof composer?.composerId === "string" && composer.composerId.trim().length > 0
          ? composer.composerId.trim()
          : null;
      if (id === null || into.has(id)) continue;
      const percent = parseContextUsagePercent(composer.contextUsagePercent);
      if (percent !== null) into.set(id, percent);
    }
  } catch {
    // Headers are best-effort; ignore malformed rows.
  }
}

/**
 * Load every known `contextUsagePercent` from state.vscdb once.
 * Prefer `cursorDiskKV` composerData rows; fill gaps from composer headers.
 */
export function loadCursorComposerContextUsageIndex(options?: {
  readonly stateDbPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}): ReadonlyMap<string, number> {
  const dbPath = options?.stateDbPath ?? resolveCursorStateDbPath(options?.env ?? process.env);
  const index = new Map<string, number>();

  try {
    const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      try {
        const rows = db
          .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
          .all() as ReadonlyArray<{ readonly key: string; readonly value: string | Uint8Array }>;
        for (const row of rows) {
          const sessionId = row.key.slice("composerData:".length).trim();
          if (sessionId.length === 0) continue;
          const percent = readPercentFromComposerDataJson(decodeSqliteText(row.value));
          if (percent !== null) index.set(sessionId, percent);
        }
      } catch {
        // Table may be missing on older Cursor installs.
      }

      try {
        const headers = db
          .prepare("SELECT value FROM ItemTable WHERE key = ?")
          .get("composer.composerHeaders") as { readonly value: string | Uint8Array } | undefined;
        if (headers !== undefined) {
          readPercentsFromComposerHeadersJson(decodeSqliteText(headers.value), index);
        }
      } catch {
        // ItemTable may be missing.
      }
    } finally {
      db.close();
    }
  } catch {
    return index;
  }

  return index;
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

  const fromIndex = loadCursorComposerContextUsageIndex(options).get(trimmed);
  return fromIndex === undefined ? null : { contextUsagePercent: fromIndex };
}
