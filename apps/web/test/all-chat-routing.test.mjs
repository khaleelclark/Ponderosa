import assert from "node:assert/strict";
import test from "node:test";
import {
  eligibleAllChatTargets,
  parseAllChatReplyTarget,
} from "../src/components/allChatRouting.js";
import {
  clampComposerMenuIndex,
  hasComposerDestination,
  selectExclusiveNewAgentDestination,
} from "../src/components/chat/composerDestination.js";

const bryce = {
  id: "bryce",
  title: "Bryce Canyon",
  handle: "Bryce-Canyon",
  projectId: "project-a",
  conversationId: "chat-a",
};

test("restores only a complete stable All Messages recipient", () => {
  assert.deepEqual(parseAllChatReplyTarget(JSON.stringify(bryce)), bryce);
  assert.equal(parseAllChatReplyTarget('{"id":"bryce"}'), undefined);
  assert.equal(parseAllChatReplyTarget(JSON.stringify({ ...bryce, id: "" })), undefined);
  assert.equal(parseAllChatReplyTarget("not json"), undefined);
});

test("locks later recipients to the first Agent's Chat", () => {
  const sameChat = { ...bryce, id: "ui", handle: "UI-Specialist" };
  const otherChat = { ...bryce, id: "saint", handle: "Saint-Croix", conversationId: "chat-b" };
  assert.deepEqual(
    eligibleAllChatTargets([bryce, sameChat, otherChat], "chat-a"),
    [bryce, sameChat],
  );
});

test("new Agent selection removes existing recipient destinations", () => {
  assert.equal(
    selectExclusiveNewAgentDestination(
      "#Bryce-Canyon ask #UI-Specialist now #",
      37,
      38,
      ["Bryce-Canyon", "UI-Specialist"],
    ),
    "ask now #new-agent ",
  );
});

test("recognizes an authored new Agent destination", () => {
  assert.equal(
    hasComposerDestination("#new-agent take this over", "new-agent"),
    true,
  );
  assert.equal(
    hasComposerDestination("continue with #new-agent.", "new-agent"),
    true,
  );
});

test("keeps autocomplete selection within a live suggestion list", () => {
  assert.equal(clampComposerMenuIndex(4, 2), 1);
  assert.equal(clampComposerMenuIndex(1, 2), 1);
  assert.equal(clampComposerMenuIndex(4, 0), 0);
});
