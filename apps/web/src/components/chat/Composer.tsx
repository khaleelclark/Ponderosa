import {
  Box,
  Paper,
  Stack,
} from "@mui/material";
import { utf8ByteLength } from "@ponderosa/core";
import type {
  ConversationDraftConflictDto,
  DraftAttachmentDto,
  EngineCommand,
  EngineComposerCapability,
  FileEntryDto,
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
  hasComposerDestination,
  NEW_AGENT_DESTINATION_HANDLE,
  prependComposerDestination,
} from "./composerDestination";
import type { ComposerProps } from "./Composer.types";
import {
  ComposerAttachmentList,
  ComposerDestinationBar,
  ComposerProjectDestinationAction,
  ComposerSendActions,
  ComposerTargetDestinationAction,
} from "./Composer.parts";
import {
  ComposerAutocompleteMenu,
  ComposerCapabilityPicker,
  ComposerNotices,
  ComposerTextInput,
  type ComposerMenuSuggestion,
} from "./Composer.controls";
import {
  canSubmitComposerText,
  composerAttachmentReducer,
  composerSubmissionText,
  engineCommandDisabledReason,
  insertComposerCapability,
  matchingComposerCapabilities,
  matchingEngineCommands,
  providerSlashSubmission,
  shouldShowQueueControl,
} from "./composerUtils";
import { useComposerDraftAttachments } from "./useComposerDraftAttachments";
import {
  useComposerDraftStorageReset,
  useComposerDraftStorageWrite,
  useComposerInsertTextRequest,
  useComposerMentionedHandlesChange,
} from "./useComposerTextEffects";
import { composerSurfaceSx } from "./Composer.styles";

const DRAFT_OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export type { ComposerProps } from "./Composer.types";

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
  const [draftReadyVersion, setDraftReadyVersion] = useState(0);
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
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
  const appliedDefaultDestination = useRef<{
    handle: string;
    selectionKey: string;
  }>();
  const [activeDefaultDestination, setActiveDefaultDestination] = useState<{
    handle: string;
    selectionKey: string;
  }>();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
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
      markUserDraftMutation();
      replacePastedText(next);
    },
    [markUserDraftMutation, replacePastedText],
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
  const composedText = composerSubmissionText(text, pastedText);
  const submissionText =
    destinationMode === "project-chat" && activeDefaultDestination
      ? prependComposerDestination(
          composedText,
          activeDefaultDestination.handle,
        )
      : composedText;
  const routingMentionHandles = useMemo(
    () =>
      destinationMode === "project-chat"
        ? [...new Set([...(mentionHandles ?? []), NEW_AGENT_DESTINATION_HANDLE])]
        : (mentionHandles ?? []),
    [destinationMode, mentionHandles],
  );
  const mentionedHandles = useMemo(
    () => findMentionedHandles(submissionText, routingMentionHandles),
    [routingMentionHandles, submissionText],
  );
  const newAgentSelected =
    destinationMode === "project-chat" &&
    mentionedHandles.some(
      handle =>
        handle.toLocaleLowerCase() === NEW_AGENT_DESTINATION_HANDLE,
    );
  const projectDestinationHandles =
    destinationMode === "project-chat"
      ? mentionedHandles.filter(
          handle =>
            ![
              "broadcast",
              "everyone",
              NEW_AGENT_DESTINATION_HANDLE,
            ].includes(handle.toLocaleLowerCase()),
        )
      : [];
  const projectDestinations = projectDestinationHandles.map(handle => ({
    handle,
  }));
  const targetRequiredHandles =
    destinationMode === "target-required"
      ? mentionedHandles.filter(
          handle =>
            !["broadcast", "everyone"].includes(handle.toLocaleLowerCase()),
        )
      : [];
  const targetRequiredDestinations = targetRequiredHandles.map(handle => ({
    handle,
  }));
  const ambiguousTargetRequiredHandles =
    destinationMode === "target-required"
      ? findMentionedHandles(submissionText, ambiguousMentionHandles ?? [])
      : [];
  const unresolvedAmbiguousTarget = ambiguousTargetRequiredHandles.find(
    handle =>
      !requiredRecipient ||
      requiredRecipient.handle.toLocaleLowerCase() !==
        handle.toLocaleLowerCase(),
  );
  const hasBroadcastDestination = hasBroadcastMention(submissionText);
  const hasEveryoneDestination =
    destinationMode === "project-chat" &&
    mentionedHandles.some(handle => handle.toLocaleLowerCase() === "everyone");
  const targetedNextRunDelivery =
    hasBroadcastDestination && projectDestinations.length > 0;
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
  useEffect(() => {
    onCommandTargetHandleChange?.(commandTargetHandle);
  }, [commandTargetHandle, onCommandTargetHandleChange]);
  const destinationError =
    newAgentSelected &&
    (hasBroadcastDestination ||
      hasEveryoneDestination ||
      projectDestinations.length > 0)
      ? "#new-agent cannot be combined with another destination."
      : targetedNextRunDelivery && files.length > 0
      ? "Targeted next-run delivery supports message text only. Remove attachments to send."
      : destinationMode === "target-required" && hasBroadcastDestination
      ? targetRequiredDestinations.length > 0
        ? "Broadcast is only available in a Project Chat."
        : "#broadcast is not available in Messages Across Ponderosa. Choose an Agent."
      : destinationMode === "target-required" &&
          targetRequiredDestinations.length > 1
        ? "Choose one Agent at a time in Messages Across Ponderosa."
        : destinationMode === "target-required" && unresolvedAmbiguousTarget
          ? `#${unresolvedAmbiguousTarget} matches more than one Agent. Use a message's # action to choose the exact Agent.`
          : undefined;
  const toggleNewAgentDestination = () => {
    setActiveDefaultDestination(undefined);
    update(current => {
      if (hasComposerDestination(current, NEW_AGENT_DESTINATION_HANDLE)) {
        return removeHandle(current, NEW_AGENT_DESTINATION_HANDLE);
      }
      let next = current;
      for (const handle of [
        "broadcast",
        "everyone",
        ...projectDestinationHandles,
      ]) {
        next = removeHandle(next, handle);
      }
      return prependComposerDestination(next, NEW_AGENT_DESTINATION_HANDLE);
    });
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const clearRequiredRecipient = () => {
    const handle = targetRequiredHandles[0] ?? requiredRecipient?.handle;
    if (handle) update(current => removeHandle(current, handle));
    requiredRecipient?.onClear();
  };
  const clearTargetDestinations = () => {
    update(current => {
      let next = current;
      if (hasBroadcastDestination) {
        next = removeHandle(next, "broadcast");
      }
      for (const handle of targetRequiredHandles) {
        next = removeHandle(next, handle);
      }
      return next;
    });
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
    Boolean(
      requiredRecipient &&
      targetRequiredHandles.length === 1 &&
      requiredRecipient.handle.toLocaleLowerCase() ===
        targetRequiredHandles[0]!.toLocaleLowerCase(),
    );
  const draftUploadsReady =
    !conversationDraftId ||
    files.every(file => draftAttachmentIds.current.has(file));
  const canSend =
    !sending &&
    !destinationError &&
    targetRequiredRecipientTagged &&
    draftUploadsReady &&
    (textCanSend ||
      (!disabled &&
        !composerLocked &&
        allowUnmentionedSend &&
        files.length > 0));
  const canCancel = running && Boolean(onCancel);
  const composerAttachmentsEnabled = attachmentsEnabled && !targetedNextRunDelivery;
  const composerAttachmentsUnavailableReason = targetedNextRunDelivery
    ? "Targeted next-run delivery supports message text only."
    : attachmentsUnavailableReason;

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
      draftReady.current = false;
      draftLocallyEdited.current = false;
      draftAttachmentsLocallyEdited.current = false;
      unrestoredDraftAttachmentIds.current = [];
      draftRevision.current = 0;
      clearDraftAttachments();
    }
  }, [conversationDraftId]);

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
      const restored = await Promise.all(
        (draft.attachments ?? []).map(
          async (attachment: DraftAttachmentDto) => ({
            attachment,
            file: await api.downloadDraftAttachment(attachment),
          }),
        ),
      );
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
      unrestoredDraftAttachmentIds.current = [];
      draftRevision.current = draft.revision;
      const local = draftStorageKey
        ? (readChatState(draftStorageKey) ?? "")
        : "";
      const focusedOrEdited =
        document.activeElement === inputRef.current ||
        draftLocallyEdited.current;
      if (!focusedOrEdited) {
        const nextText =
          draft.revision === 0 && local && !draft.text ? local : draft.text;
        replaceText(nextText);
        if (draftStorageKey) writeChatState(draftStorageKey, nextText);
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
        const focusedOrEdited =
          document.activeElement === inputRef.current ||
          draftLocallyEdited.current;
        const local = draftStorageKey
          ? (readChatState(draftStorageKey) ?? "")
          : "";
        if (!focusedOrEdited && !local) {
          replaceText(draft.text);
          if (draftStorageKey) writeChatState(draftStorageKey, draft.text);
        }
        if (!draftAttachmentsLocallyEdited.current) {
          dispatchAttachments({
            type: "replace",
            files: [],
            error: "Some staged draft attachments could not be restored.",
          });
        } else {
          dispatchAttachments({
            type: "set_error",
            error: "Some staged draft attachments could not be restored.",
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
    if (conversationDraftId && !draftReady.current) return;
    const previous = appliedDefaultDestination.current;
    if (!defaultDestination || destinationMode !== "project-chat") {
      appliedDefaultDestination.current = undefined;
      setActiveDefaultDestination(undefined);
      return;
    }
    if (previous?.selectionKey === defaultDestination.selectionKey) return;
    appliedDefaultDestination.current = defaultDestination;
    let nextText = textRef.current;
    if (previous && hasComposerDestination(nextText, previous.handle)) {
      nextText = removeHandle(nextText, previous.handle);
    }
    const containedLegacyDestination = hasComposerDestination(
      nextText,
      defaultDestination.handle,
    );
    if (containedLegacyDestination) {
      nextText = removeHandle(nextText, defaultDestination.handle);
    }
    const mayPopulate =
      nextText.trim().length === 0 ||
      Boolean(previous) ||
      containedLegacyDestination;
    if (nextText !== textRef.current) replaceText(nextText);
    setActiveDefaultDestination(mayPopulate ? defaultDestination : undefined);
  }, [
    conversationDraftId,
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
    files,
    queryClient,
    text,
  ]);

  // Agent routing uses #; @ is reserved for project file/folder references.
  const mentionMatch = /(?:^|\s)#([\p{L}\p{N}_-]*)$/u.exec(
    text.slice(0, caret),
  );
  const autocompleteHandles = mentionSuggestionHandles ?? mentionHandles;
  const suggestions =
    mentionMatch && autocompleteHandles && autocompleteHandles.length > 0
      ? autocompleteHandles.filter(handle =>
          handle.toLowerCase().startsWith(mentionMatch[1]!.toLowerCase()),
        )
      : [];
  const fileMatch = /(?:^|\s)@([^\s@#]*)$/u.exec(text.slice(0, caret));
  const fileToken = fileMatch?.[1] ?? "";
  const fileSlash = fileToken.lastIndexOf("/");
  const fileDirectory = fileSlash >= 0 ? fileToken.slice(0, fileSlash) : "";
  const filePrefix =
    fileSlash >= 0 ? fileToken.slice(fileSlash + 1) : fileToken;
  const [fileEntries, setFileEntries] = useState<FileEntryDto[]>([]);
  const fileReferenceActive = Boolean(fileMatch);
  useEffect(() => {
    let cancelled = false;
    if (!projectId || !fileReferenceActive) {
      setFileEntries([]);
      return () => {
        cancelled = true;
      };
    }
    void api
      .getFiles(projectId, fileDirectory)
      .then(response => {
        if (!cancelled)
          setFileEntries(response.kind === "dir" ? response.entries : []);
      })
      .catch(() => {
        if (!cancelled) setFileEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fileDirectory, fileReferenceActive, projectId]);
  const fileSuggestions = fileMatch
    ? fileEntries.filter(entry =>
        entry.name
          .toLocaleLowerCase()
          .startsWith(filePrefix.toLocaleLowerCase()),
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

  const applyMention = (handle: string) => {
    const start =
      caret - mentionMatch![0].length + mentionMatch![0].indexOf("#");
    const next = `${text.slice(0, start)}#${handle} ${text.slice(caret)}`;
    update(next);
    setHighlighted(0);
    // Restore focus and place the caret after the inserted handle.
    const nextCaret = start + handle.length + 2;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
        setCaret(nextCaret);
      }
    });
  };

  const applyFileReference = (entry: {
    path: string;
    kind: "file" | "dir";
  }) => {
    const start = caret - fileMatch![0].length + fileMatch![0].indexOf("@");
    const suffix = entry.kind === "dir" ? "/" : " ";
    const next = `${text.slice(0, start)}@${entry.path}${suffix}${text.slice(caret)}`;
    update(next);
    setHighlighted(0);
    const nextCaret = start + entry.path.length + 1 + suffix.length;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
      setSuppressMenu(false);
    });
  };

  const applyCommand = (command: EngineCommand) => {
    if (engineCommandDisabledReason(command)) return;
    if (!commandDraft) return;
    const next = `${text.slice(0, commandDraft.start)}${command.insertText}${text.slice(caret)}`;
    update(next);
    setHighlighted(0);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const nextCaret = commandDraft.start + command.insertText.length;
      el.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  };

  const applyCapability = (capability: EngineComposerCapability) => {
    const inserted = insertComposerCapability(text, caret, capability);
    if (!inserted) return;
    update(inserted.text);
    setCapabilityMenuAnchor(null);
    setCapabilityFilter("");
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(inserted.caret, inserted.caret);
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
      },
    ) => Promise<unknown> | unknown,
  ) => {
    if (sendingRef.current || !canSend) return;
    const commandSubmission = providerCommandInput(
      submissionText,
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
    const submittedText = text;
    const submittedPastedText = pastedText;
    const submittedUserMutationGeneration =
      userDraftMutationGeneration.current;
    const stagedIds = files
      .map(file => draftAttachmentIds.current.get(file))
      .filter(
        (id): id is string =>
          id !== undefined &&
          !locallyRemovedDraftAttachmentIds.current.has(id),
      );
    const mentionedAgents = projectDestinationHandles.flatMap((handle) => {
      const binding = mentionBindings?.find((candidate) =>
        candidate.handle.toLocaleLowerCase() === handle.toLocaleLowerCase());
      return binding ? [binding] : [];
    });
    const submissionContext = mentionedAgents.length > 0
      ? { mentionedAgents }
      : undefined;
    const runtimeCommandSubmission =
      slash?.command.invocation === "runtime";
    const operation =
      runtimeCommandSubmission
        ? onCommand!(slash.command, slash.argumentsText)
        : handler(
            submissionText,
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
        onShowPastedText={() => {
          update(composerSubmissionText(text, pastedText ?? ""));
          replacePastedText(undefined);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        onRemovePastedText={() => {
          updatePastedText(undefined);
        }}
        onRestoreDraft={() => {
          if (!draftConflict) return;
          update(draftConflict.displaced.text);
          setDraftConflict(undefined);
          inputRef.current?.focus();
        }}
        onClearError={() => {
          setSendError(undefined);
          dispatchAttachments({ type: "clear_error" });
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
        {destinationMode === "target-required" ? (
          <ComposerTargetDestinationAction
            broadcast={hasBroadcastDestination}
            handles={targetRequiredHandles}
            onClear={clearTargetDestinations}
          />
        ) : null}
        {destinationMode === "project-chat" ? (
          activeDefaultDestination ? (
            <ComposerTargetDestinationAction
              broadcast={false}
              handles={[activeDefaultDestination.handle]}
              labelPrefix="To: "
              onClear={() => setActiveDefaultDestination(undefined)}
            />
          ) : (
            <ComposerProjectDestinationAction
              newAgentSelected={newAgentSelected}
              toggleNewAgent={toggleNewAgentDestination}
            />
          )
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
            highlighted={highlighted}
            attachmentsEnabled={composerAttachmentsEnabled}
            pastedText={pastedText}
            menuSuggestions={menuSuggestions}
            destinationMode={destinationMode}
            requiredRecipient={requiredRecipient}
            mentionedBusyHandles={mentionedBusyHandles}
            mentionedHandles={mentionedHandles}
            canSend={canSend}
            onTextChange={(value, nextCaret) => {
              update(value);
              setSendError(undefined);
              setCaret(nextCaret);
              setHighlighted(0);
              setSuppressMenu(false);
            }}
            onFiles={addFiles}
            onPastedText={value => {
              updatePastedText(value);
              setSendError(undefined);
            }}
            onPasteError={setSendError}
            onCaretChange={setCaret}
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
            highlighted={highlighted}
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
          sendUnavailableReason={sendUnavailableReason}
          send={send}
          showQueue={showQueue}
          steer={steer}
          targetRequiredRecipientTagged={targetRequiredRecipientTagged}
        />
      </Stack>
    </Paper>
  );
}
