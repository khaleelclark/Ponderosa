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
