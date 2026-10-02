import assert from "node:assert/strict";
import test from "node:test";
import { workspaceEventInvalidatesAllChat } from "../src/workspaceEventInvalidation.js";

test("remote Decision events refresh All Messages without broad notification churn", () => {
  assert.equal(workspaceEventInvalidatesAllChat({
    type: "notification_changed",
    decisionId: "decision-a",
    conversationId: "chat-a",
    action: "created",
  }), true);
  assert.equal(workspaceEventInvalidatesAllChat({
    type: "notification_changed",
    notificationId: "notification-a",
    conversationId: "chat-a",
    action: "read",
  }), false);
});

test("Agent identity lifecycle refreshes recipient presentation, routine output does not", () => {
  const event = { type: "agent_event", projectId: "p", agentId: "a", conversationIds: ["c"], seq: 1, eventType: "agent_updated" };
  assert.equal(workspaceEventInvalidatesAllChat({ ...event, category: "lifecycle" }), true);
  assert.equal(workspaceEventInvalidatesAllChat({ ...event, category: "state" }), false);
});
