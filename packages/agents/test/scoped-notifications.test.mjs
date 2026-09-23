import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceStore } from "../dist/index.js";

test("chat notification inheritance and agent override preserve pending actions and replay", () => {
  const root = mkdtempSync(join(tmpdir(), "scoped-notifications-"));
  try {
    const store = new WorkspaceStore(root);
    const common = { conversationId: "chat", agentId: "agent", title: "Test", body: "Test" };
    const message = store.createNotification({ ...common, kind: "direct_responses", communicationEventId: "message" });
    const decision = store.createNotification({ ...common, kind: "decision", severity: "urgent" });
    const unrelated = store.createNotification({ ...common, conversationId: "other", agentId: "other", kind: "direct_responses" });
    const ids = () => store.listNotificationPage({ limit: 100 }).items.map(x => x.id).sort();
    assert.equal(ids().length, 3);
    assert.equal(store.notificationAllowed({ kind: "broadcasts", conversationId: "chat", sourceAgentId: "agent" }), true);
    store.updatePreferences({ notificationScopes: { "conversation:chat": "attention" } });
    assert.deepEqual(ids(), [decision.id, unrelated.id].sort());
    store.updatePreferences({ notificationScopes: { "conversation:chat": "muted" } });
    assert.equal(store.notificationAllowed({ kind: "broadcasts", conversationId: "chat", sourceAgentId: "agent" }), false);
    assert.deepEqual(ids(), [unrelated.id]);
    assert.equal(store.getNotification(decision.id).status, "open");
    assert.deepEqual(store.activeNotificationIds([decision.id, message.id]), []);
    assert.deepEqual(store.notificationSearchState({ communicationEventIds: ["message"], conversationIds: ["chat"] }).unreadCommunicationEventIds, []);
    store.updatePreferences({ notificationScopes: { "conversation:chat": "muted", "agent:agent": "all" } });
    assert.equal(ids().length, 3);
    const reopened = new WorkspaceStore(root);
    assert.equal(reopened.listNotificationPage({ limit: 100 }).items.length, 3);
    reopened.updatePreferences({ notificationScopes: { "conversation:chat": "muted" } });
    assert.equal(reopened.listNotificationPage({ limit: 100 }).items.length, 1);
    assert.equal(reopened.notificationProjection({ projectIds: [], conversationIds: ["chat"] }).conversations.chat.totalCount, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("muting abandons queued push and does not replay muted alerts when unmuted", () => {
  const root = mkdtempSync(join(tmpdir(), "scoped-push-"));
  try {
    const store = new WorkspaceStore(root);
    store.putPushSubscription({ deviceId: "device", endpoint: "https://example.test/push", expirationTime: null, keys: { p256dh: "test", auth: "test" } });
    const input = { conversationId: "chat", agentId: "agent", kind: "direct_responses", title: "Test", body: "Test" };
    store.createNotification(input, true);
    assert.equal(store.duePushDeliveries().length, 1);
    store.updatePreferences({ notificationScopes: { "conversation:chat": "muted" } });
    assert.equal(store.duePushDeliveries().length, 0);
    assert.equal(store.listPushDeliveries()[0].status, "abandoned");
    store.createNotification(input, true);
    store.updatePreferences({ notificationScopes: {} });
    assert.equal(store.duePushDeliveries().length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
