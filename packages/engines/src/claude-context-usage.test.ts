import { describe, expect, it } from "vitest";
import { mapClaudeAssistantUsage, mapClaudeEvent } from "./claude-events.js";

describe("Claude context occupancy qualification", () => {
  it("does not mislabel assistant billing usage as a normalized context_usage event", () => {
    const raw = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "candidate response" }],
        usage: {
          input_tokens: 1_000,
          cache_read_input_tokens: 4_000,
          cache_creation_input_tokens: 500,
          output_tokens: 20,
        },
      },
    };
    expect(mapClaudeAssistantUsage(raw)).toMatchObject({ inputTokens: 5_500 });
    expect(mapClaudeEvent(raw, { cwd: "/tmp" }).some((event) => event.type === "context_usage"))
      .toBe(false);
  });
});
