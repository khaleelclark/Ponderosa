import { describe, expect, it } from "vitest";
import { authorizedManualRolloverConversationId } from "./routes/provider-commands.js";

describe("manual Compact rollover scope", () => {
  it("uses the source conversation only while membership is current", () => {
    expect(authorizedManualRolloverConversationId(
      { conversationIds: ["conversation-current"] },
      "conversation-current",
    )).toBe("conversation-current");
  });

  it("falls back to Agent scope after membership removal", () => {
    expect(authorizedManualRolloverConversationId(
      { conversationIds: [] },
      "conversation-removed",
    )).toBeUndefined();
  });

  it("does not trust a stale primary or last communication conversation", () => {
    const agent = {
      conversationId: "conversation-stale-primary",
      conversationIds: ["conversation-current"],
    };
    expect(authorizedManualRolloverConversationId(
      agent,
      "conversation-stale-last-communication",
    )).toBeUndefined();
  });
});
