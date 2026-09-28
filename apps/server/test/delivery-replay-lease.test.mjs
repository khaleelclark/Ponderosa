import assert from "node:assert/strict";
import test from "node:test";
import { reconcileLeasedCommunicationReplay } from "../dist/delivery-leases.js";

for (const failure of ["none", "reconcile", "read"]) {
  test(`committed replay holds and releases delivery leases when ${failure}`, async () => {
    const conversationLeases = new Map();
    const agentLeases = new Map();
    let readCalled = false;
    const result = await reconcileLeasedCommunicationReplay({
      conversationLeases,
      agentLeases,
      conversationId: "chat-1",
      agentIds: ["agent-1", "agent-1"],
      projectId: "project-1",
      communicationEventId: "event-1",
      reconcile: async (filter) => {
        assert.deepEqual(filter, { projectId: "project-1", communicationEventId: "event-1" });
        assert.equal(conversationLeases.get("chat-1"), 1);
        assert.equal(agentLeases.get("agent-1"), 1);
        if (failure === "reconcile") throw new Error("projection unavailable");
      },
      read: () => {
        readCalled = true;
        assert.equal(conversationLeases.get("chat-1"), 1);
        assert.equal(agentLeases.get("agent-1"), 1);
        if (failure === "read") throw new Error("read unavailable");
        return "projected-message";
      },
    });
    assert.equal(result.recovered, failure === "none");
    if (result.recovered) assert.equal(result.value, "projected-message");
    assert.equal(readCalled, failure !== "reconcile");
    assert.equal(conversationLeases.size, 0);
    assert.equal(agentLeases.size, 0);
  });
}
