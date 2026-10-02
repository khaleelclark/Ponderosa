import assert from "node:assert/strict";
import test from "node:test";
import { projectAgentHealth } from "../dist/agent-health.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { createServer } from "../dist/app.js";

test("queued admission is payload-free and never displaces active, preparation, Decision, dependency, backoff or idle authority", () => {
  const now = "2026-10-02T12:00:00.000Z", agent = { id: "agent", title: "Synthetic", updatedAt: now };
  const blocker = { kind: "provider_disabled", providerId: "claude" };
  const project = changes => projectAgentHealth({ scope: { type: "project", id: "project" }, agents: [agent], now,
    activeRuns: new Map(), latestEvent: () => undefined, availability: () => "runnable", admissionBlocker: () => blocker, ...changes }).agents[0];
  const queued = project({}); assert.equal(queued.status, "blocked"); assert.equal(queued.reason, "provider_admission_blocked"); assert.deepEqual(queued.admissionBlocker, blocker);
  for (const [changes, expected] of [
    [{ activeRuns: new Map([["agent", { startedAt: now, executionId: "exact" }]]) }, "running"],
    [{ preparingRuns: new Map([["agent", { runId: "exact", status: "leased", promptInjectionState: "not_injected", leaseStartedAt: now, leaseExpiresAt: "2026-10-02T13:00:00.000Z" }]]) }, "preparing"],
    [{ pendingDecisionAt: () => now }, "needs_decision"],
    [{ availability: () => "waiting" }, "waiting"],
    [{ providerBlocked: () => ({ classification: "capacity", blockedAt: now, nextRetryAt: now, activationIds: ["exact"], deliveryFailures: 1 }) }, "blocked"],
    [{ availability: () => "idle" }, "idle"],
  ]) { const result = project(changes); assert.equal(result.status, expected); assert.equal(result.admissionBlocker, undefined); }
  for (const kind of ["authentication_unknown", "authentication_required", "provider_unavailable"]) assert.equal(project({ admissionBlocker: () => ({ kind, providerId: "codex" }) }).admissionBlocker.kind, kind);
  assert.equal(project({ admissionBlocker: () => undefined }).reason, "queued_delivery", "preference recovery removes retained blocker");
});

test("real Health and Team Directory preserve disabled queued blockers through complete app recreation and preference/cancellation changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "queued-blocker-restart-")); let store = new AgentStore(directory), app;
  const adapter = { id: "claude", displayName: "Synthetic", listModels: () => [], listEfforts: () => [] };
  const open = async () => { app = createServer({ dataDir: directory, store, engines: [{ adapter, authStatus: async () => ({ authenticated: true }) }], logger: false, startDrained: true }); await app.ready(); };
  const close = async () => { app.prepareForShutdown(); await app.close(); store.close(); };
  try {
    const p = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "claude" });
    const chat = store.createConversation(p.id, { title: "Synthetic" });
    const agent = store.createAgent(p.id, { title: "Queued", engine: "claude", conversationId: chat.id });
    const c = new CoordinationV3Store(store.sqlite);
    c.coordinate({ projectId: p.id, conversationId: chat.id, actorScope: "user:local-operator", idempotencyKey: "exact", requests: [{ requestId: "exact", recipientAgentId: agent.id, lifetime: { kind: "indefinite" }, payload: { text: "must not enter blocker DTO" } }] });
    await open();
    const check = async expected => { for (const url of [`/api/conversations/${chat.id}/agent-health`, `/api/projects/${p.id}/team-directory`]) { const response = await app.inject(url); assert.equal(response.statusCode, 200, response.body); const row = response.json().agents.find(row => row.agentId === agent.id); assert.equal(row.admissionBlocker?.kind, expected, response.body); assert.equal(JSON.stringify(row.admissionBlocker ?? {}).includes("must not"), false); } };
    await app.inject({ method: "PATCH", url: "/api/workspace/preferences", payload: { providerAvailability: { claude: false } } }); await check("provider_disabled");
    await close(); store = new AgentStore(directory); await open(); await check("provider_disabled");
    await app.inject({ method: "PATCH", url: "/api/workspace/preferences", payload: { providerAvailability: { claude: true } } });
    await app.inject("/api/engines"); await check(undefined);
    const reopened = new CoordinationV3Store(store.sqlite);
    reopened.updateRequest({ requestId: "exact", updateId: "cancel", kind: "cancelled", actor: { kind: "user", id: "local-operator" }, payload: {} });
    const cancellation = reopened.leaseNextRun({ workerId: "synthetic" });
    if (cancellation) { const injection = { injectionId: cancellation.injectionId, runId: cancellation.runId, fencingToken: cancellation.fencingToken }; reopened.preparePromptInjection({ ...injection, prompt: "Observe the exact cancelled assignment; do not execute it." }); reopened.markPromptSubmitted(injection); reopened.acknowledgePromptInjection(injection); reopened.completeRun(cancellation.runId, cancellation.fencingToken); }
    assert.equal(reopened.getRequest("exact").state, "cancelled");
    await app.inject({ method: "PATCH", url: "/api/workspace/preferences", payload: { providerAvailability: { claude: false } } }); await check(undefined);
  } finally { if (app) await close(); await rm(directory, { recursive: true, force: true }); }
});
