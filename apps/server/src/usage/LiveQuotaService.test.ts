import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { ProviderInstanceRegistryShape } from "../provider/Services/ProviderInstanceRegistry.ts";
import { resolveCursorAccountEmail } from "./LiveQuotaService.ts";

/**
 * Only `driverKind` and `snapshot.getSnapshot` matter to
 * `resolveCursorAccountEmail` — everything else on `ProviderInstance` is
 * irrelevant plumbing for this test, so it's stubbed out rather than
 * fully typed.
 */
const makeFakeInstance = (
  driverKindString: "cursor" | "claudeAgent",
  auth: ServerProvider["auth"],
): ProviderInstance =>
  ({
    driverKind: ProviderDriverKind.make(driverKindString),
    snapshot: {
      getSnapshot: Effect.succeed({ auth } as unknown as ServerProvider),
    },
  }) as unknown as ProviderInstance;

const makeRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistryShape => ({
  getInstance: () => Effect.succeed(undefined),
  listInstances: Effect.succeed(instances),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) => PubSub.subscribe(pubsub)),
});

describe("resolveCursorAccountEmail", () => {
  it.effect("resolves the authenticated Cursor instance's email", () =>
    Effect.gen(function* () {
      const registry = makeRegistry([
        makeFakeInstance("cursor", { status: "authenticated", email: "person@example.com" }),
      ]);
      const email = yield* resolveCursorAccountEmail(registry);
      expect(email).toBe("person@example.com");
    }),
  );

  it.effect("returns null when the Cursor instance is not authenticated", () =>
    Effect.gen(function* () {
      const registry = makeRegistry([makeFakeInstance("cursor", { status: "unauthenticated" })]);
      const email = yield* resolveCursorAccountEmail(registry);
      expect(email).toBeNull();
    }),
  );

  it.effect("returns null when no Cursor instance is registered", () =>
    Effect.gen(function* () {
      const registry = makeRegistry([
        makeFakeInstance("claudeAgent", { status: "authenticated", email: "person@example.com" }),
      ]);
      const email = yield* resolveCursorAccountEmail(registry);
      expect(email).toBeNull();
    }),
  );
});
