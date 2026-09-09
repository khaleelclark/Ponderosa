import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerSearchRoutes } from "../dist/routes/search.js";

test("All Messages batches and returns canonical delivery receipts", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const items = ["event-a", "event-b"].map((communicationEventId) => ({
    communicationEventId,
    messageId: communicationEventId,
    communicationIntent: "user_dm",
    project: { id: "project-a", label: "Project" },
    source: { kind: "project", conversationId: "chat-a", title: "Chat" },
    author: { kind: "user", label: "User" },
    text: communicationEventId,
    createdAt: "2026-09-09T12:00:00.000Z",
  }));
  const calls = [];
  registerSearchRoutes(app, {
    globalChatSearch: () => ({ items: [], history: { limit: 50, hasMore: false } }),
    store: {
      getAllChatPage: () => ({
        items,
        history: { limit: 50, hasMore: false },
      }),
      getCommunicationEvent: () => undefined,
      listAgents: () => [],
    },
    workspace: {
      listDecisionEventPage: () => ({ events: [], hasMore: false }),
    },
    coordinationV3: {
      deliveryReceiptsForCommunications: (projectId, eventIds) => {
        calls.push({ projectId, eventIds });
        return new Map(eventIds.map((eventId) => [eventId, [{
          activationId: `activation-${eventId}`,
          targetAgentId: "agent-a",
          executionId: `execution-${eventId}`,
          state: "started",
          updatedAt: "2026-09-09T12:00:01.000Z",
          attemptCount: 1,
        }]]));
      },
    },
  });
  const response = await app.inject({ method: "GET", url: "/api/all-chat" });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(calls, [{
    projectId: "project-a",
    eventIds: ["event-a", "event-b"],
  }]);
  assert.deepEqual(response.json().items.map((item) => ({
    eventId: item.communicationEventId,
    executionId: item.deliveryReceipts?.[0]?.executionId,
  })), [
    { eventId: "event-a", executionId: "execution-event-a" },
    { eventId: "event-b", executionId: "execution-event-b" },
  ]);
});
