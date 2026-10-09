import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {PONDEROSA_MANAGE_TOOL,PONDEROSA_CREATE_MANAGED_AGENT_TOOL} from '@ponderosa/core';
const scopeStore={getConversation:id=>({id,projectId:'project-a'}),getProject:id=>({id}),
 agentCreationPending:()=>false,getProjectDeletionReceipt:()=>undefined,getConversationDeletionReceipt:()=>undefined,
 sqlite:{prepare:sql=>({get:()=>sql.includes('SELECT c.branch_id')?{branch_id:null}:undefined})}};
const admitted=entries=>new Map(entries.map(([token,cap])=>[token,{...cap,availableToolNames:[PONDEROSA_MANAGE_TOOL.name,PONDEROSA_CREATE_MANAGED_AGENT_TOOL.name]}]));
import { registerAgentMaintenanceRoutes } from "../dist/routes/agent-maintenance.js";
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
    projectId: owner.projectId,
    idempotencyKey: "plan-a",
    requestHash: "request-a",
    scopeHash: "scope-a",
    approvalRequired: false,
    status: "planned",
    operationProgress: [],
    refs: {},
    changedAgentIds: [],
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
    store: { ...scopeStore,
      getAgent: (id) => id === owner.id ? owner : id === child.id ? child : undefined,
      listAgentSubtree: () => [owner, child],
      applyAuthorizedAgentReorganization: () => [child.id],
    },
    coordinationV3: {},
    workspace: {},
    engines: new Map(),
    managementPlans,
    activeRuns: new Map([[owner.id, { runId: plan.runId, messageCapability: "token-a" }]]),
    agentMessageCapabilities: admitted([["token-a", capability]]),
    deletingAgentIds: new Set(), deletingProjectIds:new Set(), deletingConversationIds:new Set(),
    managedAgentCreationRestricted:()=>false,
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
    projectId: owner.projectId,
    idempotencyKey: "plan-stop-retry",
    requestHash: "request-stop-retry",
    scopeHash: "scope-a",
    approvalRequired: false,
    status: "planned",
    operationProgress: [],
    refs: {},
    changedAgentIds: [],
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
    store: { ...scopeStore,
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
    agentMessageCapabilities: admitted([["token-a", capability]]),
    deletingAgentIds: new Set(), deletingProjectIds:new Set(), deletingConversationIds:new Set(),
    managedAgentCreationRestricted:()=>false,
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

test("restart resumes a partially applied rename then stop plan from durable progress", async () => {
  const owner = { id: "owner-restart", projectId: "project-a", conversationId: "chat-a", activeEngine: "codex" };
  const child = { id: "child-restart", projectId: "project-a", conversationId: "chat-a",
    managerAgentId: owner.id, activeEngine: "codex", title: "Before" };
  let durable = {
    id: "plan-restart", agentId: owner.id, runId: "owner-run-original", conversationId: "chat-a",
    projectId: "project-a", idempotencyKey: "restart-key", requestHash: "request-a", scopeHash: "scope-a",
    approvalRequired: false, status: "planned", operationProgress: [], refs: {}, changedAgentIds: [],
    createdAt: new Date().toISOString(), operations: [
      { kind: "rename_agent", targetAgentId: child.id, title: "After" },
      { kind: "stop_agent", targetAgentId: child.id, targetRunId: "child-run" },
    ],
  };
  let renameCalls = 0;
  let receipt;
  const runInstance = async (ownerRunId, cancellationFails) => {
    const app = Fastify();
    app.post(`/api/agents/${child.id}/cancel`, async (request, reply) => {
      if (cancellationFails) return reply.code(500).send({ error: "injected crash boundary" });
      receipt = { cancelled: true, runId: request.body.targetRunId };
      return receipt;
    });
    const store = { ...scopeStore,
      getAgent: (id) => id === owner.id ? owner : id === child.id ? child : undefined,
      listAgentSubtree: () => [owner, child],
      getAgentManagementPlan: (id) => id === durable.id ? structuredClone(durable) : undefined,
      updateAgentManagementPlan: (_id, patch) => {
        durable = { ...durable, ...structuredClone(patch) };
        return structuredClone(durable);
      },
      updateAgent: (_id, patch) => { renameCalls += 1; Object.assign(child, patch); return child; },
    };
    registerAgentManagementRoutes(app, {
      store,
      coordinationV3: {
        cancellationReceipt: () => receipt,
        agentSnapshot: () => ({ activeRun: receipt ? undefined : { id: "child-run" } }),
      },
      workspace: {}, engines: new Map(), managementPlans: new Map(),
      activeRuns: new Map([[owner.id, { runId: ownerRunId, messageCapability: `token-${ownerRunId}` }]]),
      agentMessageCapabilities: admitted([[`token-${ownerRunId}`, { agentId: owner.id, runId: ownerRunId, conversationId: "chat-a" }]]),
      deletingAgentIds: new Set(), deletingProjectIds:new Set(), deletingConversationIds:new Set(),
      managedAgentCreationRestricted:()=>false, cachedModelOptions: () => [], capabilityOwnsAuthoritativeRun: () => true,
      publicManagementOperations: (operations) => operations,
      commitAgentDeletion: async () => { throw new Error("unexpected deletion"); },
      appendWorkspace: () => {}, publishWorkspaceSince: () => {}, notifyScheduler: () => {},
    });
    const response = await app.inject({ method: "POST", url: "/api/agent-management",
      headers: { authorization: `Bearer token-${ownerRunId}` }, payload: { action: "apply", planId: durable.id } });
    await app.close();
    return response;
  };

  const partial = await runInstance("owner-run-original", true);
  assert.equal(partial.statusCode, 409);
  assert.equal(renameCalls, 1);
  assert.equal(durable.status, "applying");
  assert.deepEqual(durable.operationProgress.map((item) => item.index), [0]);

  const resumed = await runInstance("owner-run-after-restart", false);
  assert.equal(resumed.statusCode, 200);
  assert.equal(renameCalls, 1);
  assert.equal(durable.status, "completed");
  assert.deepEqual(durable.operationProgress.map((item) => item.index), [0, 1]);
});

test("management rejects malformed envelopes and operation types before traversal", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const owner = { id: "owner-validation", projectId: "project-a", conversationId: "chat-a", activeEngine: "codex" };
  let traversals = 0;
  registerAgentManagementRoutes(app, {
    store: { ...scopeStore, getAgent: () => owner, listAgentSubtree: () => { traversals += 1; return [owner]; } },
    coordinationV3: { steeringInjectionIds: () => { throw new Error("must not inspect malformed operation"); } },
    workspace: {}, engines: new Map(), managementPlans: new Map(),
    activeRuns: new Map([[owner.id, { runId: "run-a", messageCapability: "token-a" }]]),
    agentMessageCapabilities: admitted([["token-a", { agentId: owner.id, runId: "run-a", conversationId: "chat-a" }]]),
    deletingAgentIds: new Set(), deletingProjectIds:new Set(), deletingConversationIds:new Set(),
    managedAgentCreationRestricted:()=>false, cachedModelOptions: () => [], capabilityOwnsAuthoritativeRun: () => true,
    publicManagementOperations: (operations) => operations,
    commitAgentDeletion: async () => { throw new Error("unexpected deletion"); }, appendWorkspace: () => {},
    publishWorkspaceSince: () => {}, notifyScheduler: () => {},
  });
  for (const payload of [
    1,
    { action: "apply", planId: "x", extra: true },
    { action: "plan", idempotencyKey: "key", operations: [{ kind: "create_agent", ref: 1, title: "Child" }] },
    { action: "plan", idempotencyKey: "key", operations: [{ kind: "stop_agent", targetAgentId: "child", title: "unknown" }] },
  ]) {
    const response = await app.inject({ method: "POST", url: "/api/agent-management",
      headers: { authorization: "Bearer token-a" }, payload });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(traversals, 0);
});

test("managed Agent restriction gates management describe, plan, and apply", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const owner = { id: "owner-restricted", projectId: "project-a", conversationId: "chat-a",
    activeEngine: "codex", managementPermissions: {
      allowAutomaticDescendantDeletion: false, allowAutomaticDescendantReorganization: false,
    } };
  const plan = { id: "plan-restricted", agentId: owner.id, runId: "run-a", conversationId: "chat-a",
    projectId: "project-a", idempotencyKey: "key", requestHash: "hash", scopeHash: "scope",
    approvalRequired: false, status: "planned", operationProgress: [], refs: {}, changedAgentIds: [],
    createdAt: new Date().toISOString(), operations: [{kind:"create_agent",ref:"child",title:"Child"}] };
  registerAgentManagementRoutes(app, {
    store: { ...scopeStore, getAgent: () => owner, listAgentSubtree: () => [owner] },
    coordinationV3: { steeringInjectionIds: () => [] }, workspace: {}, engines: new Map(),
    managementPlans: new Map([[plan.id, plan]]),
    activeRuns: new Map([[owner.id, { runId: "run-a", messageCapability: "token-a" }]]),
    agentMessageCapabilities: admitted([["token-a", { agentId: owner.id, runId: "run-a", conversationId: "chat-a" }]]),
    deletingAgentIds: new Set(), deletingProjectIds:new Set(), deletingConversationIds:new Set(),
    cachedModelOptions: () => [], capabilityOwnsAuthoritativeRun: () => true,
    managedAgentCreationRestricted: () => true, publicManagementOperations: (operations) => operations,
    commitAgentDeletion: async () => { throw new Error("unexpected deletion"); }, appendWorkspace: () => {},
    publishWorkspaceSince: () => {}, notifyScheduler: () => {},
  });
  const headers = { authorization: "Bearer token-a" };
  const describe = await app.inject({method:"POST",url:"/api/agent-management",headers,payload:{action:"describe"}});
  assert.equal(describe.statusCode,200);
  assert.equal(describe.json().permissions.autonomous.includes("create_agent"),false);
  const planned = await app.inject({method:"POST",url:"/api/agent-management",headers,
    payload:{action:"plan",idempotencyKey:"new-key",operations:[{kind:"create_agent",ref:"new",title:"New"}]}});
  assert.equal(planned.statusCode,403);
  const applied = await app.inject({method:"POST",url:"/api/agent-management",headers,
    payload:{action:"apply",planId:plan.id}});
  assert.equal(applied.statusCode,403);
});

test("PUT Agent manager rejects non-objects and unknown fields before mutation", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let mutations = 0;
  registerAgentMaintenanceRoutes(app, {
    store: { updateAgentOrganization: () => { mutations += 1; } },
    coordinationV3: {}, engines: new Map(), triggerSources: {}, deletingAgentIds: new Set(),
    agentDeliveryLeases: new Map(), activeRuns: new Map(), workingCopies: {},
    clearAgentResumeSession: () => {}, persistentRuntimeForTermination: () => undefined,
    teardownPersistentRuntime: async () => {}, cachedModelOptions: () => [],
    commitAgentDeletion: async () => { throw new Error("unexpected deletion"); },
    notifyScheduler: () => {}, appendWorkspace: () => {},
  });
  for (const payload of [1, [], { managerAgentId: null, extra: true }, { managerAgentId: 1 }]) {
    const response = await app.inject({ method: "PUT", url: "/api/agents/child-a/manager", payload });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(mutations, 0);
});
