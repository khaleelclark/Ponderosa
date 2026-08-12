import type { HistoryWindowDto, MessageDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { mergeMessagePage } from "./AgentDetail.helpers";

const message = (seq: number): MessageDto => ({
  id: `message-${seq}`,
  agentId: "agent-1",
  seq,
  role: "assistant",
  text: `Message ${seq}`,
  createdAt: new Date(seq * 1_000).toISOString(),
});

const history = (cursor: string | undefined, hasMore = true): HistoryWindowDto => ({
  limit: 25,
  hasMore,
  ...(cursor ? { cursor } : {}),
});

describe("Agent focused-message history", () => {
  it("keeps the ordinary cursor and fills every gap without duplicates", () => {
    const recent = Array.from({ length: 15 }, (_, index) => message(index + 1));
    const focused = Array.from({ length: 25 }, (_, index) => message(index + 50));

    let state = mergeMessagePage(
      undefined,
      { messages: focused, history: history("after-74") },
      recent,
      true,
      history("after-15"),
    );
    expect(state.cursor).toBe("after-15");
    expect(state.hasMore).toBe(true);

    state = mergeMessagePage(
      state,
      {
        messages: Array.from({ length: 25 }, (_, index) => message(index + 16)),
        history: history("after-40"),
      },
      recent,
    );
    state = mergeMessagePage(
      state,
      {
        messages: Array.from({ length: 25 }, (_, index) => message(index + 41)),
        history: history("after-65"),
      },
      recent,
    );

    expect(state.cursor).toBe("after-65");
    expect(state.messages.map(item => item.seq)).toEqual(
      Array.from({ length: 74 }, (_, index) => index + 1),
    );
  });

  it("preserves an already-advanced ordinary cursor across a focused lookup", () => {
    const recent = Array.from({ length: 15 }, (_, index) => message(index + 1));
    const ordinary = mergeMessagePage(
      undefined,
      {
        messages: Array.from({ length: 25 }, (_, index) => message(index + 16)),
        history: history("after-40"),
      },
      recent,
    );
    const focused = mergeMessagePage(
      ordinary,
      {
        messages: Array.from({ length: 25 }, (_, index) => message(index + 75)),
        history: history(undefined, false),
      },
      recent,
      true,
      history("after-15"),
    );

    expect(focused.cursor).toBe("after-40");
    expect(focused.hasMore).toBe(true);
  });
});
