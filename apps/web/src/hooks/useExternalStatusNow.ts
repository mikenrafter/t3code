import type { ExternalThreadStatus } from "@t3tools/contracts";
import { useEffect, useState } from "react";

// setTimeout stores its delay in a signed 32-bit int; larger values fire immediately,
// so an expiry weeks away simply keeps no timer (the row repaints on any update).
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Clock for an external status overlay. It re-renders the caller once when the
 * overlay's `expiresAt` passes so an expired status disappears without waiting
 * for an unrelated update; rows without an expiry hold no timer.
 */
export function useExternalStatusNow(status: ExternalThreadStatus | null | undefined): number {
  const [, setTick] = useState(0);
  const expiresAt = status?.expiresAt ?? null;
  useEffect(() => {
    if (expiresAt === null) return;
    const delay = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(delay) || delay <= 0 || delay > MAX_TIMEOUT_MS) return;
    const timer = window.setTimeout(() => setTick((tick) => tick + 1), delay);
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  // Read at render so a row that re-renders for any reason sees the real time.
  return Date.now();
}
