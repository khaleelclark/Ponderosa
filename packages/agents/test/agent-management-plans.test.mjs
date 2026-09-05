import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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

test("interrupted Agent archive stays archived and durably recovers report detachment", () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-agent-archive-"));
  let store = new AgentStore(directory);
  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  const conversation = store.createConversation(project.id, { title: "Chat" });
  const ownerId = "00000000-0000-4000-8000-000000000101";
  const childId = "00000000-0000-4000-8000-000000000102";
  store.createAgent(project.id, {
    title: "Owner",
    engine: "codex",
    conversationId: conversation.id,
  }, undefined, ownerId);
  store.createAgent(project.id, {
    title: "Child",
    engine: "codex",
    conversationId: conversation.id,
    managerAgentId: ownerId,
  }, undefined, childId);

  const originalWrite = fs.writeSync;
  let failed = false;
  fs.writeSync = (...args) => {
    if (!failed) {
      failed = true;
      throw new Error("injected organization append failure");
    }
    return originalWrite(...args);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => store.updateAgent(ownerId, { archived: true }),
      /injected organization append failure/u,
    );
  } finally {
    fs.writeSync = originalWrite;
    syncBuiltinESMExports();
  }

  try {
    assert.equal(store.getAgent(ownerId)?.archived, true);
    assert.equal(store.getAgent(childId)?.managerAgentId, ownerId);
    store.close();

    store = new AgentStore(directory);
    assert.equal(store.getAgent(ownerId)?.archived, true);
    assert.equal(store.getAgent(childId)?.managerAgentId, undefined);

    store.updateAgent(ownerId, { archived: false });
    store.close();
    store = new AgentStore(directory);
    assert.equal(store.getAgent(ownerId)?.archived, false);
    assert.equal(store.getAgent(childId)?.managerAgentId, undefined);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
