import assert from "node:assert/strict";
import test from "node:test";
import {
  eligibleAllChatTargets,
  authoritativeAllChatReplyTarget,
  busyAllChatMentionHandles,
  allChatDeliveryConfirmation,
  allChatAttentionRoute,
  allChatComposerConversationId,
  allChatRuntimeInitializationKey,
  allChatRuntimeMutationIsLatest,
  allChatRuntimeMutationOwnsSelection,
  allChatRuntimePayloadSnapshot,
  allChatRuntimeSelectionReady,
  allChatSubmissionSettlementStillCurrent,
  allChatSourceIntentKey,
  allChatSourceConversationId,
  allChatSourceIdentity,
  parseAllChatReplyTarget,
  parseAllChatSourceIdentity,
  reduceAllChatSubmissionIntent,
  recordRuntimeCanonicalKey,
  runtimeCanonicalKey,
  runtimeMutationOwnsAuthority,
  shouldInitializeAllChatRuntime,
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
  canonicalDraftConflictFiles,
  cleanupReleasedDraftAttachmentIds,
  durableDraftContentReady,
  deletableSupersededDraftAttachmentIds,
  shouldAdoptHydratedDraft,
  composerRecipientGateSatisfied,
  composerPreparedRetryAction,
  composerDurableRetryAction,
  composerShouldSeedContinuationDestination,
  composerSubmissionMayClearDraft,
  draftContentRetryStillOwned,
  draftWriteContinuationStillOwned,
  hydratedDraftContent,
  hydratedPastedTextContent,
  ownedDraftRevisionAfterObservation,
  pendingSubmissionAfterRuntimeObservation,
  recoverableDraftConflict,
  redundantDraftConflictUploadIds,
  resolvedDraftConflictDraft,
  retryDraftRestoreForMissingAssets,
  refreshRecoverableDraftConflict,
  removeComposerPasteSelection,
  restagedDraftConflictSnapshot,
  restoreDraftConflictSnapshot,
  unresolvedRecoverableDraftConflict,
  savedPastedTextCleanMutationGeneration,
  settledDraftWriteContinuation,
  shouldIgnoreComposerKey,
  shouldSendComposerKey,
} from "../src/components/chat/composerUtils.js";
import {
  messageSelectionIntersectsCurrentTarget,
  messageSelectionTargetIsInteractive,
} from "../src/components/chat/messageSelection.js";
import {
  findMentionedHandles,
  hasBroadcastMention,
  hasEveryoneMention,
} from "../src/mentions.js";
import {
  abandonIdempotentAttempt,
  compoundCreationSettlesUnavailable,
  compoundCreationUnavailableUploads,
  definitiveSubmissionStatus,
  durableSubmissionMayBeReleased,
  durableSubmissionFingerprint,
  preparedIdempotentAttemptForRetry,
  retainIdempotentAttempt,
  selectIdempotentAttempt,
  selectDurableSubmission,
  withPendingAgentTitle,
  withCommittedAgentCreation,
} from "../src/components/idempotentAttempt.js";
import {
  pendingDraftAttachmentIds,
  pendingPastedTextAttachmentId,
  pendingRecipientUploads,
  recipientUploadsNeedPersistence,
  withPendingRecipientUploads,
  withPendingRequest,
  retryRecipientUploadCleanup,
} from "../src/conversationRouting.js";

const bryce = {
  id: "bryce",
  title: "Bryce Canyon",
  handle: "Bryce-Canyon",
  projectId: "project-a",
  conversationId: "chat-a",
};

test("All Messages waits for runtime inheritance inputs and preserves a dirty choice", () => {
  const agent = {
    id: "agent-a",
    activeEngine: "codex",
    model: null,
    effort: null,
  };
  const engine = {
    id: "codex",
    defaultModel: "model-a",
    defaultEffort: "medium",
    models: [{ id: "model-a", label: "Model A", efforts: [], availability: "available" }],
  };
  const project = {
    id: "project-a",
    defaultEngine: "codex",
    defaultModel: "model-b",
    defaultEffort: "high",
  };
  const base = {
    selectedAgentId: "agent-a",
    agent,
    engine,
    project,
    enginesLoaded: true,
    preferencesLoaded: true,
    preferencesRevision: 1,
    projectsLoaded: true,
  };
  assert.equal(allChatRuntimeInitializationKey({ ...base, enginesLoaded: false }), undefined);
  assert.equal(allChatRuntimeInitializationKey({ ...base, preferencesLoaded: false }), undefined);
  assert.equal(allChatRuntimeInitializationKey({ ...base, projectsLoaded: false }), undefined);
  assert.equal(allChatRuntimeInitializationKey({ ...base, engine: undefined }), undefined);
  assert.equal(allChatRuntimeInitializationKey({ ...base, project: undefined }), undefined);
  const first = allChatRuntimeInitializationKey(base);
  const refreshed = allChatRuntimeInitializationKey({ ...base, preferencesRevision: 2 });
  assert.equal(shouldInitializeAllChatRuntime(first, undefined, false), true);
  assert.equal(shouldInitializeAllChatRuntime(refreshed, first, false), true);
  assert.equal(shouldInitializeAllChatRuntime(refreshed, first, true), false);
});

test("restores only a complete stable All Messages recipient", () => {
  assert.deepEqual(parseAllChatReplyTarget(JSON.stringify(bryce)), bryce);
  assert.equal(parseAllChatReplyTarget('{"id":"bryce"}'), undefined);
  assert.equal(parseAllChatReplyTarget(JSON.stringify({ ...bryce, id: "" })), undefined);
  assert.equal(parseAllChatReplyTarget("not json"), undefined);
});

test("All Messages leaves queued delivery to the message status", () => {
  assert.equal(allChatDeliveryConfirmation({
    recipientTitles: ["Bryce Canyon"],
    queuedRecipientTitles: ["Bryce Canyon"],
    unavailableCount: 0,
    creationRecovering: false,
  }), undefined);
  assert.equal(allChatDeliveryConfirmation({
    recipientTitles: ["Bryce Canyon"],
    queuedRecipientTitles: [],
    unavailableCount: 2,
    creationRecovering: false,
  }), "Message sent to Bryce Canyon. 2 unavailable recipients were skipped.");
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

test("All Messages derives busy controls from eligible canonical Agent health", () => {
  const targets = eligibleAllChatTargets([
    { id: "agent-a", handle: "A", title: "A", projectId: "project-a", conversationId: "chat-a" },
    { id: "agent-b", handle: "B", title: "B", projectId: "project-a", conversationId: "chat-b" },
  ], "chat-a");
  assert.deepEqual(busyAllChatMentionHandles(targets, [{
    agentId: "agent-a",
    runtimeActivity: {
      state: "responding",
      executionId: "run-a",
      startedAt: "2026-09-09T12:00:00.000Z",
    },
  }, {
    agentId: "agent-b",
    runtimeActivity: {
      state: "responding",
      executionId: "run-b",
      startedAt: "2026-09-09T12:00:00.000Z",
    },
  }]), ["A"]);
  assert.deepEqual(busyAllChatMentionHandles(targets, [{
    agentId: "agent-a",
  }]), []);
});

test("All Messages Queue is frozen into the reload request authority", () => {
  const pending = withPendingRequest({
    fingerprint: "a".repeat(64),
    idempotencyKey: "queue-a",
  }, {
    conversationId: "chat-a",
    recipientAgentIds: ["agent-a"],
    runtime: {
      activeRunDelivery: "queue",
      ...allChatRuntimePayloadSnapshot({
        newAgentRequested: false,
        recipientCount: 1,
        selectedEngineId: "codex",
        runtime: { model: "gpt", effort: "high", speed: "priority" },
      }),
    },
  });
  assert.equal(pending.request.runtime.activeRunDelivery, "queue");
  assert.equal(
    composerDurableRetryAction(
      undefined,
      pending.request.runtime.activeRunDelivery,
    ),
    "queue",
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
  assert.deepEqual(
    deletableSupersededDraftAttachmentIds(["removed-file"], {
      attachmentIds: [],
    }),
    ["removed-file"],
  );
  assert.deepEqual(
    deletableSupersededDraftAttachmentIds(["removed-file"], {
      attachmentIds: ["removed-file"],
    }),
    [],
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

test("selected All Messages source Chat authoritatively constrains recipients", () => {
  const sameChat = { ...bryce, id: "ui", handle: "UI-Specialist" };
  const otherChat = {
    ...bryce,
    id: "saint",
    handle: "Saint-Croix",
    conversationId: "chat-b",
  };
  const selectedSourceChat = allChatComposerConversationId(
    "chat-a",
    otherChat.conversationId,
    { projectId: "project-a", conversationId: "chat-b" },
  );
  assert.equal(selectedSourceChat, "chat-a");
  assert.deepEqual(
    eligibleAllChatTargets([bryce, sameChat, otherChat], selectedSourceChat),
    [bryce, sameChat],
  );
  assert.equal(
    authoritativeAllChatReplyTarget(
      otherChat,
      "project-a",
      selectedSourceChat,
    ),
    undefined,
  );
  assert.equal(
    authoritativeAllChatReplyTarget(
      bryce,
      "project-a",
      selectedSourceChat,
    ),
    bryce,
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

test("stale runtime rollback restores only its Agent's persisted speed", () => {
  assert.equal(allChatRuntimeMutationIsLatest(4, 4), true);
  assert.equal(allChatRuntimeMutationIsLatest(4, 5), false);
  assert.equal(
    allChatRuntimeMutationOwnsSelection({
      capturedAgentId: "agent-a",
      currentAgentId: "agent-b",
      capturedGeneration: 4,
      currentGeneration: 4,
      capturedCanonicalKey: "old",
      currentCanonicalKey: "old",
    }),
    false,
  );
  assert.equal(
    allChatRuntimeMutationOwnsSelection({
      capturedAgentId: "agent-a",
      currentAgentId: "agent-a",
      capturedGeneration: 4,
      currentGeneration: 4,
      capturedCanonicalKey: "old",
      currentCanonicalKey: "old",
    }),
    true,
  );
  assert.equal(
    allChatRuntimeMutationOwnsSelection({
      capturedAgentId: "agent-a",
      currentAgentId: "agent-a",
      capturedGeneration: 4,
      currentGeneration: 4,
      capturedCanonicalKey: "old",
      currentCanonicalKey: "new-from-stream",
    }),
    false,
  );
});

test("Project Chat runtime rollback is fenced by target and canonical tuple", () => {
  const canonical = runtimeCanonicalKey({ engine: "codex", model: "sol", effort: "high" });
  assert.equal(
    runtimeMutationOwnsAuthority({
      capturedOwner: "agent:a",
      currentOwner: "agent:b",
      capturedGeneration: 2,
      currentGeneration: 2,
      capturedCanonicalKey: canonical,
      currentCanonicalKey: canonical,
    }),
    false,
  );
  assert.equal(
    runtimeMutationOwnsAuthority({
      capturedOwner: "conversation:chat-a",
      currentOwner: "conversation:chat-a",
      capturedGeneration: 2,
      currentGeneration: 2,
      capturedCanonicalKey: canonical,
      currentCanonicalKey: runtimeCanonicalKey({
        engine: "claude",
        model: "opus",
        effort: "high",
      }),
    }),
    false,
  );
});

test("adopting an external canonical runtime invalidates an in-flight rollback", () => {
  const generations = new Map([["agent:a", 4]]);
  const canonicalKeys = new Map([["agent:a", "old"]]);
  recordRuntimeCanonicalKey(generations, canonicalKeys, "agent:a", "new-from-stream");
  assert.equal(generations.get("agent:a"), 5);
  assert.equal(canonicalKeys.get("agent:a"), "new-from-stream");
  recordRuntimeCanonicalKey(generations, canonicalKeys, "agent:a", "new-from-stream");
  assert.equal(generations.get("agent:a"), 5);
});

test("interactive message descendants, including the source control, do not bubble selection", () => {
  const currentTarget = {};
  const sourceControl = {};
  assert.equal(
    messageSelectionTargetIsInteractive(currentTarget, currentTarget),
    false,
  );
  assert.equal(
    messageSelectionTargetIsInteractive(
      { closest: selector => selector.includes("button") ? sourceControl : null },
      currentTarget,
    ),
    true,
  );
  assert.equal(
    messageSelectionTargetIsInteractive(
      { closest: () => null },
      currentTarget,
    ),
    false,
  );
});

test("message text selection does not become a blank-area source selection", () => {
  const article = {};
  const selection = (isCollapsed, intersects) => ({
    isCollapsed,
    rangeCount: 1,
    getRangeAt: () => ({ intersectsNode: node => node === article && intersects }),
  });

  assert.equal(messageSelectionIntersectsCurrentTarget(article, selection(false, true)), true, "drag selection");
  assert.equal(messageSelectionIntersectsCurrentTarget(article, selection(false, true)), true, "double-click selection");
  assert.equal(messageSelectionIntersectsCurrentTarget(article, selection(false, false)), false, "selection outside message");
  assert.equal(messageSelectionIntersectsCurrentTarget(article, selection(true, true)), false, "collapsed caret");
  assert.equal(messageSelectionIntersectsCurrentTarget(article, null), false, "ordinary blank-area click");
});

test("All Messages routes a global provider action before Project validation", () => {
  assert.deepEqual(
    allChatAttentionRoute({
      id: "provider-down",
      kind: "operational",
      title: "Provider unavailable",
      body: "Reconnect it.",
      createdAt: "2026-09-05T00:00:00.000Z",
      action: { kind: "open_settings", targetId: "codex" },
    }),
    { kind: "settings", section: "providers" },
  );
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

test("late draft hydration uses one edit-owned adoption decision", () => {
  assert.equal(shouldAdoptHydratedDraft(false, false), true);
  assert.equal(shouldAdoptHydratedDraft(true, false), true);
  assert.equal(shouldAdoptHydratedDraft(false, true), false);
  assert.equal(shouldAdoptHydratedDraft(true, true), false);
});

test("focused reload safely adopts its whole durable draft", () => {
  assert.equal(shouldAdoptHydratedDraft(true, false), true);
  assert.deepEqual(
    hydratedPastedTextContent({
      attachmentId: "paste-a",
      restoredText: "durable pasted text",
      cleanMutationGeneration: 0,
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
      cleanMutationGeneration: 0,
      currentMutationGeneration: 0,
    }),
    { attachmentId: "paste-a", failure },
  );
});

test("a local edit rejects the whole foreign hydrated snapshot", () => {
  const hydratedSnapshot = shouldAdoptHydratedDraft(false, true)
    ? hydratedPastedTextContent({
      attachmentId: "paste-a",
      restoredText: "durable pasted text",
      cleanMutationGeneration: 3,
      currentMutationGeneration: 3,
    })
    : undefined;
  assert.equal(hydratedSnapshot, undefined);
  assert.equal(
    hydratedPastedTextContent({
      attachmentId: "paste-a",
      restoredText: "stale pasted text",
      cleanMutationGeneration: 3,
      currentMutationGeneration: 4,
    }),
    undefined,
  );
});

test("a local paste before initial query or refetch wins hydration", () => {
  for (const restoredText of ["initial query", "remote refetch"]) {
    assert.equal(
      hydratedPastedTextContent({
        attachmentId: "remote-paste",
        restoredText,
        cleanMutationGeneration: 6,
        currentMutationGeneration: 7,
      }),
      undefined,
    );
  }
});

test("only the matching pasted-text PUT clears the local hydration guard", () => {
  assert.equal(
    savedPastedTextCleanMutationGeneration({
      cleanMutationGeneration: 6,
      submittedMutationGeneration: 7,
      currentMutationGeneration: 7,
      submittedAttachmentId: "local-paste",
      savedAttachmentId: "local-paste",
    }),
    7,
  );
  assert.equal(
    savedPastedTextCleanMutationGeneration({
      cleanMutationGeneration: 6,
      submittedMutationGeneration: 7,
      currentMutationGeneration: 8,
      submittedAttachmentId: "local-paste",
      savedAttachmentId: "local-paste",
    }),
    6,
  );
  assert.equal(
    savedPastedTextCleanMutationGeneration({
      cleanMutationGeneration: 6,
      submittedMutationGeneration: 7,
      currentMutationGeneration: 7,
      submittedAttachmentId: "local-paste",
      savedAttachmentId: "other-paste",
    }),
    6,
  );
});

test("observing a foreign draft revision does not grant clear authority", () => {
  assert.equal(ownedDraftRevisionAfterObservation(3, 7, false), 3);
  assert.equal(ownedDraftRevisionAfterObservation(3, 7, true), 7);
});

test("a settled send clears only its exact unchanged draft identity", () => {
  const owned = {
    submittedMutationGeneration: 7,
    currentMutationGeneration: 7,
    stillOwnsDraft: true,
  };
  assert.equal(composerSubmissionMayClearDraft(owned), true);
  for (const mutation of ["text", "file", "paste", "mention", "destination", "hydration"]) {
    assert.equal(
      composerSubmissionMayClearDraft({
        ...owned,
        currentMutationGeneration: 8,
      }),
      false,
      mutation,
    );
  }
  assert.equal(
    composerSubmissionMayClearDraft({ ...owned, stillOwnsDraft: false }),
    false,
  );
});

test("a retained reply destination blocks duplicate continuation seeding after send", () => {
  const refreshedReply = {
    previousSelectionKey: "carlsbad:agent-message",
    nextSelectionKey: "carlsbad:sent-message",
    localText: "",
    editorText: "",
  };
  assert.equal(composerShouldSeedContinuationDestination({
    ...refreshedReply,
    retainedSelectionKey: "agent:carlsbad:Carlsbad",
  }), false);
  assert.equal(composerShouldSeedContinuationDestination(refreshedReply), true);
  assert.equal(composerShouldSeedContinuationDestination({
    ...refreshedReply,
    localText: "draft in progress",
  }), false);
});

test("failed draft retry loses ownership on remove, replace, or surface change", () => {
  const captured = {
    capturedScope: "chat-a",
    currentScope: "chat-a",
    capturedHydrationGeneration: 4,
    currentHydrationGeneration: 4,
    removed: false,
    failurePresent: true,
    capturedPasteMutationGeneration: 7,
    currentPasteMutationGeneration: 7,
  };
  assert.equal(draftContentRetryStillOwned(captured), true);
  assert.equal(draftContentRetryStillOwned({ ...captured, removed: true }), false);
  assert.equal(
    draftContentRetryStillOwned({
      ...captured,
      currentPasteMutationGeneration: 8,
    }),
    false,
  );
  assert.equal(
    draftContentRetryStillOwned({ ...captured, currentScope: "chat-b" }),
    false,
  );
  assert.equal(
    draftContentRetryStillOwned({
      ...captured,
      currentHydrationGeneration: 5,
    }),
    false,
  );
  assert.equal(
    draftContentRetryStillOwned({ ...captured, failurePresent: false }),
    false,
  );
});

test("attachment-only multitab conflict restores the complete snapshot for resave", () => {
  const file = { name: "evidence.png" };
  const snapshot = {
    text: "",
    attachmentIds: ["attachment-a", "unrestored-b"],
    files: [{ file, attachmentId: "attachment-a" }],
    mentionBindings: [{ agentId: "agent-a" }],
    failedContents: [{ id: "unrestored-b", kind: "attachment" }],
  };
  const conflict = recoverableDraftConflict({
    current: {
      conversationId: "chat-a",
      ownerId: "browser-a",
      text: "remote",
      attachmentIds: [],
      revision: 9,
      updatedAt: "2026-09-05T00:00:00.000Z",
      clientId: "page:remote",
    },
    displaced: {
      conversationId: "chat-a",
      text: "",
      attachmentIds: ["attachment-a", "unrestored-b"],
      mentionBindings: [{ agentId: "agent-a" }],
      clientId: "page:local",
      capturedAt: "2026-09-05T00:00:01.000Z",
    },
  }, snapshot);
  const restaged = restagedDraftConflictSnapshot(
    conflict.snapshot,
    [{ file, attachmentId: "fresh-attachment", fromId: "attachment-a" }],
  );
  const restored = restoreDraftConflictSnapshot(restaged, 8);

  assert.equal(conflict.conflict.displaced.text, "");
  assert.deepEqual(conflict.conflict.displaced.attachmentIds, [
    "attachment-a",
    "unrestored-b",
  ]);
  assert.equal(restored.text, "");
  assert.deepEqual(restored.attachmentIds, ["fresh-attachment", "unrestored-b"]);
  assert.deepEqual(restored.files, [{ file, attachmentId: "fresh-attachment" }]);
  assert.equal(restored.attachmentIds.includes("attachment-a"), false);
  assert.deepEqual(restored.mentionBindings, [{ agentId: "agent-a" }]);
  assert.deepEqual(restored.failedContents, [
    { id: "unrestored-b", kind: "attachment" },
  ]);
  assert.deepEqual(
    deletableSupersededDraftAttachmentIds(
      new Set(["current-visible", "attachment-a"]),
      restored,
    ),
    ["current-visible", "attachment-a"],
  );
  assert.equal(restored.editVersion, 9);
  assert.equal(restored.locallyEdited, true);
});

test("paste-only multitab conflict restores its staged payload for resave", () => {
  const snapshot = {
    text: "",
    attachmentIds: [],
    files: [],
    pastedText: "the extracted long paste",
    pastedTextAttachmentId: "paste-a",
    mentionBindings: [],
    failedContents: [],
  };
  const conflict = recoverableDraftConflict({
    current: {
      conversationId: "chat-a",
      ownerId: "browser-a",
      text: "remote",
      attachmentIds: [],
      revision: 4,
      updatedAt: "2026-09-05T00:00:00.000Z",
      clientId: "page:remote",
    },
    displaced: {
      conversationId: "chat-a",
      text: "",
      attachmentIds: [],
      pastedTextAttachmentId: "paste-a",
      mentionBindings: [],
      clientId: "page:local",
      capturedAt: "2026-09-05T00:00:01.000Z",
    },
  }, snapshot);
  const restaged = restagedDraftConflictSnapshot(
    conflict.snapshot,
    [],
    "fresh-paste",
  );
  const restored = restoreDraftConflictSnapshot(restaged, 3);

  assert.equal(conflict.conflict.displaced.text, "");
  assert.equal(
    conflict.conflict.displaced.pastedTextAttachmentId,
    "paste-a",
  );
  assert.equal(restored.text, "");
  assert.equal(restored.pastedText, "the extracted long paste");
  assert.equal(restored.pastedTextAttachmentId, "fresh-paste");
  assert.equal(restored.editVersion, 4);
  assert.equal(restored.locallyEdited, true);
});

test("conflict refresh keeps the stable displaced snapshot and adopts the latest revision", () => {
  const current = {
    conversationId: "chat-a",
    ownerId: "browser-a",
    text: "latest canonical",
    attachmentIds: [],
    revision: 11,
    updatedAt: "2026-09-05T00:00:02.000Z",
    clientId: "page:remote",
  };
  const conflict = {
    id: "stable-conflict",
    current: { ...current, revision: 10 },
    displaced: {
      conversationId: "chat-a",
      text: "preserve me",
      attachmentIds: [],
      clientId: "page:local",
      capturedAt: "2026-09-05T00:00:01.000Z",
    },
  };
  const recovery = recoverableDraftConflict(conflict, {
    text: "preserve me",
    attachmentIds: [],
    files: [],
    mentionBindings: [],
    failedContents: [],
  });
  const refreshed = refreshRecoverableDraftConflict(
    recovery,
    current,
    [{ ...conflict, current }],
  );
  assert.equal(refreshed?.conflict.id, "stable-conflict");
  assert.equal(refreshed?.conflict.current.revision, 11);
  assert.equal(refreshed?.snapshot, recovery.snapshot);
  assert.equal(refreshRecoverableDraftConflict(recovery, current, []), undefined);

  const unresolved = unresolvedRecoverableDraftConflict(recovery, current);
  assert.equal(unresolved.snapshot, recovery.snapshot);
  assert.equal(unresolved.conflict.current.revision, current.revision);
  assert.equal(unresolved.resolutionUnavailable, true);
});

test("lost restore replay keeps its receipt but applies only the newer canonical draft", () => {
  const receipt = {
    conversationId: "chat-a", ownerId: "browser-a", text: "restored",
    attachmentIds: ["receipt-file"], revision: 2,
    updatedAt: "2026-09-08T00:00:01.000Z", clientId: "page:restore",
  };
  const current = {
    ...receipt, text: "newer", attachmentIds: ["current-file"], revision: 3,
    updatedAt: "2026-09-08T00:00:02.000Z", clientId: "page:other",
  };
  const resolution = {
    conflictId: "conflict-a", action: "restored", replayed: true,
    draft: receipt, currentDraft: current,
    attachmentReplacements: [{ fromId: "historical-file", toId: "receipt-file" }],
  };
  const observed = {
    ...current, text: "already observed", attachmentIds: ["observed-file"], revision: 4,
    updatedAt: "2026-09-08T00:00:03.000Z",
  };

  const canonical = resolvedDraftConflictDraft(resolution, observed);
  assert.equal(canonical, observed);
  assert.deepEqual(canonicalDraftConflictFiles(
    [{ file: { name: "historical.txt" }, attachmentId: "historical-file" }],
    canonical.attachmentIds,
    resolution.attachmentReplacements,
  ), { files: [], missingAttachmentIds: ["observed-file"] });
  assert.equal(resolvedDraftConflictDraft(resolution), current);
});

test("draft restore probes durable IDs before restaging only the reported missing subset", async () => {
  let retries = 0;
  const durable = await retryDraftRestoreForMissingAssets(
    async () => "saved without upload",
    () => undefined,
    async () => { retries += 1; return "unexpected"; },
  );
  assert.equal(durable, "saved without upload");
  assert.equal(retries, 0);

  const missing = ["missing-file", "missing-paste"];
  const partial = await retryDraftRestoreForMissingAssets(
    async () => { throw { missing }; },
    error => error.missing,
    async ids => { retries += 1; return ids; },
  );
  assert.deepEqual(partial, missing);
  assert.equal(retries, 1);
});

test("conflict restaging omits unavailable bytes without hiding their recovery failure", () => {
  const snapshot = {
    text: "preserve me",
    attachmentIds: ["available", "missing"],
    files: [{ file: { name: "available.txt" }, attachmentId: "available" }],
    pastedTextAttachmentId: "missing-paste",
    mentionBindings: [],
    pendingSubmission: {
      fingerprint: "a".repeat(64),
      idempotencyKey: "operation-a",
      draftAttachmentIds: ["available", "missing"],
      editableDraftAttachmentIds: ["available", "missing"],
      pastedTextAttachmentId: "missing-paste",
      editablePastedTextAttachmentId: "missing-paste",
    },
    failedContents: [
      { id: "missing", kind: "attachment" },
      { id: "missing-paste", kind: "pasted-text" },
    ],
  };
  const restaged = restagedDraftConflictSnapshot(
    snapshot,
    [{ file: snapshot.files[0].file, attachmentId: "fresh", fromId: "available" }],
    undefined,
    new Set(["missing", "missing-paste"]),
  );
  assert.deepEqual(restaged.attachmentIds, ["fresh"]);
  assert.equal(restaged.pastedTextAttachmentId, undefined);
  assert.deepEqual(restaged.pendingSubmission.draftAttachmentIds, ["available", "missing"]);
  assert.deepEqual(restaged.pendingSubmission.editableDraftAttachmentIds, ["fresh"]);
  assert.equal(restaged.pendingSubmission.pastedTextAttachmentId, "missing-paste");
  assert.equal(restaged.pendingSubmission.editablePastedTextAttachmentId, undefined);
  assert.deepEqual(restaged.failedContents, snapshot.failedContents);
});

test("lost conflict-restore response replays the first canonical mapping without hiding files", () => {
  const file = { name: "brief.pdf" };
  const canonical = canonicalDraftConflictFiles(
    [{ file, attachmentId: "historical" }],
    ["first-upload"],
    [{ fromId: "historical", toId: "first-upload" }],
  );
  assert.deepEqual(canonical, {
    files: [{ file, attachmentId: "first-upload" }],
    missingAttachmentIds: [],
  });
  assert.deepEqual(
    redundantDraftConflictUploadIds(
      ["retry-upload"],
      new Set(["first-upload"]),
    ),
    ["retry-upload"],
  );
  assert.equal(durableDraftContentReady({
    conversationDraftId: "chat-a",
    filesReady: canonical.files.length === 1,
    pastedTextPresent: false,
    pastedTextUploading: false,
    failedRestoreCount: canonical.missingAttachmentIds.length,
  }), true);
  const partial = restagedDraftConflictSnapshot({
    text: "",
    attachmentIds: ["historical"],
    files: [{ file, attachmentId: "historical" }],
    pastedText: "retained paste",
    pastedTextAttachmentId: "durable-paste",
    mentionBindings: [],
    failedContents: [],
  }, [{ file, attachmentId: "fresh-file", fromId: "historical" }]);
  assert.equal(partial.pastedTextAttachmentId, "durable-paste");
});

test("a rejected draft tail cannot suppress the next write continuation", async () => {
  let continued = false;
  const tail = settledDraftWriteContinuation(
    Promise.reject(new Error("conflict recovery failed")),
    async () => {
      continued = true;
    },
  );
  await tail;
  assert.equal(continued, true);
});

test("an old-scope write cleans released file and paste IDs and retains failed cleanup", async () => {
  assert.equal(
    draftWriteContinuationStillOwned({
      capturedScope: "chat-a",
      currentScope: "chat-b",
      capturedGeneration: 11,
      currentGeneration: 12,
    }),
    false,
  );
  const pending = new Set(["released-file", "released-paste", "still-current"]);
  const removed = [];
  let failPaste = true;
  const remove = async id => {
    removed.push(id);
    if (id === "released-paste" && failPaste) {
      failPaste = false;
      throw new Error("temporary cleanup failure");
    }
  };
  const saved = {
    attachmentIds: ["still-current"],
  };

  await cleanupReleasedDraftAttachmentIds(pending, saved, remove);
  assert.deepEqual(removed, ["released-file", "released-paste"]);
  assert.deepEqual([...pending], ["released-paste", "still-current"]);

  await cleanupReleasedDraftAttachmentIds(pending, saved, remove);
  assert.deepEqual(removed, [
    "released-file",
    "released-paste",
    "released-paste",
  ]);
  assert.deepEqual([...pending], ["still-current"]);
});

test("delayed draft continuations lose ownership after switching Chat A to B", () => {
  for (const continuation of ["success", "error", "conflict", "cleanup"]) {
    assert.equal(
      draftWriteContinuationStillOwned({
        capturedScope: "chat-a",
        currentScope: "chat-b",
        capturedGeneration: 11,
        currentGeneration: 12,
      }),
      false,
      continuation,
    );
  }
  assert.equal(
    draftWriteContinuationStillOwned({
      capturedScope: "chat-a",
      currentScope: "chat-a",
      capturedGeneration: 11,
      currentGeneration: 11,
    }),
    true,
  );
  assert.equal(
    draftWriteContinuationStillOwned({
      capturedScope: "chat-a",
      currentScope: "chat-a",
      capturedGeneration: 11,
      currentGeneration: 12,
    }),
    false,
  );
});

test("extracted long paste replaces a range or recipient node selection", () => {
  const removed = [];
  removeComposerPasteSelection({
    kind: "range",
    removeText: () => removed.push("range"),
  });
  removeComposerPasteSelection({
    kind: "node",
    removeNodes: () => removed.push("recipient"),
  });
  removeComposerPasteSelection({ kind: "other" });
  assert.deepEqual(removed, ["range", "recipient"]);
});

test("unchanged frozen retry alone bypasses a disappeared live recipient", () => {
  const targetRequired = {
    destinationMode: "target-required",
    newAgentSelected: false,
    requiredRecipientTagged: false,
  };
  assert.equal(
    composerRecipientGateSatisfied({ ...targetRequired, retryPrepared: false }),
    false,
  );
  assert.equal(
    composerRecipientGateSatisfied({ ...targetRequired, retryPrepared: true }),
    true,
  );
  assert.equal(
    composerRecipientGateSatisfied({ ...targetRequired, retryPrepared: false }),
    false,
  );
});

test("All Messages recipient selection abandons A before B can send", () => {
  const attemptA = retainIdempotentAttempt(
    undefined,
    "chat-a:agent-a:message",
    () => "request-a",
    () => ({ recipientIds: ["agent-a"], uploads: ["upload-a"] }),
  );
  const preparedRetry = { action: "send", submissionIntentKey: "0" };
  const selectedB = reduceAllChatSubmissionIntent(
    { epoch: 0, sourceKey: "chat-a" },
    { kind: "recipient-selected" },
  );
  const abandoned = abandonIdempotentAttempt(attemptA);

  assert.equal(
    composerPreparedRetryAction(preparedRetry, String(selectedB.epoch)),
    undefined,
  );
  assert.equal(abandoned.current, undefined);
  assert.equal(abandoned.abandoned[0], attemptA);
  const attemptB = selectIdempotentAttempt(
    abandoned.current,
    false,
    () => "chat-a:agent-b:message",
    () => "request-b",
    () => ({ recipientIds: ["agent-b"], uploads: [] }),
  );
  assert.deepEqual(attemptB.prepared.recipientIds, ["agent-b"]);
  assert.equal(attemptB.idempotencyKey, "request-b");
});

test("All Messages explicit recipient clear abandons its prepared retry", () => {
  const cleared = reduceAllChatSubmissionIntent(
    { epoch: 4, sourceKey: "chat-a" },
    { kind: "recipient-cleared" },
  );
  assert.equal(cleared.epoch, 5);
  assert.equal(
    composerPreparedRetryAction(
      { action: "send", submissionIntentKey: "4" },
      String(cleared.epoch),
    ),
    undefined,
  );
});

test("All Messages source Chat switch abandons its prepared retry", () => {
  const sourceA = {
    kind: "project",
    conversationId: "chat-a",
    title: "A",
  };
  const sourceB = {
    kind: "project",
    conversationId: "chat-b",
    title: "B",
  };
  const stateA = {
    epoch: 7,
    sourceKey: allChatSourceIntentKey("project-a", sourceA, []),
  };
  const stateB = reduceAllChatSubmissionIntent(stateA, {
    kind: "source-selected",
    sourceKey: allChatSourceIntentKey("project-a", sourceB, []),
  });
  assert.equal(stateB.epoch, 8);
  assert.equal(
    composerPreparedRetryAction(
      { action: "send", submissionIntentKey: "7" },
      String(stateB.epoch),
    ),
    undefined,
  );
});

test("projection-only recipient disappearance preserves the frozen retry", () => {
  const attemptA = retainIdempotentAttempt(
    undefined,
    "chat-a:agent-a:message",
    () => "request-a",
    () => ({ recipientIds: ["agent-a"] }),
  );
  const current = { epoch: 2, sourceKey: "chat-a" };
  const projectedMissing = reduceAllChatSubmissionIntent(current, {
    kind: "recipient-projection-missing",
  });
  const action = composerPreparedRetryAction(
    { action: "send", submissionIntentKey: "2" },
    String(projectedMissing.epoch),
  );
  assert.equal(projectedMissing, current);
  assert.equal(action, "send");
  assert.equal(
    preparedIdempotentAttemptForRetry(attemptA, action === "send"),
    attemptA,
  );
});

test("explicit clear advances intent after projection-only recipient loss", () => {
  const current = { epoch: 2, sourceKey: "chat-a" };
  const projectedMissing = reduceAllChatSubmissionIntent(current, {
    kind: "recipient-projection-missing",
  });
  const explicitlyCleared = reduceAllChatSubmissionIntent(projectedMissing, {
    kind: "recipient-cleared",
  });

  assert.equal(projectedMissing, current);
  assert.deepEqual(explicitlyCleared, { epoch: 3, sourceKey: "chat-a" });
  assert.equal(
    composerPreparedRetryAction(
      { action: "send", submissionIntentKey: "2" },
      String(explicitlyCleared.epoch),
    ),
    undefined,
  );
});

test("delayed A success cannot clear a later B recipient selection", () => {
  assert.equal(
    allChatSubmissionSettlementStillCurrent({
      capturedEpoch: 4,
      currentEpoch: 5,
      capturedSourceKey: "chat-a",
      currentSourceKey: "chat-b",
      capturedTargetId: "agent-a",
      currentTargetId: "agent-b",
    }),
    false,
  );
  assert.equal(
    allChatSubmissionSettlementStillCurrent({
      capturedEpoch: 4,
      currentEpoch: 4,
      capturedSourceKey: "chat-a",
      currentSourceKey: "chat-a",
      capturedTargetId: "agent-a",
      currentTargetId: "agent-a",
    }),
    true,
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

test("durable send identity survives restart for direct, multi-recipient, and new-Agent work", async () => {
  for (const intent of [
    { kind: "direct", surface: "agent:a", recipients: ["a"] },
    { kind: "multi", surface: "chat:a", recipients: ["a", "b"] },
    { kind: "new-agent", surface: "chat:a", recipients: [] },
  ]) {
    const fingerprint = await durableSubmissionFingerprint({
      ...intent,
      text: "unchanged",
      attachmentIds: ["asset-a"],
      runtime: ["codex", "gpt", "high"],
    });
    let created = 0;
    const first = selectDurableSubmission(undefined, fingerprint, () => `operation-${++created}`);
    const committed = new Set([first.idempotencyKey]);
    const afterRestart = selectDurableSubmission(first, fingerprint, () => `operation-${++created}`);
    committed.add(afterRestart.idempotencyKey);
    assert.equal(afterRestart.idempotencyKey, first.idempotencyKey, intent.kind);
    assert.equal(committed.size, 1, intent.kind);
    assert.equal(created, 1, intent.kind);
  }
});

test("edited durable content starts a new send identity after restart", async () => {
  const initial = await durableSubmissionFingerprint({ text: "before", recipient: "agent-a" });
  const edited = await durableSubmissionFingerprint({ text: "after", recipient: "agent-a" });
  const first = selectDurableSubmission(undefined, initial, () => "operation-a");
  const second = selectDurableSubmission(first, edited, () => "operation-b");
  assert.notEqual(initial, edited);
  assert.equal(second.idempotencyKey, "operation-b");
});

test("durable send fingerprints survive reload without SubtleCrypto", async () => {
  const intent = {
    text: "unchanged 🌲".repeat(20),
    surface: "chat:a",
    recipients: ["agent-a"],
  };
  const native = await durableSubmissionFingerprint(intent);
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: () => "fallback-id" },
    });
    assert.equal(await durableSubmissionFingerprint(intent), native);
    assert.notEqual(
      await durableSubmissionFingerprint({ ...intent, text: `${intent.text}!` }),
      native,
    );
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    else delete globalThis.crypto;
  }
});

test("generated Agent title is finalized once and restored with its send identity", async () => {
  const intent = await durableSubmissionFingerprint({
    text: "start work",
    newAgentRequested: true,
  });
  const selected = selectDurableSubmission(undefined, intent, () => "operation-a");
  const finalized = await withPendingAgentTitle(selected, "Bryce Canyon");
  const afterReload = selectDurableSubmission(finalized, intent, () => "operation-b");

  assert.equal(finalized.intentFingerprint, intent);
  assert.notEqual(finalized.fingerprint, intent);
  assert.equal(afterReload.idempotencyKey, "operation-a");
  assert.equal(afterReload.agentTitle, "Bryce Canyon");
  assert.equal(afterReload.fingerprint, finalized.fingerprint);

  const changedIntent = await durableSubmissionFingerprint({
    text: "different work",
    newAgentRequested: true,
  });
  const changed = selectDurableSubmission(finalized, changedIntent, () => "operation-b");
  assert.equal(changed.idempotencyKey, "operation-b");
  assert.equal(changed.agentTitle, undefined);
});

test("prepared recipient assets remain exact across reload", () => {
  assert.equal(recipientUploadsNeedPersistence([
    { agentId: "agent-a", attachments: [] },
    { agentId: "agent-b", attachments: [] },
  ]), false, "text-only sends need no third draft write for empty upload authority");
  assert.equal(recipientUploadsNeedPersistence([
    { agentId: "agent-a", attachments: [{ id: "asset-a" }] },
    { agentId: "agent-b", attachments: [] },
  ]), true, "real uploads remain journaled before delivery");
  const pending = withPendingRecipientUploads(
    { fingerprint: "a".repeat(64), idempotencyKey: "operation-a" },
    "direct",
    [
      { agentId: "agent-a", attachments: [{ id: "asset-a" }] },
      { agentId: "agent-b", attachments: [{ id: "asset-b" }] },
    ],
  );
  assert.deepEqual(pendingRecipientUploads(pending, "direct"), [
    { agentId: "agent-a", attachments: [{ id: "asset-a" }] },
    { agentId: "agent-b", attachments: [{ id: "asset-b" }] },
  ]);
  assert.equal(pendingRecipientUploads(pending, "broadcast"), undefined);
});

test("durable routing and original draft assets remain exact after reload recovery", () => {
  const pending = withPendingRequest({
    fingerprint: "a".repeat(64),
    idempotencyKey: "operation-a",
    draftAttachmentIds: ["old-file"],
    editableDraftAttachmentIds: ["new-file"],
    pastedTextAttachmentId: "old-paste",
    editablePastedTextAttachmentId: "new-paste",
  }, {
    conversationId: "chat-a",
    recipientAgentIds: ["agent-a", "agent-b"],
    broadcastAttachmentOwnerAgentId: "agent-a",
    runtime: { activeRunDelivery: "steer", model: "gpt" },
  });
  assert.deepEqual(pendingDraftAttachmentIds(pending, ["new-file"]), ["old-file"]);
  assert.equal(pendingPastedTextAttachmentId(pending, "new-paste"), "old-paste");
  assert.deepEqual(pending.request.recipientAgentIds, ["agent-a", "agent-b"]);
  const unchanged = withPendingRequest(pending, {
    conversationId: "chat-b",
    recipientAgentIds: ["agent-c"],
    runtime: { activeRunDelivery: "queue" },
  }).request;
  assert.equal(unchanged.conversationId, "chat-a");
  assert.deepEqual(unchanged.recipientAgentIds, ["agent-a", "agent-b"]);
  assert.equal(unchanged.broadcastAttachmentOwnerAgentId, "agent-a");
  assert.deepEqual(unchanged.runtime, { activeRunDelivery: "steer", model: "gpt" });
  assert.deepEqual(pendingDraftAttachmentIds(pending, ["edited-file"]), ["edited-file"]);
});

test("only definitive client failures release durable send identity", () => {
  assert.equal(definitiveSubmissionStatus(400), true);
  assert.equal(definitiveSubmissionStatus(409, "No addressed Agent remains available"), true);
  assert.equal(definitiveSubmissionStatus(409, "runtime communication ID collision"), false);
  assert.equal(definitiveSubmissionStatus(500), false);
  assert.equal(definitiveSubmissionStatus(503), false);
});

test("a committed compound Agent creation retains its identity after a later 4xx", () => {
  const pending = withCommittedAgentCreation({
    fingerprint: "a".repeat(64),
    intentFingerprint: "b".repeat(64),
    idempotencyKey: "compound-reload",
    agentTitle: "Bryce Canyon",
    request: {
      conversationId: "chat-a",
      recipientAgentIds: ["agent-a"],
      runtime: { activeRunDelivery: "steer" },
    },
  });
  assert.equal(withCommittedAgentCreation(pending), pending);
  assert.equal(durableSubmissionMayBeReleased(pending, 409, "Project deletion is in progress"), false);
  assert.equal(durableSubmissionMayBeReleased(pending, 400, "later delivery rejected"), false);
  assert.equal(durableSubmissionMayBeReleased({ ...pending, agentCreationCommitted: undefined }, 400), true);
});

test("a durable send pins Steer or Queue and retains its prepared assets", () => {
  assert.equal(composerDurableRetryAction(undefined, "steer"), "send");
  assert.equal(composerDurableRetryAction(undefined, "queue"), "queue");
  assert.equal(composerDurableRetryAction("queue", "steer"), "send");
  const prepared = {
    fingerprint: "steer",
    idempotencyKey: "message-a",
    prepared: { uploads: [{ agentId: "agent-a", attachments: [{ id: "asset-a" }] }] },
  };
  const selected = selectIdempotentAttempt(
    prepared,
    composerDurableRetryAction("send", "steer") === "send",
    () => "queue",
    () => "message-b",
    () => ({ uploads: [] }),
  );
  assert.equal(selected, prepared);
  assert.equal(selected.prepared.uploads[0].attachments[0].id, "asset-a");
});

test("committed all-unavailable compound sends retry cleanup before settlement", async () => {
  const uploads = [{
    agentId: "agent-a",
    attachments: [{ id: "asset-a" }, { id: "asset-b" }],
  }];
  assert.equal(
    compoundCreationUnavailableUploads(
      true,
      409,
      "No addressed Agent remains available",
      uploads,
    ),
    uploads,
  );
  assert.equal(
    compoundCreationUnavailableUploads(
      false,
      409,
      "No addressed Agent remains available",
      uploads,
    ),
    undefined,
  );
  const attempts = new Map();
  await retryRecipientUploadCleanup(
    uploads,
    async (_agentId, attachment) => {
      const count = (attempts.get(attachment.id) ?? 0) + 1;
      attempts.set(attachment.id, count);
      if (attachment.id === "asset-a" && count === 1) throw new Error("offline");
    },
    undefined,
    0,
  );
  assert.deepEqual([...attempts], [["asset-a", 2], ["asset-b", 1]]);
});

test("observed runtime refreshes preserve an exact hydrated submission request", () => {
  const hydrated = withPendingRequest({
    fingerprint: "a".repeat(64),
    idempotencyKey: "operation-a",
  }, {
    recipientAgentIds: ["agent-a"],
    runtime: { activeRunDelivery: "steer", engine: "codex", model: "old-model" },
  });
  assert.equal(pendingSubmissionAfterRuntimeObservation(hydrated), hydrated);
  assert.equal(pendingSubmissionAfterRuntimeObservation({
    fingerprint: "b".repeat(64),
    idempotencyKey: "not-dispatched",
  }), undefined);
});

test("a committed Agent creation settles a later all-unavailable recipient result", () => {
  assert.equal(
    compoundCreationSettlesUnavailable(
      true,
      409,
      "No addressed Agent remains available",
    ),
    true,
  );
  assert.equal(
    compoundCreationSettlesUnavailable(
      false,
      409,
      "No addressed Agent remains available",
    ),
    false,
  );
  assert.equal(
    compoundCreationSettlesUnavailable(true, 409, "runtime communication ID collision"),
    false,
  );
  assert.equal(compoundCreationSettlesUnavailable(true, 503, "unavailable"), false);
});
