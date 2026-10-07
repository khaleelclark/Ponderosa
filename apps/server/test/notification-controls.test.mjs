import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import { registerNotificationMutationRoutes } from "../dist/routes/notifications.js";
import { pushPayload } from "../dist/web-push-delivery.js";
import { createCommunicationJournal } from "../dist/communication-journal.js";

test("tab clear route dismisses the complete selected feed, not just its loaded page", async () => {
  const root = await mkdtemp(join(tmpdir(), "notification-controls-"));
  const app = Fastify();
  let store;
  try {
    store = new AgentStore(root);
    const workspace = new WorkspaceStore(root);
    const project = store.createProject({ label: "Notifications", hostPath: root, defaultEngine: "codex" });
    const chatId = project.lastConversationId;
    const published = [];
    registerNotificationMutationRoutes(app, {
      workspace,
      store,
      publishWorkspaceSince: cursor => published.push(cursor),
    });
    const updates = Array.from({ length: 105 }, (_, index) => workspace.createNotification({
      projectId: project.id, conversationId: chatId, kind: "direct_responses", title: `Update ${index}`, body: "Reply",
    }));
    const action = workspace.createNotification({
      projectId: project.id, conversationId: chatId, kind: "operational", severity: "urgent", title: "Action", body: "Review",
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
  } finally { await app.close(); store?.close(); await rm(root, { recursive: true, force: true }); }
});

test("new reply notifications format before truncation and retain canonical Markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), 'notification-journal-preview-'));
  const store = new AgentStore(root), workspace = new WorkspaceStore(root);
  const journal = createCommunicationJournal({ store, workspace, webPushConfigured: false,
    publishWorkspaceSince: () => {}, appendWorkspace: event => workspace.append(event), isClosed: () => false });
  try {
    const project = store.createProject({ label: 'Fixture', hostPath: root, defaultEngine: 'codex' });
    const chat = store.createConversation(project.id, { title: 'Chat' });
    const agent = store.createAgent(project.id, { title: 'Agent', engine: 'codex', conversationId: chat.id });
    const text = `**Ready** [Audit preview link](https://example.test/${'a'.repeat(500)}) and next steps.`;
    const result = journal.recordCommunication({ schemaVersion: 2, eventId: 'reply', projectId: project.id, conversationId: chat.id,
      sender: { kind: 'agent', agentId: agent.id }, intent: 'user_dm', audience: { kind: 'user_agent', userId: 'operator', agentId: agent.id },
      text, createdAt: new Date().toISOString() });
    assert.equal(result.text, text);
    assert.equal(workspace.listNotificationPage({ limit: 10 }).items[0].body, 'Ready Audit preview link and next steps.');
    journal.recordCommunication(result);
    assert.equal(workspace.listNotificationPage({ limit: 10 }).items.length, 1, 'replay does not duplicate the notification');
    workspace.updatePreferences({ notifications: { directResponses: false, broadcasts: false } });
    journal.recordCommunication({ ...result, eventId: 'filtered-reply' });
    assert.equal(workspace.listNotificationPage({ limit: 10 }).items.length, 1, 'intentional notification filtering remains unchanged');
  } finally { journal.stopCommunicationReconciliation(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("push opens the containing Chat when an Agent ID is also present", () => {
  const notification = {
    id: "notification", projectId: "project", conversationId: "chat", agentId: "agent",
    communicationEventId: "message", kind: "direct_responses", title: "Agent", body: "Reply",
    createdAt: "2026-09-24T00:00:00.000Z",
  };
  assert.equal(pushPayload(notification).url, "/projects/project/chats/chat?message=message");
  assert.equal(pushPayload({ ...notification, conversationId: undefined }).url, "/projects/project/agents/agent?message=message");
  assert.equal(pushPayload({ ...notification, body: `[Audit preview link](https://example.test/${'a'.repeat(200)}` }).body, 'Audit preview link');
  assert.equal(pushPayload({ ...notification, body: `**Ready** [report](https://example.test/${'a'.repeat(500)})` }).body, 'Ready report');
});
