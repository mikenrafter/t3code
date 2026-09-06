/**
 * Cursor live-quota adapter. Reads Cursor IDE `state.vscdb` (or `cursor-agent`
 * auth.json as fallback) and calls Cursor dashboard usage APIs.
 *
 * Account email is a deliberate exception to that boundary: this module
 * never reads it off local credential files (the CLI's `auth.json` doesn't
 * even carry one). Instead the caller (`LiveQuotaService`) passes in
 * whatever email the *existing* provider-status check already resolved for
 * Cursor — the same value Settings shows — so there's exactly one source of
 * truth for "whose account is this" instead of two that can disagree.
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
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { LiveQuotaAdapter } from "../LiveQuotaService.ts";

const CURSOR_CACHE_TTL_MS = 120_000;
const CURSOR_OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const CURSOR_PERIOD_USAGE_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const CURSOR_USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const CURSOR_OAUTH_TOKEN_URL = "https://api2.cursor.sh/oauth/token";

const CURSOR_AUTH_KEYS = {
  accessToken: "cursorAuth/accessToken",
  refreshToken: "cursorAuth/refreshToken",
} as const;

export interface CursorAuthRecord {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly userId: string;
}

export type CursorAuthReadResult =
  | { readonly status: "missing" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ok"; readonly record: CursorAuthRecord };

const decodeCursorAccessTokenUserId = (accessToken: string): string | null => {
  const payloadSegment = accessToken.split(".")[1];
  if (!payloadSegment) return null;

  try {
    const padded = payloadSegment + "=".repeat((4 - (payloadSegment.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as {
      readonly sub?: unknown;
    };
    const sub = typeof claims.sub === "string" ? claims.sub : "";
    if (sub.length === 0) return null;
    const userId = sub.split("|").at(-1);
    return userId && userId.length > 0 ? userId : null;
  } catch {
    return null;
  }
};

const readCursorAuthRows = (db: NodeSqlite.DatabaseSync) => {
  const statement = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
  const get = (key: string): string | null => {
    const row = statement.get(key) as { readonly value?: unknown } | undefined;
    return typeof row?.value === "string" && row.value.length > 0 ? row.value : null;
  };
  return {
    accessToken: get(CURSOR_AUTH_KEYS.accessToken),
    refreshToken: get(CURSOR_AUTH_KEYS.refreshToken),
  };
};

export const readCursorAuth = (
  dbPath: string,
): Effect.Effect<CursorAuthReadResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem
      .exists(dbPath)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    if (!exists) return { status: "missing" as const };

    const rows = yield* Effect.try({
      try: () => {
        const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
          return readCursorAuthRows(db);
        } finally {
          db.close();
        }
      },
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.catchCause(() => Effect.succeed(null)));

    if (rows === null) {
      return {
        status: "failed" as const,
        message: "Failed to read Cursor's local session database.",
      };
    }
    if (!rows.accessToken) return { status: "missing" as const };

    const userId = decodeCursorAccessTokenUserId(rows.accessToken);
    if (userId === null) return { status: "missing" as const };

    return {
      status: "ok" as const,
      record: {
        accessToken: rows.accessToken,
        refreshToken: rows.refreshToken,
        userId,
      },
    };
  });

const parseCursorCliAuthFile = (
  raw: string,
): { accessToken?: unknown; refreshToken?: unknown } | null => {
  try {
    return JSON.parse(raw) as { accessToken?: unknown; refreshToken?: unknown };
  } catch {
    return null;
  }
};

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
    const accessToken = typeof parsed?.accessToken === "string" ? parsed.accessToken : null;
    if (accessToken === null || accessToken.length === 0) return { status: "missing" as const };

    const userId = decodeCursorAccessTokenUserId(accessToken);
    if (userId === null) return { status: "missing" as const };

    return {
      status: "ok" as const,
      record: {
        accessToken,
        refreshToken: typeof parsed?.refreshToken === "string" ? parsed.refreshToken : null,
        userId,
      },
    };
  });

const cursorCookie = (userId: string, token: string): string =>
  `WorkosCursorSessionToken=${userId}::${token}`;

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

const fetchCursorDashboard = (
  token: string,
  userId: string,
): Effect.Effect<
  {
    readonly periodStatus: number | null;
    readonly periodBody: unknown;
    readonly summaryStatus: number | null;
    readonly summaryBody: unknown;
  },
  never,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const period = yield* executeCursorJsonRequest(
      HttpClientRequest.post(CURSOR_PERIOD_USAGE_URL).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeader("Connect-Protocol-Version", "1"),
        HttpClientRequest.bodyJsonUnsafe({}),
      ),
    );
    const summary = yield* executeCursorJsonRequest(
      HttpClientRequest.get(CURSOR_USAGE_SUMMARY_URL).pipe(
        HttpClientRequest.setHeader("Cookie", cursorCookie(userId, token)),
      ),
    );
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

const formatPercent = (value: number): string => `${Math.round(value * 100) / 100}%`;

const formatResetDescription = (
  resetsAtIso: string | null,
  nowMs: number,
  fallback: string,
): string => {
  if (resetsAtIso === null) return fallback;
  const resetMs = Date.parse(resetsAtIso);
  if (Number.isNaN(resetMs)) return fallback;

  const deltaMs = resetMs - nowMs;
  if (deltaMs <= 0) return "Resets soon";
  if (deltaMs >= 86_400_000) return `Resets in ${Math.round(deltaMs / 86_400_000)}d`;
  const hours = Math.floor(deltaMs / 3_600_000);
  const minutes = Math.floor((deltaMs % 3_600_000) / 60_000);
  return `Resets in ${hours}h ${minutes}m`;
};

export const buildCursorSnapshot = (
  bodies: { readonly period: unknown; readonly summary: unknown },
  email: string | null,
  nowMs: number,
): LiveQuotaSnapshot => {
  const planUsage = pickPath(bodies.period, ["planUsage"]);
  const summaryPlan = pickPath(bodies.summary, ["individualUsage", "plan"]);

  const autoPercent = numberOr(
    pickPath(planUsage, ["autoPercentUsed"]) ?? pickPath(summaryPlan, ["autoPercentUsed"]),
  );
  const apiPercent = numberOr(
    pickPath(planUsage, ["apiPercentUsed"]) ?? pickPath(summaryPlan, ["apiPercentUsed"]),
  );

  const resetsAtRaw = pickPath(bodies.summary, ["billingCycleEnd"]);
  const resetsAt = typeof resetsAtRaw === "string" && resetsAtRaw.length > 0 ? resetsAtRaw : null;
  const resetDescription = formatResetDescription(resetsAt, nowMs, "Billing cycle");

  return {
    provider: "cursor",
    source: "cursor-dashboard-api",
    accountEmail: email,
    primary: {
      usedPercent: autoPercent,
      windowMinutes: null,
      resetsAt,
      resetDescription,
      displayValue: `Auto ${formatPercent(autoPercent)}`,
    },
    secondary: {
      usedPercent: apiPercent,
      windowMinutes: null,
      resetsAt,
      resetDescription: "API / named models",
      displayValue: `API ${formatPercent(apiPercent)}`,
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
 *
 * `email` is passed in by the caller rather than read off `auth` — this
 * module never resolves account email itself, see the module doc.
 */
export const computeCursorResult = (
  auth: CursorAuthRecord,
  email: string | null,
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
          email,
        );
      }

      token = newToken;
      fetchResult = yield* fetchCursorDashboard(token, auth.userId);
      if (fetchResult.periodStatus === 401 || fetchResult.summaryStatus === 401) {
        return unauthenticatedResult("Cursor session expired. Sign into Cursor and retry.", email);
      }
    }

    const periodOk = fetchResult.periodStatus === 200;
    const summaryOk = fetchResult.summaryStatus === 200;
    if (!periodOk && !summaryOk) {
      const status = fetchResult.periodStatus ?? fetchResult.summaryStatus ?? "unknown";
      return failedResult(`Cursor usage request failed (HTTP ${status}).`, email);
    }

    return {
      provider: "cursor",
      status: "ok",
      accountEmail: email,
      snapshot: buildCursorSnapshot(
        { period: fetchResult.periodBody, summary: fetchResult.summaryBody },
        email,
        nowMs,
      ),
    };
  });

/**
 * `resolveAccountEmail` is supplied by the caller (`LiveQuotaService`) and
 * re-read on every cache miss — see the module doc for why this module
 * doesn't resolve email itself.
 */
export const make = (
  resolveAccountEmail: Effect.Effect<string | null>,
): Effect.Effect<
  LiveQuotaAdapter,
  never,
  HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cacheRef = yield* Ref.make<{
      readonly result: LiveQuotaResult;
      readonly fetchedAtMs: number;
    } | null>(null);

    const readSnapshot: LiveQuotaAdapter = () =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const cached = yield* Ref.get(cacheRef);
        if (cached !== null && nowMs - cached.fetchedAtMs < CURSOR_CACHE_TTL_MS) {
          return cached.result;
        }

        const email = yield* resolveAccountEmail;
        const dbPath = path.join(
          NodeOS.homedir(),
          ".config",
          "Cursor",
          "User",
          "globalStorage",
          "state.vscdb",
        );
        const ideAuth = yield* readCursorAuth(dbPath);

        const ideResult: LiveQuotaResult =
          ideAuth.status === "missing"
            ? missingResult()
            : ideAuth.status === "failed"
              ? failedResult(ideAuth.message, email)
              : yield* computeCursorResult(ideAuth.record, email, nowMs);

        const result: LiveQuotaResult =
          ideResult.status === "ok"
            ? ideResult
            : yield* Effect.gen(function* () {
                const cliAuthPath = path.join(NodeOS.homedir(), ".config", "cursor", "auth.json");
                const cliAuth = yield* readCursorCliAuth(cliAuthPath);
                return cliAuth.status === "ok"
                  ? yield* computeCursorResult(cliAuth.record, email, nowMs)
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
