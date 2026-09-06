import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { buildClaudeSnapshot, fetchClaudeUsage, readClaudeAccessToken } from "./ClaudeLiveQuota.ts";

const NOW_MS = Date.parse("2026-08-22T12:00:00.000Z");
const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

function makeHttpLayer(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))),
    ),
  );
}

it.layer(NodeServices.layer)("ClaudeLiveQuota", (it) => {
  it.effect("readClaudeAccessToken reports missing when credentials are absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-live-quota-" });
      const result = yield* readClaudeAccessToken(path.join(dir, ".credentials.json"));
      expect(result).toEqual({ status: "missing" });
    }),
  );

  it.effect("readClaudeAccessToken reads a valid access token", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-live-quota-" });
      const credentialsPath = path.join(dir, ".credentials.json");
      yield* fileSystem.writeFileString(
        credentialsPath,
        JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-abc123" } }),
      );

      const result = yield* readClaudeAccessToken(credentialsPath);
      expect(result).toEqual({ status: "ok", accessToken: "sk-ant-oat-abc123" });
    }),
  );
});

describe("buildClaudeSnapshot", () => {
  it("maps five_hour and seven_day windows into quota slots", () => {
    const snapshot = buildClaudeSnapshot(
      {
        five_hour: { utilization: 42, resets_at: "2026-08-22T17:00:00.000Z" },
        seven_day: { utilization: 8, resets_at: "2026-08-29T12:00:00.000Z" },
      },
      "person@example.com",
      NOW_MS,
    );

    expect(snapshot.primary).toMatchObject({
      usedPercent: 42,
      windowMinutes: 300,
      displayValue: "42%",
    });
    expect(snapshot.secondary).toMatchObject({
      usedPercent: 8,
      windowMinutes: 10080,
      displayValue: "8%",
    });
  });

  it("formats window remainders with both hours and minutes", () => {
    const snapshot = buildClaudeSnapshot(
      {
        five_hour: { utilization: 42, resets_at: "2026-08-22T15:24:00.000Z" },
        seven_day: { utilization: 8, resets_at: "2026-08-22T14:00:00.000Z" },
      },
      null,
      NOW_MS,
    );

    expect(snapshot.primary.resetDescription).toBe("Resets in 3h 24m");
    expect(snapshot.secondary?.resetDescription).toBe("Resets in 2h 0m");
  });

  it("rounds day-based window remainders", () => {
    const snapshot = buildClaudeSnapshot(
      { seven_day: { utilization: 8, resets_at: "2026-08-24T00:00:00.000Z" } },
      null,
      NOW_MS,
    );

    expect(snapshot.secondary?.resetDescription).toBe("Resets in 2d");
  });
});

describe("fetchClaudeUsage", () => {
  it.effect("maps a 200 happy path into an ok result", () =>
    Effect.gen(function* () {
      const layer = makeHttpLayer((request) => {
        expect(request.url).toBe(CLAUDE_OAUTH_USAGE_URL);
        return Response.json({
          five_hour: { utilization: 15, resets_at: "2026-08-22T17:00:00.000Z" },
          seven_day: { utilization: 3, resets_at: "2026-08-29T12:00:00.000Z" },
        });
      });

      const result = yield* fetchClaudeUsage(
        "sk-ant-oat-abc123",
        "person@example.com",
        NOW_MS,
      ).pipe(Effect.provide(layer));
      expect(result.status).toBe("ok");
      expect(result.snapshot?.primary.usedPercent).toBe(15);
    }),
  );

  it.effect("maps a 401 to unauthenticated", () =>
    Effect.gen(function* () {
      const layer = makeHttpLayer(() => Response.json({}, { status: 401 }));
      const result = yield* fetchClaudeUsage("expired-token", null, NOW_MS).pipe(
        Effect.provide(layer),
      );
      expect(result.status).toBe("unauthenticated");
    }),
  );
});
