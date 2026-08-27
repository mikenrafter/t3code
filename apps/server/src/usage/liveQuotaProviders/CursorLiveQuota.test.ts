import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  buildCursorSnapshot,
  computeCursorResult,
  readCursorAuth,
  type CursorAuthRecord,
} from "./CursorLiveQuota.ts";

const NOW_MS = Date.parse("2026-08-22T12:00:00.000Z");
const PERIOD_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const SUMMARY_URL = "https://cursor.com/api/usage-summary";

function makeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function createCursorStateDb(dbPath: string, rows: Record<string, string> = {}): void {
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(rows)) {
    insert.run(key, value);
  }
  db.close();
}

function makeHttpLayer(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))),
    ),
  );
}

const cursorAuth = (overrides: Partial<CursorAuthRecord> = {}): CursorAuthRecord => ({
  accessToken: "initial-access-token",
  refreshToken: "initial-refresh-token",
  userId: "user_abc123",
  ...overrides,
});

it.layer(NodeServices.layer)("CursorLiveQuota", (it) => {
  it.effect("readCursorAuth reports missing when state.vscdb does not exist", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-live-quota-" });
      const result = yield* readCursorAuth(path.join(dir, "state.vscdb"));
      expect(result).toEqual({ status: "missing" });
    }),
  );

  it.effect("readCursorAuth reads a valid Cursor auth record", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-live-quota-" });
      const dbPath = path.join(dir, "state.vscdb");
      createCursorStateDb(dbPath, {
        "cursorAuth/accessToken": makeJwt("auth0|user_abc123"),
        "cursorAuth/refreshToken": "refresh-token-value",
      });

      const result = yield* readCursorAuth(dbPath);
      expect(result).toEqual({
        status: "ok",
        record: {
          accessToken: makeJwt("auth0|user_abc123"),
          refreshToken: "refresh-token-value",
          userId: "user_abc123",
        },
      });
    }),
  );
});

describe("buildCursorSnapshot", () => {
  it("maps period/summary bodies into primary (Auto) / secondary (API/named model) slots", () => {
    const snapshot = buildCursorSnapshot(
      {
        period: {
          planUsage: { autoPercentUsed: 30, apiPercentUsed: 12.5 },
        },
        summary: { billingCycleEnd: "2026-09-01T00:00:00.000Z" },
      },
      "person@example.com",
      NOW_MS,
    );

    expect(snapshot.accountEmail).toBe("person@example.com");
    expect(snapshot.primary).toMatchObject({
      usedPercent: 30,
      windowMinutes: null,
      resetsAt: "2026-09-01T00:00:00.000Z",
      displayValue: "Auto 30%",
    });
    expect(snapshot.secondary).toMatchObject({ usedPercent: 12.5, displayValue: "API 12.5%" });
  });
});

describe("computeCursorResult", () => {
  it.effect("maps a 200 happy path into an ok result", () =>
    Effect.gen(function* () {
      const layer = makeHttpLayer((request) => {
        if (request.url === PERIOD_URL) {
          return Response.json({
            planUsage: { autoPercentUsed: 10, apiPercentUsed: 5 },
          });
        }
        if (request.url === SUMMARY_URL) {
          return Response.json({ billingCycleEnd: "2026-09-01T00:00:00.000Z" });
        }
        return Response.json({}, { status: 404 });
      });

      const result = yield* computeCursorResult(cursorAuth(), "person@example.com", NOW_MS).pipe(
        Effect.provide(layer),
      );
      expect(result.status).toBe("ok");
      expect(result.accountEmail).toBe("person@example.com");
      expect(result.snapshot?.primary.usedPercent).toBe(10);
    }),
  );

  it.effect(
    "carries the caller-supplied email through regardless of the local credential source",
    () =>
      Effect.gen(function* () {
        // computeCursorResult no longer reads any email off the auth record —
        // CursorAuthRecord has no email field at all. The account email comes
        // solely from whatever the caller (LiveQuotaService, backed by the
        // same provider-status check Settings uses) passes in.
        const layer = makeHttpLayer((request) => {
          if (request.url === PERIOD_URL) {
            return Response.json({ planUsage: { autoPercentUsed: 1, apiPercentUsed: 2 } });
          }
          if (request.url === SUMMARY_URL) {
            return Response.json({ billingCycleEnd: "2026-09-01T00:00:00.000Z" });
          }
          return Response.json({});
        });

        const result = yield* computeCursorResult(
          cursorAuth(),
          "someone-else@example.com",
          NOW_MS,
        ).pipe(Effect.provide(layer));
        expect(result.accountEmail).toBe("someone-else@example.com");
        expect(result.snapshot?.accountEmail).toBe("someone-else@example.com");
      }),
  );

  it.effect("reports unauthenticated when refresh is unavailable", () =>
    Effect.gen(function* () {
      const layer = makeHttpLayer((request) => {
        if (request.url === PERIOD_URL || request.url === SUMMARY_URL) {
          return Response.json({}, { status: 401 });
        }
        return Response.json({});
      });

      const result = yield* computeCursorResult(
        cursorAuth({ refreshToken: null }),
        "person@example.com",
        NOW_MS,
      ).pipe(Effect.provide(layer));
      expect(result.status).toBe("unauthenticated");
    }),
  );
});
