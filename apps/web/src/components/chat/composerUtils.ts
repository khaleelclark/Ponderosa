import {
  INLINE_TEXT_MAX_CODE_POINTS,
  unicodeCodePointLength,
} from "@ponderosa/core";
import type {
  AssetLimitsDto,
  ConversationDraftConflictDto,
  ConversationDraftDto,
  EngineCommand,
  EngineComposerCapability,
} from "@ponderosa/core";

export function deletableSupersededDraftAttachmentIds(
  pendingIds: Iterable<string>,
  draft: Pick<ConversationDraftDto, "attachmentIds" | "pastedTextAttachmentId">,
): string[] {
  const referenced = new Set([
    ...draft.attachmentIds,
    ...(draft.pastedTextAttachmentId ? [draft.pastedTextAttachmentId] : []),
  ]);
  return [...pendingIds].filter(id => !referenced.has(id));
}

export async function cleanupReleasedDraftAttachmentIds(
  pendingIds: Set<string>,
  draft: Pick<ConversationDraftDto, "attachmentIds" | "pastedTextAttachmentId">,
  remove: (id: string) => Promise<unknown>,
): Promise<void> {
  await Promise.all(
    deletableSupersededDraftAttachmentIds(pendingIds, draft).map(async id => {
      try {
        await remove(id);
        pendingIds.delete(id);
      } catch {
        // Keep the exact write incarnation's failed cleanup eligible for retry.
        pendingIds.add(id);
      }
    }),
  );
}

export function shouldSendComposerKey(event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  repeat: boolean;
}): boolean {
  return shouldConsumeComposerKey(event) && !event.repeat;
}

export function shouldConsumeComposerKey(event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

export function shouldIgnoreComposerKey(event: {
  isComposing: boolean;
  keyCode?: number;
}): boolean {
  return event.isComposing || event.keyCode === 229;
}

export function shouldAdoptHydratedDraft(
  _editorFocused: boolean,
  locallyEdited: boolean,
): boolean {
  return !locallyEdited;
}

export function hydratedPastedTextContent<T>(input: {
  attachmentId?: string;
  restoredText?: string;
  failure?: T;
  cleanMutationGeneration: number;
  currentMutationGeneration: number;
}): {
  attachmentId?: string;
  text?: string;
  failure?: T;
} | undefined {
  if (
    input.cleanMutationGeneration !== input.currentMutationGeneration
  ) return undefined;
  return {
    ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
    ...(input.failure
      ? { failure: input.failure }
      : input.restoredText !== undefined
        ? { text: input.restoredText }
        : {}),
  };
}

export function savedPastedTextCleanMutationGeneration(input: {
  cleanMutationGeneration: number;
  submittedMutationGeneration: number;
  currentMutationGeneration: number;
  submittedAttachmentId?: string;
  savedAttachmentId?: string;
}): number {
  return input.currentMutationGeneration === input.submittedMutationGeneration &&
      input.savedAttachmentId === input.submittedAttachmentId
    ? input.submittedMutationGeneration
    : input.cleanMutationGeneration;
}

export function draftContentRetryStillOwned(input: {
  capturedScope?: string;
  currentScope?: string;
  capturedHydrationGeneration: number;
  currentHydrationGeneration: number;
  removed: boolean;
  failurePresent: boolean;
  capturedPasteMutationGeneration?: number;
  currentPasteMutationGeneration?: number;
}): boolean {
  return input.capturedScope === input.currentScope &&
    input.capturedHydrationGeneration === input.currentHydrationGeneration &&
    !input.removed &&
    input.failurePresent &&
    (input.capturedPasteMutationGeneration === undefined ||
      input.capturedPasteMutationGeneration ===
        input.currentPasteMutationGeneration);
}

export function draftWriteContinuationStillOwned(input: {
  capturedScope?: string;
  currentScope?: string;
  capturedGeneration: number;
  currentGeneration: number;
}): boolean {
  return input.capturedScope === input.currentScope &&
    input.capturedGeneration === input.currentGeneration;
}

export function composerSubmissionMayClearDraft(input: {
  submittedMutationGeneration: number;
  currentMutationGeneration: number;
  stillOwnsDraft: boolean;
}): boolean {
  return input.stillOwnsDraft &&
    input.submittedMutationGeneration === input.currentMutationGeneration;
}

export function settledDraftWriteContinuation(
  tail: Promise<void>,
  continuation: () => Promise<void>,
): Promise<void> {
  return tail.catch(() => undefined).then(continuation);
}

/** Observing another surface's revision is not authority to overwrite or clear it. */
export function ownedDraftRevisionAfterObservation(
  ownedRevision: number,
  observedRevision: number,
  adopted: boolean,
): number {
  return adopted ? observedRevision : ownedRevision;
}

export interface DraftConflictRecoverySnapshot<TFile, TMention, TFailure> {
  text: string;
  attachmentIds: string[];
  files: Array<{ file: TFile; attachmentId: string }>;
  pastedText?: string;
  pastedTextAttachmentId?: string;
  mentionBindings: TMention[];
  failedContents: TFailure[];
}

export interface RecoverableDraftConflict<TFile, TMention, TFailure> {
  conflict: ConversationDraftConflictDto;
  snapshot: DraftConflictRecoverySnapshot<TFile, TMention, TFailure>;
}

export function restagedDraftConflictSnapshot<TFile, TMention, TFailure>(
  snapshot: DraftConflictRecoverySnapshot<TFile, TMention, TFailure>,
  files: Array<{ file: TFile; attachmentId: string }>,
  pastedTextAttachmentId?: string,
): DraftConflictRecoverySnapshot<TFile, TMention, TFailure> {
  const replacementByHistoricalId = new Map(
    snapshot.files.map((item, index) => [
      item.attachmentId,
      files[index]?.attachmentId,
    ]),
  );
  return {
    ...snapshot,
    attachmentIds: snapshot.attachmentIds.map(
      id => replacementByHistoricalId.get(id) ?? id,
    ),
    files: [...files],
    ...(snapshot.pastedText !== undefined
      ? { pastedTextAttachmentId }
      : snapshot.pastedTextAttachmentId
        ? { pastedTextAttachmentId: snapshot.pastedTextAttachmentId }
        : {}),
    mentionBindings: [...snapshot.mentionBindings],
    failedContents: [...snapshot.failedContents],
  };
}

export function recoverableDraftConflict<TFile, TMention, TFailure>(
  conflict: ConversationDraftConflictDto,
  snapshot: DraftConflictRecoverySnapshot<TFile, TMention, TFailure>,
): RecoverableDraftConflict<TFile, TMention, TFailure> {
  return { conflict, snapshot };
}

export function refreshRecoverableDraftConflict<TFile, TMention, TFailure>(
  recovery: RecoverableDraftConflict<TFile, TMention, TFailure>,
  current: ConversationDraftDto,
  conflicts: ConversationDraftConflictDto[],
): RecoverableDraftConflict<TFile, TMention, TFailure> | undefined {
  const conflict = conflicts.find(candidate => candidate.id === recovery.conflict.id);
  return conflict
    ? { conflict: { ...conflict, current }, snapshot: recovery.snapshot }
    : undefined;
}

export function restoreDraftConflictSnapshot<TFile, TMention, TFailure>(
  snapshot: DraftConflictRecoverySnapshot<TFile, TMention, TFailure>,
  currentEditVersion: number,
): DraftConflictRecoverySnapshot<TFile, TMention, TFailure> & {
  editVersion: number;
  locallyEdited: true;
} {
  return {
    ...snapshot,
    attachmentIds: [...snapshot.attachmentIds],
    files: [...snapshot.files],
    mentionBindings: [...snapshot.mentionBindings],
    failedContents: [...snapshot.failedContents],
    editVersion: currentEditVersion + 1,
    locallyEdited: true,
  };
}

export function composerRecipientGateSatisfied(input: {
  destinationMode?: "project-chat" | "fixed" | "target-required";
  newAgentSelected: boolean;
  requiredRecipientTagged: boolean;
  retryPrepared: boolean;
}): boolean {
  return input.retryPrepared ||
    input.destinationMode !== "target-required" ||
    input.newAgentSelected ||
    input.requiredRecipientTagged;
}

export function composerPreparedRetryAction<Action>(
  prepared: { action: Action; submissionIntentKey?: string } | undefined,
  submissionIntentKey?: string,
): Action | undefined {
  return prepared && prepared.submissionIntentKey === submissionIntentKey
    ? prepared.action
    : undefined;
}

export function removeComposerPasteSelection(
  selection:
    | { kind: "range"; removeText: () => void }
    | { kind: "node"; removeNodes: () => void }
    | { kind: "other" },
): void {
  if (selection.kind === "range") selection.removeText();
  else if (selection.kind === "node") selection.removeNodes();
}

export function hydratedDraftContent<T>(
  revision: number,
  draftText: string,
  localText: string,
  mentionBindings: readonly T[],
): { text: string; mentionBindings: readonly T[] } {
  const restoreLocalText = revision === 0 && Boolean(localText) && !draftText;
  return {
    text: restoreLocalText ? localText : draftText,
    mentionBindings: restoreLocalText ? [] : mentionBindings,
  };
}

export function durableDraftContentReady(input: {
  conversationDraftId?: string;
  filesReady: boolean;
  pastedTextPresent: boolean;
  pastedTextAttachmentId?: string;
  pastedTextUploading: boolean;
  failedRestoreCount: number;
}): boolean {
  return input.failedRestoreCount === 0 &&
    (!input.conversationDraftId || input.filesReady) &&
    (!input.pastedTextPresent || Boolean(
      input.conversationDraftId &&
      input.pastedTextAttachmentId &&
      !input.pastedTextUploading
    ));
}

export function matchingEngineCommands(
  commands: EngineCommand[],
  prefix: string,
): EngineCommand[] {
  const normalized = prefix.toLocaleLowerCase();
  return commands.filter((command) =>
    command.name.toLocaleLowerCase().startsWith(normalized)
  );
}

export function engineCommandDisabledReason(
  command: EngineCommand,
): string | undefined {
  return command.status === "unavailable"
    ? command.unavailableReason ??
        "This provider command is not currently available."
    : undefined;
}

export function providerSlashSubmission(
  text: string,
  commands: readonly EngineCommand[],
): { command: EngineCommand; argumentsText?: string } | { error: string } | undefined {
  const match = /^\/([\p{L}\p{N}_:-]+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return undefined;
  const command = commands.find((candidate) => candidate.name === match[1]);
  if (!command) return undefined;
  const unavailable = engineCommandDisabledReason(command);
  if (unavailable) return { error: unavailable };
  const argumentsText = match[2]?.trim();
  return { command, ...(argumentsText ? { argumentsText } : {}) };
}

export function composerCapabilityDisabledReason(
  capability: EngineComposerCapability,
): string | undefined {
  if (capability.status === "unavailable") {
    return (
      capability.unavailableReason ??
      "This capability is not currently available."
    );
  }
  if (capability.insertText) return undefined;
  if (capability.kind === "connector") {
    return "Available automatically to this Agent; no direct connector command is needed.";
  }
  if (capability.kind === "plugin") {
    return "Available automatically through its runtime-provided skills and connectors.";
  }
  return "This capability cannot be inserted in a message.";
}

export function matchingComposerCapabilities(
  capabilities: readonly EngineComposerCapability[],
  query: string,
): EngineComposerCapability[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...capabilities];
  return capabilities.filter((capability) =>
    [capability.label, capability.kind, capability.description].some((value) =>
      value.toLocaleLowerCase().includes(normalized)
    )
  );
}

export function insertComposerCapability(
  text: string,
  caret: number,
  capability: EngineComposerCapability,
): { text: string; caret: number } | undefined {
  if (!capability.insertText || composerCapabilityDisabledReason(capability)) {
    return undefined;
  }
  return {
    text: `${text.slice(0, caret)}${capability.insertText}${text.slice(caret)}`,
    caret: caret + capability.insertText.length,
  };
}

export function canSubmitComposerText(input: {
  text: string;
  disabled: boolean;
  running: boolean;
  allowUnmentionedSend: boolean;
  mentionedHandles: string[];
  mentionedBusyHandles: string[];
}): boolean {
  return (
    input.text.trim().length > 0 &&
    !input.disabled &&
    !input.running &&
    (input.allowUnmentionedSend || input.mentionedHandles.length > 0)
  );
}

export function shouldExtractLongPaste(value: string): boolean {
  return unicodeCodePointLength(value) > INLINE_TEXT_MAX_CODE_POINTS;
}

export function composerSubmissionText(
  text: string,
  pastedText?: string,
): string {
  return [text.trim(), pastedText?.trim()]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

export function shouldShowQueueControl(input: {
  text: string;
  hasAttachments: boolean;
  agentResponding: boolean;
  disabled: boolean;
}): boolean {
  return (
    input.agentResponding &&
    !input.disabled &&
    (input.text.trim().length > 0 || input.hasAttachments)
  );
}

const COMPOSER_ACCEPTED_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/json",
  "application/zip",
]);
const COMPOSER_EXTENSION_MEDIA_TYPES: Record<string, string> = {
  ".csv": "text/plain",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/plain",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".zip": "application/zip",
};
const COMPOSER_MEDIA_TYPE_ALIASES: Record<string, string> = {
  "text/csv": "text/plain",
  "text/markdown": "text/plain",
  "text/x-markdown": "text/plain",
};
export const COMPOSER_MAX_FILES = 20;
export const COMPOSER_MAX_FILE_BYTES = 8 * 1024 * 1024;
const COMPOSER_MAX_MESSAGE_BYTES = 80 * 1024 * 1024;

function composerFileMediaType(file: Pick<File, "name" | "type">): string {
  const declared = file.type
    .split(";", 1)[0]
    ?.trim()
    .toLocaleLowerCase();
  const aliased = declared
    ? (COMPOSER_MEDIA_TYPE_ALIASES[declared] ?? declared)
    : undefined;
  if (aliased && aliased !== "application/octet-stream") return aliased;
  const dot = file.name.lastIndexOf(".");
  const extension = dot >= 0
    ? file.name.slice(dot).toLocaleLowerCase()
    : "";
  return COMPOSER_EXTENSION_MEDIA_TYPES[extension] ?? aliased ?? "";
}

export function filesFromClipboard(
  items: ArrayLike<Pick<DataTransferItem, "kind" | "getAsFile">>,
  fallback: ArrayLike<File> = [],
): File[] {
  const extracted = Array.from(items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  return extracted.length > 0 ? extracted : Array.from(fallback);
}

export function selectComposerFiles(
  current: File[],
  candidates: File[],
  limits?: AssetLimitsDto,
): { accepted: File[]; error?: string } {
  const maxFiles = limits?.maxAssetsPerMessage ?? COMPOSER_MAX_FILES;
  const maxFileBytes = limits?.maxFileBytes ?? COMPOSER_MAX_FILE_BYTES;
  const maxMessageBytes = limits?.maxMessageBytes ?? COMPOSER_MAX_MESSAGE_BYTES;
  const acceptedMediaTypes = limits
    ? new Set<string>(limits.acceptedMediaTypes)
    : COMPOSER_ACCEPTED_MEDIA_TYPES;
  const accepted: File[] = [];
  const rejected: string[] = [];
  let bytes = current.reduce((total, file) => total + file.size, 0);
  for (const file of candidates) {
    const mediaType = composerFileMediaType(file);
    const reason =
      current.length + accepted.length >= maxFiles
        ? `the ${maxFiles}-file limit was reached`
        : !acceptedMediaTypes.has(mediaType)
          ? "its file type is not supported"
          : file.size > maxFileBytes
            ? `it exceeds ${Math.floor(maxFileBytes / 1024 / 1024)} MiB`
            : bytes + file.size > maxMessageBytes
              ? `the message would exceed ${Math.floor(maxMessageBytes / 1024 / 1024)} MiB`
              : undefined;
    if (reason) {
      rejected.push(`${file.name || "Unnamed file"} wasn’t attached because ${reason}.`);
      continue;
    }
    accepted.push(file);
    bytes += file.size;
  }
  return {
    accepted,
    error: rejected.length > 0 ? rejected.join(" ") : undefined,
  };
}

export type ComposerAttachmentState = { files: File[]; error?: string };
export type ComposerAttachmentAction =
  | { type: "add"; candidates: File[]; limits?: AssetLimitsDto }
  | { type: "prepend"; files: File[] }
  | { type: "remove"; index: number }
  | { type: "replace"; files: File[]; error?: string }
  | { type: "set_error"; error: string }
  | { type: "clear_error" }
  | { type: "clear" };

export function composerAttachmentReducer(
  state: ComposerAttachmentState,
  action: ComposerAttachmentAction,
): ComposerAttachmentState {
  if (action.type === "clear") return { files: [] };
  if (action.type === "clear_error") return { files: state.files };
  if (action.type === "set_error") {
    return { ...state, error: action.error };
  }
  if (action.type === "prepend") {
    return { files: [...action.files, ...state.files] };
  }
  if (action.type === "remove") {
    return {
      files: state.files.filter((_, index) => index !== action.index),
    };
  }
  if (action.type === "replace") {
    return {
      files: action.files,
      ...(action.error ? { error: action.error } : {}),
    };
  }
  const selection = selectComposerFiles(
    state.files,
    action.candidates,
    action.limits,
  );
  return {
    files:
      selection.accepted.length > 0
        ? [...state.files, ...selection.accepted]
        : state.files,
    error: selection.error,
  };
}
