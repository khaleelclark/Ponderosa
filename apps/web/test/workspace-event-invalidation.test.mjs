import assert from "node:assert/strict";
import test from "node:test";
import { workspaceEventInvalidatesAllChat, workspaceEventUpdatesLiveProgress } from "../src/workspaceEventInvalidation.js";

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

test("live activity refresh uses observed call transitions, not private text or unrelated task metadata", () => {
  const event = { type: "agent_event", projectId: "p", agentId: "a", conversationIds: ["c"], seq: 1, category: "task" };
  for (const eventType of ["command", "tool_call", "tool_result"]) {
    assert.equal(workspaceEventUpdatesLiveProgress({ ...event, eventType }), true);
    assert.equal(workspaceEventInvalidatesAllChat({ ...event, eventType }), false, "not a new Communication");
    assert.equal(workspaceEventUpdatesLiveProgress({ ...event, eventType, conversationIds: [] }), false);
  }
  assert.equal(workspaceEventUpdatesLiveProgress({ ...event, category: "progress", eventType: "text" }), true);
  for (const eventType of ["reasoning", "text", "browser_console", "file_change", "work_item_update"]) {
    assert.equal(workspaceEventUpdatesLiveProgress({ ...event, eventType }), false);
  }
});
