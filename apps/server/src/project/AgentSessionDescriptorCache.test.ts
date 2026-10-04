import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  loadAgentSessionDescriptorCache,
  MAX_CACHED_DESCRIPTORS,
  resolveAgentSessionDescriptorCachePath,
  type CachedDescriptorMeta,
} from "./AgentSessionDescriptorCache.ts";

const meta = (overrides: Partial<CachedDescriptorMeta> = {}): CachedDescriptorMeta => ({
  size: 100,
  mtimeMs: 1_000,
  providerSessionId: "session-1",
  promptPreview: "preview",
  title: "Title",
  createdAt: "2026-08-24T10:00:00.000Z",
  lastMessageAt: "2026-08-24T10:05:00.000Z",
  hasCompactionSummary: false,
  ...overrides,
});

const makeCacheDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-descriptor-cache-" });
});

it.layer(NodeServices.layer)("AgentSessionDescriptorCache", (it) => {
  it.effect("keeps its file in the cache directory under a stable name", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(resolveAgentSessionDescriptorCachePath("/cache", path.join)).toBe(
        path.join("/cache", "agent-session-descriptors.json"),
      );
    }),
  );

  it.effect("returns a stored entry only while the transcript's size and mtime are unchanged", () =>
    Effect.gen(function* () {
      const cacheDir = yield* makeCacheDir;
      const cache = yield* loadAgentSessionDescriptorCache(cacheDir);
      cache.set("/sessions/a.jsonl", meta());

      assert.deepEqual(cache.get("/sessions/a.jsonl", { size: 100, mtimeMs: 1_000 }), meta());
      assert.isNull(cache.get("/sessions/a.jsonl", { size: 101, mtimeMs: 1_000 }));
      assert.isNull(cache.get("/sessions/a.jsonl", { size: 100, mtimeMs: 2_000 }));
      assert.isNull(cache.get("/sessions/other.jsonl", { size: 100, mtimeMs: 1_000 }));
    }),
  );

  it.effect("persists flushed entries for the next load, optional context fields included", () =>
    Effect.gen(function* () {
      const cacheDir = yield* makeCacheDir;
      const first = yield* loadAgentSessionDescriptorCache(cacheDir);
      const full = meta({
        contextUsedTokens: 8_000,
        contextUsedTokensFull: 100_000,
        contextMaxTokens: 200_000,
        hasCompactionSummary: true,
      });
      first.set("/sessions/a.jsonl", full);
      yield* first.flush;

      const second = yield* loadAgentSessionDescriptorCache(cacheDir);
      assert.deepEqual(second.get("/sessions/a.jsonl", { size: 100, mtimeMs: 1_000 }), full);
    }),
  );

  it.effect("does not persist entries that were never flushed", () =>
    Effect.gen(function* () {
      const cacheDir = yield* makeCacheDir;
      const first = yield* loadAgentSessionDescriptorCache(cacheDir);
      first.set("/sessions/a.jsonl", meta());

      const second = yield* loadAgentSessionDescriptorCache(cacheDir);
      assert.isNull(second.get("/sessions/a.jsonl", { size: 100, mtimeMs: 1_000 }));
    }),
  );

  it.effect("skips the write when nothing changed since the last flush", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* makeCacheDir;
      const cachePath = resolveAgentSessionDescriptorCachePath(cacheDir, path.join);
      const cache = yield* loadAgentSessionDescriptorCache(cacheDir);
      cache.set("/sessions/a.jsonl", meta());
      yield* cache.flush;
      yield* fileSystem.remove(cachePath);

      // Re-setting an identical entry and flushing again must not rewrite the file.
      cache.set("/sessions/a.jsonl", meta());
      yield* cache.flush;
      assert.isFalse(yield* fileSystem.exists(cachePath));

      cache.set("/sessions/a.jsonl", meta({ title: "Renamed" }));
      yield* cache.flush;
      assert.isTrue(yield* fileSystem.exists(cachePath));
    }),
  );

  it.effect("starts empty from a corrupt or unreadable cache file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* makeCacheDir;
      yield* fileSystem.writeFileString(
        resolveAgentSessionDescriptorCachePath(cacheDir, path.join),
        "{not json",
      );

      const cache = yield* loadAgentSessionDescriptorCache(cacheDir);

      assert.isNull(cache.get("/sessions/a.jsonl", { size: 100, mtimeMs: 1_000 }));
      cache.set("/sessions/a.jsonl", meta());
      yield* cache.flush;
      const reloaded = yield* loadAgentSessionDescriptorCache(cacheDir);
      assert.deepEqual(reloaded.get("/sessions/a.jsonl", { size: 100, mtimeMs: 1_000 }), meta());
    }),
  );

  it.effect("drops the least recently used entries past its size bound", () =>
    Effect.gen(function* () {
      const cacheDir = yield* makeCacheDir;
      const cache = yield* loadAgentSessionDescriptorCache(cacheDir);
      for (let index = 0; index < MAX_CACHED_DESCRIPTORS + 2; index += 1) {
        cache.set(`/sessions/${index}.jsonl`, meta());
      }
      // A read keeps an old entry alive past newer ones.
      cache.get("/sessions/0.jsonl", { size: 100, mtimeMs: 1_000 });
      yield* cache.flush;

      const reloaded = yield* loadAgentSessionDescriptorCache(cacheDir);
      const identity = { size: 100, mtimeMs: 1_000 };
      assert.isNotNull(reloaded.get("/sessions/0.jsonl", identity));
      assert.isNull(reloaded.get("/sessions/1.jsonl", identity));
      assert.isNull(reloaded.get("/sessions/2.jsonl", identity));
      assert.isNotNull(reloaded.get("/sessions/3.jsonl", identity));
      assert.isNotNull(reloaded.get(`/sessions/${MAX_CACHED_DESCRIPTORS + 1}.jsonl`, identity));
    }),
  );
});
