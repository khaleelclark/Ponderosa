import assert from "node:assert/strict";
import test from "node:test";
import { reconcileCommittedAgentCreation } from "../dist/agent-creation-recovery.js";

for (const failure of ["none", "projection", "settlement"]) {
  test(`canonical Agent creation recovery retains authority when ${failure}`, async () => {
    const deletingAgentIds = new Set(["agent-1", "agent-2"]);
    const calls = [];
    const recovered = await reconcileCommittedAgentCreation({
      store: {
        updateAgentCreationOperation: (id, update) => {
          calls.push(["settlement", id, update]);
          if (failure === "settlement") throw new Error("database unavailable");
        },
      },
      deletingAgentIds,
      operationId: "operation-1",
      projectId: "project-1",
      communicationEventId: "event-1",
      agentIds: ["agent-1", "agent-2"],
      reconcile: async (filter) => {
        calls.push(["projection", filter]);
        assert.deepEqual(filter, {
          projectId: "project-1",
          communicationEventId: "event-1",
          allowQuarantinedAgentIds: new Set(["agent-1", "agent-2"]),
        });
        if (failure === "projection") throw new Error("projection unavailable");
      },
    });
    assert.equal(recovered, failure === "none");
    assert.equal(calls[0][0], "projection");
    assert.equal(calls.some(([kind]) => kind === "settlement"), failure !== "projection");
    assert.deepEqual([...deletingAgentIds], failure === "none" ? [] : ["agent-1", "agent-2"]);
  });
}
