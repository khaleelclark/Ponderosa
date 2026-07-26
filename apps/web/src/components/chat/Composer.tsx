import AddIcon from "@mui/icons-material/Add";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArticleIcon from "@mui/icons-material/Article";
import CampaignOutlinedIcon from "@mui/icons-material/CampaignOutlined";
import CloseIcon from "@mui/icons-material/Close";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  ClickAwayListener,
  Divider,
  IconButton,
  MenuItem,
  MenuList,
  Paper,
  Popper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { LONG_TEXT_MAX_UTF8_BYTES, utf8ByteLength } from "@ponderosa/core";
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
import { managerBroadcastText } from "../../conversationRouting";
import { findMentionedHandles, hasBroadcastMention } from "../../mentions";
import { queryKeys } from "../../queryKeys";
import { ComposerAttachment } from "./ComposerAttachment";
import type { DraftUploadStatus } from "./ComposerAttachment";
import type { ChatComposerContract } from "./composerContracts";
import {
  COMPOSER_MAX_FILE_BYTES,
  COMPOSER_MAX_FILES,
  canSubmitComposerText,
  composerAttachmentReducer,
  composerCapabilityDisabledReason,
  composerSubmissionText,
  engineCommandDisabledReason,
  filesFromClipboard,
  insertComposerCapability,
  matchingComposerCapabilities,
  matchingEngineCommands,
  providerSlashSubmission,
  selectComposerFiles,
  shouldExtractLongPaste,
  shouldIgnoreComposerKey,
  shouldSendComposerKey,
  shouldShowQueueControl,
} from "./composerUtils";

export interface ComposerProps extends ChatComposerContract {
  /** Keep the composer available while other Agents in this shared chat are working. */
  allowSendWhileRunning?: boolean;
  placeholder?: string;
  projectId?: string;
  mentionHandles?: string[];
  mentionSuggestionHandles?: string[];
  ambiguousMentionHandles?: string[];
  onCapabilitiesOpen?(): Promise<unknown> | unknown;
  attachmentsEnabled?: boolean;
  attachmentsUnavailableReason?: string;
  busyMentionHandles?: string[];
  allowUnmentionedSend?: boolean;
  preferQueue?: boolean;
  queuedMentionHandles?: string[];
  agentResponding?: boolean;
  onCancel?(): void;
  draftStorageKey?: string;
  conversationDraftId?: string;
  insertTextRequest?: { id: string; text: string };
  /** Project Chat exposes its deliberate fresh-agent default as a destination. */
  destinationMode?: "project-chat" | "fixed" | "target-required";
  fixedRecipientTitle?: string;
  requiredRecipient?: { handle: string; title: string; onClear(): void };
  recipientRequiredMessage?: string;
  removeTextRequest?: { id: string; text: string };
  onMentionedHandlesChange?(handles: string[]): void;
  continueWith?: { handle: string; title: string };
  destinationTitleForHandle?(handle: string): string | undefined;
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
  preferQueue = false,
  queuedMentionHandles,
  agentResponding = false,
  onCancel,
  draftStorageKey,
  conversationDraftId,
  controls,
  guidance,
  insertTextRequest,
  destinationMode,
  fixedRecipientTitle,
  requiredRecipient,
  recipientRequiredMessage,
  removeTextRequest,
  onMentionedHandlesChange,
  continueWith,
  destinationTitleForHandle,
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
    title: destinationTitleForHandle?.(handle) ?? handle,
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
    title: destinationTitleForHandle?.(handle) ?? handle,
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
  const hasLeadingBroadcastDestination =
    managerBroadcastText(submissionText) !== undefined;
  const hasEveryoneDestination =
    destinationMode === "project-chat" &&
    mentionedHandles.some(handle => handle.toLocaleLowerCase() === "everyone");
  const destinationError =
    destinationMode === "project-chat" &&
    hasBroadcastDestination &&
    (projectDestinations.length > 0 || hasEveryoneDestination)
      ? "Broadcast cannot be combined with Agent recipients."
      : destinationMode === "project-chat" &&
          hasBroadcastDestination &&
          !hasLeadingBroadcastDestination
        ? "Put #broadcast first so its shared scope is explicit."
        : destinationMode === "target-required" && hasBroadcastDestination
          ? targetRequiredDestinations.length > 0
            ? "Broadcast cannot be combined with an Agent recipient."
            : "#broadcast is not available in All Messages. Choose an Agent."
          : destinationMode === "target-required" &&
              targetRequiredDestinations.length > 1
            ? "Choose one Agent at a time in All Messages."
            : destinationMode === "target-required" && unresolvedAmbiguousTarget
              ? `#${unresolvedAmbiguousTarget} matches more than one Agent. Use a message's # action to choose the exact Agent.`
              : undefined;
  const replaceDestination = (value: string, nextHandle?: string) =>
    value.replace(
      /(?:^|\s)#([\p{L}\p{N}_-]+)(?=$|\s|[.,!?;:])/gu,
      (match, handle: string) => {
        if (["broadcast", "everyone"].includes(handle.toLocaleLowerCase()))
          return match;
        return nextHandle ? ` #${nextHandle}` : " ";
      },
    );
  const setDestination = (handle: string) =>
    update(
      current =>
        `#${handle} ${replaceDestination(current, undefined).trimStart()}`,
    );
  const removeHandle = (value: string, handle: string) =>
    value
      .replace(
        new RegExp(
          `(?:^|\\s)#${handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|\\s|[.,!?;:])`,
          "iu",
        ),
        " ",
      )
      .replace(/^\s+/u, "");
  const clearDestination = (handle: string) =>
    update(current => removeHandle(current, handle));
  const clearRequiredRecipient = () => {
    const handle = targetRequiredHandles[0] ?? requiredRecipient?.handle;
    if (handle) update(current => removeHandle(current, handle));
    requiredRecipient?.onClear();
  };
  const queuedHandles = new Set(
    (queuedMentionHandles ?? []).map(handle => handle.toLocaleLowerCase()),
  );
  const mentionedAgentsWithQueues = mentionedHandles.filter(handle =>
    queuedHandles.has(handle.toLocaleLowerCase()),
  );
  const defaultsToQueue =
    Boolean(onQueue) &&
    (preferQueue ||
      (mentionedHandles.length > 0 &&
        mentionedAgentsWithQueues.length === mentionedHandles.length));
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

  const draftQuery = useQuery({
    queryKey: queryKeys.conversationDraft.detail(
      conversationDraftId,
      draftOwnerId,
    ),
    queryFn: () => api.getConversationDraft(conversationDraftId!, draftOwnerId),
    enabled: Boolean(conversationDraftId) && typeof window !== "undefined",
    staleTime: 0,
  });

  useEffect(() => {
    if (
      !insertTextRequest ||
      appliedInsertRequest.current === insertTextRequest.id
    )
      return;
    if (conversationDraftId && !draftReady.current && !draftQuery.isError)
      return;
    appliedInsertRequest.current = insertTextRequest.id;
    setText(current => {
      const requested = insertTextRequest.text.trim();
      if (
        requested &&
        current.toLocaleLowerCase().includes(requested.toLocaleLowerCase())
      )
        return current;
      if (
        destinationMode === "target-required" &&
        /^#[\p{L}\p{N}_-]+$/u.test(requested)
      ) {
        return `${requested} ${replaceDestination(current, undefined).trimStart()}`.trimEnd();
      }
      const prefix = current && !/\s$/u.test(current) ? " " : "";
      return `${current}${prefix}${insertTextRequest.text} `;
    });
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const end = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(end, end);
      setCaret(end);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    conversationDraftId,
    destinationMode,
    draftQuery?.isError,
    draftReadyVersion,
    insertTextRequest,
  ]);

  const update = (next: string | ((current: string) => string)) => {
    draftEditVersion.current += 1;
    draftLocallyEdited.current = true;
    setText(next);
  };

  useEffect(() => {
    onMentionedHandlesChange?.(mentionedHandles);
  }, [mentionedHandles, onMentionedHandlesChange]);

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

  useEffect(() => {
    if (previousDraftStorageKey.current !== draftStorageKey) {
      previousDraftStorageKey.current = draftStorageKey;
      setText(draftStorageKey ? (readChatState(draftStorageKey) ?? "") : "");
      setPastedText(undefined);
    }
  }, [draftStorageKey]);

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

  useEffect(() => {
    if (draftStorageKey) writeChatState(draftStorageKey, text);
  }, [draftStorageKey, text]);

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
  const slashMatch = /^\/([\p{L}\p{N}_:-]*)$/u.exec(text.slice(0, caret));
  const commandSuggestions =
    slashMatch && commands
      ? matchingEngineCommands(commands, slashMatch[1]!)
      : [];
  const menuSuggestions =
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
    const next = `${command.insertText}${text.slice(caret)}`;
    update(next);
    setHighlighted(0);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const nextCaret = command.insertText.length;
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
    ) => Promise<unknown> | unknown,
  ) => {
    if (sendingRef.current || !canSend) return;
    const slash =
      files.length === 0
        ? providerSlashSubmission(submissionText, commands ?? [])
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
  const send = () => (defaultsToQueue ? queue() : steer());
  const showQueue =
    Boolean(onQueue) &&
    shouldShowQueueControl({
      text: submissionText,
      hasAttachments: files.length > 0,
      agentResponding: agentResponding || mentionedBusyHandles.length > 0,
      disabled,
    });
  const projectDestinationHelper =
    destinationError ??
    (hasBroadcastDestination
      ? "Adds durable shared Project context; starts no Agent."
      : hasEveryoneDestination
        ? "Every active Agent in this Chat will receive this."
        : projectDestinations.length === 1
          ? `${projectDestinations[0]!.title} will receive this.`
          : projectDestinations.length === 2
            ? `${projectDestinations[0]!.title} and ${projectDestinations[1]!.title} will receive this.`
            : projectDestinations.length > 2
              ? `${projectDestinations.length} Agents will receive this.`
              : "Starts a fresh Agent · use #Agent or #broadcast.");
  const targetRequiredHelper =
    destinationError ??
    (targetRequiredDestinations.length === 1
      ? `${targetRequiredDestinations[0]!.title} will receive this.`
      : (recipientRequiredMessage ??
        "Tag an Agent with # to choose a recipient."));

  return (
    <Paper
      className="ponderosa-composer"
      elevation={0}
      sx={{
        position: "relative",
        zIndex: 3,
        border: 1,
        borderColor: "divider",
        borderRadius: { xs: 2, sm: 2.25 },
        width: {
          xs: "calc(100% - 16px)",
          sm: "calc(100% - 32px)",
          md: "min(1180px, calc(100% - 48px))",
          xl: "min(1240px, calc(100% - 64px))",
        },
        mx: "auto",
        mt: { xs: 0.75, sm: 1 },
        mb: { xs: 1, sm: 1.5 },
        minWidth: 0,
        maxWidth: "100%",
        overflow: "hidden",
        bgcolor: "background.paper",
        px: { xs: 1, sm: 1.5 },
        pt: { xs: 1, sm: 1.25 },
        pb: "max(10px, env(safe-area-inset-bottom))",
        boxShadow: theme =>
          theme.palette.mode === "dark"
            ? "0 10px 30px rgba(3,8,6,.18)"
            : "0 10px 30px rgba(33,45,38,.09)",
      }}
    >
      {guidance ? (
        <Box sx={{ px: 0.25, pb: 0.9, color: "text.secondary" }}>
          {typeof guidance === "string" ? (
            <Typography
              variant="body2"
              sx={{ fontSize: { xs: 12.5, sm: 13.5 }, lineHeight: 1.45 }}
            >
              {guidance}
            </Typography>
          ) : (
            guidance
          )}
        </Box>
      ) : null}
      {destinationMode === "project-chat" ? (
        <Stack
          direction="row"
          spacing={0.75}
          useFlexGap
          flexWrap="wrap"
          sx={{ px: 0.25, pb: 0.75, alignItems: "center" }}
        >
          {hasBroadcastDestination ? (
            <Chip
              size="small"
              color="info"
              icon={<CampaignOutlinedIcon />}
              label="#broadcast"
              onDelete={() => clearDestination("broadcast")}
            />
          ) : null}
          {hasEveryoneDestination ? (
            <Chip
              size="small"
              color="secondary"
              label="#everyone"
              onDelete={() => clearDestination("everyone")}
            />
          ) : null}
          {projectDestinations.map(destination => (
            <Chip
              key={destination.handle.toLocaleLowerCase()}
              size="small"
              color="primary"
              label={`#${destination.handle}`}
              onDelete={() => clearDestination(destination.handle)}
            />
          ))}
          {!hasBroadcastDestination &&
          !hasEveryoneDestination &&
          projectDestinations.length === 0 ? (
            <Chip size="small" variant="outlined" label="New Agent" />
          ) : null}
          {!hasBroadcastDestination &&
          !hasEveryoneDestination &&
          projectDestinations.length === 0 &&
          continueWith ? (
            <Button
              size="small"
              onClick={() => {
                setDestination(continueWith.handle);
                window.requestAnimationFrame(() => {
                  const input = inputRef.current;
                  if (!input) return;
                  input.focus();
                  const end = input.value.length;
                  input.setSelectionRange(end, end);
                });
              }}
            >
              Continue with {continueWith.title}
            </Button>
          ) : null}
          <Typography
            variant="caption"
            color={destinationError ? "error.main" : "text.secondary"}
          >
            {projectDestinationHelper}
          </Typography>
          {!destinationError ? (
            <Tooltip title="Use @ to reference a Project file.">
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ whiteSpace: "nowrap" }}
              >
                · @ file
              </Typography>
            </Tooltip>
          ) : null}
        </Stack>
      ) : destinationMode === "target-required" ? (
        <Stack
          direction="row"
          spacing={0.75}
          useFlexGap
          flexWrap="wrap"
          sx={{ px: 0.25, pb: 0.75, alignItems: "center" }}
        >
          {targetRequiredDestinations.map(destination => (
            <Chip
              key={destination.handle.toLocaleLowerCase()}
              size="small"
              color="primary"
              label={`#${destination.handle}`}
              onDelete={() => clearDestination(destination.handle)}
            />
          ))}
          {hasBroadcastDestination ? (
            <Chip
              size="small"
              color="info"
              icon={<CampaignOutlinedIcon />}
              label="#broadcast"
              onDelete={() => clearDestination("broadcast")}
            />
          ) : null}
          {targetRequiredDestinations.length === 0 &&
          !hasBroadcastDestination ? (
            <Chip size="small" variant="outlined" label="Choose an Agent" />
          ) : null}
          <Typography
            variant="caption"
            color={destinationError ? "error.main" : "text.secondary"}
          >
            {targetRequiredHelper}
          </Typography>
        </Stack>
      ) : destinationMode === "fixed" && fixedRecipientTitle ? (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", px: 0.25, pb: 0.75 }}
        >
          {fixedRecipientTitle} will receive this.
        </Typography>
      ) : null}
      {files.length > 0 ? (
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          flexWrap="wrap"
          sx={{ mb: 1 }}
        >
          {files.map((file, index) => {
            const upload = draftUploadStates.get(file);
            return (
              <ComposerAttachment
                key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                file={file}
                status={upload?.status}
                error={upload?.error}
                onRetry={() => retryDraftUpload(file)}
                onRemove={() => removeFile(index)}
              />
            );
          })}
        </Stack>
      ) : null}
      {pastedText ? (
        <Paper
          variant="outlined"
          sx={{
            mb: 1,
            px: 1,
            py: 0.75,
            display: "flex",
            alignItems: "center",
            gap: 1,
            maxWidth: 360,
          }}
        >
          <ArticleIcon color="action" fontSize="small" />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" noWrap>
              Pasted text
            </Typography>
            <Button
              size="small"
              sx={{ p: 0, minWidth: 0, textTransform: "none" }}
              onClick={() => {
                update(composerSubmissionText(text, pastedText));
                setPastedText(undefined);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
            >
              Show in Text Field
            </Button>
          </Box>
          <Typography variant="caption" color="text.secondary">
            {utf8ByteLength(pastedText).toLocaleString()} bytes
          </Typography>
          <IconButton
            size="small"
            aria-label="Remove pasted text"
            onClick={() => setPastedText(undefined)}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Paper>
      ) : null}
      {(attachments.error ?? sendError) ? (
        <Alert severity="error" sx={{ mb: 1 }}>
          Message not sent. {attachments.error ?? sendError}
        </Alert>
      ) : null}
      {draftConflict ? (
        <Alert
          severity="warning"
          sx={{ mb: 1 }}
          action={
            <Button
              size="small"
              onClick={() => {
                update(draftConflict.displaced.text);
                setDraftConflict(undefined);
                inputRef.current?.focus();
              }}
            >
              Restore
            </Button>
          }
        >
          This chat changed in another tab. Your displaced draft is preserved: “
          {compactPreviewText(draftConflict.displaced.text)}”
        </Alert>
      ) : null}
      <Stack
        direction="row"
        spacing={{ xs: 0.25, sm: 0.5 }}
        useFlexGap
        sx={{ alignItems: "center", flexWrap: "wrap" }}
      >
        <input
          ref={fileInput}
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,application/json,application/zip,.txt,.md,.csv,.log,.json,.zip,.pdf"
          multiple
          onChange={event => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <Tooltip title="Add an image, file, skill, plugin, or connector">
          <span>
            <IconButton
              aria-label="Add attachment or capability"
              aria-haspopup="menu"
              aria-expanded={Boolean(capabilityMenuAnchor)}
              aria-controls={
                capabilityMenuAnchor ? capabilityListId : undefined
              }
              disabled={disabled || composerLocked}
              onClick={event => {
                setCapabilityFilter("");
                setCapabilityMenuAnchor(event.currentTarget);
                void Promise.resolve(onCapabilitiesOpen?.()).catch(
                  () => undefined,
                );
              }}
            >
              <AddIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Popper
          open={Boolean(capabilityMenuAnchor)}
          anchorEl={capabilityMenuAnchor}
          placement="top-start"
          style={{ zIndex: 1400 }}
        >
          <ClickAwayListener
            onClickAway={() => {
              setCapabilityMenuAnchor(null);
              setCapabilityFilter("");
            }}
          >
            <Paper
              elevation={5}
              sx={{
                mb: 0.5,
                width: "min(420px, calc(100vw - 24px))",
                maxHeight: "min(52vh, 390px)",
                overflow: "hidden",
              }}
            >
              <Box sx={{ p: 1, borderBottom: 1, borderColor: "divider" }}>
                <TextField
                  autoFocus
                  fullWidth
                  size="small"
                  value={capabilityFilter}
                  onChange={event => setCapabilityFilter(event.target.value)}
                  placeholder="Find a skill, plugin, or connector"
                  inputProps={{ "aria-label": "Filter runtime capabilities" }}
                />
              </Box>
              <MenuList
                dense
                id={capabilityListId}
                aria-label="Add attachment or runtime capability"
                sx={{
                  maxHeight: "min(38vh, 300px)",
                  overflowY: "auto",
                  overscrollBehavior: "contain",
                }}
              >
                <MenuItem
                  disabled={
                    !attachmentsEnabled ||
                    files.length >=
                      (assetLimits?.maxAssetsPerMessage ?? COMPOSER_MAX_FILES)
                  }
                  onClick={() => {
                    setCapabilityMenuAnchor(null);
                    fileInput.current?.click();
                  }}
                  sx={{
                    whiteSpace: "normal",
                    alignItems: "flex-start",
                    minHeight: 54,
                  }}
                >
                  <Box>
                    <Typography variant="body2">
                      Upload image or file
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {!attachmentsEnabled
                        ? (attachmentsUnavailableReason ??
                          "Attachments are not supported in this chat.")
                        : files.length >=
                            (assetLimits?.maxAssetsPerMessage ??
                              COMPOSER_MAX_FILES)
                          ? "Remove an attachment before adding another."
                          : `Up to ${assetLimits?.maxAssetsPerMessage ?? COMPOSER_MAX_FILES} PNG, JPEG, WebP, PDF, text, JSON, or ZIP files · ${Math.floor((assetLimits?.maxFileBytes ?? COMPOSER_MAX_FILE_BYTES) / 1024 / 1024)} MiB each`}
                    </Typography>
                  </Box>
                </MenuItem>
                <Divider />
                {(capabilities ?? []).length === 0 ? (
                  <MenuItem disabled sx={{ whiteSpace: "normal" }}>
                    <Typography variant="caption">
                      No runtime skills, plugins, or connectors are currently
                      available.
                    </Typography>
                  </MenuItem>
                ) : visibleCapabilities.length === 0 ? (
                  <MenuItem disabled>
                    <Typography variant="caption">
                      No capabilities match “{capabilityFilter.trim()}”.
                    </Typography>
                  </MenuItem>
                ) : (
                  visibleCapabilities.map(capability => {
                    const reason = composerCapabilityDisabledReason(capability);
                    const automatic =
                      capability.status === "available" &&
                      !capability.insertText;
                    return (
                      <MenuItem
                        key={capability.id}
                        disabled={Boolean(reason)}
                        onClick={() => applyCapability(capability)}
                        sx={{
                          whiteSpace: "normal",
                          alignItems: "flex-start",
                          minHeight: 58,
                          py: 0.75,
                          ...(automatic
                            ? {
                                "&.Mui-disabled": {
                                  opacity: 1,
                                  cursor: "default",
                                },
                              }
                            : {}),
                        }}
                      >
                        <Box sx={{ minWidth: 0, width: "100%" }}>
                          <Stack
                            direction="row"
                            spacing={0.75}
                            sx={{ alignItems: "center", minWidth: 0 }}
                          >
                            <Typography
                              variant="body2"
                              noWrap
                              sx={{
                                flex: 1,
                                fontWeight: 650,
                                color: automatic ? "text.primary" : undefined,
                              }}
                            >
                              {capability.label}
                            </Typography>
                            <Chip
                              size="small"
                              variant="outlined"
                              color={automatic ? "success" : "default"}
                              label={capability.kind}
                            />
                          </Stack>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{
                              display: "-webkit-box",
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical",
                              overflow: "hidden",
                              overflowWrap: "anywhere",
                              lineHeight: 1.35,
                            }}
                          >
                            {capability.description}
                          </Typography>
                          {reason ? (
                            <Typography
                              variant="caption"
                              color={
                                automatic ? "text.secondary" : "text.disabled"
                              }
                              noWrap
                              sx={{ display: "block" }}
                            >
                              {reason}
                            </Typography>
                          ) : null}
                        </Box>
                      </MenuItem>
                    );
                  })
                )}
              </MenuList>
            </Paper>
          </ClickAwayListener>
        </Popper>
        <Box sx={{ flex: 1, minWidth: { xs: 0, sm: 24 } }} />
        {controls ? (
          <Box sx={{ minWidth: 0, maxWidth: "100%", overflowX: "auto" }}>
            {controls}
          </Box>
        ) : null}
        <Box ref={anchorRef} sx={{ order: -1, flex: "1 0 100%", minWidth: 0 }}>
          <TextField
            fullWidth
            multiline
            variant="standard"
            minRows={1}
            maxRows={5}
            sx={{
              "& .MuiInputBase-root": {
                alignItems: "flex-end",
                bgcolor: "transparent",
                px: 0.25,
                pb: 0.5,
              },
              "& textarea": {
                fontSize: 15,
                lineHeight: "22px",
                maxHeight: "110px !important",
                overflowY: "auto !important",
              },
            }}
            InputProps={{ disableUnderline: true }}
            value={text}
            inputRef={inputRef}
            disabled={disabled || composerLocked}
            placeholder={
              composerLocked
                ? "Agent is working"
                : (placeholder ?? "Send a message")
            }
            inputProps={{
              "aria-label": "Message",
              enterKeyHint: "send",
              role:
                mentionHandles || commands?.length || projectId
                  ? "combobox"
                  : undefined,
              "aria-autocomplete":
                mentionHandles || commands?.length || projectId
                  ? "list"
                  : undefined,
              "aria-expanded":
                mentionHandles || commands?.length || projectId
                  ? menuOpen
                  : undefined,
              "aria-controls": menuOpen ? mentionListId : undefined,
              "aria-activedescendant": menuOpen
                ? `${mentionListId}-option-${highlighted}`
                : undefined,
            }}
            onChange={event => {
              update(event.target.value);
              setCaret(
                event.target.selectionStart ?? event.target.value.length,
              );
              setHighlighted(0);
              setSuppressMenu(false);
            }}
            onPaste={event => {
              if (disabled || composerLocked) return;
              if (attachmentsEnabled) {
                const pasted = filesFromClipboard(
                  event.clipboardData.items,
                  event.clipboardData.files,
                );
                if (pasted.length > 0) {
                  event.preventDefault();
                  addFiles(pasted);
                  return;
                }
              }
              const pasted = event.clipboardData.getData("text/plain");
              if (!shouldExtractLongPaste(pasted)) return;
              event.preventDefault();
              const combined = composerSubmissionText(pastedText ?? "", pasted);
              if (utf8ByteLength(combined) > LONG_TEXT_MAX_UTF8_BYTES) {
                setSendError("Pasted text exceeds the 8 MiB limit.");
                return;
              }
              setPastedText(combined);
              setSendError(undefined);
            }}
            onClick={event =>
              setCaret(
                (event.target as HTMLTextAreaElement).selectionStart ?? 0,
              )
            }
            onKeyUp={event =>
              setCaret(
                (event.target as HTMLTextAreaElement).selectionStart ?? 0,
              )
            }
            onKeyDown={event => {
              if (
                shouldIgnoreComposerKey({
                  key: event.key,
                  isComposing: event.nativeEvent.isComposing,
                })
              ) {
                return;
              }
              if (menuOpen && event.key === "ArrowDown") {
                event.preventDefault();
                setHighlighted(index => (index + 1) % menuSuggestions.length);
                return;
              }
              if (menuOpen && event.key === "ArrowUp") {
                event.preventDefault();
                setHighlighted(
                  index =>
                    (index - 1 + menuSuggestions.length) %
                    menuSuggestions.length,
                );
                return;
              }
              if (
                menuOpen &&
                (event.key === "Enter" || event.key === "Tab") &&
                !event.metaKey &&
                !event.ctrlKey
              ) {
                event.preventDefault();
                const selected = menuSuggestions[highlighted]!;
                if (selected.kind === "mention") applyMention(selected.handle);
                else if (selected.kind === "file")
                  applyFileReference(selected.entry);
                else applyCommand(selected.command);
                return;
              }
              if (menuOpen && event.key === "Escape") {
                event.preventDefault();
                setSuppressMenu(true);
                return;
              }
              if (
                event.key === "Escape" &&
                destinationMode === "target-required" &&
                requiredRecipient
              ) {
                event.preventDefault();
                clearRequiredRecipient();
                return;
              }
              if (
                shouldSendComposerKey({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  isComposing: event.nativeEvent.isComposing,
                  repeat: event.repeat,
                }) &&
                canSend
              ) {
                event.preventDefault();
                send();
              }
            }}
          />
          {mentionedHandles.length > 0 &&
          destinationMode !== "project-chat" &&
          destinationMode !== "target-required" ? (
            <Typography
              variant="caption"
              color={
                mentionedBusyHandles.length > 0
                  ? "warning.main"
                  : "text.secondary"
              }
            >
              {mentionedHandles.some(
                handle => handle.toLocaleLowerCase() === "broadcast",
              )
                ? "Adding durable shared context without starting an agent"
                : mentionedBusyHandles.length > 0
                  ? `${mentionedBusyHandles.map(handle => `#${handle}`).join(", ")} ${mentionedBusyHandles.length > 1 ? "are" : "is"} working — your message will steer the active turn when supported.`
                  : mentionedHandles.some(
                        handle => handle.toLocaleLowerCase() === "everyone",
                      )
                    ? "Notifying every active agent in this conversation"
                    : `Messaging ${mentionedHandles.map(handle => `#${handle}`).join(", ")}`}
            </Typography>
          ) : null}
          <Popper
            open={menuOpen}
            anchorEl={anchorRef.current}
            placement="top-start"
            style={{ zIndex: 1400 }}
          >
            <ClickAwayListener onClickAway={() => setSuppressMenu(true)}>
              <Paper
                elevation={4}
                sx={{
                  mb: 0.5,
                  minWidth: 180,
                  maxWidth: "min(720px, calc(100vw - 24px))",
                }}
              >
                <MenuList
                  dense
                  id={mentionListId}
                  role="listbox"
                  aria-label={
                    commandSuggestions.length
                      ? "Commands"
                      : suggestions.length
                        ? "Agent tags"
                        : "Project files and folders"
                  }
                  sx={{
                    maxHeight: "min(40vh, 360px)",
                    overflowY: "auto",
                    overscrollBehavior: "contain",
                  }}
                >
                  {menuSuggestions.map((suggestion, index) =>
                    (() => {
                      const commandReason =
                        suggestion.kind === "command"
                          ? engineCommandDisabledReason(suggestion.command)
                          : undefined;
                      return (
                        <MenuItem
                          key={
                            suggestion.kind === "mention"
                              ? suggestion.handle
                              : suggestion.kind === "file"
                                ? suggestion.entry.path
                                : suggestion.command.name
                          }
                          id={`${mentionListId}-option-${index}`}
                          role="option"
                          aria-selected={index === highlighted}
                          selected={index === highlighted}
                          disabled={Boolean(commandReason)}
                          sx={{
                            whiteSpace: "normal",
                            alignItems: "flex-start",
                          }}
                          onMouseDown={event => {
                            event.preventDefault();
                            if (suggestion.kind === "mention")
                              applyMention(suggestion.handle);
                            else if (suggestion.kind === "file")
                              applyFileReference(suggestion.entry);
                            else applyCommand(suggestion.command);
                          }}
                        >
                          {suggestion.kind === "mention" ? (
                            `#${suggestion.handle}`
                          ) : suggestion.kind === "file" ? (
                            <Box>
                              <Typography variant="body2">
                                @{suggestion.entry.path}
                                {suggestion.entry.kind === "dir" ? "/" : ""}
                              </Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                {suggestion.entry.kind === "dir"
                                  ? "Folder"
                                  : "File"}
                              </Typography>
                            </Box>
                          ) : (
                            <Box sx={{ minWidth: 0 }}>
                              <Typography variant="body2">
                                {suggestion.command.insertText.trimEnd()}
                              </Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{
                                  display: "block",
                                  overflowWrap: "anywhere",
                                }}
                              >
                                {suggestion.command.source} ·{" "}
                                {commandReason ??
                                  suggestion.command.description}
                              </Typography>
                            </Box>
                          )}
                        </MenuItem>
                      );
                    })(),
                  )}
                </MenuList>
              </Paper>
            </ClickAwayListener>
          </Popper>
        </Box>
        {showQueue ? (
          <Tooltip
            title={
              defaultsToQueue
                ? "Send after the active response finishes"
                : "Steer the active response"
            }
          >
            <span>
              <Button
                size="small"
                variant="contained"
                disabled={!canSend}
                onClick={send}
                aria-label={
                  defaultsToQueue ? "Queue message" : "Steer active response"
                }
                sx={{ minHeight: 40, px: 1.5, boxShadow: "none" }}
              >
                {defaultsToQueue ? "Queue" : "Steer"}
              </Button>
            </span>
          </Tooltip>
        ) : null}
        {showQueue ? (
          <Tooltip
            title={
              defaultsToQueue
                ? "Steer the active response"
                : "Send after the active response finishes"
            }
          >
            <span>
              <Button
                size="small"
                variant="outlined"
                disabled={!canSend}
                onClick={defaultsToQueue ? steer : queue}
                aria-label={
                  defaultsToQueue ? "Steer active response" : "Queue message"
                }
                sx={{ minHeight: 40, px: 1.5 }}
              >
                {defaultsToQueue ? "Steer" : "Queue"}
              </Button>
            </span>
          </Tooltip>
        ) : null}
        {canCancel ? (
          <Tooltip title="Cancel Run">
            <IconButton
              color="error"
              onClick={onCancel}
              aria-label="Cancel run"
            >
              <StopCircleIcon />
            </IconButton>
          </Tooltip>
        ) : null}
        {!showQueue && (!canCancel || allowSendWhileRunning) ? (
          <Tooltip
            title={
              !canSend &&
              (destinationError ||
                (destinationMode === "target-required" &&
                  !targetRequiredRecipientTagged))
                ? (destinationError ??
                  recipientRequiredMessage ??
                  "Choose at least one Agent recipient.")
                : "Send"
            }
          >
            <span>
              <IconButton
                color="primary"
                disabled={!canSend}
                onClick={send}
                aria-label={
                  mentionedBusyHandles.length > 0
                    ? "Queue message"
                    : "Send message"
                }
              >
                <ArrowUpwardIcon />
              </IconButton>
            </span>
          </Tooltip>
        ) : null}
      </Stack>
    </Paper>
  );
}

function compactPreviewText(text: string, maxLength = 240): string {
  const compact = text.trim().replace(/\s+/g, " ") || "Draft unavailable";
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}
