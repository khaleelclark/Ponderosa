import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INLINE_TEXT_MAX_CODE_POINTS } from "@ponderosa/core";
import { WorkspaceStore } from "@ponderosa/agents";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { AssetStore } from "../dist/assets.js";
import {
  DraftService,
  draftUpdateBodyError,
  registerDraftRoutes,
} from "../dist/routes/drafts.js";

const validDraft = {
  text: "continue",
  attachmentIds: [],
  mentionBindings: [],
  expectedRevision: 0,
  clientId: "page:one",
  ownerId: "browser-one",
};
const validAssetId = "00000000-0000-4000-8000-000000000001";
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

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("draft updates reject malformed public-boundary values", () => {
  for (const body of [undefined, null, [], "bad"]) {
    assert.ok(draftUpdateBodyError(body, 8));
  }
  for (const body of [
    { ...validDraft, clientId: 42 },
    { ...validDraft, text: { malformed: true } },
    { ...validDraft, text: "x".repeat(INLINE_TEXT_MAX_CODE_POINTS + 1) },
    { ...validDraft, expectedRevision: -1 },
    { ...validDraft, attachmentIds: [42] },
    { ...validDraft, extra: true },
  ]) {
    assert.ok(draftUpdateBodyError(body, 8));
  }
});

test("draft updates accept only exact typed bounded state", () => {
  assert.equal(draftUpdateBodyError(validDraft, 8), undefined);
  assert.equal(draftUpdateBodyError({
    ...validDraft,
    pastedTextAttachmentId: validAssetId,
  }, 8), undefined);
  assert.ok(draftUpdateBodyError({
    ...validDraft,
    attachmentIds: [validAssetId],
    pastedTextAttachmentId: validAssetId,
  }, 8));
  assert.ok(draftUpdateBodyError({
    ...validDraft,
    mentionBindings: [{
      projectId: "project-a",
      agentId: "agent-a",
      handle: "agent-a",
      currentHandle: "agent-a",
      currentTitle: "Agent A",
      extra: true,
    }],
  }, 8));
});

test("draft asset identifiers are bounded UUIDs before stale conflict persistence", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-id-boundary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = new WorkspaceStore(directory);
  workspace.putDraft("chat-a", {
    ...validDraft,
    text: "newer",
    ownerId: "browser-one",
  });
  const app = Fastify();
  t.after(() => app.close());
  registerDraftRoutes(
    app,
    new DraftService(
      directory,
      { getAgent: () => undefined, getConversation: () => ({ id: "chat-a" }) },
      workspace,
      noCleanup,
    ),
    workspace,
    8,
    () => undefined,
  );
  for (const references of [
    { attachmentIds: ["A".repeat(1_000_000)] },
    { attachmentIds: [], pastedTextAttachmentId: "B".repeat(1_000_000) },
  ]) {
    const response = await app.inject({
      method: "PUT",
      url: "/api/conversations/chat-a/draft",
      payload: { ...validDraft, ...references, text: "stale" },
    });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(workspace.listDraftConflicts("chat-a", "browser-one").conflicts.length, 0);

  const wellFormedMissing = await app.inject({
    method: "PUT",
    url: "/api/conversations/chat-a/draft",
    payload: {
      ...validDraft,
      text: "recover me",
      attachmentIds: [validAssetId],
    },
  });
  assert.equal(wellFormedMissing.statusCode, 409, wellFormedMissing.body);
});

test("draft upload syncs its directory before settlement and releases a failed barrier", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-durable-write-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const events = [];
  let failSync = true;
  const authority = {
    ...noCleanup,
    enqueueDraftAttachmentCleanup: () => { events.push("cleanup"); },
    reserveDraftAttachment: () => { events.push("reserve"); return "reservation"; },
    settleDraftAttachment: () => { events.push("settle"); },
    releaseDraftAttachment: () => { events.push("release"); return true; },
  };
  const drafts = new DraftService(
    directory,
    { getAgent: () => undefined, getConversation: () => ({ id: "chat-a" }) },
    {
      cursor: () => 0,
      getDraft: () => ({ ...validDraft, conversationId: "chat-a", revision: 0, updatedAt: new Date(0).toISOString() }),
      listDraftConflicts: () => ({ conversationId: "chat-a", conflicts: [] }),
      putDraft: () => assert.fail("upload must not mutate the draft"),
    },
    authority,
  );
  drafts.syncAttachmentDirectory = async () => {
    events.push("sync-directory");
    if (failSync) throw new Error("injected directory fsync failure");
  };
  const app = Fastify();
  t.after(() => app.close());
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  registerDraftRoutes(app, drafts, authority, 8, () => undefined);
  const upload = () => app.inject({
    method: "POST",
    url: "/api/conversations/chat-a/draft-attachments",
    headers: {
      "content-type": "application/octet-stream",
      "x-ponderosa-draft-owner": "browser-one",
      "x-ponderosa-filename": "note.txt",
      "x-ponderosa-media-type": "text/plain",
    },
    payload: Buffer.from("durable body"),
  });
  const failed = await upload();
  assert.equal(failed.statusCode, 500, failed.body);
  assert.equal(events.includes("settle"), false);
  assert.equal(events.at(-1), "release");
  failSync = false;
  events.length = 0;
  const succeeded = await upload();
  assert.equal(succeeded.statusCode, 201, succeeded.body);
  assert.ok(events.indexOf("sync-directory") < events.indexOf("settle"));
  assert.equal(events.at(-1), "release");
});

test("draft upload concurrency is admitted before content preparation across owners", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-preparation-admission-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const assets = new AssetStore(directory);
  t.after(() => assets.close());
  const drafts = new DraftService(
    directory,
    { getAgent: () => undefined, getConversation: () => ({ id: "chat-a" }) },
    new WorkspaceStore(directory),
    assets,
  );
  const syncs = [];
  drafts.syncAttachmentDirectory = () => new Promise(resolve => syncs.push(resolve));
  const app = Fastify();
  t.after(() => app.close());
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  registerDraftRoutes(app, drafts, new WorkspaceStore(directory), 8, () => undefined);
  const request = (ownerId, payload = Buffer.from("valid text"), filename = "note.txt") => app.inject({
    method: "POST",
    url: "/api/conversations/chat-a/draft-attachments",
    headers: {
      "content-type": "application/octet-stream",
      "x-ponderosa-draft-owner": ownerId,
      "x-ponderosa-filename": filename,
      "x-ponderosa-media-type": "text/plain",
    },
    payload,
  });
  const active = Array.from({ length: 4 }, (_, index) => request(`owner-${index}`));
  while (syncs.length < 4) await new Promise(resolve => setImmediate(resolve));
  const rejectedBeforePreparation = await request(
    "rotated-owner",
    Buffer.from([0, 1, 2, 3]),
    "invalid.txt",
  );
  assert.equal(rejectedBeforePreparation.statusCode, 429, rejectedBeforePreparation.body);
  for (const resolve of syncs.splice(0)) resolve();
  const settled = await Promise.all(active);
  assert.ok(settled.every(response => response.statusCode === 201));
});

test("v9 startup quota synchronization includes future-grace receipts and is idempotent", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-v9-backfill-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = new WorkspaceStore(directory);
  let assets = new AssetStore(directory);
  let drafts = new DraftService(
    directory,
    { getAgent: () => undefined, getConversation: () => ({ id: "chat-a" }) },
    workspace,
    assets,
  );
  const app = Fastify();
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  registerDraftRoutes(app, drafts, workspace, 8, () => undefined);
  const uploaded = await app.inject({
    method: "POST",
    url: "/api/conversations/chat-a/draft-attachments",
    headers: {
      "content-type": "application/octet-stream",
      "x-ponderosa-draft-owner": "browser-one",
      "x-ponderosa-filename": "note.txt",
      "x-ponderosa-media-type": "text/plain",
    },
    payload: Buffer.from("pre-v9 body"),
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  await app.close();
  assets.close();

  const databaseFile = join(directory, "asset-authority.sqlite");
  let db = new Database(databaseFile);
  const eligibleAt = db.prepare(
    "SELECT eligible_at eligibleAt FROM draft_attachment_cleanups WHERE asset_id=?",
  ).get(uploaded.json().id).eligibleAt;
  assert.ok(eligibleAt > Date.now());
  db.exec(`
    DROP TABLE draft_asset_settlements;
    DROP TABLE draft_asset_reservations;
    DROP TABLE draft_asset_committed;
    DROP TABLE draft_asset_rate_events;
    PRAGMA user_version=8;
  `);
  db.prepare(`
    INSERT INTO draft_attachment_cleanups(draft_id,owner_id,asset_id,eligible_at)
    VALUES (?,?,?,?)
  `).run("chat-a", "browser-one", "00000000-0000-4000-8000-000000000099", eligibleAt);
  db.close();

  assets = new AssetStore(directory);
  t.after(() => assets.close());
  drafts = new DraftService(
    directory,
    { getAgent: () => undefined, getConversation: () => ({ id: "chat-a" }) },
    workspace,
    assets,
  );
  assert.equal(await drafts.synchronizeAttachmentQuota(), 1);
  assert.equal(await drafts.synchronizeAttachmentQuota(), 1);
  db = new Database(databaseFile, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) count FROM draft_asset_committed").get().count, 1);
  assert.equal(db.prepare(
    "SELECT eligible_at eligibleAt FROM draft_attachment_cleanups WHERE asset_id=?",
  ).get(uploaded.json().id).eligibleAt, eligibleAt);
  assert.equal(db.prepare("SELECT count(*) count FROM draft_attachment_cleanups").get().count, 2);
});

test("draft routes hydrate a separate durable pasted-text asset", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-paste-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = Fastify();
  const assets = new AssetStore(directory);
  t.after(() => assets.close());
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  let draft = {
    conversationId: "chat-a",
    ownerId: "browser-one",
    text: "",
    attachmentIds: [],
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    clientId: "",
  };
  const workspace = {
    cursor: () => 0,
    getDraft: () => draft,
    listDraftConflicts: () => ({ conversationId: "chat-a", conflicts: [] }),
    putDraft: (_id, input) => {
      draft = {
        conversationId: "chat-a",
        ownerId: input.ownerId,
        text: input.text,
        attachmentIds: input.attachmentIds,
        ...(input.pastedTextAttachmentId
          ? { pastedTextAttachmentId: input.pastedTextAttachmentId }
          : {}),
        mentionBindings: input.mentionBindings,
        revision: draft.revision + 1,
        updatedAt: new Date().toISOString(),
        clientId: input.clientId,
      };
      return draft;
    },
  };
  registerDraftRoutes(
    app,
    new DraftService(
      directory,
      { getAgent: () => undefined, getConversation: () => ({ id: "chat-a" }) },
      workspace,
      assets,
    ),
    workspace,
    8,
    () => undefined,
  );
  const uploaded = await app.inject({
    method: "POST",
    url: "/api/conversations/chat-a/draft-attachments",
    headers: {
      "content-type": "application/octet-stream",
      "x-ponderosa-draft-owner": "browser-one",
      "x-ponderosa-filename": "Pasted text.txt",
      "x-ponderosa-media-type": "text/plain",
    },
    payload: Buffer.from("durable long paste"),
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const attachment = uploaded.json();
  const saved = await app.inject({
    method: "PUT",
    url: "/api/conversations/chat-a/draft",
    payload: {
      ...validDraft,
      pastedTextAttachmentId: attachment.id,
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().pastedTextAttachmentId, attachment.id);
  assert.equal(saved.json().pastedTextAttachment.id, attachment.id);
  assert.deepEqual(saved.json().attachmentIds, []);
  const downloaded = await app.inject({
    method: "GET",
    url: attachment.downloadUrl,
  });
  assert.equal(downloaded.statusCode, 200, downloaded.body);
  assert.equal(downloaded.rawPayload.toString("utf8"), "durable long paste");
  const replacementUpload = await app.inject({
    method: "POST",
    url: "/api/conversations/chat-a/draft-attachments",
    headers: {
      "content-type": "application/octet-stream",
      "x-ponderosa-draft-owner": "browser-one",
      "x-ponderosa-filename": "Pasted text.txt",
      "x-ponderosa-media-type": "text/plain",
    },
    payload: Buffer.from("replacement long paste"),
  });
  assert.equal(replacementUpload.statusCode, 201, replacementUpload.body);
  const replacement = replacementUpload.json();
  const prematureDelete = await app.inject({
    method: "DELETE",
    url: `${attachment.downloadUrl}`,
  });
  assert.equal(prematureDelete.statusCode, 409, prematureDelete.body);
  const replaced = await app.inject({
    method: "PUT",
    url: "/api/conversations/chat-a/draft",
    payload: {
      ...validDraft,
      expectedRevision: 1,
      pastedTextAttachmentId: replacement.id,
    },
  });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(replaced.json().pastedTextAttachmentId, replacement.id);
  const releasedDelete = await app.inject({
    method: "DELETE",
    url: `${attachment.downloadUrl}`,
  });
  assert.equal(releasedDelete.statusCode, 404, releasedDelete.body);
  const replacementStillReferenced = await app.inject({
    method: "DELETE",
    url: `${replacement.downloadUrl}`,
  });
  assert.equal(
    replacementStillReferenced.statusCode,
    409,
    replacementStillReferenced.body,
  );
  await app.close();
});

test("draft conflict routes restore or discard exactly one durable asset snapshot", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-conflict-assets-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = new WorkspaceStore(directory);
  const assets = new AssetStore(directory);
  t.after(() => assets.close());
  const drafts = new DraftService(
    directory,
    { getAgent: () => undefined, getConversation: () => ({ id: "chat-a" }) },
    workspace,
    assets,
  );
  const app = Fastify();
  t.after(() => app.close());
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  registerDraftRoutes(app, drafts, workspace, 8, () => undefined);
  const upload = async (name, body) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/conversations/chat-a/draft-attachments",
      headers: {
        "content-type": "application/octet-stream",
        "x-ponderosa-draft-owner": "browser-one",
        "x-ponderosa-filename": name,
        "x-ponderosa-media-type": "text/plain",
      },
      payload: Buffer.from(body),
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  const current = await upload("current.txt", "current bytes");
  const restoreFile = await upload("restore.txt", "restore bytes");
  const restorePaste = await upload("Pasted text.txt", "restore paste");
  const discardFile = await upload("discard.txt", "discard bytes");
  assert.equal((await app.inject({
    method: "PUT",
    url: "/api/conversations/chat-a/draft",
    payload: { ...validDraft, attachmentIds: [current.id] },
  })).statusCode, 200);
  const conflictFor = async (text, attachmentIds, pastedTextAttachmentId) => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/conversations/chat-a/draft",
      payload: {
        ...validDraft,
        text,
        attachmentIds,
        ...(pastedTextAttachmentId ? { pastedTextAttachmentId } : {}),
        clientId: `page:${text}`,
      },
    });
    assert.equal(response.statusCode, 409, response.body);
    return response.json();
  };
  const restoreConflict = await conflictFor(
    "restore snapshot",
    [restoreFile.id],
    restorePaste.id,
  );
  const discardConflict = await conflictFor("discard snapshot", [discardFile.id]);
  const discarded = await app.inject({
    method: "DELETE",
    url: `/api/conversations/chat-a/draft-conflicts/${discardConflict.id}?ownerId=browser-one`,
  });
  assert.equal(discarded.statusCode, 200, discarded.body);
  assert.equal(discarded.json().replayed, false);
  const discardReplay = await app.inject({
    method: "DELETE",
    url: `/api/conversations/chat-a/draft-conflicts/${discardConflict.id}?ownerId=browser-one`,
  });
  assert.equal(discardReplay.statusCode, 200, discardReplay.body);
  assert.equal(discardReplay.json().replayed, true);

  const restored = await app.inject({
    method: "POST",
    url: `/api/conversations/chat-a/draft-conflicts/${restoreConflict.id}/restore`,
    payload: {
      ownerId: "browser-one",
      expectedRevision: 1,
      clientId: "page:restored",
    },
  });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().draft.text, "restore snapshot");
  assert.deepEqual(restored.json().draft.attachmentIds, [restoreFile.id]);
  assert.equal(restored.json().draft.pastedTextAttachmentId, restorePaste.id);
  const restoreReplay = await app.inject({
    method: "POST",
    url: `/api/conversations/chat-a/draft-conflicts/${restoreConflict.id}/restore`,
    payload: {
      ownerId: "browser-one",
      expectedRevision: 0,
      clientId: "ignored-on-replay",
    },
  });
  assert.equal(restoreReplay.statusCode, 200, restoreReplay.body);
  assert.equal(restoreReplay.json().replayed, true);
  await drafts.reconcileAttachmentCleanup(Date.now() + 10 * 60_000);
  assert.equal((await app.inject({ method: "GET", url: current.downloadUrl })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: discardFile.downloadUrl })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: restoreFile.downloadUrl })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: restorePaste.downloadUrl })).statusCode, 200);

  const bounded = [];
  for (let index = 0; index < 21; index += 1) {
    const attachment = await upload(`bounded-${index}.txt`, `bounded ${index}`);
    const conflict = await conflictFor(`bounded ${index}`, [attachment.id]);
    bounded.push({ attachment, conflict });
  }
  const listed = workspace.listDraftConflicts("chat-a", "browser-one").conflicts;
  assert.equal(listed.length, 20);
  assert.equal(listed.some(({ id }) => id === bounded[0].conflict.id), false);
  await drafts.reconcileAttachmentCleanup(Date.now() + 10 * 60_000);
  assert.equal((await app.inject({ method: "GET", url: bounded[0].attachment.downloadUrl })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: bounded.at(-1).attachment.downloadUrl })).statusCode, 200);
});

test("draft conflict restore adopts fresh bytes and leaves unavailable content explicitly failed", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-conflict-restage-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = new WorkspaceStore(directory);
  const assets = new AssetStore(directory);
  t.after(() => assets.close());
  const drafts = new DraftService(
    directory,
    { getAgent: () => undefined, getConversation: () => ({ id: "chat-a" }) },
    workspace,
    assets,
  );
  const app = Fastify();
  t.after(() => app.close());
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" },
    (_request, body, done) => done(null, body));
  registerDraftRoutes(app, drafts, workspace, 8, () => undefined);
  const upload = async (name, body) => {
    const response = await app.inject({
      method: "POST", url: "/api/conversations/chat-a/draft-attachments",
      headers: {
        "content-type": "application/octet-stream",
        "x-ponderosa-draft-owner": "browser-one",
        "x-ponderosa-filename": name,
        "x-ponderosa-media-type": "text/plain",
      },
      payload: Buffer.from(body),
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  assert.equal((await app.inject({
    method: "PUT", url: "/api/conversations/chat-a/draft", payload: validDraft,
  })).statusCode, 200);
  const retained = await upload("retained.txt", "retained bytes");
  const unavailable = await upload("unavailable.txt", "unavailable bytes");
  const lost = await upload("lost.txt", "lost bytes");
  const paste = await upload("Pasted text.txt", "paste bytes");
  const conflictResponse = await app.inject({
    method: "PUT", url: "/api/conversations/chat-a/draft",
    payload: {
      ...validDraft, text: "preserved", attachmentIds: [retained.id, unavailable.id, lost.id],
      pastedTextAttachmentId: paste.id, clientId: "page:stale",
    },
  });
  assert.equal(conflictResponse.statusCode, 409, conflictResponse.body);
  for (const id of [unavailable.id, lost.id, paste.id]) {
    rmSync(drafts.files("chat-a", "browser-one", id).body, { force: true });
  }
  const probe = await app.inject({
    method: "POST",
    url: `/api/conversations/chat-a/draft-conflicts/${conflictResponse.json().id}/restore`,
    payload: {
      ownerId: "browser-one", expectedRevision: 1, clientId: "page:restore",
    },
  });
  assert.equal(probe.statusCode, 409, probe.body);
  assert.deepEqual(probe.json().unavailableAttachmentIds, [
    unavailable.id,
    lost.id,
    paste.id,
  ]);
  const freshFile = await upload("unavailable.txt", "unavailable bytes");
  const partial = await app.inject({
    method: "POST",
    url: `/api/conversations/chat-a/draft-conflicts/${conflictResponse.json().id}/restore`,
    payload: {
      ownerId: "browser-one", expectedRevision: 1, clientId: "page:restore",
      attachmentReplacements: [
        { fromId: unavailable.id, toId: freshFile.id },
      ],
      unavailableAttachmentIds: [lost.id],
    },
  });
  assert.equal(partial.statusCode, 409, partial.body);
  assert.deepEqual(partial.json().unavailableAttachmentIds, [paste.id]);
  assert.equal(
    workspace.listDraftConflicts("chat-a", "browser-one").conflicts.length,
    1,
  );
  const freshPaste = await upload("Pasted text.txt", "paste bytes");
  const restored = await app.inject({
    method: "POST",
    url: `/api/conversations/chat-a/draft-conflicts/${conflictResponse.json().id}/restore`,
    payload: {
      ownerId: "browser-one", expectedRevision: 1, clientId: "page:restore",
      attachmentReplacements: [
        { fromId: unavailable.id, toId: freshFile.id },
        { fromId: paste.id, toId: freshPaste.id },
      ],
      unavailableAttachmentIds: [lost.id],
    },
  });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.deepEqual(restored.json().draft.attachmentIds, [retained.id, freshFile.id]);
  assert.equal(restored.json().draft.pastedTextAttachmentId, freshPaste.id);
  assert.deepEqual(restored.json().attachmentReplacements, [
    { fromId: unavailable.id, toId: freshFile.id },
    { fromId: paste.id, toId: freshPaste.id },
  ]);
  const later = await app.inject({
    method: "PUT",
    url: "/api/conversations/chat-a/draft",
    payload: {
      ...validDraft,
      text: "later edit",
      attachmentIds: restored.json().draft.attachmentIds,
      pastedTextAttachmentId: restored.json().draft.pastedTextAttachmentId,
      expectedRevision: restored.json().draft.revision,
      clientId: "page:later",
    },
  });
  assert.equal(later.statusCode, 200, later.body);
  const replay = await app.inject({
    method: "POST",
    url: `/api/conversations/chat-a/draft-conflicts/${conflictResponse.json().id}/restore`,
    payload: {
      ownerId: "browser-one", expectedRevision: 0, clientId: "lost-response-retry",
    },
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().replayed, true);
  assert.equal(replay.json().draft.text, "preserved");
  assert.deepEqual(replay.json().attachmentReplacements, restored.json().attachmentReplacements);
  assert.deepEqual(replay.json().draft.attachmentIds, restored.json().draft.attachmentIds);
  assert.equal(
    replay.json().draft.pastedTextAttachmentId,
    restored.json().draft.pastedTextAttachmentId,
  );
});

test("durable conflict restore needs no upload capacity", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-conflict-no-upload-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = new WorkspaceStore(directory);
  const assets = new AssetStore(directory);
  t.after(() => assets.close());
  const drafts = new DraftService(
    directory,
    { getAgent: () => undefined, getConversation: () => ({ id: "chat-a" }) },
    workspace,
    assets,
  );
  const app = Fastify();
  t.after(() => app.close());
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" },
    (_request, body, done) => done(null, body));
  registerDraftRoutes(app, drafts, workspace, 8, () => undefined);
  const upload = (index) => app.inject({
    method: "POST",
    url: "/api/conversations/chat-a/draft-attachments",
    headers: {
      "content-type": "application/octet-stream",
      "x-ponderosa-draft-owner": "browser-one",
      "x-ponderosa-filename": `quota-${index}.txt`,
      "x-ponderosa-media-type": "text/plain",
    },
    payload: Buffer.from(`quota ${index}`),
  });
  const retainedResponse = await upload(0);
  assert.equal(retainedResponse.statusCode, 201, retainedResponse.body);
  const retained = retainedResponse.json();
  assert.equal((await app.inject({
    method: "PUT", url: "/api/conversations/chat-a/draft", payload: validDraft,
  })).statusCode, 200);
  const conflict = await app.inject({
    method: "PUT",
    url: "/api/conversations/chat-a/draft",
    payload: {
      ...validDraft,
      text: "restore without upload",
      attachmentIds: [retained.id],
      clientId: "page:stale",
    },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  for (let index = 1; index < 100; index += 1) {
    const response = await upload(index);
    assert.equal(response.statusCode, 201, response.body);
  }
  const exhausted = await upload(100);
  assert.equal(exhausted.statusCode, 429, exhausted.body);
  const restored = await app.inject({
    method: "POST",
    url: `/api/conversations/chat-a/draft-conflicts/${conflict.json().id}/restore`,
    payload: {
      ownerId: "browser-one",
      expectedRevision: 1,
      clientId: "page:restore",
    },
  });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.deepEqual(restored.json().draft.attachmentIds, [retained.id]);
  assert.deepEqual(restored.json().attachmentReplacements, []);
});

test("draft clear survives partial cleanup and restart without deleting current file or paste references", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-cleanup-restart-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let draft = {
    conversationId: "chat-a",
    ownerId: "browser-one",
    text: "",
    attachmentIds: [],
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    clientId: "",
  };
  const workspace = {
    cursor: () => 0,
    getDraft: () => draft,
    listDraftConflicts: () => ({ conversationId: "chat-a", conflicts: [] }),
    putDraft: (_id, input) => {
      draft = {
        conversationId: "chat-a",
        ownerId: input.ownerId,
        text: input.text,
        attachmentIds: input.attachmentIds,
        ...(input.pastedTextAttachmentId
          ? { pastedTextAttachmentId: input.pastedTextAttachmentId }
          : {}),
        mentionBindings: input.mentionBindings,
        revision: draft.revision + 1,
        updatedAt: new Date().toISOString(),
        clientId: input.clientId,
      };
      return draft;
    },
  };
  const store = {
    getAgent: () => undefined,
    getConversation: () => ({ id: "chat-a" }),
  };
  let assets = new AssetStore(directory);
  let drafts = new DraftService(directory, store, workspace, assets);
  const app = Fastify();
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  registerDraftRoutes(app, drafts, workspace, 8, () => undefined);
  const upload = async (name, body) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/conversations/chat-a/draft-attachments",
      headers: {
        "content-type": "application/octet-stream",
        "x-ponderosa-draft-owner": "browser-one",
        "x-ponderosa-filename": name,
        "x-ponderosa-media-type": "text/plain",
      },
      payload: Buffer.from(body),
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  const file = await upload("file.txt", "file body");
  const paste = await upload("Pasted text.txt", "paste body");
  const saved = await app.inject({
    method: "PUT",
    url: "/api/conversations/chat-a/draft",
    payload: {
      ...validDraft,
      attachmentIds: [file.id],
      pastedTextAttachmentId: paste.id,
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const late = await upload("late.txt", "late body");
  assert.equal(await drafts.reconcileAttachmentCleanup(Date.now() + 10 * 60_000), 1);
  assert.equal((await app.inject({ method: "GET", url: file.downloadUrl })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: paste.downloadUrl })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: late.downloadUrl })).statusCode, 404);

  const obstruction = drafts.files("chat-a", "browser-one", file.id).preview;
  mkdirSync(obstruction);
  const cleared = await app.inject({
    method: "PUT",
    url: "/api/conversations/chat-a/draft",
    payload: {
      ...validDraft,
      expectedRevision: 1,
      clientId: "page:clear",
    },
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  await new Promise(resolve => setImmediate(resolve));
  await app.close();
  assets.close();

  rmSync(obstruction, { recursive: true, force: true });
  assets = new AssetStore(directory);
  drafts = new DraftService(directory, store, workspace, assets);
  t.after(() => assets.close());
  assert.equal(await drafts.reconcileAttachmentCleanup(), 2);
  assert.equal(existsSync(drafts.files("chat-a", "browser-one", file.id).metadata), false);
  assert.equal(existsSync(drafts.files("chat-a", "browser-one", paste.id).metadata), false);
});

test("malformed draft PUTs return 400 before reaching persistence", async () => {
  const app = Fastify();
  const workspace = {
    cursor: () => 0,
    getDraft: () => undefined,
    listDraftConflicts: () => [],
    putDraft: () => assert.fail("malformed input reached persistence"),
  };
  registerDraftRoutes(
    app,
    new DraftService(
      "/unused",
      { getAgent: () => undefined, getConversation: () => ({ id: "chat-a" }) },
      workspace,
      noCleanup,
    ),
    workspace,
    8,
    () => undefined,
  );
  for (const payload of [
    { ...validDraft, clientId: 42 },
    { ...validDraft, text: { malformed: true } },
    { ...validDraft, attachmentIds: [42] },
  ]) {
    const response = await app.inject({
      method: "PUT",
      url: "/api/conversations/chat-a/draft",
      payload,
    });
    assert.equal(response.statusCode, 400, response.body);
  }
  await app.close();
});

test("stale file and paste references reach conflict recovery before asset validation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-stale-draft-assets-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = new WorkspaceStore(directory);
  workspace.putDraft("chat-a", {
    text: "newer tab",
    attachmentIds: [],
    mentionBindings: [],
    expectedRevision: 0,
    clientId: "page:newer",
    ownerId: "browser-one",
  });
  const app = Fastify();
  registerDraftRoutes(
    app,
    new DraftService(
      directory,
      { getAgent: () => undefined, getConversation: () => ({ id: "chat-a" }) },
      workspace,
      noCleanup,
    ),
    workspace,
    8,
    () => undefined,
  );
  const missingFileId = "00000000-0000-4000-8000-000000000001";
  const missingPasteId = "00000000-0000-4000-8000-000000000002";
  for (const references of [
    { attachmentIds: [missingFileId] },
    { attachmentIds: [], pastedTextAttachmentId: missingPasteId },
  ]) {
    const response = await app.inject({
      method: "PUT",
      url: "/api/conversations/chat-a/draft",
      payload: {
        ...validDraft,
        ...references,
        text: "preserve my stale bytes",
        clientId: "page:stale",
      },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().current.text, "newer tab");
    assert.deepEqual(response.json().displaced.attachmentIds, references.attachmentIds);
    assert.equal(
      response.json().displaced.pastedTextAttachmentId,
      references.pastedTextAttachmentId,
    );
  }
  const currentMissingAsset = await app.inject({
    method: "PUT",
    url: "/api/conversations/chat-a/draft",
    payload: {
      ...validDraft,
      attachmentIds: [missingFileId],
      expectedRevision: 1,
      clientId: "page:current",
    },
  });
  assert.equal(currentMissingAsset.statusCode, 400, currentMissingAsset.body);
  await app.close();
});

for (const draftId of ["chat-a", "agent:agent-a"]) {
  test(`${draftId} draft PUT and upload cannot cross its deletion fence`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-deletion-race-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let entityExists = true;
    const store = {
      getConversation: id => entityExists && draftId === "chat-a" && id === draftId
        ? { id }
        : undefined,
      getAgent: id => entityExists && draftId === `agent:${id}` ? { id } : undefined,
    };
    const workspace = new WorkspaceStore(directory);
    const drafts = new DraftService(directory, store, workspace, noCleanup);
    const app = Fastify();
    t.after(() => app.close());
    app.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    registerDraftRoutes(app, drafts, workspace, 8, () => undefined);
    const baseUrl = `/api/conversations/${encodeURIComponent(draftId)}`;
    const uploaded = await app.inject({
      method: "POST",
      url: `${baseUrl}/draft-attachments`,
      headers: {
        "content-type": "application/octet-stream",
        "x-ponderosa-draft-owner": "browser-one",
        "x-ponderosa-filename": "note.txt",
        "x-ponderosa-media-type": "text/plain",
      },
      payload: Buffer.from("draft bytes"),
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const attachment = uploaded.json();

    const readStarted = deferred();
    const finishRead = deferred();
    const originalRead = drafts.read.bind(drafts);
    let paused = false;
    drafts.read = async (...args) => {
      if (!paused && args[2] === attachment.id) {
        paused = true;
        readStarted.resolve();
        await finishRead.promise;
      }
      return originalRead(...args);
    };
    const save = app.inject({
      method: "PUT",
      url: `${baseUrl}/draft`,
      payload: { ...validDraft, attachmentIds: [attachment.id] },
    });
    await readStarted.promise;
    let fenceSettled = false;
    const fence = drafts.fenceMutations([draftId]).then(release => {
      fenceSettled = true;
      return release;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fenceSettled, false);
    finishRead.resolve();
    assert.equal((await save).statusCode, 200);
    const releaseFence = await fence;

    entityExists = false;
    workspace.deleteDraft(draftId);
    await drafts.deleteSurface(draftId);
    const blockedUpload = await app.inject({
      method: "POST",
      url: `${baseUrl}/draft-attachments`,
      headers: {
        "content-type": "application/octet-stream",
        "x-ponderosa-draft-owner": "browser-one",
        "x-ponderosa-filename": "late.txt",
        "x-ponderosa-media-type": "text/plain",
      },
      payload: Buffer.from("late bytes"),
    });
    assert.equal(blockedUpload.statusCode, 404, blockedUpload.body);
    releaseFence();

    assert.equal(workspace.getDraft(draftId, "browser-one").text, "");
    assert.equal(existsSync(drafts.surfaceDir(draftId)), false);
    const lateSave = await app.inject({
      method: "PUT",
      url: `${baseUrl}/draft`,
      payload: validDraft,
    });
    assert.equal(lateSave.statusCode, 404, lateSave.body);
    assert.equal(existsSync(drafts.surfaceDir(draftId)), false);
  });
}
