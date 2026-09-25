import { ProviderInstanceId, type AgentSessionEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PAGE_LIMITS,
  computeImportThreadEmptyState,
  filterImportThreadEntries,
  importThreadEmptyStateMessage,
  nextPageLimit,
  providerLabel,
  resolveDefaultImportProject,
} from "./importThreadSheet.logic";

function entry(
  overrides: Partial<AgentSessionEntry> & Pick<AgentSessionEntry, "title" | "provider">,
): AgentSessionEntry {
  return {
    providerInstanceId: ProviderInstanceId.make(overrides.provider),
    providerSessionId: overrides.title,
    promptPreview: overrides.promptPreview ?? "preview",
    lastActiveAt: overrides.lastActiveAt ?? "2026-09-25T00:00:00.000Z",
    cwd: overrides.cwd ?? "/tmp/project",
    alreadyImported: overrides.alreadyImported ?? false,
    ...overrides,
  };
}

describe("PAGE_LIMITS / nextPageLimit", () => {
  it("lists the stepped limits", () => {
    expect(PAGE_LIMITS).toEqual([15, 45, 90, 200]);
  });

  it("advances to the next step and stops at the top", () => {
    expect(nextPageLimit(15)).toBe(45);
    expect(nextPageLimit(45)).toBe(90);
    expect(nextPageLimit(90)).toBe(200);
    expect(nextPageLimit(200)).toBeNull();
  });

  it("skips to the next larger limit from a custom current value", () => {
    expect(nextPageLimit(1)).toBe(15);
    expect(nextPageLimit(50)).toBe(90);
    expect(nextPageLimit(500)).toBeNull();
  });
});

describe("filterImportThreadEntries", () => {
  const rows = [
    entry({
      provider: "claudeAgent",
      title: "Fix auth",
      promptPreview: "wire scopes",
    }),
    entry({
      provider: "codex",
      title: "Ship overlay",
      promptPreview: "status icon",
    }),
    entry({
      provider: "claudeAgent",
      title: "Refactor importer",
      promptPreview: "list recent",
    }),
  ];

  it("keeps every row when filters are idle", () => {
    const filtered = filterImportThreadEntries(rows, { query: "", provider: "all" });
    expect(filtered).toHaveLength(3);
  });

  it("filters by provider", () => {
    const filtered = filterImportThreadEntries(rows, { query: "", provider: "claudeAgent" });
    expect(filtered.map((row) => row.title)).toEqual(["Fix auth", "Refactor importer"]);
  });

  it("searches title and prompt preview case-insensitively", () => {
    const filtered = filterImportThreadEntries(rows, { query: "OVERLAY", provider: "all" });
    expect(filtered.map((row) => row.title)).toEqual(["Ship overlay"]);
  });

  it("combines provider and search filters", () => {
    const filtered = filterImportThreadEntries(rows, {
      query: "import",
      provider: "claudeAgent",
    });
    expect(filtered.map((row) => row.title)).toEqual(["Refactor importer"]);
  });
});

describe("computeImportThreadEmptyState", () => {
  it("is null while any filtered row remains", () => {
    expect(
      computeImportThreadEmptyState({
        serverEntryCount: 2,
        filteredEntries: [entry({ provider: "codex", title: "A" })],
        query: "",
        provider: "all",
      }),
    ).toBeNull();
  });

  it("reports no-recent when the server returned nothing", () => {
    expect(
      computeImportThreadEmptyState({
        serverEntryCount: 0,
        filteredEntries: [],
        query: "",
        provider: "all",
      }),
    ).toEqual({ kind: "no-recent" });
  });

  it("reports all-imported when discovery only found owned sessions", () => {
    expect(
      computeImportThreadEmptyState({
        serverEntryCount: 0,
        filteredAlreadyImportedCount: 3,
        filteredEntries: [],
        query: "",
        provider: "all",
      }),
    ).toEqual({ kind: "all-imported" });
  });

  it("reports no-matches when a query clears the list", () => {
    expect(
      computeImportThreadEmptyState({
        serverEntryCount: 3,
        filteredEntries: [],
        query: "zzz",
        provider: "all",
      }),
    ).toEqual({ kind: "no-matches" });
  });

  it("reports provider-empty when a provider filter clears the list", () => {
    expect(
      computeImportThreadEmptyState({
        serverEntryCount: 2,
        filteredEntries: [],
        query: "",
        provider: "codex",
      }),
    ).toEqual({ kind: "provider-empty", provider: "codex" });
  });

  it("prefers search copy over provider copy when both apply", () => {
    expect(
      computeImportThreadEmptyState({
        serverEntryCount: 2,
        filteredEntries: [],
        query: "missing",
        provider: "claudeAgent",
      }),
    ).toEqual({ kind: "no-matches" });
  });
});

describe("importThreadEmptyStateMessage", () => {
  it("names the provider in provider-empty copy", () => {
    expect(importThreadEmptyStateMessage({ kind: "provider-empty", provider: "claudeAgent" })).toBe(
      "No recent Claude sessions for this project.",
    );
    expect(importThreadEmptyStateMessage({ kind: "no-recent" })).toContain("Cursor");
    expect(importThreadEmptyStateMessage({ kind: "all-imported" })).toContain("already in T3");
  });
});

describe("resolveDefaultImportProject", () => {
  it("prefers scoped, then active thread, then first project", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    expect(
      resolveDefaultImportProject({ preferred: a, activeThreadProject: b, projects: [c] }),
    ).toBe(a);
    expect(
      resolveDefaultImportProject({ preferred: null, activeThreadProject: b, projects: [c] }),
    ).toBe(b);
    expect(
      resolveDefaultImportProject({ preferred: null, activeThreadProject: null, projects: [c, a] }),
    ).toBe(c);
    expect(
      resolveDefaultImportProject({ preferred: null, activeThreadProject: null, projects: [] }),
    ).toBeNull();
  });
});

describe("providerLabel", () => {
  it("maps session sources to short UI labels", () => {
    expect(providerLabel("claudeAgent")).toBe("Claude");
    expect(providerLabel("codex")).toBe("Codex");
    expect(providerLabel("cursor")).toBe("Cursor");
  });
});
