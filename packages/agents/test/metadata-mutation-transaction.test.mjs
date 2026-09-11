import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentStore, ProjectDeletionInProgressError } from "../dist/index.js";

const presetInput = (name) => ({
  name,
  description: "Focused metadata regression",
  guidance: "Exercise the durable metadata mutation boundary.",
  engine: "codex",
});

test("canonical metadata commits survive projection failure and converge on restart", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-metadata-commit-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let store = new AgentStore(dataDir);
  const project = store.createProject({ label: "Before", hostPath: "/tmp/affected", defaultEngine: "codex" });
  const sibling = store.createProject({ label: "Sibling", hostPath: "/tmp/sibling", defaultEngine: "codex" });
  const conversation = store.getConversation(project.lastConversationId);
  const preset = store.createAgentPreset(project.id, presetInput("Before preset"));
  store.sqlite.exec(`
    CREATE TRIGGER fail_project_label BEFORE UPDATE OF label ON projects
      WHEN NEW.id = '${project.id}' BEGIN SELECT RAISE(FAIL, 'project projection failed'); END;
    CREATE TRIGGER fail_project_use BEFORE UPDATE OF last_used_at ON projects
      WHEN NEW.id = '${project.id}' BEGIN SELECT RAISE(FAIL, 'use projection failed'); END;
    CREATE TRIGGER fail_chat_title BEFORE UPDATE OF title ON conversations
      WHEN NEW.id = '${conversation.id}' BEGIN SELECT RAISE(FAIL, 'chat projection failed'); END;
    CREATE TRIGGER fail_preset_update BEFORE UPDATE OF name ON agent_presets
      WHEN NEW.id = '${preset.id}' BEGIN SELECT RAISE(FAIL, 'preset update projection failed'); END;
    CREATE TRIGGER fail_preset_delete BEFORE DELETE ON agent_presets
      WHEN OLD.id = '${preset.id}' BEGIN SELECT RAISE(FAIL, 'preset delete projection failed'); END;
    CREATE TRIGGER fail_preset_create BEFORE INSERT ON agent_presets
      WHEN NEW.name = 'Created while stale' BEGIN SELECT RAISE(FAIL, 'preset create projection failed'); END;
  `);

  const updatedProject = store.updateProject(project.id, { label: "After" });
  assert.equal(updatedProject.label, "After");
  assert.deepEqual(store.updateProject(project.id, { label: "After" }), updatedProject);
  const used = store.markProjectUsed(project.id, conversation.id);
  assert.equal(used.lastConversationId, conversation.id);
  const updatedConversation = store.updateConversation(conversation.id, { title: "After chat" });
  assert.equal(updatedConversation.title, "After chat");
  assert.deepEqual(store.updateConversation(conversation.id, { title: "After chat" }), updatedConversation);
  const updatedPreset = store.updateAgentPreset(preset.id, { name: "After preset" });
  assert.equal(updatedPreset.name, "After preset");
  assert.deepEqual(store.updateAgentPreset(preset.id, { name: "After preset" }), updatedPreset);
  assert.equal(store.deleteAgentPreset(preset.id), true);
  assert.equal(store.deleteAgentPreset(preset.id), true);
  const created = store.createAgentPreset(project.id, presetInput("Created while stale"));
  assert.equal(created.name, "Created while stale");
  assert.equal(store.updateProject(sibling.id, { label: "Sibling after" }).label, "Sibling after");

  const projectJson = JSON.parse(await readFile(path.join(dataDir, "projects", project.id, "project.json"), "utf8"));
  const conversationJson = JSON.parse(await readFile(path.join(dataDir, "projects", project.id, "conversations", conversation.id, "conversation.json"), "utf8"));
  const presetEvents = (await readFile(path.join(dataDir, "projects", project.id, "agent-presets.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(projectJson.label, "After");
  assert.equal(conversationJson.title, "After chat");
  assert.equal(presetEvents.filter((event) => event.type === "upsert" && event.preset?.id === preset.id).length, 2);
  assert.equal(presetEvents.filter((event) => event.type === "delete" && event.id === preset.id).length, 1);
  assert.equal(presetEvents.at(-2).type, "delete");
  assert.equal(presetEvents.at(-1).preset.id, created.id);

  store.sqlite.exec(`
    DROP TRIGGER fail_project_label;
    DROP TRIGGER fail_project_use;
    DROP TRIGGER fail_chat_title;
    DROP TRIGGER fail_preset_update;
    DROP TRIGGER fail_preset_delete;
    DROP TRIGGER fail_preset_create;
  `);
  store.close();
  store = new AgentStore(dataDir);
  assert.equal(store.getProject(project.id).label, "After");
  assert.equal(store.getProject(sibling.id).label, "Sibling after");
  assert.equal(store.getConversation(conversation.id).title, "After chat");
  assert.equal(store.getAgentPreset(preset.id), undefined);
  assert.equal(store.getAgentPreset(created.id).name, "Created while stale");
  store.close();
});

test("canonical write failure leaves the projection unchanged", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-metadata-write-fail-"));
  const store = new AgentStore(dataDir);
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const project = store.createProject({ label: "Before", hostPath: "/tmp/project", defaultEngine: "codex" });
  const file = path.join(dataDir, "projects", project.id, "project.json");
  const saved = `${file}.saved`;
  await rename(file, saved);
  await mkdir(file);
  assert.throws(() => store.updateProject(project.id, { label: "After" }));
  assert.equal(store.sqlite.prepare("SELECT label FROM projects WHERE id=?").get(project.id).label, "Before");
  await rm(file, { recursive: true });
  await rename(saved, file);
});

test("durable Project deletion quarantine rejects every metadata mutation and isolates siblings", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-metadata-quarantine-"));
  const store = new AgentStore(dataDir);
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const project = store.createProject({ label: "Affected", hostPath: "/tmp/affected", defaultEngine: "codex" });
  const sibling = store.createProject({ label: "Sibling", hostPath: "/tmp/sibling", defaultEngine: "codex" });
  const conversation = store.getConversation(project.lastConversationId);
  const preset = store.createAgentPreset(project.id, presetInput("Affected preset"));
  store.markProjectDeletionPending(project.id);

  for (const mutation of [
    () => store.updateProject(project.id, { label: "Blocked" }),
    () => store.markProjectUsed(project.id, conversation.id),
    () => store.updateConversation(conversation.id, { title: "Blocked" }),
    () => store.createAgentPreset(project.id, presetInput("Blocked create")),
    () => store.updateAgentPreset(preset.id, { name: "Blocked update" }),
    () => store.deleteAgentPreset(preset.id),
  ]) assert.throws(mutation, ProjectDeletionInProgressError);

  assert.equal(store.updateProject(sibling.id, { label: "Sibling after" }).label, "Sibling after");
  assert.equal(store.getProject(project.id).label, "Affected");
  assert.equal(store.getConversation(conversation.id).title, "New Chat");
  assert.equal(store.getAgentPreset(preset.id).name, "Affected preset");
});
