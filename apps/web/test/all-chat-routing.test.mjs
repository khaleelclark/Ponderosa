import assert from "node:assert/strict";
import test from "node:test";
import {
  eligibleAllChatTargets,
  allChatSourceConversationId,
  parseAllChatReplyTarget,
} from "../src/components/allChatRouting.js";
import {
  activeComposerMention,
  clampComposerMenuIndex,
  composerSupportsRoutingDestinations,
  hasComposerDestination,
  normalizeExclusiveNewAgentDestination,
  normalizeExclusiveNewAgentDestinationForMode,
  prependComposerDestination,
  removeComposerDestinations,
  removeComposerDestinationsAroundSelection,
  selectExclusiveNewAgentDestination,
  singleComposerDestination,
} from "../src/components/chat/composerDestination.js";
import {
  shouldConsumeComposerKey,
  shouldAdoptHydratedDraft,
  shouldIgnoreComposerKey,
  shouldSendComposerKey,
} from "../src/components/chat/composerUtils.js";
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

test("new Agent creation retains an Agent-authored message's source Chat", () => {
  assert.equal(
    allChatSourceConversationId(
      { kind: "agent", agentId: "bryce", title: "Bryce Canyon" },
      [bryce],
    ),
    "chat-a",
  );
  assert.equal(
    allChatSourceConversationId(
      { kind: "agent", agentId: "missing", title: "Deleted" },
      [bryce],
    ),
    undefined,
  );
  assert.equal(
    allChatSourceConversationId(
      { kind: "project", conversationId: "chat-b", title: "Backend" },
      [],
    ),
    "chat-b",
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

test("ordinary Agent selection removes every new Agent destination", () => {
  assert.deepEqual(
    removeComposerDestinationsAroundSelection(
      "ask #new-agent then (#new-agent) #Br",
      33,
      36,
      ["new-agent"],
    ),
    { text: "ask then () #Br", start: 12, end: 15 },
  );
  assert.equal(
    removeComposerDestinations("ask #new-agent then", ["new-agent"]),
    "ask then",
  );
});

test("new Agent toolbar selection replaces every other destination", () => {
  assert.equal(
    prependComposerDestination(
      removeComposerDestinations(
        "#Bryce-Canyon ask #everyone now",
        ["Bryce-Canyon", "everyone", "new-agent"],
      ),
      "new-agent",
    ),
    "#new-agent ask now",
  );
});

test("typed and pasted destinations keep only the last selected routing mode", () => {
  assert.deepEqual(
    normalizeExclusiveNewAgentDestination(
      "#Bryce-Canyon ask #broadcast then #new-agent ",
      ["Bryce-Canyon", "broadcast", "everyone", "new-agent"],
      46,
    ),
    { text: "ask then #new-agent ", caret: 20 },
  );
  assert.deepEqual(
    normalizeExclusiveNewAgentDestination(
      "#new-agent ask #Bryce-Canyon now",
      ["Bryce-Canyon", "broadcast", "everyone"],
    ),
    { text: "ask #Bryce-Canyon now", caret: 21 },
  );
});

test("fixed Agent composers preserve routing-looking prose exactly", () => {
  const examples = [
    "Compare #new-agent and #broadcast semantics.",
    "Compare #broadcast and #new-agent semantics.",
    "#new-agent notes for #everyone",
  ];
  for (const text of examples) {
    assert.deepEqual(
      normalizeExclusiveNewAgentDestinationForMode(
        "fixed",
        text,
        ["broadcast", "everyone"],
      ),
      { text, caret: text.length },
    );
  }
});

test("new Agent routing is enabled only for selectable destination modes", () => {
  const text = "#broadcast then #new-agent";
  const handles = ["broadcast", "everyone"];
  for (const mode of ["project-chat", "target-required"]) {
    assert.equal(composerSupportsRoutingDestinations(mode), true);
    assert.equal(
      normalizeExclusiveNewAgentDestinationForMode(mode, text, handles).text,
      "then #new-agent",
    );
  }
  for (const mode of ["fixed", undefined]) {
    assert.equal(composerSupportsRoutingDestinations(mode), false);
    assert.equal(
      normalizeExclusiveNewAgentDestinationForMode(mode, text, handles).text,
      text,
    );
  }
});

test("a destination inserted before later text wins at its caret", () => {
  const text = "#new-agent ask #Bryce-Canyon later";
  assert.deepEqual(
    normalizeExclusiveNewAgentDestination(
      text,
      ["Bryce-Canyon"],
      "#new-agent".length,
    ),
    { text: "#new-agent ask later", caret: 10 },
  );
});

test("held Enter stays single-line without sending twice", () => {
  const heldEnter = {
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    repeat: true,
  };
  assert.equal(shouldConsumeComposerKey(heldEnter), true);
  assert.equal(shouldSendComposerKey(heldEnter), false);
  assert.equal(
    shouldConsumeComposerKey({ ...heldEnter, shiftKey: true }),
    false,
  );
  assert.equal(
    shouldConsumeComposerKey({ ...heldEnter, isComposing: true }),
    false,
  );
});

test("IME composition bypasses every composer keyboard shortcut", () => {
  for (const key of ["Enter", "ArrowDown", "ArrowUp", "Tab", "Escape"]) {
    assert.equal(shouldIgnoreComposerKey({ isComposing: true }), true, key);
  }
  assert.equal(shouldIgnoreComposerKey({ isComposing: false, keyCode: 229 }), true);
  assert.equal(shouldIgnoreComposerKey({ isComposing: false, keyCode: 13 }), false);
});

test("late draft hydration never adopts bindings without their text", () => {
  assert.equal(shouldAdoptHydratedDraft(false, false), true);
  assert.equal(shouldAdoptHydratedDraft(true, false), false);
  assert.equal(shouldAdoptHydratedDraft(false, true), false);
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
