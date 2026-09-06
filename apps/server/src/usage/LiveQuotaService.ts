/**
 * LiveQuotaService - point-in-time reads of provider dashboard/rate-limit APIs.
 *
 * Distinct from {@link "./UsageService.ts" | UsageService}: usage is a
 * historical token-scan derived from provider CLIs' own on-disk session
 * transcripts, while live quota is a point-in-time read of a provider's own
 * dashboard/rate-limit API. See `packages/contracts/src/liveQuota.ts` for the
 * full contract rationale.
 *
 * Two hardcoded adapters (Cursor, Claude) are run directly — no
 * registry/adapter-interface abstraction. `ProviderAdapterRegistry.ts` exists
 * for a different concern (ACP process lifecycle for driving coding-agent
 * sessions) and doesn't fit a 2-item, read-only, polling-only feature; this
 * literal array is cheap to grow into a registry later if a third provider
 * shows up.
 *
 * Each adapter's own effect already resolves to a `LiveQuotaResult` and never
 * fails as a whole (per-provider failures become a `status:
 * "missing"|"unauthenticated"|"failed"` entry instead), so `readSnapshots`
 * just runs both and concatenates — same "partial coverage over hard
 * failure" philosophy as `UsageService.readSummary`'s `sources[]`.
 *
 * @module LiveQuotaService
 */
import type { LiveQuotaResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ClaudeLiveQuota from "./liveQuotaProviders/ClaudeLiveQuota.ts";
import * as CursorLiveQuota from "./liveQuotaProviders/CursorLiveQuota.ts";
import * as OpenAiLiveQuota from "./liveQuotaProviders/OpenAiLiveQuota.ts";

/** A fully-resolved live-quota reader: no ambient context, never fails. */
export type LiveQuotaAdapter = () => Effect.Effect<LiveQuotaResult>;

export class LiveQuotaService extends Context.Service<
  LiveQuotaService,
  {
    readonly readSnapshots: Effect.Effect<ReadonlyArray<LiveQuotaResult>>;
  }
>()("t3/usage/LiveQuotaService") {}

/** Empty snapshots, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  LiveQuotaService,
  LiveQuotaService.of({
    readSnapshots: Effect.succeed([]),
  }),
);

/**
 * Cursor's live-quota adapter doesn't resolve its own account email (see
 * `CursorLiveQuota`'s module doc) — it defers to whatever the *existing*
 * provider-status check already found for the Cursor instance, the same
 * value Settings shows. That check already runs on its own polling cadence
 * to feed `ServerProvider.auth`, so reading its cached snapshot here costs
 * nothing extra (no new subprocess spawn).
 */
export const resolveCursorAccountEmail = (
  registry: ProviderInstanceRegistryShape,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const instances = yield* registry.listInstances;
    const cursorInstance = instances.find((instance) => instance.driverKind === "cursor");
    if (cursorInstance === undefined) return null;

    const snapshot = yield* cursorInstance.snapshot.getSnapshot;
    return snapshot.auth.status === "authenticated" ? (snapshot.auth.email ?? null) : null;
  });

export const make = Effect.gen(function* () {
  const providerInstanceRegistry = yield* ProviderInstanceRegistry;
  const cursorAdapter = yield* CursorLiveQuota.make(
    resolveCursorAccountEmail(providerInstanceRegistry),
  );
  const claudeAdapter = yield* ClaudeLiveQuota.make;
  const openAiAdapter = yield* OpenAiLiveQuota.make;
  const adapters: ReadonlyArray<LiveQuotaAdapter> = [cursorAdapter, claudeAdapter, openAiAdapter];

  const readSnapshots: Effect.Effect<ReadonlyArray<LiveQuotaResult>> = Effect.all(
    adapters.map((adapter) => adapter()),
    { concurrency: "unbounded" },
  );

  return { readSnapshots } as const;
});

export const layer = Layer.effect(LiveQuotaService, make);
