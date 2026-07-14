import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWaitStore } from "../src/agent-waits.js";
import { CollaborationDeliveryStore } from "../src/handoffs.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-agent-wait-"));
  dirs.push(dataDir);
  return { dataDir, deliveries: new CollaborationDeliveryStore(dataDir), waits: new AgentWaitStore(dataDir) };
}

describe("durable agent wait conditions", () => {
  it("survives restart and releases exactly when all expected reporters arrive", () => {
    const { dataDir, deliveries, waits } = fixture();
    const registered = waits.register({
      agentId: "manager", executionId: "run-1", mode: "all",
      expectedAgentIds: ["one", "two"], quorum: 2, deliveryWatermark: deliveries.watermark(),
    }).wait;
    expect(new AgentWaitStore(dataDir).active("manager")?.id).toBe(registered.id);

    deliveries.queue({ messageId: "one", targetAgentId: "manager", authorAgentId: "one", text: "one", relayDepth: 0, mentionTrail: [], kind: "tag" });
    const reopened = new AgentWaitStore(dataDir);
    expect(reopened.evaluate("manager", deliveries.pending("manager"), deliveries).hold).toBe(true);

    deliveries.queue({ messageId: "two", targetAgentId: "manager", authorAgentId: "two", text: "two", relayDepth: 0, mentionTrail: [], kind: "tag" });
    expect(reopened.evaluate("manager", deliveries.pending("manager"), deliveries)).toMatchObject({ hold: false, wait: { status: "satisfied" } });
    expect(reopened.active("manager")).toBeUndefined();
  });

  it("counts unique reporters for quorum after the registration watermark", () => {
    const { deliveries, waits } = fixture();
    deliveries.queue({ messageId: "old", targetAgentId: "manager", authorAgentId: "one", text: "old", relayDepth: 0, mentionTrail: [], kind: "tag" });
    const old = deliveries.pending("manager")[0]!;
    deliveries.markDelivered(old.id);
    deliveries.acknowledgeBatch([old.id]);
    waits.register({
      agentId: "manager", executionId: "run-1", mode: "quorum",
      expectedAgentIds: ["one", "two", "three"], quorum: 2, deliveryWatermark: deliveries.watermark(),
    });
    deliveries.queue({ messageId: "new-one", targetAgentId: "manager", authorAgentId: "one", text: "new", relayDepth: 0, mentionTrail: [], kind: "tag" });
    deliveries.queue({ messageId: "new-one-again", targetAgentId: "manager", authorAgentId: "one", text: "again", relayDepth: 0, mentionTrail: [], kind: "tag" });
    expect(waits.evaluate("manager", deliveries.pending("manager"), deliveries).hold).toBe(true);
    deliveries.queue({ messageId: "new-two", targetAgentId: "manager", authorAgentId: "two", text: "two", relayDepth: 0, mentionTrail: [], kind: "tag" });
    expect(waits.evaluate("manager", deliveries.pending("manager"), deliveries).hold).toBe(false);
  });

  it("fails open for a direct priority signal or an elapsed deadline", () => {
    const direct = fixture();
    direct.waits.register({
      agentId: "manager", executionId: "run-1", mode: "all",
      expectedAgentIds: ["one"], quorum: 1, deliveryWatermark: direct.deliveries.watermark(),
    });
    direct.deliveries.queue({ messageId: "user", targetAgentId: "manager", text: "user", relayDepth: 0, mentionTrail: [], kind: "direct" });
    expect(direct.waits.evaluate("manager", direct.deliveries.pending("manager"), direct.deliveries)).toMatchObject({ hold: false, wait: { status: "cancelled" } });

    const deadline = fixture();
    deadline.waits.register({
      agentId: "manager", executionId: "run-1", mode: "any",
      expectedAgentIds: ["one"], quorum: 1, deliveryWatermark: 0, deadline: "2026-07-14T00:00:00.000Z",
    });
    expect(deadline.waits.evaluate("manager", [], deadline.deliveries, Date.parse("2026-07-14T00:00:01.000Z")))
      .toMatchObject({ hold: false, wait: { status: "expired" } });
  });
});
