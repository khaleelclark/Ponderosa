import assert from "node:assert/strict";
import test from "node:test";
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
