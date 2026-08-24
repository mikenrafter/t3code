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
  it("dedupes two environments reporting the same provider and account", () => {
    const merged = mergeLiveQuota([
      environment("env-a", [result({ accountEmail: "theo@example.com" })]),
      environment("env-b", [result({ accountEmail: "theo@example.com" })]),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.accountEmail).toBe("theo@example.com");
  });

  it("keeps different accounts for the same provider separate", () => {
    const merged = mergeLiveQuota([
      environment("env-a", [result({ accountEmail: "theo@example.com" })]),
      environment("env-b", [result({ accountEmail: "other@example.com" })]),
    ]);

    expect(merged).toHaveLength(2);
  });
});
