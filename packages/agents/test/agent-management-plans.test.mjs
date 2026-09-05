import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore } from "../dist/index.js";

test("management plans preserve frozen input and per-operation progress across restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-management-plan-"));
  const plan = {
    id: "management-a", projectId: "project-a", conversationId: "chat-a",
    agentId: "owner-a", runId: "run-a", idempotencyKey: "key-a", requestHash: "request-a",
    operations: [
      { kind: "rename_agent", targetAgentId: "child-a", title: "Renamed" },
      { kind: "stop_agent", targetAgentId: "child-a", targetRunId: "child-run-a" },
    ],
    scopeHash: "scope-a", approvalRequired: false, status: "planned",
    operationProgress: [], refs: {}, changedAgentIds: [], createdAt: "2026-01-01T00:00:00.000Z",
  };
  const store = new AgentStore(directory);
  store.createAgentManagementPlan(plan);
  store.updateAgentManagementPlan(plan.id, { status: "applying", operationProgress: [
    { index: 0, kind: "rename_agent", receipt: { agentId: "child-a", title: "Renamed" } },
  ], changedAgentIds: ["child-a"] });
  store.close();

  const reopened = new AgentStore(directory);
  try {
    const recovered = reopened.getAgentManagementPlan(plan.id);
    assert.equal(recovered.status, "applying");
    assert.deepEqual(recovered.operations, plan.operations);
    assert.deepEqual(recovered.operationProgress, [
      { index: 0, kind: "rename_agent", receipt: { agentId: "child-a", title: "Renamed" } },
    ]);
    assert.deepEqual(recovered.changedAgentIds, ["child-a"]);
    assert.throws(() => reopened.createAgentManagementPlan({ ...plan, requestHash: "different" }), /reused with different input/u);
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
