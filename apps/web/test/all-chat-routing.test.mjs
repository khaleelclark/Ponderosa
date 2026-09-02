import assert from "node:assert/strict";
import test from "node:test";
import {
  eligibleAllChatTargets,
  parseAllChatReplyTarget,
} from "../src/components/allChatRouting.js";
import {
  activeComposerMention,
  clampComposerMenuIndex,
  hasComposerDestination,
  selectExclusiveNewAgentDestination,
  singleComposerDestination,
} from "../src/components/chat/composerDestination.js";
import {
  findMentionedHandles,
  hasBroadcastMention,
  hasEveryoneMention,
} from "../src/mentions.js";

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
  assert.equal(
    hasComposerDestination("continue with (#new-agent)", "new-agent"),
    true,
  );
});

test("normalizes new Agent into one canonical destination", () => {
  assert.equal(
    singleComposerDestination(
      "#new-agent first, then (#new-agent) again #NEW-AGENT",
      "new-agent",
    ),
    "#new-agent first, then () again ",
  );
  const text = "(#Bryce-Canyon) ask #new-agent then #UI-Specialist #";
  const cursor = text.lastIndexOf("#");
  assert.equal(
    selectExclusiveNewAgentDestination(
      text,
      cursor,
      cursor + 1,
      ["Bryce-Canyon", "UI-Specialist"],
    ),
    "() ask then #new-agent ",
  );
});

test("recognizes punctuation-wrapped destinations consistently", () => {
  assert.deepEqual(
    findMentionedHandles("ask (#Bryce-Canyon), please", ["Bryce-Canyon"]),
    ["Bryce-Canyon"],
  );
  assert.equal(hasBroadcastMention("send (#broadcast)"), true);
  assert.equal(hasEveryoneMention("ask [#everyone]"), true);
});

test("opens mention autocomplete at canonical punctuation boundaries", () => {
  assert.deepEqual(activeComposerMention("ask (#Br"), {
    handlePrefix: "Br",
    start: 5,
  });
  assert.deepEqual(activeComposerMention("#"), {
    handlePrefix: "",
    start: 0,
  });
  assert.equal(activeComposerMention("word#Br"), undefined);
});

test("keeps autocomplete selection within a live suggestion list", () => {
  assert.equal(clampComposerMenuIndex(4, 2), 1);
  assert.equal(clampComposerMenuIndex(1, 2), 1);
  assert.equal(clampComposerMenuIndex(4, 0), 0);
});
