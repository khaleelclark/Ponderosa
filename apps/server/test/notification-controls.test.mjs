import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { WorkspaceStore } from "@ponderosa/agents";
import { registerNotificationMutationRoutes } from "../dist/routes/notifications.js";
import { pushPayload } from "../dist/web-push-delivery.js";

test("tab clear route dismisses the complete selected feed, not just its loaded page", async () => {
  const root = await mkdtemp(join(tmpdir(), "notification-controls-"));
  const app = Fastify();
  try {
    const workspace = new WorkspaceStore(root);
    const published = [];
    registerNotificationMutationRoutes(app, {
      workspace,
      store: { getAgentTitleProjection: () => new Map() },
      publishWorkspaceSince: cursor => published.push(cursor),
    });
    const updates = Array.from({ length: 105 }, (_, index) => workspace.createNotification({
      projectId: "project", conversationId: "chat", kind: "direct_responses", title: `Update ${index}`, body: "Reply",
    }));
    const action = workspace.createNotification({
      projectId: "project", conversationId: "chat", kind: "operational", severity: "urgent", title: "Action", body: "Review",
    });
    assert.equal((await app.inject({ method: "POST", url: "/api/notifications/dismiss-all", payload: { kind: "both" } })).statusCode, 400);
    const cleared = await app.inject({ method: "POST", url: "/api/notifications/dismiss-all", payload: { kind: "updates" } });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().dismissed, 105);
    assert.equal(workspace.listNotificationPage({ limit: 100 }).openActionCount, 1);
    assert.equal(workspace.getNotification(updates[104].id).status, "dismissed");
    assert.equal((await app.inject({ method: "POST", url: "/api/notifications/dismiss-all", payload: { kind: "attention" } })).json().dismissed, 1);
    assert.equal(workspace.getNotification(action.id).status, "dismissed");
    assert.equal(workspace.listNotificationPage({ limit: 100 }).items.length, 0);
    assert.equal(published.length, 2);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test("push opens the containing Chat when an Agent ID is also present", () => {
  const notification = {
    id: "notification", projectId: "project", conversationId: "chat", agentId: "agent",
    communicationEventId: "message", kind: "direct_responses", title: "Agent", body: "Reply",
    createdAt: "2026-09-24T00:00:00.000Z",
  };
  assert.equal(pushPayload(notification).url, "/projects/project/chats/chat?message=message");
  assert.equal(pushPayload({ ...notification, conversationId: undefined }).url, "/projects/project/agents/agent?message=message");
});
