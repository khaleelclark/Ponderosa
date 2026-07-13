import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunLedger } from "../src/run-ledger.js";
import { CollaborationDeliveryStore } from "../src/handoffs.js";

const dirs: string[] = [];
const make = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ponderosa-runs-"));
  dirs.push(dir);
  return { dir, ledger: new RunLedger(dir) };
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("RunLedger", () => {
  it("allows one durable generation and fences stale transitions", () => {
    const { ledger } = make();
    const winner = ledger.claim("agent", "winner");
    expect(() => ledger.claim("agent", "loser")).toThrow(/ownership/);
    expect(ledger.transition({ agentId: "agent", runId: "loser", generation: winner.generation }, "completed")).toBeUndefined();
    expect(ledger.current("agent")).toMatchObject({ runId: "winner", generation: 1, state: "running" });
  });

  it("rebuilds from append-only evidence, interrupts unfinished ownership, and advances generation", () => {
    const { dir, ledger } = make();
    ledger.claim("agent", "first", ["delivery-1"]);
    const restarted = new RunLedger(dir, () => "2026-07-12T01:00:00.000Z");
    expect(restarted.current("agent")).toMatchObject({ generation: 1, state: "interrupted", deliveryIds: ["delivery-1"] });
    expect(restarted.claim("agent", "second").generation).toBe(2);
    expect(readFileSync(path.join(dir, "runtime-runs.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("retains an interrupted runtime delivery without automatically replaying its prompt", () => {
    const { dir, ledger } = make();
    const deliveries = new CollaborationDeliveryStore(dir);
    const delivery = deliveries.queue({ messageId: "message", targetAgentId: "agent", text: "do once", relayDepth: 0, mentionTrail: [], kind: "direct" }).delivery;
    deliveries.markDelivered(delivery.id);
    ledger.claim("agent", "run", [delivery.id]);
    const restarted = new RunLedger(dir);
    const interrupted = new Set(restarted.all().filter((claim) => claim.state === "interrupted").flatMap((claim) => claim.deliveryIds ?? []));
    expect(new CollaborationDeliveryStore(dir).recoverUnacknowledged(interrupted)).toEqual([]);
    expect(new CollaborationDeliveryStore(dir).get(delivery.id)?.status).toBe("delivered");
  });
});
