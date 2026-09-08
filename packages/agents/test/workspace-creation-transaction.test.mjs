import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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

test("Agent preset creation replays one canonical identity after projection failure", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-preset-create-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let store = new AgentStore(dataDir);
  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  const attempt = identity("preset-create-stable", "preset-a");
  const input = {
    name: "Custom QA",
    description: "Checks",
    guidance: "Verify the exact behavior carefully.",
    engine: "codex",
  };
  store.sqlite.exec(`
    CREATE TRIGGER fail_custom_preset BEFORE INSERT ON agent_presets
    WHEN NEW.name = 'Custom QA'
    BEGIN SELECT RAISE(FAIL, 'injected preset projection failure'); END
  `);
  assert.throws(
    () => store.createAgentPreset(project.id, input, attempt),
    /injected preset projection failure/u,
  );
  assert.throws(
    () => store.createAgentPreset(project.id, input, attempt),
    /injected preset projection failure/u,
  );
  store.sqlite.exec("DROP TRIGGER fail_custom_preset");
  const recovered = store.createAgentPreset(project.id, input, attempt);
  assert.equal(store.createAgentPreset(project.id, input, attempt).id, recovered.id);
  const presetEvents = (await readFile(
    path.join(dataDir, "projects", project.id, "agent-presets.jsonl"), "utf8",
  )).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(presetEvents.filter((event) => event.preset?.id === recovered.id).length, 1);
  assert.throws(
    () => store.createAgentPreset(project.id, { ...input, name: "Changed" }, identity(attempt.idempotencyKey, "changed")),
    /reused with different input/u,
  );
  assert.equal(store.listAgentPresets(project.id).filter((preset) => preset.name === input.name).length, 1);
  store.close();

  store = new AgentStore(dataDir);
  assert.equal(store.createAgentPreset(project.id, input, attempt).id, recovered.id);
  assert.equal(store.listAgentPresets(project.id).filter((preset) => preset.name === input.name).length, 1);
  assert.equal(store.deleteAgentPreset(recovered.id), true);
  assert.throws(
    () => store.createAgentPreset(project.id, input, attempt),
    /already deleted/u,
  );
  store.close();
});

test("startup repairs an organization torn tail and isolates a corrupt Project journal", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-project-journal-recovery-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let store = new AgentStore(dataDir);
  const affected = store.createProject({ label: "Affected", hostPath: "/tmp/a", defaultEngine: "codex" });
  const healthy = store.createProject({ label: "Healthy", hostPath: "/tmp/b", defaultEngine: "codex" });
  const chat = store.getConversation(affected.lastConversationId);
  const manager = store.createAgent(affected.id, { title: "Manager", engine: "codex", conversationId: chat.id });
  store.createAgent(affected.id, {
    title: "Child", engine: "codex", conversationId: chat.id, managerAgentId: manager.id,
  });
  store.close();

  const organizationFile = path.join(dataDir, "projects", affected.id, "agent-organization.jsonl");
  const organizationBytes = await readFile(organizationFile);
  await writeFile(organizationFile, organizationBytes.subarray(0, organizationBytes.length - 5));
  store = new AgentStore(dataDir);
  assert.deepEqual(store.listProjects().map((project) => project.label).sort(), ["Affected", "Healthy"]);
  assert.equal((await readFile(organizationFile)).length, 0);
  store.close();

  const presetFile = path.join(dataDir, "projects", affected.id, "agent-presets.jsonl");
  const presetBytes = await readFile(presetFile, "utf8");
  const presetLines = presetBytes.trimEnd().split("\n");
  presetLines.splice(1, 0, "{broken-middle");
  const corrupted = `${presetLines.join("\n")}\n`;
  await writeFile(presetFile, corrupted);
  store = new AgentStore(dataDir);
  assert.deepEqual(store.listProjects().map((project) => project.label), ["Healthy"]);
  assert.deepEqual(store.startupProfile().recoveryIssues, [{
    projectId: affected.id,
    detail: "agent preset journal contains non-tail corruption",
  }]);
  assert.equal(await readFile(presetFile, "utf8"), corrupted);
  store.close();

  store = new AgentStore(dataDir);
  assert.deepEqual(store.listProjects().map((project) => project.label), ["Healthy"]);
  assert.equal(await readFile(presetFile, "utf8"), corrupted);
  store.close();
});

test("startup preserves and isolates non-tail organization corruption", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-organization-quarantine-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let store = new AgentStore(dataDir);
  const affected = store.createProject({ label: "Affected", hostPath: "/tmp/a", defaultEngine: "codex" });
  const healthy = store.createProject({ label: "Healthy", hostPath: "/tmp/b", defaultEngine: "codex" });
  const chat = store.getConversation(affected.lastConversationId);
  const manager = store.createAgent(affected.id, { title: "Manager", engine: "codex", conversationId: chat.id });
  store.createAgent(affected.id, {
    title: "Child", engine: "codex", conversationId: chat.id, managerAgentId: manager.id,
  });
  store.close();

  const organizationFile = path.join(dataDir, "projects", affected.id, "agent-organization.jsonl");
  const corrupted = `${await readFile(organizationFile, "utf8")}{broken\n`;
  await writeFile(organizationFile, corrupted);
  store = new AgentStore(dataDir);
  assert.deepEqual(store.listProjects().map((project) => project.id), [healthy.id]);
  assert.deepEqual(store.startupProfile().recoveryIssues, [{
    projectId: affected.id,
    detail: "agent organization log contains non-tail corruption",
  }]);
  assert.equal(await readFile(organizationFile, "utf8"), corrupted);
  store.close();
});

test("startup quarantines relationally invalid Project records without mutating siblings", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-project-owner-quarantine-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let store = new AgentStore(dataDir);
  const affected = store.createProject({ label: "Affected", hostPath: "/tmp/a", defaultEngine: "codex" });
  const healthy = store.createProject({ label: "Healthy", hostPath: "/tmp/b", defaultEngine: "codex" });
  store.close();

  const presetFile = path.join(dataDir, "projects", affected.id, "agent-presets.jsonl");
  const now = new Date().toISOString();
  const crossProjectPreset = {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: healthy.id,
    name: "Wrong owner",
    description: "Must remain quarantined",
    guidance: "This valid JSON record belongs to a different Project.",
    engine: "codex",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  await appendFile(presetFile, `${JSON.stringify({ type: "upsert", preset: crossProjectPreset })}\n`);
  const preserved = await readFile(presetFile, "utf8");

  store = new AgentStore(dataDir);
  assert.deepEqual(store.listProjects().map((project) => project.id), [healthy.id]);
  assert.equal(store.listAgentPresets(healthy.id).some((preset) => preset.id === crossProjectPreset.id), false);
  assert.deepEqual(store.startupProfile().recoveryIssues, [{
    projectId: affected.id,
    detail: `Agent preset record does not belong to Project ${affected.id}`,
  }]);
  assert.equal(await readFile(presetFile, "utf8"), preserved);
  store.close();
});

test("startup rejects Project, Chat, and Agent records outside their containing paths", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-contained-records-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let store = new AgentStore(dataDir);
  const healthy = store.createProject({ label: "Healthy", hostPath: "/tmp/healthy", defaultEngine: "codex" });
  const wrongProject = store.createProject({ label: "Wrong Project", hostPath: "/tmp/p", defaultEngine: "codex" });
  const wrongChat = store.createProject({ label: "Wrong Chat", hostPath: "/tmp/c", defaultEngine: "codex" });
  const wrongAgent = store.createProject({ label: "Wrong Agent", hostPath: "/tmp/a", defaultEngine: "codex" });
  const agent = store.createAgent(wrongAgent.id, {
    title: "Agent",
    engine: "codex",
    conversationId: wrongAgent.lastConversationId,
  });
  store.close();

  const projectFile = path.join(dataDir, "projects", wrongProject.id, "project.json");
  await writeFile(projectFile, JSON.stringify({
    ...JSON.parse(await readFile(projectFile, "utf8")),
    id: "33333333-3333-4333-8333-333333333333",
  }));
  const chatFile = path.join(
    dataDir, "projects", wrongChat.id, "conversations", wrongChat.lastConversationId, "conversation.json",
  );
  await writeFile(chatFile, JSON.stringify({
    ...JSON.parse(await readFile(chatFile, "utf8")),
    id: "44444444-4444-4444-8444-444444444444",
  }));
  const agentFile = path.join(dataDir, "projects", wrongAgent.id, "agents", agent.id, "agent.json");
  await writeFile(agentFile, JSON.stringify({
    ...JSON.parse(await readFile(agentFile, "utf8")),
    projectId: healthy.id,
  }));

  store = new AgentStore(dataDir);
  assert.deepEqual(store.listProjects().map((project) => project.id), [healthy.id]);
  assert.deepEqual(
    new Set(store.startupProfile().recoveryIssues.map((issue) => issue.projectId)),
    new Set([wrongProject.id, wrongChat.id, wrongAgent.id]),
  );
  store.close();
});
