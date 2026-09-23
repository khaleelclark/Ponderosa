import assert from "node:assert/strict";
import test from "node:test";
import { authorizedManualRolloverConversationId } from "../dist/routes/provider-commands.js";

test("an internal handoff Run retains its Agent Chat for manual rollover", () => {
  const agent = { conversationId: "agent-chat" };
  assert.equal(authorizedManualRolloverConversationId(agent, undefined, false), "agent-chat");
  assert.equal(authorizedManualRolloverConversationId(agent, "agent-chat", true), "agent-chat");
  assert.equal(authorizedManualRolloverConversationId(agent, "other-chat", true), undefined);
  assert.equal(authorizedManualRolloverConversationId(agent, undefined, true), undefined);
});
