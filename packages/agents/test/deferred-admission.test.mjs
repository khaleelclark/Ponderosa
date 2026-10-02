import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore, CoordinationV3Store } from "../dist/index.js";

test("admission deferral fences only an uninjected claim and preserves exact queued assignment and budgets", () => {
  const directory = mkdtempSync(join(tmpdir(), "deferred-admission-")); let store = new AgentStore(directory);
  try {
    let c = new CoordinationV3Store(store.sqlite);
    const p = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "codex" });
    const chat = store.createConversation(p.id, { title: "Synthetic" });
    const a = store.createAgent(p.id, { title: "Synthetic", engine: "codex", conversationId: chat.id });
    c.coordinate({ projectId: p.id, conversationId: chat.id, actorScope: "user:local-operator", idempotencyKey: "original", requests: [{ requestId: "original", recipientAgentId: a.id, lifetime: { kind: "indefinite" }, payload: { text: "exact" } }] });
    const first = c.leaseNextRun({ workerId: "synthetic" });
    const requestBefore = c.getRequest("original");
    c.preparePromptInjection({ injectionId: first.injectionId, runId: first.runId, fencingToken: first.fencingToken, prompt: "prepared but not submitted" });
    c.deferUninjectedRun(first.runId, first.fencingToken);
    assert.deepEqual(c.getRequest("original"), requestBefore);
    assert.equal(store.sqlite.prepare("SELECT delivery_failures FROM agent_activations WHERE id=?").get(first.activationIds[0]).delivery_failures, 0);
    assert.throws(() => c.markPromptSubmitted({ injectionId: first.injectionId, runId: first.runId, fencingToken: first.fencingToken }), /fenc|stale/i);
    store.close(); store = new AgentStore(directory); c = new CoordinationV3Store(store.sqlite);
    const next = c.leaseNextRun({ workerId: "synthetic" }); assert.notEqual(next.runId, first.runId); assert.deepEqual(next.activationIds, first.activationIds);
    c.preparePromptInjection({ injectionId: next.injectionId, runId: next.runId, fencingToken: next.fencingToken, prompt: "exact" });
    c.markPromptSubmitted({ injectionId: next.injectionId, runId: next.runId, fencingToken: next.fencingToken });
    assert.throws(() => c.deferUninjectedRun(next.runId, next.fencingToken), /uninjected/);
    c.cancelAgentRun({ agentId: a.id, expectedRunId: next.runId, idempotencyKey: "cancel-original" });
    assert.throws(() => c.deferUninjectedRun(next.runId, next.fencingToken), /fenc|stale/i);
    assert.equal(c.leaseNextRun({ workerId: "synthetic" }), undefined, "re-enable cannot revive cancelled work");
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM coordination_requests").get().n, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
