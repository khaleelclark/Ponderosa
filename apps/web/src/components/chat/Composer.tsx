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
import { useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { api } from "../../api";
import { ApiRequestError } from "../../api/types";
import { readChatState, writeChatState } from "../../chatState";
import { createClientId } from "../../clientId";
import { findMentionedHandles, hasBroadcastMention } from "../../mentions";
import { queryKeys } from "../../queryKeys";
import { removeHandle, replaceDestination } from "./Composer.helpers";
import type { DraftUploadStatus } from "./ComposerAttachment";
import type { ComposerProps } from "./Composer.types";
import {
  ComposerAttachmentList,
  ComposerDestinationBar,
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
  canSubmitComposerText,
  composerAttachmentReducer,
  composerSubmissionText,
  engineCommandDisabledReason,
  insertComposerCapability,
  matchingComposerCapabilities,
  matchingEngineCommands,
  providerSlashSubmission,
  selectComposerFiles,
  shouldShowQueueControl,
} from "./composerUtils";
import {
  useComposerDraftStorageReset,
  useComposerDraftStorageWrite,
  useComposerInsertTextRequest,
  useComposerMentionedHandlesChange,
} from "./useComposerTextEffects";
import { composerSurfaceSx } from "./Composer.styles";

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
  mentionSuggestionHandles,
  ambiguousMentionHandles,
  commands,
  capabilities,
  onCapabilitiesOpen,
  attachmentsEnabled = true,
  attachmentsUnavailableReason,
  busyMentionHandles,
  allowUnmentionedSend = true,
  onSend,
  onCommand,
  onQueue,
  agentResponding = false,
  onCancel,
  draftStorageKey,
  conversationDraftId,
  controls,
  insertTextRequest,
  destinationMode,
  requiredRecipient,
  recipientRequiredMessage,
  removeTextRequest,
  onMentionedHandlesChange,
  onCommandTargetHandleChange,
  continueWith,
}: ComposerProps): JSX.Element {
  const [text, setText] = useState(() =>
    draftStorageKey ? (readChatState(draftStorageKey) ?? "") : "",
  );
  const [draftOwnerId] = useState(() => {
    if (typeof window === "undefined") return "server";
    const key = "ponderosa.draft.owner.v1";
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const created = createClientId();
    window.localStorage.setItem(key, created);
    return created;
  });
  const [pastedText, setPastedText] = useState<string>();
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
  const draftClientId = useRef<string>();
  const draftAttachmentIds = useRef(new Map<File, string>());
  const [draftUploadStates, setDraftUploadStates] = useState<
    Map<File, { status: DraftUploadStatus; error?: string }>
  >(() => new Map());
  const pendingDraftUploads = useRef<File[]>([]);
  const activeDraftUploads = useRef(0);
  const pumpDraftUploads = useRef<() => void>(() => undefined);
  const draftWriteChain = useRef<Promise<void>>(Promise.resolve());
  const draftGeneration = useRef(0);
  const draftEditVersion = useRef(0);
  const draftLocallyEdited = useRef(false);
  const [draftAttachmentVersion, setDraftAttachmentVersion] = useState(0);
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
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [implicitContinueSelected, setImplicitContinueSelected] = useState(
    Boolean(continueWith?.responding),
  );
  useEffect(() => {
    setImplicitContinueSelected(Boolean(continueWith?.responding));
  }, [continueWith?.handle, continueWith?.responding]);
  const submissionText = composerSubmissionText(text, pastedText);
  const mentionedHandles = useMemo(
    () => findMentionedHandles(submissionText, mentionHandles ?? []),
    [mentionHandles, submissionText],
  );
  const projectDestinationHandles =
    destinationMode === "project-chat"
      ? mentionedHandles.filter(
          handle =>
            !["broadcast", "everyone"].includes(handle.toLocaleLowerCase()),
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
  const implicitContinueHandle =
    destinationMode === "project-chat" &&
    implicitContinueSelected &&
    continueWith?.responding &&
    !hasBroadcastDestination &&
    !hasEveryoneDestination &&
    projectDestinations.length === 0
      ? continueWith.handle
      : undefined;
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
    explicitCommandTargetHandle ?? implicitContinueHandle;
  useEffect(() => {
    onCommandTargetHandleChange?.(commandTargetHandle);
  }, [commandTargetHandle, onCommandTargetHandleChange]);
  const destinationError =
    destinationMode === "target-required" && hasBroadcastDestination
      ? targetRequiredDestinations.length > 0
        ? "Broadcast is only available in a Project Chat."
        : "#broadcast is not available in All Messages. Choose an Agent."
      : destinationMode === "target-required" &&
          targetRequiredDestinations.length > 1
        ? "Choose one Agent at a time in All Messages."
        : destinationMode === "target-required" && unresolvedAmbiguousTarget
          ? `#${unresolvedAmbiguousTarget} matches more than one Agent. Use a message's # action to choose the exact Agent.`
          : undefined;
  const setDestination = (handle: string) =>
    update(
      current =>
        `#${handle} ${replaceDestination(current, undefined).trimStart()}`,
    );
  const clearDestination = (handle: string) =>
    update(current => removeHandle(current, handle));
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
  const implicitContinueResponding = Boolean(
    implicitContinueHandle &&
      busyHandles.has(implicitContinueHandle.toLocaleLowerCase()),
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
    setText,
  });

  const update = (next: string | ((current: string) => string)) => {
    draftEditVersion.current += 1;
    draftLocallyEdited.current = true;
    setText(next);
  };

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
    setPastedText,
    setText,
  });

  useEffect(() => {
    const changed = previousConversationDraftId.current !== conversationDraftId;
    previousConversationDraftId.current = conversationDraftId;
    if (changed) {
      draftReady.current = false;
      draftLocallyEdited.current = false;
      draftRevision.current = 0;
      draftAttachmentIds.current.clear();
      pendingDraftUploads.current = [];
      activeDraftUploads.current = 0;
      setDraftUploadStates(new Map());
      dispatchAttachments({ type: "clear" });
    }
    if (!conversationDraftId || typeof window === "undefined") return;
    const key = "ponderosa.draft.client.v1";
    let clientId = window.sessionStorage.getItem(key);
    if (!clientId) {
      clientId = createClientId();
      window.sessionStorage.setItem(key, clientId);
    }
    draftClientId.current = clientId;
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
    const apply = async () => {
      const restored = await Promise.all(
        (draft.attachments ?? []).map(
          async (attachment: DraftAttachmentDto) => ({
            attachment,
            file: await api.downloadDraftAttachment(attachment),
          }),
        ),
      );
      if (cancelled || draft.revision < draftRevision.current) return;
      draftAttachmentIds.current = new Map(
        restored.map(({ attachment, file }) => [file, attachment.id]),
      );
      setDraftUploadStates(
        new Map(
          restored.map(({ file }) => [file, { status: "complete" as const }]),
        ),
      );
      dispatchAttachments({
        type: "replace",
        files: restored.map(({ file }) => file),
      });
      setDraftAttachmentVersion(value => value + 1);
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
        setText(nextText);
        if (draftStorageKey) writeChatState(draftStorageKey, nextText);
      }
      draftReady.current = true;
      setDraftReadyVersion(value => value + 1);
    };
    void apply().catch(() => {
      if (!cancelled) {
        draftRevision.current = draft.revision;
        setText(draft.text);
        dispatchAttachments({
          type: "replace",
          files: [],
          error: "Some staged draft attachments could not be restored.",
        });
        draftReady.current = true;
        setDraftReadyVersion(value => value + 1);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [conversationDraftId, draftQuery.data, draftStorageKey]);

  useComposerDraftStorageWrite({
    draftStorageKey,
    text,
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
      const attachmentIds = files
        .map(file => draftAttachmentIds.current.get(file))
        .filter((id): id is string => Boolean(id));
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
          if (draftEditVersion.current === editVersion)
            draftLocallyEdited.current = false;
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
    files,
    queryClient,
    text,
  ]);

  pumpDraftUploads.current = () => {
    if (!conversationDraftId) return;
    while (
      activeDraftUploads.current < 4 &&
      pendingDraftUploads.current.length > 0
    ) {
      const file = pendingDraftUploads.current.shift()!;
      const state = draftUploadStates.get(file);
      if (state?.status === "complete" || draftAttachmentIds.current.has(file))
        continue;
      activeDraftUploads.current += 1;
      setDraftUploadStates(current =>
        new Map(current).set(file, { status: "uploading" }),
      );
      void api
        .uploadDraftAttachment(conversationDraftId, draftOwnerId, file)
        .then(attachment => {
          draftAttachmentIds.current.set(file, attachment.id);
          setDraftUploadStates(current =>
            new Map(current).set(file, { status: "complete" }),
          );
          setDraftAttachmentVersion(value => value + 1);
        })
        .catch((error: unknown) => {
          setDraftUploadStates(current =>
            new Map(current).set(file, {
              status: "failed",
              error: error instanceof Error ? error.message : "Upload failed.",
            }),
          );
        })
        .finally(() => {
          activeDraftUploads.current -= 1;
          pumpDraftUploads.current();
        });
    }
  };

  const queueDraftUploads = (candidates: File[]) => {
    if (!conversationDraftId || candidates.length === 0) return;
    setDraftUploadStates(current => {
      const next = new Map(current);
      for (const file of candidates) next.set(file, { status: "queued" });
      return next;
    });
    pendingDraftUploads.current.push(...candidates);
    window.queueMicrotask(() => pumpDraftUploads.current());
  };

  const addFiles = (candidates: File[]) => {
    const selection = selectComposerFiles(files, candidates, assetLimits);
    dispatchAttachments({ type: "add", candidates, limits: assetLimits });
    queueDraftUploads(selection.accepted);
  };

  const retryDraftUpload = (file: File) => {
    if (!conversationDraftId || draftAttachmentIds.current.has(file)) return;
    setDraftUploadStates(current =>
      new Map(current).set(file, { status: "queued" }),
    );
    pendingDraftUploads.current.push(file);
    pumpDraftUploads.current();
  };

  const removeFile = (index: number) => {
    const file = files[index];
    if (!file) return;
    const id = draftAttachmentIds.current.get(file);
    draftAttachmentIds.current.delete(file);
    pendingDraftUploads.current = pendingDraftUploads.current.filter(
      candidate => candidate !== file,
    );
    setDraftUploadStates(current => {
      const next = new Map(current);
      next.delete(file);
      return next;
    });
    dispatchAttachments({ type: "remove", index });
    setDraftAttachmentVersion(value => value + 1);
    if (conversationDraftId && id)
      void api
        .deleteDraftAttachment(conversationDraftId, draftOwnerId, id)
        .catch(() => undefined);
  };

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
    explicitCommandTargetHandle,
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
      context?: { implicitRecipientId?: string },
    ) => Promise<unknown> | unknown,
  ) => {
    if (sendingRef.current || !canSend) return;
    const commandSubmission = providerCommandInput(
      submissionText,
      explicitCommandTargetHandle,
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
    const stagedIds = files
      .map(file => draftAttachmentIds.current.get(file))
      .filter((id): id is string => Boolean(id));
    const operation =
      slash && slash.command.invocation === "runtime"
        ? onCommand!(slash.command, slash.argumentsText)
        : handler(
            submissionText,
            files,
            stagedIds,
            conversationDraftId ? draftOwnerId : undefined,
            implicitContinueHandle
              ? { implicitRecipientId: continueWith!.agentId }
              : undefined,
          );
    void Promise.resolve(operation)
      .then(() => {
        update("");
        setPastedText(undefined);
        dispatchAttachments({ type: "clear" });
        draftAttachmentIds.current.clear();
        pendingDraftUploads.current = [];
        setDraftUploadStates(new Map());
        setDraftAttachmentVersion(value => value + 1);
        if (conversationDraftId)
          for (const id of stagedIds)
            void api
              .deleteDraftAttachment(conversationDraftId, draftOwnerId, id)
              .catch(() => undefined);
        setCaret(0);
      })
      .catch((error: unknown) =>
        setSendError(
          error instanceof Error ? error.message : "Upload failed; try again.",
        ),
      )
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
        implicitContinueResponding ||
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
        clearDestination={clearDestination}
        continueWith={continueWith}
        destinationError={destinationError}
        destinationMode={destinationMode}
        hasBroadcastDestination={hasBroadcastDestination}
        hasEveryoneDestination={hasEveryoneDestination}
        inputRef={inputRef}
        implicitContinueSelected={Boolean(implicitContinueHandle)}
        projectDestinations={projectDestinations}
        selectImplicitContinue={setImplicitContinueSelected}
        setDestination={setDestination}
        targetRequiredDestinations={targetRequiredDestinations}
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
          setPastedText(undefined);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        onRemovePastedText={() => setPastedText(undefined)}
        onRestoreDraft={() => {
          if (!draftConflict) return;
          update(draftConflict.displaced.text);
          setDraftConflict(undefined);
          inputRef.current?.focus();
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
          attachmentsEnabled={attachmentsEnabled}
          attachmentsUnavailableReason={attachmentsUnavailableReason}
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
            attachmentsEnabled={attachmentsEnabled}
            pastedText={pastedText}
            menuSuggestions={menuSuggestions}
            destinationMode={destinationMode}
            requiredRecipient={requiredRecipient}
            mentionedBusyHandles={mentionedBusyHandles}
            mentionedHandles={mentionedHandles}
            canSend={canSend}
            onTextChange={(value, nextCaret) => {
              update(value);
              setCaret(nextCaret);
              setHighlighted(0);
              setSuppressMenu(false);
            }}
            onFiles={addFiles}
            onPastedText={value => {
              setPastedText(value);
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
          canSend={canSend}
          destinationError={destinationError}
          destinationMode={destinationMode}
          mentionedBusyHandles={mentionedBusyHandles}
          onCancel={onCancel}
          queue={queue}
          recipientRequiredMessage={recipientRequiredMessage}
          send={send}
          showQueue={showQueue}
          steer={steer}
          targetRequiredRecipientTagged={targetRequiredRecipientTagged}
        />
      </Stack>
    </Paper>
  );
}
