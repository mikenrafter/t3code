/**
 * Disk-backed cache of import-list transcript polish fields.
 *
 * Survives browser reloads and server restarts. Entries are keyed by transcript
 * path and invalidated when size or mtime changes, so a Refresh that finds
 * unchanged files skips re-parsing JSONL.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";

const CACHE_VERSION = 1 as const;
const CACHE_FILE_NAME = "agent-session-descriptors.json";

const CachedDescriptorMeta = Schema.Struct({
  size: Schema.Number,
  mtimeMs: Schema.Number,
  providerSessionId: Schema.String,
  promptPreview: Schema.String,
  title: Schema.String,
  createdAt: Schema.String,
  lastMessageAt: Schema.String,
  hasCompactionSummary: Schema.Boolean,
  contextUsedTokens: Schema.optional(Schema.Number),
  contextUsedTokensFull: Schema.optional(Schema.Number),
  contextMaxTokens: Schema.optional(Schema.Number),
});

const CacheFile = Schema.Struct({
  version: Schema.Literal(CACHE_VERSION),
  entries: Schema.Record(Schema.String, CachedDescriptorMeta),
});

export type CachedDescriptorMeta = typeof CachedDescriptorMeta.Type;

const decodeCacheFile = Schema.decodeUnknownEffect(Schema.fromJsonString(CacheFile));
const encodeCacheFile = Schema.encodeEffect(Schema.fromJsonString(CacheFile));

export function resolveAgentSessionDescriptorCachePath(cacheDir: string, join: Path.Path["join"]) {
  return join(cacheDir, CACHE_FILE_NAME);
}

export type AgentSessionDescriptorCache = {
  readonly get: (
    filePath: string,
    identity: { readonly size: number; readonly mtimeMs: number },
  ) => CachedDescriptorMeta | null;
  readonly set: (filePath: string, meta: CachedDescriptorMeta) => void;
  readonly flush: Effect.Effect<void>;
};

export const loadAgentSessionDescriptorCache = Effect.fn("loadAgentSessionDescriptorCache")(
  function* (cacheDir: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cachePath = resolveAgentSessionDescriptorCachePath(cacheDir, path.join);
    yield* fileSystem
      .makeDirectory(cacheDir, { recursive: true })
      .pipe(Effect.orElseSucceed(() => undefined));

    const entries = new Map<string, CachedDescriptorMeta>();
    const raw = yield* fileSystem.readFileString(cachePath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length > 0) {
      const decoded = yield* decodeCacheFile(raw).pipe(Effect.orElseSucceed(() => null));
      if (decoded !== null) {
        for (const [filePath, meta] of Object.entries(decoded.entries)) {
          entries.set(filePath, meta);
        }
      }
    }

    let dirty = false;

    return {
      get: (filePath, identity) => {
        const cached = entries.get(filePath);
        if (cached === undefined) return null;
        if (cached.size !== identity.size || cached.mtimeMs !== identity.mtimeMs) return null;
        return cached;
      },
      set: (filePath, meta) => {
        const previous = entries.get(filePath);
        if (
          previous !== undefined &&
          previous.size === meta.size &&
          previous.mtimeMs === meta.mtimeMs &&
          previous.providerSessionId === meta.providerSessionId &&
          previous.promptPreview === meta.promptPreview &&
          previous.title === meta.title &&
          previous.createdAt === meta.createdAt &&
          previous.lastMessageAt === meta.lastMessageAt &&
          previous.hasCompactionSummary === meta.hasCompactionSummary &&
          previous.contextUsedTokens === meta.contextUsedTokens &&
          previous.contextUsedTokensFull === meta.contextUsedTokensFull &&
          previous.contextMaxTokens === meta.contextMaxTokens
        ) {
          return;
        }
        entries.set(filePath, meta);
        dirty = true;
      },
      flush: Effect.gen(function* () {
        if (!dirty) return;
        const payload = yield* encodeCacheFile({
          version: CACHE_VERSION,
          entries: Object.fromEntries(entries),
        });
        yield* writeFileStringAtomically({ filePath: cachePath, contents: payload }).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        dirty = false;
      }),
    } satisfies AgentSessionDescriptorCache;
  },
);
