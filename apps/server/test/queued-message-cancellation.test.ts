import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationDeliveryStore } from "../src/handoffs.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "ponderosa-cancel-"));
  dirs.push(dir);
  return { dir, store: new CollaborationDeliveryStore(dir) };
}

function queue(store: CollaborationDeliveryStore, messageId: string, orderKey: string) {
  return store.queue({
    conversationId: "chat",
    messageId,
    communicationEventId: `communication-${messageId}`,
    targetAgentId: "agent",
    text: messageId,
    relayDepth: 0,
    mentionTrail: [],
    kind: "direct",
    sourceChannel: "main",
    orderKey,
  }).delivery;
}

describe("queued project message cancellation", () => {
  it("appends a cancellation, removes only that FIFO item, and survives restart", () => {
    const { dir, store } = fixture();
    const first = queue(store, "first", "001");
    const second = queue(store, "second", "002");

    expect(store.cancelQueued(first.id, "operator cancelled")?.status).toBe("cancelled");
    expect(store.pending("agent").map((item) => item.id)).toEqual([second.id]);

    const restarted = new CollaborationDeliveryStore(dir);
    expect(restarted.get(first.id)?.status).toBe("cancelled");
    expect(restarted.pending("agent").map((item) => item.id)).toEqual([second.id]);
    expect(restarted.recoverUnacknowledged()).toEqual(["agent"]);
    expect(readFileSync(path.join(dir, "collaboration-deliveries.jsonl"), "utf8"))
      .toContain('"status":"cancelled"');
  });

  it("deduplicates queue retries and rejects cancellation after delivery begins", () => {
    const { store } = fixture();
    const first = queue(store, "same", "001");
    const replay = queue(store, "same", "001");
    expect(replay.id).toBe(first.id);
    expect(store.pendingCount("agent")).toBe(1);

    store.markDelivered(first.id);
    expect(store.cancelQueued(first.id, "too late")?.status).toBe("delivered");
    expect(store.get(first.id)?.cancelledAt).toBeUndefined();
  });
});
