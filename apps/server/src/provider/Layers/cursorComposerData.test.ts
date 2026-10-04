// @effect-diagnostics nodeBuiltinImport:off - fixtures build a real sqlite state.vscdb synchronously
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import {
  loadCursorComposerContextUsageIndex,
  readCursorComposerContextUsage,
  resolveCursorStateDbPath,
} from "./cursorComposerData.ts";

function writeComposerDataDb(
  dbPath: string,
  entries: ReadonlyArray<{ readonly sessionId: string; readonly value: unknown }>,
  options?: {
    readonly headers?: ReadonlyArray<{
      readonly composerId: string;
      readonly contextUsagePercent?: number;
    }>;
  },
): void {
  NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    for (const entry of entries) {
      insert.run(`composerData:${entry.sessionId}`, JSON.stringify(entry.value));
    }
    if (options?.headers !== undefined) {
      db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
        "composer.composerHeaders",
        JSON.stringify({ allComposers: options.headers }),
      );
    }
  } finally {
    db.close();
  }
}

describe("resolveCursorStateDbPath", () => {
  it("prefers CURSOR_STATE_DB over XDG and home defaults", () => {
    expect(
      resolveCursorStateDbPath({
        CURSOR_STATE_DB: "/tmp/custom-state.vscdb",
        XDG_CONFIG_HOME: "/xdg",
        HOME: "/home/nobody",
      }),
    ).toBe("/tmp/custom-state.vscdb");
  });

  it("uses XDG_CONFIG_HOME when CURSOR_STATE_DB is unset", () => {
    expect(
      resolveCursorStateDbPath({
        XDG_CONFIG_HOME: "/xdg-config",
        HOME: "/home/nobody",
      }),
    ).toBe("/xdg-config/Cursor/User/globalStorage/state.vscdb");
  });

  it("falls back to ~/.config when neither override is set", () => {
    expect(resolveCursorStateDbPath({ HOME: "/home/nobody" })).toBe(
      NodePath.join("/home/nobody", ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    );
  });
});

describe("readCursorComposerContextUsage", () => {
  it("returns native contextUsagePercent without inventing token counts", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cursor-composer-"));
    const dbPath = NodePath.join(dir, "state.vscdb");
    const sessionId = "5caf2dec-a694-4bdc-a180-4775e75bb307";
    writeComposerDataDb(dbPath, [
      {
        sessionId,
        value: {
          contextUsagePercent: 66.2265,
          name: "meter fixture",
          usageData: {},
        },
      },
    ]);

    expect(readCursorComposerContextUsage(sessionId, { stateDbPath: dbPath })).toEqual({
      contextUsagePercent: 66.2265,
    });
  });

  it("returns null when the composerData row is missing", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cursor-composer-miss-"));
    const dbPath = NodePath.join(dir, "state.vscdb");
    writeComposerDataDb(dbPath, []);

    expect(
      readCursorComposerContextUsage("11111111-1111-4111-8111-111111111111", {
        stateDbPath: dbPath,
      }),
    ).toBeNull();
  });

  it("returns null for invalid percent or unreadable database", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cursor-composer-bad-"));
    const dbPath = NodePath.join(dir, "state.vscdb");
    writeComposerDataDb(dbPath, [
      { sessionId: "bad-percent", value: { contextUsagePercent: 101 } },
      { sessionId: "missing-percent", value: { name: "no percent" } },
    ]);

    expect(readCursorComposerContextUsage("bad-percent", { stateDbPath: dbPath })).toBeNull();
    expect(readCursorComposerContextUsage("missing-percent", { stateDbPath: dbPath })).toBeNull();
    expect(
      readCursorComposerContextUsage("any", {
        stateDbPath: NodePath.join(dir, "does-not-exist.vscdb"),
      }),
    ).toBeNull();
  });

  it("honors CURSOR_STATE_DB from env when stateDbPath is omitted", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cursor-composer-env-"));
    const dbPath = NodePath.join(dir, "state.vscdb");
    writeComposerDataDb(dbPath, [{ sessionId: "env-session", value: { contextUsagePercent: 42 } }]);

    expect(
      readCursorComposerContextUsage("env-session", {
        env: { CURSOR_STATE_DB: dbPath },
      }),
    ).toEqual({ contextUsagePercent: 42 });
  });

  it("falls back to composer.composerHeaders when composerData is missing", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cursor-composer-headers-"));
    const dbPath = NodePath.join(dir, "state.vscdb");
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    writeComposerDataDb(dbPath, [], {
      headers: [{ composerId: sessionId, contextUsagePercent: 55.5 }],
    });

    expect(readCursorComposerContextUsage(sessionId, { stateDbPath: dbPath })).toEqual({
      contextUsagePercent: 55.5,
    });
  });
});

describe("loadCursorComposerContextUsageIndex", () => {
  it("looks up only the requested sessions when given ids", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cursor-composer-ids-"));
    const dbPath = NodePath.join(dir, "state.vscdb");
    writeComposerDataDb(dbPath, [
      { sessionId: "wanted", value: { contextUsagePercent: 12 } },
      { sessionId: "other", value: { contextUsagePercent: 88 } },
    ]);

    expect([
      ...loadCursorComposerContextUsageIndex({ stateDbPath: dbPath, sessionIds: ["wanted"] }),
    ]).toEqual([["wanted", 12]]);
    expect([...loadCursorComposerContextUsageIndex({ stateDbPath: dbPath })].toSorted()).toEqual([
      ["other", 88],
      ["wanted", 12],
    ]);
  });

  it("skips a composer row whose JSON is malformed instead of losing the rest", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cursor-composer-junk-"));
    const dbPath = NodePath.join(dir, "state.vscdb");
    writeComposerDataDb(dbPath, [{ sessionId: "good", value: { contextUsagePercent: 30 } }]);
    const db = new NodeSqlite.DatabaseSync(dbPath);
    try {
      db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
        "composerData:junk",
        "{not json",
      );
    } finally {
      db.close();
    }

    expect([
      ...loadCursorComposerContextUsageIndex({ stateDbPath: dbPath, sessionIds: ["junk", "good"] }),
    ]).toEqual([["good", 30]]);
  });
});
