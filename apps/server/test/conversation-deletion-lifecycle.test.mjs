import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import Fastify from "fastify";
import { createConversationDeletionAuthority } from "../dist/conversation-deletion-authority.js";
import { DraftService } from "../dist/routes/drafts.js";
import { registerConversationRoutes } from "../dist/routes/conversations.js";

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "ponderosa-chat-deletion-"));
  const store = new AgentStore(dataDir);
  const workspace = new WorkspaceStore(dataDir);
  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  const chat = store.listConversations(project.id)[0];
  const drafts = new DraftService(dataDir, store, workspace);
  t.after(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { chat, dataDir, drafts, store, workspace };
}

test("committed Chat cleanup retains refresh and draft rm failures for exact retry", async (t) => {
  const { chat, drafts, store, workspace } = fixture(t);
  for (const draftId of [chat.id, `collaboration:${chat.id}`]) {
    workspace.putDraft(draftId, {
      text: "recover me",
      attachmentIds: [],
      mentionBindings: [],
      expectedRevision: 0,
      clientId: "page:one",
      ownerId: "browser-one",
    });
    mkdirSync(drafts.surfaceDir(draftId), { recursive: true });
    writeFileSync(join(drafts.surfaceDir(draftId), "sentinel"), "draft");
  }
  const receipt = store.commitConversationDeletion(chat.id);
  assert.ok(receipt);
  assert.equal(store.getConversation(chat.id), undefined);

  let failDraftRm = true;
  let failRefresh = true;
  const published = [];
  const { processConversationDeletionCleanup } = createConversationDeletionAuthority({
    store,
    workspace,
    drafts: {
      deleteSurface: async (draftId) => {
        if (draftId === chat.id && failDraftRm) {
          failDraftRm = false;
          throw new Error("injected draft rm failure");
        }
        await drafts.deleteSurface(draftId);
      },
    },
    refreshTriggerSources: async () => {
      if (failRefresh) {
        failRefresh = false;
        throw new Error("injected refresh failure");
      }
    },
    publishWorkspace: event => published.push(event),
  });

  assert.equal(await processConversationDeletionCleanup(receipt), false);
  const pending = store.getConversationDeletionReceipt(chat.id);
  assert.equal(pending.storageCleanupCompleted, true);
  assert.equal(pending.serverCleanupCompleted, false);
  assert.match(pending.lastError, /injected draft rm failure/u);
  assert.match(pending.lastError, /injected refresh failure/u);
  assert.equal(existsSync(drafts.surfaceDir(chat.id)), true);

  assert.equal(await processConversationDeletionCleanup(pending), true);
  const completed = store.getConversationDeletionReceipt(chat.id);
  assert.equal(completed.storageCleanupCompleted, true);
  assert.equal(completed.serverCleanupCompleted, true);
  assert.equal(completed.lastError, undefined);
  assert.equal(existsSync(drafts.surfaceDir(chat.id)), false);
  assert.equal(existsSync(drafts.surfaceDir(`collaboration:${chat.id}`)), false);
  assert.equal(workspace.getDraft(chat.id, "browser-one").text, "");
  assert.equal(workspace.getDraft(`collaboration:${chat.id}`, "browser-one").text, "");
  assert.equal(
    workspace.readSince(0).filter(event =>
      event.event.type === "conversation_changed" &&
      event.event.action === "deleted" &&
      event.event.conversationId === chat.id).length,
    1,
  );
  assert.equal(published.length, 2);
  assert.equal(published[0].id, published[1].id);
});

test("Chat DELETE reports committed cleanup pending and replays its receipt", async (t) => {
  const { chat, drafts, store, workspace } = fixture(t);
  const app = Fastify();
  t.after(() => app.close());
  registerConversationRoutes(app, {
    store,
    workspace,
    engines: new Map(),
    cachedModelOptions: () => [],
    appendWorkspace: () => {},
    generateConversationTitle: async () => ({ title: chat.title, generated: false }),
    conversationDetail: () => undefined,
    agentHealth: () => ({}),
    teamDirectory: () => ({}),
    hasActiveRun: () => false,
    commitAgentDeletion: async () => ({ deletedAgentIds: [] }),
    deletingConversationIds: new Set(),
    agentCreationConversationLeases: new Map(),
    conversationDeliveryLeases: new Map(),
    reconcileConversationRuntimeCommunicationProjections: async () => 0,
    purgeCommunicationV4Conversation: () => {},
    refreshTriggers: async () => {},
    drafts,
    processConversationDeletionCleanup: async () => false,
  });

  const first = await app.inject({ method: "DELETE", url: `/api/conversations/${chat.id}` });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().deleted, true);
  assert.equal(first.json().cleanupPending, true);
  assert.equal(store.getConversation(chat.id), undefined);

  const replay = await app.inject({ method: "DELETE", url: `/api/conversations/${chat.id}` });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().deleted, true);
  assert.equal(replay.json().cleanupPending, true);
  assert.equal(replay.json().replayed, true);
  assert.equal(replay.json().deletionReceiptId, first.json().deletionReceiptId);
});
