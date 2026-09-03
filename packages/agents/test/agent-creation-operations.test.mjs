import assert from "node:assert/strict";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { AgentStore } from "../dist/index.js";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryStore() {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-agent-create-operation-"));
  temporaryDirectories.push(directory);
  return { directory, store: new AgentStore(directory) };
}

const operation = {
  projectId: "project-1",
  actorScope: "user:local-operator",
  kind: "human",
  idempotencyKey: "create-1",
  payloadHash: "payload-a",
};

test("creation operations preserve exact members and completed replay across restart", () => {
  const { directory, store } = temporaryStore();
  const begun = store.beginAgentCreationOperation(operation);
  assert.equal(begun.replayed, false);
  store.addAgentCreationOperationMember(begun.operation.id, "agent-1", 0);
  store.updateAgentCreationOperation(begun.operation.id, {
    status: "canonical_committed",
    communicationEventId: "communication-1",
    artifactIds: ["artifact-1"],
    artifactIdentities: [{
      id: "artifact-1",
      byteLength: 12,
      sha256: "a".repeat(64),
    }],
    result: { agent: { id: "agent-1" }, requestId: "request-1" },
  });
  assert.deepEqual(store.listRecoverableAgentCreationOperations().map((item) => item.agentIds), [["agent-1"]]);
  store.updateAgentCreationOperation(begun.operation.id, { status: "completed" });
  store.close();

  const reopened = new AgentStore(directory);
  try {
    const replay = reopened.beginAgentCreationOperation(operation);
    assert.equal(replay.replayed, true);
    assert.equal(replay.operation.status, "completed");
    assert.deepEqual(replay.operation.agentIds, ["agent-1"]);
    assert.deepEqual(replay.operation.artifactIds, ["artifact-1"]);
    assert.deepEqual(replay.operation.artifactIdentities, [{
      id: "artifact-1",
      byteLength: 12,
      sha256: "a".repeat(64),
    }]);
    assert.deepEqual(replay.operation.result, { agent: { id: "agent-1" }, requestId: "request-1" });
    assert.throws(
      () => reopened.beginAgentCreationOperation({ ...operation, payloadHash: "payload-b" }),
      /reused with different input/u,
    );
  } finally {
    reopened.close();
  }
});

test("rolled-back operations restart cleanly without survivor members", () => {
  const { store } = temporaryStore();
  try {
    const begun = store.beginAgentCreationOperation(operation);
    store.addAgentCreationOperationMember(begun.operation.id, "agent-1", 0);
    store.updateAgentCreationOperation(begun.operation.id, {
      status: "rolled_back",
      lastError: "interrupted before commit",
    });

    const retry = store.beginAgentCreationOperation(operation);
    assert.equal(retry.replayed, false);
    assert.equal(retry.operation.status, "preparing");
    assert.deepEqual(retry.operation.agentIds, []);
    assert.deepEqual(retry.operation.artifactIds, []);
    assert.deepEqual(retry.operation.artifactIdentities, []);
    assert.equal(retry.operation.lastError, undefined);
  } finally {
    store.close();
  }
});

test("preparing creation members are quarantined from ordinary Agent scheduling and reads", () => {
  const { store } = temporaryStore();
  try {
    const project = store.createProject({
      label: "Project",
      hostPath: "/tmp/project",
      defaultEngine: "codex",
    });
    const conversation = store.createConversation(project.id, { title: "Chat" });
    const begun = store.beginAgentCreationOperation({ ...operation, projectId: project.id });
    const agentId = "00000000-0000-4000-8000-000000000001";
    store.addAgentCreationOperationMember(begun.operation.id, agentId, 0);
    store.createAgent(project.id, {
      title: "Hidden until committed",
      engine: "codex",
      conversationId: conversation.id,
    }, undefined, agentId);

    assert.equal(store.agentCreationPending(agentId), true);
    assert.deepEqual(store.listAgents(project.id), []);
    assert.deepEqual(store.listAgentEngineAssignments().filter((item) => item.id === agentId), []);
    assert.equal(store.getAgentTitleProjection([agentId]).has(agentId), false);
    assert.deepEqual(store.listAgents(project.id, { includePendingCreation: true }).map((item) => item.id), [agentId]);

    store.updateAgentCreationOperation(begun.operation.id, { status: "completed", result: { agentId } });
    assert.equal(store.agentCreationPending(agentId), false);
    assert.deepEqual(store.listAgents(project.id).map((item) => item.id), [agentId]);
    assert.deepEqual(store.listAgentEngineAssignments().filter((item) => item.id === agentId).map((item) => item.id), [agentId]);
    assert.equal(store.getAgentTitleProjection([agentId]).get(agentId), "Hidden until committed");
  } finally {
    store.close();
  }
});

test("startup publishes a row-backed .creating directory before projection rebuild", () => {
  const { directory, store } = temporaryStore();
  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  const conversation = store.createConversation(project.id, { title: "Chat" });
  const agent = store.createAgent(project.id, {
    title: "Interrupted creation",
    engine: "codex",
    conversationId: conversation.id,
  });
  const agentsDirectory = join(directory, "projects", project.id, "agents");
  const canonical = join(agentsDirectory, agent.id);
  const staging = join(agentsDirectory, `.${agent.id}.creating`);
  store.close();
  renameSync(canonical, staging);

  const reopened = new AgentStore(directory);
  try {
    assert.equal(existsSync(staging), false);
    assert.equal(existsSync(canonical), true);
    assert.equal(reopened.getAgent(agent.id)?.id, agent.id);
  } finally {
    reopened.close();
  }
});
