import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { createServer } from "../dist/app.js";

test("real Chat, Agent Chat and All Messages routes share scoped progress without adding Communication", async () => {
  const root = mkdtempSync(join(tmpdir(), "progress-routes-"));
  const store = new AgentStore(root);
  const project = store.createProject({ label: "Fixture", hostPath: root, defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Chat" });
  const agent = store.createAgent(project.id, { title: "Boston", engine: "codex", conversationId: chat.id });
  const app = createServer({ dataDir: root, store, engines: [], logger: false, startDrained: true });
  const coordination = new CoordinationV3Store(store.sqlite);
  const now = () => new Date().toISOString();
  try {
    await app.ready();
    const sent = await app.inject({ method: "POST", url: `/api/conversations/${chat.id}/direct-messages`,
      payload: { text: "Use the revised plan", idempotencyKey: "once", recipients: [{ agentId: agent.id }] } });
    assert.equal(sent.statusCode, 200, sent.body);
    const eventId = sent.json().message.communicationEventId;
    const initialCommunications = store.readCommunicationEvents(project.id).length;
    const lease = coordination.leaseNextRun({ workerId: "disposable", now: now() }); assert.ok(lease);
    coordination.markRunStarted(lease.runId, lease.fencingToken, now());
    coordination.recordProviderInput({ executionId: "execution", schedulerRunId: lease.runId, fencingToken: lease.fencingToken,
      agentId: agent.id, projectId: project.id, prompt: "work", sourceManifest: { schemaVersion: 1, historyMessageCount: 0,
        activationIds: lease.activationIds, communicationEventIds: [eventId], artifactIds: [], conversationId: chat.id,
        providerSessionDisposition: "fresh_task", sources: [] }, now: now() });
    coordination.preparePromptInjection({ injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken, prompt: "work", now: now() });
    coordination.markPromptSubmitted({ injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken, now: now() });
    coordination.acknowledgePromptInjection({ injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken, now: now() });
    store.appendEvent(agent.id, { type: "text", delta: "Latest public update", presentation: "progress",
      executionId: "execution", progressInjectionId: lease.injectionId }, now());
    store.appendEvent(agent.id, { type: "reasoning", delta: "PRIVATE REASONING", executionId: "execution" }, now());
    const reads = [
      [`/api/conversations/${chat.id}`, body => body.messages],
      [`/api/agents/${agent.id}`, body => body.messages],
      ["/api/all-chat", body => body.items],
    ];
    for (const [url, items] of reads) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 200, response.body);
      const messages = items(response.json());
      const original = messages.find(m => m.communicationEventId === eventId);
      assert.equal(original.deliveryReceipts[0].liveProgress.text, "Latest public update", url);
      assert.equal(original.text, "Use the revised plan");
      assert.equal(messages.length, 1, "no added authored message");
      assert.doesNotMatch(JSON.stringify(messages), /PRIVATE REASONING/);
    }
    assert.equal(store.readCommunicationEvents(project.id).length, initialCommunications);
    // A second Agent's explicit private progress must not appear in these receipts.
    const child = store.createAgent(project.id, { title: "Private helper", engine: "codex", conversationId: chat.id, managerAgentId: agent.id });
    store.appendEvent(child.id, { type: "text", delta: "PRIVATE CHILD", presentation: "progress",
      executionId: "execution", progressInjectionId: lease.injectionId }, now());
    assert.doesNotMatch((await app.inject("/api/all-chat")).body, /PRIVATE CHILD/);
  } finally { await app.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
