import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { PONDEROSA_MESSAGE_TOOL, PONDEROSA_UPDATE_REQUEST_TOOL } from "@ponderosa/core";
import { canonicalDefaultReplyRoute } from "../dist/required-reply-route.js";
import { communicationV3Prompt } from "../dist/runtime-selection.js";
import { registerAgentRequestCommandRoutes } from "../dist/routes/agent-request-commands.js";

test("advertised message examples validate; immediate recipients need explicit Collaboration while next_run remains separate", async () => {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.post("/message", { schema: { body: PONDEROSA_MESSAGE_TOOL.inputSchema } }, async () => ({ ok: true }));
  try {
    for (const body of [ { text: "one canonical route" }, { intent: "direct_to_user", text: "private" }, { intent: "broadcast", text: "shared" }, { intent: "collaboration", recipientAgentIds: ["stable-a", "stable-b"], text: "group" }, { delivery: "next_run", recipientAgentIds: ["stable-a"], text: "passive" } ]) {
      const response = await app.inject({ method: "POST", url: "/message", payload: body }); assert.equal(response.statusCode, 200, response.body);
    }
    for (const body of [{ text: "wrong", recipientAgentIds: ["stable-a"] }, { intent: "broadcast", text: "wrong", recipientAgentIds: ["stable-a"] }]) assert.equal((await app.inject({ method: "POST", url: "/message", payload: body })).statusCode, 400);
  } finally { await app.close(); }
});

test("canonical Broadcast/Direct/peer routes and conflicting steering agree with durable obligations; exact injections survive reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "canonical-tool-contracts-")); let store = new AgentStore(directory);
  try {
    let c = new CoordinationV3Store(store.sqlite);
    const p = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "codex" });
    const chat = store.createConversation(p.id, { title: "Synthetic" });
    const agent = store.createAgent(p.id, { title: "Worker", engine: "codex", conversationId: chat.id });
    const peer = store.createAgent(p.id, { title: "Peer", engine: "codex", conversationId: chat.id });
    const intake = (id, intent, sender, policy = "next_run") => {
      const communication = { eventId: id, schemaVersion: 2, projectId: p.id, conversationId: chat.id, sender, intent,
        audience: intent === "broadcast" ? { kind: "organization", organizationId: p.id } : intent === "user_dm" ? { kind: "user_agent", userId: "local-operator", agentId: agent.id } : { kind: "agents", agentIds: [agent.id] }, text: id, createdAt: new Date().toISOString() };
      c.recordRuntimeCommunication({ id, projectId: p.id, sender, intent, audience: communication.audience, payload: { communication, dispatch: { conversationId: chat.id, text: id, activeRunDelivery: policy === "next_run" ? "run" : "steer", recipients: [{ agentId: agent.id, attachments: [] }] } }, activation: { agentId: agent.id, kind: sender.kind === "user" ? "human_message" : "ordinary_message", priority: 100, dispatchPolicy: policy, promptClass: "human" } });
    };
    const acknowledge = lease => { const input = { injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken }; const route = canonicalDefaultReplyRoute(c, lease.runId, agent.id); const prompt = communicationV3Prompt(route).join("\n"); c.preparePromptInjection({ ...input, prompt }); c.markPromptSubmitted(input); c.acknowledgePromptInjection(input); return prompt; };
    intake("broadcast", "broadcast", { kind: "user", userId: "local-operator" });
    const run = c.leaseNextRun({ workerId: "synthetic" });
    assert.deepEqual(canonicalDefaultReplyRoute(c, run.runId, agent.id), { intent: "broadcast" }); acknowledge(run);
    const obligationsBeforeSteering = c.requiredReplyObligationsForRun(run.runId).length;
    intake("private-steer", "user_dm", { kind: "user", userId: "local-operator" }, "steer_or_run");
    const steer = c.leaseNextSteering({ workerId: "synthetic" }); assert.equal(steer.runId, run.runId);
    assert.equal(canonicalDefaultReplyRoute(c, run.runId, agent.id), undefined);
    const prompt = acknowledge(steer); assert.match(prompt, /no authorized default reply route/);
    assert.match(prompt, /direct_to_user/); assert.match(prompt, /waiting_dependency/);
    assert.equal(c.requiredReplyObligationsForRun(run.runId).length, obligationsBeforeSteering, "convenience route does not manufacture a durable obligation");
    const stored = store.sqlite.prepare("SELECT exact_prompt, prompt_hash, source_manifest_json FROM scheduler_prompt_injections WHERE id=?").get(steer.injectionId);
    assert.equal(stored.exact_prompt, prompt); assert.equal(stored.prompt_hash, createHash("sha256").update(prompt).digest("hex"));
    assert.deepEqual(JSON.parse(stored.source_manifest_json).activationIds, steer.activationIds);
    assert.throws(() => c.preparePromptInjection({ injectionId: steer.injectionId, runId: run.runId, fencingToken: run.fencingToken, prompt: "changed instructions" }), /payload changed/);
    store.close(); store = new AgentStore(directory); c = new CoordinationV3Store(store.sqlite);
    assert.equal(store.sqlite.prepare("SELECT exact_prompt FROM scheduler_prompt_injections WHERE id=?").get(steer.injectionId).exact_prompt, prompt);
    assert.equal(canonicalDefaultReplyRoute(c, run.runId, agent.id), undefined);
    c.completeRun(run.runId, run.fencingToken);
    // Use separate Agents to avoid consuming the deliberately unresolved human reply.
    const peerRecipient = store.createAgent(p.id, { title: "Peer recipient", engine: "codex", conversationId: chat.id });
    c.coordinate({ projectId: p.id, conversationId: chat.id, requesterAgentId: peer.id, actorScope: `agent:${peer.id}`, idempotencyKey: "managed", requests: [{ requestId: "managed", recipientAgentId: peerRecipient.id, lifetime: { kind: "indefinite" }, payload: {} }] });
    const managed = c.leaseNextRun({ workerId: "managed", excludedAgentIds: [agent.id] });
    assert.equal(canonicalDefaultReplyRoute(c, managed.runId, peerRecipient.id), undefined, "a correlated Request without an inherited route uses update_request");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("invalid Request kind returns the schema's exact bounded accepted values, without accepting waiting as an alias", async () => {
  const app = Fastify();
  registerAgentRequestCommandRoutes(app, { coordinationV3: {}, agentMessageCapabilities: new Map([["synthetic", { agentId: "a" }]]), activeRuns: new Map([["a", { messageCapability: "synthetic" }]]), capabilityMatchesCleanupRun: () => true });
  try {
    const response = await app.inject({ method: "POST", url: "/api/agent-request-updates", headers: { authorization: "Bearer synthetic" }, payload: { kind: "waiting" } });
    assert.equal(response.statusCode, 400, response.body); assert.equal(response.json().code, "invalid_input");
    assert.deepEqual(response.json().acceptedKinds, PONDEROSA_UPDATE_REQUEST_TOOL.inputSchema.properties.kind.enum);
    assert.match(PONDEROSA_UPDATE_REQUEST_TOOL.description, /waiting_dependency/); assert.match(PONDEROSA_UPDATE_REQUEST_TOOL.description, /waiting is not a value/);
  } finally { await app.close(); }
});
