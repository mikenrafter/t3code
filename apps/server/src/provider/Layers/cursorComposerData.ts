// @effect-diagnostics nodeBuiltinImport:off -- Synchronous read of Cursor's own sqlite file; callers pass a plain env, not Effect services.
/**
 * Read Cursor IDE `composerData:<sessionId>` context usage from global state.vscdb.
 *
 * Source of truth for live Cursor sessions: table `cursorDiskKV`, field
 * `contextUsagePercent` (0–100). `composer.composerHeaders` (ItemTable) is a
 * secondary index that often carries the same percent when the KV row is
 * missing. Missing row / unreadable DB / invalid percent → no signal (null),
 * never an error and never invented token counts.
 */

import * as NodeOS from "node:os";
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
    typeof env.HOME === "string" && env.HOME.trim().length > 0 ? env.HOME.trim() : NodeOS.homedir();
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

/** Keep each `IN (...)` well under SQLite's bound-variable limit. */
const SESSION_ID_CHUNK_SIZE = 500;

/**
 * Load known `contextUsagePercent` values from state.vscdb.
 * Prefer `cursorDiskKV` composerData rows; fill gaps from composer headers.
 *
 * The percent is extracted inside SQLite so composer blobs (which can hold whole
 * conversations) never cross into JS. Pass `sessionIds` to look up just those
 * composers by key instead of visiting every row; the headers row is only read
 * while some requested id is still missing.
 */
export function loadCursorComposerContextUsageIndex(options?: {
  readonly stateDbPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sessionIds?: ReadonlyArray<string>;
}): ReadonlyMap<string, number> {
  const dbPath = options?.stateDbPath ?? resolveCursorStateDbPath(options?.env ?? process.env);
  const sessionIds = options?.sessionIds
    ?.map((sessionId) => sessionId.trim())
    .filter((sessionId) => sessionId.length > 0);
  const index = new Map<string, number>();

  const collect = (rows: ReadonlyArray<Record<string, unknown>>) => {
    for (const row of rows) {
      const key = row.key;
      if (typeof key !== "string") continue;
      const sessionId = key.slice("composerData:".length).trim();
      const percent = parseContextUsagePercent(row.percent);
      if (sessionId.length > 0 && percent !== null) index.set(sessionId, percent);
    }
  };
  const percentExpression =
    "CASE WHEN json_valid(CAST(value AS TEXT)) " +
    "THEN json_extract(CAST(value AS TEXT), '$.contextUsagePercent') END AS percent";

  try {
    const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      try {
        if (sessionIds === undefined) {
          collect(
            db
              .prepare(
                `SELECT key, ${percentExpression} FROM cursorDiskKV WHERE key LIKE 'composerData:%'`,
              )
              .all(),
          );
        } else {
          for (let start = 0; start < sessionIds.length; start += SESSION_ID_CHUNK_SIZE) {
            const chunk = sessionIds.slice(start, start + SESSION_ID_CHUNK_SIZE);
            collect(
              db
                .prepare(
                  `SELECT key, ${percentExpression} FROM cursorDiskKV WHERE key IN (${chunk
                    .map(() => "?")
                    .join(", ")})`,
                )
                .all(...chunk.map((sessionId) => `composerData:${sessionId}`)),
            );
          }
        }
      } catch {
        // Table may be missing on older Cursor installs.
      }

      const needsHeaders =
        sessionIds === undefined || sessionIds.some((sessionId) => !index.has(sessionId));
      if (needsHeaders) {
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

  const fromIndex = loadCursorComposerContextUsageIndex({
    ...options,
    sessionIds: [trimmed],
  }).get(trimmed);
  return fromIndex === undefined ? null : { contextUsagePercent: fromIndex };
}
