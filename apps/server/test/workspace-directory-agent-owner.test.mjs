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
  const workingAgents = new Map([[agent.id, "running"]]);
  const assignedOutcomes = new Map();
  for (const [title, status] of [
    ["Waiting Agent", "waiting"],
    ["Provider Blocked Agent", "blocked"],
    ["Decision Agent", "needs_decision"],
  ]) {
    const workingAgent = store.createAgent(project.id, {
      title,
      engine: "codex",
      conversationId: owner.id,
    });
    workingAgents.set(workingAgent.id, status);
  }
  for (let index = 0; index < 30; index += 1) {
    const laterAgent = store.createAgent(project.id, {
      title: `Later Agent ${String(index).padStart(2, "0")}`,
      engine: "codex",
      conversationId: owner.id,
    });
    assignedOutcomes.set(laterAgent.id, `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`);
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
    store.sqlite.prepare("UPDATE trigger_definitions SET next_fire_at = ? WHERE id = ?")
      .run(index === 30 ? "2000-01-01T00:00:00.000Z" : `2099-01-${String(30 - index).padStart(2, "0")}T00:00:00.000Z`, `trigger-${index}`);
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
        status: workingAgents.get(id) ?? "idle",
        statusTimestamp: new Date(0).toISOString(),
        reason: { kind: "idle" },
        ...(assignedOutcomes.has(id) ? {
          assignedWorkOutcome: {
            runId: `outcome-${id}`,
            status: "completed",
            reason: { kind: "completed" },
            updatedAt: assignedOutcomes.get(id),
          },
        } : {}),
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
    url: "/api/workspace/directory/agent?active=true&limit=2&sort=last_used",
  });
  assert.equal(activeAgents.statusCode, 200, activeAgents.body);
  assert.equal(activeAgents.json().activeCount, 4);
  assert.equal(activeAgents.json().items.length, 2);
  assert.equal(activeAgents.json().history.hasMore, true);
  const nextActiveAgents = await app.inject({
    method: "GET",
    url: `/api/workspace/directory/agent?active=true&limit=2&sort=last_used&cursor=${encodeURIComponent(activeAgents.json().history.cursor)}`,
  });
  assert.equal(nextActiveAgents.statusCode, 200, nextActiveAgents.body);
  assert.equal(nextActiveAgents.json().activeCount, 4);
  assert.deepEqual(
    new Set([...activeAgents.json().items, ...nextActiveAgents.json().items].map(item => item.health.status)),
    new Set(["running", "waiting", "blocked", "needs_decision"]),
  );
  assert.equal(
    [...activeAgents.json().items, ...nextActiveAgents.json().items].some(item => item.health.status === "idle"),
    false,
  );
  workingAgents.set(agent.id, "idle");
  const staleActiveAgents = await app.inject({
    method: "GET",
    url: `/api/workspace/directory/agent?active=true&limit=2&sort=last_used&cursor=${encodeURIComponent(activeAgents.json().history.cursor)}`,
  });
  assert.equal(staleActiveAgents.statusCode, 409, staleActiveAgents.body);
  assert.equal(staleActiveAgents.json().code, "stale_collection_cursor");
  const refreshedActiveAgents = await app.inject({
    method: "GET",
    url: "/api/workspace/directory/agent?active=true&limit=2&sort=last_used",
  });
  assert.equal(refreshedActiveAgents.statusCode, 200, refreshedActiveAgents.body);
  assert.equal(refreshedActiveAgents.json().activeCount, 3);
  workingAgents.set(
    refreshedActiveAgents.json().items[0].agent.id,
    refreshedActiveAgents.json().items[0].health.status === "blocked" ? "waiting" : "blocked",
  );
  const staleHealthPage = await app.inject({
    method: "GET",
    url: `/api/workspace/directory/agent?active=true&limit=2&sort=last_used&cursor=${encodeURIComponent(refreshedActiveAgents.json().history.cursor)}`,
  });
  assert.equal(staleHealthPage.statusCode, 409, staleHealthPage.body);
  assert.equal(staleHealthPage.json().code, "stale_collection_cursor");

  const recentOutcomes = await app.inject({
    method: "GET",
    url: "/api/workspace/directory/agent?outcomes=true&limit=6",
  });
  assert.equal(recentOutcomes.statusCode, 200, recentOutcomes.body);
  assert.deepEqual(
    recentOutcomes.json().items.map(item => item.agent.title),
    ["Later Agent 29", "Later Agent 28", "Later Agent 27", "Later Agent 26", "Later Agent 25", "Later Agent 24"],
  );
  assert.equal(recentOutcomes.json().total, 30);
  assert.equal(recentOutcomes.json().history.hasMore, true);
  assignedOutcomes.set(recentOutcomes.json().items[0].agent.id, "2025-01-01T00:00:00.000Z");
  const staleOutcomes = await app.inject({
    method: "GET",
    url: `/api/workspace/directory/agent?outcomes=true&limit=6&cursor=${encodeURIComponent(recentOutcomes.json().history.cursor)}`,
  });
  assert.equal(staleOutcomes.statusCode, 409, staleOutcomes.body);
  assert.equal(staleOutcomes.json().code, "stale_collection_cursor");

  const automations = await app.inject({
    method: "GET",
    url: "/api/workspace/directory/trigger?limit=25&sort=last_used",
  });
  assert.equal(automations.statusCode, 200, automations.body);
  assert.equal(automations.json().items.length, 25);
  assert.equal(automations.json().history.hasMore, true);
  assert.equal(automations.json().enabledCount, 30);

  const homeAutomations = await app.inject({
    method: "GET",
    url: "/api/workspace/directory/trigger?enabled=true&sort=next_fire&limit=8",
  });
  assert.equal(homeAutomations.statusCode, 200, homeAutomations.body);
  assert.deepEqual(homeAutomations.json().items.map(item => item.trigger.id), [
    "trigger-29", "trigger-28", "trigger-27", "trigger-26",
    "trigger-25", "trigger-24", "trigger-23", "trigger-22",
  ]);
  assert.equal(homeAutomations.json().items.some(item => item.trigger.id === "trigger-30"), false);
  const nextHomeAutomations = await app.inject({
    method: "GET",
    url: `/api/workspace/directory/trigger?enabled=true&sort=next_fire&limit=8&cursor=${encodeURIComponent(homeAutomations.json().history.cursor)}`,
  });
  assert.equal(nextHomeAutomations.statusCode, 200, nextHomeAutomations.body);
  assert.equal(nextHomeAutomations.json().items[0].trigger.id, "trigger-21");
});
