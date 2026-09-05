import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INLINE_TEXT_MAX_CODE_POINTS } from "@ponderosa/core";
import Fastify from "fastify";
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
    pastedTextAttachmentId: "paste-a",
  }, 8), undefined);
  assert.ok(draftUpdateBodyError({
    ...validDraft,
    attachmentIds: ["paste-a"],
    pastedTextAttachmentId: "paste-a",
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

test("draft routes hydrate a separate durable pasted-text asset", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-paste-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = Fastify();
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
    listDraftConflicts: () => [],
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
  await app.close();
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
