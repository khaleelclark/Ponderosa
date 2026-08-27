import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_API_ROUTES,
  agentApiAudience,
  isAgentToolRoute,
} from "../dist/agent-tool-route-classification.js";

test("agent capabilities cannot cross the operator route boundary", () => {
  assert.equal(agentApiAudience("/api/agent-messages?run=current"), "agent");
  assert.equal(agentApiAudience("/api/agent-documents/document-id"), "agent");
  assert.equal(agentApiAudience("/api/agent-presets/preset-id"), "operator");
  assert.equal(agentApiAudience("/api/agent-messages/extra"), undefined);
  assert.equal(agentApiAudience("/api/agent-documents"), undefined);
  assert.equal(agentApiAudience("/api/agent-unknown"), undefined);
  assert.equal(isAgentToolRoute("/api/agent-presets/preset-id"), false);
});

test("agent route classifications are unambiguous", () => {
  const identities = AGENT_API_ROUTES.map(({ path, match }) => `${match}:${path}`);
  assert.equal(new Set(identities).size, identities.length);
});
