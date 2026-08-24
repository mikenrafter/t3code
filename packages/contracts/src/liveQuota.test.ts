import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { LiveQuotaResult, LiveQuotaSnapshot } from "./liveQuota.ts";

const decodeLiveQuotaSnapshot = Schema.decodeUnknownEffect(LiveQuotaSnapshot);
const decodeLiveQuotaResult = Schema.decodeUnknownEffect(LiveQuotaResult);
const encodeLiveQuotaResult = Schema.encodeEffect(LiveQuotaResult);

const validSlot = {
  usedPercent: 42.5,
  windowMinutes: 300,
  resetsAt: "2026-08-22T05:00:00.000Z",
  resetDescription: "Resets in 3h",
  displayValue: "42.5%",
};

const validSnapshot = {
  provider: "claude" as const,
  source: "anthropic-oauth-usage",
  accountEmail: "user@example.com",
  primary: validSlot,
  secondary: {
    ...validSlot,
    windowMinutes: 10080,
    resetDescription: "Resets in 4d",
  },
  updatedAt: "2026-08-22T02:00:00.000Z",
};

it.effect("decodes a live quota snapshot and result statuses", () =>
  Effect.gen(function* () {
    const snapshot = yield* decodeLiveQuotaSnapshot(validSnapshot);
    assert.strictEqual(snapshot.provider, "claude");

    const ok = yield* decodeLiveQuotaResult({
      provider: "claude",
      status: "ok",
      accountEmail: "user@example.com",
      snapshot,
    });
    assert.strictEqual(ok.status, "ok");

    const missing = yield* decodeLiveQuotaResult({
      provider: "cursor",
      status: "missing",
      accountEmail: null,
    });
    assert.strictEqual(missing.status, "missing");

    const unauthenticated = yield* decodeLiveQuotaResult({
      provider: "cursor",
      status: "unauthenticated",
      accountEmail: null,
      message: "Session expired.",
    });
    assert.strictEqual(unauthenticated.status, "unauthenticated");
  }),
);

it.effect("rejects unknown result statuses and round-trips ok results", () =>
  Effect.gen(function* () {
    const rejected = yield* Effect.exit(
      decodeLiveQuotaResult({
        provider: "claude",
        status: "error",
        accountEmail: null,
      }),
    );
    assert.strictEqual(rejected._tag, "Failure");

    const decoded = yield* decodeLiveQuotaResult({
      provider: "claude",
      status: "ok",
      accountEmail: "user@example.com",
      snapshot: validSnapshot,
    });
    const encoded = yield* encodeLiveQuotaResult(decoded);
    assert.deepStrictEqual(encoded, {
      provider: "claude",
      status: "ok",
      accountEmail: "user@example.com",
      snapshot: validSnapshot,
    });
  }),
);
