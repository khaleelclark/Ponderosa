import assert from "node:assert/strict";
import test from "node:test";
import {
  eligibleAllChatTargets,
  allChatComposerConversationId,
  allChatRuntimePayloadSnapshot,
  allChatRuntimeSelectionReady,
  allChatSourceConversationId,
  allChatSourceIdentity,
  parseAllChatReplyTarget,
  parseAllChatSourceIdentity,
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
  durableDraftContentReady,
  deletableSupersededDraftAttachmentIds,
  shouldAdoptHydratedDraft,
  hydratedDraftContent,
  hydratedPastedTextContent,
  shouldIgnoreComposerKey,
  shouldSendComposerKey,
} from "../src/components/chat/composerUtils.js";
import {
  findMentionedHandles,
  hasBroadcastMention,
  hasEveryoneMention,
} from "../src/mentions.js";
import {
  preparedIdempotentAttemptForRetry,
  retainIdempotentAttempt,
  selectIdempotentAttempt,
} from "../src/components/idempotentAttempt.js";

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

test("restores only a complete All Messages source Chat identity", () => {
  const source = { projectId: "project-a", conversationId: "chat-a" };
  assert.deepEqual(parseAllChatSourceIdentity(JSON.stringify(source)), source);
  assert.equal(parseAllChatSourceIdentity('{"projectId":"project-a"}'), undefined);
  assert.equal(parseAllChatSourceIdentity("not json"), undefined);
  assert.equal(
    allChatComposerConversationId(undefined, undefined, source),
    "chat-a",
  );
});

test("All Messages retry runtime identity excludes presentation state", () => {
  const available = {
    model: "gpt-5",
    effort: "high",
    speed: "priority",
    models: [{ id: "gpt-5", label: "GPT-5" }],
    efforts: [{ id: "high", label: "High" }],
    speeds: [{ id: "priority", label: "Priority" }],
    ready: true,
  };
  const refreshed = {
    ...available,
    models: [{ id: "gpt-5", label: "GPT-5 (refreshed)" }],
    ready: false,
  };
  const availableSnapshot = allChatRuntimePayloadSnapshot({
    newAgentRequested: false,
    recipientCount: 1,
    selectedEngineId: "codex",
    runtime: available,
  });
  const refreshedSnapshot = allChatRuntimePayloadSnapshot({
    newAgentRequested: false,
    recipientCount: 1,
    selectedEngineId: "claude",
    runtime: refreshed,
  });
  assert.deepEqual(availableSnapshot, refreshedSnapshot);
  assert.notDeepEqual(
    allChatRuntimePayloadSnapshot({
      newAgentRequested: false,
      recipientCount: 1,
      selectedEngineId: "claude",
      runtime: { ...refreshed, speed: "standard" },
    }),
    availableSnapshot,
  );
  let generated = 0;
  const first = retainIdempotentAttempt(
    undefined,
    JSON.stringify({ runtime: availableSnapshot }),
    () => `request-${++generated}`,
    () => ({ runtime: availableSnapshot }),
  );
  const retry = retainIdempotentAttempt(
    first,
    JSON.stringify({ runtime: refreshedSnapshot }),
    () => `request-${++generated}`,
    () => ({ runtime: refreshedSnapshot }),
  );
  assert.equal(retry, first);
  assert.equal(retry.prepared.runtime, availableSnapshot);
  assert.deepEqual(
    allChatRuntimePayloadSnapshot({
      newAgentRequested: false,
      recipientCount: 2,
      selectedEngineId: "codex",
      runtime: refreshed,
    }),
    {},
  );
  assert.deepEqual(
    allChatRuntimePayloadSnapshot({
      newAgentRequested: true,
      recipientCount: 0,
      defaultEngine: "claude",
      runtime: refreshed,
    }),
    { engine: "claude", model: "gpt-5", effort: "high" },
  );
});

test("ambiguous retries select the frozen operation before mutable state", () => {
  const first = retainIdempotentAttempt(
    undefined,
    "recipients:a,b;runtime:shared",
    () => "request-one",
    () => ({ recipients: ["a", "b"], runtime: {} }),
  );
  assert.equal(preparedIdempotentAttemptForRetry(first, true), first);
  assert.equal(preparedIdempotentAttemptForRetry(first, false), undefined);
  const edited = retainIdempotentAttempt(
    preparedIdempotentAttemptForRetry(first, false),
    "recipients:a;runtime:model-x",
    () => "request-two",
    () => ({ recipients: ["a"], runtime: { model: "model-x" } }),
  );
  assert.notEqual(edited, first);
  assert.equal(edited.idempotencyKey, "request-two");
});

test("fixed-Agent retries do not read changed runtime or message inputs", () => {
  const first = retainIdempotentAttempt(
    undefined,
    "agent-a:old-runtime:old-draft",
    () => "request-one",
    () => ({ agentId: "agent-a", model: "old-runtime", draftId: "old-draft" }),
  );
  let liveReads = 0;
  const retry = selectIdempotentAttempt(
    first,
    true,
    () => { liveReads += 1; return "agent-a:new-runtime:new-draft"; },
    () => "request-two",
    () => { liveReads += 1; return { agentId: "agent-a", model: "new-runtime", draftId: "new-draft" }; },
  );
  assert.equal(retry, first);
  assert.equal(liveReads, 0);
  assert.equal(retry.idempotencyKey, "request-one");
  assert.deepEqual(retry.prepared, {
    agentId: "agent-a",
    model: "old-runtime",
    draftId: "old-draft",
  });

  const edited = selectIdempotentAttempt(
    first,
    false,
    () => "agent-a:new-runtime:new-draft",
    () => "request-two",
    () => ({ agentId: "agent-a", model: "new-runtime", draftId: "new-draft" }),
  );
  assert.notEqual(edited, first);
  assert.equal(edited.idempotencyKey, "request-two");
});

test("superseded pasted text is deleted only after a returned draft releases it", () => {
  assert.deepEqual(
    deletableSupersededDraftAttachmentIds(["old", "current"], {
      attachmentIds: [],
      pastedTextAttachmentId: "old",
    }),
    ["current"],
  );
  assert.deepEqual(
    deletableSupersededDraftAttachmentIds(["old"], {
      attachmentIds: [],
      pastedTextAttachmentId: "replacement",
    }),
    ["old"],
  );
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
      {
        kind: "agent",
        agentId: "missing",
        conversationId: "chat-deleted-agent",
        title: "Deleted",
      },
      [bryce],
    ),
    "chat-deleted-agent",
  );
  assert.equal(
    allChatSourceConversationId(
      { kind: "project", conversationId: "chat-b", title: "Backend" },
      [],
    ),
    "chat-b",
  );
  assert.deepEqual(
    allChatSourceIdentity(
      "project-a",
      { kind: "agent", agentId: "bryce", conversationId: "chat-a", title: "Bryce" },
      [],
    ),
    { projectId: "project-a", conversationId: "chat-a" },
  );
  assert.equal(
    allChatComposerConversationId("chat-a", "chat-b", {
      projectId: "project-a",
      conversationId: "chat-c",
    }),
    "chat-a",
  );
});

test("All Messages runtime overrides are unavailable until the selected Agent initializes", () => {
  assert.equal(allChatRuntimeSelectionReady("agent-a", "agent-a"), true);
  assert.equal(allChatRuntimeSelectionReady("agent-b", "agent-a"), false);
  assert.equal(allChatRuntimeSelectionReady(undefined, "agent-a"), false);
});

test("failed or unstaged durable draft content blocks send", () => {
  const ready = {
    conversationDraftId: "chat-a",
    filesReady: true,
    pastedTextPresent: true,
    pastedTextAttachmentId: "paste-a",
    pastedTextUploading: false,
    failedRestoreCount: 0,
  };
  assert.equal(durableDraftContentReady(ready), true);
  assert.equal(
    durableDraftContentReady({ ...ready, pastedTextAttachmentId: undefined }),
    false,
  );
  assert.equal(
    durableDraftContentReady({ ...ready, failedRestoreCount: 1 }),
    false,
  );
  assert.equal(
    durableDraftContentReady({ ...ready, filesReady: false }),
    false,
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

test("focused reload restores durable pasted text independently of editor text", () => {
  assert.equal(shouldAdoptHydratedDraft(true, false), false);
  assert.deepEqual(
    hydratedPastedTextContent({
      attachmentId: "paste-a",
      restoredText: "durable pasted text",
      mutationGenerationAtStart: 0,
      currentMutationGeneration: 0,
    }),
    { attachmentId: "paste-a", text: "durable pasted text" },
  );
});

test("focused reload exposes failed pasted-text restore ownership", () => {
  const failure = { id: "paste-a", name: "Pasted text" };
  assert.deepEqual(
    hydratedPastedTextContent({
      attachmentId: "paste-a",
      failure,
      mutationGenerationAtStart: 0,
      currentMutationGeneration: 0,
    }),
    { attachmentId: "paste-a", failure },
  );
});

test("an unrelated edit preserves hydrated pasted-text ownership", () => {
  assert.equal(shouldAdoptHydratedDraft(false, true), false);
  assert.equal(
    hydratedPastedTextContent({
      attachmentId: "paste-a",
      restoredText: "durable pasted text",
      mutationGenerationAtStart: 3,
      currentMutationGeneration: 3,
    })?.attachmentId,
    "paste-a",
  );
  assert.equal(
    hydratedPastedTextContent({
      attachmentId: "paste-a",
      restoredText: "stale pasted text",
      mutationGenerationAtStart: 3,
      currentMutationGeneration: 4,
    }),
    undefined,
  );
});

test("attachment failure still hydrates durable text and bindings atomically", () => {
  const bindings = [{ agentId: "agent-a" }];
  assert.deepEqual(
    hydratedDraftContent(4, "#new-name durable", "local cache", bindings),
    { text: "#new-name durable", mentionBindings: bindings },
  );
  assert.deepEqual(
    hydratedDraftContent(0, "", "local cache", bindings),
    { text: "local cache", mentionBindings: [] },
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
