import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentStore } from "../dist/index.js";

const identity = (key, payload) => ({
  idempotencyKey: key,
  payloadHash: createHash("sha256").update(payload).digest("hex"),
});

test("Project creation commits presets atomically and exact retries replay across restart", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-project-create-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const attempt = identity("project-create-stable", "project-a");
  let store = new AgentStore(dataDir);
  const unrelated = store.createProject({
    label: "Unrelated",
    hostPath: "/tmp/unrelated",
    defaultEngine: "codex",
  });
  store.sqlite.exec(`
    CREATE TRIGGER fail_builtin_preset BEFORE INSERT ON agent_presets
    BEGIN SELECT RAISE(FAIL, 'injected preset failure'); END
  `);
  assert.throws(() => store.createProject({
    label: "Project A",
    hostPath: "/tmp/project-a",
    defaultEngine: "codex",
  }, attempt), /injected preset failure/u);
  assert.deepEqual(store.listProjects().map((project) => project.id), [unrelated.id]);
  store.sqlite.exec("DROP TRIGGER fail_builtin_preset");
  const created = store.createProject({
    label: "Project A",
    hostPath: "/tmp/project-a",
    defaultEngine: "codex",
  }, attempt);
  assert.equal(store.listAgentPresets(created.id).length, 4);
  assert.equal(store.createProject({
    label: "Project A",
    hostPath: "/tmp/project-a",
    defaultEngine: "codex",
  }, attempt).id, created.id);
  assert.throws(() => store.createProject({
    label: "Changed",
    hostPath: "/tmp/project-a",
    defaultEngine: "codex",
  }, identity(attempt.idempotencyKey, "changed")), /reused with different input/u);
  assert.equal(store.getProject(unrelated.id)?.label, "Unrelated");

  store.close();
  const canonical = path.join(dataDir, "projects", created.id);
  const staged = path.join(dataDir, "projects", `.${created.id}.creating`);
  await rename(canonical, staged);
  store = new AgentStore(dataDir);
  assert.equal(existsSync(canonical), true);
  assert.equal(existsSync(staged), false);
  assert.equal(store.createProject({
    label: "Project A",
    hostPath: "/tmp/project-a",
    defaultEngine: "codex",
  }, attempt).id, created.id);
  assert.equal(store.listAgentPresets(created.id).length, 4);
  store.close();
});

test("Chat creation rolls back ordinary projection failures and replays lost responses", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-chat-create-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let store = new AgentStore(dataDir);
  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  const attempt = identity("chat-create-stable", "chat-a");
  const projectRecordPath = path.join(dataDir, "projects", project.id, "project.json");
  const projectBeforeChat = await readFile(projectRecordPath, "utf8");
  store.sqlite.exec(`
    CREATE TRIGGER fail_chat_recency BEFORE UPDATE OF last_used_at ON projects
    BEGIN SELECT RAISE(FAIL, 'injected recency failure'); END
  `);
  assert.throws(() => store.createConversation(project.id, {
    title: "Chat A",
    defaultEngine: "codex",
  }, attempt), /injected recency failure/u);
  assert.equal(store.listConversations(project.id).some((chat) => chat.title === "Chat A"), false);
  store.sqlite.exec("DROP TRIGGER fail_chat_recency");

  const created = store.createConversation(project.id, {
    title: "Chat A",
    defaultEngine: "codex",
  }, attempt);
  assert.deepEqual(store.createConversation(project.id, {
    title: "Chat A",
    defaultEngine: "codex",
  }, attempt), created);
  assert.throws(() => store.createConversation(project.id, {
    title: "Changed",
    defaultEngine: "codex",
  }, identity(attempt.idempotencyKey, "changed")), /reused with different input/u);

  store.sqlite.prepare("DELETE FROM conversations WHERE id = ?").run(created.id);
  await writeFile(projectRecordPath, projectBeforeChat);
  store.close();
  const canonical = path.join(dataDir, "projects", project.id, "conversations", created.id);
  const staged = path.join(dataDir, "projects", project.id, "conversations", `.${created.id}.creating`);
  await rename(canonical, staged);
  store = new AgentStore(dataDir);
  assert.equal(existsSync(canonical), true);
  assert.equal(existsSync(staged), false);
  assert.deepEqual(store.createConversation(project.id, {
    title: "Chat A",
    defaultEngine: "codex",
  }, attempt), created);
  assert.equal(store.getProject(project.id)?.lastConversationId, created.id);
  store.close();
});
