import type { EnvironmentId, LiveQuotaResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeLiveQuota, type EnvironmentLiveQuotaAnswer } from "./liveQuota";

function result(overrides: Partial<LiveQuotaResult> = {}): LiveQuotaResult {
  return {
    provider: "claude",
    status: "ok",
    accountEmail: null,
    snapshot: undefined,
    message: undefined,
    ...overrides,
  };
}

function environment(id: string, results: readonly LiveQuotaResult[]): EnvironmentLiveQuotaAnswer {
  return { environmentId: id as EnvironmentId, results };
}

describe("mergeLiveQuota", () => {
  it("dedupes two environments reporting the same (provider, accountEmail)", () => {
    const merged = mergeLiveQuota([
      environment("env-a", [result({ accountEmail: "theo@example.com" })]),
      environment("env-b", [result({ accountEmail: "theo@example.com" })]),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.accountEmail).toBe("theo@example.com");
  });

  it("keeps two environments reporting different accounts for the same provider separate", () => {
    const merged = mergeLiveQuota([
      environment("env-a", [result({ accountEmail: "theo@example.com" })]),
      environment("env-b", [result({ accountEmail: "other@example.com" })]),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.accountEmail).sort()).toEqual([
      "other@example.com",
      "theo@example.com",
    ]);
  });

  it("does not collapse two environments that both report a null accountEmail", () => {
    // accountEmail is best-effort (Claude's live-quota result in particular
    // may not have one). Two null-email results silently collapsing into one
    // card would reintroduce the exact "wrong account" bug this dedupe rule
    // exists to prevent, so a null email falls back to keying by environment.
    const merged = mergeLiveQuota([
      environment("env-a", [result({ accountEmail: null })]),
      environment("env-b", [result({ accountEmail: null })]),
    ]);

    expect(merged).toHaveLength(2);
  });

  it("dedupes different providers independently", () => {
    const merged = mergeLiveQuota([
      environment("env-a", [
        result({ provider: "claude", accountEmail: "theo@example.com" }),
        result({ provider: "cursor", accountEmail: "theo@example.com" }),
      ]),
      environment("env-b", [
        result({ provider: "claude", accountEmail: "theo@example.com" }),
        result({ provider: "cursor", accountEmail: "theo@example.com" }),
      ]),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.provider).sort()).toEqual(["claude", "cursor"]);
  });

  it("returns an empty array with no environments", () => {
    expect(mergeLiveQuota([])).toEqual([]);
  });
});
