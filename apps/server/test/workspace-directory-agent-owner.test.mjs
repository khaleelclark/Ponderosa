import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore, CoordinationV3Store, WorkspaceStore } from "@ponderosa/agents";
import Fastify from "fastify";
import { registerWorkspaceDirectoryRoutes } from "../dist/routes/workspace-directory.js";

test("Agent directory carries its owner Chat independently of Chat filtering and pagination", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "ponderosa-agent-directory-owner-"));
  const store = new AgentStore(dataDir);
  const workspace = new WorkspaceStore(dataDir);
  const coordination = new CoordinationV3Store(store.sqlite);
  const app = Fastify();
  t.after(async () => {
    await app.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  for (let index = 0; index < 30; index += 1) {
    store.createConversation(project.id, { title: `Earlier ${String(index).padStart(2, "0")}` });
  }
  const owner = store.createConversation(project.id, { title: "Zulu Backend" });
  const agent = store.createAgent(project.id, {
    title: "Database Expert",
    engine: "codex",
    conversationId: owner.id,
  });
  for (let index = 0; index < 30; index += 1) {
    store.createAgent(project.id, {
      title: `Later Agent ${String(index).padStart(2, "0")}`,
      engine: "codex",
      conversationId: owner.id,
    });
  }
  const now = new Date().toISOString();
  store.sqlite.prepare(`
    INSERT INTO scheduler_runs (
      id, project_id, agent_id, status, lease_owner, lease_expires_at,
      fencing_token, prompt_injection_state, heartbeat_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'running', 'test', ?, 1, 'not_injected', ?, ?, ?)
  `).run("run-a", project.id, agent.id, now, now, now, now);
  for (let index = 0; index < 31; index += 1) {
    coordination.createTriggerDefinition({
      id: `trigger-${index}`,
      projectId: project.id,
      conversationId: owner.id,
      targetAgentId: agent.id,
      name: `Automation ${String(index).padStart(2, "0")}`,
      instructions: "Run the task",
      sourceKind: "schedule",
      sourceConfig: { scheduleKind: "once", at: "2099-01-01T00:00:00.000Z" },
      enabled: index < 30,
      now,
    });
  }
  registerWorkspaceDirectoryRoutes(app, {
    store,
    coordination,
    workspace,
    agentHealth: (scope, agents) => ({
      scope,
      generatedAt: new Date(0).toISOString(),
      agents: agents.map(({ id }) => ({
        agentId: id,
        childAgentIds: [],
        status: id === agent.id ? "running" : "idle",
        statusTimestamp: new Date(0).toISOString(),
        reason: { kind: "idle" },
      })),
    }),
    projectDisplayPath: (hostPath) => hostPath,
  });

  const filteredChats = await app.inject({
    method: "GET",
    url: `/api/workspace/directory/conversation?projectId=${project.id}&search=Database%20Expert&limit=1`,
  });
  assert.equal(filteredChats.json().total, 0);
  const firstChatPage = await app.inject({
    method: "GET",
    url: `/api/workspace/directory/conversation?projectId=${project.id}&sort=alphabetical&limit=1`,
  });
  assert.equal(firstChatPage.json().history.hasMore, true);
  assert.notEqual(firstChatPage.json().items[0].conversation.id, owner.id);

  const response = await app.inject({
    method: "GET",
    url: `/api/workspace/directory/agent?projectId=${project.id}&search=Database%20Expert&limit=1`,
  });
  assert.equal(response.statusCode, 200, response.body);
  const payload = response.json();
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].agent.id, agent.id);
  assert.deepEqual(payload.items[0].ownerConversation, {
    id: owner.id,
    title: "Zulu Backend",
  });

  const activeAgents = await app.inject({
    method: "GET",
    url: "/api/workspace/directory/agent?active=true&limit=6&sort=last_used",
  });
  assert.equal(activeAgents.statusCode, 200, activeAgents.body);
  assert.equal(activeAgents.json().activeCount, 1);
  assert.deepEqual(activeAgents.json().items.map(item => item.agent.id), [agent.id]);

  const automations = await app.inject({
    method: "GET",
    url: "/api/workspace/directory/trigger?limit=25&sort=last_used",
  });
  assert.equal(automations.statusCode, 200, automations.body);
  assert.equal(automations.json().items.length, 25);
  assert.equal(automations.json().history.hasMore, true);
  assert.equal(automations.json().enabledCount, 30);
});
