import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerAgentAuditRoutes } from "../dist/routes/agent-audit.js";

const detail = {
  agent: {
    id: "agent-a",
    projectId: "project-a",
    conversationId: "chat-a",
    title: "Agent A",
  },
  messages: [],
  runOutput: [],
  activity: [],
  changedFiles: [],
  runs: [],
  workItems: [],
  artifacts: [],
  state: "idle",
};

test("Agent detail projects the exact owner Chat for paged and filtered sidebar fallbacks", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  registerAgentAuditRoutes(app, {
    agentDetail: () => detail,
    store: {
      agentCreationPending: () => false,
      getConversation: id => id === "chat-a"
        ? { id, title: "Backend", projectId: "project-a" }
        : undefined,
    },
  });

  const response = await app.inject({ method: "GET", url: "/api/agents/agent-a?limit=1" });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().ownerConversation, { id: "chat-a", title: "Backend" });
});

test("Agent detail omits owner Chat only when it is canonically missing", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  registerAgentAuditRoutes(app, {
    agentDetail: () => detail,
    store: {
      agentCreationPending: () => false,
      getConversation: () => undefined,
    },
  });

  const response = await app.inject({ method: "GET", url: "/api/agents/agent-a?limit=1" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal("ownerConversation" in response.json(), false);
});
