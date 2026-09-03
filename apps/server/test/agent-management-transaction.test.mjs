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
