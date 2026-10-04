import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Native run transition that retires an external status: `work` when a run
 * becomes active, `error` when it fails, `done` when it completes. A
 * `custom:<name>` event is never raised by the server, so it only expires.
 */
export const ExternalThreadStatusClearEvent = Schema.Union([
  Schema.Literals(["work", "error", "done"]),
  Schema.String.check(Schema.isPattern(/^custom:.+$/)),
]);
export type ExternalThreadStatusClearEvent = typeof ExternalThreadStatusClearEvent.Type;

/** `IsoDateTime` is a bare string; external producers get their timestamps checked. */
const ExternalStatusTimestamp = IsoDateTime.check(
  Schema.makeFilter((value) =>
    Number.isNaN(Date.parse(value)) ? "Expected an ISO 8601 timestamp" : undefined,
  ),
);

/**
 * A producer-owned temporary presentation overlay for a thread. Dates are ISO
 * strings so the same shape rides thread payloads, shell snapshots, commands,
 * and the HTTP body.
 */
export const ExternalThreadStatus = Schema.Struct({
  source: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  icon: TrimmedNonEmptyString,
  color: TrimmedNonEmptyString,
  notifyUser: Schema.Boolean,
  expiresAt: Schema.NullOr(ExternalStatusTimestamp),
  clearsOn: Schema.NullOr(ExternalThreadStatusClearEvent).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  updatedAt: ExternalStatusTimestamp,
});
export type ExternalThreadStatus = typeof ExternalThreadStatus.Type;
