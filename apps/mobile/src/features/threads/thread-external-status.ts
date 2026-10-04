import {
  resolveExternalStatusTone,
  type ExternalStatusTone,
} from "@t3tools/client-runtime/state/thread-external-status";
import type { ExternalThreadStatus } from "@t3tools/contracts";
import { useEffect, useState } from "react";

/** Adaptive text colors that already ship in the generated Uniwind theme. */
const EXTERNAL_STATUS_TEXT_CLASS_BY_TONE: Record<ExternalStatusTone, string> = {
  amber: "text-adaptive-amber-700-300",
  emerald: "text-adaptive-emerald-700-300",
  indigo: "text-adaptive-indigo-600-300",
  red: "text-adaptive-rose-700-300",
  sky: "text-adaptive-sky-600-400",
  violet: "text-adaptive-violet-600-400",
  slate: "text-foreground-secondary",
};

export function externalStatusTextClassName(status: Pick<ExternalThreadStatus, "color">): string {
  return EXTERNAL_STATUS_TEXT_CLASS_BY_TONE[resolveExternalStatusTone(status.color)];
}

// setTimeout stores its delay in a signed 32-bit int; larger values fire immediately,
// so an expiry weeks away simply keeps no timer (the row repaints on any update).
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Clock for a thread row's external status overlay: re-renders the row once
 * when `expiresAt` passes so an expired overlay disappears without waiting for
 * another shell update. Overlays without an expiry hold no timer.
 */
export function useExternalStatusNow(status: ExternalThreadStatus | null | undefined): number {
  const [, setTick] = useState(0);
  const expiresAt = status?.expiresAt ?? null;
  useEffect(() => {
    if (expiresAt === null) return;
    const delay = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(delay) || delay <= 0 || delay > MAX_TIMEOUT_MS) return;
    const timer = setTimeout(() => setTick((tick) => tick + 1), delay);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  // Read at render so a row that re-renders for any reason sees the real time.
  return Date.now();
}
