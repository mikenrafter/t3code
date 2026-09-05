import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  buildClaudeSnapshot,
  fetchClaudeUsage,
  readClaudeAccessToken,
  readClaudeAccountEmail,
  resolveClaudeAccountConfigPath,
} from "./ClaudeLiveQuota.ts";

const NOW_MS = Date.parse("2026-08-22T12:00:00.000Z");
const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Test fixtures only — `preferSchemaOverJson` flags raw `JSON.stringify`. */
const toJsonFixture = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("ClaudeLiveQuota file reads", (it) => {
  it.effect("resolveClaudeAccountConfigPath joins the expected ~/.claude.json location", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const resolved = yield* resolveClaudeAccountConfigPath("/home/tester");
      expect(resolved).toBe(path.join("/home/tester", ".claude.json"));
    }),
  );

  describe("readClaudeAccessToken", () => {
    it.effect("reports 'missing' when .credentials.json does not exist", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-live-quota-" });
        const credentialsPath = path.join(dir, ".credentials.json");

        const result = yield* readClaudeAccessToken(credentialsPath);
        expect(result).toEqual({ status: "missing" });
      }),
    );

    it.effect("reports 'missing' when the accessToken field is empty", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-live-quota-" });
        const credentialsPath = path.join(dir, ".credentials.json");
        yield* fileSystem.writeFileString(
          credentialsPath,
          toJsonFixture({ claudeAiOauth: { accessToken: "" } }),
        );

        const result = yield* readClaudeAccessToken(credentialsPath);
        expect(result).toEqual({ status: "missing" });
      }),
    );

    it.effect("reports 'missing' when the file is malformed JSON, not a thrown exception", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-live-quota-" });
        const credentialsPath = path.join(dir, ".credentials.json");
        yield* fileSystem.writeFileString(credentialsPath, "{not valid json");

        const result = yield* readClaudeAccessToken(credentialsPath);
        expect(result).toEqual({ status: "missing" });
      }),
    );

    it.effect("reads a valid access token", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-live-quota-" });
        const credentialsPath = path.join(dir, ".credentials.json");
        yield* fileSystem.writeFileString(
          credentialsPath,
          toJsonFixture({ claudeAiOauth: { accessToken: "sk-ant-oat-abc123" } }),
        );

        const result = yield* readClaudeAccessToken(credentialsPath);
        expect(result).toEqual({ status: "ok", accessToken: "sk-ant-oat-abc123" });
      }),
    );
  });

  describe("readClaudeAccountEmail", () => {
    it.effect("resolves to null when ~/.claude.json does not exist (best-effort)", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-live-quota-" });
        const claudeJsonPath = path.join(dir, ".claude.json");

        const email = yield* readClaudeAccountEmail(claudeJsonPath);
        expect(email).toBeNull();
      }),
    );

    it.effect("resolves to null when oauthAccount is absent", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-live-quota-" });
        const claudeJsonPath = path.join(dir, ".claude.json");
        yield* fileSystem.writeFileString(claudeJsonPath, toJsonFixture({}));

        const email = yield* readClaudeAccountEmail(claudeJsonPath);
        expect(email).toBeNull();
      }),
    );

    it.effect("resolves to null on malformed JSON rather than throwing", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-live-quota-" });
        const claudeJsonPath = path.join(dir, ".claude.json");
        yield* fileSystem.writeFileString(claudeJsonPath, "{not valid json");

        const email = yield* readClaudeAccountEmail(claudeJsonPath);
        expect(email).toBeNull();
      }),
    );

    it.effect("reads the email out of oauthAccount.emailAddress", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-live-quota-" });
        const claudeJsonPath = path.join(dir, ".claude.json");
        yield* fileSystem.writeFileString(
          claudeJsonPath,
          toJsonFixture({ oauthAccount: { emailAddress: "person@example.com" } }),
        );

        const email = yield* readClaudeAccountEmail(claudeJsonPath);
        expect(email).toBe("person@example.com");
      }),
    );
  });
});

describe("buildClaudeSnapshot", () => {
  it("maps five_hour into primary (300min) and seven_day into secondary (10080min)", () => {
    const snapshot = buildClaudeSnapshot(
      {
        five_hour: { utilization: 42, resets_at: "2026-08-22T17:00:00.000Z" },
        seven_day: { utilization: 8, resets_at: "2026-08-29T12:00:00.000Z" },
      },
      "person@example.com",
      NOW_MS,
    );

    expect(snapshot.provider).toBe("claude");
    expect(snapshot.source).toBe("anthropic-oauth-usage");
    expect(snapshot.accountEmail).toBe("person@example.com");
    expect(snapshot.primary).toMatchObject({
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: "2026-08-22T17:00:00.000Z",
      displayValue: "42%",
    });
    expect(snapshot.secondary).toMatchObject({
      usedPercent: 8,
      windowMinutes: 10080,
      resetsAt: "2026-08-29T12:00:00.000Z",
      displayValue: "8%",
    });
  });

  it("defaults missing utilization fields to 0 and resetsAt to null", () => {
    const snapshot = buildClaudeSnapshot({}, null, NOW_MS);
    expect(snapshot.primary.usedPercent).toBe(0);
    expect(snapshot.primary.resetsAt).toBeNull();
    expect(snapshot.secondary?.usedPercent).toBe(0);
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
    expect(snapshot.secondary?.resetDescription).toBe("Resets in 2h");
  });
});

function makeHttpLayer(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))),
    ),
  );
}

describe("fetchClaudeUsage", () => {
  it.effect("maps a 200 happy path into an 'ok' result", () =>
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
      expect(result.snapshot?.secondary?.usedPercent).toBe(3);
    }),
  );

  it.effect("maps a 401 straight to 'unauthenticated' with no refresh attempt", () =>
    Effect.gen(function* () {
      const requestedUrls: Array<string> = [];
      const layer = makeHttpLayer((request) => {
        requestedUrls.push(request.url);
        return Response.json({}, { status: 401 });
      });

      const result = yield* fetchClaudeUsage("expired-token", null, NOW_MS).pipe(
        Effect.provide(layer),
      );
      expect(result.status).toBe("unauthenticated");
      // Exactly one request (the usage read) — no refresh/token endpoint touched.
      expect(requestedUrls).toEqual([CLAUDE_OAUTH_USAGE_URL]);
      expect(requestedUrls.some((url) => /token|refresh/i.test(url))).toBe(false);
    }),
  );

  it.effect("maps a 403 straight to 'unauthenticated' with no refresh attempt", () =>
    Effect.gen(function* () {
      const requestedUrls: Array<string> = [];
      const layer = makeHttpLayer((request) => {
        requestedUrls.push(request.url);
        return Response.json({}, { status: 403 });
      });

      const result = yield* fetchClaudeUsage("expired-token", null, NOW_MS).pipe(
        Effect.provide(layer),
      );
      expect(result.status).toBe("unauthenticated");
      expect(requestedUrls).toEqual([CLAUDE_OAUTH_USAGE_URL]);
    }),
  );

  it.effect("maps any other non-200 to 'failed'", () =>
    Effect.gen(function* () {
      const layer = makeHttpLayer(() => Response.json({}, { status: 500 }));

      const result = yield* fetchClaudeUsage("sk-ant-oat-abc123", null, NOW_MS).pipe(
        Effect.provide(layer),
      );
      expect(result.status).toBe("failed");
    }),
  );
});
