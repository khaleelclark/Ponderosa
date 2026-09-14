import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { CoordinationIdempotencyConflictError } from "@ponderosa/agents";
import { registerProviderCommandRoutes } from "../dist/routes/provider-commands.js";

test("Stop maps idempotency reuse for a different Run to 409", async (t) => {
  const app = Fastify();
  registerProviderCommandRoutes(app, {
    coordinationV3: {
      cancelAgentRun() {
        throw new CoordinationIdempotencyConflictError();
      },
    },
    activeRuns: new Map(),
    serverContext: { store: {} },
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/agents/agent-a/cancel",
    payload: { targetRunId: "run-two", idempotencyKey: "run-one-key" },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(response.json(), {
    error: "the cancellation key belongs to a different Run",
    cancelled: false,
    replayed: false,
  });
});
