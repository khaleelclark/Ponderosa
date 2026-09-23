import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { WorkspaceStore } from "@ponderosa/agents";
import { registerWorkspacePreferenceRoutes } from "../dist/routes/workspace-preferences.js";

test("resource notification updates validate scope and preserve unrelated preferences", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "notification-settings-"));
  const app = Fastify();
  try {
    const workspace = new WorkspaceStore(root);
    registerWorkspacePreferenceRoutes(app, { opts: { dataDir: root }, workspace, engines: new Map(),
      store: { getAgent: id => id === "agent" ? { id, conversationId: "chat" } : undefined, getConversation: id => id === "chat" ? { id } : undefined }, publishWorkspaceSince() {} });
    const put = (scope, mode) => app.inject({ method: "PUT", url: `/api/notification-settings/${scope}`, payload: { mode } });
    assert.equal((await put("conversation/chat", "muted")).statusCode, 200);
    assert.equal((await put("agent/agent", "attention")).statusCode, 200);
    assert.deepEqual(workspace.getPreferences().notificationScopes, { "conversation:chat": "muted", "agent:agent": "attention" });
    assert.equal((await put("agent/agent", "inherit")).statusCode, 200);
    assert.deepEqual(workspace.getPreferences().notificationScopes, { "conversation:chat": "muted" });
    assert.equal((await put("conversation/chat", "inherit")).statusCode, 400);
    assert.equal((await put("agent/missing", "all")).statusCode, 404);
    assert.equal((await put("agent/agent", "invalid")).statusCode, 400);
    assert.equal((await put("project/chat", "muted")).statusCode, 400);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/workspace/preferences", payload: { notificationScopes: {} } })).statusCode, 400);
    assert.equal(workspace.getPreferences().notifications.directResponses, true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
