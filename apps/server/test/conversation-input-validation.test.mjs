import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  conversationMutationBodyError,
  registerConversationRoutes,
} from "../dist/routes/conversations.js";

test("rejects malformed and empty Chat mutation bodies", () => {
  for (const body of [undefined, null, "bad", [], {}]) {
    assert.ok(conversationMutationBodyError(body, "create"));
    assert.ok(conversationMutationBodyError(body, "patch"));
  }
});

test("accepts only exact typed Chat create fields", () => {
  assert.equal(
    conversationMutationBodyError({ title: "UI", defaultEngine: "codex" }, "create"),
    undefined,
  );
  assert.equal(
    conversationMutationBodyError({ title: 42 }, "create"),
    "title must be a string",
  );
  assert.equal(
    conversationMutationBodyError({ archived: false }, "create"),
    "unknown field: archived",
  );
});

test("accepts nullable runtime fields and a boolean archive patch", () => {
  assert.equal(
    conversationMutationBodyError(
      { title: "UI", defaultEngine: null, defaultModel: null, archived: false },
      "patch",
    ),
    undefined,
  );
  assert.equal(
    conversationMutationBodyError({ archived: "false" }, "patch"),
    "archived must be a boolean",
  );
  assert.equal(
    conversationMutationBodyError({ title: null }, "patch"),
    "title must be a string",
  );
  assert.equal(
    conversationMutationBodyError({ extra: true }, "patch"),
    "unknown field: extra",
  );
});

test("malformed public Chat mutations return 400 instead of reaching stores", async () => {
  const app = Fastify();
  registerConversationRoutes(app, {});
  for (const request of [
    { method: "POST", url: "/api/projects/project-a/conversations", payload: {} },
    { method: "POST", url: "/api/projects/project-a/conversations", payload: { title: 42 } },
    { method: "PATCH", url: "/api/conversations/chat-a", payload: null },
    { method: "PATCH", url: "/api/conversations/chat-a", payload: { archived: "false" } },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 400, response.body);
  }
  await app.close();
});
