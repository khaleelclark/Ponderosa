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

test("clear all dismisses only the selected live tab across pages and survives replay", () => {
  const root = mkdtempSync(join(tmpdir(), "notification-clear-all-"));
  try {
    const store = new WorkspaceStore(root);
    const updates = Array.from({ length: 105 }, (_, index) => store.createNotification({
      projectId: "project", conversationId: "chat", kind: "direct_responses",
      title: `Update ${index}`, body: "A response",
    }));
    const actions = Array.from({ length: 3 }, (_, index) => store.createNotification({
      projectId: "project", conversationId: "chat", kind: "operational", severity: "urgent",
      title: `Action ${index}`, body: "Needs review",
    }));
    assert.deepEqual(store.listNotificationPage({ limit: 100 }).openActionCount, 3);
    assert.deepEqual(store.listNotificationPage({ limit: 100 }).unreadUpdateCount, 105);
    assert.equal(store.dismissNotifications("updates"), 105);
    assert.equal(store.dismissNotifications("updates"), 0);
    assert.deepEqual(store.listNotificationPage({ limit: 100 }).items.map(item => item.id).sort(), actions.map(item => item.id).sort());
    assert.equal(store.getNotification(updates.at(-1).id).status, "dismissed");
    assert.equal(store.dismissNotifications("attention"), 3);
    assert.equal(store.listNotificationPage({ limit: 100 }).openActionCount, 0);
    assert.equal(store.listNotificationPage({ limit: 100 }).unreadUpdateCount, 0);
    const reopened = new WorkspaceStore(root);
    assert.equal(reopened.listNotificationPage({ limit: 100 }).items.length, 0);
    assert.equal(reopened.getNotification(actions[0].id).status, "dismissed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dismissing one update removes it and its pending push without touching a sibling", () => {
  const root = mkdtempSync(join(tmpdir(), "notification-dismiss-one-"));
  try {
    const store = new WorkspaceStore(root);
    store.putPushSubscription({ deviceId: "device", endpoint: "https://example.test/push", expirationTime: null, keys: { p256dh: "test", auth: "test" } });
    const first = store.createNotification({ projectId: "project", conversationId: "chat", kind: "direct_responses", title: "First", body: "First" }, true);
    const second = store.createNotification({ projectId: "project", conversationId: "chat", kind: "direct_responses", title: "Second", body: "Second" }, true);
    assert.equal(store.duePushDeliveries().length, 2);
    store.setNotificationStatus(first.id, "dismissed");
    assert.deepEqual(store.duePushDeliveries().map(({ notification }) => notification.id), [second.id]);
    assert.equal(store.getNotification(first.id).readAt !== undefined, true);
    assert.deepEqual(store.listNotificationPage({ limit: 100 }).items.map(item => item.id), [second.id]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
