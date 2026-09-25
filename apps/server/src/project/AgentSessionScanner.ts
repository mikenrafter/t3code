/**
 * AgentSessionScanner - discovery of projects a user already works on.
 *
 * Claude Code and Codex both keep a per-session transcript on disk, and each
 * transcript records the directory the session ran in. Reading those `cwd`
 * values gives us the set of directories worth offering as projects during
 * onboarding, without asking the user to browse the filesystem.
 *
 * Cursor stores project-scoped transcripts under `~/.cursor/projects/<slug>/`
 * and chat meta under `~/.cursor/chats/<md5>/`. Context % comes from Cursor IDE
 * `state.vscdb` (`composerData:<id>`), not chat store.db. Import lists those for
 * a known workspace root only — it never walks all of ~/.cursor.
 *
 * The scan is read-only and best-effort: an unreadable home, a malformed
 * transcript, or a directory that has since been deleted is skipped rather
 * than failing the scan. Project creation stays with the client, which
 * dispatches `project.create` for whichever candidates the user picks.
 *
 * @module project/AgentSessionScanner
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import {
  AgentSessionScanError,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type AgentSessionImportSource,
  type AgentSessionProjectCandidate,
  type AgentSessionProjectGit,
  type AgentSessionScanResult,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  parseOriginUrlFromGitConfig,
} from "@t3tools/shared/git";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { loadCursorComposerContextUsageIndex } from "../provider/Layers/cursorComposerData.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  createTranscriptJsonReader,
  createTranscriptJsonSelector,
  TranscriptJsonLimitError,
} from "./AgentSessionJson.ts";
import { loadAgentSessionDescriptorCache } from "./AgentSessionDescriptorCache.ts";

/** Chunk size for full transcript reads. */
const TRANSCRIPT_PREFIX_BYTES = 32 * 1024;
/** Small reads avoid wasting the metadata budget on long Codex instruction headers. */
const METADATA_READ_BYTES = 8 * 1024;
/** Prevent malformed transcripts from turning project discovery into a full file scan. */
const MAX_TRANSCRIPT_SCAN_BYTES = 1024 * 1024;

/**
 * Upper bound on transcripts inspected (first line read) per source.
 * Newest-first ordering means the cap drops only stale sessions when a home
 * directory is unusually large.
 */
const MAX_TRANSCRIPTS_PER_SOURCE = 5000;

/**
 * Upper bound on discovery filesystem operations per source. Newest-first
 * ordering needs mtimes before the read cap can be applied, so directory reads
 * and candidate stats share a larger budget. Once it runs out the scan stops.
 */
const MAX_DISCOVERY_OPERATIONS_PER_SOURCE = MAX_TRANSCRIPTS_PER_SOURCE * 4;
const MAX_METADATA_BYTES_PER_SOURCE = 64 * 1024 * 1024;
const MAX_METADATA_OPERATIONS_PER_SOURCE = MAX_TRANSCRIPTS_PER_SOURCE * 4;
const MAX_METADATA_RECORDS_PER_SOURCE = 100_000;
const MAX_METADATA_RECORDS_PER_TRANSCRIPT = 1_000;
const RECENT_THREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Large tool results (especially screenshots) can make an otherwise ordinary
 * Codex transcript several GiB. Streaming field selection avoids allocating
 * those payloads. Raw I/O and selected history have separate budgets.
 */
const MAX_IMPORTED_TRANSCRIPT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_IMPORTED_MESSAGES = 200;
const MAX_IMPORT_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_IMPORT_TRANSCRIPTS = 100;
const MAX_IMPORT_RECORDS = 100_000;

const TranscriptContentBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});

const TranscriptMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(TranscriptContentBlock)])),
  model: Schema.optional(Schema.String),
});

const CodexTurnMetadata = Schema.Struct({
  turn_id: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});

const TranscriptRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  /** Cursor agent-transcript JSONL stores role at the top level. */
  role: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  aiTitle: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  message: Schema.optional(TranscriptMessage),
  payload: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      session_id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      role: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Array(TranscriptContentBlock)),
      internal_chat_message_metadata_passthrough: Schema.optional(Schema.Unknown),
    }),
  ),
});

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeTranscriptRecord = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptRecord));
const decodeTranscriptValue = Schema.decodeUnknownOption(TranscriptRecord);
const selectTranscriptPath = createTranscriptJsonSelector(TranscriptRecord);
const decodeCodexTurnMetadata = Schema.decodeUnknownOption(CodexTurnMetadata);

type DecodedTranscriptRecord = typeof TranscriptRecord.Type;

interface AgentSessionTranscriptMetadata {
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly fallbackSessionId: string;
  readonly lastActiveAtMs: number;
}

export interface AgentSessionThreadMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface AgentSessionThread {
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly title: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<AgentSessionThreadMessage>;
}

/**
 * What the session list needs to render a row: who owns the session, what the
 * user asked first, and when it last ran. Deliberately cheaper than
 * {@link AgentSessionThread}, which carries the imported message history.
 */
export interface AgentSessionDescriptor {
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly title: string;
  readonly promptPreview: string;
  readonly lastActiveAt: string;
  readonly cwd: string;
  /** Session creation time when the provider exposes it. */
  readonly createdAt?: string;
  /** Latest message / activity time when known. */
  readonly lastMessageAt?: string;
  readonly contextMaxTokens?: number;
  /** Compaction-mode used tokens (post-summary when compacted). */
  readonly contextUsedTokens?: number;
  /** Full-history used tokens (pre-summary peak when compacted). */
  readonly contextUsedTokensFull?: number;
  /** Native provider percent only — never derived from used/max. */
  readonly contextUsagePercent?: number;
  readonly importable?: boolean;
  readonly importBlockedReason?: string;
  readonly hasCompactionSummary?: boolean;
}

/** One provider home that could not be read, so the rest of the list still shows. */
export interface AgentSessionDescriptorFailure {
  readonly source: AgentSessionSource;
  readonly message: string;
}

export interface AgentSessionDescriptorPage {
  readonly descriptors: ReadonlyArray<AgentSessionDescriptor>;
  readonly providerErrors: ReadonlyArray<AgentSessionDescriptorFailure>;
  readonly truncated: boolean;
}

export type AgentSessionRecentThread =
  | {
      readonly _tag: "Importable";
      readonly thread: AgentSessionThread;
      readonly source: AgentSessionImportSource;
    }
  | { readonly _tag: "AlreadyImported"; readonly source: AgentSessionImportSource }
  | { readonly _tag: "Duplicate"; readonly source: AgentSessionImportSource }
  | { readonly _tag: "Skipped" };

/** Service tag for agent session discovery. */
export class AgentSessionScanner extends Context.Service<
  AgentSessionScanner,
  {
    /**
     * Discover every directory the configured Claude and Codex homes have run
     * a session in. Candidates are returned newest-first; the client decides
     * which ones to import and how far back to look. Fails with the contract
     * error directly — there is no server-local context worth wrapping.
     */
    readonly scan: Effect.Effect<AgentSessionScanResult, AgentSessionScanError>;
    readonly recentThreads: (
      workspaceRoot: string,
      completedSources?: ReadonlyArray<AgentSessionImportSource>,
      options?: { readonly historyMode?: "compaction" | "full" },
    ) => Stream.Stream<AgentSessionRecentThread, AgentSessionScanError>;
    /**
     * Newest-first descriptors for sessions that ran in `workspaceRoot`, read
     * without parsing whole transcripts. A home that cannot be read reports a
     * provider error instead of failing the page.
     */
    readonly listRecentSessionDescriptors: (
      workspaceRoot: string,
      limit: number,
    ) => Effect.Effect<AgentSessionDescriptorPage, AgentSessionScanError>;
  }
>()("t3/project/AgentSessionScanner") {}

type AgentSessionSource = AgentSessionProjectCandidate["sources"][number];

/** A single directory's worth of evidence from one source. */
interface RawCandidate {
  readonly cwd: string;
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadCount: number;
  readonly lastActiveAtMs: number | null;
  readonly transcripts: ReadonlyArray<{
    readonly filePath: string;
    readonly mtimeMs: number | null;
    /** Cursor chat meta `name`, when the store.db row is readable. */
    readonly titleOverride?: string;
    readonly createdAtMs?: number;
    readonly lastUpdatedAtMs?: number;
    readonly contextUsagePercent?: number;
  }>;
}

interface TranscriptCandidate {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly providerInstanceId: ProviderInstanceId;
  readonly size: number;
}

interface MetadataReadBudget {
  bytesRemaining: number;
  operationsRemaining: number;
  recordsRemaining: number;
  truncated: boolean;
}

function selectMetadataTranscripts(transcripts: ReadonlyArray<TranscriptCandidate>) {
  const selected: Array<TranscriptCandidate> = [];
  let pending = Array.from(
    Map.groupBy(transcripts, (transcript) => transcript.providerInstanceId).values(),
    (entries) => entries.values(),
  );
  while (pending.length > 0 && selected.length < MAX_TRANSCRIPTS_PER_SOURCE) {
    const nextRound: typeof pending = [];
    for (const iterator of pending) {
      if (selected.length === MAX_TRANSCRIPTS_PER_SOURCE) break;
      const next = iterator.next();
      if (next.done) continue;
      selected.push(next.value);
      nextRound.push(iterator);
    }
    pending = nextRound;
  }
  return selected;
}

function splitTranscriptRecords(contents: string, limit: number): string[] {
  const records = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  return records.split("\n", limit);
}

function extractText(
  content: string | ReadonlyArray<typeof TranscriptContentBlock.Type> | undefined,
): string {
  if (typeof content === "string") return content.trim();
  if (content === undefined) return "";
  return content
    .filter(
      (block) =>
        block.type === "text" || block.type === "input_text" || block.type === "output_text",
    )
    .map((block) => block.text?.trim() ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

/** Cursor wraps prompts in `<user_query>` and often prefixes `<timestamp>`; strip both. */
function stripHarnessMarkup(text: string): string {
  let next = text.trim();
  const userQuery = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(next);
  if (userQuery?.[1]?.trim()) {
    next = userQuery[1].trim();
  }
  next = next
    // Drop tagged harness blocks entirely (tags + body), not just the tags.
    .replace(/<timestamp\b[^>]*>[\s\S]*?<\/timestamp>/gi, " ")
    .replace(/<\/?timestamp\b[^>]*>/gi, " ")
    .replace(/<\/?user_query\b[^>]*>/gi, " ")
    .replace(/<user_info\b[^>]*>[\s\S]*?<\/user_info>/gi, " ")
    .replace(/<runtime_info\b[^>]*>[\s\S]*?<\/runtime_info>/gi, " ")
    .replace(/<pull_request_linking\b[^>]*>[\s\S]*?<\/pull_request_linking>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return next;
}

/** @deprecated Prefer {@link stripHarnessMarkup}. */
function stripUserQueryWrapper(text: string): string {
  return stripHarnessMarkup(text);
}

/**
 * Skip system / environment dumps and harness scaffolding CLIs sometimes write
 * as the first "user" record so Import previews stay legible. Long real prompts
 * are fine — only reject dumps and tag-heavy scaffolding.
 */
function isUsableListPreviewText(text: string): boolean {
  const trimmed = stripHarnessMarkup(text);
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("<user_info") ||
    lower.startsWith("<system") ||
    lower.startsWith("<environment") ||
    lower.startsWith("<agent_transcripts") ||
    lower.startsWith("<runtime_info") ||
    lower.startsWith("<pull_request_linking") ||
    lower.startsWith("<recommended_plugins") ||
    lower.startsWith("<timestamp") ||
    lower.startsWith("# system") ||
    // System-persona dumps, not ordinary prompts like "You are reviewing…".
    lower.startsWith("you are a ") ||
    lower.startsWith("you are an ") ||
    lower.startsWith("you are the ") ||
    // Cursor agent↔harness status lines / follow-up directives — not titles.
    lower.startsWith("give the user ") ||
    lower.startsWith("i'll give the user ") ||
    lower.startsWith("i will give the user ") ||
    lower.startsWith("briefly inform the user") ||
    lower.startsWith("inform the user about") ||
    lower.startsWith("inform the user of") ||
    lower.includes("perform any follow-up actions") ||
    lower.startsWith("the background skill command") ||
    lower === "done" ||
    lower === "ok" ||
    (lower.includes("claude.md") && trimmed.length > 400)
  ) {
    return false;
  }
  const tagChars = (trimmed.match(/[<>]/g) ?? []).length;
  if (tagChars > 20 && tagChars / trimmed.length > 0.08) return false;
  return true;
}

/** Cursor IDE default titles — prefer the first real user prompt instead. */
function isGenericCursorChatTitle(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "new agent" ||
    normalized === "new chat" ||
    normalized === "untitled" ||
    normalized === "agent" ||
    normalized === "composer"
  );
}

function truncatePreview(text: string, maxChars = 280): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Cursor project folder name for a cwd: `/a/b` → `a-b`. Matches the IDE/CLI layout under
 * `~/.cursor/projects/<slug>/agent-transcripts`.
 */
export function cursorProjectSlug(cwd: string): string {
  return cwd.replaceAll("\\", "/").replace(/^\//, "").replaceAll("/", "-");
}

/** Cursor chat meta directory key: `md5(cwd)` under `~/.cursor/chats`. */
export function cursorChatDirectoryHash(cwd: string): string {
  return NodeCrypto.createHash("md5").update(cwd).digest("hex");
}

interface CursorChatMeta {
  readonly name: string | null;
  readonly createdAtMs: number | null;
  readonly lastUpdatedAtMs: number | null;
  readonly isSubagent: boolean;
}

/** Read title / timestamps / subagent flag from `chats/<md5>/<agentId>/store.db`. */
function readCursorChatMeta(storeDbPath: string): CursorChatMeta | null {
  try {
    const db = new NodeSqlite.DatabaseSync(storeDbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("0") as
        | { readonly value: string | Uint8Array }
        | undefined;
      if (row === undefined) return null;
      const raw =
        typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
      let jsonText: string;
      try {
        jsonText = Buffer.from(raw, "hex").toString("utf8");
      } catch {
        jsonText = raw;
      }
      const parsed = JSON.parse(jsonText) as {
        readonly name?: unknown;
        readonly createdAt?: unknown;
        readonly lastUpdatedAt?: unknown;
        readonly subagentInfo?: unknown;
      };
      const name =
        typeof parsed.name === "string" && parsed.name.trim().length > 0
          ? parsed.name.trim()
          : null;
      const createdAtMs =
        typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt)
          ? parsed.createdAt
          : null;
      const lastUpdatedAtMs =
        typeof parsed.lastUpdatedAt === "number" && Number.isFinite(parsed.lastUpdatedAt)
          ? parsed.lastUpdatedAt
          : null;
      return {
        name,
        createdAtMs,
        lastUpdatedAtMs,
        isSubagent: parsed.subagentInfo != null,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/**
 * Codex context fill from rollout JSONL. Prefer `token_count` (used + max);
 * `token_usage_record` / `task_started` fill gaps. Never invents a percent.
 */
function extractCodexContextFields(parsed: Record<string, unknown>): {
  readonly contextUsedTokens: number | null;
  readonly contextMaxTokens: number | null;
} {
  const empty = { contextUsedTokens: null, contextMaxTokens: null } as const;
  const payload = parsed.payload;
  if (typeof payload !== "object" || payload === null) return empty;
  const body = payload as Record<string, unknown>;

  if (parsed.type === "token_usage_record") {
    const usage = body.usage;
    if (typeof usage !== "object" || usage === null) return empty;
    return {
      contextUsedTokens: nonNegativeInt((usage as Record<string, unknown>).total_tokens),
      contextMaxTokens: null,
    };
  }

  if (parsed.type !== "event_msg") return empty;

  if (body.type === "task_started") {
    return {
      contextUsedTokens: null,
      contextMaxTokens: positiveInt(body.model_context_window),
    };
  }

  if (body.type !== "token_count") return empty;
  const info = body.info;
  if (typeof info !== "object" || info === null) return empty;
  const infoRecord = info as Record<string, unknown>;
  const last = infoRecord.last_token_usage;
  const used =
    typeof last === "object" && last !== null
      ? nonNegativeInt((last as Record<string, unknown>).total_tokens)
      : null;
  return {
    contextUsedTokens: used,
    contextMaxTokens: positiveInt(infoRecord.model_context_window),
  };
}

/**
 * Claude active-context tokens from an assistant message, matching
 * ClaudeAdapter's input+cache(+output/total) active usage calc. Sidechains
 * skipped. Max window is rarely on disk — used alone is enough for the list.
 */
function extractClaudeContextUsedTokens(parsed: Record<string, unknown>): number | null {
  if (parsed.type !== "assistant" || parsed.isSidechain === true) return null;
  const message = parsed.message;
  if (typeof message !== "object" || message === null) return null;
  const usage = (message as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;
  const iterations = Array.isArray(usageRecord.iterations) ? usageRecord.iterations : [];
  const active =
    [...iterations]
      .reverse()
      .find(
        (iteration): iteration is Record<string, unknown> =>
          iteration !== null && typeof iteration === "object" && !Array.isArray(iteration),
      ) ?? usageRecord;
  const inputTokens =
    (nonNegativeInt(active.input_tokens) ?? 0) +
    (nonNegativeInt(active.cache_creation_input_tokens) ?? 0) +
    (nonNegativeInt(active.cache_read_input_tokens) ?? 0);
  const outputTokens = nonNegativeInt(active.output_tokens) ?? 0;
  const explicitTotal = nonNegativeInt(active.total_tokens);
  const activeTokens =
    explicitTotal !== null && explicitTotal > 0 ? explicitTotal : inputTokens + outputTokens;
  return activeTokens > 0 ? activeTokens : null;
}

/**
 * Pick used tokens for the list row under the current history mode.
 * Compaction → last post-summary usage when a compact summary exists;
 * full → last pre-summary usage (peak of the retained full history).
 */
function selectContextUsedForHistoryMode(input: {
  readonly historyMode: "compaction" | "full";
  readonly hasCompactionSummary: boolean;
  readonly usedBeforeCompaction: number | null;
  readonly usedAfterCompaction: number | null;
}): number | null {
  const { historyMode, hasCompactionSummary, usedBeforeCompaction, usedAfterCompaction } = input;
  if (!hasCompactionSummary) {
    return usedAfterCompaction ?? usedBeforeCompaction;
  }
  if (historyMode === "compaction") {
    return usedAfterCompaction ?? usedBeforeCompaction;
  }
  return usedBeforeCompaction ?? usedAfterCompaction;
}

function normalizeTimestamp(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : fallback;
}

function codexTurnId(metadata: unknown): string | null {
  const decoded = decodeCodexTurnMetadata(metadata);
  if (
    Option.isNone(decoded) ||
    typeof decoded.value.turn_id !== "string" ||
    decoded.value.turn_id.trim().length === 0
  ) {
    return null;
  }
  return decoded.value.turn_id;
}

/** Keep visible user and assistant text while ignoring tools, reasoning, and malformed records. */
export function parseAgentSessionTranscript(
  input: AgentSessionTranscriptMetadata & {
    readonly contents: string;
    /**
     * `compaction` keeps compact-summary records and drops older pre-summary
     * history (except the first user message). `full` skips compact summaries
     * and retains older messages up to the import cap. Defaults to compaction.
     */
    readonly historyMode?: "compaction" | "full";
  },
  lines = splitTranscriptRecords(input.contents, MAX_IMPORT_RECORDS + 1),
): AgentSessionThread | null {
  if (lines.length > MAX_IMPORT_RECORDS) return null;
  const records = lines.flatMap((line) => Option.toArray(decodeTranscriptRecord(line)));
  return parseAgentSessionRecords(input, records);
}

type ParsedSessionMessage = AgentSessionThreadMessage & {
  readonly codexResponseUser: boolean;
  readonly isCompactSummary: boolean;
};

function parseAgentSessionRecords(
  input: AgentSessionTranscriptMetadata & {
    readonly historyMode?: "compaction" | "full";
  },
  records: ReadonlyArray<DecodedTranscriptRecord>,
): AgentSessionThread | null {
  const historyMode = input.historyMode ?? "compaction";
  const fallbackTimestamp = DateTime.formatIso(DateTime.makeUnsafe(input.lastActiveAtMs));
  // Claude filenames are session IDs. Codex rollout filenames include extra
  // timestamp text, so only transcript metadata can provide a resumable ID.
  let providerSessionId = input.source === "codex" ? "" : input.fallbackSessionId;
  let title: string | null = null;
  let model: string | null = null;
  let hasCodexSessionId = false;
  const messages: Array<ParsedSessionMessage> = [];
  let firstUserMessage: ParsedSessionMessage | undefined;
  // A Codex response item can include generated setup text beside the real
  // prompt. Suppress response-user records only when the shared turn ID and a
  // verbatim event copy prove which prompt the user submitted.
  const canonicalCodexResponseUserIndices = new Set<number>();
  let canonicalUserTextsInTurn = new Set<string>();
  let responseUsersInTurn: Array<{
    readonly index: number;
    readonly turnId: string;
    readonly text: string;
  }> = [];
  const finishCodexTurn = () => {
    const canonicalTurnIds = new Set(
      responseUsersInTurn.flatMap((responseUser) =>
        canonicalUserTextsInTurn.has(responseUser.text) ? [responseUser.turnId] : [],
      ),
    );
    for (const responseUser of responseUsersInTurn) {
      if (canonicalTurnIds.has(responseUser.turnId)) {
        canonicalCodexResponseUserIndices.add(responseUser.index);
      }
    }
    canonicalUserTextsInTurn = new Set();
    responseUsersInTurn = [];
  };
  if (input.source === "codex") {
    let recordIndex = -1;
    for (const record of records) {
      recordIndex += 1;
      if (
        record.type === "response_item" &&
        record.payload?.type === "message" &&
        record.payload.role === "assistant"
      ) {
        finishCodexTurn();
        continue;
      }
      if (record.type === "event_msg" && record.payload?.type === "user_message") {
        const text = record.payload.message?.trim() ?? "";
        if (text.length > 0) canonicalUserTextsInTurn.add(text);
        continue;
      }
      if (
        record.type === "response_item" &&
        record.payload?.type === "message" &&
        record.payload.role === "user"
      ) {
        const turnId = codexTurnId(record.payload.internal_chat_message_metadata_passthrough);
        const text = extractText(record.payload.content);
        if (turnId !== null && text.length > 0) {
          responseUsersInTurn.push({ index: recordIndex, turnId, text });
        }
      }
    }
    finishCodexTurn();
  }

  const retainMessage = (message: ParsedSessionMessage) => {
    if (firstUserMessage === undefined && message.role === "user") {
      firstUserMessage = message;
    }
    messages.push(message);
    if (messages.length > MAX_IMPORTED_MESSAGES) messages.shift();
  };

  const hasMatchingCodexEventInTurn = (text: string) => {
    const comparisonText = text.trim();
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === "assistant") return false;
      if (
        message?.role === "user" &&
        !message.codexResponseUser &&
        message.text.trim() === comparisonText
      ) {
        return true;
      }
    }
    return false;
  };

  let recordIndex = -1;
  for (const record of records) {
    recordIndex += 1;
    if (input.source === "cursor") {
      const role =
        record.role === "user" || record.role === "assistant"
          ? record.role
          : record.message?.role === "user" || record.message?.role === "assistant"
            ? record.message.role
            : null;
      if (role === null) continue;
      const text = stripUserQueryWrapper(extractText(record.message?.content));
      if (text.length === 0) continue;
      retainMessage({
        role,
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
        isCompactSummary: false,
      });
      continue;
    }
    if (input.source === "claudeAgent") {
      if (record.isSidechain === true || record.isMeta === true) {
        continue;
      }
      const isCompactSummary = record.isCompactSummary === true;
      if (isCompactSummary && historyMode === "full") {
        continue;
      }
      if (record.sessionId?.trim()) providerSessionId = record.sessionId.trim();
      if (record.aiTitle?.trim()) title = record.aiTitle.trim();
      const messageModel = record.message?.model?.trim();
      // Claude uses this sentinel for local error responses. It is not a
      // model ID that can be selected when the imported session resumes.
      if (messageModel && messageModel !== "<synthetic>") model = messageModel;
      if (record.type !== "user" && record.type !== "assistant") {
        continue;
      }

      const text = extractText(record.message?.content);
      if (text.length === 0) continue;
      retainMessage({
        role: record.type,
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
        isCompactSummary,
      });
      continue;
    }

    if (record.type === "session_meta") {
      const sessionId = record.payload?.id?.trim() || record.payload?.session_id?.trim();
      if (!hasCodexSessionId && sessionId) {
        providerSessionId = sessionId;
        hasCodexSessionId = true;
      }
      continue;
    }
    if (record.type === "turn_context" && record.payload?.model?.trim()) {
      model = record.payload.model.trim();
      continue;
    }
    if (record.type === "event_msg" && record.payload?.type === "user_message") {
      const text = record.payload.message ?? "";
      if (text.trim().length === 0) continue;
      // Codex can write the same prompt as both a response item and an event.
      // Remove only the matching response copy so mixed-format logs keep every
      // distinct user message.
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role === "assistant") break;
        if (message?.codexResponseUser === true && message.text.trim() === text.trim()) {
          if (firstUserMessage === message) firstUserMessage = undefined;
          messages.splice(index, 1);
          break;
        }
      }
      retainMessage({
        role: "user",
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
        isCompactSummary: false,
      });
      continue;
    }
    if (
      record.type !== "response_item" ||
      record.payload?.type !== "message" ||
      (record.payload.role !== "user" && record.payload.role !== "assistant")
    ) {
      continue;
    }

    const extractedText = extractText(record.payload.content);
    if (extractedText.length === 0) continue;
    if (record.payload.role === "user" && canonicalCodexResponseUserIndices.has(recordIndex)) {
      continue;
    }
    if (record.payload.role === "user" && hasMatchingCodexEventInTurn(extractedText)) {
      continue;
    }
    retainMessage({
      role: record.payload.role,
      text: extractedText,
      createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
      codexResponseUser: record.payload.role === "user",
      isCompactSummary: false,
    });
  }

  if (providerSessionId.trim().length === 0 || firstUserMessage === undefined) return null;
  const firstUserMessageRetained = messages.includes(firstUserMessage);
  let retainedInternal = firstUserMessageRetained
    ? messages
    : [firstUserMessage, ...messages.slice(-(MAX_IMPORTED_MESSAGES - 1))];

  if (historyMode === "compaction") {
    let lastCompactIndex = -1;
    for (let index = retainedInternal.length - 1; index >= 0; index--) {
      if (retainedInternal[index]?.isCompactSummary === true) {
        lastCompactIndex = index;
        break;
      }
    }
    if (lastCompactIndex >= 0) {
      const afterCompact = retainedInternal.slice(lastCompactIndex);
      const firstUser = retainedInternal.find((message) => message.role === "user");
      retainedInternal =
        firstUser !== undefined && !afterCompact.includes(firstUser)
          ? [firstUser, ...afterCompact]
          : afterCompact;
    }
  }

  const stripInternal = ({
    codexResponseUser: _codexResponseUser,
    isCompactSummary: _isCompactSummary,
    ...message
  }: ParsedSessionMessage): AgentSessionThreadMessage => message;
  const retainedMessages = retainedInternal.map(stripInternal);
  const visibleFirstUserMessage = stripInternal(firstUserMessage);
  const derivedTitle = visibleFirstUserMessage.text.trim().split("\n")[0]?.slice(0, 100).trim();

  return {
    source: input.source,
    providerInstanceId: input.providerInstanceId,
    providerSessionId,
    title: title ?? (derivedTitle && derivedTitle.length > 0 ? derivedTitle : "Imported thread"),
    model,
    createdAt: retainedMessages[0]?.createdAt ?? fallbackTimestamp,
    updatedAt: fallbackTimestamp,
    messages: retainedMessages,
  };
}

function extractDecodedCwd(record: DecodedTranscriptRecord): string | null {
  const cwd = record.cwd?.trim() || record.payload?.cwd?.trim();
  return cwd && cwd.length > 0 ? cwd : null;
}

/** Session id / first usable prompt / last assistant / title from one JSONL record. */
function extractDescriptorFields(
  source: AgentSessionSource,
  line: string,
): {
  readonly cwd: string | null;
  readonly sessionId: string | null;
  readonly prompt: string | null;
  readonly assistantPreview: string | null;
  /** User record that failed usability — suppress following harness status replies. */
  readonly harnessUser: boolean;
  readonly title: string | null;
  readonly timestamp: string | null;
  readonly isCompactSummary: boolean;
  readonly contextUsedTokens: number | null;
  readonly contextMaxTokens: number | null;
} {
  const empty = {
    cwd: null,
    sessionId: null,
    prompt: null,
    assistantPreview: null,
    harnessUser: false,
    title: null,
    timestamp: null,
    isCompactSummary: false,
    contextUsedTokens: null,
    contextMaxTokens: null,
  } as const;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) return empty;
  const record = parsed as DecodedTranscriptRecord;
  const cwd = extractDecodedCwd(record);
  const timestamp =
    typeof record.timestamp === "string" && record.timestamp.trim().length > 0
      ? record.timestamp.trim()
      : null;
  const isCompactSummary = record.isCompactSummary === true;
  if (source === "cursor") {
    const sessionId = record.sessionId?.trim() || null;
    let prompt: string | null = null;
    let assistantPreview: string | null = null;
    let harnessUser = false;
    const role =
      record.role === "user" || record.role === "assistant"
        ? record.role
        : record.message?.role === "user" || record.message?.role === "assistant"
          ? record.message.role
          : null;
    if (role === "user") {
      const text = stripHarnessMarkup(extractText(record.message?.content));
      if (isUsableListPreviewText(text)) prompt = text;
      else harnessUser = text.trim().length > 0;
    } else if (role === "assistant") {
      const text = stripHarnessMarkup(extractText(record.message?.content));
      if (isUsableListPreviewText(text)) assistantPreview = text;
    }
    return {
      cwd,
      sessionId,
      prompt,
      assistantPreview,
      harnessUser,
      title: null,
      timestamp,
      isCompactSummary,
      contextUsedTokens: null,
      contextMaxTokens: null,
    };
  }
  if (source === "claudeAgent") {
    const sessionId = record.sessionId?.trim() || null;
    const title = record.aiTitle?.trim() || null;
    let prompt: string | null = null;
    let assistantPreview: string | null = null;
    let harnessUser = false;
    if (record.isSidechain !== true && record.isMeta !== true && record.isCompactSummary !== true) {
      if (record.type === "user") {
        const text = extractText(record.message?.content);
        if (isUsableListPreviewText(text)) prompt = text;
        else harnessUser = text.trim().length > 0;
      } else if (record.type === "assistant") {
        const text = extractText(record.message?.content);
        if (isUsableListPreviewText(text)) assistantPreview = text;
      }
    }
    return {
      cwd,
      sessionId,
      prompt,
      assistantPreview,
      harnessUser,
      title,
      timestamp,
      isCompactSummary,
      contextUsedTokens: extractClaudeContextUsedTokens(parsed as Record<string, unknown>),
      contextMaxTokens: null,
    };
  }
  const context = extractCodexContextFields(parsed as Record<string, unknown>);
  let sessionId: string | null = null;
  if (record.type === "session_meta") {
    sessionId = record.payload?.id?.trim() || record.payload?.session_id?.trim() || null;
  }
  let prompt: string | null = null;
  let assistantPreview: string | null = null;
  let harnessUser = false;
  if (record.type === "event_msg" && record.payload?.type === "user_message") {
    const text = record.payload.message?.trim() ?? "";
    if (isUsableListPreviewText(text)) prompt = text;
    else harnessUser = text.length > 0;
  } else if (record.type === "response_item" && record.payload?.type === "message") {
    const text = extractText(record.payload.content);
    if (record.payload.role === "user") {
      if (isUsableListPreviewText(text)) prompt = text;
      else harnessUser = text.trim().length > 0;
    } else if (record.payload.role === "assistant") {
      if (isUsableListPreviewText(text)) assistantPreview = text;
    }
  }
  return {
    cwd,
    sessionId,
    prompt,
    assistantPreview,
    harnessUser,
    title: null,
    timestamp,
    isCompactSummary,
    contextUsedTokens: context.contextUsedTokens,
    contextMaxTokens: context.contextMaxTokens,
  };
}

function shouldRetainDecodedRecord(
  source: AgentSessionSource,
  record: DecodedTranscriptRecord,
): boolean {
  if (extractDecodedCwd(record) !== null) return true;
  if (source === "cursor") {
    return (
      record.role === "user" || record.role === "assistant" || record.message?.content !== undefined
    );
  }
  if (source === "claudeAgent") {
    return (
      record.type === "user" ||
      record.type === "assistant" ||
      record.sessionId !== undefined ||
      record.aiTitle !== undefined ||
      record.message?.model !== undefined
    );
  }
  return (
    record.type === "session_meta" ||
    record.type === "turn_context" ||
    (record.type === "event_msg" && record.payload?.type === "user_message") ||
    (record.type === "response_item" &&
      record.payload?.type === "message" &&
      (record.payload.role === "user" || record.payload.role === "assistant"))
  );
}

/**
 * T3 Code runs its own agent sessions inside disposable worktrees. Their
 * transcripts look exactly like user sessions, but re-importing the app's own
 * sandboxes as projects is never right. Matches this server's configured
 * worktrees directory plus the conventional `.t3/worktrees` layout, which
 * also catches sandboxes from other T3 homes on the same machine. Separators
 * are normalized (and, on Windows, case folded) so the prefix match holds
 * there too. Callers check both the recorded spelling and its realpath so a
 * symlink into the worktrees directory cannot bypass the filter.
 */
function normalizeForWorktreeMatch(value: string, caseFold: boolean): string {
  const normalized = `${value.replaceAll("\\", "/")}/`;
  return caseFold ? normalized.toLowerCase() : normalized;
}

function isT3ManagedWorktree(
  candidatePath: string,
  worktreesDir: string,
  caseFold: boolean,
): boolean {
  const normalized = normalizeForWorktreeMatch(candidatePath, caseFold);
  return (
    normalized.startsWith(normalizeForWorktreeMatch(worktreesDir, caseFold)) ||
    normalized.includes("/.t3/worktrees/")
  );
}

/** Extract `cwd` from a session-meta record, tolerating the shapes each CLI writes. */
function extractCwd(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (typeof record.cwd === "string" && record.cwd.trim().length > 0) {
    return record.cwd;
  }
  // Codex nests session metadata under `payload`.
  const payload = record.payload;
  if (typeof payload === "object" && payload !== null) {
    const nested = (payload as Record<string, unknown>).cwd;
    if (typeof nested === "string" && nested.trim().length > 0) {
      return nested;
    }
  }
  return null;
}

function transcriptIdentity(filePath: string, stats: FileSystem.File.Info) {
  return {
    filePath,
    size: Number(stats.size),
    mtimeMs: Option.match(stats.mtime, { onNone: () => null, onSome: (date) => date.getTime() }),
    device: stats.dev,
    inode: Option.getOrNull(stats.ino),
    birthtimeMs: Option.match(stats.birthtime, {
      onNone: () => null,
      onSome: (date) => date.getTime(),
    }),
  };
}

function sameTranscriptIdentity(
  left: ReturnType<typeof transcriptIdentity>,
  right: ReturnType<typeof transcriptIdentity>,
): boolean {
  return (
    left.filePath === right.filePath &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeMs === right.birthtimeMs
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  // Different project imports can arrive concurrently from multiple clients.
  // Only one transcript may hold its selected-history budget at a time.
  const importReadLock = yield* Semaphore.make(1);
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const baseDir = path.resolve(serverConfig.baseDir);
  const worktreesDir = path.resolve(serverConfig.worktreesDir);
  // Windows filesystems are case-insensitive, so path prefix checks there
  // must case fold.
  const foldWorktreeCase = (yield* HostProcessPlatform) === "win32";
  const hostEnvironment = yield* HostProcessEnvironment;
  const homeDir = NodeOS.homedir();
  const descriptorCache = yield* loadAgentSessionDescriptorCache(
    serverConfig.providerStatusCacheDir,
  );
  // `/private/tmp` is what macOS reports for sessions started in `/tmp`.
  const excludedProjectRoots = new Set(
    [homeDir, NodeOS.tmpdir(), "/tmp", "/private/tmp"].map((directory) =>
      normalizeProjectPathForComparison(path.resolve(directory)),
    ),
  );
  // Codex creates one scratch directory per conversation under
  // ~/Documents/Codex/<date>/<slug>. Neither those nor anything a user
  // unpacked into Downloads is a project.
  const excludedProjectAncestors = [
    path.join(homeDir, "Downloads"),
    path.join(homeDir, "Documents", "Codex"),
  ];

  const isExcludedProjectPath = (candidatePath: string) =>
    excludedProjectRoots.has(normalizeProjectPathForComparison(candidatePath)) ||
    excludedProjectAncestors.some((ancestor) =>
      normalizeForWorktreeMatch(candidatePath, foldWorktreeCase).startsWith(
        normalizeForWorktreeMatch(ancestor, foldWorktreeCase),
      ),
    ) ||
    normalizeForWorktreeMatch(candidatePath, foldWorktreeCase).startsWith(
      normalizeForWorktreeMatch(baseDir, foldWorktreeCase),
    ) ||
    isT3ManagedWorktree(candidatePath, worktreesDir, foldWorktreeCase);

  const listDirectory = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const statOption = (target: string) =>
    fileSystem.stat(target).pipe(Effect.map(Option.some), Effect.orElseSucceed(Option.none));

  /** Match directory aliases without assuming the host volume is case-insensitive. */
  const directoryIdentity = Effect.fn("AgentSessionScanner.directoryIdentity")(function* (
    target: string,
    knownStats?: FileSystem.File.Info,
  ) {
    const resolved = path.resolve(target);
    const stats = knownStats === undefined ? yield* statOption(resolved) : Option.some(knownStats);
    if (
      Option.isSome(stats) &&
      Option.isSome(stats.value.ino) &&
      Number.isSafeInteger(stats.value.ino.value) &&
      stats.value.ino.value > 0
    ) {
      return `inode:${stats.value.dev}:${stats.value.ino.value}`;
    }
    const realPath = yield* fileSystem
      .realPath(resolved)
      .pipe(Effect.orElseSucceed(() => resolved));
    return `path:${normalizeProjectPathForComparison(realPath)}`;
  });

  /**
   * Git identity of a directory, or the reason it has none. Reads `.git`
   * directly instead of spawning git so a scan over hundreds of candidates
   * stays cheap. A `.git` file is a `gitdir:` pointer. When it points into a
   * `worktrees/` directory the checkout is a linked worktree, which
   * onboarding skips because its history belongs to the main checkout.
   * Submodules use the same pointer shape but live under `modules/`, and
   * are offered like any other repository.
   */
  const readGitIdentity = Effect.fn("AgentSessionScanner.readGitIdentity")(function* (
    directory: string,
  ): Effect.fn.Return<
    | { readonly _tag: "Repository"; readonly git: AgentSessionProjectGit | null }
    | { readonly _tag: "Worktree" }
    | { readonly _tag: "NotGit" }
  > {
    const gitPath = path.join(directory, ".git");
    const gitStats = yield* statOption(gitPath);
    if (Option.isNone(gitStats)) return { _tag: "NotGit" } as const;
    let gitDir = gitPath;
    if (gitStats.value.type !== "Directory") {
      const pointer = yield* fileSystem
        .readFileString(gitPath)
        .pipe(Effect.orElseSucceed(() => ""));
      const target = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
      if (target === undefined || target.length === 0) return { _tag: "NotGit" } as const;
      gitDir = path.resolve(directory, target);
      if (/[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitDir)) return { _tag: "Worktree" } as const;
    }
    const configText = yield* fileSystem
      .readFileString(path.join(gitDir, "config"))
      .pipe(Effect.orElseSucceed(() => ""));
    const originUrl = parseOriginUrlFromGitConfig(configText);
    return {
      _tag: "Repository",
      git: {
        remoteKey: originUrl === null ? null : normalizeGitRemoteUrl(originUrl),
        repository: parseGitHubRepositoryNameWithOwnerFromRemoteUrl(originUrl),
      },
    } as const;
  });

  // A large history snapshot can precede session metadata. Read bounded
  // chunks until a complete record names its cwd or the safety budget ends.
  const readCwd = Effect.fn("AgentSessionScanner.readCwd")(function* (
    transcript: TranscriptCandidate,
    budget: MetadataReadBudget,
  ) {
    if (transcript.size === 0) return null;
    if (
      budget.bytesRemaining === 0 ||
      budget.operationsRemaining < 2 ||
      budget.recordsRemaining === 0
    ) {
      budget.truncated = true;
      return null;
    }
    budget.operationsRemaining -= 1;
    return yield* Effect.scoped(
      fileSystem.open(transcript.filePath, { flag: "r" }).pipe(
        Effect.flatMap((file) =>
          Effect.gen(function* () {
            const decoder = new TextDecoder();
            let remaining = "";
            let bytesRead = 0;
            let recordsRead = 0;
            const maxBytes = Math.min(MAX_TRANSCRIPT_SCAN_BYTES, transcript.size);
            const reserveRecord = () => {
              if (
                recordsRead === MAX_METADATA_RECORDS_PER_TRANSCRIPT ||
                budget.recordsRemaining === 0
              ) {
                budget.truncated = true;
                return false;
              }
              recordsRead += 1;
              budget.recordsRemaining -= 1;
              return true;
            };
            const readLastRecord = () => {
              const record = remaining + decoder.decode();
              return record.length === 0 || !reserveRecord() ? null : extractCwd(record.trim());
            };

            while (bytesRead < maxBytes) {
              if (budget.bytesRemaining === 0 || budget.operationsRemaining === 0) {
                budget.truncated = true;
                return null;
              }
              const readSize = Math.min(
                METADATA_READ_BYTES,
                maxBytes - bytesRead,
                budget.bytesRemaining,
              );
              budget.operationsRemaining -= 1;
              budget.bytesRemaining -= readSize;
              const next = yield* file.readAlloc(readSize);
              if (Option.isNone(next)) {
                return readLastRecord();
              }

              bytesRead += next.value.byteLength;
              remaining += decoder.decode(next.value, { stream: true });
              const lines = remaining.split("\n");
              remaining = lines.pop() ?? "";

              for (const line of lines) {
                if (!reserveRecord()) return null;
                const cwd = extractCwd(line.trim());
                if (cwd !== null) return cwd;
              }
            }

            if (bytesRead < transcript.size) {
              budget.truncated = true;
              return null;
            }
            return readLastRecord();
          }),
        ),
      ),
    ).pipe(Effect.orElseSucceed(() => null));
  });

  /**
   * Read just enough of a transcript to name the session and its first prompt.
   * Continues within the forward budget for timestamps and compaction flags so
   * oversized / compacted sessions still get accurate list polish fields.
   */
  const readDescriptorMeta = Effect.fn("AgentSessionScanner.readDescriptorMeta")(function* (
    source: AgentSessionSource,
    transcript: TranscriptCandidate & { readonly mtimeMs: number },
  ) {
    if (transcript.size === 0) return null;
    const fallbackSessionId = path.basename(transcript.filePath, ".jsonl");
    const fallbackTimestamp = DateTime.formatIso(DateTime.makeUnsafe(transcript.mtimeMs));
    return yield* Effect.scoped(
      fileSystem.open(transcript.filePath, { flag: "r" }).pipe(
        Effect.flatMap((file) =>
          Effect.gen(function* () {
            const decoder = new TextDecoder();
            let remaining = "";
            let bytesRead = 0;
            let recordsRead = 0;
            let sessionId = source === "codex" ? "" : fallbackSessionId;
            let prompt: string | null = null;
            let assistantPreview: string | null = null;
            let suppressAssistantPreview = false;
            let title: string | null = null;
            let firstTimestamp: string | null = null;
            let lastTimestamp: string | null = null;
            let hasCompactionSummary = false;
            let usedBeforeCompaction: number | null = null;
            let usedAfterCompaction: number | null = null;
            let contextMaxTokens: number | null = null;
            const maxBytes = Math.min(MAX_TRANSCRIPT_SCAN_BYTES, transcript.size);

            const consider = (line: string) => {
              const fields = extractDescriptorFields(source, line);
              if (fields.sessionId !== null && (source !== "codex" || sessionId.length === 0)) {
                sessionId = fields.sessionId;
              }
              if (fields.title !== null) title = fields.title;
              if (fields.harnessUser) suppressAssistantPreview = true;
              if (fields.prompt !== null) {
                if (prompt === null) prompt = fields.prompt;
                suppressAssistantPreview = false;
              }
              if (fields.assistantPreview !== null && !suppressAssistantPreview) {
                assistantPreview = fields.assistantPreview;
              }
              if (fields.isCompactSummary) hasCompactionSummary = true;
              if (fields.contextMaxTokens !== null) contextMaxTokens = fields.contextMaxTokens;
              if (fields.contextUsedTokens !== null) {
                if (hasCompactionSummary) {
                  usedAfterCompaction = fields.contextUsedTokens;
                } else {
                  usedBeforeCompaction = fields.contextUsedTokens;
                }
              }
              if (fields.timestamp !== null) {
                const normalized = normalizeTimestamp(fields.timestamp, fallbackTimestamp);
                if (firstTimestamp === null) firstTimestamp = normalized;
                lastTimestamp = normalized;
              }
            };

            while (bytesRead < maxBytes) {
              if (recordsRead >= MAX_METADATA_RECORDS_PER_TRANSCRIPT) break;
              const readSize = Math.min(METADATA_READ_BYTES, maxBytes - bytesRead);
              const next = yield* file.readAlloc(readSize);
              if (Option.isNone(next)) break;
              bytesRead += next.value.byteLength;
              remaining += decoder.decode(next.value, { stream: true });
              const lines = remaining.split("\n");
              remaining = lines.pop() ?? "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.length === 0) continue;
                recordsRead += 1;
                consider(trimmed);
                if (recordsRead >= MAX_METADATA_RECORDS_PER_TRANSCRIPT) break;
              }
            }

            const last = (remaining + decoder.decode()).trim();
            if (last.length > 0) {
              recordsRead += 1;
              consider(last);
            }

            // Prefer the last assistant reply for the list preview. The forward
            // window often stops at the first reply; the tail read catches the
            // latest usable agent text when the file is large enough to seek.
            const tail = yield* readDescriptorTail(source, transcript, hasCompactionSummary);
            if (tail.assistantPreview !== null) assistantPreview = tail.assistantPreview;
            if (tail.lastTimestamp !== null) {
              lastTimestamp = normalizeTimestamp(tail.lastTimestamp, fallbackTimestamp);
            }
            if (tail.hasCompactionSummary) hasCompactionSummary = true;
            if (tail.usedBeforeCompaction !== null) {
              usedBeforeCompaction = tail.usedBeforeCompaction;
            }
            if (tail.usedAfterCompaction !== null) {
              usedAfterCompaction = tail.usedAfterCompaction;
            }
            if (tail.contextMaxTokens !== null) contextMaxTokens = tail.contextMaxTokens;

            if (sessionId.length === 0) return null;
            // Last agent response when we have one; otherwise the first usable
            // user prompt (system dumps already filtered by isUsableListPreviewText).
            const previewSource = assistantPreview ?? prompt;
            if (previewSource === null) return null;
            // Cursor: never title from agent↔harness status replies — prefer the
            // first usable user prompt, then the session id.
            const titleSource =
              title ?? prompt ?? (source === "cursor" ? null : previewSource) ?? sessionId;
            const contextUsedTokens = selectContextUsedForHistoryMode({
              historyMode: "compaction",
              hasCompactionSummary,
              usedBeforeCompaction,
              usedAfterCompaction,
            });
            const contextUsedTokensFull = selectContextUsedForHistoryMode({
              historyMode: "full",
              hasCompactionSummary,
              usedBeforeCompaction,
              usedAfterCompaction,
            });
            return {
              providerSessionId: sessionId,
              promptPreview: truncatePreview(previewSource),
              title: truncatePreview(titleSource, 120),
              createdAt: firstTimestamp ?? fallbackTimestamp,
              lastMessageAt: lastTimestamp ?? firstTimestamp ?? fallbackTimestamp,
              hasCompactionSummary,
              ...(contextUsedTokens !== null ? { contextUsedTokens } : {}),
              ...(contextUsedTokensFull !== null ? { contextUsedTokensFull } : {}),
              ...(contextMaxTokens !== null ? { contextMaxTokens } : {}),
            };
          }),
        ),
      ),
    ).pipe(Effect.orElseSucceed(() => null));
  });

  /**
   * Last usable assistant text / timestamp / compaction flag from the end of a
   * transcript, bounded.
   */
  const readDescriptorTail = Effect.fn("AgentSessionScanner.readDescriptorTail")(function* (
    source: AgentSessionSource,
    transcript: TranscriptCandidate & { readonly mtimeMs: number },
    alreadySawCompaction: boolean,
  ) {
    const empty = {
      assistantPreview: null as string | null,
      lastTimestamp: null as string | null,
      hasCompactionSummary: false,
      usedBeforeCompaction: null as number | null,
      usedAfterCompaction: null as number | null,
      contextMaxTokens: null as number | null,
    };
    const tailByteCount = Math.min(METADATA_READ_BYTES * 4, transcript.size);
    if (tailByteCount <= 0) return empty;
    // Effect's File.seek tracks position as bigint; pass bigint offsets.
    const size = BigInt(transcript.size);
    const tailBytes = BigInt(tailByteCount);
    return yield* Effect.scoped(
      fileSystem.open(transcript.filePath, { flag: "r" }).pipe(
        Effect.flatMap((file) =>
          Effect.gen(function* () {
            yield* file.seek(size - tailBytes, "start");
            const chunk = yield* file.readAlloc(tailByteCount);
            if (Option.isNone(chunk)) return empty;
            const text = new TextDecoder().decode(chunk.value);
            const lines = text.split("\n");
            let assistantPreview: string | null = null;
            let suppressAssistantPreview = false;
            let lastTimestamp: string | null = null;
            let hasCompactionSummary = false;
            let sawCompaction = alreadySawCompaction;
            let usedBeforeCompaction: number | null = null;
            let usedAfterCompaction: number | null = null;
            let contextMaxTokens: number | null = null;
            // First line may be a partial JSONL record after the seek.
            for (let index = 1; index < lines.length; index++) {
              const trimmed = lines[index]?.trim() ?? "";
              if (trimmed.length === 0) continue;
              const fields = extractDescriptorFields(source, trimmed);
              if (fields.harnessUser) suppressAssistantPreview = true;
              if (fields.prompt !== null) suppressAssistantPreview = false;
              if (fields.assistantPreview !== null && !suppressAssistantPreview) {
                assistantPreview = fields.assistantPreview;
              }
              if (fields.timestamp !== null) lastTimestamp = fields.timestamp;
              if (fields.isCompactSummary) {
                hasCompactionSummary = true;
                sawCompaction = true;
              }
              if (fields.contextMaxTokens !== null) contextMaxTokens = fields.contextMaxTokens;
              if (fields.contextUsedTokens !== null) {
                if (sawCompaction) {
                  usedAfterCompaction = fields.contextUsedTokens;
                } else {
                  usedBeforeCompaction = fields.contextUsedTokens;
                }
              }
            }
            return {
              assistantPreview,
              lastTimestamp,
              hasCompactionSummary,
              usedBeforeCompaction,
              usedAfterCompaction,
              contextMaxTokens,
            };
          }),
        ),
      ),
    ).pipe(Effect.orElseSucceed(() => empty));
  });

  /** Count JSONL records up to `limit` without parsing JSON (newline-delimited). */
  const countTranscriptRecordsUpTo = Effect.fn("AgentSessionScanner.countTranscriptRecordsUpTo")(
    function* (filePath: string, size: number, limit: number) {
      if (size === 0 || limit <= 0) return 0;
      return yield* Effect.scoped(
        fileSystem.open(filePath, { flag: "r" }).pipe(
          Effect.flatMap((file) =>
            Effect.gen(function* () {
              let bytesRead = 0;
              let count = 0;
              let lineStarted = false;
              while (bytesRead < size && count < limit) {
                const readSize = Math.min(TRANSCRIPT_PREFIX_BYTES, size - bytesRead);
                const next = yield* file.readAlloc(readSize);
                if (Option.isNone(next)) break;
                bytesRead += next.value.byteLength;
                for (let index = 0; index < next.value.byteLength; index++) {
                  lineStarted = true;
                  if (next.value[index] === 10) {
                    count += 1;
                    lineStarted = false;
                    if (count >= limit) return count;
                  }
                }
              }
              // Match splitTranscriptRecords: a final line without trailing newline counts.
              if (lineStarted && count < limit) count += 1;
              return count;
            }),
          ),
        ),
      ).pipe(Effect.orElseSucceed(() => 0));
    },
  );

  /**
   * Project history fields while reading, before allocating whole JSON records.
   * Check the file identity on both sides of the read. A selected-history budget
   * failure rejects the entire transcript before any imported messages persist.
   */
  const readTranscript = Effect.fn("AgentSessionScanner.readTranscript")(function* (
    filePath: string,
    expected: ReturnType<typeof transcriptIdentity>,
    recordLimit: number,
    source: AgentSessionSource,
  ) {
    if (expected.size > MAX_IMPORTED_TRANSCRIPT_BYTES) return null;

    return yield* Effect.scoped(
      fileSystem.open(filePath, { flag: "r" }).pipe(
        Effect.flatMap((file) =>
          Effect.gen(function* () {
            if (!sameTranscriptIdentity(expected, transcriptIdentity(filePath, yield* file.stat))) {
              return null;
            }
            const records: Array<DecodedTranscriptRecord> = [];
            let historyBytes = 0;
            let recordBytes = 0;
            let recordCount = 0;
            let bytesRead = 0;
            const reserve = (bytes: number) => {
              recordBytes += bytes;
              if (historyBytes + recordBytes > MAX_IMPORT_HISTORY_BYTES) {
                throw new TranscriptJsonLimitError(
                  "Transcript selected history exceeds the 32 MiB memory budget",
                );
              }
            };
            let reader = createTranscriptJsonReader(reserve, selectTranscriptPath);
            let decoder = new TextDecoder();
            let recordStarted = false;

            const finishRecord = () => {
              reader.write(decoder.decode());
              recordCount += 1;
              if (recordCount > recordLimit) return false;
              const decoded = decodeTranscriptValue(reader.finish());
              if (Option.isSome(decoded) && shouldRetainDecodedRecord(source, decoded.value)) {
                records.push(decoded.value);
                historyBytes += recordBytes;
              }
              recordBytes = 0;
              reader = createTranscriptJsonReader(reserve, selectTranscriptPath);
              decoder = new TextDecoder();
              recordStarted = false;
              return true;
            };

            while (bytesRead < expected.size) {
              const next = yield* file.readAlloc(
                Math.min(TRANSCRIPT_PREFIX_BYTES, expected.size - bytesRead),
              );
              if (Option.isNone(next)) {
                return null;
              }

              bytesRead += next.value.byteLength;
              const withinBudget = yield* Effect.try(() => {
                let start = 0;
                while (start < next.value.byteLength) {
                  const newline = next.value.indexOf(10, start);
                  const end = newline === -1 ? next.value.byteLength : newline;
                  recordStarted = true;
                  reader.write(decoder.decode(next.value.subarray(start, end), { stream: true }));
                  if (newline === -1) break;
                  if (!finishRecord()) return false;
                  start = newline + 1;
                }
                return true;
              });
              if (!withinBudget) return null;
            }

            if (recordStarted && !(yield* Effect.try(finishRecord))) return null;
            return sameTranscriptIdentity(expected, transcriptIdentity(filePath, yield* file.stat))
              ? { records, recordCount }
              : null;
          }),
        ),
      ),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read imported transcript", { filePath, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
  });

  /**
   * Resolve the Claude config directory the CLI would use, matching the
   * precedence the spawned CLI sees: the instance's `homePath` (exported as
   * `CLAUDE_CONFIG_DIR`), then a `CLAUDE_CONFIG_DIR` already in the
   * environment, then `~/.claude`.
   */
  const resolveClaudeConfigDir = (homePath: string, environmentHome?: string): string => {
    const configured = homePath.trim();
    if (configured.length > 0) {
      return path.resolve(expandHomePath(configured));
    }
    const fromEnvironment = environmentHome?.trim() ?? "";
    if (fromEnvironment.length > 0) {
      return path.resolve(expandHomePath(fromEnvironment));
    }
    return path.join(NodeOS.homedir(), ".claude");
  };

  const discoverClaudeTranscripts = Effect.fn("AgentSessionScanner.discoverClaudeTranscripts")(
    function* (homePath: string, providerInstanceId: ProviderInstanceId, operationBudget: number) {
      const projectsDir = path.join(homePath, "projects");
      let operationsRemaining = operationBudget;
      let truncated = false;
      const readDirectory = (directory: string) => {
        if (operationsRemaining <= 0) {
          truncated = true;
          return Effect.succeed<ReadonlyArray<string>>([]);
        }
        operationsRemaining -= 1;
        return listDirectory(directory);
      };
      const projectDirectories = yield* readDirectory(projectsDir);
      const transcripts: Array<TranscriptCandidate> = [];

      for (const projectDirectory of projectDirectories) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        const directory = path.join(projectsDir, projectDirectory);
        const directoryTranscripts = (yield* readDirectory(directory))
          .filter((entry) => entry.endsWith(".jsonl"))
          .map((entry) => path.join(directory, entry));

        for (const filePath of directoryTranscripts) {
          if (operationsRemaining <= 0) {
            truncated = true;
            break;
          }
          operationsRemaining -= 1;
          const stats = yield* statOption(filePath);
          if (
            Option.isNone(stats) ||
            stats.value.type !== "File" ||
            Option.isNone(stats.value.mtime)
          ) {
            continue;
          }
          transcripts.push({
            filePath,
            mtimeMs: stats.value.mtime.value.getTime(),
            providerInstanceId,
            size: Number(stats.value.size),
          });
        }
      }
      return { transcripts, truncated };
    },
  );

  const discoverCodexTranscripts = Effect.fn("AgentSessionScanner.discoverCodexTranscripts")(
    function* (homePath: string, providerInstanceId: ProviderInstanceId, operationBudget: number) {
      const sessionsDir = path.join(homePath, "sessions");

      const transcripts: Array<TranscriptCandidate> = [];
      let operationsRemaining = operationBudget;
      let truncated = false;
      const readDirectory = (directory: string) => {
        if (operationsRemaining <= 0) {
          truncated = true;
          return Effect.succeed<ReadonlyArray<string>>([]);
        }
        operationsRemaining -= 1;
        return listDirectory(directory);
      };
      // Date-partitioned directories sort chronologically, so walking them in
      // reverse spends each home's share of the operation budget on recent sessions.
      for (const year of (yield* readDirectory(sessionsDir)).toSorted().toReversed()) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        for (const month of (yield* readDirectory(path.join(sessionsDir, year)))
          .toSorted()
          .toReversed()) {
          if (operationsRemaining <= 0) {
            truncated = true;
            break;
          }
          for (const day of (yield* readDirectory(path.join(sessionsDir, year, month)))
            .toSorted()
            .toReversed()) {
            if (operationsRemaining <= 0) {
              truncated = true;
              break;
            }
            const directory = path.join(sessionsDir, year, month, day);
            for (const entry of (yield* readDirectory(directory)).toSorted().toReversed()) {
              if (!entry.startsWith("rollout-") || !entry.endsWith(".jsonl")) continue;
              if (operationsRemaining <= 0) {
                truncated = true;
                break;
              }
              const filePath = path.join(directory, entry);
              operationsRemaining -= 1;
              const stats = yield* statOption(filePath);
              if (
                Option.isSome(stats) &&
                stats.value.type === "File" &&
                Option.isSome(stats.value.mtime)
              ) {
                transcripts.push({
                  filePath,
                  mtimeMs: stats.value.mtime.value.getTime(),
                  providerInstanceId,
                  size: Number(stats.value.size),
                });
              }
            }
          }
        }
      }
      return { transcripts, truncated };
    },
  );

  const groupTranscriptsByCwd = Effect.fn("AgentSessionScanner.groupTranscriptsByCwd")(function* (
    source: AgentSessionSource,
    transcripts: ReadonlyArray<TranscriptCandidate>,
    budget: MetadataReadBudget,
  ) {
    const byOwnerAndCwd = new Map<
      string,
      {
        cwd: string;
        providerInstanceId: ProviderInstanceId;
        lastActiveAtMs: number;
        transcripts: Array<{ filePath: string; mtimeMs: number }>;
      }
    >();

    for (const transcript of transcripts) {
      const cwd = yield* readCwd(transcript, budget);
      if (cwd === null) continue;
      const key = `${transcript.providerInstanceId}\0${cwd}`;
      const existing = byOwnerAndCwd.get(key);
      if (existing) {
        existing.lastActiveAtMs = Math.max(existing.lastActiveAtMs, transcript.mtimeMs);
        existing.transcripts.push(transcript);
      } else {
        byOwnerAndCwd.set(key, {
          cwd,
          providerInstanceId: transcript.providerInstanceId,
          lastActiveAtMs: transcript.mtimeMs,
          transcripts: [transcript],
        });
      }
    }

    return Array.from(byOwnerAndCwd.values(), (group): RawCandidate => ({
      cwd: group.cwd,
      source,
      providerInstanceId: group.providerInstanceId,
      threadCount: group.transcripts.length,
      lastActiveAtMs: group.lastActiveAtMs,
      transcripts: group.transcripts,
    }));
  });

  const resolveSourceHomes = Effect.fn("AgentSessionScanner.resolveSourceHomes")(function* (
    source: AgentSessionSource,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-settings", cause })),
    );
    const instances: Array<{
      readonly instanceId: ProviderInstanceId;
      readonly config: ProviderInstanceConfig;
    }> = Object.entries(settings.providerInstances)
      .filter(
        ([, instance]) => instance.driver === source && resolveProviderInstanceEnabled(instance),
      )
      .map(([instanceId, config]) => ({
        instanceId: ProviderInstanceId.make(instanceId),
        config,
      }));
    if (!Object.hasOwn(settings.providerInstances, source)) {
      const legacyInstance = {
        instanceId: ProviderInstanceId.make(source),
        config: {
          driver: ProviderDriverKind.make(source),
          config: settings.providers[source],
        },
      };
      if (resolveProviderInstanceEnabled(legacyInstance.config)) {
        instances.push(legacyInstance);
      }
    }

    // A shared home contains one copy of each session. Prefer the built-in
    // instance as its owner, then keep configured order for custom accounts.
    instances.sort((left, right) => {
      const leftDefault = left.instanceId === source ? 0 : 1;
      const rightDefault = right.instanceId === source ? 0 : 1;
      return leftDefault - rightDefault;
    });
    const homes: Array<{ homePath: string; providerInstanceId: ProviderInstanceId }> = [];
    const seenHomes = new Set<string>();
    for (const { instanceId, config: instance } of instances) {
      let homePath: string;
      if (source === "cursor") {
        // Listing reads ~/.cursor (or CURSOR_HOME). CursorSettings has no homePath;
        // we never spawn cursor-agent just to discover transcripts.
        const fromEnvironment = hostEnvironment.CURSOR_HOME?.trim() ?? "";
        homePath =
          fromEnvironment.length > 0
            ? path.resolve(expandHomePath(fromEnvironment))
            : path.join(NodeOS.homedir(), ".cursor");
      } else if (source === "claudeAgent") {
        const homeVariable = "CLAUDE_CONFIG_DIR";
        const environmentHome =
          instance.environment?.findLast((variable) => variable.name === homeVariable)?.value ??
          hostEnvironment[homeVariable];
        const config = decodeClaudeSettings(instance.config ?? {});
        if (Option.isNone(config)) continue;
        homePath = resolveClaudeConfigDir(config.value.homePath, environmentHome);
      } else {
        const homeVariable = "CODEX_HOME";
        const environmentHome =
          instance.environment?.findLast((variable) => variable.name === homeVariable)?.value ??
          hostEnvironment[homeVariable];
        const config = decodeCodexSettings(instance.config ?? {});
        if (Option.isNone(config)) continue;
        const codexSettings =
          config.value.homePath.trim().length === 0 &&
          config.value.shadowHomePath.trim().length === 0 &&
          environmentHome?.trim()
            ? { ...config.value, homePath: environmentHome }
            : config.value;
        const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
          Effect.provideService(Path.Path, path),
        );
        homePath = layout.sharedHomePath;
      }

      const homeKey = `${source}\0${yield* directoryIdentity(homePath)}`;
      if (seenHomes.has(homeKey)) continue;
      seenHomes.add(homeKey);
      homes.push({ homePath, providerInstanceId: instanceId });
    }

    // Cursor history import is filesystem-only. When the provider is disabled,
    // still offer ~/.cursor sessions under the built-in instance id so Import
    // works without turning the live adapter on.
    if (source === "cursor" && homes.length === 0) {
      const fromEnvironment = hostEnvironment.CURSOR_HOME?.trim() ?? "";
      homes.push({
        homePath:
          fromEnvironment.length > 0
            ? path.resolve(expandHomePath(fromEnvironment))
            : path.join(NodeOS.homedir(), ".cursor"),
        providerInstanceId: ProviderInstanceId.make("cursor"),
      });
    }
    return homes;
  });

  /**
   * Project-scoped Cursor discovery: only `projects/<slug(cwd)>/agent-transcripts`
   * and matching `chats/<md5(cwd)>` meta. Never walks all of ~/.cursor.
   */
  const discoverCursorSessionsForWorkspace = Effect.fn(
    "AgentSessionScanner.discoverCursorSessionsForWorkspace",
  )(function* (workspaceRoot: string) {
    const homes = yield* resolveSourceHomes("cursor");
    const root = path.resolve(expandHomePath(workspaceRoot));
    const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
    const cwdVariants = root === realRoot ? [root] : [root, realRoot];
    const seenFiles = new Set<string>();
    const transcripts: Array<
      TranscriptCandidate & {
        readonly titleOverride?: string;
        readonly createdAtMs?: number;
        readonly lastUpdatedAtMs?: number;
        readonly contextUsagePercent?: number;
        readonly cwd: string;
      }
    > = [];
    let truncated = false;
    let providerError: string | null = null;

    // Native % lives in Cursor IDE global state.vscdb, not chats/*/store.db.
    // Load once per discovery pass (composerData + headers fallback).
    const composerUsageIndex = loadCursorComposerContextUsageIndex({
      env: hostEnvironment,
    });

    for (const home of homes) {
      const projectsRoot = path.join(home.homePath, "projects");
      const probed = yield* fileSystem.readDirectory(projectsRoot).pipe(
        Effect.as(null as string | null),
        Effect.catchTags({
          PlatformError: (error: PlatformError.PlatformError) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(null)
              : Effect.succeed(
                  error.message.trim().length > 0
                    ? error.message
                    : `Could not read ${projectsRoot}`,
                ),
        }),
      );
      if (probed !== null) {
        providerError = probed;
        continue;
      }

      for (const cwd of cwdVariants) {
        const slug = cursorProjectSlug(cwd);
        const chatHash = cursorChatDirectoryHash(cwd);
        const transcriptsDir = path.join(home.homePath, "projects", slug, "agent-transcripts");
        const agentIds = yield* listDirectory(transcriptsDir);
        for (const agentId of agentIds) {
          if (transcripts.length >= MAX_TRANSCRIPTS_PER_SOURCE) {
            truncated = true;
            break;
          }
          const trimmedId = agentId.trim();
          if (trimmedId.length === 0) continue;
          const filePath = path.join(transcriptsDir, trimmedId, `${trimmedId}.jsonl`);
          if (seenFiles.has(filePath)) continue;
          const storeDbPath = path.join(home.homePath, "chats", chatHash, trimmedId, "store.db");
          const chatMeta = readCursorChatMeta(storeDbPath);
          if (chatMeta?.isSubagent === true) continue;

          const stats = yield* statOption(filePath);
          if (
            Option.isNone(stats) ||
            stats.value.type !== "File" ||
            Option.isNone(stats.value.mtime)
          ) {
            continue;
          }
          seenFiles.add(filePath);
          const contextUsagePercent = composerUsageIndex.get(trimmedId);
          transcripts.push({
            filePath,
            mtimeMs: stats.value.mtime.value.getTime(),
            providerInstanceId: home.providerInstanceId,
            size: Number(stats.value.size),
            ...(chatMeta?.name &&
            !isGenericCursorChatTitle(chatMeta.name) &&
            isUsableListPreviewText(chatMeta.name)
              ? { titleOverride: stripHarnessMarkup(chatMeta.name) }
              : {}),
            ...(chatMeta?.createdAtMs != null ? { createdAtMs: chatMeta.createdAtMs } : {}),
            ...(chatMeta?.lastUpdatedAtMs != null
              ? { lastUpdatedAtMs: chatMeta.lastUpdatedAtMs }
              : {}),
            ...(contextUsagePercent !== undefined ? { contextUsagePercent } : {}),
            cwd: root,
          });
        }
      }
    }

    return { transcripts, truncated, providerError };
  });

  const collectCandidates = Effect.fn("AgentSessionScanner.collectCandidates")(function* () {
    const raw: Array<RawCandidate> = [];
    let truncated = false;

    for (const source of ["claudeAgent", "codex"] as const) {
      const homes = yield* resolveSourceHomes(source);

      const transcriptCandidates: Array<TranscriptCandidate> = [];
      const baseOperationBudget = Math.floor(
        MAX_DISCOVERY_OPERATIONS_PER_SOURCE / Math.max(1, homes.length),
      );
      const extraOperationBudgets = MAX_DISCOVERY_OPERATIONS_PER_SOURCE % Math.max(1, homes.length);
      for (const [index, home] of homes.entries()) {
        const operationBudget = baseOperationBudget + (index < extraOperationBudgets ? 1 : 0);
        if (operationBudget === 0) {
          truncated = true;
          continue;
        }
        const discovered = yield* source === "claudeAgent"
          ? discoverClaudeTranscripts(home.homePath, home.providerInstanceId, operationBudget)
          : discoverCodexTranscripts(home.homePath, home.providerInstanceId, operationBudget);
        truncated ||= discovered.truncated;
        transcriptCandidates.push(...discovered.transcripts);
      }

      transcriptCandidates.sort(
        (left, right) =>
          right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath),
      );
      if (transcriptCandidates.length > MAX_TRANSCRIPTS_PER_SOURCE) {
        truncated = true;
      }
      // Give each account a turn before taking another file from the same home.
      const selectedTranscripts = selectMetadataTranscripts(transcriptCandidates);
      const metadataBudget: MetadataReadBudget = {
        bytesRemaining: MAX_METADATA_BYTES_PER_SOURCE,
        operationsRemaining: MAX_METADATA_OPERATIONS_PER_SOURCE,
        recordsRemaining: MAX_METADATA_RECORDS_PER_SOURCE,
        truncated: false,
      };
      raw.push(...(yield* groupTranscriptsByCwd(source, selectedTranscripts, metadataBudget)));
      truncated ||= metadataBudget.truncated;
    }

    return { candidates: raw, truncated };
  });

  let cachedCandidates: ReadonlyArray<RawCandidate> | null = null;

  const scan: AgentSessionScanner["Service"]["scan"] = Effect.gen(function* () {
    const { candidates: raw, truncated } = yield* collectCandidates();
    cachedCandidates = raw;

    // Filesystem identity merges symlinks and case aliases without collapsing
    // distinct case-sensitive directories.
    const merged = new Map<
      string,
      {
        path: string;
        sources: Array<AgentSessionSource>;
        threadCount: number;
        lastActiveAtMs: number | null;
        git: AgentSessionProjectGit | null;
      }
    >();
    const directoryKeys = new Map<string, string>();
    const gitIdentities = new Map<string, AgentSessionProjectGit | null>();

    for (const candidate of raw) {
      const expanded = expandHomePath(candidate.cwd.trim());
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      if (isExcludedProjectPath(resolved)) continue;
      let key = directoryKeys.get(resolved);
      if (key === undefined) {
        const stats = yield* statOption(resolved);
        // Directories that no longer exist can't be imported.
        if (Option.isNone(stats) || stats.value.type !== "Directory") {
          directoryKeys.set(resolved, "");
          continue;
        }
        const realPath = yield* fileSystem
          .realPath(resolved)
          .pipe(Effect.orElseSucceed(() => resolved));
        // A symlink can point into the worktrees directory even when its own
        // spelling doesn't; check again with links resolved.
        if (isExcludedProjectPath(realPath)) {
          key = "";
        } else {
          const gitIdentity = yield* readGitIdentity(resolved);
          if (gitIdentity._tag === "Worktree") {
            key = "";
          } else {
            key = yield* directoryIdentity(resolved, stats.value);
            gitIdentities.set(key, gitIdentity._tag === "Repository" ? gitIdentity.git : null);
          }
        }
        directoryKeys.set(resolved, key);
      }
      if (key === "") continue;

      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          path: resolved,
          sources: [candidate.source],
          threadCount: candidate.threadCount,
          lastActiveAtMs: candidate.lastActiveAtMs,
          git: gitIdentities.get(key) ?? null,
        });
        continue;
      }
      if (!existing.sources.includes(candidate.source)) {
        existing.sources.push(candidate.source);
      }
      existing.threadCount += candidate.threadCount;
      existing.lastActiveAtMs =
        existing.lastActiveAtMs === null || candidate.lastActiveAtMs === null
          ? (existing.lastActiveAtMs ?? candidate.lastActiveAtMs)
          : Math.max(existing.lastActiveAtMs, candidate.lastActiveAtMs);
    }

    // Resolve persisted roots too. A project and a transcript can name
    // different symlinks to the same directory.
    const shellSnapshot = yield* projectionSnapshotQuery
      .getShellSnapshot()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const importedProjectsByRoot = new Map<string, (typeof shellSnapshot.projects)[number]>();
    for (const project of shellSnapshot.projects) {
      const projectRoot = path.resolve(expandHomePath(project.workspaceRoot));
      importedProjectsByRoot.set(normalizeProjectPathForComparison(projectRoot), project);
      importedProjectsByRoot.set(yield* directoryIdentity(projectRoot), project);
    }

    const candidates: Array<AgentSessionProjectCandidate> = [];
    for (const [key, entry] of merged.entries()) {
      // Keep the path key for missing roots and use filesystem identity for
      // aliases that resolve to the same directory.
      const importedProject =
        importedProjectsByRoot.get(normalizeProjectPathForComparison(entry.path)) ??
        importedProjectsByRoot.get(key);
      const candidatePath = importedProject?.workspaceRoot ?? entry.path;
      candidates.push({
        path: candidatePath,
        title: path.basename(candidatePath) || candidatePath,
        ...(importedProject === undefined ? {} : { projectId: importedProject.id }),
        sources: entry.sources,
        threadCount: entry.threadCount,
        lastActiveAt:
          entry.lastActiveAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(entry.lastActiveAtMs)),
        alreadyImported: importedProject !== undefined,
        git: entry.git,
      });
    }

    // Newest first, undated candidates last.
    candidates.sort((left, right) => {
      if (left.lastActiveAt === right.lastActiveAt) return left.path.localeCompare(right.path);
      if (left.lastActiveAt === null) return 1;
      if (right.lastActiveAt === null) return -1;
      return right.lastActiveAt.localeCompare(left.lastActiveAt);
    });

    return {
      candidates,
      scannedAt: DateTime.formatIso(yield* DateTime.now),
      ...(truncated ? { truncated: true } : {}),
    };
  });

  const prepareRecentThreads = Effect.fn("AgentSessionScanner.prepareRecentThreads")(function* (
    workspaceRoot: string,
    completedSources: ReadonlyArray<AgentSessionImportSource>,
    historyMode: "compaction" | "full" = "compaction",
  ) {
    const root = path.resolve(expandHomePath(workspaceRoot));
    const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
    if (isExcludedProjectPath(root) || isExcludedProjectPath(realRoot)) return Stream.empty;
    const rootIdentity = yield* directoryIdentity(root);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const cutoffMs = nowMs - RECENT_THREAD_WINDOW_MS;

    const candidates = cachedCandidates ?? (yield* collectCandidates()).candidates;
    cachedCandidates = candidates;

    const cursorDiscovery = yield* discoverCursorSessionsForWorkspace(workspaceRoot);
    const cursorByInstance = Map.groupBy(
      cursorDiscovery.transcripts,
      (transcript) => transcript.providerInstanceId,
    );
    const cursorCandidates: Array<RawCandidate> = Array.from(
      cursorByInstance.entries(),
      ([providerInstanceId, transcripts]) => {
        const lastActiveAtMs = transcripts.reduce(
          (max, transcript) => Math.max(max, transcript.mtimeMs),
          0,
        );
        return {
          cwd: root,
          source: "cursor" as const,
          providerInstanceId,
          threadCount: transcripts.length,
          lastActiveAtMs,
          transcripts: transcripts.map((transcript) => ({
            filePath: transcript.filePath,
            mtimeMs: transcript.mtimeMs,
            ...(transcript.titleOverride ? { titleOverride: transcript.titleOverride } : {}),
          })),
        };
      },
    );

    const eligibleTranscripts: Array<{
      readonly candidate: RawCandidate;
      readonly transcript: RawCandidate["transcripts"][number] & { readonly mtimeMs: number };
    }> = [];
    for (const candidate of [...candidates, ...cursorCandidates]) {
      const expanded = expandHomePath(candidate.cwd.trim());
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      if ((yield* directoryIdentity(resolved)) !== rootIdentity) continue;

      for (const transcript of candidate.transcripts) {
        if (
          transcript.mtimeMs === null ||
          transcript.mtimeMs < cutoffMs ||
          transcript.mtimeMs > nowMs
        ) {
          continue;
        }
        eligibleTranscripts.push({
          candidate,
          transcript: { ...transcript, mtimeMs: transcript.mtimeMs },
        });
      }
    }

    eligibleTranscripts.sort((left, right) => {
      if (left.transcript.mtimeMs !== right.transcript.mtimeMs) {
        return right.transcript.mtimeMs - left.transcript.mtimeMs;
      }
      return left.transcript.filePath.localeCompare(right.transcript.filePath);
    });

    const completedByFile = Map.groupBy(
      completedSources,
      (source) => `${source.providerInstanceId}\0${source.filePath}`,
    );
    const importedSessions = new Set<string>();
    let bytesRemaining = MAX_IMPORT_BYTES;
    let transcriptsRemaining = MAX_IMPORT_TRANSCRIPTS;
    let recordsRemaining = MAX_IMPORT_RECORDS;
    return Stream.fromIteratorSucceed(eligibleTranscripts.values(), 1).pipe(
      Stream.mapEffect(({ candidate, transcript }) =>
        Effect.gen(function* () {
          const completed = completedByFile.get(
            `${candidate.providerInstanceId}\0${transcript.filePath}`,
          );
          if (
            completed === undefined &&
            (transcriptsRemaining === 0 || bytesRemaining === 0 || recordsRemaining === 0)
          ) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const stats = yield* statOption(transcript.filePath);
          if (Option.isNone(stats) || stats.value.type !== "File") {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const identity = transcriptIdentity(transcript.filePath, stats.value);
          const completedSource = completed?.find(
            (source) =>
              source.provider === candidate.source && sameTranscriptIdentity(source, identity),
          );
          if (completedSource !== undefined) {
            const sessionKey = `${completedSource.providerInstanceId}\0${completedSource.providerSessionId}`;
            if (importedSessions.has(sessionKey)) return Option.none<AgentSessionRecentThread>();
            importedSessions.add(sessionKey);
            return Option.some<AgentSessionRecentThread>({
              _tag: "AlreadyImported",
              source: completedSource,
            });
          }
          if (
            transcriptsRemaining === 0 ||
            recordsRemaining === 0 ||
            identity.size > MAX_IMPORTED_TRANSCRIPT_BYTES ||
            identity.size > bytesRemaining
          ) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          // Reserve the whole file even if its read or parse fails.
          transcriptsRemaining -= 1;
          bytesRemaining -= identity.size;
          const snapshot = yield* readTranscript(
            transcript.filePath,
            identity,
            recordsRemaining,
            candidate.source,
          );
          if (snapshot === null) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          recordsRemaining -= snapshot.recordCount;

          // A stable replacement file can belong to a different project than the cached candidate.
          // Cursor transcripts omit cwd; discovery already scoped them to this workspace.
          if (candidate.source !== "cursor") {
            let snapshotCwd: string | null = null;
            for (const record of snapshot.records) {
              snapshotCwd = extractDecodedCwd(record);
              if (snapshotCwd !== null) break;
            }
            if (snapshotCwd === null) {
              return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
            }
            const expandedCwd = expandHomePath(snapshotCwd.trim());
            if (
              !path.isAbsolute(expandedCwd) ||
              (yield* directoryIdentity(path.resolve(expandedCwd))) !== rootIdentity
            ) {
              return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
            }
          }

          const parsedThread = parseAgentSessionRecords(
            {
              source: candidate.source,
              providerInstanceId: candidate.providerInstanceId,
              fallbackSessionId: path.basename(transcript.filePath, ".jsonl"),
              lastActiveAtMs: transcript.mtimeMs,
              historyMode,
            },
            snapshot.records,
          );
          if (parsedThread === null) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const titledThread =
            transcript.titleOverride !== undefined && transcript.titleOverride.trim().length > 0
              ? { ...parsedThread, title: transcript.titleOverride.trim() }
              : parsedThread;

          const source: AgentSessionImportSource = {
            ...identity,
            provider: titledThread.source,
            providerInstanceId: titledThread.providerInstanceId,
            providerSessionId: titledThread.providerSessionId,
          };
          const sessionKey = `${titledThread.providerInstanceId}\0${titledThread.providerSessionId}`;
          if (importedSessions.has(sessionKey)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Duplicate", source });
          }
          importedSessions.add(sessionKey);
          return Option.some<AgentSessionRecentThread>({
            _tag: "Importable",
            thread: titledThread,
            source,
          });
        }).pipe(importReadLock.withPermits(1)),
      ),
      Stream.map(Option.toArray),
      Stream.flattenIterable,
    );
  });

  const recentThreads: AgentSessionScanner["Service"]["recentThreads"] = (
    workspaceRoot,
    completedSources = [],
    options,
  ) =>
    Stream.unwrap(
      prepareRecentThreads(workspaceRoot, completedSources, options?.historyMode ?? "compaction"),
    );

  const listRecentSessionDescriptors: AgentSessionScanner["Service"]["listRecentSessionDescriptors"] =
    Effect.fn("AgentSessionScanner.listRecentSessionDescriptors")(function* (
      workspaceRoot: string,
      limit: number,
    ) {
      const root = path.resolve(expandHomePath(workspaceRoot));
      const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
      if (isExcludedProjectPath(root) || isExcludedProjectPath(realRoot)) {
        return { descriptors: [], providerErrors: [], truncated: false };
      }
      const rootIdentity = yield* directoryIdentity(root);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const cutoffMs = nowMs - RECENT_THREAD_WINDOW_MS;

      const providerErrors: Array<AgentSessionDescriptorFailure> = [];
      for (const source of ["claudeAgent", "codex"] as const) {
        const homes = yield* resolveSourceHomes(source);
        for (const home of homes) {
          const probeRoot =
            source === "claudeAgent"
              ? path.join(home.homePath, "projects")
              : path.join(home.homePath, "sessions");
          const probed = yield* fileSystem.readDirectory(probeRoot).pipe(
            Effect.as(null as string | null),
            Effect.catchTags({
              PlatformError: (error: PlatformError.PlatformError) =>
                error.reason._tag === "NotFound"
                  ? Effect.succeed(null)
                  : Effect.succeed(
                      error.message.trim().length > 0
                        ? error.message
                        : `Could not read ${probeRoot}`,
                    ),
            }),
          );
          if (probed !== null) {
            providerErrors.push({ source, message: probed });
            break;
          }
        }
      }

      const candidates = cachedCandidates ?? (yield* collectCandidates()).candidates;
      cachedCandidates = candidates;

      const cursorDiscovery = yield* discoverCursorSessionsForWorkspace(workspaceRoot);
      if (cursorDiscovery.providerError !== null) {
        providerErrors.push({ source: "cursor", message: cursorDiscovery.providerError });
      }
      const cursorByInstance = Map.groupBy(
        cursorDiscovery.transcripts,
        (transcript) => transcript.providerInstanceId,
      );
      const cursorCandidates: Array<RawCandidate> = Array.from(
        cursorByInstance.entries(),
        ([providerInstanceId, transcripts]) => {
          const lastActiveAtMs = transcripts.reduce(
            (max, transcript) => Math.max(max, transcript.mtimeMs),
            0,
          );
          return {
            cwd: root,
            source: "cursor" as const,
            providerInstanceId,
            threadCount: transcripts.length,
            lastActiveAtMs,
            transcripts: transcripts.map((transcript) => ({
              filePath: transcript.filePath,
              mtimeMs: transcript.mtimeMs,
              ...(transcript.titleOverride ? { titleOverride: transcript.titleOverride } : {}),
              ...(transcript.createdAtMs != null ? { createdAtMs: transcript.createdAtMs } : {}),
              ...(transcript.lastUpdatedAtMs != null
                ? { lastUpdatedAtMs: transcript.lastUpdatedAtMs }
                : {}),
              ...(transcript.contextUsagePercent != null
                ? { contextUsagePercent: transcript.contextUsagePercent }
                : {}),
            })),
          };
        },
      );

      const eligibleTranscripts: Array<{
        readonly candidate: RawCandidate;
        readonly transcript: RawCandidate["transcripts"][number] & { readonly mtimeMs: number };
      }> = [];
      for (const candidate of [...candidates, ...cursorCandidates]) {
        const expanded = expandHomePath(candidate.cwd.trim());
        if (!path.isAbsolute(expanded)) continue;
        const resolved = path.resolve(expanded);
        if ((yield* directoryIdentity(resolved)) !== rootIdentity) continue;

        for (const transcript of candidate.transcripts) {
          if (
            transcript.mtimeMs === null ||
            transcript.mtimeMs < cutoffMs ||
            transcript.mtimeMs > nowMs
          ) {
            continue;
          }
          eligibleTranscripts.push({
            candidate,
            transcript: { ...transcript, mtimeMs: transcript.mtimeMs },
          });
        }
      }

      eligibleTranscripts.sort((left, right) => {
        if (left.transcript.mtimeMs !== right.transcript.mtimeMs) {
          return right.transcript.mtimeMs - left.transcript.mtimeMs;
        }
        return left.transcript.filePath.localeCompare(right.transcript.filePath);
      });

      const descriptors: Array<AgentSessionDescriptor> = [];
      let truncated = cursorDiscovery.truncated;
      for (const { candidate, transcript } of eligibleTranscripts) {
        if (descriptors.length >= limit) {
          truncated = true;
          break;
        }
        const stats = yield* statOption(transcript.filePath);
        if (Option.isNone(stats) || stats.value.type !== "File") continue;
        const fileSize = Number(stats.value.size);
        const cached = descriptorCache.get(transcript.filePath, {
          size: fileSize,
          mtimeMs: transcript.mtimeMs,
        });
        const meta =
          cached !== null
            ? {
                providerSessionId: cached.providerSessionId,
                promptPreview: cached.promptPreview,
                title: cached.title,
                createdAt: cached.createdAt,
                lastMessageAt: cached.lastMessageAt,
                hasCompactionSummary: cached.hasCompactionSummary,
                ...(cached.contextUsedTokens !== undefined
                  ? { contextUsedTokens: cached.contextUsedTokens }
                  : {}),
                ...(cached.contextUsedTokensFull !== undefined
                  ? { contextUsedTokensFull: cached.contextUsedTokensFull }
                  : {}),
                ...(cached.contextMaxTokens !== undefined
                  ? { contextMaxTokens: cached.contextMaxTokens }
                  : {}),
              }
            : yield* readDescriptorMeta(candidate.source, {
                filePath: transcript.filePath,
                mtimeMs: transcript.mtimeMs,
                providerInstanceId: candidate.providerInstanceId,
                size: fileSize,
              });
        if (meta === null) continue;
        if (cached === null) {
          descriptorCache.set(transcript.filePath, {
            size: fileSize,
            mtimeMs: transcript.mtimeMs,
            providerSessionId: meta.providerSessionId,
            promptPreview: meta.promptPreview,
            title: meta.title,
            createdAt: meta.createdAt,
            lastMessageAt: meta.lastMessageAt,
            hasCompactionSummary: meta.hasCompactionSummary,
            ...(meta.contextUsedTokens !== undefined
              ? { contextUsedTokens: meta.contextUsedTokens }
              : {}),
            ...(meta.contextUsedTokensFull !== undefined
              ? { contextUsedTokensFull: meta.contextUsedTokensFull }
              : {}),
            ...(meta.contextMaxTokens !== undefined
              ? { contextMaxTokens: meta.contextMaxTokens }
              : {}),
          });
        }

        const lastActiveAt = DateTime.formatIso(DateTime.makeUnsafe(transcript.mtimeMs));
        const createdAt =
          transcript.createdAtMs != null
            ? DateTime.formatIso(DateTime.makeUnsafe(transcript.createdAtMs))
            : meta.createdAt;
        const lastMessageAt =
          transcript.lastUpdatedAtMs != null
            ? DateTime.formatIso(DateTime.makeUnsafe(transcript.lastUpdatedAtMs))
            : meta.lastMessageAt;

        const recordCount =
          fileSize <= MAX_IMPORT_RECORDS
            ? 0
            : yield* countTranscriptRecordsUpTo(
                transcript.filePath,
                fileSize,
                MAX_IMPORT_RECORDS + 1,
              );
        const importable = fileSize <= MAX_IMPORT_RECORDS || recordCount <= MAX_IMPORT_RECORDS;
        const oversizedReason = "Session transcript exceeds the import record limit";

        descriptors.push({
          source: candidate.source,
          providerInstanceId: candidate.providerInstanceId,
          providerSessionId: meta.providerSessionId,
          title:
            transcript.titleOverride !== undefined && transcript.titleOverride.trim().length > 0
              ? transcript.titleOverride.trim()
              : meta.title,
          promptPreview: meta.promptPreview,
          lastActiveAt,
          cwd: candidate.cwd,
          createdAt,
          lastMessageAt,
          ...(transcript.contextUsagePercent != null
            ? { contextUsagePercent: transcript.contextUsagePercent }
            : {}),
          ...(meta.contextUsedTokens !== undefined
            ? { contextUsedTokens: meta.contextUsedTokens }
            : {}),
          ...(meta.contextUsedTokensFull !== undefined
            ? { contextUsedTokensFull: meta.contextUsedTokensFull }
            : {}),
          ...(meta.contextMaxTokens !== undefined
            ? { contextMaxTokens: meta.contextMaxTokens }
            : {}),
          importable,
          ...(importable ? {} : { importBlockedReason: oversizedReason }),
          hasCompactionSummary: meta.hasCompactionSummary,
        });
      }

      yield* descriptorCache.flush;
      return { descriptors, providerErrors, truncated };
    });

  return AgentSessionScanner.of({ scan, recentThreads, listRecentSessionDescriptors });
});

export const layer = Layer.effect(AgentSessionScanner, make);
