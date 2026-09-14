import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { pendingAgentQuarantine } from "../dist/routes/pending-agent-quarantine.js";

const pendingId = "00000000-0000-4000-8000-000000000001";

test("pending Agent quarantine covers path, query, body, and compound references", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.addHook("preHandler", pendingAgentQuarantine({
    agentCreationPending: (agentId) => agentId === pendingId,
  }));
  app.get("/agents/:id", async () => ({ ok: true }));
  app.get("/capabilities", async () => ({ ok: true }));
  app.get("/conversations/:id/draft", async () => ({ ok: true }));
  app.post("/deliver", async () => ({ ok: true }));

  for (const request of [
    { method: "GET", url: `/agents/${pendingId}` },
    { method: "GET", url: `/capabilities?agentId=${pendingId}` },
    { method: "GET", url: `/conversations/agent:${pendingId}/draft` },
    { method: "POST", url: "/deliver", payload: { recipients: [{ agentId: pendingId }] } },
    { method: "POST", url: "/deliver", payload: { rootAgentIds: [pendingId] } },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 404, `${request.method} ${request.url}`);
    assert.deepEqual(response.json(), { error: "agent not found" });
  }

  assert.equal((await app.inject({
    method: "POST",
    url: "/deliver",
    payload: { text: "ordinary request", recipientAgentIds: ["visible-agent"] },
  })).statusCode, 200);
});
