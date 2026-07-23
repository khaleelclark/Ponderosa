import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceStore } from "@ponderosa/agents";
import { pushPayload, WebPushDeliveryManager } from "../src/web-push-delivery.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "ponderosa-push-delivery-"));
  dirs.push(dir);
  const store = new WorkspaceStore(dir);
  store.putPushSubscription({ deviceId: "phone", endpoint: "https://push.example/device", expirationTime: null, keys: { p256dh: "key", auth: "auth" } });
  const notification = store.createNotification({ projectId: "project / one", conversationId: "chat one", communicationEventId: "event #1", kind: "direct_responses", title: "Agent", body: "Done" }, true);
  return { store, notification };
}

describe("durable Web Push delivery", () => {
  it("retries a transient failure and never sends a delivered notification twice", async () => {
    const { store } = fixture();
    let now = Date.now();
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const manager = new WebPushDeliveryManager({
      store,
      sender: { send },
      onWorkspaceEvents: () => undefined,
      now: () => now,
      retryDelaysMs: [100],
    });

    await manager.drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ timeout: 4_000 }),
    );
    expect(store.listPushDeliveries()[0]).toMatchObject({ status: "pending", attempts: 1 });
    now += 100;
    await manager.drain();
    await manager.drain();
    manager.stop();
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.listPushDeliveries()[0]).toMatchObject({ status: "delivered", attempts: 2 });
  });

  it("abandons an expired subscription and removes it canonically", async () => {
    const { store } = fixture();
    const error = Object.assign(new Error("gone"), { statusCode: 410 });
    const manager = new WebPushDeliveryManager({
      store,
      sender: { send: vi.fn().mockRejectedValue(error) },
      onWorkspaceEvents: () => undefined,
    });
    await manager.drain();
    manager.stop();
    expect(store.listPushSubscriptions()).toEqual([]);
    expect(store.listPushDeliveries()[0]).toMatchObject({ status: "abandoned", attempts: 1, lastError: "push service returned 410" });
  });

  it("links a push to the exact canonical conversation message", () => {
    const { notification } = fixture();
    expect(pushPayload(notification)).toMatchObject({
      notificationId: notification.id,
      url: "/projects/project%20%2F%20one/chats/chat%20one?message=event%20%231",
    });
  });
});
