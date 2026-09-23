import assert from "node:assert/strict";
import test from "node:test";
import { replaceCachedConversationAgent } from "../src/conversationAgentCache.js";
import { runtimeSelectionAfterChange } from "../src/conversationEngine.js";

const engine = {
  id: "codex",
  displayName: "Codex",
  models: [
    {
      id: "first",
      label: "First",
      efforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }],
      defaultEffort: "low",
      serviceTiers: [{ id: "priority", label: "Fast" }],
    },
    {
      id: "second",
      label: "Second",
      efforts: [{ id: "medium", label: "Medium" }, { id: "high", label: "High" }],
      defaultEffort: "medium",
      serviceTiers: [{ id: "priority", label: "Fast" }],
    },
  ],
  efforts: [],
  defaultModel: "first",
  configured: true,
  authentication: "authenticated",
  intakeReady: true,
  reachability: "reachable",
};

test("changing models preserves compatible reasoning and speed", () => {
  assert.deepEqual(
    runtimeSelectionAfterChange(
      engine,
      undefined,
      undefined,
      { model: "first", effort: "high", speed: "priority" },
      { model: "second" },
    ),
    { model: "second", effort: "high", speed: "priority" },
  );
});

test("Agent cache refresh ignores non-conversation records sharing the prefix", () => {
  const receiptCache = { items: [{ activationId: "activation-1" }] };
  const updated = { id: "agent-1", title: "Pine" };
  assert.equal(replaceCachedConversationAgent(receiptCache, updated), receiptCache);

  const detail = { agents: [{ id: "agent-1", title: "Old" }, { id: "agent-2", title: "Other" }] };
  assert.deepEqual(replaceCachedConversationAgent(detail, updated), {
    agents: [updated, { id: "agent-2", title: "Other" }],
  });
});
