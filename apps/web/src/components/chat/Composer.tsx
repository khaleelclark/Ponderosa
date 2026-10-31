import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  LONG_TEXT_MAX_UTF8_BYTES,
  messageTagTokens,
  utf8ByteLength,
} from "@ponderosa/core";
import type {
  AgentMentionBindingDto,
  ArtifactDto,
  ConversationDraftConflictDto,
  ConversationDraftDto,
  DraftPendingSubmissionDto,
  DraftAttachmentDto,
  EngineCommand,
  EngineComposerCapability,
  ResolveConversationDraftConflictResponse,
  RestoreConversationDraftConflictUnavailableResponse,
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
import { collectAttachments, droppedAttachmentEntries } from "./folderAttachments";
import { readChatState, readChatStateEntries, writeChatState } from "../../chatState";
import { acknowledgeDraftTextRecovery, readDraftTextRecoveries, recoverDraftText, retireSubmittedDraftText, writeDraftTextRecovery } from "./draftTextRecovery";
import { readDraftSelection, writeDraftSelection } from "./draftSelection";
import { createClientId, draftSurfaceClientId } from "../../clientId";
import { readBrowserStorage, writeBrowserStorage } from "../../browserStorage";
import {
  createRecipientUploadAuthorityOutbox,
  parseRecipientUploadAuthorityOutbox,
  pendingDraftAttachmentIds,
  pendingPastedTextAttachmentId,
  recipientUploadAuthorityConfirmed,
  recipientUploadAuthorityHasCapacity,
  recipientUploadAuthorityStoragePrefix,
  recipientUploadAuthorityStorageKey,
  reconcileRecipientUploadAuthority,
  serializeRecipientUploadAuthorityOutbox,
  stableMessageActionText,
} from "../../conversationRouting";
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
  durableSubmissionMayBeReleased,
  durableSubmissionFingerprint,
  selectDurableSubmission,
} from "../idempotentAttempt";
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
  COMPOSER_MAX_FILE_BYTES,
  canonicalDraftConflictFiles,
  composerAttachmentReducer,
  composerPreparedRetryAction,
  composerDurableRetryAction,
  composerRecipientGateSatisfied,
  composerShouldSeedContinuationDestination,
  composerSubmissionText,
  cleanupReleasedDraftAttachmentIds,
  composerSubmissionMayClearDraft,
  deletableSupersededDraftAttachmentIds,
  draftContentRetryStillOwned,
  draftWriteContinuationStillOwned,
  durableDraftContentReady,
  engineCommandDisabledReason,
  hydratedDraftContent,
  hydratedPastedTextContent,
  insertComposerCapability,
  matchingComposerCapabilities,
  matchingEngineCommands,
  ownedDraftRevisionAfterObservation,
  pendingSubmissionAfterRuntimeObservation,
  providerSlashSubmission,
  recoverableDraftConflict,
  redundantDraftConflictUploadIds,
  resolvedDraftConflictDraft,
  retryDraftRestoreForMissingAssets,
  refreshRecoverableDraftConflict,
  type RecoverableDraftConflict,
  restagedDraftConflictSnapshot,
  restoreDraftConflictSnapshot,
  savedPastedTextCleanMutationGeneration,
  settledDraftWriteContinuation,
  unresolvedRecoverableDraftConflict,
  shouldAdoptHydratedDraft,
  shouldShowQueueControl,
} from "./composerUtils";
import {
  refreshedMentionBindings,
  resolvedMentionBinding,
  submissionMentionBinding,
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
import { CapturedSubmissionOrderError, withCapturedSubmissionLock, capturedSubmissionRunning, readCapturedSubmissions, recoverAcceptedSubmissions, submissionOutboxEvent, runCapturedSubmission, saveCapturedSubmission, removeCapturedSubmission, type CapturedSubmission } from "./submissionOutbox";
import { persistCapturedDraftSubmission, withCapturedDraftSubmissions } from "./capturedDraftSubmissions";
import { useOutgoingMessage } from "./OutgoingMessage";

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

function unavailableDraftConflictAttachmentIds(error: unknown): string[] | undefined {
  if (!(error instanceof ApiRequestError) || ![400, 409].includes(error.status) ||
      !error.body || typeof error.body !== "object" || Array.isArray(error.body)) return undefined;
  const body = error.body as Partial<RestoreConversationDraftConflictUnavailableResponse>;
  return body.error === "draft conflict attachment is unavailable" &&
    Array.isArray(body.unavailableAttachmentIds) &&
    body.unavailableAttachmentIds.every(id => typeof id === "string")
    ? body.unavailableAttachmentIds
    : undefined;
}

function rejectedDraftConflict(
  error: unknown,
  current: ConversationDraftDto,
): ConversationDraftConflictDto | undefined {
  if (!(error instanceof ApiRequestError) || error.status !== 409 ||
      !error.body || typeof error.body !== "object" || Array.isArray(error.body)) return undefined;
  const body = error.body as { id?: unknown; displaced?: unknown };
  if (typeof body.id !== "string" || !body.id ||
      !body.displaced || typeof body.displaced !== "object" || Array.isArray(body.displaced)) return undefined;
  const displaced = body.displaced as Record<string, unknown>;
  if (typeof displaced.conversationId !== "string" ||
      typeof displaced.text !== "string" ||
      !Array.isArray(displaced.attachmentIds) ||
      displaced.attachmentIds.some(id => typeof id !== "string") ||
      typeof displaced.clientId !== "string" ||
      typeof displaced.capturedAt !== "string" ||
      (displaced.mentionBindings !== undefined && !Array.isArray(displaced.mentionBindings))) return undefined;
  return {
    id: body.id,
    current,
    displaced: displaced as ConversationDraftConflictDto["displaced"],
  };
}

type FailedDraftContent = {
  id: string;
  name: string;
  kind: "attachment" | "pasted-text";
  attachment?: DraftAttachmentDto;
};

type DraftWriteChain = {
  clientId: string;
  recoveryStorageKey?: string;
  recoveredText?: { clientId: string; text: string; mentionBindings: AgentMentionBindingDto[] };
  cleanupRetryScheduled: boolean;
  ownedRevision: number;
  pendingDeletionIds: Set<string>;
  tail: Promise<void>;
};

function acknowledgeRecoveredText(chain: DraftWriteChain, saved: { text: string; mentionBindings: AgentMentionBindingDto[] }, revision: number): void {
  const recovered = chain.recoveredText;
  const pending = readDraftTextRecoveries(chain.recoveryStorageKey).find(value => value.clientId === recovered?.clientId);
  if (recovered && pending && pending.text === recovered.text &&
      JSON.stringify(pending.mentionBindings) === JSON.stringify(recovered.mentionBindings) && recovered.text === saved.text &&
      JSON.stringify(recovered.mentionBindings) === JSON.stringify(saved.mentionBindings)) {
    acknowledgeDraftTextRecovery(chain.recoveryStorageKey, recovered.clientId, recovered, revision);
    chain.recoveredText = undefined;
  }
}

const createDraftWriteChain = (): DraftWriteChain => ({
  clientId: draftSurfaceClientId(),
  cleanupRetryScheduled: false,
  ownedRevision: 0,
  pendingDeletionIds: new Set(),
  tail: Promise.resolve(),
});

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
  mentionBindings: suppliedMentionBindings,
  mentionBindingsReady = true,
  mentionSuggestionHandles,
  ambiguousMentionHandles,
  commands,
  capabilities,
  menuActions,
  capabilityButtonRef,
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
  submissionDisabled,
  submissionIntentKey,
  submissionRuntimeKey,
  submissionRuntimeIntentKey,
  onSubmissionIntentChange,
  onMentionedHandlesChange,
  onAuthoredMentionHandlesChange,
  preserveUntargetedDraft,
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
    const existing = readBrowserStorage("localStorage", key);
    if (existing && DRAFT_OWNER_ID.test(existing)) return existing;
    const created = createClientId();
    writeBrowserStorage("localStorage", key, created);
    return created;
  });
  const [pastedText, setPastedTextState] = useState<string>();
  const pastedTextRef = useRef<string>();
  const [pastedTextEditorOpen, setPastedTextEditorOpen] = useState(false);
  const [pastedTextEditorValue, setPastedTextEditorValue] = useState("");
  const [attachments, dispatchAttachments] = useReducer(
    composerAttachmentReducer,
    { files: [] },
  );
  const files = attachments.files;
  const queryClient = useQueryClient();
  const outgoing = useOutgoingMessage();
  const assetLimitsQuery = useQuery({
    queryKey: queryKeys.assetLimits.all,
    queryFn: () => api.getAssetLimits(),
    staleTime: 5 * 60_000,
  });
  const assetLimits = assetLimitsQuery.data;
  const [sendError, setSendError] = useState<string>();
  const [preparedRetry, setPreparedRetry] = useState<{
    action: "send" | "queue";
    submissionIntentKey?: string;
  }>();
  const preparedRetryAction = composerPreparedRetryAction(
    preparedRetry,
    submissionIntentKey,
  );
  const [draftConflict, setDraftConflict] =
    useState<RecoverableDraftConflict<
      File,
      AgentMentionBindingDto,
      FailedDraftContent
    >>();
  const draftConflictGeneration = useRef(0);
  const [restoringDraftConflict, setRestoringDraftConflict] = useState(false);
  const [localRecoveryOpen, setLocalRecoveryOpen] = useState(false);
  const [, refreshLocalRecovery] = useState(0);
  useEffect(() => {
    const changed = () => refreshLocalRecovery(value => value + 1);
    window.addEventListener("storage", changed);
    window.addEventListener(submissionOutboxEvent, changed);
    return () => { window.removeEventListener("storage", changed); window.removeEventListener(submissionOutboxEvent, changed); };
  }, []);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const fileDragDepth = useRef(0);
  const [fileDragActive, setFileDragActive] = useState(false);
  const previousDraftStorageKey = useRef(draftStorageKey);
  const previousConversationDraftId = useRef(conversationDraftId);
  const uploadAuthorityStoragePrefix = draftStorageKey
    ? recipientUploadAuthorityStoragePrefix(draftStorageKey)
    : undefined;
  const draftRevision = useRef(0);
  const pendingSubmissionRef = useRef<DraftPendingSubmissionDto>();
  const pendingUploadAuthorityStorageKeys = useRef(new Set<string>());
  const draftReady = useRef(false);
  const [initialDraftWriteChain] = useState(createDraftWriteChain);
  const draftWriteChain = useRef<DraftWriteChain>(initialDraftWriteChain);
  const draftGeneration = useRef(0);
  const draftHydrationGeneration = useRef(0);
  const draftEditVersion = useRef(0);
  const userDraftMutationGeneration = useRef(0);
  const draftLocallyEdited = useRef(false);
  const draftAttachmentsLocallyEdited = useRef(false);
  const unrestoredDraftAttachmentIds = useRef<string[]>([]);
  const pastedTextAttachmentId = useRef<string>();
  const pastedTextMutationGeneration = useRef(0);
  const pastedTextCleanMutationGeneration = useRef(0);
  const pastedTextUploadGeneration = useRef(0);
  const pastedTextUploadFailedFor = useRef<string>();
  const [pastedTextUploading, setPastedTextUploading] = useState(false);
  const [failedDraftContents, setFailedDraftContents] = useState<
    FailedDraftContent[]
  >([]);
  const failedDraftContentsRef = useRef<FailedDraftContent[]>([]);
  const [draftReadyVersion, setDraftReadyVersion] = useState(0);
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [preparingFolder, setPreparingFolder] = useState(false);
  const attachmentImportGeneration = useRef(0);
  const attachmentImportBusy = useRef(false);
  const attachmentImportScope = JSON.stringify([conversationDraftId, draftStorageKey]);
  const attachmentImportScopeRef = useRef(attachmentImportScope);
  attachmentImportScopeRef.current = attachmentImportScope;
  const attachmentImportAllowedRef = useRef(false);
  useEffect(() => {
    setPreparingFolder(false);
    attachmentImportBusy.current = false;
    return () => { attachmentImportGeneration.current++; attachmentImportBusy.current = false; };
  }, [attachmentImportScope]);
  const draftMutationLockedRef = useRef(false);
  const [draftMutationLocked, setDraftMutationLocked] = useState(false);
  const draftContentGeneration = useRef(0);
  const dictationSettlingRef = useRef(false);
  const [dictationSettling, setDictationSettling] = useState(false);
  const composerRoot = useRef<HTMLDivElement>(null);
  const [narrowComposer, setNarrowComposer] = useState(() => typeof window !== "undefined" && window.innerWidth < 520);
  useEffect(() => {
    const root = composerRoot.current;
    if (!root) return;
    const observer = new ResizeObserver(entries => {
      if (entries[0]) setNarrowComposer(entries[0].contentRect.width < 520);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
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
  // Retain authored identities for display while loading, but do not permit sends
  // until the current roster can validate them. A loaded deletion stays invalid.
  const mentionBindings = mentionBindingsReady
    ? suppliedMentionBindings
    : knownMentionBindings;
  const inputRef = useRef<ComposerEditorHandle | null>(null);
  const pendingSelection = useRef(readDraftSelection(draftStorageKey));
  const selectionIntent = useRef(0);
  const authoredTextInput = useRef(false);
  useEffect(() => {
    const cancelRestore = (event: Event) => {
      if (!composerRoot.current?.contains(event.target as Node)) return;
      if (event.type === "beforeinput" || event.type === "paste") authoredTextInput.current = true;
      selectionIntent.current++;
      pendingSelection.current = undefined;
    };
    document.addEventListener("pointerdown", cancelRestore, true);
    document.addEventListener("keydown", cancelRestore, true);
    document.addEventListener("beforeinput", cancelRestore, true);
    document.addEventListener("paste", cancelRestore, true);
    return () => {
      document.removeEventListener("pointerdown", cancelRestore, true);
      document.removeEventListener("keydown", cancelRestore, true);
      document.removeEventListener("beforeinput", cancelRestore, true);
      document.removeEventListener("paste", cancelRestore, true);
    };
  }, []);
  useEffect(() => {
    pendingSelection.current = readDraftSelection(draftStorageKey);
    let frame: number | undefined;
    const restore = () => {
      if (!pendingSelection.current || !inputRef.current?.isFocused()) return;
      const capturedEditor = inputRef.current;
      const capturedSelection = pendingSelection.current;
      const capturedIntent = selectionIntent.current;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const editor = inputRef.current;
        const saved = pendingSelection.current;
        if (!editor?.isFocused() || !saved) return;
        if (editor !== capturedEditor || saved !== capturedSelection ||
            selectionIntent.current !== capturedIntent) return;
        // Hydration may still be pending when focus arrives. Keep the snapshot
        // until the editor contains its exact content; never take focus.
        if (editor.getCanonicalText() !== saved.text) return;
        pendingSelection.current = undefined;
        editor.setSelectionOffsets(saved.start, saved.end);
        setCaret(saved.end);
      });
    };
    document.addEventListener("focusin", restore);
    restore();
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      document.removeEventListener("focusin", restore);
    };
  }, [draftStorageKey, draftReadyVersion]);
  const activeSubmissionIntentKeyRef = useRef(submissionIntentKey);
  activeSubmissionIntentKeyRef.current = submissionIntentKey;
  const previousSubmissionRuntimeKey = useRef(submissionRuntimeKey);
  const previousSubmissionRuntimeIntentKey = useRef(submissionRuntimeIntentKey);
  const activeDraftScopeRef = useRef(conversationDraftId);
  activeDraftScopeRef.current = conversationDraftId;
  const updateFailedDraftContents = useCallback(
    (
      next:
        | FailedDraftContent[]
        | ((current: FailedDraftContent[]) => FailedDraftContent[]),
    ) => {
      const resolved = typeof next === "function"
        ? next(failedDraftContentsRef.current)
        : next;
      failedDraftContentsRef.current = resolved;
      setFailedDraftContents(resolved);
    },
    [],
  );
  const pendingSubmissionWithLocalUploadAuthority = useCallback(
    (draft: ConversationDraftDto) => {
      pendingUploadAuthorityStorageKeys.current.clear();
      const candidates = uploadAuthorityStoragePrefix && draftStorageKey &&
          conversationDraftId && projectId
        ? readChatStateEntries(uploadAuthorityStoragePrefix).flatMap(([key, raw]) => {
            const value = parseRecipientUploadAuthorityOutbox(raw, {
              draftId: conversationDraftId,
              draftStorageKey,
              projectId,
              ownerId: draftOwnerId,
            });
            if (!value) writeChatState(key, "");
            return value ? [{ key, value }] : [];
          }).sort((left, right) => right.value.createdAt - left.value.createdAt)
        : [];
      for (const candidate of candidates) {
        const reconciled = reconcileRecipientUploadAuthority(
          draft.pendingSubmission,
          candidate.value,
          draft,
        );
        if (reconciled.retainLocal) {
          pendingUploadAuthorityStorageKeys.current.add(candidate.key);
          return reconciled.pending;
        }
        if (recipientUploadAuthorityConfirmed(
          draft.pendingSubmission,
          candidate.value,
        )) {
          writeChatState(candidate.key, "");
        }
      }
      return draft.pendingSubmission;
    },
    [
      conversationDraftId,
      draftOwnerId,
      draftStorageKey,
      projectId,
      uploadAuthorityStoragePrefix,
    ],
  );
  const markUserDraftMutation = useCallback(() => {
    userDraftMutationGeneration.current += 1;
    pendingSubmissionRef.current = undefined;
    draftConflictGeneration.current += 1;
    setDraftConflict(undefined);
    setRestoringDraftConflict(false);
    setPreparedRetry(undefined);
    onSubmissionIntentChange?.();
  }, [onSubmissionIntentChange]);
  const markDraftEdited = useCallback(() => {
    markUserDraftMutation();
    draftEditVersion.current += 1;
    draftLocallyEdited.current = true;
  }, [markUserDraftMutation]);
  const replaceText = useCallback(
    (next: string | ((current: string) => string)) => {
      const resolved =
        typeof next === "function" ? next(textRef.current) : next;
      if (resolved === textRef.current) return;
      draftContentGeneration.current += 1;
      textRef.current = resolved;
      setTextState(resolved);
    },
    [],
  );
  const update = useCallback(
    (next: string | ((current: string) => string)) => {
      if (draftMutationLockedRef.current) return;
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
      if (draftMutationLockedRef.current) return;
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
        { caret: insertion.caret },
      );
      setSendError(undefined);
      setCaret(insertion.caret);
      setHighlighted(0);
      setSuppressMenu(false);
      requestAnimationFrame(() => inputRef.current?.focus());
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
  useEffect(() => {
    if (previousSubmissionRuntimeKey.current === submissionRuntimeKey) return;
    previousSubmissionRuntimeKey.current = submissionRuntimeKey;
    pendingSubmissionRef.current = pendingSubmissionAfterRuntimeObservation(
      pendingSubmissionRef.current,
    );
    if (pendingSubmissionRef.current) return;
    setPreparedRetry(undefined);
    onSubmissionIntentChange?.();
  }, [onSubmissionIntentChange, submissionRuntimeKey]);
  useEffect(() => {
    if (previousSubmissionRuntimeIntentKey.current === submissionRuntimeIntentKey) return;
    previousSubmissionRuntimeIntentKey.current = submissionRuntimeIntentKey;
    if (!pendingSubmissionRef.current) return;
    pendingSubmissionRef.current = undefined;
    setPreparedRetry(undefined);
    draftEditVersion.current += 1;
    draftLocallyEdited.current = true;
    setDraftReadyVersion(value => value + 1);
    onSubmissionIntentChange?.();
  }, [onSubmissionIntentChange, submissionRuntimeIntentKey]);
  const replacePastedText = useCallback(
    (
      next:
        | string
        | undefined
        | ((current: string | undefined) => string | undefined),
    ) => {
      const resolved =
        typeof next === "function" ? next(pastedTextRef.current) : next;
      if (resolved === pastedTextRef.current) return;
      draftContentGeneration.current += 1;
      pastedTextRef.current = resolved;
      setPastedTextState(resolved);
    },
    [],
  );
  const updatePastedText = useCallback(
    (next: string | undefined) => {
      if (draftMutationLockedRef.current) return;
      if (next === pastedTextRef.current) return;
      pastedTextMutationGeneration.current += 1;
      const displacedFailures = failedDraftContentsRef.current.filter(
        item => item.kind === "pasted-text",
      );
      for (const failure of displacedFailures) {
        draftWriteChain.current.pendingDeletionIds.add(failure.id);
      }
      if (displacedFailures.length > 0) {
        updateFailedDraftContents(current =>
          current.filter(item => item.kind !== "pasted-text"),
        );
      }
      const previousAttachmentId = pastedTextAttachmentId.current;
      pastedTextAttachmentId.current = undefined;
      pastedTextUploadGeneration.current += 1;
      setPastedTextUploading(false);
      pastedTextUploadFailedFor.current = undefined;
      markDraftEdited();
      replacePastedText(next);
      if (conversationDraftId && previousAttachmentId) {
        draftWriteChain.current.pendingDeletionIds.add(previousAttachmentId);
      }
    },
    [
      conversationDraftId,
      draftOwnerId,
      markDraftEdited,
      replacePastedText,
      updateFailedDraftContents,
    ],
  );
  const invalidateDraftHydration = useCallback(() => {
    draftHydrationGeneration.current += 1;
  }, []);
  const markDraftAttachmentsEdited = useCallback(
    (removedAttachmentId?: string) => {
      if (draftMutationLockedRef.current) return;
      draftContentGeneration.current += 1;
      if (removedAttachmentId) {
        draftWriteChain.current.pendingDeletionIds.add(removedAttachmentId);
        unrestoredDraftAttachmentIds.current =
          unrestoredDraftAttachmentIds.current.filter(
            id => id !== removedAttachmentId,
          );
        updateFailedDraftContents(current =>
          current.filter(item => item.id !== removedAttachmentId),
        );
      }
      draftAttachmentsLocallyEdited.current = true;
      markDraftEdited();
    },
    [markDraftEdited, updateFailedDraftContents],
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
    addFiles: addDraftFiles,
    attachmentIds: draftAttachmentIds,
    metadata: draftAttachmentMetadata,
    attachmentVersion: draftAttachmentVersion,
    clear: clearDraftAttachments,
    locallyRemovedIds: locallyRemovedDraftAttachmentIds,
    mergeRestored: mergeRestoredDraftAttachments,
    removeFile: removeDraftFile,
    replaceRestored: replaceRestoredDraftAttachments,
    replaceSnapshot: replaceSnapshotDraftAttachments,
    retryUpload: retryDraftUploadBase,
    uploadStates: draftUploadStates,
  } = draftAttachments;
  const addFiles = useCallback((candidates: File[]) => {
    if (!draftMutationLockedRef.current) addDraftFiles(candidates);
  }, [addDraftFiles]);
  const importAttachments = async (entries: Array<FileSystemEntry | File>) => {
    if (!attachmentImportAllowedRef.current || draftMutationLockedRef.current || attachmentImportBusy.current) return;
    attachmentImportBusy.current = true;
    const generation = ++attachmentImportGeneration.current;
    const scope = attachmentImportScope;
    const checkActive = () => {
      if (generation !== attachmentImportGeneration.current || scope !== attachmentImportScopeRef.current ||
          !attachmentImportAllowedRef.current || draftMutationLockedRef.current) throw new Error("Folder preparation was cancelled because the destination is no longer available.");
    };
    setPreparingFolder(true);
    try {
      const maxBytes = Math.min(assetLimits?.maxFileBytes ?? COMPOSER_MAX_FILE_BYTES,
        (assetLimits?.maxMessageBytes ?? COMPOSER_MAX_FILE_BYTES) - files.reduce((sum, file) => sum + file.size, 0));
      const result = await collectAttachments(entries, maxBytes, checkActive);
      checkActive();
      addFiles(result.files);
      if (result.skipped) dispatchAttachments({ type: "set_error", error: `Skipped ${result.skipped} hidden, sensitive, or dependency items while preparing the folder ZIP.` });
    } catch (error) {
      if (generation === attachmentImportGeneration.current && scope === attachmentImportScopeRef.current) {
        dispatchAttachments({ type: "set_error", error: error instanceof Error ? error.message : "The folder could not be prepared. Nothing was attached." });
      }
    } finally {
      if (generation === attachmentImportGeneration.current && scope === attachmentImportScopeRef.current) {
        attachmentImportBusy.current = false; setPreparingFolder(false);
      }
    }
  };
  const removeFile = useCallback((index: number) => {
    if (!draftMutationLockedRef.current) removeDraftFile(index);
  }, [removeDraftFile]);
  const retryDraftUpload = useCallback((file: File) => {
    if (!draftMutationLockedRef.current) retryDraftUploadBase(file);
  }, [retryDraftUploadBase]);
  const removeFailedDraftContent = useCallback((id: string) => {
    if (draftMutationLockedRef.current) return;
    const failed = failedDraftContentsRef.current.find(item => item.id === id);
    if (!failed) return;
    if (failed.kind === "pasted-text") {
      pastedTextMutationGeneration.current += 1;
      pastedTextAttachmentId.current = undefined;
      replacePastedText(undefined);
    } else {
      unrestoredDraftAttachmentIds.current =
        unrestoredDraftAttachmentIds.current.filter(candidate => candidate !== id);
    }
    draftWriteChain.current.pendingDeletionIds.add(id);
    locallyRemovedDraftAttachmentIds.current.add(id);
    updateFailedDraftContents(current => current.filter(item => item.id !== id));
    dispatchAttachments({ type: "clear_error" });
    markDraftEdited();
  }, [
    dispatchAttachments,
    locallyRemovedDraftAttachmentIds,
    markDraftEdited,
    replacePastedText,
    updateFailedDraftContents,
  ]);
  const retryFailedDraftContent = useCallback(async (id: string) => {
    if (draftMutationLockedRef.current) return;
    const failed = failedDraftContentsRef.current.find(item => item.id === id);
    if (!failed || !conversationDraftId) return;
    const scope = conversationDraftId;
    const hydrationGeneration = draftHydrationGeneration.current;
    const pasteMutationGeneration = pastedTextMutationGeneration.current;
    const stillOwnsFailure = () =>
      draftContentRetryStillOwned({
        capturedScope: scope,
        currentScope: activeDraftScopeRef.current,
        capturedHydrationGeneration: hydrationGeneration,
        currentHydrationGeneration: draftHydrationGeneration.current,
        removed: locallyRemovedDraftAttachmentIds.current.has(id),
        failurePresent: failedDraftContentsRef.current.some(item =>
          item.id === id && item.kind === failed.kind),
      });
    const canApplyPaste = () =>
      stillOwnsFailure() && draftContentRetryStillOwned({
        capturedScope: scope,
        currentScope: activeDraftScopeRef.current,
        capturedHydrationGeneration: hydrationGeneration,
        currentHydrationGeneration: draftHydrationGeneration.current,
        removed: locallyRemovedDraftAttachmentIds.current.has(id),
        failurePresent: true,
        capturedPasteMutationGeneration: pasteMutationGeneration,
        currentPasteMutationGeneration: pastedTextMutationGeneration.current,
      });
    setSendError(undefined);
    try {
      const refreshedDraft = failed.attachment
        ? undefined
        : await api.getConversationDraft(scope, draftOwnerId);
      if (!stillOwnsFailure()) return;
      const attachment = failed.attachment ??
        (failed.kind === "pasted-text"
          ? refreshedDraft?.pastedTextAttachment
          : refreshedDraft?.attachments?.find(item => item.id === id));
      if (!attachment) throw new Error("The staged content is no longer available.");
      const file = await api.downloadDraftAttachment(attachment);
      if (failed.kind === "pasted-text" ? !canApplyPaste() : !stillOwnsFailure()) {
        return;
      }
      if (failed.kind === "pasted-text") {
        const restoredText = await file.text();
        if (!canApplyPaste()) return;
        pastedTextMutationGeneration.current += 1;
        pastedTextCleanMutationGeneration.current =
          pastedTextMutationGeneration.current;
        pastedTextAttachmentId.current = id;
        replacePastedText(restoredText);
      } else {
        mergeRestoredDraftAttachments([{ attachment, file }]);
        unrestoredDraftAttachmentIds.current =
          unrestoredDraftAttachmentIds.current.filter(candidate => candidate !== id);
      }
      if (!stillOwnsFailure()) return;
      updateFailedDraftContents(current => current.filter(item => item.id !== id));
      dispatchAttachments({ type: "clear_error" });
    } catch (error) {
      if (!stillOwnsFailure()) return;
      setSendError(
        error instanceof Error ? error.message : "Draft content could not be restored.",
      );
    }
  }, [
    conversationDraftId,
    draftOwnerId,
    dispatchAttachments,
    mergeRestoredDraftAttachments,
    replacePastedText,
    updateFailedDraftContents,
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
  const durableRequest = pendingSubmissionRef.current?.request;
  const durableRetryAction = composerDurableRetryAction(
    preparedRetryAction,
    durableRequest?.runtime.activeRunDelivery,
  );
  const renderedDestinationIdentityRef = useRef<string>();
  renderedDestinationIdentityRef.current = renderedDefaultDestination?.selectionKey;
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
              ...(durableRequest?.mentionBindings ?? []).flatMap(binding => [
                binding.handle,
                binding.currentHandle,
              ]),
              NEW_AGENT_DESTINATION_HANDLE,
            ]),
          ]
        : (mentionHandles ?? []),
    [destinationMode, durableRequest, knownMentionBindings, mentionHandles],
  );
  const visibleRoutingText = renderedDefaultDestination
    ? prependComposerDestination(
        visibleSubmissionText,
        renderedDefaultDestination.handle,
      )
    : visibleSubmissionText;
  const durableRoutingText = (durableRequest?.mentionBindings ?? []).reduce(
    (current, binding) =>
      hasComposerDestination(current, binding.handle) ||
        hasComposerDestination(current, binding.currentHandle)
        ? current
        : prependComposerDestination(current, binding.handle),
    visibleRoutingText,
  );
  const mentionedHandles = useMemo(
    () => findMentionedHandles(durableRoutingText, routingMentionHandles),
    [durableRoutingText, routingMentionHandles],
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
  const invalidMention = mentionTokens.find(token =>
    !token.valid && (!token.agentId || !durableRequest?.recipientAgentIds.includes(token.agentId)));
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
  ) && !pendingSubmissionRef.current?.request?.mentionBindings?.some(binding =>
    binding.handle.toLocaleLowerCase() === handle.toLocaleLowerCase() ||
    binding.currentHandle.toLocaleLowerCase() === handle.toLocaleLowerCase()));
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
      projectDestinations.length === 1
      ? resolvedMentionBinding(projectDestinations[0]!.handle, knownMentionBindings, mentionBindings ?? [])?.agentId
      : destinationMode === "fixed"
        ? defaultDestination?.binding?.agentId
        : undefined;
  useEffect(() => {
    onCommandTargetHandleChange?.(commandTargetHandle);
  }, [commandTargetHandle, onCommandTargetHandleChange]);
  useEffect(() => {
    onCommandTargetAgentIdChange?.(commandTargetAgentId);
  }, [commandTargetAgentId, onCommandTargetAgentIdChange]);
  const retainedDestinationUnavailable = renderedDefaultDestination?.binding &&
    !mentionBindings?.some(binding => binding.agentId === renderedDefaultDestination.binding!.agentId);
  const destinationError =
    retainedDestinationUnavailable
      ? `#${renderedDefaultDestination!.handle} no longer identifies an available Agent. Remove it before sending.`
      : invalidMention
      ? `#${invalidMention.handle} no longer identifies an available Agent. Remove it before sending.`
      : unresolvedAuthoredTarget
        ? `#${unresolvedAuthoredTarget} does not identify one available Agent. Remove it or choose an Agent again.`
      : destinationMode === "target-required" && hasBroadcastDestination
      ? targetRequiredDestinations.length > 0
        ? "Broadcast is only available in a Chat."
        : "#broadcast is not available in Messages Across Ponderosa. Choose an Agent."
      : destinationMode === "target-required" && unresolvedAmbiguousTarget
          ? `#${unresolvedAmbiguousTarget} matches more than one Agent. Use a message's # action to choose the exact Agent.`
          : undefined;
  const toggleNewAgentDestination = () => {
    if (draftMutationLockedRef.current) return;
    const selectingNewAgent = !newAgentSelected;
    update(current => {
      if (!selectingNewAgent) {
        const next = removeComposerDestinations(current, [NEW_AGENT_DESTINATION_HANDLE]);
        return destinationMode === "project-chat" && defaultDestination
          ? prependComposerDestination(next, defaultDestination.handle)
          : next;
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
      selectingNewAgent || destinationMode === "project-chat" ? undefined : defaultDestination,
    );
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const clearActiveDefaultDestination = useCallback(() => {
    if (draftMutationLockedRef.current) return;
    setActiveDefaultDestination(undefined);
  }, []);
  const clearRequiredRecipient = () => {
    if (draftMutationLockedRef.current) return;
    markUserDraftMutation();
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
    text: composerSubmissionText(removeComposerDestinations(text, [...mentionedHandles, "broadcast", "everyone", NEW_AGENT_DESTINATION_HANDLE]), pastedText),
    disabled: disabled || submissionDisabled === true,
    running: composerLocked,
    allowUnmentionedSend:
      allowUnmentionedSend || Boolean(durableRetryAction),
    mentionedHandles,
    mentionedBusyHandles,
  });
  const liveRequiredRecipientTagged = Boolean(
    requiredRecipient &&
    targetRequiredHandles.some(handle =>
      requiredRecipient.handle.toLocaleLowerCase() === handle.toLocaleLowerCase()),
  );
  const targetRequiredRecipientTagged = composerRecipientGateSatisfied({
    destinationMode,
    newAgentSelected,
    requiredRecipientTagged: liveRequiredRecipientTagged,
    retryPrepared: Boolean(durableRetryAction || durableRequest),
  });
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
    mentionBindingsReady &&
    !sending &&
    !preparingFolder &&
    !dictationSettling &&
    (!destinationError || Boolean(durableRetryAction) || Boolean(pendingSubmissionRef.current?.request)) &&
    targetRequiredRecipientTagged &&
    draftUploadsReady &&
    durableContentReady &&
    (textCanSend ||
      (!disabled && !submissionDisabled &&
        !composerLocked &&
        allowUnmentionedSend &&
        files.length > 0));
  const canCancel = running && Boolean(onCancel);
  const composerAttachmentsEnabled = attachmentsEnabled;
  const composerAttachmentsUnavailableReason = attachmentsUnavailableReason;
  attachmentImportAllowedRef.current = attachmentsEnabled && !disabled && !composerLocked && !draftMutationLocked;
  const fileDropEnabled = attachmentImportAllowedRef.current && !preparingFolder;
  useEffect(() => {
    fileDragDepth.current = 0;
    setFileDragActive(false);
  }, [fileDropEnabled, conversationDraftId, draftStorageKey]);

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
    mutationLocked: draftMutationLocked,
    inputRef,
    insertTextRequest,
    setCaret,
    selectionIntent,
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

  const carriedUntargetedDraft = preserveUntargetedDraft &&
    previousConversationDraftId.current === undefined && conversationDraftId &&
    textRef.current.trim() ? textRef.current : undefined;
  useComposerDraftStorageReset({
    draftStorageKey,
    previousDraftStorageKey,
    setPastedText: replacePastedText,
    setText: replaceText,
    carryText: carriedUntargetedDraft,
  });

  useEffect(() => {
    const changed = previousConversationDraftId.current !== conversationDraftId;
    previousConversationDraftId.current = conversationDraftId;
    if (changed) {
      draftGeneration.current += 1;
      draftWriteChain.current = createDraftWriteChain();
      pastedTextMutationGeneration.current += 1;
      pastedTextCleanMutationGeneration.current =
        pastedTextMutationGeneration.current;
      pastedTextUploadGeneration.current += 1;
      pastedTextAttachmentId.current = undefined;
      setPastedTextUploading(false);
      updateFailedDraftContents([]);
      draftConflictGeneration.current += 1;
      setDraftConflict(undefined);
      setRestoringDraftConflict(false);
      replacePastedText(undefined);
      draftReady.current = false;
      draftLocallyEdited.current = false;
      draftAttachmentsLocallyEdited.current = false;
      unrestoredDraftAttachmentIds.current = [];
      draftRevision.current = 0;
      pendingSubmissionRef.current = undefined;
      setKnownMentionBindings([]);
      clearDraftAttachments();
      if (carriedUntargetedDraft !== undefined) {
        draftLocallyEdited.current = true;
        draftEditVersion.current++;
        setKnownMentionBindings(refreshedMentionBindings(carriedUntargetedDraft, [], mentionBindings ?? []));
        writeDraftTextRecovery(draftStorageKey, { text: carriedUntargetedDraft, mentionBindings: [], expectedRevision: 0, clientId: draftWriteChain.current.clientId });
      }
    }
  }, [
    conversationDraftId,
    clearDraftAttachments,
    replacePastedText,
    updateFailedDraftContents,
  ]);

  useEffect(() => () => {
    activeDraftScopeRef.current = undefined;
    draftGeneration.current += 1;
  }, []);

  useEffect(() => {
    const canonicalDraft = draftQuery.data;
    const pendingText = !draftReady.current && canonicalDraft
      ? recoverDraftText(draftStorageKey, canonicalDraft) : undefined;
    // Recovered edits retain their original revision. A competing save is handled
    // by the existing 409/recovery flow, never by adopting overwrite authority.
    const draft = canonicalDraft && pendingText
      ? { ...canonicalDraft, text: pendingText.text, mentionBindings: pendingText.mentionBindings,
          ...(pendingText.attachmentIds ? { attachmentIds: pendingText.attachmentIds, attachments: pendingText.attachments?.filter(asset =>
            asset.conversationId === conversationDraftId && asset.ownerId === draftOwnerId &&
            asset.downloadUrl === `/api/conversations/${encodeURIComponent(conversationDraftId)}/draft-attachments/${encodeURIComponent(asset.id)}?ownerId=${encodeURIComponent(draftOwnerId)}`
          ) ?? canonicalDraft.attachments } : {}), pendingSubmission: undefined }
      : canonicalDraft;
    if (
      sendingRef.current ||
      !conversationDraftId ||
      !draft ||
      (draftReady.current && draft.revision <= draftRevision.current)
    )
      return;
    let cancelled = false;
    const hydrationGeneration = ++draftHydrationGeneration.current;
    const pastedTextCleanMutationAtStart =
      pastedTextCleanMutationGeneration.current;
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
      draftRevision.current = draft.revision;
      const local = draftStorageKey
        ? (readChatState(draftStorageKey) ?? "")
        : "";
      const adoptDraft = shouldAdoptHydratedDraft(
        inputRef.current?.isFocused() ?? false,
        draftLocallyEdited.current,
      );
      draftWriteChain.current.ownedRevision = ownedDraftRevisionAfterObservation(
        draftWriteChain.current.ownedRevision,
        draft.revision,
        adoptDraft,
      );
      if (adoptDraft && pendingText) {
        draftWriteChain.current.ownedRevision = pendingText.expectedRevision;
        draftWriteChain.current.recoveredText = pendingText;
        draftWriteChain.current.recoveryStorageKey = draftStorageKey;
      }
      if (!adoptDraft) {
        draftReady.current = true;
        setDraftReadyVersion(value => value + 1);
        return;
      }
      pendingSubmissionRef.current = pendingSubmissionWithLocalUploadAuthority(
        draft,
      );
      draftContentGeneration.current += 1;
      if (!draftAttachmentsLocallyEdited.current) {
        replaceRestoredDraftAttachments(restored);
      } else {
        mergeRestoredDraftAttachments(restored);
      }
      unrestoredDraftAttachmentIds.current = failedAttachments.map(item => item.id);
      const hydratedPastedText = hydratedPastedTextContent({
        attachmentId: draft.pastedTextAttachmentId,
        restoredText: restoredPastedText,
        failure: failedPastedText,
        cleanMutationGeneration: pastedTextCleanMutationAtStart,
        currentMutationGeneration: pastedTextMutationGeneration.current,
      });
      if (
        !hydratedPastedText &&
        draft.pastedTextAttachmentId &&
        pastedTextAttachmentId.current !== draft.pastedTextAttachmentId
      ) {
        draftWriteChain.current.pendingDeletionIds.add(
          draft.pastedTextAttachmentId,
        );
      }
      updateFailedDraftContents(current => [
        ...failedAttachments,
        ...(hydratedPastedText
          ? hydratedPastedText.failure
            ? [hydratedPastedText.failure]
            : []
          : current.filter(item => item.kind === "pasted-text")),
      ]);
      if (hydratedPastedText) {
        const previousPastedTextAttachmentId = pastedTextAttachmentId.current;
        if (
          previousPastedTextAttachmentId &&
          previousPastedTextAttachmentId !== hydratedPastedText.attachmentId
        ) {
          draftWriteChain.current.pendingDeletionIds.add(
            previousPastedTextAttachmentId,
          );
        }
        pastedTextAttachmentId.current = hydratedPastedText.attachmentId;
        replacePastedText(
          hydratedPastedText.failure ? undefined : hydratedPastedText.text,
        );
        pastedTextCleanMutationGeneration.current =
          pastedTextMutationGeneration.current;
      }
      const hydrated = hydratedDraftContent(
        draft.revision,
        draft.text,
        local,
        draft.mentionBindings ?? [],
      );
      replaceText(hydrated.text);
      setKnownMentionBindings([...hydrated.mentionBindings]);
      if (draftStorageKey) writeChatState(draftStorageKey, hydrated.text);
      if (pendingText) {
        draftLocallyEdited.current = true;
        draftEditVersion.current += 1;
      }
      if (failedAttachments.length || hydratedPastedText?.failure) {
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
        const adoptDraft = shouldAdoptHydratedDraft(
          inputRef.current?.isFocused() ?? false,
          draftLocallyEdited.current,
        );
        draftWriteChain.current.ownedRevision = ownedDraftRevisionAfterObservation(
          draftWriteChain.current.ownedRevision,
          draft.revision,
          adoptDraft,
        );
        if (adoptDraft && pendingText) {
          draftWriteChain.current.ownedRevision = pendingText.expectedRevision;
          draftWriteChain.current.recoveredText = pendingText;
          draftWriteChain.current.recoveryStorageKey = draftStorageKey;
        }
        if (!adoptDraft) {
          draftReady.current = true;
          setDraftReadyVersion(value => value + 1);
          return;
        }
        pendingSubmissionRef.current = pendingSubmissionWithLocalUploadAuthority(
          draft,
        );
        draftContentGeneration.current += 1;
        unrestoredDraftAttachmentIds.current = draft.attachmentIds.filter(
          id => !locallyRemovedDraftAttachmentIds.current.has(id),
        );
        const failedPastedText =
          draft.pastedTextAttachmentId &&
          !locallyRemovedDraftAttachmentIds.current.has(
            draft.pastedTextAttachmentId,
          )
            ? {
                id: draft.pastedTextAttachmentId,
                name: "Pasted text",
                kind: "pasted-text" as const,
                ...(draft.pastedTextAttachment
                  ? { attachment: draft.pastedTextAttachment }
                  : {}),
              }
            : undefined;
        const hydratedPastedText = hydratedPastedTextContent({
          attachmentId: draft.pastedTextAttachmentId,
          failure: failedPastedText,
          cleanMutationGeneration: pastedTextCleanMutationAtStart,
          currentMutationGeneration: pastedTextMutationGeneration.current,
        });
        if (
          !hydratedPastedText &&
          draft.pastedTextAttachmentId &&
          pastedTextAttachmentId.current !== draft.pastedTextAttachmentId
        ) {
          draftWriteChain.current.pendingDeletionIds.add(
            draft.pastedTextAttachmentId,
          );
        }
        updateFailedDraftContents(current => [
          ...draft.attachmentIds
            .filter(id => !locallyRemovedDraftAttachmentIds.current.has(id))
            .map(id => ({ id, name: "Staged attachment", kind: "attachment" as const })),
          ...(hydratedPastedText
            ? hydratedPastedText.failure
              ? [hydratedPastedText.failure]
              : []
            : current.filter(item => item.kind === "pasted-text")),
        ]);
        if (hydratedPastedText) {
          const previousPastedTextAttachmentId = pastedTextAttachmentId.current;
          if (
            previousPastedTextAttachmentId &&
            previousPastedTextAttachmentId !== hydratedPastedText.attachmentId
          ) {
            draftWriteChain.current.pendingDeletionIds.add(
              previousPastedTextAttachmentId,
            );
          }
          pastedTextAttachmentId.current = hydratedPastedText.attachmentId;
          replacePastedText(undefined);
          pastedTextCleanMutationGeneration.current =
            pastedTextMutationGeneration.current;
        }
        const local = draftStorageKey
          ? (readChatState(draftStorageKey) ?? "")
          : "";
        const hydrated = hydratedDraftContent(
          draft.revision,
          draft.text,
          local,
          draft.mentionBindings ?? [],
        );
        replaceText(hydrated.text);
        setKnownMentionBindings([...hydrated.mentionBindings]);
        if (draftStorageKey) writeChatState(draftStorageKey, hydrated.text);
        if (pendingText) {
          draftLocallyEdited.current = true;
          draftEditVersion.current += 1;
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
  }, [
    conversationDraftId,
    draftQuery.data,
    draftStorageKey,
    sending,
    pendingSubmissionWithLocalUploadAuthority,
    updateFailedDraftContents,
  ]);

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
    // A reply can arrive through SSE before the send request acknowledges.
    // Do not rewrite that submission's text/destination while it is settling.
    if (sendingRef.current) return;
    if (conversationDraftId && !draftReady.current) return;
    const previous = appliedDefaultDestination.current;
    if (!defaultDestination) {
      // A locally retained queue target remains selected even before an incoming
      // reply provides a parent continuation. New sends still validate its ID.
      if (destinationMode !== "project-chat") {
        appliedDefaultDestination.current = undefined;
        setActiveDefaultDestination(undefined);
      }
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
    const editor = inputRef.current;
    if (!editor || draftMutationLockedRef.current) return;
    // A continuation is a normal authored token, not an ephemeral overlay.
    // Seed only an empty draft with no retained destination: refreshes/new
    // replies must never duplicate or retarget an already selected recipient.
    const currentText = editor.getCanonicalText();
    if (!composerShouldSeedContinuationDestination({
      previousSelectionKey: previous?.selectionKey,
      nextSelectionKey: defaultDestination.selectionKey,
      retainedSelectionKey: activeDefaultDestination?.selectionKey,
      localText: textRef.current,
      editorText: currentText,
    })) {
      if (activeDefaultDestination) {
        appliedDefaultDestination.current = defaultDestination;
      }
      return;
    }
    appliedDefaultDestination.current = defaultDestination;
    const nextText = prependComposerDestination(currentText, defaultDestination.handle);
    if (defaultDestination.binding) {
      const binding = defaultDestination.binding;
      setKnownMentionBindings(previous => refreshedMentionBindings(nextText, previous, [binding, ...(mentionBindings ?? [])]));
    }
    editor.replaceCanonicalRange(0, currentText.length, nextText, { focus: false });
  }, [
    conversationDraftId,
    activeDefaultDestination?.selectionKey,
    defaultDestination?.binding?.currentTitle,
    defaultDestination?.handle,
    defaultDestination?.selectionKey,
    destinationMode,
    draftReadyVersion,
    draftMutationLocked,
    replaceText,
    sending,
  ]);

  useComposerDraftStorageWrite({
    draftStorageKey,
    text,
    textRef,
  });

  useEffect(() => {
    if (
      !conversationDraftId ||
      sendingRef.current ||
      !draftReady.current ||
      !draftLocallyEdited.current
    )
      return;
    writeDraftTextRecovery(draftStorageKey, {
      text,
      mentionBindings: knownMentionBindings,
      expectedRevision: draftWriteChain.current.ownedRevision,
      clientId: draftWriteChain.current.clientId,
      attachmentIds: files.flatMap(file => { const id = draftAttachmentIds.current.get(file); return id ? [id] : []; }),
      attachments: files.flatMap(file => { const id = draftAttachmentIds.current.get(file); const metadata = id ? draftAttachmentMetadata.current.get(id) : undefined; return metadata ? [metadata] : []; }),
    });
    const scheduledGeneration = draftGeneration.current;
    const timer = window.setTimeout(() => {
      // A queued debounce must not revive a sent draft or save an empty
      // snapshot after this surface has already relinquished draft ownership.
      if (sendingRef.current || !draftLocallyEdited.current ||
          scheduledGeneration !== draftGeneration.current) return;
      // Store the extracted paste and its draft reference as one logical draft
      // update. A partial write must never make a reload silently lose it.
      if (pastedText && !pastedTextAttachmentId.current) return;
      const generation = draftGeneration.current;
      const editVersion = draftEditVersion.current;
      const submittedPastedTextAttachmentId =
        pastedTextAttachmentId.current;
      const submittedPastedTextMutationGeneration =
        pastedTextMutationGeneration.current;
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
      const writeChain = draftWriteChain.current;
      const clientId = writeChain.clientId;
      const scope = conversationDraftId;
      const snapshot = {
        text,
        attachmentIds,
        files: files.flatMap(file => {
          const attachmentId = draftAttachmentIds.current.get(file);
          return attachmentId && attachmentIds.includes(attachmentId)
            ? [{ file, attachmentId }]
            : [];
        }),
        ...(pastedText !== undefined ? { pastedText } : {}),
        ...(submittedPastedTextAttachmentId
          ? { pastedTextAttachmentId: submittedPastedTextAttachmentId }
          : {}),
        mentionBindings: [...knownMentionBindings],
        ...(pendingSubmissionRef.current
          ? { pendingSubmission: pendingSubmissionRef.current }
          : {}),
        failedContents: [...failedDraftContentsRef.current],
      };
      writeChain.tail = settledDraftWriteContinuation(writeChain.tail, async () => {
        const stillOwnsWrite = () => draftWriteContinuationStillOwned({
          capturedScope: scope,
          currentScope: activeDraftScopeRef.current,
          capturedGeneration: generation,
          currentGeneration: draftGeneration.current,
        });
        if (!stillOwnsWrite()) return;
        try {
          const draft = await api.putConversationDraft(scope, withCapturedDraftSubmissions(scope, {
            text,
            attachmentIds,
            ...(submittedPastedTextAttachmentId
              ? { pastedTextAttachmentId: submittedPastedTextAttachmentId }
              : {}),
            mentionBindings: knownMentionBindings,
            ...(pendingSubmissionRef.current
              ? { pendingSubmission: pendingSubmissionRef.current }
              : {}),
            expectedRevision: writeChain.ownedRevision,
            clientId,
            ownerId: draftOwnerId,
          }, queryClient.getQueryData<ConversationDraftDto>(queryKeys.conversationDraft.detail(scope, draftOwnerId))));
          writeChain.ownedRevision = draft.revision;
          acknowledgeDraftTextRecovery(draftStorageKey, clientId, { text, mentionBindings: knownMentionBindings, attachmentIds }, draft.revision);
          acknowledgeRecoveredText(writeChain, { text, mentionBindings: knownMentionBindings }, draft.revision);
          const cleanupReleased = async (): Promise<void> => {
            await cleanupReleasedDraftAttachmentIds(
              writeChain.pendingDeletionIds,
              draft,
              id => api.deleteDraftAttachment(scope, draftOwnerId, id)
                .catch(error => {
                  if (
                    error instanceof ApiRequestError &&
                    (error.status === 404 || error.status === 409)
                  ) return;
                  throw error;
                }),
            );
            if (
              writeChain.cleanupRetryScheduled ||
              deletableSupersededDraftAttachmentIds(
                writeChain.pendingDeletionIds,
                draft,
              ).length === 0
            ) return;
            writeChain.cleanupRetryScheduled = true;
            window.setTimeout(() => {
              writeChain.cleanupRetryScheduled = false;
              writeChain.tail = settledDraftWriteContinuation(
                writeChain.tail,
                cleanupReleased,
              );
            }, 5_000);
          };
          await cleanupReleased();
          if (!stillOwnsWrite()) return;
          draftRevision.current = draft.revision;
          pastedTextCleanMutationGeneration.current =
            savedPastedTextCleanMutationGeneration({
              cleanMutationGeneration:
                pastedTextCleanMutationGeneration.current,
              submittedMutationGeneration:
                submittedPastedTextMutationGeneration,
              currentMutationGeneration:
                pastedTextMutationGeneration.current,
              submittedAttachmentId: submittedPastedTextAttachmentId,
              savedAttachmentId: draft.pastedTextAttachmentId,
            });
          if (
            draftEditVersion.current === editVersion &&
            attachmentsResolved
          ) {
            draftLocallyEdited.current = false;
            draftAttachmentsLocallyEdited.current = false;
          }
          draftConflictGeneration.current += 1;
          setDraftConflict(undefined);
          setRestoringDraftConflict(false);
          queryClient.setQueryData(
            queryKeys.conversationDraft.detail(
              scope,
              draftOwnerId,
            ),
            draft,
          );
        } catch (error) {
          if (!stillOwnsWrite()) return;
          if (!(error instanceof ApiRequestError) || error.status !== 409) {
            setSendError(
              error instanceof ApiRequestError && error.status === 429
                ? `Draft not saved yet. Your text and attachments remain here; retry in about ${Math.ceil((error.retryAfterMs ?? 1_000) / 1_000)} seconds.`
                : error instanceof Error
                ? error.message
                : "Draft could not be saved.",
            );
            return;
          }
          let current;
          try {
            current = await api.getConversationDraft(scope, draftOwnerId);
          } catch (recoveryError) {
            if (stillOwnsWrite()) {
              setSendError(
                recoveryError instanceof Error
                  ? `Draft changed elsewhere, but the current version could not be loaded: ${recoveryError.message}`
                  : "Draft changed elsewhere, but the current version could not be loaded.",
              );
            }
            return;
          }
          if (!stillOwnsWrite()) return;
          draftRevision.current = current.revision;
          queryClient.setQueryData(
            queryKeys.conversationDraft.detail(
              scope,
              draftOwnerId,
            ),
            current,
          );
          const conflicts = await api
            .getConversationDraftConflicts(scope, draftOwnerId)
            .catch(() => undefined);
          if (!stillOwnsWrite()) return;
          const conflict = conflicts?.conflicts
            .filter(candidate => candidate.displaced.clientId === clientId)
            .at(-1);
          if (!conflict) {
            const rejected = rejectedDraftConflict(error, current);
            if (rejected) {
              writeChain.ownedRevision = current.revision;
              setDraftConflict({
                conflict: rejected,
                snapshot,
                resolutionUnavailable: true,
              });
              setSendError(undefined);
              return;
            }
            setSendError(
              "This draft changed elsewhere. Your text remains in the composer, but its recovery record could not be loaded.",
            );
            return;
          }
          draftConflictGeneration.current += 1;
          setDraftConflict(recoverableDraftConflict(conflict, snapshot));
        }
      }).catch(error => {
        if (!draftWriteContinuationStillOwned({
          capturedScope: scope,
          currentScope: activeDraftScopeRef.current,
          capturedGeneration: generation,
          currentGeneration: draftGeneration.current,
        })) return;
        setSendError(
          error instanceof Error ? error.message : "Draft could not be saved.",
        );
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [
    draftStorageKey,
    conversationDraftId,
    draftAttachmentVersion,
    draftOwnerId,
    draftReadyVersion,
    failedDraftContents.length,
    files,
    queryClient,
    knownMentionBindings,
    pastedText,
    sending,
    text,
  ]);

  // Agent routing uses #; @ is reserved for project file/folder references.
  const mentionMatch = activeComposerMention(text.slice(0, caret));
  const autocompleteHandles = [...new Set([
    ...(mentionSuggestionHandles ?? mentionHandles ?? []),
    ...(destinationMode === "project-chat" ? ["broadcast"] : []),
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
    if (draftMutationLockedRef.current) return;
    authoredTextInput.current = true;
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
      inputRef.current?.resetDocument(next);
      update(next);
      setHighlighted(0);
      inputRef.current?.focus();
      setCaret(next.length);
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
      inputRef.current.insertMention(descriptor, " ");
    } else {
      update(
        `${selection.text.slice(0, selection.start)}#${handle} ${selection.text.slice(selection.end)}`,
      );
    }
    setHighlighted(0);
    const nextCaret = selection.start + (descriptor?.handle ?? handle).length + 2;
    setCaret(nextCaret);
  };

  const applyFileReference = (entry: ArtifactDto) => {
    if (draftMutationLockedRef.current) return;
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
    // Insertion commits its selection synchronously; never restore an old
    // offset in a later frame after newer typing or a Chat change.
    setCaret(nextCaret);
    setSuppressMenu(false);
  };

  const applyCommand = (command: EngineCommand) => {
    if (draftMutationLockedRef.current) return;
    if (engineCommandDisabledReason(command)) return;
    if (!commandDraft) return;
    const nextCaret = commandDraft.start + command.insertText.length;
    inputRef.current?.replaceCanonicalRange(
      commandDraft.start,
      caret,
      command.insertText,
      { caret: nextCaret },
    );
    setHighlighted(0);
    setCaret(nextCaret);
  };

  const applyCapability = (capability: EngineComposerCapability) => {
    if (draftMutationLockedRef.current) return;
    const inserted = insertComposerCapability(text, caret, capability);
    if (!inserted) return;
    inputRef.current?.replaceCanonicalRange(0, text.length, inserted.text, {
      caret: inserted.caret,
    });
    setCapabilityMenuAnchor(null);
    setCapabilityFilter("");
    setCaret(inserted.caret);
  };

  const visibleCapabilities = matchingComposerCapabilities(
    capabilities ?? [],
    capabilityFilter,
  );

  type SubmissionHandler = ComposerProps["onSend"];
  const executeCaptured = (
    item: CapturedSubmission,
    handler: SubmissionHandler,
    writeChain: DraftWriteChain,
    selectedFiles: File[] = [],
  ) => {
    const previouslyDispatched = item.dispatchStarted === true;
    let dispatchInvoked = false;
    let outgoingId: string | undefined;
    const persist = async (pending: DraftPendingSubmissionDto, retire = false) => {
      item = { ...item, pending };
      if (!retire) saveCapturedSubmission(item);
      if (!item.scope || item.scope.startsWith("local:")) return;
      let alreadyRetired = false;
      const write = settledDraftWriteContinuation(writeChain.tail, async () => {
        const result = await persistCapturedDraftSubmission(
          item.scope, item.ownerId, item.clientId, pending, retire, writeChain.ownedRevision,
        );
        if (result.mayAdvanceDraftRevision) {
          const beforeRevision = writeChain.ownedRevision;
          writeChain.ownedRevision = result.draft.revision;
          // Our metadata-only CAS did not alter editable content. Advance the
          // same local recovery incarnation, preserving any newer text verbatim.
          const recovered = readDraftTextRecoveries(item.storageKey).find(snapshot => snapshot.clientId === writeChain.clientId);
          if (recovered && recovered.expectedRevision === beforeRevision) {
            writeDraftTextRecovery(item.storageKey, { ...recovered, expectedRevision: result.draft.revision });
          }
        }
        // Metadata writes retain the exact editable body. Hydration still obeys
        // the existing edit-generation gate, including after navigation.
        queryClient.setQueryData<ConversationDraftDto>(
          queryKeys.conversationDraft.detail(item.scope, item.ownerId),
          current => current && current.revision > result.draft.revision ? current : result.draft,
        );
        alreadyRetired = result.retired === true;
        if (retire || alreadyRetired) removeCapturedSubmission(item.pending.idempotencyKey);
      });
      writeChain.tail = write;
      await write;
      return alreadyRetired;
    };
    void runCapturedSubmission(item, async () => {
      if (item.status === "accepted") {
        await persist(item.pending, true);
        if (item.scope.startsWith("local:")) removeCapturedSubmission(item.pending.idempotencyKey);
        return;
      }
      item = { ...item, status: "pending", error: undefined };
      saveCapturedSubmission(item);
      if (item.pending.fingerprint === "0".repeat(64)) {
        const fingerprint = await durableSubmissionFingerprint({
          action: item.action, scope: item.scope, text: item.text,
          pending: item.pending, newAgentRequested: item.newAgentRequested,
        });
        item = { ...item, pending: { ...item.pending, fingerprint, intentFingerprint: fingerprint } };
      }
      if (await persist(item.pending)) return;
      let exactFiles = selectedFiles;
      if (exactFiles.length === 0 && (item.pending.draftAttachmentIds?.length ?? 0) > 0) {
        const saved = await api.getConversationDraft(item.scope, item.ownerId);
        const byId = new Map([...(saved.attachments ?? []), ...(saved.pendingSubmissionAttachments ?? [])].map(attachment => [attachment.id, attachment]));
        exactFiles = await Promise.all(item.pending.draftAttachmentIds!.map(async id => {
          const metadata = byId.get(id);
          if (!metadata) throw new Error("A captured attachment is unavailable. The original operation remains preserved; inspect its recovery before retrying.");
          return api.downloadDraftAttachment(metadata);
        }));
      }
      item = { ...item, dispatchStarted: true };
      saveCapturedSubmission(item);
      if (outgoingId && !item.newAgentRequested) {
        const conversationId = item.pending.request?.conversationId;
        const key = item.pending.idempotencyKey;
        if (conversationId) {
          await outgoing?.identify(outgoingId, hasBroadcastMention(item.text) ? "broadcast" : "user-dm",
            hasBroadcastMention(item.text) ? `${conversationId}\0${key}` : `multi-direct:${conversationId}:${key}`);
        } else if (item.projectId && item.scope.startsWith("agent:")) {
          await outgoing?.identify(outgoingId, "user-message", `${item.projectId}\0${item.scope.slice(6)}\0${key}`);
        }
      }
      dispatchInvoked = true;
      const result = await handler(
        item.text, exactFiles, item.pending.draftAttachmentIds ?? [], item.ownerId,
        {
          mentionedAgents: item.mentionedAgents,
          newAgentRequested: item.newAgentRequested,
          pendingSubmission: item.pending,
          retryPreparedAttempt: true,
          capturedSubmission: true,
          capturedProjectId: item.projectId,
          persistPendingSubmission: async value => { await persist(value); },
          onAgentCreated: agent => { if (outgoingId) outgoing?.agentCreated(outgoingId, agent); },
        },
      );
      const receipt = result as { communicationEventId?: string; message?: { communicationEventId?: string }; deliveryId?: string; recipients?: Array<{ deliveryId?: string }>; deliveryIds?: string[] } | undefined;
      if (outgoingId) outgoing?.accepted(outgoingId, receipt?.communicationEventId ?? receipt?.message?.communicationEventId);
      const acceptedDeliveryIds = receipt?.deliveryIds ?? receipt?.recipients?.flatMap(recipient => recipient.deliveryId ? [recipient.deliveryId] : []) ?? (receipt?.deliveryId ? [receipt.deliveryId] : []);
      item = { ...item, status: "accepted", acceptedDeliveryIds, error: undefined };
      saveCapturedSubmission(item);
      // The server receipt owns accepted/queued state. Retire only this browser
      // intent and its protection metadata; never clear the active draft here.
      await persist(item.pending, true);
      if (item.scope.startsWith("local:")) removeCapturedSubmission(item.pending.idempotencyKey);
      return result;
    }).catch(error => {
      const accepted = item.status === "accepted";
      const definitive = !accepted && (dispatchInvoked || !previouslyDispatched) &&
        (error instanceof CapturedSubmissionOrderError || (error instanceof ApiRequestError &&
        durableSubmissionMayBeReleased(item.pending, error.status, error.message)));
      item = { ...item, status: accepted ? "accepted" : definitive ? "failed" : "unknown", error: accepted
        ? `Message ${item.action === "queue" ? "queued" : "sent"}; recovery cleanup failed. ${error instanceof Error ? error.message : "Try cleanup again."}`
        : error instanceof Error ? error.message : "Acceptance could not be confirmed. Retry this captured message." };
      try { saveCapturedSubmission(item); } catch { /* Existing captured bytes remain recoverable. */ }
    }).finally(() => { if (outgoingId) outgoing?.finish(outgoingId); });
    // Register transport before optimistic rendering can expose the captured send in the recovery tray.
    outgoingId = item.action === "send" && item.status !== "accepted" ? outgoing?.begin(item.text, item.attachmentNames) : undefined;
  };
  useEffect(() => {
    if (!conversationDraftId) return;
    // One attempt on entering this owner surface or regaining connectivity.
    // Do not subscribe to outbox changes: a persistent failure must not loop.
    const recover = () => recoverAcceptedSubmissions(conversationDraftId, draftOwnerId,
      item => executeCaptured(item, onSend, draftWriteChain.current));
    recover();
    window.addEventListener("online", recover);
    return () => window.removeEventListener("online", recover);
  }, [conversationDraftId, draftOwnerId]);
  useEffect(() => {
    const retry = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      const item = readCapturedSubmissions(conversationDraftId, draftOwnerId).find(value => value.pending.idempotencyKey === id);
      if (!item || capturedSubmissionRunning(id)) return;
      const handler = item.action === "queue" ? onQueue : onSend;
      if (!handler) return;
      executeCaptured(item, handler, draftWriteChain.current);
    };
    const discard = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      const item = readCapturedSubmissions(conversationDraftId, draftOwnerId).find(value => value.pending.idempotencyKey === id);
      if (!item || item.status !== "failed" || capturedSubmissionRunning(id) || !navigator.locks) return;
      const writeChain = draftWriteChain.current;
      void withCapturedSubmissionLock(item, async () => {
        const current = readCapturedSubmissions(item.scope, item.ownerId).find(value => value.pending.idempotencyKey === id);
        if (!current || current.status !== "failed") return;
        // Only definite rejection permits disposal. Unknown/committed outcomes
        // must reconcile via Retry before edit/delete/steer becomes meaningful.
        for (const upload of current.pending.uploads ?? []) {
          for (const recipient of upload.recipients) {
            for (const attachmentId of recipient.attachmentIds) {
              if (recipient.agentId === item.scope) await api.deleteConversationAttachment(item.scope, attachmentId);
              else await api.deleteAttachment(recipient.agentId, attachmentId);
            }
          }
        }
        const write = settledDraftWriteContinuation(writeChain.tail, async () => {
          const result = await persistCapturedDraftSubmission(item.scope, item.ownerId, item.clientId, item.pending, true, writeChain.ownedRevision);
          if (result.mayAdvanceDraftRevision) writeChain.ownedRevision = result.draft.revision;
          queryClient.setQueryData(queryKeys.conversationDraft.detail(item.scope, item.ownerId), result.draft);
          removeCapturedSubmission(id);
        });
        writeChain.tail = write;
        await write;
      }).catch(error => saveCapturedSubmission({ ...item, error: error instanceof Error ? error.message : "Rejected input could not be discarded; retry." }));
    };
    window.addEventListener("ponderosa-submission-discard", discard);
    window.addEventListener("ponderosa-submission-retry", retry);
    return () => { window.removeEventListener("ponderosa-submission-retry", retry); window.removeEventListener("ponderosa-submission-discard", discard); };
  });

  const submit = (
    handler: (
      message: string,
      selectedFiles: File[],
      stagedAttachmentIds?: string[],
      stagedDraftOwnerId?: string,
      context?: {
        mentionedAgents?: import("@ponderosa/core").AgentMentionBindingDto[];
        newAgentRequested?: boolean;
        onAgentCreated?(agent: import("@ponderosa/core").AgentDto): void;
        retryPreparedAttempt?: boolean;
        pendingSubmission?: DraftPendingSubmissionDto;
        persistPendingSubmission?(
          value: DraftPendingSubmissionDto,
          retainOnFailure?: boolean,
        ): Promise<void>;
      },
    ) => Promise<unknown> | unknown,
    action: "send" | "queue",
  ) => {
    if (dictationSettlingRef.current) {
      setSendError(
        "Stop voice dictation and wait for final text before sending.",
      );
      return;
    }
    if (sendingRef.current || !canSend) return;
    if (
      durableRetryAction && durableRetryAction !== action
    ) {
      const retryHandler = durableRetryAction === "queue"
        ? onQueue ?? onSend
        : onSend;
      if (retryHandler) submit(retryHandler, durableRetryAction);
      return;
    }
    const retryPreparedAttempt = durableRetryAction === action;
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
    setSendError(undefined);
    const submittedText = normalizedDraft;
    const submittedPastedText = pastedTextRef.current;
    const submittedPastedTextAttachmentId = pastedTextAttachmentId.current;
    const submittedMentionBindings = [...knownMentionBindings];
    const submittedDraftScope = conversationDraftId;
    const submittedOwnedDraftRevision = draftWriteChain.current.ownedRevision;
    let submittedDraftClientId = draftQuery.data?.clientId ??
      draftWriteChain.current.clientId;
    const submittedDraftGeneration = draftGeneration.current;
    const submittedDraftWriteChain = draftWriteChain.current;
    const submittedSupersededPastedTextAttachmentIds = [
      ...submittedDraftWriteChain.pendingDeletionIds,
    ];
    const submittedScopeStillActive = () =>
      draftWriteContinuationStillOwned({
        capturedScope: submittedDraftScope,
        currentScope: activeDraftScopeRef.current,
        capturedGeneration: submittedDraftGeneration,
        currentGeneration: draftGeneration.current,
      });
    const submittedUserMutationGeneration =
      userDraftMutationGeneration.current;
    const submittedContentGeneration = draftContentGeneration.current;
    const submittedDestinationIdentity = safeDefaultDestination?.selectionKey;
    const stagedIds = files
      .map(file => draftAttachmentIds.current.get(file))
      .filter(
        (id): id is string =>
          id !== undefined &&
          !locallyRemovedDraftAttachmentIds.current.has(id),
      );
    const durableRetry = Boolean(pendingSubmissionRef.current?.request);
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
      const binding = submissionMentionBinding(
        handle,
        knownMentionBindings,
        mentionBindings ?? [],
        retryPreparedAttempt || durableRetry,
      );
      if (binding) {
        mentionedAgentsById.set(binding.agentId, binding);
      }
    }
    for (const binding of pendingSubmissionRef.current?.request?.mentionBindings ?? []) {
      mentionedAgentsById.set(binding.agentId, binding);
    }
    const mentionedAgents = [...mentionedAgentsById.values()];
    const retainedAgentDestination =
      destinationMode === "project-chat" &&
      !safeNewAgentSelected &&
      !hasBroadcastMention(safeRoutingText) &&
      !findMentionedHandles(safeRoutingText, ["everyone"]).length &&
      mentionedAgents.length === 1
        ? {
            handle: mentionedAgents[0]!.currentHandle,
            binding: mentionedAgents[0]!,
            selectionKey: `agent:${mentionedAgents[0]!.agentId}:${mentionedAgents[0]!.currentTitle}`,
          }
        : undefined;
    const exactSubmissionText = mentionedAgents.reduce(
      (current, binding) =>
        hasComposerDestination(current, binding.handle) ||
          hasComposerDestination(current, binding.currentHandle)
          ? current
          : prependComposerDestination(current, binding.handle),
      safeSubmissionText,
    );
    const runtimeCommandSubmission =
      slash?.command.invocation === "runtime";
    if (conversationDraftId && draftStorageKey && !runtimeCommandSubmission && !durableRetryAction) {
      const recipientBindings = destinationMode === "fixed" && defaultDestination?.binding
        ? [defaultDestination.binding]
        : findMentionedHandles(safeRoutingText, ["everyone"]).length
          ? [...(mentionBindings ?? [])]
          : mentionedAgents;
      const [capturedEngine, capturedModel, capturedEffort, capturedSpeed] = JSON.parse(submissionRuntimeKey ?? "[]") as string[];
      const createdAt = Math.max(Date.now(), ...readCapturedSubmissions().map(item => item.createdAt + 1));
      const item: CapturedSubmission = {
        version: 1, scope: conversationDraftId, storageKey: draftStorageKey,
        ownerId: draftOwnerId, clientId: submittedDraftWriteChain.clientId,
        ...(projectId ? { projectId } : {}),
        createdAt, action, text: exactSubmissionText, editorText: submittedText,
        ...(submittedPastedText ? { pastedText: submittedPastedText } : {}),
        attachmentNames: files.map(file => file.name),
        mentionedAgents: recipientBindings, newAgentRequested: safeNewAgentSelected,
        status: "pending",
        pending: {
          fingerprint: "0".repeat(64), idempotencyKey: createClientId("send-"),
          captureRevision: submittedDraftWriteChain.ownedRevision,
          text: exactSubmissionText, editorText: submittedText,
          ...(submittedPastedText ? { pastedText: submittedPastedText } : {}),
          draftAttachmentIds: [...stagedIds], editableDraftAttachmentIds: [...stagedIds],
          ...(submittedPastedTextAttachmentId ? { pastedTextAttachmentId: submittedPastedTextAttachmentId } : {}),
          request: {
            ...(!conversationDraftId.startsWith("agent:") ? { conversationId: conversationDraftId } : {}),
            recipientAgentIds: [...new Set(recipientBindings.map(binding => binding.agentId))],
            ...(recipientBindings.length ? { mentionBindings: recipientBindings } : {}),
            ...(hasBroadcastMention(safeRoutingText) && files.length ? { broadcastAttachmentOwnerAgentId: recipientBindings[0]?.agentId ?? conversationDraftId } : {}),
            runtime: { activeRunDelivery: action === "queue" ? "queue" : "steer",
              ...(capturedEngine ? { engine: capturedEngine } : {}),
              ...(capturedModel ? { model: capturedModel } : {}),
              ...(capturedEffort ? { effort: capturedEffort } : {}),
              ...(capturedSpeed ? { speed: capturedSpeed } : {}),
            },
          },
        },
      };
      if (readCapturedSubmissions(conversationDraftId, draftOwnerId).length >= 32) {
        setSendError("Resolve captured messages in the tray before submitting more (32 per Chat).");
        return;
      }
      try { saveCapturedSubmission(item); } catch (error) {
        setSendError(error instanceof Error ? error.message : "Message could not be saved for recovery.");
        return;
      }
      executeCaptured(item, handler, submittedDraftWriteChain, [...files]);
      // Local retirement is synchronous and incarnation-based, not text equality.
      // Identical newly typed text is a distinct draft and cannot be cleared by
      // late acknowledgement. Staged assets remain protected by pendingSubmissions.
      draftGeneration.current++;
      draftEditVersion.current++;
      draftLocallyEdited.current = true;
      draftAttachmentsLocallyEdited.current = true;
      unrestoredDraftAttachmentIds.current = [];
      pendingSelection.current = undefined;
      // Keep the selected Agent as an authored token in the next editable
      // snapshot, so navigation/reload preserves its structural binding too.
      const nextDraftText = retainedAgentDestination
        ? prependComposerDestination("", retainedAgentDestination.handle) : "";
      replaceText(nextDraftText);
      if (draftStorageKey) writeChatState(draftStorageKey, nextDraftText);
      replacePastedText(undefined);
      pastedTextAttachmentId.current = undefined;
      clearDraftAttachments();
      setKnownMentionBindings(retainedAgentDestination ? [retainedAgentDestination.binding] : []);
      setActiveDefaultDestination(retainedAgentDestination ? undefined : safeDefaultDestination);
      inputRef.current?.resetDocument(nextDraftText);
      setCaret(nextDraftText.length);
      setSendError(undefined);
      writeDraftTextRecovery(draftStorageKey, {
        text: nextDraftText, mentionBindings: retainedAgentDestination ? [retainedAgentDestination.binding] : [], attachmentIds: [], attachments: [], expectedRevision: submittedDraftWriteChain.ownedRevision,
        clientId: submittedDraftWriteChain.clientId,
      });
      return;
    }
    sendingRef.current = true;
    setSending(true);
    // Render before fingerprinting, durable draft persistence or upload prep.
    // Runtime commands are not authored messages and must not get an echo.
    const outgoingId = runtimeCommandSubmission ? undefined
      : outgoing?.begin(safeNewAgentSelected && !hasComposerDestination(exactSubmissionText, NEW_AGENT_DESTINATION_HANDLE)
        ? prependComposerDestination(exactSubmissionText, NEW_AGENT_DESTINATION_HANDLE) : exactSubmissionText,
        files.map(file => file.name));
    if (!runtimeCommandSubmission) {
      draftMutationLockedRef.current = true;
      setDraftMutationLocked(true);
      setCapabilityMenuAnchor(null);
      setSuppressMenu(true);
    }
    const persistPendingSubmission = async (
      value: DraftPendingSubmissionDto | undefined,
      retainOnFailure = false,
    ): Promise<void> => {
      if (!submittedDraftScope) return;
      if (!submittedScopeStillActive()) {
        throw new Error("The draft destination changed before it could be sent.");
      }
      if (retainOnFailure) {
        pendingSubmissionRef.current = value;
        if (draftStorageKey && projectId && value?.uploads?.some(upload =>
            upload.recipients.some(recipient => recipient.attachmentIds.length))) {
          const outbox = createRecipientUploadAuthorityOutbox({
              draftId: submittedDraftScope,
              draftStorageKey,
              projectId,
              ownerId: draftOwnerId,
              baseDraftClientId: submittedDraftClientId,
              writeClientId: submittedDraftWriteChain.clientId,
              expectedRevision:
                submittedDraftWriteChain.ownedRevision ||
                submittedOwnedDraftRevision,
              pending: value,
            });
          const serialized = serializeRecipientUploadAuthorityOutbox(outbox);
          const authorityKey = recipientUploadAuthorityStorageKey(
            draftStorageKey,
            outbox.writeClientId,
            value.idempotencyKey,
          );
          const existingAuthorityKeys = uploadAuthorityStoragePrefix
            ? readChatStateEntries(uploadAuthorityStoragePrefix).flatMap(([key, raw]) => {
                const valid = parseRecipientUploadAuthorityOutbox(raw, {
                  draftId: submittedDraftScope,
                  draftStorageKey,
                  projectId,
                  ownerId: draftOwnerId,
                });
                if (!valid) writeChatState(key, "");
                return valid ? [key] : [];
              })
            : [];
          if (!recipientUploadAuthorityHasCapacity(
                existingAuthorityKeys,
                authorityKey,
              ) ||
              !serialized || !writeChatState(authorityKey, serialized)) {
            throw new ApiRequestError(
              400,
              "Upload cleanup authority could not be saved in this browser.",
            );
          }
          pendingUploadAuthorityStorageKeys.current.add(authorityKey);
        }
      } else if (!value) {
        for (const key of pendingUploadAuthorityStorageKeys.current) {
          writeChatState(key, "");
        }
        pendingUploadAuthorityStorageKeys.current.clear();
      }
      let saved: ConversationDraftDto | undefined;
      const write = settledDraftWriteContinuation(
        submittedDraftWriteChain.tail,
        async () => {
          if (!submittedScopeStillActive()) {
            throw new Error("The draft destination changed before it could be sent.");
          }
          saved = await api.putConversationDraft(submittedDraftScope, withCapturedDraftSubmissions(submittedDraftScope, {
            text: submittedText,
            attachmentIds: stagedIds,
            ...(submittedPastedTextAttachmentId
              ? { pastedTextAttachmentId: submittedPastedTextAttachmentId }
              : {}),
            mentionBindings: submittedMentionBindings,
            ...(value ? { pendingSubmission: value } : {}),
            expectedRevision:
              submittedDraftWriteChain.ownedRevision ||
              submittedOwnedDraftRevision,
            clientId: submittedDraftWriteChain.clientId,
            ownerId: draftOwnerId,
          }, queryClient.getQueryData<ConversationDraftDto>(queryKeys.conversationDraft.detail(submittedDraftScope, draftOwnerId))));
          submittedDraftWriteChain.ownedRevision = saved.revision;
          acknowledgeDraftTextRecovery(draftStorageKey, submittedDraftWriteChain.clientId, { text: submittedText, mentionBindings: submittedMentionBindings }, saved.revision);
          acknowledgeRecoveredText(submittedDraftWriteChain, { text: submittedText, mentionBindings: submittedMentionBindings }, saved.revision);
          submittedDraftClientId = saved.clientId;
        },
      );
      submittedDraftWriteChain.tail = write;
      await write;
      if (!saved || !submittedScopeStillActive()) {
        throw new Error("The draft destination changed before it could be sent.");
      }
      draftRevision.current = saved.revision;
      pendingSubmissionRef.current = value;
      for (const key of pendingUploadAuthorityStorageKeys.current) {
        writeChatState(key, "");
      }
      pendingUploadAuthorityStorageKeys.current.clear();
      queryClient.setQueryData(
        queryKeys.conversationDraft.detail(submittedDraftScope, draftOwnerId),
        saved,
      );
    };
    const operation = Promise.resolve().then(async () => {
      if (runtimeCommandSubmission) {
        return onCommand!(slash.command, slash.argumentsText);
      }
      let pendingSubmission: DraftPendingSubmissionDto | undefined;
      if (submittedDraftScope) {
        const exactDraftAttachmentIds = pendingDraftAttachmentIds(
          pendingSubmissionRef.current,
          stagedIds,
        );
        const exactPastedTextAttachmentId = pendingPastedTextAttachmentId(
          pendingSubmissionRef.current,
          submittedPastedTextAttachmentId,
        );
        const fingerprint = pendingSubmissionRef.current?.request
          ? pendingSubmissionRef.current.intentFingerprint ??
            pendingSubmissionRef.current.fingerprint
          : await durableSubmissionFingerprint({
              version: 1,
              action,
              surface: submittedDraftScope,
              text: stableMessageActionText(exactSubmissionText, mentionedAgents),
              attachmentIds: exactDraftAttachmentIds,
              pastedTextAttachmentId: exactPastedTextAttachmentId ?? null,
              recipientAgentIds: mentionedAgents.map(item => item.agentId).sort(),
              newAgentRequested: safeNewAgentSelected,
              runtime: submissionRuntimeKey ?? null,
            });
        pendingSubmission = selectDurableSubmission(
          pendingSubmissionRef.current,
          fingerprint,
          () => createClientId("send-"),
        );
        if (!pendingSubmission.draftAttachmentIds) {
          pendingSubmission = {
            ...pendingSubmission,
            draftAttachmentIds: [...stagedIds],
            editableDraftAttachmentIds: [...stagedIds],
            ...(submittedPastedTextAttachmentId ? {
              pastedTextAttachmentId: submittedPastedTextAttachmentId,
              editablePastedTextAttachmentId: submittedPastedTextAttachmentId,
            } : {}),
          };
        }
        await persistPendingSubmission(pendingSubmission);
        if (!submittedScopeStillActive()) {
          throw new Error("The draft destination changed before it could be sent.");
        }
      }
      const submissionContext =
        mentionedAgents.length > 0 || safeNewAgentSelected ||
          retryPreparedAttempt || pendingSubmission
          ? {
              mentionedAgents,
              newAgentRequested: safeNewAgentSelected,
              onAgentCreated: (agent: import("@ponderosa/core").AgentDto) => {
                if (outgoingId) outgoing?.agentCreated(outgoingId, agent);
              },
              retryPreparedAttempt: retryPreparedAttempt || durableRetry,
              ...(pendingSubmission ? {
                pendingSubmission,
                persistPendingSubmission,
              } : {}),
            }
          : undefined;
      return handler(
        exactSubmissionText,
        files,
        stagedIds,
        conversationDraftId ? draftOwnerId : undefined,
        submissionContext,
      );
    });
    void operation
      .then(() => {
        if (submittedScopeStillActive()) setPreparedRetry(undefined);
        const scopeStillActive = submittedScopeStillActive();
        const submissionMayClearDraft = composerSubmissionMayClearDraft({
          submittedMutationGeneration: submittedContentGeneration,
          currentMutationGeneration: draftContentGeneration.current,
          stillOwnsDraft:
            scopeStillActive &&
            draftWriteChain.current === submittedDraftWriteChain &&
            (!runtimeCommandSubmission || (
              activeSubmissionIntentKeyRef.current === submissionIntentKey &&
              renderedDestinationIdentityRef.current === submittedDestinationIdentity
            )),
        });
        // Message edits are locked while sending. Navigation releases this
        // editor, not the captured submission's CAS authority to retire itself.
        // Runtime commands remain governed by the editable-content guard.
        const submissionMayRetireSavedDraft = submissionMayClearDraft ||
          (!runtimeCommandSubmission && Boolean(submittedDraftScope) && !scopeStillActive);
        if (submissionMayRetireSavedDraft) {
          retireSubmittedDraftText(
            draftStorageKey,
            submittedDraftWriteChain.clientId,
            { text: submittedText, mentionBindings: submittedMentionBindings },
            submittedDraftWriteChain.ownedRevision,
          );
        }
        // Clear only the exact draft incarnation that produced this submission.
        // This also preserves edits made while a runtime command is pending.
        if (submissionMayClearDraft && scopeStillActive) {
          draftGeneration.current += 1;
          draftEditVersion.current += 1;
          draftLocallyEdited.current = false;
          draftAttachmentsLocallyEdited.current = false;
          unrestoredDraftAttachmentIds.current = [];
          replaceText("");
          setKnownMentionBindings(retainedAgentDestination
            ? [retainedAgentDestination.binding]
            : []);
          setActiveDefaultDestination(retainedAgentDestination);
          if (draftStorageKey) writeChatState(draftStorageKey, "");
          replacePastedText(undefined);
          clearDraftAttachments();
        }
        if (
          submissionMayRetireSavedDraft &&
          submittedDraftScope
        ) {
          const clientId = submittedDraftWriteChain.clientId;
          const clearGeneration = draftGeneration.current;
          const clearOwnsActiveScope = () =>
            scopeStillActive &&
            draftWriteChain.current === submittedDraftWriteChain &&
            draftWriteContinuationStillOwned({
              capturedScope: submittedDraftScope,
              currentScope: activeDraftScopeRef.current,
              capturedGeneration: clearGeneration,
              currentGeneration: draftGeneration.current,
            });
          const clearChain = submittedDraftWriteChain.tail
            .catch(() => undefined)
            .then(async () => {
              const clearSavedDraft = (expectedRevision: number) =>
                api.putConversationDraft(submittedDraftScope, withCapturedDraftSubmissions(submittedDraftScope, {
                  text: "",
                  attachmentIds: [],
                  mentionBindings: [],
                  expectedRevision,
                  clientId,
                  ownerId: draftOwnerId,
                }, queryClient.getQueryData<ConversationDraftDto>(queryKeys.conversationDraft.detail(submittedDraftScope, draftOwnerId))));
              try {
                // Sequence behind every save captured by this surface
                // incarnation. The server may fast-forward only this exact
                // incarnation; a 409 from a later incarnation is terminal.
                const clearedDraft = await clearSavedDraft(
                  submittedDraftWriteChain.ownedRevision ||
                    submittedOwnedDraftRevision,
                );
                submittedDraftWriteChain.ownedRevision = clearedDraft.revision;
                if (clearOwnsActiveScope()) {
                  pendingSubmissionRef.current = clearedDraft.pendingSubmission;
                  draftRevision.current = clearedDraft.revision;
                }
                queryClient.setQueryData<ConversationDraftDto>(
                  queryKeys.conversationDraft.detail(
                    submittedDraftScope,
                    draftOwnerId,
                  ),
                  current => current && current.revision > clearedDraft.revision
                    ? current : clearedDraft,
                );
                const cleanupIds = new Set([
                  ...stagedIds,
                  ...submittedSupersededPastedTextAttachmentIds,
                  ...(submittedPastedTextAttachmentId
                    ? [submittedPastedTextAttachmentId]
                    : []),
                ]);
                for (const id of cleanupIds) {
                  submittedDraftWriteChain.pendingDeletionIds.delete(id);
                  void api.deleteDraftAttachment(
                    submittedDraftScope,
                    draftOwnerId,
                    id,
                  ).catch(() => undefined);
                }
              } catch {
                if (clearOwnsActiveScope()) {
                  setSendError(
                    "Message sent, but its saved draft could not be cleared.",
                  );
                }
              }
            });
          submittedDraftWriteChain.tail = clearChain;
        }
        if (
          submissionMayClearDraft &&
          submittedPastedTextAttachmentId &&
          scopeStillActive &&
          pastedTextAttachmentId.current === submittedPastedTextAttachmentId
        ) {
          pastedTextAttachmentId.current = undefined;
        }
        if (submissionMayClearDraft && scopeStillActive) setCaret(0);
      })
      .catch(async (error: unknown) => {
        if (!submittedScopeStillActive()) return;
        if (error instanceof ApiRequestError && pendingSubmissionRef.current &&
            durableSubmissionMayBeReleased(
              pendingSubmissionRef.current,
              error.status,
              error.message,
            )) {
          await persistPendingSubmission(undefined).catch(() => undefined);
        }
        const intentUnchanged =
          userDraftMutationGeneration.current ===
            submittedUserMutationGeneration &&
          activeSubmissionIntentKeyRef.current === submissionIntentKey;
        setPreparedRetry(
          !(error instanceof ApiRequestError) && intentUnchanged
            ? { action, submissionIntentKey }
            : undefined,
        );
        if (draftContentGeneration.current === submittedContentGeneration) {
          replaceText(submittedText);
          replacePastedText(submittedPastedText);
          if (draftStorageKey) writeChatState(draftStorageKey, submittedText);
        }
        setSendError(
          error instanceof ApiRequestError && error.status === 429
            ? `Message not sent. Your draft and attachments remain here; retry in about ${Math.ceil((error.retryAfterMs ?? 1_000) / 1_000)} seconds.`
            : error instanceof Error ? error.message : "Upload failed; try again.",
        );
      })
      .finally(() => {
        if (outgoingId) outgoing?.finish(outgoingId);
        draftMutationLockedRef.current = false;
        setDraftMutationLocked(false);
        sendingRef.current = false;
        setSending(false);
      });
  };
  const steer = () => submit(onSend, "send");
  const queue = () => {
    if (!onQueue) return;
    submit(onQueue, "queue");
  };
  const send = steer;
  const queueTargetIds = [...new Set([
    ...(defaultDestination?.binding ? [defaultDestination.binding.agentId] : []),
    ...mentionedHandles.flatMap(handle => {
      const binding = resolvedMentionBinding(handle, knownMentionBindings, mentionBindings ?? []);
      return binding ? [binding.agentId] : [];
    }),
  ])].sort();
  const queueTargetKey = JSON.stringify([conversationDraftId, queueTargetIds]);
  const queueActivity = useRef({ key: queueTargetKey, active: false });
  const liveQueueActivity = agentResponding || mentionedBusyHandles.length > 0;
  const acceptancePendingForTarget = readCapturedSubmissions(conversationDraftId, draftOwnerId).some(item =>
    capturedSubmissionRunning(item.pending.idempotencyKey) &&
    item.pending.request?.recipientAgentIds.some(id => queueTargetIds.includes(id)));
  if (queueActivity.current.key !== queueTargetKey) queueActivity.current = { key: queueTargetKey, active: liveQueueActivity };
  else if (liveQueueActivity) queueActivity.current.active = true;
  else if (!acceptancePendingForTarget) queueActivity.current.active = false;
  const showQueue = Boolean(onQueue) && !destinationError &&
    targetRequiredRecipientTagged &&
    shouldShowQueueControl({
      text: submissionText, hasAttachments: files.length > 0,
      agentResponding: liveQueueActivity || (queueActivity.current.active && acceptancePendingForTarget),
      disabled,
    });
  const localRecoverySnapshots = readDraftTextRecoveries(draftStorageKey).filter(snapshot =>
    snapshot.clientId !== draftWriteChain.current.clientId && (snapshot.text !== text ||
      JSON.stringify(snapshot.mentionBindings) !== JSON.stringify(knownMentionBindings)));
  return (
    <Paper
      ref={composerRoot}
      className="ponderosa-composer"
      data-compact="false"
      data-file-drag-active={fileDragActive && fileDropEnabled}
      elevation={0}
      sx={composerSurfaceSx}
      onDragEnterCapture={event => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        fileDragDepth.current += 1;
        if (fileDropEnabled) setFileDragActive(true);
      }}
      onDragOverCapture={event => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = fileDropEnabled ? "copy" : "none";
      }}
      onDragLeaveCapture={() => {
        fileDragDepth.current = Math.max(0, fileDragDepth.current - 1);
        if (fileDragDepth.current === 0) setFileDragActive(false);
      }}
      onDropCapture={event => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        fileDragDepth.current = 0;
        setFileDragActive(false);
        if (!fileDropEnabled || draftMutationLockedRef.current) return;
        const entries = droppedAttachmentEntries(event.dataTransfer);
        if (entries.some(entry => !(entry instanceof File) && entry.isDirectory)) void importAttachments(entries);
        else addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <Box sx={{ display: "contents" }}>
      {preparingFolder ? <Typography role="status" variant="caption" sx={{ px: 1.5, pt: 0.5 }}>Preparing folder ZIP…</Typography> : null}
      <ComposerDestinationBar
        destinationError={destinationError}
        destinationMode={destinationMode}
      />
      {!draftMutationLocked && <ComposerAttachmentList
        disabled={draftMutationLocked}
        draftUploadStates={draftUploadStates}
        files={files}
        removeFile={removeFile}
        retryDraftUpload={retryDraftUpload}
      />}
      {localRecoverySnapshots.length ? <Button
        onClick={() => setLocalRecoveryOpen(true)} disabled={draftMutationLocked || sending}>
        Review other recoverable drafts
      </Button> : null}
      <Dialog open={localRecoveryOpen} onClose={() => setLocalRecoveryOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Recoverable drafts from this browser</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>Unsaved text from another tab or visit is still available. Choose text to restore; your current text will also stay recoverable.</Typography>
          {localRecoverySnapshots.map(snapshot => <Box key={snapshot.clientId} sx={{ mb: 2 }}>
            <TextField fullWidth multiline value={snapshot.text} label="Recovered text" InputProps={{ readOnly: true }} />
            <Button disabled={draftMutationLocked || sending || !draftReady.current || Boolean(pendingSubmissionRef.current) || Boolean(draftConflict)} onClick={() => {
              if (draftMutationLockedRef.current || sendingRef.current || pendingSubmissionRef.current || draftConflict) return;
              // Preserve the current visit before explicitly choosing another.
              writeDraftTextRecovery(draftStorageKey, {
                text: textRef.current, mentionBindings: knownMentionBindings,
                expectedRevision: draftWriteChain.current.ownedRevision,
                clientId: draftWriteChain.current.clientId,
              });
              draftGeneration.current += 1;
              draftWriteChain.current = createDraftWriteChain();
              draftWriteChain.current.ownedRevision = snapshot.expectedRevision;
              draftWriteChain.current.recoveredText = snapshot;
              draftWriteChain.current.recoveryStorageKey = draftStorageKey;
              const editor = inputRef.current;
              editor?.replaceCanonicalRange(0, editor.getCanonicalText().length, snapshot.text, { focus: false });
              update(snapshot.text);
              setKnownMentionBindings(snapshot.mentionBindings);
              setLocalRecoveryOpen(false);
            }}>Restore this text</Button>
          </Box>)}
        </DialogContent>
        <DialogActions><Button onClick={() => setLocalRecoveryOpen(false)}>Close</Button></DialogActions>
      </Dialog>
      <ComposerNotices
        pastedText={draftMutationLocked ? undefined : pastedText}
        pastedTextBytes={pastedText ? utf8ByteLength(pastedText) : 0}
        error={attachments.error ?? sendError}
        attachmentError={Boolean(attachments.error)}
        draftConflict={draftConflict?.conflict}
        failedDraftContents={failedDraftContents}
        restoringDraft={restoringDraftConflict}
        mutationLocked={draftMutationLocked}
        onShowPastedText={() => {
          setPastedTextEditorValue(pastedText ?? "");
          setPastedTextEditorOpen(true);
        }}
        onRemovePastedText={() => {
          updatePastedText(undefined);
        }}
        onRestoreDraft={() => {
          if (draftMutationLockedRef.current || !draftConflict || restoringDraftConflict || !conversationDraftId) return;
          const recovery = draftConflict;
          const scope = conversationDraftId;
          const recoveryWriteChain = draftWriteChain.current;
          const scopeGeneration = draftGeneration.current;
          const recoveryGeneration = ++draftConflictGeneration.current;
          draftMutationLockedRef.current = true;
          setDraftMutationLocked(true);
          setRestoringDraftConflict(true);
          setSendError(undefined);
          void (async () => {
            const uploadedIds: string[] = [];
            let attemptedSnapshot = recovery.snapshot;
            const discardUploads = () => Promise.all(uploadedIds.map(id =>
              api.deleteDraftAttachment(scope, draftOwnerId, id).catch(() => undefined)));
            try {
              const restoredFiles: Array<{
                file: File;
                attachmentId: string;
                fromId: string;
              }> = [];
              const unavailableAttachmentIds = new Set<string>();
              let restoredPasteId: string | undefined;
              const replacements = () => [
                ...restoredFiles.map(({ fromId, attachmentId }) => ({
                  fromId,
                  toId: attachmentId,
                })),
                ...(recovery.snapshot.pastedTextAttachmentId && restoredPasteId
                  ? [{
                      fromId: recovery.snapshot.pastedTextAttachmentId,
                      toId: restoredPasteId,
                    }]
                  : []),
              ];
              const putSnapshot = async (
                snapshot: typeof recovery.snapshot,
              ): Promise<ResolveConversationDraftConflictResponse> => {
                const draft = await api.putConversationDraft(scope, withCapturedDraftSubmissions(scope, {
                  text: snapshot.text,
                  attachmentIds: snapshot.attachmentIds,
                  ...(snapshot.pastedTextAttachmentId
                    ? { pastedTextAttachmentId: snapshot.pastedTextAttachmentId }
                    : {}),
                  mentionBindings: snapshot.mentionBindings,
                  ...(snapshot.pendingSubmission
                    ? { pendingSubmission: snapshot.pendingSubmission }
                    : {}),
                  expectedRevision: recovery.conflict.current.revision,
                  clientId: recoveryWriteChain.clientId,
                  ownerId: draftOwnerId,
                }, recovery.conflict.current));
                return {
                  conflictId: recovery.conflict.id,
                  action: "restored",
                  replayed: false,
                  draft,
                  attachmentReplacements: replacements(),
                  unavailableAttachmentIds: [...unavailableAttachmentIds],
                };
              };
              const resolution = await retryDraftRestoreForMissingAssets(
                () => recovery.resolutionUnavailable
                  ? putSnapshot(recovery.snapshot)
                  : api.restoreConversationDraftConflict(
                    scope,
                    recovery.conflict.id,
                    {
                      ownerId: draftOwnerId,
                      expectedRevision: recovery.conflict.current.revision,
                      clientId: recoveryWriteChain.clientId,
                    },
                  ),
                unavailableDraftConflictAttachmentIds,
                async missingIds => {
                  for (const fromId of missingIds) {
                    const retained = recovery.snapshot.files.find(
                      item => item.attachmentId === fromId,
                    );
                    if (retained) {
                      const uploaded = await api.uploadDraftAttachment(
                        scope,
                        draftOwnerId,
                        retained.file,
                      );
                      uploadedIds.push(uploaded.id);
                      restoredFiles.push({
                        file: retained.file,
                        attachmentId: uploaded.id,
                        fromId,
                      });
                    } else if (
                      recovery.snapshot.pastedTextAttachmentId === fromId &&
                      recovery.snapshot.pastedText !== undefined
                    ) {
                      const uploaded = await api.uploadDraftAttachment(
                        scope,
                        draftOwnerId,
                        new File(
                          [recovery.snapshot.pastedText],
                          PASTED_TEXT_DRAFT_NAME,
                          { type: "text/plain" },
                        ),
                      );
                      uploadedIds.push(uploaded.id);
                      restoredPasteId = uploaded.id;
                    } else {
                      unavailableAttachmentIds.add(fromId);
                    }
                  }
                  attemptedSnapshot = restagedDraftConflictSnapshot(
                    recovery.snapshot,
                    restoredFiles,
                    restoredPasteId,
                    unavailableAttachmentIds,
                  );
                  return recovery.resolutionUnavailable
                    ? putSnapshot(attemptedSnapshot)
                    : api.restoreConversationDraftConflict(
                        scope,
                        recovery.conflict.id,
                        {
                          ownerId: draftOwnerId,
                          expectedRevision: recovery.conflict.current.revision,
                          clientId: recoveryWriteChain.clientId,
                          attachmentReplacements: replacements(),
                          unavailableAttachmentIds: [...unavailableAttachmentIds],
                        },
                      );
                },
              );
              const draftQueryKey = queryKeys.conversationDraft.detail(scope, draftOwnerId);
              const observed = queryClient.getQueryData<ConversationDraftDto>(draftQueryKey);
              const canonical = resolvedDraftConflictDraft(resolution, observed);
              if (!canonical) throw new Error("Restored draft state is unavailable.");
              const applyingNewerCurrent = canonical !== resolution.draft;
              const canonicalIds = new Set([
                ...canonical.attachmentIds,
                ...(canonical.pastedTextAttachmentId
                  ? [canonical.pastedTextAttachmentId]
                  : []),
              ]);
              await Promise.all(redundantDraftConflictUploadIds(uploadedIds, canonicalIds)
                .map(id => api.deleteDraftAttachment(scope, draftOwnerId, id)
                  .catch(() => undefined)));
              const historicalByCanonicalId = new Map(
                (resolution.attachmentReplacements ?? []).map(item => [
                  item.toId,
                  item.fromId,
                ]),
              );
              const attachmentById = new Map(
                (canonical.attachments ?? []).map(attachment => [
                  attachment.id,
                  attachment,
                ]),
              );
              const locallyRestored = canonicalDraftConflictFiles(
                recovery.snapshot.files,
                canonical.attachmentIds,
                resolution.attachmentReplacements,
              );
              const locallyRestoredById = new Map(
                locallyRestored.files.map(item => [item.attachmentId, item.file]),
              );
              const restoredResults = await Promise.allSettled(
                canonical.attachmentIds.map(async attachmentId => {
                  const historicalId = historicalByCanonicalId.get(attachmentId) ??
                    attachmentId;
                  const retained = locallyRestoredById.get(attachmentId);
                  if (retained) {
                    return { file: retained, attachmentId, historicalId };
                  }
                  const attachment = attachmentById.get(attachmentId);
                  if (!attachment) {
                    throw Object.assign(
                      new Error("Draft attachment metadata is unavailable."),
                      { attachmentId, historicalId },
                    );
                  }
                  return {
                    file: await api.downloadDraftAttachment(attachment),
                    attachmentId,
                    historicalId,
                  };
                }),
              );
              const hydratedFiles = restoredResults.flatMap(result =>
                result.status === "fulfilled" ? [result.value] : []);
              const failedHydrations = restoredResults.flatMap((result, index) => {
                if (result.status === "fulfilled") return [];
                const id = canonical.attachmentIds[index]!;
                const attachment = attachmentById.get(id);
                return [{
                  id,
                  name: attachment?.name ?? "Staged attachment",
                  kind: "attachment" as const,
                  ...(attachment ? { attachment } : {}),
                }];
              });
              let restoredPastedText: string | undefined;
              let failedPaste: FailedDraftContent | undefined;
              if (canonical.pastedTextAttachmentId) {
                const historicalId = historicalByCanonicalId.get(
                  canonical.pastedTextAttachmentId,
                ) ?? canonical.pastedTextAttachmentId;
                if (
                  recovery.snapshot.pastedTextAttachmentId === historicalId &&
                  recovery.snapshot.pastedText !== undefined
                ) {
                  restoredPastedText = recovery.snapshot.pastedText;
                } else {
                  try {
                    if (!canonical.pastedTextAttachment) {
                      throw new Error("Pasted-text metadata is unavailable.");
                    }
                    restoredPastedText = await (
                      await api.downloadDraftAttachment(canonical.pastedTextAttachment)
                    ).text();
                  } catch {
                    failedPaste = {
                      id: canonical.pastedTextAttachmentId,
                      name: "Pasted text",
                      kind: "pasted-text",
                      ...(canonical.pastedTextAttachment
                        ? { attachment: canonical.pastedTextAttachment }
                        : {}),
                    };
                  }
                }
              }
              if (
                recoveryGeneration !== draftConflictGeneration.current ||
                scope !== activeDraftScopeRef.current ||
                scopeGeneration !== draftGeneration.current ||
                recoveryWriteChain !== draftWriteChain.current
              ) {
                return;
              }
              const explicitUnavailableFailures = (
                resolution.unavailableAttachmentIds ?? []
              ).flatMap(id => attemptedSnapshot.failedContents.some(item => item.id === id)
                ? []
                : [{
                    id,
                    name: recovery.snapshot.pastedTextAttachmentId === id
                      ? "Pasted text"
                      : "Staged attachment",
                    kind: recovery.snapshot.pastedTextAttachmentId === id
                      ? "pasted-text" as const
                      : "attachment" as const,
                  }]);
              const restored = restoreDraftConflictSnapshot(
                {
                  ...attemptedSnapshot,
                  text: canonical.text,
                  attachmentIds: [...canonical.attachmentIds],
                  files: hydratedFiles.map(({ file, attachmentId }) => ({
                    file,
                    attachmentId,
                  })),
                  ...(restoredPastedText !== undefined
                    ? { pastedText: restoredPastedText }
                    : { pastedText: undefined }),
                  ...(canonical.pastedTextAttachmentId
                    ? { pastedTextAttachmentId: canonical.pastedTextAttachmentId }
                    : { pastedTextAttachmentId: undefined }),
                  mentionBindings: [...(canonical.mentionBindings ?? [])],
                  ...(canonical.pendingSubmission
                    ? { pendingSubmission: canonical.pendingSubmission }
                    : { pendingSubmission: undefined }),
                  failedContents: [
                    ...(applyingNewerCurrent
                      ? []
                      : attemptedSnapshot.failedContents.filter(item => {
                          const canonicalId = (resolution.attachmentReplacements ?? [])
                            .find(replacement => replacement.fromId === item.id)?.toId ?? item.id;
                          return !canonicalIds.has(canonicalId);
                        })),
                    ...(applyingNewerCurrent ? [] : explicitUnavailableFailures),
                    ...failedHydrations,
                    ...(failedPaste ? [failedPaste] : []),
                  ],
                },
                draftEditVersion.current,
              );
              recoveryWriteChain.ownedRevision = canonical.revision;
              acknowledgeDraftTextRecovery(draftStorageKey, recoveryWriteChain.clientId, attemptedSnapshot, canonical.revision);
              acknowledgeRecoveredText(recoveryWriteChain, attemptedSnapshot, canonical.revision);
              draftRevision.current = canonical.revision;
              markUserDraftMutation();
              pendingSubmissionRef.current = restored.pendingSubmission;
              draftEditVersion.current = restored.editVersion;
              draftLocallyEdited.current = false;
              draftAttachmentsLocallyEdited.current = false;
              replaceText(restored.text);
              setKnownMentionBindings(restored.mentionBindings);
              replaceSnapshotDraftAttachments(restored.files);
              const restoredFileIds = new Set(
                restored.files.map(item => item.attachmentId),
              );
              unrestoredDraftAttachmentIds.current = restored.attachmentIds.filter(
                id => !restoredFileIds.has(id),
              );
              for (const id of restored.attachmentIds) {
                locallyRemovedDraftAttachmentIds.current.delete(id);
              }
              pastedTextMutationGeneration.current += 1;
              pastedTextUploadGeneration.current += 1;
              pastedTextAttachmentId.current = restored.pastedTextAttachmentId;
              pastedTextUploadFailedFor.current = undefined;
              setPastedTextUploading(false);
              replacePastedText(restored.pastedText);
              if (restored.pastedTextAttachmentId) {
                locallyRemovedDraftAttachmentIds.current.delete(
                  restored.pastedTextAttachmentId,
                );
              }
              updateFailedDraftContents(restored.failedContents);
              queryClient.setQueryData(draftQueryKey, canonical);
              setDraftConflict(undefined);
              setRestoringDraftConflict(false);
              setDraftReadyVersion(value => value + 1);
              // Focus can publish Lexical's previous document before React's
              // canonical-text layout effect. Install the restored bytes first.
              inputRef.current?.resetDocument(restored.text);
              inputRef.current?.focus();
            } catch (error) {
              const stillOwnsRecovery = () =>
                recoveryGeneration === draftConflictGeneration.current &&
                scope === activeDraftScopeRef.current &&
                scopeGeneration === draftGeneration.current &&
                recoveryWriteChain === draftWriteChain.current;
              if (!stillOwnsRecovery()) {
                await discardUploads();
                return;
              }
              if (error instanceof ApiRequestError &&
                  (error.status === 409 || error.status === 404)) {
                try {
                  const [current, conflicts] = await Promise.all([
                    api.getConversationDraft(scope, draftOwnerId),
                    api.getConversationDraftConflicts(scope, draftOwnerId),
                  ]);
                  if (!stillOwnsRecovery()) return;
                  const refreshed = refreshRecoverableDraftConflict(
                    recovery,
                    current,
                    conflicts.conflicts,
                  );
                  const retryConflict = recovery.resolutionUnavailable
                    ? conflicts.conflicts.findLast(candidate =>
                        candidate.displaced.clientId === recoveryWriteChain.clientId)
                    : undefined;
                  queryClient.setQueryData(
                    queryKeys.conversationDraft.detail(scope, draftOwnerId),
                    current,
                  );
                  if (refreshed) {
                    await discardUploads();
                    setRestoringDraftConflict(false);
                    setDraftConflict(refreshed);
                    setSendError(
                      "The saved draft changed again. Review your preserved version, then choose Restore again.",
                    );
                    return;
                  }
                  if (retryConflict) {
                    recoveryWriteChain.ownedRevision = current.revision;
                    draftRevision.current = current.revision;
                    setDraftConflict(recoverableDraftConflict(
                      { ...retryConflict, current },
                      attemptedSnapshot,
                    ));
                    setRestoringDraftConflict(false);
                    setSendError(
                      "The saved draft changed again. Your preserved version is ready for an explicit Restore retry.",
                    );
                    return;
                  }
                  await discardUploads();
                  recoveryWriteChain.ownedRevision = current.revision;
                  draftRevision.current = current.revision;
                  draftLocallyEdited.current = true;
                  draftAttachmentsLocallyEdited.current = true;
                  setDraftConflict(unresolvedRecoverableDraftConflict(recovery, current));
                  setRestoringDraftConflict(false);
                  setSendError(
                    "This conflict was resolved elsewhere. Your preserved draft is unchanged; choose Restore again to save it against the latest revision.",
                  );
                  return;
                } catch (refreshError) {
                  if (!stillOwnsRecovery()) {
                    await discardUploads();
                    return;
                  }
                  await discardUploads();
                  setRestoringDraftConflict(false);
                  setSendError(
                    refreshError instanceof Error
                      ? `The draft changed again, but its current version could not be loaded: ${refreshError.message}`
                      : "The draft changed again, but its current version could not be loaded.",
                  );
                  return;
                }
              }
              await discardUploads();
              setRestoringDraftConflict(false);
              setSendError(
                error instanceof Error
                  ? `Your preserved draft could not be restored: ${error.message}`
                  : "Your preserved draft could not be restored.",
              );
            } finally {
              draftMutationLockedRef.current = false;
              setDraftMutationLocked(false);
              setRestoringDraftConflict(false);
            }
          })();
        }}
        onDiscardDraft={() => {
          if (draftMutationLockedRef.current || !draftConflict || restoringDraftConflict || !conversationDraftId) return;
          const conflictId = draftConflict.conflict.id;
          const scope = conversationDraftId;
          const recoveryWriteChain = draftWriteChain.current;
          const generation = ++draftConflictGeneration.current;
          const scopeGeneration = draftGeneration.current;
          draftMutationLockedRef.current = true;
          setDraftMutationLocked(true);
          setRestoringDraftConflict(true);
          setSendError(undefined);
          void api.discardConversationDraftConflict(scope, draftOwnerId, conflictId)
            .then(async resolution => {
              if (generation !== draftConflictGeneration.current ||
                  scope !== activeDraftScopeRef.current ||
                  scopeGeneration !== draftGeneration.current ||
                  recoveryWriteChain !== draftWriteChain.current) return;
              const current = resolution.currentDraft ??
                await api.getConversationDraft(scope, draftOwnerId);
              if (generation !== draftConflictGeneration.current ||
                  scope !== activeDraftScopeRef.current ||
                  scopeGeneration !== draftGeneration.current ||
                  recoveryWriteChain !== draftWriteChain.current) return;
              recoveryWriteChain.ownedRevision = current.revision;
              draftRevision.current = current.revision;
              draftLocallyEdited.current = true;
              draftAttachmentsLocallyEdited.current = true;
              writeDraftTextRecovery(draftStorageKey, {
                text: textRef.current,
                mentionBindings: knownMentionBindings,
                expectedRevision: current.revision,
                clientId: recoveryWriteChain.clientId,
              });
              queryClient.setQueryData(
                queryKeys.conversationDraft.detail(scope, draftOwnerId),
                current,
              );
              setDraftConflict(undefined);
              setRestoringDraftConflict(false);
            })
            .catch(error => {
              if (generation !== draftConflictGeneration.current ||
                  scope !== activeDraftScopeRef.current ||
                  scopeGeneration !== draftGeneration.current) return;
              setRestoringDraftConflict(false);
              setSendError(
                error instanceof Error
                  ? `Your preserved draft could not be discarded: ${error.message}`
                  : "Your preserved draft could not be discarded.",
              );
            })
            .finally(() => {
              draftMutationLockedRef.current = false;
              setDraftMutationLocked(false);
              setRestoringDraftConflict(false);
            });
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
      </Box>
      <Dialog
        open={pastedTextEditorOpen}
        onClose={() => setPastedTextEditorOpen(false)}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>View or edit pasted text</DialogTitle>
        <DialogContent>
          <TextField
            disabled={draftMutationLocked}
            autoFocus
            fullWidth
            multiline
            minRows={12}
            maxRows={24}
            value={pastedTextEditorValue}
            onChange={event => setPastedTextEditorValue(event.target.value)}
            error={utf8ByteLength(pastedTextEditorValue) > LONG_TEXT_MAX_UTF8_BYTES}
            helperText={`${utf8ByteLength(pastedTextEditorValue).toLocaleString()} of ${LONG_TEXT_MAX_UTF8_BYTES.toLocaleString()} bytes`}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPastedTextEditorOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={draftMutationLocked || utf8ByteLength(pastedTextEditorValue) > LONG_TEXT_MAX_UTF8_BYTES}
            onClick={() => {
              updatePastedText(pastedTextEditorValue || undefined);
              setPastedTextEditorOpen(false);
            }}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
      <Stack
        direction="row"
        spacing={{ xs: 0.25, sm: 0.5 }}
        useFlexGap
        sx={{ alignItems: "center", flexWrap: "wrap" }}
      >
        <Box data-composer-toolbar sx={{
          display: { xs: "flex", md: "contents" },
          alignItems: "center", gap: 0.25, flex: "1 1 0", minWidth: 0,
          overflowX: narrowComposer ? "visible" : { xs: "auto", md: "visible" },
          "& > *": { flexShrink: { xs: 0, md: undefined } },
        }}>
        <ComposerCapabilityPicker
          fileInput={fileInput}
          disabled={disabled || composerLocked || draftMutationLocked || preparingFolder}
          menuAnchor={capabilityMenuAnchor}
          listId={capabilityListId}
          filter={capabilityFilter}
          attachmentsEnabled={composerAttachmentsEnabled}
          attachmentsUnavailableReason={composerAttachmentsUnavailableReason}
          fileCount={files.length}
          assetLimits={assetLimits}
          capabilities={capabilities}
          menuActions={menuActions}
          buttonRef={capabilityButtonRef}
          visibleCapabilities={visibleCapabilities}
          onFiles={addFiles}
          onFolderFiles={files => { void importAttachments(files); }}
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
        {destinationMode === "project-chat" ? (
          <ComposerProjectDestinationAction
            disabled={draftMutationLocked}
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
        <Box sx={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          gap: 0.25,
          ml: "auto",
        }}>
          {controls ? (
            <Box sx={{ minWidth: narrowComposer ? 44 : 0, maxWidth: "100%" }}>
              {controls}
            </Box>
          ) : null}
          {enableVoiceDictation ? <DictationControls
            disabled={disabled || composerLocked || sending}
            onFinalTranscript={insertDictatedText}
            onSettlingChange={handleDictationSettlingChange}
          /> : null}
        </Box>
        </Box>
        <Box ref={anchorRef} sx={{ order: -1, flex: "1 0 100%", minWidth: 0 }}>
          <ComposerTextInput
            text={draftMutationLocked ? "" : text}
            inputRef={inputRef}
            disabled={disabled || draftMutationLocked}
            locked={composerLocked}
            placeholder={placeholder}
            comboboxEnabled={Boolean(mentionHandles || commands?.length || projectId)}
            menuOpen={menuOpen}
            listId={mentionListId}
            highlighted={effectiveHighlighted}
            attachmentsEnabled={composerAttachmentsEnabled}
            pastedText={draftMutationLocked ? undefined : pastedText}
            menuSuggestions={menuSuggestions}
            destinationMode={destinationMode}
            requiredRecipient={requiredRecipient}
            inlineDestination={!draftMutationLocked && renderedDefaultDestination
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
            mentionTokens={draftMutationLocked ? [] : mentionTokens}
            mentionBindings={mentionBindings ?? []}
            mentionedBusyHandles={mentionedBusyHandles}
            mentionedHandles={mentionedHandles}
            canSend={canSend}
            onTextChange={(value, nextCaret) => {
              // Blank presentation during intake must not rewrite the durable
              // submitted draft or its mutation/CAS authority.
              if (draftMutationLockedRef.current) return;
              const contentChanged = value !== textRef.current;
              const normalized = normalizeExclusiveNewAgentDestinationForMode(
                destinationMode,
                value,
                exclusiveDestinationHandles,
                nextCaret,
              );
              if (contentChanged) {
                pendingSelection.current = undefined;
                if (authoredTextInput.current) {
                  authoredTextInput.current = false;
                  onAuthoredMentionHandlesChange?.(findMentionedHandles(normalized.text, routingMentionHandles));
                }
              }
              if (!pendingSelection.current && inputRef.current?.isFocused()) {
                const offsets = inputRef.current.getSelectionOffsets();
                writeDraftSelection(draftStorageKey, { text: normalized.text, ...offsets });
              }
              update(normalized.text);
              if (contentChanged) setSendError(undefined);
              setCaret(normalized.caret);
              setHighlighted(0);
              setSuppressMenu(false);
              if (normalized.text !== value) {
                const capturedIntent = selectionIntent.current;
                const capturedEditor = inputRef.current;
                requestAnimationFrame(() => {
                  if (selectionIntent.current !== capturedIntent || inputRef.current !== capturedEditor ||
                      inputRef.current?.getCanonicalText() !== normalized.text) return;
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
            open={menuOpen && !draftMutationLocked}
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
        <Box data-composer-send-actions sx={{ display: { xs: "flex", md: "contents" }, alignItems: "center", gap: 0.25, flexShrink: 0 }}>
        <ComposerSendActions
          allowSendWhileRunning={allowSendWhileRunning}
          canCancel={canCancel}
          cancelPending={cancelPending}
          canSend={canSend}
          compact={narrowComposer}
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
        </Box>
      </Stack>
    </Paper>
  );
}
