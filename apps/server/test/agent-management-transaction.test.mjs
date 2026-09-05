import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerAgentManagementRoutes } from "../dist/routes/agent-management.js";

test("post-commit publication failure cannot turn management success into a 409", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const owner = {
    id: "owner-a",
    projectId: "project-a",
    conversationId: "chat-a",
    activeEngine: "codex",
  };
  const child = {
    id: "child-a",
    projectId: owner.projectId,
    conversationId: owner.conversationId,
    managerAgentId: owner.id,
    activeEngine: "codex",
  };
  const plan = {
    id: "plan-a",
    agentId: owner.id,
    runId: "run-a",
    conversationId: owner.conversationId,
    scopeHash: "scope-a",
    createdAt: new Date().toISOString(),
    operations: [{
      kind: "set_manager",
      targetAgentId: child.id,
      managerAgentId: owner.id,
    }],
  };
  const managementPlans = new Map([[plan.id, plan]]);
  const capability = { agentId: owner.id, runId: plan.runId, conversationId: owner.conversationId };
  registerAgentManagementRoutes(app, {
    store: {
      getAgent: (id) => id === owner.id ? owner : id === child.id ? child : undefined,
      listAgentSubtree: () => [owner, child],
      applyAuthorizedAgentReorganization: () => [child.id],
    },
    coordinationV3: {},
    workspace: {},
    engines: new Map(),
    managementPlans,
    activeRuns: new Map([[owner.id, { runId: plan.runId, messageCapability: "token-a" }]]),
    agentMessageCapabilities: new Map([["token-a", capability]]),
    deletingAgentIds: new Set(),
    cachedModelOptions: () => [],
    capabilityOwnsAuthoritativeRun: () => true,
    publicManagementOperations: (operations) => operations,
    commitAgentDeletion: async () => { throw new Error("unexpected deletion"); },
    appendWorkspace: () => { throw new Error("workspace unavailable"); },
    publishWorkspaceSince: () => {},
    notifyScheduler: () => { throw new Error("scheduler unavailable"); },
  });

  const first = await app.inject({
    method: "POST",
    url: "/api/agent-management",
    headers: { authorization: "Bearer token-a" },
    payload: { action: "apply", planId: plan.id },
  });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json().result.changedAgentIds, [child.id]);

  const replay = await app.inject({
    method: "POST",
    url: "/api/agent-management",
    headers: { authorization: "Bearer token-a" },
    payload: { action: "apply", planId: plan.id },
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().replayed, true);
  assert.deepEqual(replay.json().result, first.json().result);
});

test("management retry replays completed creates and exact stops before mutable state", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const owner = {
    id: "owner-a",
    projectId: "project-a",
    conversationId: "chat-a",
    activeEngine: "codex",
  };
  const child = {
    id: "child-a",
    projectId: owner.projectId,
    conversationId: owner.conversationId,
    managerAgentId: owner.id,
    activeEngine: "codex",
  };
  const plan = {
    id: "plan-stop-retry",
    agentId: owner.id,
    runId: "owner-run",
    conversationId: owner.conversationId,
    scopeHash: "scope-a",
    createdAt: new Date().toISOString(),
    operations: [
      { kind: "create_agent", ref: "new-child", title: "New child", engine: "codex" },
      { kind: "stop_agent", targetAgentId: child.id, targetRunId: "child-run" },
      { kind: "rename_agent", targetAgentId: child.id, title: "Renamed child" },
    ],
  };
  const managementPlans = new Map([[plan.id, plan]]);
  const capability = {
    agentId: owner.id,
    runId: plan.runId,
    conversationId: owner.conversationId,
  };
  let receipt;
  let createdAgent;
  let creationOperation;
  let createCalls = 0;
  let failRename = true;
  let cancelCalls = 0;
  const engines = new Map([["codex", {
    adapter: { id: "codex", listModels: () => [], listEfforts: () => [] },
  }]]);
  app.post(`/api/agents/${child.id}/cancel`, async (request) => {
    cancelCalls += 1;
    receipt = {
      cancelled: true,
      replayed: false,
      runId: request.body.targetRunId,
      fencingToken: 2,
    };
    return receipt;
  });
  registerAgentManagementRoutes(app, {
    store: {
      getAgent: (id) => id === owner.id ? owner : id === child.id ? child
        : id === createdAgent?.id ? createdAgent : undefined,
      listAgentSubtree: () => [owner, child],
      findAgentCreationOperation: () => creationOperation,
      beginAgentCreationOperation: (input) => {
        creationOperation ??= {
          id: "creation-a",
          ...input,
          status: "preparing",
          agentIds: [],
          artifactIds: [],
          artifactIdentities: [],
        };
        return { operation: creationOperation };
      },
      addAgentCreationOperationMember: (_operationId, agentId) => {
        creationOperation.agentIds = [agentId];
      },
      createAgent: (_projectId, input, _origin, agentId) => {
        createCalls += 1;
        createdAgent = { id: agentId, projectId: owner.projectId, ...input };
        return createdAgent;
      },
      updateAgentCreationOperation: (_operationId, patch) =>
        Object.assign(creationOperation, patch),
      setImportedHistory: () => {},
      updateAgent: (_id, patch) => {
        if (failRename) {
          failRename = false;
          throw new Error("injected rename failure");
        }
        Object.assign(child, patch);
        return child;
      },
    },
    coordinationV3: {
      cancellationReceipt: (_agentId, idempotencyKey) =>
        idempotencyKey === `${plan.id}:1` ? receipt : undefined,
      agentSnapshot: () => ({ activeRun: receipt ? undefined : { id: "child-run" } }),
    },
    workspace: {},
    engines,
    managementPlans,
    activeRuns: new Map([[owner.id, {
      runId: plan.runId,
      messageCapability: "token-a",
    }]]),
    agentMessageCapabilities: new Map([["token-a", capability]]),
    deletingAgentIds: new Set(),
    cachedModelOptions: () => [],
    capabilityOwnsAuthoritativeRun: () => true,
    publicManagementOperations: (operations) => operations,
    commitAgentDeletion: async () => { throw new Error("unexpected deletion"); },
    appendWorkspace: () => {},
    publishWorkspaceSince: () => {},
    notifyScheduler: () => {},
  });

  const first = await app.inject({
    method: "POST",
    url: "/api/agent-management",
    headers: { authorization: "Bearer token-a" },
    payload: { action: "apply", planId: plan.id },
  });
  assert.equal(first.statusCode, 409);
  assert.equal(createCalls, 1);
  assert.equal(cancelCalls, 1);
  engines.clear();

  const retry = await app.inject({
    method: "POST",
    url: "/api/agent-management",
    headers: { authorization: "Bearer token-a" },
    payload: { action: "apply", planId: plan.id },
  });
  assert.equal(retry.statusCode, 200);
  assert.equal(createCalls, 1);
  assert.equal(cancelCalls, 1);
  assert.equal(child.title, "Renamed child");
});
