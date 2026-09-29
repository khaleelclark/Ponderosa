import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore } from "../dist/index.js";

test("a deleted Agent's public results remain in their Chat across pagination and restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "deleted-agent-chat-artifacts-"));
  let store = new AgentStore(directory);
  try {
    const project = store.createProject({ label: "Project", hostPath: "/tmp/project", defaultEngine: "codex" });
    const chat = store.createConversation(project.id, { title: "Owning Chat" });
    const otherChat = store.createConversation(project.id, { title: "Other Chat" });
    const agent = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: chat.id });
    const body = Buffer.from("retained result");
    const sha256 = createHash("sha256").update(body).digest("hex");
    for (const [id, createdAt] of [["result-one", "2026-09-29T10:00:00.000Z"], ["result-two", "2026-09-29T10:01:00.000Z"]]) {
      store.recordProjectArtifact({
        id, projectId: project.id, agentId: agent.id, originAgentId: agent.id,
        kind: "generated_file", path: `${id}.txt`, summary: id, createdAt,
        size: body.length, sha256, mediaType: "text/plain",
      });
    }
    store.appendEvent(agent.id, { type: "generated_artifact", artifactId: "execution-result",
      executionId: "old-run", path: "execution-result.txt", sourcePath: "/tmp/result.txt",
      name: "Execution result", mediaType: "text/plain", size: body.length, sha256,
      visibility: "project" });
    store.recordProjectArtifact({
      id: "private-result", projectId: project.id, agentId: agent.id, originAgentId: agent.id,
      kind: "generated_file", path: "private-result.txt", summary: "Private result",
      createdAt: "2026-09-29T10:02:00.000Z", size: body.length, sha256, mediaType: "text/plain",
    }, { ownerKind: "communication", ownerId: "private-message",
      audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id } });
    const page = (conversationId, cursor) => store.getProjectArtifactPage(project.id, {
      conversationId, limit: 1, ...(cursor ? { cursor } : {}),
    });
    assert.equal(store.getProjectArtifactPage(project.id, { conversationId: chat.id, limit: 10 }).items.length, 3);
    store.deleteAgent(agent.id);
    assert.equal(store.getProjectArtifactPage(project.id, { conversationId: chat.id, limit: 10 }).items.length, 3);
    assert.equal(page(otherChat.id).items.length, 0, "historical visibility stays in the owning Chat");
    const first = page(chat.id);
    assert.equal(first.history.hasMore, true);
    const second = page(chat.id, first.history.cursor);
    const third = page(chat.id, second.history.cursor);
    assert.deepEqual(new Set([...first.items, ...second.items, ...third.items].map(item => item.id)), new Set(["result-one", "result-two", "execution-result"]));
    store.close();
    store = new AgentStore(directory);
    const restartedFirst = page(chat.id);
    const restartedSecond = page(chat.id, restartedFirst.history.cursor);
    const restartedThird = page(chat.id, restartedSecond.history.cursor);
    assert.deepEqual(new Set([...restartedFirst.items, ...restartedSecond.items, ...restartedThird.items].map(item => item.id)), new Set(["result-one", "result-two", "execution-result"]));
    assert.equal(page(otherChat.id).items.length, 0);
    assert.equal(store.getProjectArtifactPage(project.id, { limit: 10 }).items.length, 3);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
