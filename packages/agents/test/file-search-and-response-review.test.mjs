import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore } from "../dist/index.js";

test("Chat catalog search finds older results before pagination and fences the query/Chat cursor", t => {
  const root = mkdtempSync(join(tmpdir(), "ponderosa-catalog-search-"));
  const store = new AgentStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = store.createProject({ label: "Project", hostPath: root, defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Owning Chat" });
  const other = store.createConversation(project.id, { title: "Other Chat" });
  const agent = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: chat.id });
  const body = Buffer.from("result");
  for (let index = 0; index < 110; index++) store.recordProjectArtifact({
    id: `result-${index}`, projectId: project.id, agentId: agent.id, originAgentId: agent.id,
    kind: "generated_file", path: index < 3 ? `marketing/${index}/README.md` : `new/${index}.txt`,
    summary: "result", createdAt: new Date(1_000_000 + index * 1000).toISOString(),
    size: body.length, sha256: createHash("sha256").update(body).digest("hex"), mediaType: "text/plain",
  });
  const first = store.getProjectArtifactPage(project.id, { conversationId: chat.id, search: "marketing", limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.history.hasMore, true);
  assert.match(first.items[0].path, /marketing/);
  const next = store.getProjectArtifactPage(project.id, { conversationId: chat.id, search: "marketing", limit: 1, cursor: first.history.cursor });
  assert.notEqual(next.items[0].id, first.items[0].id);
  assert.throws(() => store.getProjectArtifactPage(project.id, { conversationId: chat.id, search: "new", limit: 1, cursor: first.history.cursor }), /cursor/i);
  assert.equal(store.getProjectArtifactPage(project.id, { conversationId: other.id, search: "marketing", limit: 10 }).items.length, 0);
  assert.equal(store.getProjectArtifactPage(project.id, { conversationId: chat.id, search: "%", limit: 10 }).items.length, 0, "SQL wildcard input is literal");
});

test("response review isolates exact execution changes from accumulated Agent history", t => {
  const root = mkdtempSync(join(tmpdir(), "ponderosa-response-review-"));
  const store = new AgentStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = store.createProject({ label: "Project", hostPath: root, defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Chat" });
  const agent = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: chat.id });
  store.appendEvent(agent.id, { type: "file_change", executionId: "old-run", kind: "edit", path: "old.txt", diff: "-old\n+older" });
  store.appendEvent(agent.id, { type: "file_change", executionId: "selected-run", kind: "edit", path: "current.txt", diff: "-one\n+two" });
  store.appendEvent(agent.id, { type: "file_change", executionId: "selected-run", kind: "edit", path: "current.txt", diff: "-two\n+three" });
  const review = store.getResponseFileReview(agent.id, "selected-run");
  assert.deepEqual(review.files.map(file => file.path), ["current.txt"]);
  assert.equal(review.files[0].diff, "-two\n+three");
  assert.deepEqual(review.files[0].executionIds, ["selected-run"]);
  assert.equal(review.truncated, false);
  assert.deepEqual(store.getResponseFileReview("another-agent", "selected-run").files, []);
});

test("Chat usage follows the canonical communication room after Agent membership changes", t => {
  const root = mkdtempSync(join(tmpdir(), "ponderosa-chat-usage-"));
  const store = new AgentStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = store.createProject({ label: "Project", hostPath: root, defaultEngine: "codex" });
  const original = store.createConversation(project.id, { title: "Original" });
  const current = store.createConversation(project.id, { title: "Current" });
  const agent = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: original.id });
  for (const [eventId, chat, tokens] of [["original-message", original, 10], ["current-message", current, 20]]) {
    store.appendCommunicationEvent({ eventId, schemaVersion: 2, projectId: project.id, conversationId: chat.id,
      sender: { kind: "user", userId: "operator" }, intent: "broadcast", audience: { kind: "organization", organizationId: project.id }, text: "Work", createdAt: "2026-09-29T12:00:00Z" });
    store.sqlite.prepare(`INSERT INTO runs (id, agent_id, title, status, reason, engine, communication_event_id, total_tokens, started_at, updated_at, completed_at)
      VALUES (?, ?, 'Work', 'completed', 'completed', 'codex', ?, ?, '2026-09-29T12:00:00Z', '2026-09-29T12:00:01Z', '2026-09-29T12:00:01Z')`).run(eventId, agent.id, eventId, tokens);
  }
  store.sqlite.prepare("UPDATE agents SET conversation_id = ? WHERE id = ?").run(current.id, agent.id);
  assert.equal(store.getTokenUsage({ type: "conversation", id: original.id }).totalTokens, 10);
  assert.equal(store.getTokenUsage({ type: "conversation", id: current.id }).totalTokens, 20);
  assert.equal(store.getTokenUsage({ type: "project", id: project.id }).totalTokens, 30);
  assert.equal(store.getTokenUsage({ type: "conversation", id: "missing" }).finalizedRuns, 0);
});
