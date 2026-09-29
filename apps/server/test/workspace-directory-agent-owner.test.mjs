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
  const assignedOutcomes = new Map([[agent.id, "2027-01-01T00:00:00.000Z"]]);
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
            status: id === agent.id ? "running" : "completed",
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
  assert.equal(firstChatPage.json().items[0].runningAgentCount, 0);
  const activityCount = async () => {
    const result = await app.inject({ method: "GET", url: `/api/workspace/directory/conversation?conversationId=${owner.id}` });
    assert.equal(result.statusCode, 200, result.body);
    return result.json().items[0].runningAgentCount;
  };
  assert.equal(await activityCount(), 1, "Only canonical running work counts, not assigned idle or blocked agents");
  const workspaceRunningCount = async () => {
    const result = await app.inject({ method: "GET", url: "/api/workspace/directory/agent?summary=true&active=true" });
    assert.equal(result.statusCode, 200, result.body);
    return result.json().runningCount;
  };
  assert.equal(await workspaceRunningCount(), 1, "the Agents heading counts Runs, not waiting or blocked Agents");
  store.sqlite.prepare("UPDATE scheduler_runs SET status = 'completed' WHERE id = 'run-a'").run();
  assert.equal(await activityCount(), 0, "The indicator clears when work completes");
  assert.equal(await workspaceRunningCount(), 0);
  store.sqlite.prepare("UPDATE scheduler_runs SET status = 'running' WHERE id = 'run-a'").run();

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
    url: "/api/workspace/directory/agent?active=true&limit=2",
  });
  assert.equal(activeAgents.statusCode, 200, activeAgents.body);
  assert.equal(activeAgents.json().activeCount, 4);
  assert.equal(activeAgents.json().items.length, 2);
  assert.equal(activeAgents.json().history.hasMore, true);
  const nextActiveAgents = await app.inject({
    method: "GET",
    url: `/api/workspace/directory/agent?active=true&limit=2&cursor=${encodeURIComponent(activeAgents.json().history.cursor)}`,
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
    url: `/api/workspace/directory/agent?active=true&limit=2&cursor=${encodeURIComponent(activeAgents.json().history.cursor)}`,
  });
  assert.equal(staleActiveAgents.statusCode, 409, staleActiveAgents.body);
  assert.equal(staleActiveAgents.json().code, "stale_collection_cursor");
  const refreshedActiveAgents = await app.inject({
    method: "GET",
    url: "/api/workspace/directory/agent?active=true&limit=2",
  });
  assert.equal(refreshedActiveAgents.statusCode, 200, refreshedActiveAgents.body);
  assert.equal(refreshedActiveAgents.json().activeCount, 3);
  workingAgents.set(
    refreshedActiveAgents.json().items[0].agent.id,
    refreshedActiveAgents.json().items[0].health.status === "blocked" ? "waiting" : "blocked",
  );
  const staleHealthPage = await app.inject({
    method: "GET",
    url: `/api/workspace/directory/agent?active=true&limit=2&cursor=${encodeURIComponent(refreshedActiveAgents.json().history.cursor)}`,
  });
  assert.equal(staleHealthPage.statusCode, 409, staleHealthPage.body);
  assert.equal(staleHealthPage.json().code, "stale_collection_cursor");
  const activeSortOverride = await app.inject({
    method: "GET",
    url: "/api/workspace/directory/agent?active=true&sort=last_used",
  });
  assert.equal(activeSortOverride.statusCode, 400, activeSortOverride.body);

  const recentOutcomes = await app.inject({
    method: "GET",
    url: "/api/workspace/directory/agent?outcomes=true&limit=6",
  });
  assert.equal(recentOutcomes.statusCode, 200, recentOutcomes.body);
  assert.equal(recentOutcomes.json().items.some(item => item.agent.id === agent.id), false,
    "an assigned Run that is still running is not a finished outcome");
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

test("active Agent pages use canonical health order and retain Project-scoped totals", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "ponderosa-active-agent-directory-"));
  const store = new AgentStore(dataDir);
  const workspace = new WorkspaceStore(dataDir);
  const coordination = new CoordinationV3Store(store.sqlite);
  const app = Fastify();
  t.after(async () => {
    await app.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const createProjectAgent = (label, suffix, agentTitle = `${label} Agent`) => {
    const project = store.createProject({
      label,
      hostPath: `/tmp/${suffix}`,
      defaultEngine: "codex",
    });
    const conversation = store.createConversation(project.id, { title: `${label} Chat` });
    const agent = store.createAgent(project.id, {
      title: agentTitle,
      engine: "codex",
      conversationId: conversation.id,
    });
    return { project, conversation, agent };
  };
  const first = createProjectAgent("First", "first");
  const second = createProjectAgent("Second", "second");
  const bulk = createProjectAgent("Bulk", "bulk", "Bulk Agent 00");
  const bulkAgents = [bulk.agent];
  for (let index = 1; index < 30; index += 1) {
    bulkAgents.push(store.createAgent(bulk.project.id, {
      title: `Bulk Agent ${String(index).padStart(2, "0")}`,
      engine: "codex",
      conversationId: bulk.conversation.id,
    }));
  }
  const statusTimestamps = new Map([
    [first.agent.id, "2025-12-01T00:00:00.000Z"],
    [second.agent.id, "2025-12-01T00:00:00.000Z"],
  ]);
  store.sqlite.prepare("UPDATE agents SET updated_at = ? WHERE id IN (?, ?)").run(
    "2025-12-01T00:00:00.000Z",
    first.agent.id,
    second.agent.id,
  );
  bulkAgents.forEach((agent, index) => {
    store.sqlite.prepare("UPDATE agents SET updated_at = ? WHERE id = ?").run(
      `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
      agent.id,
    );
    statusTimestamps.set(
      agent.id,
      index < 2
        ? "2026-02-01T00:29:00.000Z"
        : `2026-02-01T00:${String(30 - index).padStart(2, "0")}:00.000Z`,
    );
  });

  registerWorkspaceDirectoryRoutes(app, {
    store,
    coordination,
    workspace,
    agentHealth: (scope, agents) => ({
      scope,
      generatedAt: "2026-03-01T00:00:00.000Z",
      agents: agents.map(({ id }) => ({
        agentId: id,
        childAgentIds: [],
        status: "running",
        statusTimestamp: statusTimestamps.get(id),
        reason: "active_run",
      })),
    }),
    projectDisplayPath: (hostPath) => hostPath,
  });

  for (const { project } of [first, second]) {
    const response = await app.inject({
      method: "GET",
      url: `/api/workspace/directory/agent?active=true&projectId=${project.id}&limit=1`,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().total, 1, "Project active totals remain scoped");
    assert.equal(response.json().activeCount, 32, "the workspace-wide count remains available separately");
  }

  const expected = [...bulkAgents, first.agent, second.agent].sort((left, right) =>
    statusTimestamps.get(right.id).localeCompare(statusTimestamps.get(left.id)) ||
    left.id.localeCompare(right.id));
  const lastUsedPage = await app.inject({
    method: "GET",
    url: "/api/workspace/directory/agent?sort=last_used&limit=1",
  });
  assert.equal(lastUsedPage.statusCode, 200, lastUsedPage.body);
  assert.equal(lastUsedPage.json().items[0].agent.title, "Bulk Agent 29");
  const firstPage = await app.inject({
    method: "GET",
    url: "/api/workspace/directory/agent?active=true&limit=25",
  });
  assert.equal(firstPage.statusCode, 200, firstPage.body);
  assert.deepEqual(
    firstPage.json().items.map(item => item.agent.id),
    expected.slice(0, 25).map(agent => agent.id),
    "the first page is the workspace's canonical newest health slice",
  );
  assert.equal(firstPage.json().items.slice(0, 8).some(item => item.agent.title === "Bulk Agent 00"), true);

  const nextPage = await app.inject({
    method: "GET",
    url: `/api/workspace/directory/agent?active=true&limit=25&cursor=${encodeURIComponent(firstPage.json().history.cursor)}`,
  });
  assert.equal(nextPage.statusCode, 200, nextPage.body);
  assert.deepEqual(
    nextPage.json().items.map(item => item.agent.id),
    expected.slice(25).map(agent => agent.id),
  );

  statusTimestamps.set(expected.at(-1).id, "2026-03-02T00:00:00.000Z");
  const stalePage = await app.inject({
    method: "GET",
    url: `/api/workspace/directory/agent?active=true&limit=25&cursor=${encodeURIComponent(firstPage.json().history.cursor)}`,
  });
  assert.equal(stalePage.statusCode, 409, stalePage.body);
  assert.equal(stalePage.json().code, "stale_collection_cursor");
});
