import type { LiveQuotaProviderKind, LiveQuotaResult, LiveQuotaSlot } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { ClaudeAI, CursorIcon, type Icon } from "../Icons";

const PROVIDER_ICON: Record<LiveQuotaProviderKind, Icon> = {
  cursor: CursorIcon,
  claude: ClaudeAI,
};

const PROVIDER_LABEL: Record<LiveQuotaProviderKind, string> = {
  cursor: "Cursor",
  claude: "Claude",
};

/**
 * Formats a rolling-window duration for the small badge next to a quota bar
 * (e.g. `300` -> `"5h"`, `10080` -> `"7d"`). Callers only call this for a
 * non-null `windowMinutes` — a billing-cycle meter (`null`) gets no badge at
 * all, matching the DMS `aiOverviewControl` plugin's own `getWindowLabel`
 * null-handling.
 */
export function formatQuotaWindow(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * Renders one card per live-quota result. `"missing"` results (no usable
 * credential — never installed, or installed but never signed in) are
 * omitted entirely rather than nagging the user; every other status renders
 * a card, just with different content in place of the percent bar.
 */
export function LiveQuotaCards({
  results,
  onRetry,
}: {
  readonly results: readonly LiveQuotaResult[];
  readonly onRetry: () => void;
}) {
  const visible = results.filter((result) => result.status !== "missing");
  if (visible.length === 0) {
    return null;
  }

  return (
    <section className="grid gap-3 sm:grid-cols-2">
      {visible.map((result) => (
        <LiveQuotaCard
          key={`${result.provider}:${result.accountEmail ?? "unknown"}`}
          result={result}
          onRetry={onRetry}
        />
      ))}
    </section>
  );
}

function LiveQuotaCard({
  result,
  onRetry,
}: {
  readonly result: LiveQuotaResult;
  readonly onRetry: () => void;
}) {
  const Icon = PROVIDER_ICON[result.provider];

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Icon className="size-4 shrink-0" aria-hidden />
          {PROVIDER_LABEL[result.provider]}
        </span>
        {/* Always shown, even when null, so a multi-account render (two cards
            for the same provider) stays legible instead of looking like a
            rendering glitch. Redacted by default since it's a real account
            email (PII) rendered directly in the UI. */}
        {result.accountEmail ? (
          <RedactedSensitiveText
            value={result.accountEmail}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
          />
        ) : (
          <span className="text-xs text-muted-foreground">No account</span>
        )}
      </div>
      <LiveQuotaCardBody result={result} onRetry={onRetry} />
    </div>
  );
}

function LiveQuotaCardBody({
  result,
  onRetry,
}: {
  readonly result: LiveQuotaResult;
  readonly onRetry: () => void;
}) {
  if (result.status === "unauthenticated") {
    return (
      <p className="text-xs text-muted-foreground">
        Sign in to {PROVIDER_LABEL[result.provider]} to see live quota.
      </p>
    );
  }

  // "ok" with no snapshot should not happen per the contract, but render the
  // same retry affordance as "failed" rather than crash on a missing field.
  if (result.status === "failed" || result.snapshot === undefined) {
    return (
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {result.message ?? "Could not read live quota."}
        </p>
        <button
          type="button"
          onClick={onRetry}
          aria-label={`Retry ${PROVIDER_LABEL[result.provider]} live quota`}
          className="cursor-pointer rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground"
        >
          <RefreshCwIcon className="size-3.5" />
        </button>
      </div>
    );
  }

  const { primary, secondary } = result.snapshot;

  return (
    <div className="flex flex-col gap-2">
      <LiveQuotaMeter slot={primary} size="primary" />
      {secondary ? <LiveQuotaMeter slot={secondary} size="secondary" /> : null}
    </div>
  );
}

function LiveQuotaMeter({
  slot,
  size,
}: {
  readonly slot: LiveQuotaSlot;
  readonly size: "primary" | "secondary";
}) {
  const percent = Math.min(100, Math.max(0, slot.usedPercent));

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={cn(
            "font-semibold text-foreground tabular-nums",
            size === "primary" ? "text-2xl" : "text-sm",
          )}
        >
          {slot.displayValue}
        </span>
        {slot.windowMinutes !== null ? (
          <span
            className={cn(
              "shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px]",
              "text-muted-foreground uppercase",
            )}
          >
            rolling {formatQuotaWindow(slot.windowMinutes)}
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          "w-full overflow-hidden rounded-full bg-muted",
          size === "primary" ? "h-1" : "h-0.5",
        )}
      >
        <div className="h-full bg-foreground" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{slot.resetDescription}</span>
    </div>
  );
}
