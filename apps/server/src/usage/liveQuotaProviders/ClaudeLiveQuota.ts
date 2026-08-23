/**
 * Claude live-quota adapter.
 *
 * Port of the DMS `aiOverviewControl` plugin's `get-claude-usage`'s OAuth
 * section: reads Claude Code's own stored OAuth credentials and calls
 * Anthropic's rolling-window rate-limit endpoint
 * (`api.anthropic.com/api/oauth/usage`), giving the `windowMinutes` field in
 * the live-quota contract a real, populated example (Claude's 5h/7d windows;
 * Cursor's billing-cycle usage has none).
 *
 * Deliberately **no refresh-token path**, unlike Cursor: `.credentials.json`
 * also holds a refresh token, but spending it here risks rotating/
 * invalidating Claude Code's own active CLI session out from under the user
 * for the sake of a read-only usage widget. A 401/403 maps straight to
 * `status: "unauthenticated"` — do not add a refresh call here.
 *
 * @module ClaudeLiveQuota
 */
import * as NodeOS from "node:os";

import type { LiveQuotaResult, LiveQuotaSnapshot } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { resolveClaudeHomePath } from "../../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../../serverSettings.ts";
import type { LiveQuotaAdapter } from "../LiveQuotaService.ts";

/** Same TTL cache pattern as Cursor's adapter. */
const CLAUDE_CACHE_TTL_MS = 120_000;

const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const FIVE_HOUR_WINDOW_MINUTES = 300;
const SEVEN_DAY_WINDOW_MINUTES = 10_080;

/**
 * `~/.claude.json` — a sibling of the Claude home directory, not inside it,
 * and NOT affected by `CLAUDE_CONFIG_DIR`/`resolveClaudeHomePath` overrides
 * the same way `.credentials.json` is. Resolved off `NodeOS.homedir()`
 * directly, matching the plan's explicit call-out that this is a different
 * resolution path than the credentials file.
 */
export const resolveClaudeAccountConfigPath = (
  homeDir: string = NodeOS.homedir(),
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(homeDir, ".claude.json");
  });

const ClaudeAccountConfigFileSchema = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({
      emailAddress: Schema.optional(Schema.String),
    }),
  ),
});
const decodeClaudeAccountConfigFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    ClaudeAccountConfigFileSchema as unknown as Schema.Codec<
      typeof ClaudeAccountConfigFileSchema.Type
    >,
  ),
);

/**
 * Best-effort account email lookup. Absent file/field is a real, expected
 * case (not every install has this file, or it may lack `oauthAccount`) —
 * this must never fail, only resolve to `null`.
 */
export const readClaudeAccountEmail = (
  claudeJsonPath: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem
      .readFileString(claudeJsonPath)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (raw === null) return null;

    const parsed = yield* decodeClaudeAccountConfigFile(raw).pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    const email = parsed?.oauthAccount?.emailAddress?.trim();
    return email && email.length > 0 ? email : null;
  });

export type ClaudeCredentialsReadResult =
  | { readonly status: "missing" }
  | { readonly status: "ok"; readonly accessToken: string };

const ClaudeCredentialsFileSchema = Schema.Struct({
  claudeAiOauth: Schema.optional(
    Schema.Struct({
      accessToken: Schema.optional(Schema.String),
    }),
  ),
});
const decodeClaudeCredentialsFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    ClaudeCredentialsFileSchema as unknown as Schema.Codec<typeof ClaudeCredentialsFileSchema.Type>,
  ),
);

/** Missing file or empty token both read as `"missing"` — no auth attempt was even possible. */
export const readClaudeAccessToken = (
  credentialsPath: string,
): Effect.Effect<ClaudeCredentialsReadResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem
      .readFileString(credentialsPath)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (raw === null) return { status: "missing" as const };

    const parsed = yield* decodeClaudeCredentialsFile(raw).pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    const accessToken = parsed?.claudeAiOauth?.accessToken;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      return { status: "missing" as const };
    }
    return { status: "ok" as const, accessToken };
  });

const numberOr = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const formatClaudePercent = (value: number): string => `${Math.round(value * 100) / 100}%`;

const formatClaudeResetDescription = (resetsAtIso: string | null, nowMs: number): string => {
  if (resetsAtIso === null) return "No active window";
  const resetMs = Date.parse(resetsAtIso);
  if (Number.isNaN(resetMs)) return "No active window";

  const deltaMs = resetMs - nowMs;
  if (deltaMs <= 0) return "Resets soon";
  const days = Math.floor(deltaMs / 86_400_000);
  if (days > 0) return `Resets in ${days}d`;
  const hours = Math.floor(deltaMs / 3_600_000);
  if (hours > 0) return `Resets in ${hours}h`;
  const minutes = Math.max(1, Math.floor(deltaMs / 60_000));
  return `Resets in ${minutes}m`;
};

interface ClaudeUsageBody {
  readonly five_hour?: { readonly utilization?: unknown; readonly resets_at?: unknown };
  readonly seven_day?: { readonly utilization?: unknown; readonly resets_at?: unknown };
}

/** `primary` = five_hour (300min window), `secondary` = seven_day (10080min window). */
export const buildClaudeSnapshot = (
  body: ClaudeUsageBody,
  email: string | null,
  nowMs: number,
): LiveQuotaSnapshot => {
  const fiveHourPercent = numberOr(body.five_hour?.utilization);
  const fiveHourResetsAt = stringOrNull(body.five_hour?.resets_at);
  const sevenDayPercent = numberOr(body.seven_day?.utilization);
  const sevenDayResetsAt = stringOrNull(body.seven_day?.resets_at);

  return {
    provider: "claude",
    source: "anthropic-oauth-usage",
    accountEmail: email,
    primary: {
      usedPercent: fiveHourPercent,
      windowMinutes: FIVE_HOUR_WINDOW_MINUTES,
      resetsAt: fiveHourResetsAt,
      resetDescription: formatClaudeResetDescription(fiveHourResetsAt, nowMs),
      displayValue: formatClaudePercent(fiveHourPercent),
    },
    secondary: {
      usedPercent: sevenDayPercent,
      windowMinutes: SEVEN_DAY_WINDOW_MINUTES,
      resetsAt: sevenDayResetsAt,
      resetDescription: formatClaudeResetDescription(sevenDayResetsAt, nowMs),
      displayValue: formatClaudePercent(sevenDayPercent),
    },
    updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
  };
};

const missingResult = (): LiveQuotaResult => ({
  provider: "claude",
  status: "missing",
  accountEmail: null,
});

const failedResult = (message: string, email: string | null = null): LiveQuotaResult => ({
  provider: "claude",
  status: "failed",
  accountEmail: email,
  message,
});

const unauthenticatedResult = (message: string, email: string | null): LiveQuotaResult => ({
  provider: "claude",
  status: "unauthenticated",
  accountEmail: email,
  message,
});

/**
 * Calls Anthropic's OAuth usage endpoint for an already-resolved access
 * token. No refresh-token path — see the module doc comment.
 */
export const fetchClaudeUsage = (
  accessToken: string,
  email: string | null,
  nowMs: number,
): Effect.Effect<LiveQuotaResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(CLAUDE_OAUTH_USAGE_URL).pipe(
      HttpClientRequest.bearerToken(accessToken),
      HttpClientRequest.setHeader("anthropic-beta", "oauth-2025-04-20"),
    );

    const outcome = yield* httpClient.execute(request).pipe(
      Effect.flatMap((response) =>
        response.json.pipe(
          Effect.catchCause(() => Effect.succeed(null)),
          Effect.map((body) => ({ status: response.status, body })),
        ),
      ),
      Effect.catchCause(() =>
        Effect.succeed({ status: null as number | null, body: null as unknown }),
      ),
    );

    if (outcome.status === 401 || outcome.status === 403) {
      return unauthenticatedResult(
        "Claude OAuth credentials are invalid or expired. Run: claude auth login --claudeai",
        email,
      );
    }

    if (outcome.status !== 200 || outcome.body === null || typeof outcome.body !== "object") {
      return failedResult(
        `Claude usage request failed (HTTP ${outcome.status ?? "unknown"}).`,
        email,
      );
    }

    const snapshot = buildClaudeSnapshot(outcome.body as ClaudeUsageBody, email, nowMs);
    return {
      provider: "claude",
      status: "ok",
      accountEmail: email,
      snapshot,
    };
  });

interface ClaudeCacheEntry {
  readonly result: LiveQuotaResult;
  readonly fetchedAtMs: number;
}

/**
 * Builds the Claude live-quota adapter: a closure with its own 120s TTL
 * cache, fully resolved against its dependencies at construction time so
 * the returned thunk itself needs no ambient context (R = never), matching
 * `LiveQuotaAdapter`.
 */
export const make: Effect.Effect<
  LiveQuotaAdapter,
  never,
  HttpClient.HttpClient | FileSystem.FileSystem | Path.Path | ServerSettings.ServerSettingsService
> = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const cacheRef = yield* Ref.make<ClaudeCacheEntry | null>(null);

  const readSnapshot: LiveQuotaAdapter = () =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const cached = yield* Ref.get(cacheRef);
      if (cached !== null && nowMs - cached.fetchedAtMs < CLAUDE_CACHE_TTL_MS) {
        return cached.result;
      }

      // A settings read failure must not crash the whole live-quota RPC —
      // it degrades to "failed" for this one provider, same "partial
      // coverage over hard failure" philosophy as the rest of this feature.
      const settings = yield* Effect.result(settingsService.getSettings);
      const result: LiveQuotaResult = yield* Result.isFailure(settings)
        ? Effect.succeed(failedResult("Server settings could not be read."))
        : Effect.gen(function* () {
            const claudeHome = yield* resolveClaudeHomePath(settings.success.providers.claudeAgent);
            const credentialsPath = path.join(claudeHome, ".credentials.json");
            const accountConfigPath = yield* resolveClaudeAccountConfigPath();

            const credentials = yield* readClaudeAccessToken(credentialsPath);
            if (credentials.status === "missing") return missingResult();

            const email = yield* readClaudeAccountEmail(accountConfigPath);
            return yield* fetchClaudeUsage(credentials.accessToken, email, nowMs);
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
