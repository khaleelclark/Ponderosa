import assert from "node:assert/strict";
import test from "node:test";
import { workspaceAgentEventCategory } from "../dist/notification-routing.js";
import { createAgentEventService } from "../dist/agent-event-service.js";

test("workspace publishes metadata-only public progress, never raw commentary or reasoning", () => {
  const published = [];
  const service = createAgentEventService({ store: { getAgent: () => ({ id: "a", projectId: "p", conversationId: "c" }) },
    subscribers: new Map(), appendWorkspace: event => published.push(event) });
  for (const event of [
    { type: "text", delta: "ordinary" }, { type: "reasoning", delta: "PRIVATE" },
    { type: "text", delta: "public", presentation: "progress", progressInjectionId: "injection", executionId: "run" },
  ]) service.publish("a", { seq: 5, event });
  assert.deepEqual(published, [{ type: "agent_event", projectId: "p", agentId: "a", conversationIds: ["c"],
    seq: 5, eventType: "text", category: "progress", executionId: "run" }]);
  assert.equal(workspaceAgentEventCategory({ type: "text", delta: "anything" }), undefined);
});
