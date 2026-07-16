import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "../src/workspace-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "ponderosa-workspace-store-"));
  dirs.push(dir);
  return { dir, store: new WorkspaceStore(dir) };
}

describe("WorkspaceStore canonical replay", () => {
  it("persists synced preferences and revisioned drafts with deterministic conflicts", () => {
    const { dir, store } = fixture();
    store.updatePreferences({ projectSort: "custom", projectOrder: ["two", "one"], sidebarWidth: 340 });
    const first = store.putDraft("chat", { text: "first", attachmentIds: ["asset"], expectedRevision: 0, clientId: "tab-a" });
    expect(first.revision).toBe(1);
    let conflict: unknown;
    try { store.putDraft("chat", { text: "stale", attachmentIds: [], expectedRevision: 0, clientId: "tab-b" }); } catch (error) { conflict = error; }
    expect(conflict).toMatchObject({ code: "DRAFT_CONFLICT", current: first, displaced: { text: "stale", clientId: "tab-b" } });

    const restarted = new WorkspaceStore(dir);
    expect(restarted.instanceId()).toBe(store.instanceId());
    expect(restarted.getPreferences()).toMatchObject({ projectSort: "custom", projectOrder: ["two", "one"], sidebarWidth: 340 });
    expect(restarted.getDraft("chat")).toEqual(first);
    expect(restarted.listDraftConflicts("chat").conflicts).toEqual([expect.objectContaining({ current: first, displaced: expect.objectContaining({ text: "stale" }) })]);
    expect(restarted.readSince(0).map((item) => item.id)).toEqual(restarted.readSince(0).map((_, index) => index + 1));
  });

  it("deduplicates notifications and rotates/removes one device subscription", () => {
    const { dir, store } = fixture();
    const notification = store.createNotification({ projectId: "project", conversationId: "chat", communicationEventId: "event", kind: "mentions", title: "Agent", body: "Hello" });
    expect(store.createNotification({ projectId: "project", conversationId: "chat", communicationEventId: "event", kind: "mentions", title: "Agent", body: "Hello" })).toEqual(notification);
    store.readConversation("chat");
    expect(store.listNotifications()[0]?.readAt).toBeTruthy();

    store.putPushSubscription({ deviceId: "phone", endpoint: "https://push.example/one", expirationTime: null, keys: { p256dh: "one", auth: "auth" } });
    store.putPushSubscription({ deviceId: "phone", endpoint: "https://push.example/two", expirationTime: null, keys: { p256dh: "two", auth: "auth" } });
    expect(store.listPushSubscriptions()).toHaveLength(1);
    expect(store.listPushSubscriptions()[0]?.endpoint).toContain("/two");
    store.deletePushSubscription("phone");
    expect(new WorkspaceStore(dir).listPushSubscriptions()).toEqual([]);
  });

  it("persists one push delivery per subscribed endpoint and converges read state after restart", () => {
    const { dir, store } = fixture();
    const first = store.putPushSubscription({ deviceId: "tab-a", endpoint: "https://push.example/device", expirationTime: null, keys: { p256dh: "one", auth: "auth" } });
    expect(store.putPushSubscription({ deviceId: "tab-a", endpoint: first.endpoint, expirationTime: null, keys: first.keys })).toEqual(first);
    // Clearing local storage can create a new device ID, but the endpoint still
    // identifies one browser subscription and must not receive duplicates.
    store.putPushSubscription({ deviceId: "tab-b", endpoint: first.endpoint, expirationTime: null, keys: first.keys });
    expect(store.listPushSubscriptions().map((item) => item.deviceId)).toEqual(["tab-b"]);

    const notification = store.createNotification({ projectId: "project", conversationId: "chat", communicationEventId: "message", kind: "direct_responses", title: "Agent", body: "Done" }, true);
    expect(store.duePushDeliveries()).toHaveLength(1);
    store.updatePushDelivery({ notificationId: notification.id, deviceId: "tab-b", status: "delivered", deliveredAt: new Date().toISOString() });
    store.readConversation("chat");

    const restarted = new WorkspaceStore(dir);
    expect(restarted.duePushDeliveries()).toEqual([]);
    expect(restarted.listPushDeliveries()).toEqual([expect.objectContaining({ notificationId: notification.id, deviceId: "tab-b", status: "delivered", attempts: 1 })]);
    expect(restarted.listNotifications()[0]?.readAt).toBeTruthy();
  });
});
