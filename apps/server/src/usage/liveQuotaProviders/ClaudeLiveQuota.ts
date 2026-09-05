/**
 * Claude live-quota adapter. Reads Claude Code OAuth credentials and calls
 * Anthropic's rolling-window usage endpoint. No refresh-token path here.
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
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { resolveClaudeHomePath } from "../../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../../serverSettings.ts";
import type { LiveQuotaAdapter } from "../LiveQuotaService.ts";

const CLAUDE_CACHE_TTL_MS = 120_000;
const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const FIVE_HOUR_WINDOW_MINUTES = 300;
const SEVEN_DAY_WINDOW_MINUTES = 10_080;

export type ClaudeCredentialsReadResult =
  | { readonly status: "missing" }
  | { readonly status: "ok"; readonly accessToken: string };

const parseJsonObject = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export const readClaudeAccessToken = (
  credentialsPath: string,
): Effect.Effect<ClaudeCredentialsReadResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem
      .readFileString(credentialsPath)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (raw === null) return { status: "missing" as const };

    const parsed = parseJsonObject(raw);
    const oauth = parsed?.claudeAiOauth;
    const accessToken =
      oauth !== null && typeof oauth === "object"
        ? (oauth as Record<string, unknown>).accessToken
        : undefined;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      return { status: "missing" as const };
    }
    return { status: "ok" as const, accessToken };
  });

export const readClaudeAccountEmail = (
  claudeJsonPath: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem
      .readFileString(claudeJsonPath)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (raw === null) return null;

    const parsed = parseJsonObject(raw);
    const oauthAccount = parsed?.oauthAccount;
    const email =
      oauthAccount !== null && typeof oauthAccount === "object"
        ? (oauthAccount as Record<string, unknown>).emailAddress
        : undefined;
    const trimmed = typeof email === "string" ? email.trim() : "";
    return trimmed.length > 0 ? trimmed : null;
  });

export const resolveClaudeCredentialsPath = (
  claudeHome: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const nested = path.join(claudeHome, ".claude", ".credentials.json");
    const nestedExists = yield* fileSystem
      .exists(nested)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    return nestedExists ? nested : path.join(claudeHome, ".credentials.json");
  });

const numberOr = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const formatPercent = (value: number): string => `${Math.round(value * 100) / 100}%`;

const formatResetDescription = (resetsAtIso: string | null, nowMs: number): string => {
  if (resetsAtIso === null) return "No active window";
  const resetMs = Date.parse(resetsAtIso);
  if (Number.isNaN(resetMs)) return "No active window";

  const deltaMs = resetMs - nowMs;
  if (deltaMs <= 0) return "Resets soon";
  const days = Math.floor(deltaMs / 86_400_000);
  if (days > 0) return `Resets in ${days}d`;
  const hours = Math.floor(deltaMs / 3_600_000);
  const minutes = Math.floor((deltaMs % 3_600_000) / 60_000);
  if (hours > 0) {
    return minutes > 0 ? `Resets in ${hours}h ${minutes}m` : `Resets in ${hours}h`;
  }
  return `Resets in ${Math.max(1, minutes)}m`;
};

interface ClaudeUsageBody {
  readonly five_hour?: { readonly utilization?: unknown; readonly resets_at?: unknown };
  readonly seven_day?: { readonly utilization?: unknown; readonly resets_at?: unknown };
}

export const buildClaudeSnapshot = (
  body: ClaudeUsageBody,
  email: string | null,
  nowMs: number,
): LiveQuotaSnapshot => {
  const fiveHourResetsAt = stringOrNull(body.five_hour?.resets_at);
  const sevenDayResetsAt = stringOrNull(body.seven_day?.resets_at);

  return {
    provider: "claude",
    source: "anthropic-oauth-usage",
    accountEmail: email,
    primary: {
      usedPercent: numberOr(body.five_hour?.utilization),
      windowMinutes: FIVE_HOUR_WINDOW_MINUTES,
      resetsAt: fiveHourResetsAt,
      resetDescription: formatResetDescription(fiveHourResetsAt, nowMs),
      displayValue: formatPercent(numberOr(body.five_hour?.utilization)),
    },
    secondary: {
      usedPercent: numberOr(body.seven_day?.utilization),
      windowMinutes: SEVEN_DAY_WINDOW_MINUTES,
      resetsAt: sevenDayResetsAt,
      resetDescription: formatResetDescription(sevenDayResetsAt, nowMs),
      displayValue: formatPercent(numberOr(body.seven_day?.utilization)),
    },
    updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
  };
};

export const fetchClaudeUsage = (
  accessToken: string,
  email: string | null,
  nowMs: number,
): Effect.Effect<LiveQuotaResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const outcome = yield* httpClient
      .execute(
        HttpClientRequest.get(CLAUDE_OAUTH_USAGE_URL).pipe(
          HttpClientRequest.bearerToken(accessToken),
          HttpClientRequest.setHeader("anthropic-beta", "oauth-2025-04-20"),
        ),
      )
      .pipe(
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
      return {
        provider: "claude",
        status: "unauthenticated",
        accountEmail: email,
        message:
          "Claude OAuth credentials are invalid or expired. Run: claude auth login --claudeai",
      };
    }

    if (outcome.status !== 200 || outcome.body === null || typeof outcome.body !== "object") {
      return {
        provider: "claude",
        status: "failed",
        accountEmail: email,
        message: `Claude usage request failed (HTTP ${outcome.status ?? "unknown"}).`,
      };
    }

    return {
      provider: "claude",
      status: "ok",
      accountEmail: email,
      snapshot: buildClaudeSnapshot(outcome.body as ClaudeUsageBody, email, nowMs),
    };
  });

export const make: Effect.Effect<
  LiveQuotaAdapter,
  never,
  HttpClient.HttpClient | FileSystem.FileSystem | Path.Path | ServerSettings.ServerSettingsService
> = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const cacheRef = yield* Ref.make<{
    readonly result: LiveQuotaResult;
    readonly fetchedAtMs: number;
  } | null>(null);

  const readSnapshot: LiveQuotaAdapter = () =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const cached = yield* Ref.get(cacheRef);
      if (cached !== null && nowMs - cached.fetchedAtMs < CLAUDE_CACHE_TTL_MS) {
        return cached.result;
      }

      const settings = yield* Effect.result(settingsService.getSettings);
      const result: LiveQuotaResult = yield* Result.isFailure(settings)
        ? Effect.succeed({
            provider: "claude",
            status: "failed",
            accountEmail: null,
            message: "Server settings could not be read.",
          })
        : Effect.gen(function* () {
            const claudeHome = yield* resolveClaudeHomePath(settings.success.providers.claudeAgent);
            const credentialsPath = yield* resolveClaudeCredentialsPath(claudeHome);
            const accountConfigPath = path.join(NodeOS.homedir(), ".claude.json");

            const credentials = yield* readClaudeAccessToken(credentialsPath);
            if (credentials.status === "missing") {
              return { provider: "claude", status: "missing", accountEmail: null };
            }

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
