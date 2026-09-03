import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
    assert.equal(retry.operation.lastError, undefined);
  } finally {
    store.close();
  }
});
