import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore, CoordinationV3Store } from "../dist/index.js";

const authorization = lease => ({ runId: lease.runId, agentId: lease.agentId, fencingToken: lease.fencingToken });
function acknowledge(c, lease) {
  const input = { injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken };
  c.preparePromptInjection({ ...input, prompt: "synthetic turn" });
  c.markPromptSubmitted(input); c.acknowledgePromptInjection(input);
}

for (const source of ["request", "request_update", "join"]) for (const outcome of ["open", "completed", "failed"]) {
  test(`exact ${source} / ${outcome} dependency survives progress/completion and store reopening, then settles once`, () => {
    const directory = mkdtempSync(join(tmpdir(), "dependency-finalization-"));
    let store = new AgentStore(directory);
    try {
      let c = new CoordinationV3Store(store.sqlite);
      const project = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "codex" });
      const chat = store.createConversation(project.id, { title: "Synthetic" });
      const owner = store.createAgent(project.id, { title: "Owner", engine: "codex", conversationId: chat.id });
      const child = store.createAgent(project.id, { title: "Child", engine: "codex", conversationId: chat.id });
      const coordinate = (id, recipientAgentId) => c.coordinate({ projectId: project.id, conversationId: chat.id, actorScope: "user:local-operator", idempotencyKey: id, requests: [{ requestId: id, recipientAgentId, lifetime: { kind: "indefinite" }, payload: { text: id } }] });
      coordinate("parent", owner.id);
      let initial = c.leaseNextRun({ workerId: "owner" }); acknowledge(c, initial);
      if (source === "request_update") {
        c.updateRequest({ requestId: "parent", updateId: "question", kind: "question", actor: { kind: "agent", id: owner.id }, runAuthorization: authorization(initial), payload: { text: "clarify" } });
        c.completeRun(initial.runId, initial.fencingToken);
        c.updateRequest({ requestId: "parent", updateId: "answer", kind: "answer", inReplyToUpdateId: "question", actor: { kind: "user", id: "local-operator" }, payload: { text: "answered" } });
        initial = c.leaseNextRun({ workerId: "owner", excludedAgentIds: [child.id] }); acknowledge(c, initial);
        assert.equal(initial.activations[0].kind, "coordination_answer");
      } else if (source === "join") {
        c.coordinate({ projectId: project.id, conversationId: chat.id, requesterAgentId: owner.id, actorScope: `agent:${owner.id}:run:${initial.runId}`, runAuthorization: authorization(initial), idempotencyKey: "precursor", requests: [{ requestId: "precursor", recipientAgentId: child.id, lifetime: { kind: "indefinite" }, payload: {} }], join: { id: "precursor", mode: "all", continuationRequestIds: ["parent"] } });
        const precursor = c.leaseNextRun({ workerId: "child" }); acknowledge(c, precursor);
        c.updateRequest({ requestId: "precursor", updateId: "precursor-result", kind: "completed", actor: { kind: "agent", id: child.id }, runAuthorization: authorization(precursor), payload: {} });
        c.completeRun(precursor.runId, precursor.fencingToken);
        c.completeRun(initial.runId, initial.fencingToken);
        initial = c.leaseNextRun({ workerId: "owner", excludedAgentIds: [child.id] }); acknowledge(c, initial);
        assert.equal(initial.activations[0].kind, "coordination_join_satisfied");
      }
      c.coordinate({ projectId: project.id, conversationId: chat.id, requesterAgentId: owner.id,
        actorScope: `agent:${owner.id}:run:${initial.runId}`, runAuthorization: authorization(initial),
        idempotencyKey: "child", requests: [{ requestId: "child", recipientAgentId: child.id,
          lifetime: { kind: "indefinite" }, payload: { text: "child" } }],
        join: { id: "dependency", mode: "all", continuationRequestIds: ["parent"] } });
      const childRun = c.leaseNextRun({ workerId: "child" }); acknowledge(c, childRun);
      const childResult = () => c.updateRequest({ requestId: "child", updateId: "child-result", kind: outcome === "failed" ? "failed" : "completed",
        actor: { kind: "agent", id: child.id }, runAuthorization: authorization(childRun), payload: { text: "child result" } });
      if (outcome !== "open") { childResult(); c.completeRun(childRun.runId, childRun.fencingToken); }
      c.updateRequest({ requestId: "parent", updateId: "progress", kind: "progress", actor: { kind: "agent", id: owner.id }, runAuthorization: authorization(initial), payload: { text: "still integrating" } });
      c.completeRun(initial.runId, initial.fencingToken);
      assert.equal(c.getRequest("parent").state, outcome === "open" ? "waiting_dependency" : "in_progress");
      store.close(); store = new AgentStore(directory); c = new CoordinationV3Store(store.sqlite);
      if (outcome === "open") { childResult(); c.completeRun(childRun.runId, childRun.fencingToken); }
      const continuation = c.leaseNextRun({ workerId: "owner", excludedAgentIds: [child.id] });
      assert.equal(continuation.agentId, owner.id);
      assert.equal(continuation.activations.length, 1);
      assert.equal(continuation.activations[0].kind, outcome === "failed" ? "coordination_join_impossible" : "coordination_join_satisfied");
      acknowledge(c, continuation);
      const result = { requestId: "parent", updateId: "parent-result", kind: outcome === "failed" ? "failed" : "completed", actor: { kind: "agent", id: owner.id }, runAuthorization: authorization(continuation), payload: { text: "integrated exact dependency" } };
      c.updateRequest(result); c.updateRequest(result);
      c.completeRun(continuation.runId, continuation.fencingToken);
      assert.equal(c.getRequest("parent").state, result.kind);
      assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM coordination_request_updates WHERE request_id='parent' AND kind IN ('completed','failed')").get().n, 1);
      assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id WHERE s.source_kind='join' AND s.source_id='dependency'").get().n, 1);
      assert.equal(c.leaseNextRun({ workerId: "owner", excludedAgentIds: [child.id] }), undefined);
      assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM coordination_requests WHERE id='parent'").get().n, 1);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

test("unrelated historical dependency cannot protect completion without a canonical result", () => {
  const directory = mkdtempSync(join(tmpdir(), "dependency-unrelated-"));
  const store = new AgentStore(directory);
  try {
    const c = new CoordinationV3Store(store.sqlite);
    const p = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "codex" });
    const chat = store.createConversation(p.id, { title: "Synthetic" });
    const owner = store.createAgent(p.id, { title: "Owner", engine: "codex", conversationId: chat.id });
    const child = store.createAgent(p.id, { title: "Child", engine: "codex", conversationId: chat.id });
    c.coordinate({ projectId: p.id, conversationId: chat.id, requesterAgentId: owner.id, actorScope: "user:local-operator", idempotencyKey: "unrelated", requests: [{ requestId: "unrelated", recipientAgentId: child.id, lifetime: { kind: "indefinite" }, payload: {} }], join: { id: "unrelated", mode: "all" } });
    c.coordinate({ projectId: p.id, conversationId: chat.id, actorScope: "user:local-operator", idempotencyKey: "current", requests: [{ requestId: "current", recipientAgentId: owner.id, lifetime: { kind: "indefinite" }, payload: {} }] });
    const lease = c.leaseNextRun({ workerId: "owner", excludedAgentIds: [child.id] }); acknowledge(c, lease);
    c.completeRun(lease.runId, lease.fencingToken);
    assert.equal(c.getRequest("current").state, "outcome_unknown");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("dependency wait → progress → durable rollover → completion → exact wake preserves one parent and does not replay opening work", () => {
  const directory = mkdtempSync(join(tmpdir(), "dependency-rollover-")); let store = new AgentStore(directory);
  try {
    let c = new CoordinationV3Store(store.sqlite);
    const p = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "codex" });
    const chat = store.createConversation(p.id, { title: "Synthetic" });
    const owner = store.createAgent(p.id, { title: "Owner", engine: "codex", conversationId: chat.id });
    const child = store.createAgent(p.id, { title: "Child", engine: "codex", conversationId: chat.id });
    c.coordinate({ projectId: p.id, conversationId: chat.id, actorScope: "user:local-operator", idempotencyKey: "parent", requests: [{ requestId: "parent", recipientAgentId: owner.id, lifetime: { kind: "indefinite" }, payload: { text: "opening assignment must not replay" } }] });
    const initial = c.leaseNextRun({ workerId: "owner" }); acknowledge(c, initial);
    c.coordinate({ projectId: p.id, conversationId: chat.id, requesterAgentId: owner.id, actorScope: `agent:${owner.id}:run:${initial.runId}`, runAuthorization: authorization(initial), idempotencyKey: "child", requests: [{ requestId: "child", recipientAgentId: child.id, lifetime: { kind: "indefinite" }, payload: {} }], join: { id: "dependency", mode: "all", continuationRequestIds: ["parent"] } });
    const childRun = c.leaseNextRun({ workerId: "child" }); acknowledge(c, childRun);
    c.updateRequest({ requestId: "child", updateId: "result", kind: "completed", actor: { kind: "agent", id: child.id }, runAuthorization: authorization(childRun), payload: {} }); c.completeRun(childRun.runId, childRun.fencingToken);
    c.updateRequest({ requestId: "parent", updateId: "progress", kind: "progress", actor: { kind: "agent", id: owner.id }, runAuthorization: authorization(initial), payload: {} });
    const rollover = c.requestContextRollover({ projectId: p.id, agentId: owner.id, oldProviderSessionId: "old", providerSessionGeneration: "old", detectedOccupancy: 150001, threshold: 150000, lowWaterMark: 75000, sourceRunId: initial.runId, sourceActivationIds: initial.activationIds, compactionCutoffOrdinal: 1, compactionCutoffEventId: "boundary", recentTail: [{ communicationEventId: "boundary", contentSha256: "a".repeat(64) }], scopeKey: `conversation:${chat.id}`, conversationId: chat.id }).rollover;
    store.appendEvent(owner.id, { type: "continuation_handoff", handoffId: "exact-handoff", executionId: initial.runId, text: "Integrate the existing child result; do not repeat work." });
    c.commitContextRolloverHandoff(rollover.id, "exact-handoff"); c.beginContextRolloverRetirement(rollover.id);
    c.completeRun(initial.runId, initial.fencingToken);
    assert.equal(c.getRequest("parent").state, "in_progress");
    assert.equal(c.prepareContextRolloverContinuation({ id: rollover.id }).state, "continuation_ready");
    store.close(); store = new AgentStore(directory); c = new CoordinationV3Store(store.sqlite);
    const replacement = c.leaseNextRun({ workerId: "owner", coalesceLimit: 1, excludedAgentIds: [child.id] });
    // The already-ready canonical Join wake is the isolated replacement,
    // rather than an extra handoff Run followed by a second Join Run.
    assert.equal(replacement.activations[0].kind, "coordination_join_satisfied");
    assert.equal(c.contextRolloverForContinuationRun(replacement.runId, owner.id)?.id, rollover.id);
    assert.equal(replacement.activations[0].payload.joinId, 'dependency');
    assert.equal(replacement.activationIds.includes(initial.activationIds[0]), false);
    acknowledge(c, replacement);
    assert.equal(c.getRequest("parent").state, "in_progress");
    const wake = replacement;
    const result = { requestId: "parent", updateId: "terminal", kind: "completed", actor: { kind: "agent", id: owner.id }, runAuthorization: authorization(wake), payload: {} }; c.updateRequest(result); c.updateRequest(result); c.completeRun(wake.runId, wake.fencingToken);
    assert.equal(c.getRequest("parent").state, "completed");
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM coordination_request_updates WHERE request_id='parent' AND kind='completed'").get().n, 1);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM scheduler_run_activations WHERE activation_id=?").get(initial.activationIds[0]).n, 1);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id WHERE s.source_kind='join' AND s.source_id='dependency'").get().n, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const disposition of ["cancelled_join", "expired_join", "archived_owner", "cancelled_parent", "superseded_parent", "provider_loss", "cancelled_run"]) {
  test(`${disposition} cannot gain normal-completion continuation protection or revive historical work`, () => {
    const directory = mkdtempSync(join(tmpdir(), "dependency-invalid-")); const store = new AgentStore(directory);
    try {
      const c = new CoordinationV3Store(store.sqlite);
      const p = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "codex" });
      const chat = store.createConversation(p.id, { title: "Synthetic" });
      const owner = store.createAgent(p.id, { title: "Owner", engine: "codex", conversationId: chat.id });
      const child = store.createAgent(p.id, { title: "Child", engine: "codex", conversationId: chat.id });
      c.coordinate({ projectId: p.id, conversationId: chat.id, actorScope: "user:local-operator", idempotencyKey: "parent", requests: [{ requestId: "parent", recipientAgentId: owner.id, lifetime: { kind: "indefinite" }, payload: {} }] });
      const run = c.leaseNextRun({ workerId: "owner" }); acknowledge(c, run);
      c.coordinate({ projectId: p.id, conversationId: chat.id, requesterAgentId: owner.id, actorScope: `agent:${owner.id}:run:${run.runId}`, runAuthorization: authorization(run), idempotencyKey: "dependency", requests: [{ requestId: "child", recipientAgentId: child.id, lifetime: { kind: "indefinite" }, payload: {} }], join: { id: "dependency", mode: "all", continuationRequestIds: ["parent"], ...(disposition === "expired_join" ? { deadlineAt: new Date(Date.now() + 1000).toISOString() } : {}) } });
      c.updateRequest({ requestId: "parent", updateId: "progress", kind: "progress", actor: { kind: "agent", id: owner.id }, runAuthorization: authorization(run), payload: {} });
      if (disposition === "cancelled_join") c.cancelJoin("dependency", owner.id);
      if (disposition === "archived_owner") store.updateAgent(owner.id, { archived: true });
      if (disposition.endsWith("_parent")) c.updateRequest({ requestId: "parent", updateId: disposition, kind: disposition === "cancelled_parent" ? "cancelled" : "superseded", actor: { kind: "user", id: "local-operator" }, payload: {} });
      if (disposition === "provider_loss") {
        c.failRun({ runId: run.runId, fencingToken: run.fencingToken, workerId: "owner", sameRunResumable: false, retryable: false, error: "synthetic provider authority loss" });
      } else if (disposition === "cancelled_run") {
        c.cancelAgentRun({ agentId: owner.id, expectedRunId: run.runId, idempotencyKey: "cancel-exact" });
        assert.throws(() => c.completeRun(run.runId, run.fencingToken), /fenc|stale/);
      } else {
        c.completeRun(run.runId, run.fencingToken, disposition === "expired_join" ? new Date(Date.now() + 2000).toISOString() : undefined);
      }
      const state = c.getRequest("parent").state;
      assert.equal(state, disposition === "cancelled_parent" ? "cancelled" : disposition === "superseded_parent" ? "superseded" : "outcome_unknown");
      assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM coordination_requests WHERE id='parent'").get().n, 1);
      assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM coordination_request_updates WHERE request_id='parent' AND kind='completed'").get().n, 0);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
