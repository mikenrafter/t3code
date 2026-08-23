/**
 * Cursor live-quota adapter.
 *
 * Direct TS port of the DMS `aiOverviewControl` plugin's `get-cursor-usage`
 * bash+jq script: locates Cursor's local IDE session (its `state.vscdb`
 * SQLite database, the same file the Cursor IDE itself writes to), decodes
 * the stored OAuth access token to find the account's `user_id`, and calls
 * Cursor's own (undocumented) dashboard APIs to read billing-cycle usage.
 *
 * Boundary-crossing note: unlike `CursorDriver.ts`/`CursorAdapter.ts` (which
 * only ever shell out to the `cursor-agent` CLI), this reads Cursor's stored
 * IDE credentials directly and calls undocumented endpoints. That's a
 * deliberate, local-only tradeoff — see the Nix patch header this file ships
 * under for the full rationale.
 *
 * @module CursorLiveQuota
 */
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import type { LiveQuotaResult, LiveQuotaSnapshot } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { LiveQuotaAdapter } from "../LiveQuotaService.ts";

/** Matches `CURSOR_USAGE_CACHE_TTL` in the reference bash script. */
const CURSOR_CACHE_TTL_MS = 120_000;

/** Same public OAuth client id the bash script uses to refresh tokens. */
const CURSOR_OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";

const CURSOR_PERIOD_USAGE_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const CURSOR_USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const CURSOR_PLAN_INFO_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo";
const CURSOR_OAUTH_TOKEN_URL = "https://api2.cursor.sh/oauth/token";

const CURSOR_AUTH_ITEM_KEYS = {
  accessToken: "cursorAuth/accessToken",
  refreshToken: "cursorAuth/refreshToken",
  email: "cursorAuth/cachedEmail",
  membership: "cursorAuth/stripeMembershipType",
} as const;

/** Resolves Cursor's IDE session database, defaulting to the process home. */
export const resolveCursorStateDbPath = (
  homeDir: string = NodeOS.homedir(),
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
  });

/**
 * Decodes the (unverified) JWT payload of a Cursor access token to pull the
 * account's `user_id` out of the `sub` claim — same base64url decode the
 * bash script's inline Python does. Returns `null` for anything that isn't a
 * well-formed, decodable JWT with a non-empty `sub`, so callers can treat a
 * malformed token the same as "no token" rather than throwing.
 */
export const decodeCursorAccessTokenUserId = (accessToken: string): string | null => {
  const parts = accessToken.split(".");
  const payloadSegment = parts[1];
  if (parts.length < 2 || !payloadSegment) return null;

  try {
    const padded = payloadSegment + "=".repeat((4 - (payloadSegment.length % 4)) % 4);
    const json = Buffer.from(padded, "base64url").toString("utf8");
    const claims = JSON.parse(json) as { readonly sub?: unknown };
    const sub = typeof claims.sub === "string" ? claims.sub : "";
    if (sub.length === 0) return null;

    const segments = sub.split("|");
    const userId = segments[segments.length - 1];
    return userId && userId.length > 0 ? userId : null;
  } catch {
    return null;
  }
};

export interface CursorAuthRecord {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly email: string | null;
  readonly membership: string | null;
  readonly userId: string;
}

export type CursorAuthReadResult =
  | { readonly status: "missing" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ok"; readonly record: CursorAuthRecord };

const isSqliteBusyError = (cause: unknown): boolean =>
  cause instanceof Error && /SQLITE_BUSY/i.test(cause.message);

const defaultOpenCursorStateDb = (dbPath: string): NodeSqlite.DatabaseSync =>
  new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });

interface CursorAuthRawRows {
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly email: string | null;
  readonly membership: string | null;
}

interface CursorAuthOpenError {
  readonly busy: boolean;
  readonly message: string;
}

const readCursorAuthRows = (db: NodeSqlite.DatabaseSync): CursorAuthRawRows => {
  const statement = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
  const get = (key: string): string | null => {
    const row = statement.get(key) as { readonly value?: unknown } | undefined;
    return typeof row?.value === "string" && row.value.length > 0 ? row.value : null;
  };
  return {
    accessToken: get(CURSOR_AUTH_ITEM_KEYS.accessToken),
    refreshToken: get(CURSOR_AUTH_ITEM_KEYS.refreshToken),
    email: get(CURSOR_AUTH_ITEM_KEYS.email),
    membership: get(CURSOR_AUTH_ITEM_KEYS.membership),
  };
};

const openAndReadCursorAuthRows = (
  dbPath: string,
  openDatabase: (path: string) => NodeSqlite.DatabaseSync,
): Effect.Effect<CursorAuthRawRows, CursorAuthOpenError> =>
  Effect.try({
    try: () => {
      const db = openDatabase(dbPath);
      try {
        return readCursorAuthRows(db);
      } finally {
        db.close();
      }
    },
    catch: (cause): CursorAuthOpenError => ({
      busy: isSqliteBusyError(cause),
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  });

/**
 * Reads Cursor's stored OAuth session from `state.vscdb`.
 *
 * `state.vscdb` is a WAL-mode database the Cursor IDE may be writing to
 * concurrently, so a `SQLITE_BUSY` open/read can legitimately happen — this
 * retries once after a short delay before giving up as `"failed"`.
 * `openDatabase` is overridable so tests can simulate a busy database
 * without real file-level lock contention.
 */
export const readCursorAuth = (
  dbPath: string,
  openDatabase: (path: string) => NodeSqlite.DatabaseSync = defaultOpenCursorStateDb,
): Effect.Effect<CursorAuthReadResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem
      .exists(dbPath)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    if (!exists) return { status: "missing" as const };

    let attempt = yield* Effect.result(openAndReadCursorAuthRows(dbPath, openDatabase));
    if (Result.isFailure(attempt) && attempt.failure.busy) {
      yield* Effect.sleep("200 millis");
      attempt = yield* Effect.result(openAndReadCursorAuthRows(dbPath, openDatabase));
    }

    if (Result.isFailure(attempt)) {
      return {
        status: "failed" as const,
        message: `Failed to read Cursor's local session database: ${attempt.failure.message}`,
      };
    }

    const rows = attempt.success;
    if (!rows.accessToken) return { status: "missing" as const };

    const userId = decodeCursorAccessTokenUserId(rows.accessToken);
    if (userId === null) return { status: "missing" as const };

    return {
      status: "ok" as const,
      record: {
        accessToken: rows.accessToken,
        refreshToken: rows.refreshToken,
        email: rows.email,
        membership: rows.membership,
        userId,
      },
    };
  });

/**
 * `cursor-agent`'s own auth store — separate from the Cursor IDE's
 * `state.vscdb`. A user who only runs the CLI (never opens the IDE) has a
 * live session only here; a user who only uses the IDE has one only in
 * `state.vscdb`. Checked as a fallback, not primary, matching the reference
 * script's IDE-first precedent and avoiding an extra file read plus a
 * duplicate set of dashboard calls when the IDE session already works.
 */
export const resolveCursorCliAuthPath = (
  homeDir: string = NodeOS.homedir(),
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(homeDir, ".config", "cursor", "auth.json");
  });

interface CursorCliAuthFile {
  readonly accessToken?: unknown;
  readonly refreshToken?: unknown;
}

const parseCursorCliAuthFile = (raw: string): CursorCliAuthFile | null => {
  try {
    return JSON.parse(raw) as CursorCliAuthFile;
  } catch {
    return null;
  }
};

/**
 * Reads `cursor-agent`'s `auth.json`. Unlike `state.vscdb`'s `ItemTable`,
 * this file carries no email/membership fields — both are `null` on the
 * resulting record, and the UI already renders a `null` email as "No
 * account".
 */
export const readCursorCliAuth = (
  authPath: string,
): Effect.Effect<CursorAuthReadResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem
      .readFileString(authPath)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (raw === null) return { status: "missing" as const };

    const parsed = parseCursorCliAuthFile(raw);
    if (parsed === null) return { status: "missing" as const };

    const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken : null;
    if (accessToken === null || accessToken.length === 0) return { status: "missing" as const };

    const userId = decodeCursorAccessTokenUserId(accessToken);
    if (userId === null) return { status: "missing" as const };

    const refreshToken = typeof parsed.refreshToken === "string" ? parsed.refreshToken : null;

    return {
      status: "ok" as const,
      record: { accessToken, refreshToken, email: null, membership: null, userId },
    };
  });

const cursorCookie = (userId: string, token: string): string =>
  `WorkosCursorSessionToken=${userId}::${token}`;

const dashboardRequest = (url: string, token: string) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.setHeader("Connect-Protocol-Version", "1"),
    HttpClientRequest.bodyJsonUnsafe({}),
  );

const summaryRequest = (userId: string, token: string) =>
  HttpClientRequest.get(CURSOR_USAGE_SUMMARY_URL).pipe(
    HttpClientRequest.setHeader("Cookie", cursorCookie(userId, token)),
  );

interface CursorDashboardFetch {
  readonly periodStatus: number | null;
  readonly periodBody: unknown;
  readonly summaryStatus: number | null;
  readonly summaryBody: unknown;
}

const executeCursorJsonRequest = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<
  { readonly status: number | null; readonly body: unknown },
  never,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return yield* httpClient.execute(request).pipe(
      Effect.flatMap((response) =>
        response.json.pipe(
          Effect.catchCause(() => Effect.succeed(null)),
          Effect.map((body) => ({ status: response.status, body })),
        ),
      ),
      Effect.catchCause(() => Effect.succeed({ status: null, body: null })),
    );
  });

/** Also fires `GetPlanInfo`, but that response is best-effort only (unused
 * by the current mapping, mirroring `plan`'s minor role in the bash script)
 * so its failure never affects the period/summary-driven result below. */
const fetchCursorDashboard = (
  token: string,
  userId: string,
): Effect.Effect<CursorDashboardFetch, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const period = yield* executeCursorJsonRequest(
      dashboardRequest(CURSOR_PERIOD_USAGE_URL, token),
    );
    const summary = yield* executeCursorJsonRequest(summaryRequest(userId, token));
    yield* executeCursorJsonRequest(dashboardRequest(CURSOR_PLAN_INFO_URL, token));

    return {
      periodStatus: period.status,
      periodBody: period.body,
      summaryStatus: summary.status,
      summaryBody: summary.body,
    };
  });

const refreshCursorAccessToken = (
  refreshToken: string,
): Effect.Effect<string | null, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const outcome = yield* httpClient
      .execute(
        HttpClientRequest.post(CURSOR_OAUTH_TOKEN_URL).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            grant_type: "refresh_token",
            client_id: CURSOR_OAUTH_CLIENT_ID,
            refresh_token: refreshToken,
          }),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.status !== 200
            ? Effect.succeed(null)
            : response.json.pipe(Effect.catchCause(() => Effect.succeed(null))),
        ),
        Effect.catchCause(() => Effect.succeed(null)),
      );

    if (outcome === null || typeof outcome !== "object") return null;
    const accessToken = (outcome as Record<string, unknown>).access_token;
    return typeof accessToken === "string" && accessToken.length > 0 ? accessToken : null;
  });

const numberOr = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const pickPath = (source: unknown, keys: ReadonlyArray<string>): unknown => {
  let current = source;
  for (const key of keys) {
    if (
      current !== null &&
      typeof current === "object" &&
      key in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
};

const formatCursorPercent = (value: number): string => `${Math.round(value * 100) / 100}%`;

const formatCursorResetDescription = (resetsAtIso: string | null, nowMs: number): string => {
  if (resetsAtIso === null) return "Billing cycle";
  const resetMs = Date.parse(resetsAtIso);
  if (Number.isNaN(resetMs)) return "Billing cycle";

  const deltaMs = resetMs - nowMs;
  if (deltaMs <= 0) return "Resets soon";
  const days = Math.floor(deltaMs / 86_400_000);
  if (days > 0) return `Resets in ${days}d`;
  const hours = Math.floor(deltaMs / 3_600_000);
  if (hours > 0) return `Resets in ${hours}h`;
  const minutes = Math.max(1, Math.floor(deltaMs / 60_000));
  return `Resets in ${minutes}m`;
};

interface CursorUsageBodies {
  readonly period: unknown;
  readonly summary: unknown;
}

/** Same three-slot split as the bash script's `jq` block. */
export const buildCursorSnapshot = (
  bodies: CursorUsageBodies,
  email: string | null,
  nowMs: number,
): LiveQuotaSnapshot => {
  const planUsage = pickPath(bodies.period, ["planUsage"]);
  const summaryPlan = pickPath(bodies.summary, ["individualUsage", "plan"]);

  const totalPercent = numberOr(
    pickPath(planUsage, ["totalPercentUsed"]) ?? pickPath(summaryPlan, ["totalPercentUsed"]),
  );
  const autoPercent = numberOr(
    pickPath(planUsage, ["autoPercentUsed"]) ?? pickPath(summaryPlan, ["autoPercentUsed"]),
  );
  const apiPercent = numberOr(
    pickPath(planUsage, ["apiPercentUsed"]) ?? pickPath(summaryPlan, ["apiPercentUsed"]),
  );

  const resetsAtRaw = pickPath(bodies.summary, ["billingCycleEnd"]);
  const resetsAt = typeof resetsAtRaw === "string" && resetsAtRaw.length > 0 ? resetsAtRaw : null;
  const resetDescription = formatCursorResetDescription(resetsAt, nowMs);

  return {
    provider: "cursor",
    source: "cursor-dashboard-api",
    accountEmail: email,
    primary: {
      usedPercent: totalPercent,
      windowMinutes: null,
      resetsAt,
      resetDescription,
      displayValue: formatCursorPercent(totalPercent),
    },
    secondary: {
      usedPercent: autoPercent,
      windowMinutes: null,
      resetsAt,
      resetDescription: "Auto + Composer",
      displayValue: `Auto ${formatCursorPercent(autoPercent)}`,
    },
    tertiary: {
      usedPercent: apiPercent,
      windowMinutes: null,
      resetsAt,
      resetDescription: "API / named models",
      displayValue: `API ${formatCursorPercent(apiPercent)}`,
    },
    updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
  };
};

const missingResult = (): LiveQuotaResult => ({
  provider: "cursor",
  status: "missing",
  accountEmail: null,
});

const failedResult = (message: string, email: string | null = null): LiveQuotaResult => ({
  provider: "cursor",
  status: "failed",
  accountEmail: email,
  message,
});

const unauthenticatedResult = (message: string, email: string | null): LiveQuotaResult => ({
  provider: "cursor",
  status: "unauthenticated",
  accountEmail: email,
  message,
});

/**
 * Runs the dashboard calls for an already-decoded Cursor session, retrying
 * once via OAuth refresh on a 401 before giving up as `"unauthenticated"`.
 */
export const computeCursorResult = (
  auth: CursorAuthRecord,
  nowMs: number,
): Effect.Effect<LiveQuotaResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    let token = auth.accessToken;
    let fetchResult = yield* fetchCursorDashboard(token, auth.userId);

    if (fetchResult.periodStatus === 401 || fetchResult.summaryStatus === 401) {
      const newToken = auth.refreshToken
        ? yield* refreshCursorAccessToken(auth.refreshToken)
        : null;
      if (newToken === null) {
        return unauthenticatedResult(
          "Cursor session expired and refresh failed. Sign into Cursor and retry.",
          auth.email,
        );
      }

      token = newToken;
      fetchResult = yield* fetchCursorDashboard(token, auth.userId);
      if (fetchResult.periodStatus === 401 || fetchResult.summaryStatus === 401) {
        return unauthenticatedResult(
          "Cursor session expired. Sign into Cursor and retry.",
          auth.email,
        );
      }
    }

    const periodOk = fetchResult.periodStatus === 200;
    const summaryOk = fetchResult.summaryStatus === 200;
    if (!periodOk && !summaryOk) {
      const status = fetchResult.periodStatus ?? fetchResult.summaryStatus ?? "unknown";
      return failedResult(`Cursor usage request failed (HTTP ${status}).`, auth.email);
    }

    const snapshot = buildCursorSnapshot(
      { period: fetchResult.periodBody, summary: fetchResult.summaryBody },
      auth.email,
      nowMs,
    );

    return {
      provider: "cursor",
      status: "ok",
      accountEmail: auth.email,
      snapshot,
    };
  });

interface CursorCacheEntry {
  readonly result: LiveQuotaResult;
  readonly fetchedAtMs: number;
}

/**
 * Builds the Cursor live-quota adapter: a closure with its own 120s TTL
 * cache (matching `CURSOR_USAGE_CACHE_TTL` in the reference script), fully
 * resolved against `HttpClient`/`FileSystem` at construction time so the
 * returned thunk itself needs no ambient context (matches
 * `LiveQuotaAdapter`'s `Effect.Effect<LiveQuotaResult>`, R = never).
 */
export const make: Effect.Effect<
  LiveQuotaAdapter,
  never,
  HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cacheRef = yield* Ref.make<CursorCacheEntry | null>(null);

  const readSnapshot: LiveQuotaAdapter = () =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const cached = yield* Ref.get(cacheRef);
      if (cached !== null && nowMs - cached.fetchedAtMs < CURSOR_CACHE_TTL_MS) {
        return cached.result;
      }

      const dbPath = yield* resolveCursorStateDbPath();
      const ideAuth = yield* readCursorAuth(dbPath);

      const ideResult: LiveQuotaResult =
        ideAuth.status === "missing"
          ? missingResult()
          : ideAuth.status === "failed"
            ? failedResult(ideAuth.message)
            : yield* computeCursorResult(ideAuth.record, nowMs);

      // A real "ok" from the IDE session always wins without touching the
      // CLI auth file at all; only fall back when the IDE gave us nothing
      // usable (never signed in, a stale/expired session, or a local read
      // failure), since the two sessions can go stale independently of each
      // other.
      const result: LiveQuotaResult =
        ideResult.status === "ok"
          ? ideResult
          : yield* Effect.gen(function* () {
              const cliAuthPath = yield* resolveCursorCliAuthPath();
              const cliAuth = yield* readCursorCliAuth(cliAuthPath);
              return cliAuth.status === "ok"
                ? yield* computeCursorResult(cliAuth.record, nowMs)
                : ideResult;
            });

      yield* Ref.set(cacheRef, { result, fetchedAtMs: nowMs });
      return result;
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(Path.Path, path),
    );

  return readSnapshot;
});
