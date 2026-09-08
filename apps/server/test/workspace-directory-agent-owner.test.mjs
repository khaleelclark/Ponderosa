import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import Fastify from "fastify";
import { registerWorkspaceDirectoryRoutes } from "../dist/routes/workspace-directory.js";

test("Agent directory carries its owner Chat independently of Chat filtering and pagination", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "ponderosa-agent-directory-owner-"));
  const store = new AgentStore(dataDir);
  const workspace = new WorkspaceStore(dataDir);
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
  registerWorkspaceDirectoryRoutes(app, {
    store,
    coordination: { getTriggerDefinition: () => undefined },
    workspace,
    agentHealth: (scope, agents) => ({
      scope,
      generatedAt: new Date(0).toISOString(),
      agents: agents.map(({ id }) => ({
        agentId: id,
        childAgentIds: [],
        status: "idle",
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
});
