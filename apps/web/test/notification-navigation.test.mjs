import assert from "node:assert/strict";
import test from "node:test";
import { notificationNavigationRoute } from "../src/notificationNavigation.js";

const notification = {
  id: "notice",
  projectId: "project",
  conversationId: "chat",
  agentId: "agent",
  communicationEventId: "message",
  kind: "direct_responses",
  title: "Agent replied",
  body: "Hello",
  createdAt: "2026-09-24T00:00:00.000Z",
};

test("a notification with both Agent and Chat identities opens the Chat and focuses its message", () => {
  assert.deepEqual(notificationNavigationRoute(notification, new Set(["project"])), {
    kind: "conversation", projectId: "project", conversationId: "chat", focusMessageId: "message",
  });
  assert.deepEqual(notificationNavigationRoute({
    ...notification,
    action: { kind: "open_agent", targetId: "agent" },
  }), {
    kind: "conversation", projectId: "project", conversationId: "chat", focusMessageId: "message",
  });
});

test("Agent-only alerts retain an Agent fallback and unavailable Projects cannot be opened", () => {
  const agentOnly = { ...notification, conversationId: undefined, communicationEventId: undefined };
  assert.deepEqual(notificationNavigationRoute(agentOnly), {
    kind: "agent", projectId: "project", agentId: "agent",
  });
  assert.equal(notificationNavigationRoute(notification, new Set(["other"])), undefined);
});
