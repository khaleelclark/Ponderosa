import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { TEAM_DIRECTORY_LIMITS, agentCanReadRequest } from "@ponderosa/core";
import { registerAgentDirectoryRoutes } from "../dist/routes/agent-directory.js";
import { collaborationFixture } from "./fixtures/collaboration-presentation.mjs";

function acknowledge(c, lease) {
  const input = { injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken };
  c.preparePromptInjection({ ...input, prompt: "Disposable canonical work" });
  c.markPromptSubmitted(input); c.acknowledgePromptInjection(input);
  return { runId: lease.runId, agentId: lease.agentId, fencingToken: lease.fencingToken };
}

test("on-demand directory filters canonical Requests before payloads, progress, relationships and limits", async t => {
  const f = await collaborationFixture(); t.after(() => f.close());
  const c = f.coordinationV3;
  const requester = f.cedar;
  const target = f.boston;
  c.coordinate({ projectId: f.project.id, conversationId: f.chat.id, actorScope: "user:local-operator", idempotencyKey: "root",
    requests: [{ requestId: "root", recipientAgentId: requester.id, payload: { text: "Private initial instructions" }, lifetime: { kind: "indefinite" } }] });
  const owner = c.leaseNextRun({ workerId: "test" });
  const auth = acknowledge(c, owner);
  c.coordinate({ projectId: f.project.id, conversationId: f.chat.id, requesterAgentId: requester.id,
    actorScope: `agent:${requester.id}:run:${owner.runId}`, runAuthorization: auth, idempotencyKey: "private",
    requests: Array.from({ length: 5 }, (_, i) => ({ requestId: `SECRET-REQUEST-${i}`, recipientAgentId: target.id,
      payload: { text: `SECRET-ASSIGNMENT-${i} ` + "🌳".repeat(1000) }, lifetime: { kind: "indefinite" } })),
    join: { id: "SECRET-JOIN", mode: "all", continuationRequestIds: ["root"] } });
  const worker = c.leaseNextRun({ workerId: "test-worker" });
  assert.equal(worker.agentId, target.id);
  const workerAuth = acknowledge(c, worker);
  c.updateRequest({ requestId: "SECRET-REQUEST-0", updateId: "explicit-progress", kind: "progress",
    actor: { kind: "agent", id: target.id }, runAuthorization: workerAuth, payload: { text: "SECRET-PROGRESS " + "x".repeat(500) } });
  f.store.sqlite.prepare("UPDATE agents SET spawn_prompt = ? WHERE id = ?").run("SECRET-SPAWN-PROMPT", target.id);
  const access = agentId => ({ kind: "agent", agentId, projectId: f.project.id, conversationId: f.chat.id });
  const input = { projectId: f.project.id, conversationId: f.chat.id, agentId: target.id };
  const authorityBefore = f.authority();
  const restricted = c.directoryWork({ ...input, caller: access(f.juniper.id) });
  assert.deepEqual(restricted, { assignments: [], hasMoreAssignments: false, activeAssignmentDetails: "restricted" });
  assert.doesNotMatch(JSON.stringify(restricted), /SECRET|requester|progress|count/i);
  for (const caller of [access(requester.id), access(target.id), { kind: "operator" }]) {
    const work = c.directoryWork({ ...input, caller });
    assert.equal(work.assignments.length, TEAM_DIRECTORY_LIMITS.assignmentsPerAgent);
    assert.equal(work.hasMoreAssignments, true);
    assert.equal(work.activeAssignmentDetails, "available");
    for (const item of work.assignments) {
      assert(agentCanReadRequest(c.getRequest(item.requestId), caller.kind === "operator" ? target.id : caller.agentId));
      assert(Array.from(item.summary).length <= TEAM_DIRECTORY_LIMITS.textCharacters);
      assert.equal(item.requesterAgentId, requester.id);
      if (item.progress) assert(item.progress.text.length <= TEAM_DIRECTORY_LIMITS.textCharacters);
    }
  }
  const unauthorizedDirectory = f.readModels.teamDirectory(f.project.id, f.chat.id, f.juniper.id, undefined, access(f.juniper.id));
  const restrictedEntry = unauthorizedDirectory.agents.find(a => a.agentId === target.id);
  assert.doesNotMatch(JSON.stringify(unauthorizedDirectory), /SECRET-|Private initial instructions/);
  assert.match(restrictedEntry.currentActivity, /assignment details restricted/);
  assert.equal(restrictedEntry.work.hasMoreAssignments, false);
  const authorizedDirectory = f.readModels.teamDirectory(f.project.id, f.chat.id, requester.id, undefined, access(requester.id));
  assert.equal(authorizedDirectory.agents.find(a => a.agentId === target.id).work.assignments.length, 3);
  assert.doesNotMatch(JSON.stringify(authorizedDirectory), /SECRET-SPAWN-PROMPT/);
  assert.throws(() => c.directoryWork({ ...input, caller: { ...access(requester.id), projectId: "other" } }), /scope mismatch/);
  assert.throws(() => c.directoryWork({ ...input, caller: { ...access(requester.id), conversationId: "other" } }), /scope mismatch/);
  // Same canonical store, different caller: no authorized cache can leak back.
  assert.deepEqual(c.directoryWork({ ...input, caller: access(f.juniper.id) }), restricted);
  assert.equal(c.directoryWork({ ...input, agentId: f.juniper.id, caller: access(f.juniper.id) }).activeAssignmentDetails, "none");
  const dependency = c.directoryWork({ ...input, agentId: requester.id, caller: access(requester.id) });
  assert.equal(dependency.assignments[0].dependencyState, "open");
  assert.equal(dependency.assignments[0].requestState, "waiting_dependency");
  assert.deepEqual(f.authority(), authorityBefore, "directory projection cannot create delivery or provider input records");
  c.updateRequest({ requestId: "SECRET-REQUEST-0", updateId: "terminal", kind: "cancelled",
    actor: { kind: "user", id: "local-operator" }, payload: { text: "Cancelled" } });
  assert.equal(c.getRequest("SECRET-REQUEST-0").state, "cancelled");
  for (let i = 1; i < 5; i++) c.updateRequest({ requestId: `SECRET-REQUEST-${i}`, updateId: `cancel-${i}`, kind: "cancelled",
    actor: { kind: "user", id: "local-operator" }, payload: { text: "Cancelled" } });
  const terminal = c.directoryWork({ ...input, caller: access(requester.id) });
  assert(terminal.assignments.every(item => item.requestState === "cancelled" && item.deliveryState === "request_terminal"));
  assert.equal(terminal.activeAssignmentDetails, "none");
});

test("directory routes pass authenticated capability identity and focused entries stay bounded", async t => {
  const f = await collaborationFixture(); t.after(() => f.close());
  const app = Fastify(); t.after(() => app.close());
  const capability = { agentId: f.cedar.id, conversationId: f.chat.id, runId: "exact-run" };
  let calls = 0;
  registerAgentDirectoryRoutes(app, { store: f.store, agentMessageCapabilities: new Map([["valid", capability]]),
    activeRuns: new Map([[f.cedar.id, { messageCapability: "valid" }]]), capabilityOwnsAuthoritativeRun: (cap) => cap === capability,
    teamDirectory: (...args) => { calls++; assert.deepEqual(args[4], { kind: "agent", agentId: f.cedar.id, projectId: f.project.id, conversationId: f.chat.id });
      return f.readModels.teamDirectory(...args); } });
  assert.equal((await app.inject({ url: "/api/agent-directory", headers: { authorization: "Bearer invalid" } })).statusCode, 401);
  assert.equal(calls, 0);
  const response = await app.inject({ url: `/api/agent-directory/${f.boston.id}`, headers: { authorization: "Bearer valid" } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().agentId, f.boston.id);
  assert(Buffer.byteLength(response.body) <= TEAM_DIRECTORY_LIMITS.responseUtf8Bytes);
  assert.equal((await app.inject({ url: "/api/agent-directory/not-visible", headers: { authorization: "Bearer valid" } })).statusCode, 404);
});

test("directory bounds total UTF-8 output without leaking restricted omission counts", async t => {
  const f = await collaborationFixture(); t.after(() => f.close());
  for (let i = 0; i < 100; i++) {
    const agent = f.store.createAgent(f.project.id, { title: `Worker ${i} ` + "🌳".repeat(80), engine: "codex", conversationId: f.chat.id });
    f.coordinationV3.coordinate({ projectId: f.project.id, conversationId: f.chat.id, actorScope: "user:local-operator", idempotencyKey: `bounded-${i}`,
      requests: Array.from({ length: 4 }, (_, n) => ({ requestId: `bounded-${i}-${n}`, recipientAgentId: agent.id,
        payload: { text: "🌳".repeat(1000) }, lifetime: { kind: "indefinite" } })) });
  }
  const visible = f.readModels.teamDirectory(f.project.id, f.chat.id, undefined, undefined, { kind: "operator" });
  assert.equal(visible.agents.length, TEAM_DIRECTORY_LIMITS.agents);
  assert.equal(visible.totalAgents, 103);
  assert.equal(visible.hasMoreAgents, true);
  assert(Buffer.byteLength(JSON.stringify(visible)) <= TEAM_DIRECTORY_LIMITS.responseUtf8Bytes);
  assert(visible.agents.some(entry => entry.workSummaryOmitted), "large authorized output visibly signals its details bound");
  const omitted = visible.agents.find(entry => entry.workSummaryOmitted);
  const focused = f.readModels.teamDirectory(f.project.id, f.chat.id, undefined, [omitted.agentId], { kind: "operator" });
  assert.equal(focused.agents[0].work.assignments.length, 3);
  const restricted = f.readModels.teamDirectory(f.project.id, f.chat.id, f.cedar.id, undefined,
    { kind: "agent", agentId: f.cedar.id, projectId: f.project.id, conversationId: f.chat.id });
  assert(restricted.agents.every(entry => entry.work.assignments.length === 0 && entry.work.hasMoreAssignments === false));
  assert(restricted.agents.every(entry => !entry.workSummaryOmitted));
});
