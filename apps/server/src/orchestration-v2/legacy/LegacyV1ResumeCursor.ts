import { ProviderDriverKind } from "@t3tools/contracts";
import * as Result from "effect/Result";

/** Why a V1 `resume_cursor_json` cannot name a native provider session. */
export type LegacyV1ResumeCursorRejection =
  | "malformed-json"
  | "missing-cursor"
  | "missing-native-id"
  | "unsupported-provider"
  | "unsupported-cursor-version";

export interface LegacyV1NativeSession {
  readonly driver: ProviderDriverKind;
  readonly nativeId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const nonBlankString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const parseCursorText = (cursor: unknown): Result.Result<unknown, "malformed-json"> => {
  if (typeof cursor !== "string") return Result.succeed(cursor);
  try {
    return Result.succeed(JSON.parse(cursor));
  } catch {
    return Result.fail("malformed-json");
  }
};

/**
 * Translate the cursor V1's provider adapters persisted into the native
 * session id V2 resumes from. `cursor` is the parsed object or its raw JSON
 * text. The T3 `threadId` inside a Claude cursor is never the native session:
 * only `resume` (or its historical `sessionId` alias) is, and it must be a UUID.
 * Other Claude fields (`resumeSessionAt`, `turnCount`, ...) are not read.
 */
export const decodeLegacyV1ResumeCursor = (
  providerName: string,
  cursor: unknown,
): Result.Result<LegacyV1NativeSession, LegacyV1ResumeCursorRejection> => {
  if (providerName !== "claudeAgent" && providerName !== "codex" && providerName !== "cursor") {
    return Result.fail("unsupported-provider");
  }
  const parsed = parseCursorText(cursor);
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  const value = parsed.success;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Result.fail("missing-cursor");
  }
  const fields = value as Readonly<Record<string, unknown>>;
  const driver = ProviderDriverKind.make(providerName);

  if (providerName === "cursor") {
    if (fields.schemaVersion !== 1) return Result.fail("unsupported-cursor-version");
    const nativeId = nonBlankString(fields.sessionId);
    return nativeId === undefined
      ? Result.fail("missing-native-id")
      : Result.succeed({ driver, nativeId });
  }
  if (providerName === "codex") {
    const nativeId = nonBlankString(fields.threadId);
    return nativeId === undefined
      ? Result.fail("missing-native-id")
      : Result.succeed({ driver, nativeId });
  }
  // `resume` wins over the alias; a present but malformed `resume` is not repaired by it.
  const claudeId = nonBlankString(fields.resume) ?? nonBlankString(fields.sessionId);
  return claudeId === undefined || !UUID_PATTERN.test(claudeId)
    ? Result.fail("missing-native-id")
    : Result.succeed({ driver, nativeId: claudeId });
};
