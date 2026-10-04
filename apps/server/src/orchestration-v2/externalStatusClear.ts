import type {
  ExternalThreadStatus,
  ExternalThreadStatusClearEvent,
  OrchestrationV2RunStatus,
} from "@t3tools/contracts";

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "preparing",
  "starting",
  "running",
]);

/**
 * The native clear event a run status change raises, if any. `before` is the
 * stored run's status prior to the event (undefined for an unseen run) and
 * `now` is the status the event carries. Transitions only: a repeat of the
 * same status never re-raises its event, so a status set after the
 * transition survives a stale duplicate.
 *
 * - `work`: the run becomes active from idle/terminal/unseen (not `queued`, not `waiting`).
 * - `error`: the run newly fails.
 * - `done`: the run newly completes.
 */
export function runTransitionClearEvent(
  before: OrchestrationV2RunStatus | undefined,
  now: OrchestrationV2RunStatus,
): ExternalThreadStatusClearEvent | null {
  if (now === "failed") return before === "failed" ? null : "error";
  if (now === "completed") return before === "completed" ? null : "done";
  if (ACTIVE_RUN_STATUSES.has(now)) {
    const alreadyActive =
      before !== undefined && (ACTIVE_RUN_STATUSES.has(before) || before === "waiting");
    return alreadyActive ? null : "work";
  }
  return null;
}

/** True when `status` retires on the run transition `before` -> `now`. */
export function externalStatusClearedByRun(
  status: ExternalThreadStatus | null | undefined,
  before: OrchestrationV2RunStatus | undefined,
  now: OrchestrationV2RunStatus,
): boolean {
  if (status === null || status === undefined || status.clearsOn === null) return false;
  return status.clearsOn === runTransitionClearEvent(before, now);
}
