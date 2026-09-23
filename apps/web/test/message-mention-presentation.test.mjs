import assert from "node:assert/strict";
import test from "node:test";
import { resolveMessageMentionText } from "../src/components/chat/messageMentionPresentation.js";

const renamedAgent = {
  projectId: "project-a",
  handle: "Carlsbad",
  agentId: "agent-a",
  currentHandle: "Redwood",
  currentTitle: "Redwood",
};

test("numeric PR and issue references remain literal", () => {
  assert.equal(
    resolveMessageMentionText("Implemented in PR #18; follow-up issue #301.", []),
    "Implemented in PR #18; follow-up issue #301.",
  );
});

test("unbound hashtags remain literal instead of implying an unavailable Agent", () => {
  assert.equal(
    resolveMessageMentionText("Discuss #reliability with #user", []),
    "Discuss #reliability with #user",
  );
});

test("durably bound Agent mentions still resolve to their current handle", () => {
  assert.equal(
    resolveMessageMentionText("Ask #Carlsbad about PR #18.", [renamedAgent]),
    "Ask #Redwood about PR #18.",
  );
});
