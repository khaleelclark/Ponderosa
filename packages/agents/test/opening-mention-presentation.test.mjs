import assert from "node:assert/strict";
import test from "node:test";
import { communicationMentionBindings } from "../dist/store-mention-bindings.js";

test("creation tag resolves only the exact opening identity without rewriting communication", () => {
  const event = { eventId: "agent-opening:boston", projectId: "project", intent: "broadcast",
    sender: { kind: "user" }, audience: { kind: "organization", organizationId: "project" }, text: "hi #new-agent" };
  const agent = { id: "boston", projectId: "project", handle: "Boston", title: "Boston" };
  const getAgent = id => id === agent.id ? agent : undefined;
  assert.deepEqual(communicationMentionBindings(event.text, event, getAgent), [{
    projectId: "project", agentId: "boston", handle: "new-agent", currentHandle: "Boston", currentTitle: "Boston",
  }]);
  assert.equal(event.text, "hi #new-agent");
  assert.equal(communicationMentionBindings("hi", event, getAgent)[0].currentHandle, "Boston", "implicit creation also has display identity");
  agent.handle = "Renamed-Boston";
  assert.equal(communicationMentionBindings(event.text, event, getAgent)[0].currentHandle, "Renamed-Boston");
  assert.deepEqual(communicationMentionBindings(event.text, { ...event, eventId: "ordinary-event" }, getAgent), []);
  assert.deepEqual(communicationMentionBindings(event.text, event, () => undefined), [], "deleted identity stays an inert pending tag");
  assert.deepEqual(communicationMentionBindings(event.text, event, () => ({ ...agent, projectId: "other" })), []);
  assert.deepEqual(communicationMentionBindings("hi #new-agent", { ...event, eventId: "agent-opening:wrong" }, getAgent), []);
});
