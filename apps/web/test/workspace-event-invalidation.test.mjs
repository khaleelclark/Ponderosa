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
