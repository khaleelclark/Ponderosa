import assert from "node:assert/strict";
import test from "node:test";
import { createOperationalNotifications } from "../dist/operational-notifications.js";

test("urgent message notices identify their Agent, Chat and exact source message without putting excerpts in push copy", () => {
  const created = [];
  const failures = ["message-one", "message-two"].map((communicationEventId, index) => ({
    id: `activation-${index}`, projectId: "project", agentId: "agent", kind: "human_message",
    scopeKey: "conversation:chat", communicationEventId, communicationIntent: "direct",
    state: "outcome_unknown", deliveryFailures: 1, supersededByRetry: false,
  }));
  const context = {
    store: {
      getAgent: () => ({ title: "Richmond" }),
      getConversation: () => ({ id: "chat", title: "Glance" }),
      getCommunicationEvent: (_projectId, id) => ({ text: `Please inspect ${id} before continuing.` }),
    },
    coordinationV3: { communicationAttentionActivations: () => failures },
    workspace: {
      cursor: () => 0,
      createNotification: (input, push) => { created.push({ ...input, push }); return input; },
      forEachOpenOperationalNotification: () => {},
    },
    publishWorkspaceSince: () => {},
  };
  createOperationalNotifications(context).reconcileCommunicationFailureNotifications();
  assert.equal(created.length, 2);
  assert.notEqual(created[0].dedupeKey, created[1].dedupeKey);
  for (const [index, notice] of created.entries()) {
    assert.match(notice.title, /Richmond/);
    assert.equal(notice.conversationId, "chat");
    assert.equal(notice.communicationEventId, failures[index].communicationEventId);
    assert.match(notice.contextPreview, new RegExp(failures[index].communicationEventId));
    assert.doesNotMatch(notice.body, /Please inspect/);
    assert.equal(notice.push, true);
  }
});
