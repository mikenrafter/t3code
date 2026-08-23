import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  LiveQuotaProviderKind,
  LiveQuotaResult,
  LiveQuotaSlot,
  LiveQuotaSnapshot,
} from "./liveQuota.ts";

const decodeLiveQuotaSlot = Schema.decodeUnknownEffect(LiveQuotaSlot);
const decodeLiveQuotaSnapshot = Schema.decodeUnknownEffect(LiveQuotaSnapshot);
const decodeLiveQuotaResult = Schema.decodeUnknownEffect(LiveQuotaResult);
const encodeLiveQuotaResult = Schema.encodeEffect(LiveQuotaResult);
const decodeLiveQuotaProviderKind = Schema.decodeUnknownEffect(LiveQuotaProviderKind);

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

it.effect("decodes a LiveQuotaProviderKind literal and rejects unknown ones", () =>
  Effect.gen(function* () {
    const cursor = yield* decodeLiveQuotaProviderKind("cursor");
    const claude = yield* decodeLiveQuotaProviderKind("claude");
    assert.strictEqual(cursor, "cursor");
    assert.strictEqual(claude, "claude");

    const rejected = yield* Effect.exit(decodeLiveQuotaProviderKind("copilot"));
    assert.strictEqual(rejected._tag, "Failure");
  }),
);

it.effect("decodes a LiveQuotaSlot with a rolling window", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeLiveQuotaSlot(validSlot);
    assert.strictEqual(parsed.usedPercent, 42.5);
    assert.strictEqual(parsed.windowMinutes, 300);
    assert.strictEqual(parsed.resetsAt, "2026-08-22T05:00:00.000Z");
    assert.strictEqual(parsed.resetDescription, "Resets in 3h");
    assert.strictEqual(parsed.displayValue, "42.5%");
  }),
);

it.effect("decodes a LiveQuotaSlot with no rolling window (billing-cycle based)", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeLiveQuotaSlot({
      ...validSlot,
      windowMinutes: null,
      resetsAt: null,
    });
    assert.strictEqual(parsed.windowMinutes, null);
    assert.strictEqual(parsed.resetsAt, null);
  }),
);

it.effect("rejects a LiveQuotaSlot whose resetDescription is blank after trim", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeLiveQuotaSlot({
        ...validSlot,
        resetDescription: "   ",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes a LiveQuotaSnapshot with only the required primary slot", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeLiveQuotaSnapshot({
      provider: "cursor",
      source: "cursor-dashboard-api",
      accountEmail: null,
      primary: validSlot,
      updatedAt: "2026-08-22T02:00:00.000Z",
    });
    assert.strictEqual(parsed.provider, "cursor");
    assert.strictEqual(parsed.accountEmail, null);
    assert.strictEqual(parsed.secondary, undefined);
    assert.strictEqual(parsed.tertiary, undefined);
  }),
);

it.effect("decodes a LiveQuotaSnapshot with secondary and tertiary slots", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeLiveQuotaSnapshot({
      ...validSnapshot,
      provider: "cursor",
      tertiary: validSlot,
    });
    assert.ok(parsed.secondary);
    assert.ok(parsed.tertiary);
  }),
);

it.effect("decodes a LiveQuotaResult with status ok and a snapshot", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeLiveQuotaResult({
      provider: "claude",
      status: "ok",
      accountEmail: "user@example.com",
      snapshot: validSnapshot,
    });
    assert.strictEqual(parsed.status, "ok");
    assert.strictEqual(parsed.accountEmail, "user@example.com");
    assert.ok(parsed.snapshot);
    assert.strictEqual(parsed.message, undefined);
  }),
);

it.effect("decodes a LiveQuotaResult with status missing and no snapshot", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeLiveQuotaResult({
      provider: "cursor",
      status: "missing",
      accountEmail: null,
    });
    assert.strictEqual(parsed.status, "missing");
    assert.strictEqual(parsed.snapshot, undefined);
  }),
);

it.effect("decodes a LiveQuotaResult with status unauthenticated and a message", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeLiveQuotaResult({
      provider: "cursor",
      status: "unauthenticated",
      accountEmail: null,
      message: "Session expired; refresh also failed.",
    });
    assert.strictEqual(parsed.status, "unauthenticated");
    assert.strictEqual(parsed.message, "Session expired; refresh also failed.");
  }),
);

it.effect("decodes a LiveQuotaResult with status failed", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeLiveQuotaResult({
      provider: "claude",
      status: "failed",
      accountEmail: null,
      message: "Network error contacting api.anthropic.com",
    });
    assert.strictEqual(parsed.status, "failed");
  }),
);

it.effect("rejects a LiveQuotaResult with an unknown status literal", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeLiveQuotaResult({
        provider: "claude",
        status: "error",
        accountEmail: null,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("round-trips a LiveQuotaResult through decode and encode", () =>
  Effect.gen(function* () {
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
