/** OpenAI live-quota adapter, backed by Codex app-server's rate-limit RPC. */
import type { LiveQuotaResult, LiveQuotaSnapshot, LiveQuotaSlot } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Duration from "effect/Duration";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { resolveCodexLaunchArgs } from "../../provider/Layers/codexLaunchArgs.ts";
import { requestCodexRateLimits } from "../../provider/Layers/CodexProvider.ts";
import * as ServerSettings from "../../serverSettings.ts";
import type { LiveQuotaAdapter } from "../LiveQuotaService.ts";

const OPENAI_CACHE_TTL_MS = 120_000;
const FIVE_HOUR_WINDOW_MINUTES = 300;
const SEVEN_DAY_WINDOW_MINUTES = 10_080;

type RateLimitWindow = CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow;

const resetTimeMs = (value: number | null | undefined): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value < 1_000_000_000_000 ? value * 1_000 : value;
};

const formatResetDescription = (resetsAt: number | null, nowMs: number): string => {
  if (resetsAt === null) return "No active window";
  const remaining = resetsAt - nowMs;
  if (remaining <= 0) return "Resets soon";
  if (remaining >= 86_400_000) return `Resets in ${Math.round(remaining / 86_400_000)}d`;
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return `Resets in ${hours}h ${minutes}m`;
};

const buildSlot = (
  window: RateLimitWindow | null | undefined,
  fallbackMinutes: number,
  nowMs: number,
): LiveQuotaSlot => {
  const resetsAtMs = resetTimeMs(window?.resetsAt);
  const usedPercent = window?.usedPercent ?? 0;
  return {
    usedPercent,
    windowMinutes: window?.windowDurationMins ?? fallbackMinutes,
    resetsAt: resetsAtMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(resetsAtMs)),
    resetDescription: formatResetDescription(resetsAtMs, nowMs),
    displayValue: `${Math.round(usedPercent * 100) / 100}%`,
  };
};

export const buildOpenAiSnapshot = (
  rateLimits: CodexSchema.V2GetAccountRateLimitsResponse,
  email: string | null,
  nowMs: number,
): LiveQuotaSnapshot => ({
  provider: "openai",
  source: "codex-app-server",
  accountEmail: email,
  primary: buildSlot(rateLimits.rateLimits.primary, FIVE_HOUR_WINDOW_MINUTES, nowMs),
  secondary: buildSlot(rateLimits.rateLimits.secondary, SEVEN_DAY_WINDOW_MINUTES, nowMs),
  updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
});

const missingResult = (): LiveQuotaResult => ({
  provider: "openai",
  status: "missing",
  accountEmail: null,
});
const unauthenticatedResult = (): LiveQuotaResult => ({
  provider: "openai",
  status: "unauthenticated",
  accountEmail: null,
  message: "Codex is not authenticated. Run: codex login",
});
const failedResult = (message: string, email: string | null = null): LiveQuotaResult => ({
  provider: "openai",
  status: "failed",
  accountEmail: email,
  message,
});

interface CacheEntry {
  readonly fetchedAtMs: number;
  readonly result: LiveQuotaResult;
}

export const make: Effect.Effect<
  LiveQuotaAdapter,
  never,
  ServerSettings.ServerSettingsService | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cacheRef = yield* Ref.make<CacheEntry | null>(null);

  return () =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const cached = yield* Ref.get(cacheRef);
      if (cached !== null && nowMs - cached.fetchedAtMs < OPENAI_CACHE_TTL_MS) return cached.result;

      const settings = yield* Effect.result(settingsService.getSettings);
      const result: LiveQuotaResult = yield* Result.isFailure(settings)
        ? Effect.succeed(failedResult("Server settings could not be read."))
        : Effect.gen(function* () {
            const codex = settings.success.providers.codex;
            if (!codex.enabled) return missingResult();
            const response = yield* requestCodexRateLimits({
              binaryPath: codex.binaryPath,
              homePath: codex.shadowHomePath || codex.homePath || undefined,
              launchArgs: resolveCodexLaunchArgs(codex.launchArgs, process.env),
              cwd: process.cwd(),
              environment: process.env,
            }).pipe(Effect.scoped, Effect.timeout(Duration.seconds(10)), Effect.result);
            if (Result.isFailure(response))
              return failedResult("Could not read Codex rate limits.");
            if (!response.success.account.account && response.success.account.requiresOpenaiAuth) {
              return unauthenticatedResult();
            }
            const account = response.success.account.account;
            const email = account?.type === "chatgpt" ? account.email : null;
            return {
              provider: "openai",
              status: "ok",
              accountEmail: email,
              snapshot: buildOpenAiSnapshot(response.success.rateLimits, email, nowMs),
            };
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      yield* Ref.set(cacheRef, { fetchedAtMs: nowMs, result });
      return result;
    });
});
