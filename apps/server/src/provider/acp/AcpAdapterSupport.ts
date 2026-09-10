import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type AcpToolCallState, toolCallProgressLength } from "./AcpRuntimeModel.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}

// Rough char-to-token ratio for English prose plus code; the estimate is
// coarse by design and labeled as such.
const ESTIMATE_CHARS_PER_TOKEN = 4;

/**
 * Estimated context occupancy for ACP providers whose streams carry no token
 * accounting (Cursor, Grok, Antigravity). Conversation text accumulates at
 * roughly four chars per token; snapshots carry `estimated: true` so clients
 * render a "~" prefix instead of presenting the count as provider-reported.
 *
 * A compaction turn rewrites the context: everything streamed before it is
 * replaced by the summary the turn itself produces, so its accumulation
 * restarts from zero and the compacted size re-estimates from the summary.
 */
export class AcpContextEstimator {
  #contextChars = 0;
  #turnChars = 0;
  readonly #toolCallChars = new Map<string, number>();

  /** Starts a fresh turn; a compaction turn also resets the running context. */
  beginTurn(input: { readonly compaction: boolean }): void {
    if (input.compaction) {
      this.#contextChars = 0;
      this.#toolCallChars.clear();
    }
    this.#turnChars = 0;
  }

  addPromptText(text: string): void {
    this.#account(text.length);
  }

  addAssistantText(text: string): void {
    this.#account(text.length);
  }

  addToolCallState(toolCall: AcpToolCallState): void {
    // Tool outputs stream as redraws of the same call, so only the growth
    // since the last update is new context.
    const progressChars = toolCallProgressLength(toolCall);
    const previousChars = this.#toolCallChars.get(toolCall.toolCallId) ?? 0;
    this.#toolCallChars.set(toolCall.toolCallId, progressChars);
    this.#account(Math.max(0, progressChars - previousChars));
  }

  /** The settled turn's snapshot; undefined when the turn carried no text. */
  endTurn(): ThreadTokenUsageSnapshot | undefined {
    if (this.#contextChars <= 0) {
      return undefined;
    }
    return {
      usedTokens: Math.ceil(this.#contextChars / ESTIMATE_CHARS_PER_TOKEN),
      lastUsedTokens: Math.ceil(this.#turnChars / ESTIMATE_CHARS_PER_TOKEN),
      estimated: true,
    };
  }

  #account(chars: number): void {
    if (chars <= 0) {
      return;
    }
    this.#contextChars += chars;
    this.#turnChars += chars;
  }
}
