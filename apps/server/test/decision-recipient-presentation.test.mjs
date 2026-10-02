import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import { createServer } from "../dist/app.js";
import { withDecisionRecipient } from "../dist/decision-presentation.js";

test("recipient projection uses the exact Decision ID binding without modifying canonical records", () => {
  const event = { kind: "decision_response", id: "response", createdAt: "now",
    decision: { agentId: "right", projectId: "p", response: { text: "#Wrong do it" } } };
  const original = structuredClone(event);
  const lookups = [];
  const projected = withDecisionRecipient({ getAgent: id => { lookups.push(id); return { id, projectId: "p", title: "Renamed Boston", handle: "Boston-renamed" }; } }, event);
  assert.deepEqual(lookups, ["right"]);
  assert.deepEqual(projected.recipientAgent, { id: "right", title: "Renamed Boston", handle: "Boston-renamed" });
  assert.deepEqual(event, original);
  assert.equal(withDecisionRecipient({ getAgent: () => undefined }, event).recipientAgent, null);
  assert.equal(withDecisionRecipient({ getAgent: () => ({ id: "right", projectId: "other" }) }, event).recipientAgent, null);
  assert.equal(withDecisionRecipient({ getAgent: () => ({ id: "wrong", projectId: "p" }) }, event).recipientAgent, null);
});

test("real routes preserve one answer and targeted delivery; bounded history, rename, deletion and replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "ponderosa-decision-recipient-"));
  const store = new AgentStore(root);
  const workspace = new WorkspaceStore(root);
  const project = store.createProject({ label: "Disposable", hostPath: root, defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Chat" });
  const agent = store.createAgent(project.id, { title: "Boston", engine: "codex", conversationId: chat.id });
  const other = store.createAgent(project.id, { title: "Other", engine: "codex", conversationId: chat.id });
  const deleted = store.createAgent(project.id, { title: "Former", engine: "codex", conversationId: chat.id });
  const make = (key, agentId = agent.id, mode = "text") => workspace.createDecision({ projectId: project.id,
    conversationId: chat.id, agentId, question: `Question ${key}`, mode, options: mode === "text" ? [] : [{ id: "yes", label: "Continue" }],
    allowOther: true, idempotencyKey: key });
  const pending = make("target");
  const former = make("deleted", deleted.id);
  workspace.resolveDecision(former.id, { text: "An older answer", respondedAt: new Date().toISOString() });
  store.deleteAgent(deleted.id);
  const older = Array.from({ length: 9 }, (_, i) => {
    const decision = make(`older-${i}`, agent.id, i % 2 ? "choice" : "approval");
    workspace.resolveDecision(decision.id, { optionId: "yes", respondedAt: new Date().toISOString() });
    return decision;
  });
  const unrelated = make("private", other.id);
  workspace.resolveDecision(unrelated.id, { text: "Other's answer", respondedAt: new Date().toISOString() });
  let app;
  try {
    app = createServer({ dataDir: root, store, engines: [], logger: false, startDrained: true });
    await app.ready();
    const get = async url => { const response = await app.inject(url); assert.equal(response.statusCode, 200, response.body); return response.json(); };
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ method: "POST", url: `/api/decisions/${pending.id}/respond`, payload: { text: "Do it yourself #Other" } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().response.text, "Do it yourself #Other");
    }
    const activations = store.sqlite.prepare("SELECT agent_id, scope_key, payload_json FROM agent_activations").all();
    assert.equal(activations.length, 1);
    assert.equal(activations[0].agent_id, agent.id);
    assert.equal(activations[0].scope_key, `conversation:${chat.id}`);
    assert.equal(JSON.parse(activations[0].payload_json).decision.response.text, "Do it yourself #Other");
    let cursor, events = [], iterations = 0;
    do {
      const page = await get(`/api/agents/${agent.id}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      assert(page.decisionEvents.length <= 2);
      assert(page.decisionEvents.every(event => event.decision.agentId === agent.id));
      events.push(...page.decisionEvents);
      cursor = page.history.cursor;
      assert(++iterations < 30, "history terminates");
    } while (cursor);
    assert.equal(new Set(events.map(event => event.id)).size, events.length);
    assert.equal(events.filter(event => event.kind === "decision_response").length, older.length + 1);
    assert.equal(events.filter(event => event.decision.id === pending.id && event.kind === "decision_response").length, 1);
    const first = await get(`/api/agents/${agent.id}?limit=2`);
    const wrongScope = await app.inject(`/api/agents/${other.id}?cursor=${encodeURIComponent(first.history.cursor)}`);
    assert.equal(wrongScope.statusCode, 400, wrongScope.body);
    const renamed = store.updateAgent(agent.id, { title: "Boston renamed" });
    const chatPage = await get(`/api/conversations/${chat.id}`);
    assert.equal(chatPage.decisionEvents.find(event => event.decision.id === pending.id).recipientAgent.handle, renamed.handle);
    assert.equal(chatPage.decisionEvents.find(event => event.decision.id === former.id).recipientAgent, null);
    const all = await get("/api/all-chat");
    assert.equal(all.decisions.find(event => event.decision.id === pending.id).recipientAgent.id, agent.id);
    assert.equal(all.items.length, 0, "answers are not fabricated Communications");
    assert.equal(chatPage.messages.length, 0);
    const replay = new WorkspaceStore(root).listDecisionEventPage({ projectId: project.id, agentId: agent.id, limit: 100 });
    assert.equal(replay.events.filter(event => event.kind === "decision_response").length, older.length + 1);
  } finally { await app?.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
