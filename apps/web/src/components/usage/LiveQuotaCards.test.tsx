import type { LiveQuotaResult } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { LiveQuotaCards } from "./LiveQuotaCards";

type LiveQuotaSnapshot = NonNullable<LiveQuotaResult["snapshot"]>;

const okResult = (overrides: Partial<LiveQuotaSnapshot> = {}): LiveQuotaResult => ({
  provider: "claude",
  status: "ok",
  accountEmail: "alice@example.com",
  snapshot: {
    provider: "claude",
    source: "anthropic-oauth-usage",
    accountEmail: "alice@example.com",
    primary: {
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: "2026-08-26T18:00:00.000Z",
      resetDescription: "Resets in 3h",
      displayValue: "42%",
    },
    updatedAt: "2026-08-26T15:00:00.000Z",
    ...overrides,
  },
});

describe("LiveQuotaCards", () => {
  it("renders both meters when a snapshot has a secondary slot", () => {
    const result = okResult({
      secondary: {
        usedPercent: 48,
        windowMinutes: 10080,
        resetsAt: "2026-09-01T00:00:00.000Z",
        resetDescription: "Resets in 5d",
        displayValue: "48% (API)",
      },
    });

    const markup = renderToStaticMarkup(<LiveQuotaCards results={[result]} onRetry={vi.fn()} />);

    expect(markup).toContain("42%");
    expect(markup).toContain("48% (API)");
    expect(markup).toContain("rolling 5h");
    expect(markup).toContain("rolling 7d");
  });

  it("renders no secondary meter when the snapshot has only a primary slot", () => {
    const result = okResult();

    const markup = renderToStaticMarkup(<LiveQuotaCards results={[result]} onRetry={vi.fn()} />);

    expect(markup).toContain("42%");
    // Only the primary badge should be present; nothing else marked "rolling".
    expect(markup.match(/rolling/g)).toHaveLength(1);
  });

  it("renders a non-null account email behind the redacted control, not as plain text", () => {
    const result = okResult();

    const markup = renderToStaticMarkup(<LiveQuotaCards results={[result]} onRetry={vi.fn()} />);

    expect(markup).not.toContain("alice@example.com");
    expect(markup).toContain("Toggle account email visibility");
  });

  it('shows "No account" when accountEmail is null', () => {
    const result = okResult();
    const withoutEmail: LiveQuotaResult = { ...result, accountEmail: null };

    const markup = renderToStaticMarkup(
      <LiveQuotaCards results={[withoutEmail]} onRetry={vi.fn()} />,
    );

    expect(markup).toContain("No account");
  });
});
