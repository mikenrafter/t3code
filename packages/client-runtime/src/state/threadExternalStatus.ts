// @effect-diagnostics globalDate:off - Pure presenter shared by React clients; it runs outside any Effect runtime.
import type { ExternalThreadStatus } from "@t3tools/contracts";

/**
 * Overlay presentation shared by web and mobile thread lists. The server owns
 * native-transition clearing (see `clearsOn`); clients only hide expired
 * overlays and keep native attention states ahead of them.
 */

/** The native list status of a thread row, the same union on web and mobile. */
export type ThreadListNativeStatus =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

/** Native states that need the user's attention and must stay visible over an overlay. */
const NATIVE_STATUSES_THAT_WIN: ReadonlySet<ThreadListNativeStatus> = new Set([
  "approval",
  "input",
  "failed",
  "limited",
]);

export type ExternalStatusTone =
  | "amber"
  | "emerald"
  | "indigo"
  | "red"
  | "sky"
  | "violet"
  | "slate";

const EXTERNAL_STATUS_TONES: ReadonlySet<string> = new Set([
  "amber",
  "emerald",
  "indigo",
  "red",
  "sky",
  "violet",
  "slate",
]);

/** Producer-chosen color mapped onto the palette clients ship; unknown colors read slate. */
export function resolveExternalStatusTone(color: string): ExternalStatusTone {
  return EXTERNAL_STATUS_TONES.has(color) ? (color as ExternalStatusTone) : "slate";
}

/** Active iff present and not yet expired. */
export function isExternalThreadStatusActive(
  status: ExternalThreadStatus | null | undefined,
  now = Date.now(),
): status is ExternalThreadStatus {
  return (
    status !== undefined &&
    status !== null &&
    (status.expiresAt === null || Date.parse(status.expiresAt) > now)
  );
}

/**
 * The overlay a thread row should render, or null. Native approval, input,
 * failed, and limited states win; the overlay replaces working, waiting, and
 * ready.
 */
export function resolveExternalStatusOverlay(input: {
  readonly status: ThreadListNativeStatus;
  readonly externalStatus: ExternalThreadStatus | null | undefined;
  readonly now?: number;
}): ExternalThreadStatus | null {
  if (NATIVE_STATUSES_THAT_WIN.has(input.status)) return null;
  return isExternalThreadStatusActive(input.externalStatus, input.now)
    ? input.externalStatus
    : null;
}
