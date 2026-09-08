import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspaceStore } from "../dist/index.js";

test("conversation drafts retain stable mention bindings after restart", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-binding-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const mentionBindings = [{
    projectId: "project-a",
    agentId: "agent-a",
    handle: "old-name",
    currentHandle: "old-name",
    currentTitle: "Old Name",
  }];
  const store = new WorkspaceStore(directory);
  store.putDraft("chat-a", {
    ownerId: "browser-a",
    text: "#old-name continue",
    attachmentIds: [],
    pastedTextAttachmentId: "paste-a",
    mentionBindings,
    expectedRevision: 0,
    clientId: "page:a",
  });

  const restored = new WorkspaceStore(directory).getDraft(
    "chat-a",
    "browser-a",
  );
  assert.deepEqual(restored.mentionBindings, mentionBindings);
  assert.equal(restored.pastedTextAttachmentId, "paste-a");
});

test("pending send authority survives restart, conflict restore, and authoritative clear", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-send-authority-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pendingSubmission = {
    fingerprint: "a".repeat(64),
    intentFingerprint: "b".repeat(64),
    idempotencyKey: "send-a",
    agentTitle: "Bryce Canyon",
    uploads: [{
      scope: "direct",
      recipients: [{ agentId: "agent-a", attachmentIds: ["asset-a"] }],
    }],
  };
  let store = new WorkspaceStore(directory);
  const pending = store.putDraft("chat-a", {
    ownerId: "browser-a",
    text: "send once",
    attachmentIds: ["draft-a"],
    pendingSubmission,
    expectedRevision: 0,
    clientId: "page:browser-a:draft:first",
  });
  store = new WorkspaceStore(directory);
  assert.deepEqual(
    store.getDraft("chat-a", "browser-a").pendingSubmission,
    pendingSubmission,
  );
  assert.deepEqual(store.draftRecoveryInventory()[0].pendingUploads, [{
    agentId: "agent-a",
    attachmentIds: ["asset-a"],
  }]);
  const displacedSubmission = {
    fingerprint: "c".repeat(64),
    intentFingerprint: "d".repeat(64),
    idempotencyKey: "send-b",
    uploads: [{
      scope: "broadcast",
      recipients: [{ agentId: "agent-b", attachmentIds: ["asset-b"] }],
    }],
  };
  let conflict;
  assert.throws(() => store.putDraft("chat-a", {
    ownerId: "browser-a",
    text: "send once",
    attachmentIds: ["draft-a"],
    pendingSubmission: displacedSubmission,
    expectedRevision: 0,
    clientId: "page:browser-a:draft:stale",
  }), error => {
    conflict = error.conflict;
    return error?.code === "DRAFT_CONFLICT";
  });
  assert.deepEqual(store.draftRecoveryInventory()[0].pendingUploads, [
    { agentId: "agent-a", attachmentIds: ["asset-a"] },
    { agentId: "agent-b", attachmentIds: ["asset-b"] },
  ]);
  const restored = store.restoreDraftConflict({
    conversationId: "chat-a",
    ownerId: "browser-a",
    conflictId: conflict.id,
    expectedRevision: pending.revision,
    clientId: "page:browser-a:draft:restored",
  }).draft;
  assert.deepEqual(restored.pendingSubmission, displacedSubmission);
  const cleared = store.putDraft("chat-a", {
    ownerId: "browser-a",
    text: "",
    attachmentIds: [],
    expectedRevision: restored.revision,
    clientId: "page:browser-a:draft:restored",
  });
  assert.equal(cleared.pendingSubmission, undefined);
});

test("draft incarnation fencing rejects delayed writes and clears after A to B to A", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-incarnation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  const oldIncarnation = "page:browser-a:draft:visit-one";
  const newIncarnation = "page:browser-a:draft:visit-two";

  const initial = store.putDraft("chat-a", {
    ownerId: "browser-a",
    text: "submitted draft",
    attachmentIds: [],
    expectedRevision: 0,
    clientId: oldIncarnation,
  });
  const current = store.putDraft("chat-a", {
    ownerId: "browser-a",
    text: "new draft after returning to A",
    attachmentIds: [],
    expectedRevision: initial.revision,
    clientId: newIncarnation,
  });

  for (const text of [
    "delayed old write",
    "new draft after returning to A",
    "",
  ]) {
    assert.throws(
      () => store.putDraft("chat-a", {
        ownerId: "browser-a",
        text,
        attachmentIds: [],
        expectedRevision: initial.revision,
        clientId: oldIncarnation,
      }),
      error => error?.code === "DRAFT_CONFLICT",
    );
    assert.equal(store.getDraft("chat-a", "browser-a").text, current.text);
    assert.equal(store.getDraft("chat-a", "browser-a").revision, current.revision);
  }
});

test("only incarnation-shaped IDs receive same-chain revision recovery", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-compatibility-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  const incarnation = "page:browser-a:draft:visit-one";
  store.putDraft("chat-a", {
    ownerId: "browser-a",
    text: "first",
    attachmentIds: [],
    expectedRevision: 0,
    clientId: incarnation,
  });
  const recovered = store.putDraft("chat-a", {
    ownerId: "browser-a",
    text: "recovered after a lost response",
    attachmentIds: [],
    expectedRevision: 0,
    clientId: incarnation,
  });
  assert.equal(recovered.text, "recovered after a lost response");

  const legacyStore = new WorkspaceStore(directory);
  legacyStore.putDraft("chat-b", {
    ownerId: "browser-a",
    text: "legacy current data",
    attachmentIds: [],
    expectedRevision: 0,
    clientId: "page:legacy",
  });
  assert.throws(
    () => legacyStore.putDraft("chat-b", {
      ownerId: "browser-a",
      text: "unsafe legacy fast-forward",
      attachmentIds: [],
      expectedRevision: 0,
      clientId: "page:legacy",
    }),
    error => error?.code === "DRAFT_CONFLICT",
  );
  assert.equal(
    legacyStore.getDraft("chat-b", "browser-a").text,
    "legacy current data",
  );
});

test("draft conflicts keep stable IDs and resolve one snapshot idempotently across restart", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-conflict-resolution-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new WorkspaceStore(directory);
  const current = store.putDraft("chat-a", {
    ownerId: "browser-a",
    text: "current",
    attachmentIds: ["current-file"],
    expectedRevision: 0,
    clientId: "page:browser-a:draft:current",
  });
  const stale = {
    ownerId: "browser-a",
    text: "restore me",
    attachmentIds: ["stale-file"],
    pastedTextAttachmentId: "stale-paste",
    mentionBindings: [{
      projectId: "project-a",
      agentId: "agent-a",
      handle: "agent-a",
      currentHandle: "agent-a",
      currentTitle: "Agent A",
    }],
    expectedRevision: 0,
    clientId: "page:browser-a:draft:stale",
  };
  let firstConflict;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(
      () => store.putDraft("chat-a", stale),
      error => {
        assert.equal(error?.code, "DRAFT_CONFLICT");
        firstConflict ??= error.conflict;
        assert.equal(error.conflict.id, firstConflict.id);
        return true;
      },
    );
  }
  assert.equal(store.listDraftConflicts("chat-a", "browser-a").conflicts.length, 1);

  const newer = store.putDraft("chat-a", {
    ownerId: "browser-a",
    text: "newer current",
    attachmentIds: [],
    expectedRevision: current.revision,
    clientId: "page:browser-a:draft:newer",
  });
  let secondConflict;
  assert.throws(
    () => store.putDraft("chat-a", {
      ...stale,
      text: "discard me",
      clientId: "page:browser-a:draft:other-stale",
    }),
    error => {
      secondConflict = error.conflict;
      return error?.code === "DRAFT_CONFLICT";
    },
  );
  assert.notEqual(secondConflict.id, firstConflict.id);
  assert.deepEqual(
    store.discardDraftConflict({
      conversationId: "chat-a",
      ownerId: "browser-a",
      conflictId: secondConflict.id,
    }),
    { replayed: false },
  );
  assert.deepEqual(
    store.discardDraftConflict({
      conversationId: "chat-a",
      ownerId: "browser-a",
      conflictId: secondConflict.id,
    }),
    { replayed: true },
  );
  assert.deepEqual(
    store.listDraftConflicts("chat-a", "browser-a").conflicts.map(({ id }) => id),
    [firstConflict.id],
  );

  const restored = store.restoreDraftConflict({
    conversationId: "chat-a",
    ownerId: "browser-a",
    conflictId: firstConflict.id,
    expectedRevision: newer.revision,
    clientId: "page:browser-a:draft:restored",
    attachmentIds: ["fresh-file"],
    pastedTextAttachmentId: "fresh-paste",
    attachmentReplacements: [
      { fromId: "stale-file", toId: "fresh-file" },
      { fromId: "stale-paste", toId: "fresh-paste" },
    ],
    unavailableAttachmentIds: [],
  });
  assert.equal(restored.replayed, false);
  assert.equal(restored.draft.text, stale.text);
  assert.deepEqual(restored.draft.attachmentIds, ["fresh-file"]);
  assert.equal(restored.draft.pastedTextAttachmentId, "fresh-paste");
  assert.deepEqual(restored.draft.mentionBindings, stale.mentionBindings);
  assert.equal(store.listDraftConflicts("chat-a", "browser-a").conflicts.length, 0);

  store = new WorkspaceStore(directory);
  assert.deepEqual(store.getDraft("chat-a", "browser-a"), restored.draft);
  const later = store.putDraft("chat-a", {
    ownerId: "browser-a",
    text: "later canonical",
    attachmentIds: [],
    expectedRevision: restored.draft.revision,
    clientId: "page:browser-a:draft:later",
  });
  store = new WorkspaceStore(directory);
  const cursorBeforeReplay = store.cursor();
  assert.deepEqual(store.restoreDraftConflict({
    conversationId: "chat-a",
    ownerId: "browser-a",
    conflictId: firstConflict.id,
    expectedRevision: 0,
    clientId: "ignored-on-replay",
  }), {
    draft: restored.draft,
    replayed: true,
    attachmentReplacements: [
      { fromId: "stale-file", toId: "fresh-file" },
      { fromId: "stale-paste", toId: "fresh-paste" },
    ],
    unavailableAttachmentIds: [],
  });
  assert.deepEqual(store.getDraft("chat-a", "browser-a"), later);
  assert.equal(store.cursor(), cursorBeforeReplay);
  assert.throws(
    () => store.discardDraftConflict({
      conversationId: "chat-a",
      ownerId: "browser-a",
      conflictId: firstConflict.id,
    }),
    error => error?.code === "DRAFT_CONFLICT_RESOLUTION_CONFLICT",
  );
});

test("a newer stale write supersedes only its own client incarnation across restart", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-conflict-supersession-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new WorkspaceStore(directory);
  const current = store.putDraft("chat-a", {
    ownerId: "browser-a", text: "current", attachmentIds: [], expectedRevision: 0,
    clientId: "page:browser-a:draft:current",
  });
  const conflict = (clientId, text, attachmentId) => {
    try {
      store.putDraft("chat-a", {
        ownerId: "browser-a", text, attachmentIds: [attachmentId], expectedRevision: 0, clientId,
      });
    } catch (error) {
      assert.equal(error?.code, "DRAFT_CONFLICT");
      return error;
    }
    assert.fail("expected a draft conflict");
  };
  const first = conflict("page:browser-a:draft:stale", "first", "first-file");
  const other = conflict("page:browser-a:draft:other", "other", "other-file");
  store.putDraft("chat-a", {
    ownerId: "browser-a", text: "new current", attachmentIds: [],
    expectedRevision: current.revision, clientId: "page:browser-a:draft:current-2",
  });
  const replacement = conflict("page:browser-a:draft:stale", "replacement", "replacement-file");
  assert.deepEqual(replacement.supersededConflicts.map(item => item.id), [first.conflict.id]);
  assert.deepEqual(
    store.listDraftConflicts("chat-a", "browser-a").conflicts.map(item => item.id),
    [other.conflict.id, replacement.conflict.id],
  );
  store = new WorkspaceStore(directory);
  assert.deepEqual(
    store.listDraftConflicts("chat-a", "browser-a").conflicts.map(item => item.id),
    [other.conflict.id, replacement.conflict.id],
  );
  const replay = conflict(
    "page:browser-a:draft:stale",
    "replacement",
    "replacement-file",
  );
  assert.equal(replay.conflict.id, replacement.conflict.id);
  assert.deepEqual(replay.supersededConflicts.map(item => item.id), [first.conflict.id]);
  assert.deepEqual(store.discardDraftConflict({
    conversationId: "chat-a", ownerId: "browser-a", conflictId: first.conflict.id,
  }), { replayed: true });
});
