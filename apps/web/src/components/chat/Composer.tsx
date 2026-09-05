import {
  Box,
  Paper,
  Stack,
} from "@mui/material";
import { messageTagTokens, utf8ByteLength } from "@ponderosa/core";
import type {
  AgentMentionBindingDto,
  ArtifactDto,
  ConversationDraftConflictDto,
  DraftAttachmentDto,
  EngineCommand,
  EngineComposerCapability,
} from "@ponderosa/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { api } from "../../api";
import { ApiRequestError } from "../../api/types";
import { readChatState, writeChatState } from "../../chatState";
import { createClientId, pageClientId } from "../../clientId";
import { findMentionedHandles, hasBroadcastMention } from "../../mentions";
import { queryKeys } from "../../queryKeys";
import { removeHandle } from "./Composer.helpers";
import {
  activeComposerMention,
  clampComposerMenuIndex,
  composerSupportsRoutingDestinations,
  hasComposerDestination,
  NEW_AGENT_DESTINATION_HANDLE,
  normalizeExclusiveNewAgentDestinationForMode,
  prependComposerDestination,
  removeComposerDestinations,
  removeComposerDestinationsAroundSelection,
  selectExclusiveNewAgentDestination,
  singleComposerDestination,
} from "./composerDestination";
import type { ComposerProps } from "./Composer.types";
import {
  ComposerAttachmentList,
  ComposerDestinationBar,
  ComposerProjectDestinationAction,
  ComposerSendActions,
} from "./Composer.parts";
import {
  ComposerAutocompleteMenu,
  ComposerCapabilityPicker,
  ComposerNotices,
  ComposerTextInput,
  type ComposerMenuSuggestion,
} from "./Composer.controls";
import {
  projectFileCanonicalText,
  type ComposerEditorHandle,
  type ComposerProjectFileDescriptor,
} from "./ComposerEditor";
import {
  canSubmitComposerText,
  composerAttachmentReducer,
  composerSubmissionText,
  durableDraftContentReady,
  engineCommandDisabledReason,
  hydratedDraftContent,
  insertComposerCapability,
  matchingComposerCapabilities,
  matchingEngineCommands,
  providerSlashSubmission,
  shouldAdoptHydratedDraft,
  shouldShowQueueControl,
} from "./composerUtils";
import {
  refreshedMentionBindings,
  resolvedMentionBinding,
} from "./composerMentionBindings";
import { useComposerDraftAttachments } from "./useComposerDraftAttachments";
import {
  useComposerDraftStorageReset,
  useComposerDraftStorageWrite,
  useComposerInsertTextRequest,
  useComposerMentionedHandlesChange,
} from "./useComposerTextEffects";
import { composerSurfaceSx } from "./Composer.styles";
import { DictationControls } from "../speech/DictationControls";
import { insertSpeechText } from "../speech/speechText";

const DRAFT_OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SPECIAL_MENTION_TITLES = new Map([
  ["broadcast", "Broadcast"],
  ["everyone", "Everyone"],
  [NEW_AGENT_DESTINATION_HANDLE, "New Agent"],
]);
type ComposerMentionToken = {
  start: number;
  end: number;
  handle: string;
  title: string;
  valid: boolean;
  kind: "agent" | "special";
  agentId?: string;
};

type FailedDraftContent = {
  id: string;
  name: string;
  kind: "attachment" | "pasted-text";
  attachment?: DraftAttachmentDto;
};

const PASTED_TEXT_DRAFT_NAME = "Pasted text.txt";

export type { ComposerProps } from "./Composer.types";

type ComposerDefaultDestination = NonNullable<
  ComposerProps["defaultDestination"]
>;

function removeAllComposerDestinations(
  value: string,
  handle: string,
): string {
  return removeComposerDestinations(value, [handle]);
}

function providerCommandInput(
  value: string,
  destinationHandle?: string,
): { text: string; start: number } | undefined {
  if (!destinationHandle) return { text: value, start: 0 };
  const destination = /^#([\p{L}\p{N}_-]+)\s+/u.exec(value);
  if (
    !destination ||
    destination[1]!.toLocaleLowerCase() !==
      destinationHandle.toLocaleLowerCase()
  ) {
    return undefined;
  }
  return {
    text: value.slice(destination[0].length),
    start: destination[0].length,
  };
}

export function Composer({
  disabled,
  running,
  allowSendWhileRunning = false,
  placeholder,
  projectId,
  mentionHandles,
  mentionBindings,
  mentionSuggestionHandles,
  ambiguousMentionHandles,
  commands,
  capabilities,
  onCapabilitiesOpen,
  attachmentsEnabled = true,
  attachmentsUnavailableReason,
  enableVoiceDictation = false,
  busyMentionHandles,
  allowUnmentionedSend = true,
  sendUnavailableReason,
  onSend,
  onCommand,
  onQueue,
  agentResponding = false,
  onCancel,
  cancelPending = false,
  draftStorageKey,
  conversationDraftId,
  leadingControls,
  controls,
  insertTextRequest,
  destinationMode,
  requiredRecipient,
  recipientRequiredMessage,
  removeTextRequest,
  onMentionedHandlesChange,
  onCommandTargetHandleChange,
  onCommandTargetAgentIdChange,
  defaultDestination,
}: ComposerProps): JSX.Element {
  const [text, setTextState] = useState(() =>
    draftStorageKey ? (readChatState(draftStorageKey) ?? "") : "",
  );
  const textRef = useRef(text);
  const [draftOwnerId] = useState(() => {
    if (typeof window === "undefined") return "server";
    const key = "ponderosa.draft.owner.v1";
    const existing = window.localStorage.getItem(key);
    if (existing && DRAFT_OWNER_ID.test(existing)) return existing;
    const created = createClientId();
    window.localStorage.setItem(key, created);
    return created;
  });
  const [pastedText, setPastedTextState] = useState<string>();
  const pastedTextRef = useRef<string>();
  const [attachments, dispatchAttachments] = useReducer(
    composerAttachmentReducer,
    { files: [] },
  );
  const files = attachments.files;
  const queryClient = useQueryClient();
  const assetLimitsQuery = useQuery({
    queryKey: queryKeys.assetLimits.all,
    queryFn: () => api.getAssetLimits(),
    staleTime: 5 * 60_000,
  });
  const assetLimits = assetLimitsQuery.data;
  const [sendError, setSendError] = useState<string>();
  const [draftConflict, setDraftConflict] =
    useState<ConversationDraftConflictDto>();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const previousDraftStorageKey = useRef(draftStorageKey);
  const previousConversationDraftId = useRef(conversationDraftId);
  const draftRevision = useRef(0);
  const draftReady = useRef(false);
  const draftClientId = useRef(pageClientId());
  const draftWriteChain = useRef<Promise<void>>(Promise.resolve());
  const draftGeneration = useRef(0);
  const draftHydrationGeneration = useRef(0);
  const draftEditVersion = useRef(0);
  const userDraftMutationGeneration = useRef(0);
  const draftLocallyEdited = useRef(false);
  const draftAttachmentsLocallyEdited = useRef(false);
  const unrestoredDraftAttachmentIds = useRef<string[]>([]);
  const pastedTextAttachmentId = useRef<string>();
  const pastedTextUploadGeneration = useRef(0);
  const pastedTextUploadFailedFor = useRef<string>();
  const [pastedTextUploading, setPastedTextUploading] = useState(false);
  const [failedDraftContents, setFailedDraftContents] = useState<
    FailedDraftContent[]
  >([]);
  const [draftReadyVersion, setDraftReadyVersion] = useState(0);
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const dictationSettlingRef = useRef(false);
  const [dictationSettling, setDictationSettling] = useState(false);
  const [caret, setCaret] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const [suppressMenu, setSuppressMenu] = useState(false);
  const mentionListId = useId();
  const capabilityListId = useId();
  const [capabilityMenuAnchor, setCapabilityMenuAnchor] =
    useState<HTMLElement | null>(null);
  const [capabilityFilter, setCapabilityFilter] = useState("");
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const appliedInsertRequest = useRef<string>();
  const appliedRemoveRequest = useRef<string>();
  const appliedDefaultDestination = useRef<ComposerDefaultDestination>();
  const [activeDefaultDestination, setActiveDefaultDestination] =
    useState<ComposerDefaultDestination>();
  const [knownMentionBindings, setKnownMentionBindings] = useState<
    AgentMentionBindingDto[]
  >([]);
  const inputRef = useRef<ComposerEditorHandle | null>(null);
  const markUserDraftMutation = useCallback(() => {
    userDraftMutationGeneration.current += 1;
  }, []);
  const markDraftEdited = useCallback(() => {
    markUserDraftMutation();
    draftEditVersion.current += 1;
    draftLocallyEdited.current = true;
  }, [markUserDraftMutation]);
  const replaceText = useCallback(
    (next: string | ((current: string) => string)) => {
      const resolved =
        typeof next === "function" ? next(textRef.current) : next;
      textRef.current = resolved;
      setTextState(resolved);
    },
    [],
  );
  const update = useCallback(
    (next: string | ((current: string) => string)) => {
      const resolved =
        typeof next === "function" ? next(textRef.current) : next;
      if (resolved === textRef.current) return;
      markDraftEdited();
      replaceText(resolved);
    },
    [markDraftEdited, replaceText],
  );
  const insertDictatedText = useCallback(
    (transcript: string) => {
      const selection = inputRef.current?.getSelectionOffsets() ?? {
        start: textRef.current.length,
        end: textRef.current.length,
      };
      const insertion = insertSpeechText(
        textRef.current,
        transcript,
        selection.start,
        selection.end,
      );
      inputRef.current?.replaceCanonicalRange(
        0,
        textRef.current.length,
        insertion.text,
      );
      setSendError(undefined);
      setCaret(insertion.caret);
      setHighlighted(0);
      setSuppressMenu(false);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionOffsets(insertion.caret, insertion.caret);
      });
    },
    [],
  );
  const handleDictationSettlingChange = useCallback((settling: boolean) => {
    dictationSettlingRef.current = settling;
    setDictationSettling(settling);
  }, []);
  useEffect(() => {
    setKnownMentionBindings(previous =>
      refreshedMentionBindings(text, previous, mentionBindings ?? []));
  }, [mentionBindings, text]);
  const replacePastedText = useCallback(
    (
      next:
        | string
        | undefined
        | ((current: string | undefined) => string | undefined),
    ) => {
      const resolved =
        typeof next === "function" ? next(pastedTextRef.current) : next;
      pastedTextRef.current = resolved;
      setPastedTextState(resolved);
    },
    [],
  );
  const updatePastedText = useCallback(
    (next: string | undefined) => {
      if (next === pastedTextRef.current) return;
      const previousAttachmentId = pastedTextAttachmentId.current;
      pastedTextAttachmentId.current = undefined;
      pastedTextUploadGeneration.current += 1;
      setPastedTextUploading(false);
      pastedTextUploadFailedFor.current = undefined;
      markDraftEdited();
      replacePastedText(next);
      if (conversationDraftId && previousAttachmentId) {
        void api.deleteDraftAttachment(
          conversationDraftId,
          draftOwnerId,
          previousAttachmentId,
        ).catch(() => undefined);
      }
    },
    [conversationDraftId, draftOwnerId, markDraftEdited, replacePastedText],
  );
  const invalidateDraftHydration = useCallback(() => {
    draftHydrationGeneration.current += 1;
  }, []);
  const markDraftAttachmentsEdited = useCallback(
    (removedAttachmentId?: string) => {
      if (removedAttachmentId) {
        unrestoredDraftAttachmentIds.current =
          unrestoredDraftAttachmentIds.current.filter(
            id => id !== removedAttachmentId,
          );
        setFailedDraftContents(current =>
          current.filter(item => item.id !== removedAttachmentId),
        );
      }
      draftAttachmentsLocallyEdited.current = true;
      markDraftEdited();
    },
    [markDraftEdited],
  );
  const draftAttachments = useComposerDraftAttachments({
    assetLimits,
    conversationDraftId,
    dispatch: dispatchAttachments,
    draftOwnerId,
    files,
    onEdit: markDraftAttachmentsEdited,
    onBeforeClear: invalidateDraftHydration,
  });
  const {
    addFiles,
    attachmentIds: draftAttachmentIds,
    attachmentVersion: draftAttachmentVersion,
    clear: clearDraftAttachments,
    locallyRemovedIds: locallyRemovedDraftAttachmentIds,
    mergeRestored: mergeRestoredDraftAttachments,
    removeFile,
    replaceRestored: replaceRestoredDraftAttachments,
    retryUpload: retryDraftUpload,
    uploadStates: draftUploadStates,
  } = draftAttachments;
  const removeFailedDraftContent = useCallback((id: string) => {
    const failed = failedDraftContents.find(item => item.id === id);
    if (!failed) return;
    if (failed.kind === "pasted-text") {
      pastedTextAttachmentId.current = undefined;
      replacePastedText(undefined);
    } else {
      unrestoredDraftAttachmentIds.current =
        unrestoredDraftAttachmentIds.current.filter(candidate => candidate !== id);
    }
    locallyRemovedDraftAttachmentIds.current.add(id);
    setFailedDraftContents(current => current.filter(item => item.id !== id));
    dispatchAttachments({ type: "clear_error" });
    markDraftEdited();
    if (conversationDraftId) {
      void api
        .deleteDraftAttachment(conversationDraftId, draftOwnerId, id)
        .catch(() => undefined);
    }
  }, [
    conversationDraftId,
    dispatchAttachments,
    draftOwnerId,
    failedDraftContents,
    locallyRemovedDraftAttachmentIds,
    markDraftEdited,
    replacePastedText,
  ]);
  const retryFailedDraftContent = useCallback(async (id: string) => {
    const failed = failedDraftContents.find(item => item.id === id);
    if (!failed || !conversationDraftId) return;
    setSendError(undefined);
    try {
      const refreshedDraft = failed.attachment
        ? undefined
        : await api.getConversationDraft(conversationDraftId, draftOwnerId);
      const attachment = failed.attachment ??
        (failed.kind === "pasted-text"
          ? refreshedDraft?.pastedTextAttachment
          : refreshedDraft?.attachments?.find(item => item.id === id));
      if (!attachment) throw new Error("The staged content is no longer available.");
      const file = await api.downloadDraftAttachment(attachment);
      if (failed.kind === "pasted-text") {
        pastedTextAttachmentId.current = id;
        replacePastedText(await file.text());
      } else {
        mergeRestoredDraftAttachments([{ attachment, file }]);
        unrestoredDraftAttachmentIds.current =
          unrestoredDraftAttachmentIds.current.filter(candidate => candidate !== id);
      }
      setFailedDraftContents(current => current.filter(item => item.id !== id));
      dispatchAttachments({ type: "clear_error" });
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : "Draft content could not be restored.",
      );
    }
  }, [
    conversationDraftId,
    draftOwnerId,
    failedDraftContents,
    dispatchAttachments,
    mergeRestoredDraftAttachments,
    replacePastedText,
  ]);
  const exclusiveDestinationHandles = useMemo(
    () => [...new Set([...(mentionHandles ?? []), "broadcast", "everyone"])],
    [mentionHandles],
  );
  const routingDestinationsEnabled =
    composerSupportsRoutingDestinations(destinationMode);
  const normalizedDestinationDraft = normalizeExclusiveNewAgentDestinationForMode(
    destinationMode,
    text,
    exclusiveDestinationHandles,
  );
  useEffect(() => {
    if (normalizedDestinationDraft.text !== text) {
      update(normalizedDestinationDraft.text);
    }
  }, [normalizedDestinationDraft.text, text, update]);
  const newAgentSelected =
    routingDestinationsEnabled &&
    hasComposerDestination(
      normalizedDestinationDraft.text,
      NEW_AGENT_DESTINATION_HANDLE,
    );
  const visibleSubmissionText = newAgentSelected
    ? singleComposerDestination(
        normalizedDestinationDraft.text,
        NEW_AGENT_DESTINATION_HANDLE,
      )
    : normalizedDestinationDraft.text;
  const composedText = composerSubmissionText(visibleSubmissionText, pastedText);
  const renderedDefaultDestination = newAgentSelected
    ? undefined
    : destinationMode === "target-required"
      ? defaultDestination
      : activeDefaultDestination;
  const submissionText =
    (destinationMode === "project-chat" || destinationMode === "target-required") &&
    renderedDefaultDestination
      ? prependComposerDestination(
          composedText,
          renderedDefaultDestination.handle,
        )
      : composedText;
  const routingMentionHandles = useMemo(
    () =>
      destinationMode === "project-chat" || destinationMode === "target-required"
        ? [
            ...new Set([
              ...(mentionHandles ?? []),
              ...knownMentionBindings.map(binding => binding.handle),
              NEW_AGENT_DESTINATION_HANDLE,
            ]),
          ]
        : (mentionHandles ?? []),
    [destinationMode, knownMentionBindings, mentionHandles],
  );
  const visibleRoutingText = renderedDefaultDestination
    ? prependComposerDestination(
        visibleSubmissionText,
        renderedDefaultDestination.handle,
      )
    : visibleSubmissionText;
  const mentionedHandles = useMemo(
    () => findMentionedHandles(visibleRoutingText, routingMentionHandles),
    [routingMentionHandles, visibleRoutingText],
  );
  const mentionTokens = useMemo<ComposerMentionToken[]>(() => {
    const currentById = new Map((mentionBindings ?? []).map(binding => [binding.agentId, binding]));
    const byHandle = new Map<string, AgentMentionBindingDto>();
    for (const binding of mentionBindings ?? []) {
      byHandle.set(binding.handle.toLocaleLowerCase(), binding);
      byHandle.set(binding.currentHandle.toLocaleLowerCase(), binding);
    }
    const knownByHandle = new Map<string, AgentMentionBindingDto[]>();
    for (const binding of knownMentionBindings) {
      for (const handle of [binding.handle, binding.currentHandle]) {
        const normalized = handle.toLocaleLowerCase();
        const matches = knownByHandle.get(normalized) ?? [];
        matches.push(binding);
        knownByHandle.set(normalized, matches);
      }
    }
    for (const [handle, matches] of knownByHandle) {
      const owners = new Set(matches.map(binding => binding.agentId));
      if (owners.size === 1) byHandle.set(handle, matches[0]!);
      else byHandle.delete(handle);
    }
    const tokens: ComposerMentionToken[] = [];
    for (const token of messageTagTokens(text)) {
      const specialTitle = routingDestinationsEnabled
        ? SPECIAL_MENTION_TITLES.get(token.handle.toLocaleLowerCase())
        : undefined;
      if (specialTitle) {
        tokens.push({
          start: token.start,
          end: token.end,
          handle: token.handle,
          title: specialTitle,
          valid: true,
          kind: "special",
        });
        continue;
      }
      const binding = byHandle.get(token.handle.toLocaleLowerCase());
      if (!binding) continue;
      const current = currentById.get(binding.agentId);
      tokens.push({
        start: token.start,
        end: token.end,
        handle: token.handle,
        title: current?.currentTitle ?? binding.currentTitle,
        valid: Boolean(current),
        kind: "agent",
        agentId: binding.agentId,
      });
    }
    return tokens;
  }, [knownMentionBindings, mentionBindings, routingDestinationsEnabled, text]);
  const invalidMention = mentionTokens.find(token => !token.valid);
  const authoredProjectDestinationHandles = destinationMode === "project-chat"
    ? findMentionedHandles(visibleSubmissionText, routingMentionHandles).filter(
        handle =>
          ![
            "broadcast",
            "everyone",
            NEW_AGENT_DESTINATION_HANDLE,
          ].includes(handle.toLocaleLowerCase()),
      )
    : [];
  const projectDestinationHandles = destinationMode === "project-chat"
    ? [
        ...new Map(
          [
            ...(renderedDefaultDestination
              ? [renderedDefaultDestination.handle]
              : []),
            ...authoredProjectDestinationHandles,
          ].map(handle => [handle.toLocaleLowerCase(), handle]),
        ).values(),
      ]
    : [];
  const projectDestinations = projectDestinationHandles.map(handle => ({
    handle,
  }));
  const targetRequiredHandles =
    destinationMode === "target-required"
      ? mentionedHandles.filter(
          handle =>
            !["broadcast", "everyone", NEW_AGENT_DESTINATION_HANDLE].includes(handle.toLocaleLowerCase()),
        )
      : [];
  const targetRequiredDestinations = targetRequiredHandles.map(handle => ({
    handle,
  }));
  const ambiguousTargetRequiredHandles =
    destinationMode === "target-required"
      ? findMentionedHandles(visibleRoutingText, ambiguousMentionHandles ?? [])
      : [];
  const unresolvedAmbiguousTarget = ambiguousTargetRequiredHandles.find(
    handle =>
      !requiredRecipient ||
      requiredRecipient.handle.toLocaleLowerCase() !==
        handle.toLocaleLowerCase(),
  );
  const unresolvedAuthoredTarget = [
    ...authoredProjectDestinationHandles,
    ...targetRequiredHandles,
  ].find(handle => !resolvedMentionBinding(
    handle,
    knownMentionBindings,
    mentionBindings ?? [],
  ));
  const hasBroadcastDestination = hasBroadcastMention(visibleRoutingText);
  const hasEveryoneDestination =
    destinationMode === "project-chat" &&
    mentionedHandles.some(handle => handle.toLocaleLowerCase() === "everyone");
  const explicitCommandTargetHandle =
    destinationMode === "project-chat" &&
    !hasBroadcastDestination &&
    !hasEveryoneDestination &&
    projectDestinations.length === 1
      ? projectDestinations[0]!.handle
      : destinationMode === "target-required" &&
          !hasBroadcastDestination &&
          targetRequiredDestinations.length === 1 &&
          requiredRecipient?.handle.toLocaleLowerCase() ===
            targetRequiredDestinations[0]!.handle.toLocaleLowerCase() &&
          !unresolvedAmbiguousTarget
        ? targetRequiredDestinations[0]!.handle
        : undefined;
  const commandTargetHandle =
    explicitCommandTargetHandle ??
    (destinationMode === "fixed" ? defaultDestination?.handle : undefined);
  const commandTargetAgentId =
    destinationMode === "project-chat" &&
      !hasBroadcastDestination &&
      !hasEveryoneDestination &&
      renderedDefaultDestination?.binding &&
      projectDestinations.length === 1 &&
      projectDestinations[0]?.handle.toLocaleLowerCase() ===
        renderedDefaultDestination.handle.toLocaleLowerCase()
      ? renderedDefaultDestination.binding.agentId
      : destinationMode === "fixed"
        ? defaultDestination?.binding?.agentId
        : undefined;
  useEffect(() => {
    onCommandTargetHandleChange?.(commandTargetHandle);
  }, [commandTargetHandle, onCommandTargetHandleChange]);
  useEffect(() => {
    onCommandTargetAgentIdChange?.(commandTargetAgentId);
  }, [commandTargetAgentId, onCommandTargetAgentIdChange]);
  const destinationError =
    invalidMention
      ? `#${invalidMention.handle} no longer identifies an available Agent. Remove it before sending.`
      : unresolvedAuthoredTarget
        ? `#${unresolvedAuthoredTarget} does not identify one available Agent. Remove it or choose an Agent again.`
      : destinationMode === "target-required" && hasBroadcastDestination
      ? targetRequiredDestinations.length > 0
        ? "Broadcast is only available in a Project Chat."
        : "#broadcast is not available in Messages Across Ponderosa. Choose an Agent."
      : destinationMode === "target-required" && unresolvedAmbiguousTarget
          ? `#${unresolvedAmbiguousTarget} matches more than one Agent. Use a message's # action to choose the exact Agent.`
          : undefined;
  const toggleNewAgentDestination = () => {
    const selectingNewAgent = !newAgentSelected;
    update(current => {
      if (!selectingNewAgent) {
        return removeComposerDestinations(current, [NEW_AGENT_DESTINATION_HANDLE]);
      }
      return prependComposerDestination(
        removeComposerDestinations(current, [
          NEW_AGENT_DESTINATION_HANDLE,
          ...targetRequiredHandles,
          ...authoredProjectDestinationHandles,
          "broadcast",
          "everyone",
        ]),
        NEW_AGENT_DESTINATION_HANDLE,
      );
    });
    if (selectingNewAgent) requiredRecipient?.onClear();
    setActiveDefaultDestination(
      selectingNewAgent ? undefined : defaultDestination,
    );
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const clearActiveDefaultDestination = useCallback(() => {
    setActiveDefaultDestination(undefined);
  }, []);
  const clearRequiredRecipient = () => {
    const handle = targetRequiredHandles[0] ?? requiredRecipient?.handle;
    if (handle) update(current => removeHandle(current, handle));
    requiredRecipient?.onClear();
  };
  const composerLocked = running && !allowSendWhileRunning;
  const busyHandles = new Set(
    (busyMentionHandles ?? []).map(handle => handle.toLocaleLowerCase()),
  );
  const mentionedBusyHandles = mentionedHandles.filter(handle =>
    busyHandles.has(handle.toLocaleLowerCase()),
  );
  const textCanSend = canSubmitComposerText({
    text: submissionText,
    disabled,
    running: composerLocked,
    allowUnmentionedSend,
    mentionedHandles,
    mentionedBusyHandles,
  });
  const targetRequiredRecipientTagged =
    destinationMode !== "target-required" ||
    newAgentSelected ||
    Boolean(
      requiredRecipient &&
      targetRequiredHandles.some(handle =>
        requiredRecipient.handle.toLocaleLowerCase() === handle.toLocaleLowerCase()),
    );
  const draftUploadsReady =
    !conversationDraftId ||
    files.every(file => draftAttachmentIds.current.has(file));
  const durableContentReady = durableDraftContentReady({
    conversationDraftId,
    filesReady: files.every(file => draftAttachmentIds.current.has(file)),
    pastedTextPresent: Boolean(pastedText),
    pastedTextAttachmentId: pastedTextAttachmentId.current,
    pastedTextUploading,
    failedRestoreCount: failedDraftContents.length,
  });
  const canSend =
    !sending &&
    !dictationSettling &&
    !destinationError &&
    targetRequiredRecipientTagged &&
    draftUploadsReady &&
    durableContentReady &&
    (textCanSend ||
      (!disabled &&
        !composerLocked &&
        allowUnmentionedSend &&
        files.length > 0));
  const canCancel = running && Boolean(onCancel);
  const composerAttachmentsEnabled = attachmentsEnabled;
  const composerAttachmentsUnavailableReason = attachmentsUnavailableReason;

  const draftQuery = useQuery({
    queryKey: queryKeys.conversationDraft.detail(
      conversationDraftId,
      draftOwnerId,
    ),
    queryFn: () => api.getConversationDraft(conversationDraftId!, draftOwnerId),
    enabled: Boolean(conversationDraftId) && typeof window !== "undefined",
    staleTime: 0,
  });

  useComposerInsertTextRequest({
    appliedInsertRequest,
    conversationDraftId,
    destinationMode,
    draftQuery,
    draftReady,
    draftReadyVersion,
    inputRef,
    insertTextRequest,
    setCaret,
    updateText: update,
  });

  useComposerMentionedHandlesChange({
    mentionedHandles,
    onMentionedHandlesChange,
  });

  useEffect(() => {
    if (
      !removeTextRequest ||
      appliedRemoveRequest.current === removeTextRequest.id
    )
      return;
    appliedRemoveRequest.current = removeTextRequest.id;
    const handle = removeTextRequest.text.trim().replace(/^#/u, "");
    if (!handle) return;
    update(current => removeHandle(current, handle));
  }, [removeTextRequest]);

  useComposerDraftStorageReset({
    draftStorageKey,
    previousDraftStorageKey,
    setPastedText: replacePastedText,
    setText: replaceText,
  });

  useEffect(() => {
    const changed = previousConversationDraftId.current !== conversationDraftId;
    previousConversationDraftId.current = conversationDraftId;
    if (changed) {
      pastedTextUploadGeneration.current += 1;
      pastedTextAttachmentId.current = undefined;
      setPastedTextUploading(false);
      setFailedDraftContents([]);
      replacePastedText(undefined);
      draftReady.current = false;
      draftLocallyEdited.current = false;
      draftAttachmentsLocallyEdited.current = false;
      unrestoredDraftAttachmentIds.current = [];
      draftRevision.current = 0;
      setKnownMentionBindings([]);
      clearDraftAttachments();
    }
  }, [conversationDraftId, clearDraftAttachments, replacePastedText]);

  useEffect(() => {
    const draft = draftQuery.data;
    if (
      !conversationDraftId ||
      !draft ||
      (draftReady.current && draft.revision <= draftRevision.current)
    )
      return;
    let cancelled = false;
    const hydrationGeneration = draftHydrationGeneration.current;
    const apply = async () => {
      const attachmentById = new Map(
        (draft.attachments ?? []).map(attachment => [attachment.id, attachment]),
      );
      const restoredResults = await Promise.allSettled(
        draft.attachmentIds.map(async id => {
          const attachment = attachmentById.get(id);
          if (!attachment) throw new Error("Draft attachment metadata is unavailable.");
          return {
            attachment,
            file: await api.downloadDraftAttachment(attachment),
          };
        }),
      );
      const restored = restoredResults.flatMap(result =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const failedAttachments = restoredResults.flatMap((result, index) => {
        if (result.status === "fulfilled") return [];
        const id = draft.attachmentIds[index]!;
        const attachment = attachmentById.get(id);
        return [{
          id,
          name: attachment?.name ?? "Staged attachment",
          kind: "attachment" as const,
          ...(attachment ? { attachment } : {}),
        }];
      }).filter(item => !locallyRemovedDraftAttachmentIds.current.has(item.id));
      let restoredPastedText: string | undefined;
      let failedPastedText: FailedDraftContent | undefined;
      if (draft.pastedTextAttachmentId) {
        try {
          if (!draft.pastedTextAttachment) {
            throw new Error("Pasted-text metadata is unavailable.");
          }
          restoredPastedText = await (
            await api.downloadDraftAttachment(draft.pastedTextAttachment)
          ).text();
        } catch {
          if (!locallyRemovedDraftAttachmentIds.current.has(
            draft.pastedTextAttachmentId,
          )) {
            failedPastedText = {
              id: draft.pastedTextAttachmentId,
              name: "Pasted text",
              kind: "pasted-text",
              ...(draft.pastedTextAttachment
                ? { attachment: draft.pastedTextAttachment }
                : {}),
            };
          }
        }
      }
      if (
        cancelled ||
        hydrationGeneration !== draftHydrationGeneration.current ||
        draft.revision < draftRevision.current
      )
        return;
      if (!draftAttachmentsLocallyEdited.current) {
        replaceRestoredDraftAttachments(restored);
      } else {
        mergeRestoredDraftAttachments(restored);
      }
      unrestoredDraftAttachmentIds.current = failedAttachments.map(item => item.id);
      draftRevision.current = draft.revision;
      const local = draftStorageKey
        ? (readChatState(draftStorageKey) ?? "")
        : "";
      const adoptDraft = shouldAdoptHydratedDraft(
        inputRef.current?.isFocused() ?? false,
        draftLocallyEdited.current,
      );
      setFailedDraftContents([
        ...failedAttachments,
        ...(adoptDraft && failedPastedText ? [failedPastedText] : []),
      ]);
      if (adoptDraft) {
        pastedTextAttachmentId.current = draft.pastedTextAttachmentId;
        const hydrated = hydratedDraftContent(
          draft.revision,
          draft.text,
          local,
          draft.mentionBindings ?? [],
        );
        replaceText(hydrated.text);
        setKnownMentionBindings([...hydrated.mentionBindings]);
        replacePastedText(failedPastedText ? undefined : restoredPastedText);
        if (draftStorageKey) writeChatState(draftStorageKey, hydrated.text);
      }
      if (failedAttachments.length || (adoptDraft && failedPastedText)) {
        dispatchAttachments({
          type: "set_error",
          error: "Some staged draft content could not be restored.",
        });
      }
      draftReady.current = true;
      setDraftReadyVersion(value => value + 1);
    };
    void apply().catch(() => {
      if (
        !cancelled &&
        hydrationGeneration === draftHydrationGeneration.current
      ) {
        draftRevision.current = draft.revision;
        unrestoredDraftAttachmentIds.current = draft.attachmentIds.filter(
          id => !locallyRemovedDraftAttachmentIds.current.has(id),
        );
        const adoptDraft = shouldAdoptHydratedDraft(
          inputRef.current?.isFocused() ?? false,
          draftLocallyEdited.current,
        );
        setFailedDraftContents([
          ...draft.attachmentIds
            .filter(id => !locallyRemovedDraftAttachmentIds.current.has(id))
            .map(id => ({ id, name: "Staged attachment", kind: "attachment" as const })),
          ...(adoptDraft &&
              draft.pastedTextAttachmentId &&
              !locallyRemovedDraftAttachmentIds.current.has(draft.pastedTextAttachmentId)
            ? [{
                id: draft.pastedTextAttachmentId,
                name: "Pasted text",
                kind: "pasted-text" as const,
                ...(draft.pastedTextAttachment
                  ? { attachment: draft.pastedTextAttachment }
                  : {}),
              }]
            : []),
        ]);
        const local = draftStorageKey
          ? (readChatState(draftStorageKey) ?? "")
          : "";
        if (adoptDraft) {
          pastedTextAttachmentId.current = draft.pastedTextAttachmentId;
          const hydrated = hydratedDraftContent(
            draft.revision,
            draft.text,
            local,
            draft.mentionBindings ?? [],
          );
          replaceText(hydrated.text);
          setKnownMentionBindings([...hydrated.mentionBindings]);
          replacePastedText(undefined);
          if (draftStorageKey) writeChatState(draftStorageKey, hydrated.text);
        }
        if (!draftAttachmentsLocallyEdited.current) {
          dispatchAttachments({
            type: "replace",
            files: [],
            error: "Some staged draft content could not be restored.",
          });
        } else {
          dispatchAttachments({
            type: "set_error",
            error: "Some staged draft content could not be restored.",
          });
        }
        draftReady.current = true;
        setDraftReadyVersion(value => value + 1);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [conversationDraftId, draftQuery.data, draftStorageKey]);

  useEffect(() => {
    if (
      !conversationDraftId ||
      !draftReady.current ||
      !pastedText ||
      pastedTextAttachmentId.current ||
      pastedTextUploading
    ) return;
    const fingerprint = `${conversationDraftId}\u0000${pastedText}`;
    if (pastedTextUploadFailedFor.current === fingerprint) return;
    const generation = ++pastedTextUploadGeneration.current;
    setPastedTextUploading(true);
    void api.uploadDraftAttachment(
      conversationDraftId,
      draftOwnerId,
      new File([pastedText], PASTED_TEXT_DRAFT_NAME, { type: "text/plain" }),
    ).then(attachment => {
      if (
        generation !== pastedTextUploadGeneration.current ||
        pastedTextRef.current !== pastedText ||
        previousConversationDraftId.current !== conversationDraftId
      ) {
        void api.deleteDraftAttachment(
          conversationDraftId,
          draftOwnerId,
          attachment.id,
        ).catch(() => undefined);
        return;
      }
      pastedTextAttachmentId.current = attachment.id;
      pastedTextUploadFailedFor.current = undefined;
      setDraftReadyVersion(value => value + 1);
    }).catch((error: unknown) => {
      if (generation !== pastedTextUploadGeneration.current) return;
      pastedTextUploadFailedFor.current = fingerprint;
      setSendError(
        error instanceof Error ? error.message : "Pasted text could not be staged.",
      );
    }).finally(() => {
      if (generation === pastedTextUploadGeneration.current) {
        setPastedTextUploading(false);
      }
    });
  }, [
    conversationDraftId,
    draftOwnerId,
    draftReadyVersion,
    pastedText,
    pastedTextUploading,
  ]);

  useEffect(() => {
    if (conversationDraftId && !draftReady.current) return;
    const previous = appliedDefaultDestination.current;
    if (!defaultDestination) {
      appliedDefaultDestination.current = undefined;
      setActiveDefaultDestination(undefined);
      return;
    }
    const selectingDestination =
      previous?.selectionKey !== defaultDestination.selectionKey;
    if (destinationMode === "target-required") {
      appliedDefaultDestination.current = defaultDestination;
      setActiveDefaultDestination(undefined);
      const normalizedText = removeAllComposerDestinations(
        selectingDestination
          ? removeComposerDestinations(textRef.current, [
              NEW_AGENT_DESTINATION_HANDLE,
            ])
          : textRef.current,
        defaultDestination.handle,
      );
      if (normalizedText !== textRef.current) replaceText(normalizedText);
      return;
    }
    if (destinationMode !== "project-chat") {
      appliedDefaultDestination.current = undefined;
      setActiveDefaultDestination(undefined);
      return;
    }
    if (previous?.selectionKey === defaultDestination.selectionKey) {
      appliedDefaultDestination.current = defaultDestination;
      setActiveDefaultDestination(current =>
        current?.selectionKey === defaultDestination.selectionKey
          ? defaultDestination
          : current,
      );
      return;
    }
    appliedDefaultDestination.current = defaultDestination;
    const currentText = textRef.current;
    const nextText = selectingDestination
      ? removeComposerDestinations(currentText, [
          NEW_AGENT_DESTINATION_HANDLE,
        ])
      : currentText;
    const normalizedText = removeAllComposerDestinations(
      nextText,
      defaultDestination.handle,
    );
    const previousWasActive = Boolean(
      previous &&
      activeDefaultDestination?.selectionKey === previous.selectionKey,
    );
    const destinationWasInline = normalizedText !== nextText;
    const newAgentWasInline = nextText !== currentText;
    const mayActivate = normalizedText.trim().length === 0
      || previousWasActive
      || destinationWasInline
      || newAgentWasInline;
    if (mayActivate) {
      setActiveDefaultDestination(defaultDestination);
    } else {
      setActiveDefaultDestination(undefined);
    }
    if (normalizedText !== currentText) replaceText(normalizedText);
  }, [
    conversationDraftId,
    activeDefaultDestination?.selectionKey,
    defaultDestination?.binding?.currentTitle,
    defaultDestination?.handle,
    defaultDestination?.selectionKey,
    destinationMode,
    draftReadyVersion,
    replaceText,
  ]);

  useComposerDraftStorageWrite({
    draftStorageKey,
    text,
    textRef,
  });

  useEffect(() => {
    if (
      !conversationDraftId ||
      !draftReady.current ||
      !draftClientId.current ||
      !draftLocallyEdited.current
    )
      return;
    const timer = window.setTimeout(() => {
      // Store the extracted paste and its draft reference as one logical draft
      // update. A partial write must never make a reload silently lose it.
      if (pastedText && !pastedTextAttachmentId.current) return;
      const generation = draftGeneration.current;
      const editVersion = draftEditVersion.current;
      const visibleAttachmentIds = files
        .map(file => draftAttachmentIds.current.get(file))
        .filter(
          (id): id is string =>
            id !== undefined &&
            !locallyRemovedDraftAttachmentIds.current.has(id),
        );
      const attachmentIds = Array.from(
        new Set([
          ...unrestoredDraftAttachmentIds.current.filter(
            id => !locallyRemovedDraftAttachmentIds.current.has(id),
          ),
          ...visibleAttachmentIds,
        ]),
      );
      const attachmentsResolved =
        visibleAttachmentIds.length === files.length;
      const clientId = draftClientId.current!;
      draftWriteChain.current = draftWriteChain.current.then(async () => {
        if (generation !== draftGeneration.current) return;
        try {
          const draft = await api.putConversationDraft(conversationDraftId, {
            text,
            attachmentIds,
            ...(pastedTextAttachmentId.current
              ? { pastedTextAttachmentId: pastedTextAttachmentId.current }
              : {}),
            mentionBindings: knownMentionBindings,
            expectedRevision: draftRevision.current,
            clientId,
            ownerId: draftOwnerId,
          });
          if (generation !== draftGeneration.current) return;
          draftRevision.current = draft.revision;
          if (
            draftEditVersion.current === editVersion &&
            attachmentsResolved
          ) {
            draftLocallyEdited.current = false;
            draftAttachmentsLocallyEdited.current = false;
          }
          queryClient.setQueryData(
            queryKeys.conversationDraft.detail(
              conversationDraftId,
              draftOwnerId,
            ),
            draft,
          );
        } catch (error) {
          if (!(error instanceof ApiRequestError) || error.status !== 409) {
            setSendError(
              error instanceof Error
                ? error.message
                : "Draft could not be saved.",
            );
            return;
          }
          const current = await api.getConversationDraft(
            conversationDraftId,
            draftOwnerId,
          );
          draftGeneration.current += 1;
          draftRevision.current = current.revision;
          queryClient.setQueryData(
            queryKeys.conversationDraft.detail(
              conversationDraftId,
              draftOwnerId,
            ),
            current,
          );
          const conflicts = await api
            .getConversationDraftConflicts(conversationDraftId, draftOwnerId)
            .catch(() => undefined);
          const displaced = conflicts?.conflicts.at(-1);
          if (displaced) setDraftConflict(displaced);
        }
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [
    conversationDraftId,
    draftAttachmentVersion,
    draftOwnerId,
    draftReadyVersion,
    failedDraftContents.length,
    files,
    queryClient,
    knownMentionBindings,
    pastedText,
    text,
  ]);

  // Agent routing uses #; @ is reserved for project file/folder references.
  const mentionMatch = activeComposerMention(text.slice(0, caret));
  const autocompleteHandles = [...new Set([
    ...(mentionSuggestionHandles ?? mentionHandles ?? []),
    ...((destinationMode === "project-chat" || destinationMode === "target-required")
      ? [NEW_AGENT_DESTINATION_HANDLE]
      : []),
  ])];
  const suggestions =
    mentionMatch && autocompleteHandles && autocompleteHandles.length > 0
      ? autocompleteHandles.filter(handle =>
          handle
            .toLowerCase()
            .startsWith(mentionMatch.handlePrefix.toLowerCase()),
        )
      : [];
  const fileMatch = /(?:^|\s)@([^\s@#]*)$/u.exec(text.slice(0, caret));
  const filePrefix = fileMatch?.[1] ?? "";
  const [fileEntries, setFileEntries] = useState<ArtifactDto[]>([]);
  const fileReferenceActive = Boolean(fileMatch);
  useEffect(() => {
    let cancelled = false;
    if (!projectId || !fileReferenceActive) {
      setFileEntries([]);
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      const items: ArtifactDto[] = [];
      let cursor: string | undefined;
      do {
        const response = await api.listProjectArtifacts(projectId, 500, cursor);
        items.push(...response.items);
        const nextCursor = response.history.hasMore
          ? response.history.cursor
          : undefined;
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      } while (!cancelled);
      return items;
    })()
      .then(items => {
        if (!cancelled) setFileEntries(items);
      })
      .catch(() => {
        if (!cancelled) setFileEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fileReferenceActive, projectId]);
  const fileSuggestions = fileMatch
    ? fileEntries.filter(entry =>
        entry.path
          .toLocaleLowerCase()
          .includes(filePrefix.toLocaleLowerCase()),
      )
    : [];
  const commandDraft = providerCommandInput(
    text.slice(0, caret),
    commandTargetHandle,
  );
  const slashMatch = commandDraft
    ? /^\/([\p{L}\p{N}_:-]*)$/u.exec(commandDraft.text)
    : null;
  const commandSuggestions =
    slashMatch && commands
      ? matchingEngineCommands(commands, slashMatch[1]!)
      : [];
  const menuSuggestions: ComposerMenuSuggestion[] =
    commandSuggestions.length > 0
      ? commandSuggestions.map(command => ({
          kind: "command" as const,
          command,
        }))
      : suggestions.length > 0
        ? suggestions.map(handle => ({ kind: "mention" as const, handle }))
        : fileSuggestions.map(entry => ({ kind: "file" as const, entry }));
  const menuOpen = menuSuggestions.length > 0 && !suppressMenu;
  const effectiveHighlighted = clampComposerMenuIndex(
    highlighted,
    menuSuggestions.length,
  );

  const applyMention = (handle: string) => {
    const start = mentionMatch!.start;
    const specialTitle = SPECIAL_MENTION_TITLES.get(handle.toLocaleLowerCase());
    if (
      (destinationMode === "target-required" || destinationMode === "project-chat") &&
      handle.toLocaleLowerCase() === NEW_AGENT_DESTINATION_HANDLE
    ) {
      const next = selectExclusiveNewAgentDestination(
        text,
        start,
        caret,
        [
          ...targetRequiredHandles,
          ...authoredProjectDestinationHandles,
          "broadcast",
          "everyone",
        ],
      );
      requiredRecipient?.onClear();
      update(next);
      setHighlighted(0);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        const nextCaret = inputRef.current?.getCanonicalText().length ?? 0;
        inputRef.current?.setSelectionOffsets(nextCaret, nextCaret);
        setCaret(nextCaret);
      });
      return;
    }
    const binding = (mentionBindings ?? []).find(candidate =>
      [candidate.handle, candidate.currentHandle].some(
        candidateHandle =>
          candidateHandle.toLocaleLowerCase() === handle.toLocaleLowerCase(),
      ),
    );
    const descriptor = specialTitle
      ? {
          kind: "special" as const,
          handle,
          title: specialTitle,
          valid: true,
        }
      : binding
        ? {
            kind: "agent" as const,
            agentId: binding.agentId,
            handle: binding.currentHandle,
            title: binding.currentTitle,
            valid: true,
          }
        : undefined;
    const selection =
      descriptor &&
        handle.toLocaleLowerCase() !== NEW_AGENT_DESTINATION_HANDLE &&
        (destinationMode === "target-required" || destinationMode === "project-chat")
        ? removeComposerDestinationsAroundSelection(
            text,
            start,
            caret,
            [NEW_AGENT_DESTINATION_HANDLE],
          )
        : { text, start, end: caret };
    if (inputRef.current && descriptor) {
      if (selection.text !== text) {
        inputRef.current.replaceCanonicalRange(0, text.length, selection.text);
      }
      inputRef.current.setSelectionOffsets(selection.start, selection.end);
      inputRef.current.insertMention(descriptor);
      inputRef.current.insertText(" ");
    } else {
      update(
        `${selection.text.slice(0, selection.start)}#${handle} ${selection.text.slice(selection.end)}`,
      );
    }
    setHighlighted(0);
    const nextCaret = selection.start + handle.length + 2;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionOffsets(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  };

  const applyFileReference = (entry: ArtifactDto) => {
    const start = caret - fileMatch![0].length + fileMatch![0].indexOf("@");
    const filename = entry.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? entry.path;
    const descriptor: ComposerProjectFileDescriptor = {
      projectId: projectId!,
      artifactId: entry.id,
      historicalFilename: filename,
      currentFilename: filename,
    };
    inputRef.current?.insertProjectFile(
      descriptor,
      { start, end: caret },
      " ",
    );
    setHighlighted(0);
    const nextCaret = start + projectFileCanonicalText(descriptor).length + 1;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionOffsets(nextCaret, nextCaret);
      setCaret(nextCaret);
      setSuppressMenu(false);
    });
  };

  const applyCommand = (command: EngineCommand) => {
    if (engineCommandDisabledReason(command)) return;
    if (!commandDraft) return;
    inputRef.current?.replaceCanonicalRange(
      commandDraft.start,
      caret,
      command.insertText,
    );
    setHighlighted(0);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const nextCaret = commandDraft.start + command.insertText.length;
      el.setSelectionOffsets(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  };

  const applyCapability = (capability: EngineComposerCapability) => {
    const inserted = insertComposerCapability(text, caret, capability);
    if (!inserted) return;
    inputRef.current?.replaceCanonicalRange(0, text.length, inserted.text);
    setCapabilityMenuAnchor(null);
    setCapabilityFilter("");
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionOffsets(inserted.caret, inserted.caret);
      setCaret(inserted.caret);
    });
  };

  const visibleCapabilities = matchingComposerCapabilities(
    capabilities ?? [],
    capabilityFilter,
  );

  const submit = (
    handler: (
      message: string,
      selectedFiles: File[],
      stagedAttachmentIds?: string[],
      stagedDraftOwnerId?: string,
      context?: {
        mentionedAgents?: import("@ponderosa/core").AgentMentionBindingDto[];
        newAgentRequested?: boolean;
      },
    ) => Promise<unknown> | unknown,
  ) => {
    if (dictationSettlingRef.current) {
      setSendError(
        "Stop voice dictation and wait for final text before sending.",
      );
      return;
    }
    if (sendingRef.current || !canSend) return;
    const normalizedDraft = normalizeExclusiveNewAgentDestinationForMode(
      destinationMode,
      textRef.current,
      exclusiveDestinationHandles,
    ).text;
    const safeNewAgentSelected =
      routingDestinationsEnabled &&
      hasComposerDestination(
        normalizedDraft,
        NEW_AGENT_DESTINATION_HANDLE,
      );
    const safeVisibleText = safeNewAgentSelected
      ? singleComposerDestination(
          normalizedDraft,
          NEW_AGENT_DESTINATION_HANDLE,
        )
      : normalizedDraft;
    const safeComposedText = composerSubmissionText(
      safeVisibleText,
      pastedTextRef.current,
    );
    const safeDefaultDestination = safeNewAgentSelected
      ? undefined
      : destinationMode === "target-required"
        ? defaultDestination
        : activeDefaultDestination;
    const safeSubmissionText =
      (destinationMode === "project-chat" || destinationMode === "target-required") &&
      safeDefaultDestination
        ? prependComposerDestination(
            safeComposedText,
            safeDefaultDestination.handle,
          )
        : safeComposedText;
    const safeRoutingText = safeDefaultDestination
      ? prependComposerDestination(
          safeVisibleText,
          safeDefaultDestination.handle,
        )
      : safeVisibleText;
    const safeMentionedHandles = findMentionedHandles(
      safeRoutingText,
      routingMentionHandles,
    );
    if (normalizedDraft !== textRef.current) update(normalizedDraft);
    const commandSubmission = providerCommandInput(
      safeSubmissionText,
      commandTargetHandle,
    );
    const slash =
      files.length === 0 && commands !== undefined && commandSubmission
        ? providerSlashSubmission(commandSubmission.text, commands)
        : undefined;
    if (slash && "error" in slash) {
      setSendError(slash.error);
      return;
    }
    if (slash && slash.command.invocation === "runtime" && !onCommand) {
      setSendError(
        `/${slash.command.name} requires a structured provider action that is unavailable here.`,
      );
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setSendError(undefined);
    const submittedText = normalizedDraft;
    const submittedPastedText = pastedTextRef.current;
    const submittedUserMutationGeneration =
      userDraftMutationGeneration.current;
    const stagedIds = files
      .map(file => draftAttachmentIds.current.get(file))
      .filter(
        (id): id is string =>
          id !== undefined &&
          !locallyRemovedDraftAttachmentIds.current.has(id),
      );
    const mentionedAgentsById = new Map<string, AgentMentionBindingDto>();
    if (safeDefaultDestination?.binding) {
      mentionedAgentsById.set(
        safeDefaultDestination.binding.agentId,
        safeDefaultDestination.binding,
      );
    }
    const structurallyAuthoredHandles =
      destinationMode === "target-required" || destinationMode === "project-chat"
        ? safeMentionedHandles.filter(
            handle => !["broadcast", "everyone", NEW_AGENT_DESTINATION_HANDLE]
              .includes(handle.toLocaleLowerCase()),
          )
        : [];
    for (const handle of structurallyAuthoredHandles) {
      const binding = resolvedMentionBinding(
        handle,
        knownMentionBindings,
        mentionBindings ?? [],
      );
      if (binding) {
        mentionedAgentsById.set(binding.agentId, binding);
      }
    }
    const mentionedAgents = [...mentionedAgentsById.values()];
    const submissionContext = mentionedAgents.length > 0 || safeNewAgentSelected
      ? { mentionedAgents, newAgentRequested: safeNewAgentSelected }
      : undefined;
    const runtimeCommandSubmission =
      slash?.command.invocation === "runtime";
    const operation =
      runtimeCommandSubmission
        ? onCommand!(slash.command, slash.argumentsText)
        : handler(
            safeSubmissionText,
            files,
            stagedIds,
            conversationDraftId ? draftOwnerId : undefined,
            submissionContext,
          );
    void Promise.resolve(operation)
      .then(() => {
        const draftChangedAfterSubmission =
          userDraftMutationGeneration.current !==
          submittedUserMutationGeneration;
        const preserveNewRuntimeDraft =
          runtimeCommandSubmission && draftChangedAfterSubmission;
        // A successful send can settle after this Composer has unmounted. Do
        // not rely on controlled-input effects to clear its durable draft. A
        // runtime command is the exception: it submits no message or files, so
        // preserve anything the user starts composing while it is pending.
        if (!preserveNewRuntimeDraft) {
          draftGeneration.current += 1;
          draftEditVersion.current += 1;
          draftLocallyEdited.current = false;
          draftAttachmentsLocallyEdited.current = false;
          unrestoredDraftAttachmentIds.current = [];
          replaceText("");
          setKnownMentionBindings([]);
          setActiveDefaultDestination(undefined);
          if (draftStorageKey) writeChatState(draftStorageKey, "");
          replacePastedText(undefined);
          clearDraftAttachments();
        }
        if (
          !preserveNewRuntimeDraft &&
          conversationDraftId &&
          draftClientId.current
        ) {
          const clientId = draftClientId.current;
          draftWriteChain.current = draftWriteChain.current
            .catch(() => undefined)
            .then(async () => {
              const clearSavedDraft = (expectedRevision: number) =>
                api.putConversationDraft(conversationDraftId, {
                  text: "",
                  attachmentIds: [],
                  mentionBindings: [],
                  expectedRevision,
                  clientId,
                  ownerId: draftOwnerId,
                });
              try {
                let clearedDraft;
                try {
                  clearedDraft = await clearSavedDraft(draftRevision.current);
                } catch (error) {
                  if (
                    !(error instanceof ApiRequestError) ||
                    error.status !== 409
                  )
                    throw error;
                  // A save that was already in flight can commit after send
                  // invalidates its local generation. Refresh once and clear
                  // against that committed revision. Never loop on a second
                  // conflict: another writer should surface as a warning.
                  const current = await api.getConversationDraft(
                    conversationDraftId,
                    draftOwnerId,
                  );
                  // Owner IDs are shared by tabs; only this page's client ID
                  // proves the conflicting revision came from our own chain.
                  if (current.clientId !== clientId) throw error;
                  clearedDraft = await clearSavedDraft(current.revision);
                }
                if (
                  previousConversationDraftId.current === conversationDraftId
                ) {
                  draftRevision.current = clearedDraft.revision;
                }
                queryClient.setQueryData(
                  queryKeys.conversationDraft.detail(
                    conversationDraftId,
                    draftOwnerId,
                  ),
                  clearedDraft,
                );
              } catch {
                setSendError(
                  "Message sent, but its saved draft could not be cleared.",
                );
              }
            });
        }
        if (conversationDraftId)
          for (const id of stagedIds)
            void api
              .deleteDraftAttachment(conversationDraftId, draftOwnerId, id)
              .catch(() => undefined);
        if (conversationDraftId && pastedTextAttachmentId.current) {
          const id = pastedTextAttachmentId.current;
          pastedTextAttachmentId.current = undefined;
          void api
            .deleteDraftAttachment(conversationDraftId, draftOwnerId, id)
            .catch(() => undefined);
        }
        if (!preserveNewRuntimeDraft) setCaret(0);
      })
      .catch((error: unknown) => {
        if (
          userDraftMutationGeneration.current ===
          submittedUserMutationGeneration
        ) {
          replaceText(submittedText);
          replacePastedText(submittedPastedText);
          if (draftStorageKey) writeChatState(draftStorageKey, submittedText);
        }
        setSendError(
          error instanceof Error ? error.message : "Upload failed; try again.",
        );
      })
      .finally(() => {
        sendingRef.current = false;
        setSending(false);
      });
  };
  const steer = () => submit(onSend);
  const queue = () => {
    if (!onQueue) return;
    submit(onQueue);
  };
  const send = steer;
  const showQueue =
    Boolean(onQueue) &&
    shouldShowQueueControl({
      text: submissionText,
      hasAttachments: files.length > 0,
      agentResponding:
        agentResponding ||
        mentionedBusyHandles.length > 0,
      disabled,
    });
  return (
    <Paper
      className="ponderosa-composer"
      elevation={0}
      sx={composerSurfaceSx}
    >
      <ComposerDestinationBar
        destinationError={destinationError}
        destinationMode={destinationMode}
      />
      <ComposerAttachmentList
        draftUploadStates={draftUploadStates}
        files={files}
        removeFile={removeFile}
        retryDraftUpload={retryDraftUpload}
      />
      <ComposerNotices
        pastedText={pastedText}
        pastedTextBytes={pastedText ? utf8ByteLength(pastedText) : 0}
        error={attachments.error ?? sendError}
        displacedDraft={draftConflict?.displaced.text}
        failedDraftContents={failedDraftContents}
        onShowPastedText={() => {
          update(composerSubmissionText(text, pastedText ?? ""));
          updatePastedText(undefined);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        onRemovePastedText={() => {
          updatePastedText(undefined);
        }}
        onRestoreDraft={() => {
          if (!draftConflict) return;
          setKnownMentionBindings(draftConflict.displaced.mentionBindings ?? []);
          update(draftConflict.displaced.text);
          setDraftConflict(undefined);
          inputRef.current?.focus();
        }}
        onRetryDraftContent={id => {
          void retryFailedDraftContent(id);
        }}
        onRemoveDraftContent={removeFailedDraftContent}
        onClearError={() => {
          setSendError(undefined);
          dispatchAttachments({ type: "clear_error" });
          if (pastedText) {
            pastedTextUploadFailedFor.current = undefined;
            setDraftReadyVersion(value => value + 1);
          }
        }}
      />
      <Stack
        direction="row"
        spacing={{ xs: 0.25, sm: 0.5 }}
        useFlexGap
        sx={{ alignItems: "center", flexWrap: "wrap" }}
      >
        <ComposerCapabilityPicker
          fileInput={fileInput}
          disabled={disabled || composerLocked}
          menuAnchor={capabilityMenuAnchor}
          listId={capabilityListId}
          filter={capabilityFilter}
          attachmentsEnabled={composerAttachmentsEnabled}
          attachmentsUnavailableReason={composerAttachmentsUnavailableReason}
          fileCount={files.length}
          assetLimits={assetLimits}
          capabilities={capabilities}
          visibleCapabilities={visibleCapabilities}
          onFiles={addFiles}
          onOpen={anchor => {
            setCapabilityFilter("");
            setCapabilityMenuAnchor(anchor);
            void Promise.resolve(onCapabilitiesOpen?.()).catch(() => undefined);
          }}
          onClose={() => {
            setCapabilityMenuAnchor(null);
            setCapabilityFilter("");
          }}
          onFilterChange={setCapabilityFilter}
          onApplyCapability={applyCapability}
        />
        {enableVoiceDictation ? (
          <DictationControls
            disabled={disabled || composerLocked || sending}
            onFinalTranscript={insertDictatedText}
            onSettlingChange={handleDictationSettlingChange}
          />
        ) : null}
        {destinationMode === "project-chat" ? (
          <ComposerProjectDestinationAction
            newAgentSelected={newAgentSelected}
            toggleNewAgent={toggleNewAgentDestination}
            replyDestination={!newAgentSelected && defaultDestination && mentionedHandles.some(
              handle => handle.toLocaleLowerCase() === defaultDestination.handle.toLocaleLowerCase(),
            )
              ? defaultDestination.binding?.currentTitle ?? defaultDestination.handle
              : undefined}
          />
        ) : null}
        {leadingControls ? (
          <Box sx={{ minWidth: 0, maxWidth: "100%" }}>
            {leadingControls}
          </Box>
        ) : null}
        <Box sx={{ flex: 1, minWidth: { xs: 0, sm: 24 } }} />
        {controls ? (
          <Box sx={{ minWidth: 0, maxWidth: "100%", overflowX: "auto" }}>
            {controls}
          </Box>
        ) : null}
        <Box ref={anchorRef} sx={{ order: -1, flex: "1 0 100%", minWidth: 0 }}>
          <ComposerTextInput
            text={text}
            inputRef={inputRef}
            disabled={disabled}
            locked={composerLocked}
            placeholder={placeholder}
            comboboxEnabled={Boolean(mentionHandles || commands?.length || projectId)}
            menuOpen={menuOpen}
            listId={mentionListId}
            highlighted={effectiveHighlighted}
            attachmentsEnabled={composerAttachmentsEnabled}
            pastedText={pastedText}
            menuSuggestions={menuSuggestions}
            destinationMode={destinationMode}
            requiredRecipient={requiredRecipient}
            inlineDestination={renderedDefaultDestination
              ? {
                  handle: renderedDefaultDestination.handle,
                  title:
                    renderedDefaultDestination.binding?.currentTitle ??
                    renderedDefaultDestination.handle,
                  agentId: renderedDefaultDestination.binding?.agentId,
                  onClear: destinationMode === "target-required"
                    ? clearRequiredRecipient
                    : clearActiveDefaultDestination,
                }
              : undefined}
            mentionTokens={mentionTokens}
            mentionBindings={mentionBindings ?? []}
            mentionedBusyHandles={mentionedBusyHandles}
            mentionedHandles={mentionedHandles}
            canSend={canSend}
            onTextChange={(value, nextCaret) => {
              const normalized = normalizeExclusiveNewAgentDestinationForMode(
                destinationMode,
                value,
                exclusiveDestinationHandles,
                nextCaret,
              );
              update(normalized.text);
              setSendError(undefined);
              setCaret(normalized.caret);
              setHighlighted(0);
              setSuppressMenu(false);
              if (normalized.text !== value) {
                requestAnimationFrame(() => {
                  inputRef.current?.setSelectionOffsets(
                    normalized.caret,
                    normalized.caret,
                  );
                });
              }
            }}
            onFiles={addFiles}
            onPastedText={value => {
              updatePastedText(value);
              setSendError(undefined);
            }}
            onPasteError={setSendError}
            onHighlightChange={setHighlighted}
            onSuppressMenu={() => setSuppressMenu(true)}
            onApplySuggestion={selected => {
              if (selected.kind === "mention") applyMention(selected.handle);
              else if (selected.kind === "file") applyFileReference(selected.entry);
              else applyCommand(selected.command);
            }}
            onClearRequiredRecipient={clearRequiredRecipient}
            onSend={send}
          />
          <ComposerAutocompleteMenu
            open={menuOpen}
            anchor={anchorRef.current}
            listId={mentionListId}
            suggestions={menuSuggestions}
            highlighted={effectiveHighlighted}
            onDismiss={() => setSuppressMenu(true)}
            onSelect={selected => {
              if (selected.kind === "mention") applyMention(selected.handle);
              else if (selected.kind === "file") applyFileReference(selected.entry);
              else applyCommand(selected.command);
            }}
          />
        </Box>
        <ComposerSendActions
          allowSendWhileRunning={allowSendWhileRunning}
          canCancel={canCancel}
          cancelPending={cancelPending}
          canSend={canSend}
          destinationError={destinationError}
          destinationMode={destinationMode}
          mentionedBusyHandles={mentionedBusyHandles}
          onCancel={onCancel}
          queue={queue}
          recipientRequiredMessage={recipientRequiredMessage}
          sendUnavailableReason={
            dictationSettling
              ? "Stop voice dictation and wait for final text before sending."
              : sendUnavailableReason
          }
          send={send}
          showQueue={showQueue}
          steer={steer}
          targetRequiredRecipientTagged={targetRequiredRecipientTagged}
        />
      </Stack>
    </Paper>
  );
}
