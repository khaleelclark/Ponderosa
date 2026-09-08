import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import Fastify from "fastify";
import {
  createConversationDeletionAuthority,
  drainProjectConversationDeletions,
} from "../dist/conversation-deletion-authority.js";
import { DraftService } from "../dist/routes/drafts.js";
import { registerConversationRoutes } from "../dist/routes/conversations.js";

const noCleanup = {
  enqueueDraftAttachmentCleanup: () => {},
  finishDraftAttachmentCleanup: () => {},
  pendingDraftAttachmentCleanups: () => [],
  reserveDraftAttachment: () => "draft-reservation",
  settleDraftAttachment: () => {},
  releaseDraftAttachment: () => true,
  syncDraftAttachment: () => {},
  finishDraftSurfaceCleanup: () => {},
};

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
  const drafts = new DraftService(dataDir, store, workspace, noCleanup);
  t.after(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { chat, dataDir, drafts, project, store, workspace };
}

function deletionAuthority({
  commitAgentDeletion = async () => {},
  drafts,
  reconcile = async () => 0,
  refresh = async () => {},
  store,
  workspace,
}) {
  return createConversationDeletionAuthority({
    store,
    workspace,
    drafts,
    deletingConversationIds: new Set(),
    agentCreationConversationLeases: new Map(),
    conversationDeliveryLeases: new Map(),
    reconcileConversationRuntimeCommunicationProjections: reconcile,
    commitAgentDeletion,
    purgeCommunicationV4Conversation: () => {},
    refreshTriggerSources: refresh,
    publishWorkspace: () => {},
  });
}

test("committed Chat cleanup retains refresh and draft rm failures for exact retry", async (t) => {
  const { chat, drafts, store, workspace } = fixture(t);
  for (const draftId of [chat.id, `collaboration:${chat.id}`]) {
    workspace.putDraft(draftId, {
      text: "recover me",
      attachmentIds: ["current-file"],
      pastedTextAttachmentId: "current-paste",
      mentionBindings: [],
      expectedRevision: 0,
      clientId: "page:one",
      ownerId: "browser-one",
    });
    assert.throws(() => workspace.putDraft(draftId, {
      text: "displaced conflict",
      attachmentIds: ["conflict-file"],
      pastedTextAttachmentId: "conflict-paste",
      mentionBindings: [],
      expectedRevision: 0,
      clientId: "page:two",
      ownerId: "browser-one",
    }), error => error?.code === "DRAFT_CONFLICT");
    assert.equal(workspace.listDraftConflicts(draftId, "browser-one").conflicts.length, 1);
    mkdirSync(drafts.surfaceDir(draftId), { recursive: true });
    for (const name of ["current-file", "current-paste", "conflict-file", "conflict-paste"]) {
      writeFileSync(join(drafts.surfaceDir(draftId), name), "draft");
    }
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
    deletingConversationIds: new Set(),
    agentCreationConversationLeases: new Map(),
    conversationDeliveryLeases: new Map(),
    reconcileConversationRuntimeCommunicationProjections: async () => 0,
    commitAgentDeletion: async () => {},
    purgeCommunicationV4Conversation: () => {},
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
  assert.equal(workspace.listDraftConflicts(chat.id, "browser-one").conflicts.length, 0);
  assert.equal(workspace.listDraftConflicts(`collaboration:${chat.id}`, "browser-one").conflicts.length, 0);
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
  const { processConversationDeletionCleanup } = deletionAuthority({
    drafts,
    store,
    workspace,
    refresh: async () => { throw new Error("injected refresh failure"); },
  });
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
    deletingConversationIds: new Set(),
    agentCreationConversationLeases: new Map(),
    conversationDeliveryLeases: new Map(),
    reconcileConversationRuntimeCommunicationProjections: async () => 0,
    refreshTriggers: async () => {},
    processConversationDeletionCleanup,
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

test("Chat deletion resumes after failure immediately after archive", async (t) => {
  const { chat, drafts, project, store, workspace } = fixture(t);
  const agent = store.createAgent(project.id, {
    title: "Agent",
    engine: "codex",
    conversationId: chat.id,
  });
  const pending = store.markConversationDeletionPending(chat.id);
  let observedArchived = false;
  const first = deletionAuthority({
    drafts,
    store,
    workspace,
    commitAgentDeletion: async () => {
      observedArchived = store.getConversation(chat.id)?.archived === true;
      throw new Error("injected failure after archive");
    },
  });

  assert.equal(await first.processConversationDeletionCleanup(pending), false);
  assert.equal(observedArchived, true);
  assert.equal(store.getConversation(chat.id)?.archived, true);
  assert.equal(store.getAgent(agent.id)?.id, agent.id);
  assert.equal(store.getConversationDeletionReceipt(chat.id)?.canonicalDeletionCompleted, false);

  let deletes = 0;
  const recovered = deletionAuthority({
    drafts,
    store,
    workspace,
    commitAgentDeletion: async (rootAgentIds) => {
      deletes += 1;
      for (const agentId of rootAgentIds) store.deleteAgent(agentId);
    },
  });
  const receipt = store.getConversationDeletionReceipt(chat.id);
  assert.ok(receipt);
  assert.equal(await recovered.processConversationDeletionCleanup(receipt), true);
  assert.equal(await recovered.processConversationDeletionCleanup(receipt), true);
  assert.equal(deletes, 1);
  assert.equal(store.getConversation(chat.id), undefined);
  assert.equal(store.getAgent(agent.id), undefined);
  assert.equal(store.getConversationDeletionReceipt(chat.id)?.canonicalDeletionCompleted, true);
});

test("Chat deletion resumes after Agent deletion before canonical Chat commit", async (t) => {
  const { chat, drafts, project, store, workspace } = fixture(t);
  const agent = store.createAgent(project.id, {
    title: "Agent",
    engine: "codex",
    conversationId: chat.id,
  });
  const pending = store.markConversationDeletionPending(chat.id);
  const first = deletionAuthority({
    drafts,
    store,
    workspace,
    commitAgentDeletion: async (rootAgentIds) => {
      for (const agentId of rootAgentIds) store.deleteAgent(agentId);
      throw new Error("injected failure after Agent deletion");
    },
  });

  assert.equal(await first.processConversationDeletionCleanup(pending), false);
  assert.equal(store.getConversation(chat.id)?.archived, true);
  assert.equal(store.getAgent(agent.id), undefined);
  assert.equal(store.getConversationDeletionReceipt(chat.id)?.canonicalDeletionCompleted, false);

  const recovered = deletionAuthority({ drafts, store, workspace });
  const receipt = store.getConversationDeletionReceipt(chat.id);
  assert.ok(receipt);
  assert.equal(await recovered.processConversationDeletionCleanup(receipt), true);
  assert.equal(store.getConversation(chat.id), undefined);
  assert.equal(store.getConversationDeletionReceipt(chat.id)?.canonicalDeletionCompleted, true);
});

test("Chat DELETE cannot enter after Project deletion quarantine", async (t) => {
  const { chat, drafts, store, workspace } = fixture(t);
  const app = Fastify();
  t.after(() => app.close());
  const authority = deletionAuthority({ drafts, store, workspace });
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
    projectDeletionInProgress: () => true,
    deletingConversationIds: new Set(),
    agentCreationConversationLeases: new Map(),
    conversationDeliveryLeases: new Map(),
    reconcileConversationRuntimeCommunicationProjections: async () => 0,
    refreshTriggers: async () => {},
    processConversationDeletionCleanup: authority.processConversationDeletionCleanup,
  });

  const response = await app.inject({
    method: "DELETE",
    url: `/api/conversations/${chat.id}`,
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(store.getConversationDeletionReceipt(chat.id), undefined);
  assert.ok(store.getConversation(chat.id));
});

test("Project deletion drains a seeded Chat receipt before committing", async (t) => {
  const { chat, drafts, project, store, workspace } = fixture(t);
  const receipt = store.markConversationDeletionPending(chat.id);
  const authority = deletionAuthority({ drafts, store, workspace });

  assert.equal(await drainProjectConversationDeletions(
    store,
    project.id,
    authority.processConversationDeletionCleanup,
  ), true);
  assert.equal(store.listPendingConversationDeletionReceipts().length, 0);
  assert.ok(store.commitProjectDeletion(project.id));
  assert.equal(store.getProject(project.id), undefined);
});

test("Project commit refuses a Chat deletion admitted before quarantine", async (t) => {
  const { chat, project, store, workspace } = fixture(t);
  const app = Fastify();
  t.after(() => app.close());
  let projectDeleting = false;
  let deletionStarted;
  const started = new Promise(resolve => { deletionStarted = resolve; });
  let finishDeletion;
  const finish = new Promise(resolve => { finishDeletion = resolve; });
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
    projectDeletionInProgress: () => projectDeleting,
    deletingConversationIds: new Set(),
    agentCreationConversationLeases: new Map(),
    conversationDeliveryLeases: new Map(),
    reconcileConversationRuntimeCommunicationProjections: async () => 0,
    refreshTriggers: async () => {},
    processConversationDeletionCleanup: async () => {
      deletionStarted();
      await finish;
      return false;
    },
  });

  const chatDeletion = app.inject({
    method: "DELETE",
    url: `/api/conversations/${chat.id}`,
  });
  await started;
  projectDeleting = true;

  assert.throws(
    () => store.commitProjectDeletion(project.id),
    /cannot commit while Chat deletion cleanup is pending/u,
  );
  assert.ok(store.getProject(project.id));
  assert.ok(store.getConversation(chat.id));
  assert.equal(store.listPendingConversationDeletionReceipts().length, 1);

  finishDeletion();
  const response = await chatDeletion;
  assert.equal(response.statusCode, 202, response.body);
});

test("startup cleanup converges a legacy Chat receipt superseded by Project deletion", async (t) => {
  const { chat, drafts, project, store, workspace } = fixture(t);
  const authority = deletionAuthority({ drafts, store, workspace });
  const pending = store.markConversationDeletionPending(chat.id);
  assert.equal(await authority.processConversationDeletionCleanup(pending), true);
  assert.ok(store.commitProjectDeletion(project.id));

  store.sqlite.prepare(`
    UPDATE conversation_deletion_receipts
    SET canonical_deletion_completed=0,
        storage_cleanup_completed=0,
        server_cleanup_completed=0,
        completed_at=NULL
    WHERE conversation_id=?
  `).run(chat.id);
  const legacy = store.getConversationDeletionReceipt(chat.id);
  assert.ok(legacy);
  assert.equal(store.getProject(project.id), undefined);
  assert.equal(store.getConversation(chat.id), undefined);

  assert.equal(await authority.processConversationDeletionCleanup(legacy), true);
  const recovered = store.getConversationDeletionReceipt(chat.id);
  assert.equal(recovered.canonicalDeletionCompleted, true);
  assert.equal(recovered.storageCleanupCompleted, true);
  assert.equal(recovered.serverCleanupCompleted, true);
  assert.equal(store.listPendingConversationDeletionReceipts().length, 0);
});
