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
  decodeCursorAccessTokenUserId,
  readCursorAuth,
  resolveCursorStateDbPath,
  type CursorAuthRecord,
} from "./CursorLiveQuota.ts";

const NOW_MS = Date.parse("2026-08-22T12:00:00.000Z");

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

describe("decodeCursorAccessTokenUserId", () => {
  it("decodes the user id out of a well-formed JWT's sub claim", () => {
    expect(decodeCursorAccessTokenUserId(makeJwt("auth0|user_abc123"))).toBe("user_abc123");
  });

  it("returns the whole sub when there is no pipe-delimited prefix", () => {
    expect(decodeCursorAccessTokenUserId(makeJwt("user_abc123"))).toBe("user_abc123");
  });

  it("returns null for a token with no dot-delimited payload segment", () => {
    expect(decodeCursorAccessTokenUserId("not-a-jwt")).toBeNull();
  });

  it("returns null for a truncated / non-base64 payload segment", () => {
    expect(decodeCursorAccessTokenUserId("header.%%%not-base64%%%.sig")).toBeNull();
  });

  it("returns null when the decoded payload isn't valid JSON", () => {
    const badPayload = Buffer.from("not json").toString("base64url");
    expect(decodeCursorAccessTokenUserId(`header.${badPayload}.sig`)).toBeNull();
  });

  it("returns null when the sub claim is empty", () => {
    expect(decodeCursorAccessTokenUserId(makeJwt(""))).toBeNull();
  });
});

it.layer(NodeServices.layer)("CursorLiveQuota readCursorAuth", (it) => {
  it.effect("resolveCursorStateDbPath joins the expected Cursor state.vscdb location", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dbPath = yield* resolveCursorStateDbPath("/home/tester");
      expect(dbPath).toBe(
        path.join("/home/tester", ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
      );
    }),
  );

  it.effect("reports 'missing' when state.vscdb does not exist", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-live-quota-" });
      const dbPath = path.join(dir, "state.vscdb");

      const result = yield* readCursorAuth(dbPath);
      expect(result).toEqual({ status: "missing" });
    }),
  );

  it.effect("reports 'missing' when state.vscdb exists but has no cursorAuth rows", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-live-quota-" });
      const dbPath = path.join(dir, "state.vscdb");
      createCursorStateDb(dbPath);

      const result = yield* readCursorAuth(dbPath);
      expect(result).toEqual({ status: "missing" });
    }),
  );

  it.effect("reports 'missing' when the stored access token is a malformed JWT", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-live-quota-" });
      const dbPath = path.join(dir, "state.vscdb");
      createCursorStateDb(dbPath, { "cursorAuth/accessToken": "not-a-jwt" });

      const result = yield* readCursorAuth(dbPath);
      expect(result).toEqual({ status: "missing" });
    }),
  );

  it.effect("reads a valid Cursor auth record", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-live-quota-" });
      const dbPath = path.join(dir, "state.vscdb");
      createCursorStateDb(dbPath, {
        "cursorAuth/accessToken": makeJwt("auth0|user_abc123"),
        "cursorAuth/refreshToken": "refresh-token-value",
        "cursorAuth/stripeMembershipType": "pro",
      });

      const result = yield* readCursorAuth(dbPath);
      expect(result).toEqual({
        status: "ok",
        record: {
          accessToken: makeJwt("auth0|user_abc123"),
          refreshToken: "refresh-token-value",
          membership: "pro",
          userId: "user_abc123",
        },
      });
    }),
  );
});

// `readCursorAuth`'s retry delay uses a real `Effect.sleep`; `it.effect`
// (and `it.layer(...)`'s scoped variant) run under a virtual `TestClock`
// that never advances on its own, so these two need the real clock
// `it.live` provides instead (otherwise the sleep never resolves and the
// test hangs) — `it.live` isn't exposed on `it.layer(...)`'s scoped `it`,
// so `NodeServices.layer` is provided explicitly here instead.
it.live("retries once on SQLITE_BUSY and succeeds on the second attempt", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-live-quota-" });
    const dbPath = path.join(dir, "state.vscdb");
    yield* fileSystem.writeFileString(dbPath, "");

    let attempts = 0;
    const fakeStatement = {
      get: (key: string) =>
        key === "cursorAuth/accessToken" ? { value: makeJwt("auth0|user_retry") } : undefined,
    };
    const fakeDb = {
      prepare: () => fakeStatement,
      close: () => {},
    } as unknown as NodeSqlite.DatabaseSync;

    const openDatabase = () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return fakeDb;
    };

    const result = yield* readCursorAuth(dbPath, openDatabase);
    expect(attempts).toBe(2);
    expect(result).toEqual({
      status: "ok",
      record: {
        accessToken: makeJwt("auth0|user_retry"),
        refreshToken: null,
        membership: null,
        userId: "user_retry",
      },
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.live("reports 'failed' when SQLITE_BUSY persists through the retry", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-live-quota-" });
    const dbPath = path.join(dir, "state.vscdb");
    yield* fileSystem.writeFileString(dbPath, "");

    let attempts = 0;
    const openDatabase = (): NodeSqlite.DatabaseSync => {
      attempts += 1;
      throw new Error("SQLITE_BUSY: database is locked");
    };

    const result = yield* readCursorAuth(dbPath, openDatabase);
    expect(attempts).toBe(2);
    expect(result.status).toBe("failed");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

describe("buildCursorSnapshot", () => {
  it("maps period/summary bodies into primary (Auto) / secondary (API/named model) slots", () => {
    const snapshot = buildCursorSnapshot(
      {
        period: {
          planUsage: {
            totalPercentUsed: 42.5,
            autoPercentUsed: 30,
            apiPercentUsed: 12.5,
          },
        },
        summary: {
          billingCycleEnd: "2026-09-01T00:00:00.000Z",
        },
      },
      "person@example.com",
      NOW_MS,
    );

    expect(snapshot.provider).toBe("cursor");
    expect(snapshot.source).toBe("cursor-dashboard-api");
    expect(snapshot.accountEmail).toBe("person@example.com");
    expect(snapshot.primary).toMatchObject({
      usedPercent: 30,
      windowMinutes: null,
      resetsAt: "2026-09-01T00:00:00.000Z",
      displayValue: "Auto 30%",
    });
    expect(snapshot.secondary).toMatchObject({ usedPercent: 12.5, displayValue: "API 12.5%" });
  });

  it("formats window remainders with both hours and minutes", () => {
    const snapshot = buildCursorSnapshot(
      {
        period: {
          planUsage: {
            totalPercentUsed: 42.5,
            autoPercentUsed: 30,
            apiPercentUsed: 12.5,
          },
        },
        summary: {
          billingCycleEnd: "2026-08-22T15:24:00.000Z",
        },
      },
      "person@example.com",
      NOW_MS,
    );

    expect(snapshot.primary.resetDescription).toBe("Resets in 3h 24m");
  });

  it("rounds day-based window remainders", () => {
    const snapshot = buildCursorSnapshot(
      { period: {}, summary: { billingCycleEnd: "2026-08-24T00:00:00.000Z" } },
      "person@example.com",
      NOW_MS,
    );

    expect(snapshot.primary.resetDescription).toBe("Resets in 2d");
  });

  it("falls back to the summary plan fields when period.planUsage is absent", () => {
    const snapshot = buildCursorSnapshot(
      {
        period: {},
        summary: {
          individualUsage: {
            plan: { totalPercentUsed: 10, autoPercentUsed: 5, apiPercentUsed: 1 },
          },
        },
      },
      null,
      NOW_MS,
    );

    expect(snapshot.primary.usedPercent).toBe(5);
    expect(snapshot.secondary?.usedPercent).toBe(1);
    expect(snapshot.primary.resetsAt).toBeNull();
    expect(snapshot.primary.resetDescription).toBe("Billing cycle");
  });
});

const PERIOD_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const SUMMARY_URL = "https://cursor.com/api/usage-summary";
const PLAN_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo";
const REFRESH_URL = "https://api2.cursor.sh/oauth/token";

const cursorAuth = (overrides: Partial<CursorAuthRecord> = {}): CursorAuthRecord => ({
  accessToken: "initial-access-token",
  refreshToken: "initial-refresh-token",
  membership: "pro",
  userId: "user_abc123",
  ...overrides,
});

function makeHttpLayer(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))),
    ),
  );
}

describe("computeCursorResult", () => {
  it.effect("maps a 200 happy path into an 'ok' result", () =>
    Effect.gen(function* () {
      const layer = makeHttpLayer((request) => {
        if (request.url === PERIOD_URL) {
          return Response.json({
            planUsage: { totalPercentUsed: 20, autoPercentUsed: 10, apiPercentUsed: 5 },
          });
        }
        if (request.url === SUMMARY_URL) {
          return Response.json({ billingCycleEnd: "2026-09-01T00:00:00.000Z" });
        }
        if (request.url === PLAN_URL) {
          return Response.json({});
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

  it.effect("refreshes the token once on 401 and retries successfully", () =>
    Effect.gen(function* () {
      let periodCalls = 0;
      const layer = makeHttpLayer((request) => {
        if (request.url === REFRESH_URL) {
          return Response.json({ access_token: "refreshed-access-token" });
        }
        if (request.url === PERIOD_URL) {
          periodCalls += 1;
          if (periodCalls === 1) return Response.json({}, { status: 401 });
          return Response.json({ planUsage: { autoPercentUsed: 55 } });
        }
        if (request.url === SUMMARY_URL) {
          return Response.json({ billingCycleEnd: "2026-09-01T00:00:00.000Z" });
        }
        if (request.url === PLAN_URL) {
          return Response.json({});
        }
        return Response.json({}, { status: 404 });
      });

      const result = yield* computeCursorResult(cursorAuth(), "person@example.com", NOW_MS).pipe(
        Effect.provide(layer),
      );
      expect(periodCalls).toBe(2);
      expect(result.status).toBe("ok");
      expect(result.snapshot?.primary.usedPercent).toBe(55);
    }),
  );

  it.effect("reports 'unauthenticated' when refresh also fails", () =>
    Effect.gen(function* () {
      const layer = makeHttpLayer((request) => {
        if (request.url === REFRESH_URL) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        if (request.url === PERIOD_URL || request.url === SUMMARY_URL) {
          return Response.json({}, { status: 401 });
        }
        return Response.json({});
      });

      const result = yield* computeCursorResult(cursorAuth(), "person@example.com", NOW_MS).pipe(
        Effect.provide(layer),
      );
      expect(result.status).toBe("unauthenticated");
      expect(result.accountEmail).toBe("person@example.com");
    }),
  );

  it.effect("reports 'unauthenticated' with no refresh token available", () =>
    Effect.gen(function* () {
      const refreshCalls: Array<string> = [];
      const layer = makeHttpLayer((request) => {
        if (request.url === REFRESH_URL) refreshCalls.push(request.url);
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
      expect(refreshCalls).toEqual([]);
      expect(result.status).toBe("unauthenticated");
    }),
  );

  it.effect(
    "reports 'failed' when both period and summary requests fail with a non-401 error",
    () =>
      Effect.gen(function* () {
        const layer = makeHttpLayer((request) => {
          if (request.url === PERIOD_URL || request.url === SUMMARY_URL) {
            return Response.json({}, { status: 500 });
          }
          return Response.json({});
        });

        const result = yield* computeCursorResult(cursorAuth(), "person@example.com", NOW_MS).pipe(
          Effect.provide(layer),
        );
        expect(result.status).toBe("failed");
      }),
  );
});
