import { describe, expect, it } from "vitest";

import { AcpContextEstimator } from "./AcpAdapterSupport.ts";

const toolCall = (toolCallId: string, detail: string) => ({
  toolCallId,
  detail,
  data: {},
});

describe("AcpContextEstimator", () => {
  it("estimates the running context at four chars per token", () => {
    const estimator = new AcpContextEstimator();
    estimator.beginTurn({ compaction: false });
    estimator.addPromptText("12345678"); // 8 chars -> 2 tokens
    estimator.addAssistantText("1234"); // 4 chars -> 1 token
    estimator.addToolCallState(toolCall("t1", "12345678")); // 8 chars -> 2 tokens

    expect(estimator.endTurn()).toEqual({
      usedTokens: 5,
      lastUsedTokens: 5,
      estimated: true,
    });
  });

  it("counts only tool output growth across redraws of the same call", () => {
    const estimator = new AcpContextEstimator();
    estimator.beginTurn({ compaction: false });
    estimator.addToolCallState(toolCall("t1", "12345678"));
    estimator.addToolCallState(toolCall("t1", "1234567890")); // 2 new chars -> 1 token
    estimator.addToolCallState(toolCall("t1", "1234567890")); // no growth

    expect(estimator.endTurn()).toEqual({
      usedTokens: 3,
      lastUsedTokens: 3,
      estimated: true,
    });
  });

  it("re-estimates from the compaction turn's own output", () => {
    const estimator = new AcpContextEstimator();
    estimator.beginTurn({ compaction: false });
    estimator.addPromptText("12345678");
    estimator.addAssistantText("12345678");
    expect(estimator.endTurn()).toEqual({ usedTokens: 4, lastUsedTokens: 4, estimated: true });

    // A /compact-style turn rewrites the context: everything before it is
    // replaced by the summary the turn itself streams.
    estimator.beginTurn({ compaction: true });
    estimator.addPromptText("12345678");
    estimator.addAssistantText("12345678");
    expect(estimator.endTurn()).toEqual({ usedTokens: 4, lastUsedTokens: 4, estimated: true });
  });

  it("carries the settled context across turns and isolates the last turn's share", () => {
    const estimator = new AcpContextEstimator();
    estimator.beginTurn({ compaction: false });
    estimator.addAssistantText("12345678");
    expect(estimator.endTurn()).toEqual({ usedTokens: 2, lastUsedTokens: 2, estimated: true });

    estimator.beginTurn({ compaction: false });
    estimator.addAssistantText("1234");
    expect(estimator.endTurn()).toEqual({ usedTokens: 3, lastUsedTokens: 1, estimated: true });
  });

  it("skips the snapshot when the turn carried no text", () => {
    const estimator = new AcpContextEstimator();
    estimator.beginTurn({ compaction: false });
    estimator.addToolCallState(toolCall("t1", ""));
    expect(estimator.endTurn()).toBeUndefined();
  });
});
