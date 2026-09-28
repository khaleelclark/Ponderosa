import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { compileActivationPrompt } from "../dist/coordination-v3-scheduler.js";

test("eight oversized terminal Joins reach one manager continuation and settle its parent Request", () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-eight-joins-"));
  const store = new AgentStore(directory);
  try {
    const coordination = new CoordinationV3Store(store.sqlite);
    const project = store.createProject({ label: "Join qualification", hostPath: "/tmp/join-qualification", defaultEngine: "codex" });
    const conversation = store.createConversation(project.id, { title: "Join handoff" });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: conversation.id });
    const worker = store.createAgent(project.id, { title: "Worker", engine: "codex", conversationId: conversation.id });
    coordination.coordinate({
      projectId: project.id, conversationId: conversation.id, actorScope: "user:local-operator",
      idempotencyKey: "parent", requests: [{ requestId: "parent-request", recipientAgentId: manager.id,
        lifetime: { kind: "indefinite" }, payload: { text: "Integrate all eight results" } }],
    });
    const initial = coordination.leaseNextRun({ workerId: "manager-worker" });
    assert.ok(initial && initial.agentId === manager.id);
    const initialAuthorization = { runId: initial.runId, agentId: manager.id, fencingToken: initial.fencingToken };
    for (let index = 0; index < 8; index++) {
      coordination.coordinate({
        projectId: project.id, conversationId: conversation.id,
        requesterAgentId: manager.id, actorScope: `agent:${manager.id}:run:${initial.runId}`,
        runAuthorization: initialAuthorization, idempotencyKey: `join-${index}`,
        requests: [{ requestId: `child-${index}`, recipientAgentId: worker.id,
          lifetime: { kind: "indefinite" }, payload: { text: `Return result ${index}` } }],
        join: { id: `join-${index}`, mode: "all", continuationRequestIds: ["parent-request"] },
      });
    }
    assert.equal(coordination.requestLifecycleDetails({ projectId: project.id, conversationId: conversation.id,
      recordId: "parent-request" }).request.state, "waiting_dependency");
    coordination.preparePromptInjection({ injectionId: initial.injectionId, runId: initial.runId,
      fencingToken: initial.fencingToken, prompt: "Delegate eight requests" });
    coordination.markPromptSubmitted({ injectionId: initial.injectionId, runId: initial.runId,
      fencingToken: initial.fencingToken });
    coordination.acknowledgePromptInjection({ injectionId: initial.injectionId, runId: initial.runId,
      fencingToken: initial.fencingToken });
    coordination.completeRun(initial.runId, initial.fencingToken);

    const child = coordination.leaseNextRun({ workerId: "child-worker", coalesceLimit: 8 });
    assert.ok(child && child.agentId === worker.id);
    assert.equal(child.activations.length, 8);
    for (let index = 0; index < 8; index++) {
      coordination.updateRequest({ requestId: `child-${index}`, updateId: `result-${index}`,
        kind: "completed", actor: { kind: "agent", id: worker.id },
        runAuthorization: { runId: child.runId, agentId: worker.id, fencingToken: child.fencingToken },
        payload: { text: `${index}:${"R".repeat(7_800)}` },
      });
    }
    const continuation = coordination.leaseNextRun({ workerId: "manager-worker", coalesceLimit: 8,
      excludedAgentIds: [worker.id] });
    assert.ok(continuation && continuation.agentId === manager.id);
    assert.equal(continuation.activations.length, 8);
    assert.ok(continuation.activations.every(activation => activation.kind === "coordination_join_satisfied"));
    const compiled = compileActivationPrompt(continuation, { maxUtf8Bytes: 256 * 1024 });
    assert.ok(Buffer.byteLength(compiled.prompt, "utf8") > 65_536);
    assert.ok(Buffer.byteLength(compiled.prompt, "utf8") <= 256 * 1024);
    for (let index = 0; index < 8; index++) assert.match(compiled.prompt, new RegExp(`join-${index}`));
    coordination.updateRequest({ requestId: "parent-request", updateId: "manager-integrated-eight",
      kind: "completed", actor: { kind: "agent", id: manager.id },
      runAuthorization: { runId: continuation.runId, agentId: manager.id, fencingToken: continuation.fencingToken },
      payload: { text: "Integrated all eight child results." },
    });
    assert.equal(coordination.requestLifecycleDetails({ projectId: project.id, conversationId: conversation.id,
      recordId: "parent-request" }).request.state, "completed");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
