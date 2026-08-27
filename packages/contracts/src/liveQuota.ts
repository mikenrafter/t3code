/**
 * Live quota contract.
 *
 * Distinct from {@link "./usage.ts" | the usage contract}: usage is a
 * historical token-scan derived from provider CLIs' own on-disk session
 * transcripts, while live quota is a point-in-time read of a provider's own
 * dashboard/rate-limit API (Cursor's billing-cycle usage, Anthropic's rolling
 * 5h/7d rate-limit window). Cursor's local transcripts carry no token/usage
 * data at all, so its usage can only ever be observed this way.
 *
 * Loosely inspired by the DMS `aiOverviewControl` plugin's
 * `get-provider-wrapper` contract's `usage.primary/secondary` shape (each
 * slot has `usedPercent`, `windowMinutes`, `resetsAt`, `resetDescription`,
 * `displayValue`) rather than inventing a new one.
 *
 * @module liveQuota
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LiveQuotaProviderKind = Schema.Literals(["cursor", "claude"]);
export type LiveQuotaProviderKind = typeof LiveQuotaProviderKind.Type;

/**
 * One usage meter within a snapshot (e.g. Cursor's total/auto/API split, or
 * Claude's 5h/7d rolling windows).
 */
export const LiveQuotaSlot = Schema.Struct({
  usedPercent: Schema.Number,
  /**
   * `null` means this meter has no rolling window and instead resets on a
   * billing cycle (Cursor's monthly plan). A real duration (Claude's 5h/7d
   * rate-limit windows) is populated in minutes so the client doesn't have to
   * parse a duration string to render a "rolling Xh/Xd" badge.
   */
  windowMinutes: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(Schema.String),
  resetDescription: TrimmedNonEmptyString,
  displayValue: TrimmedNonEmptyString,
});
export type LiveQuotaSlot = typeof LiveQuotaSlot.Type;

/**
 * A successful point-in-time read from one provider's live quota API.
 *
 * `secondary` is optional because not every provider has a two-way split
 * (a future single-meter provider could report `primary` alone).
 */
export const LiveQuotaSnapshot = Schema.Struct({
  provider: LiveQuotaProviderKind,
  /** `"cursor-dashboard-api" | "anthropic-oauth-usage"` — diagnostic only. */
  source: TrimmedNonEmptyString,
  accountEmail: Schema.NullOr(TrimmedNonEmptyString),
  primary: LiveQuotaSlot,
  secondary: Schema.optional(LiveQuotaSlot),
  updatedAt: Schema.String,
});
export type LiveQuotaSnapshot = typeof LiveQuotaSnapshot.Type;

/**
 * Status vocabulary deliberately mirrors {@link "./usage.ts" | UsageSourceStatus}
 * (`"ok"|"missing"|"partial"|"failed"`) rather than inventing new words:
 *
 * - `"ok"` - a snapshot was read successfully.
 * - `"missing"` - no usable credential exists (state.vscdb/`.credentials.json`
 *   absent, or present but empty/no token). Installed-but-never-signed-in
 *   reads the same as never-installed; both correctly hide the card rather
 *   than nag.
 * - `"unauthenticated"` - the one genuinely new state this feature needs. A
 *   usable-looking credential existed, but the API rejected it (401/403, or
 *   refresh also failed). Conflating this with `"missing"` (as an earlier
 *   draft of this contract did with a flat `"error"` status) would make both
 *   render identically, which is wrong: a user who's never installed Cursor
 *   and a user whose Cursor session expired need different messaging — the
 *   former hides the card, the latter shows a sign-in prompt.
 * - `"failed"` - any other read failure (network, non-200, malformed
 *   response). Named `"failed"`, not `"error"`, to match
 *   `UsageSourceStatus`'s vocabulary exactly.
 */
export const LiveQuotaResult = Schema.Struct({
  provider: LiveQuotaProviderKind,
  status: Schema.Literals(["ok", "missing", "unauthenticated", "failed"]),
  /**
   * Hoisted onto the result itself, not just nested in `snapshot`, so the
   * client can dedupe/label results even when rendering multiple
   * environments' answers for the same provider without having to reach into
   * an optional `snapshot` first.
   */
  accountEmail: Schema.NullOr(TrimmedNonEmptyString),
  snapshot: Schema.optional(LiveQuotaSnapshot),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type LiveQuotaResult = typeof LiveQuotaResult.Type;
