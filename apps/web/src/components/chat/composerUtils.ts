import {
  INLINE_TEXT_MAX_CODE_POINTS,
  unicodeCodePointLength,
} from "@ponderosa/core";
import type {
  AssetLimitsDto,
  EngineCommand,
  EngineComposerCapability,
} from "@ponderosa/core";

export function shouldSendComposerKey(event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  repeat: boolean;
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && !event.repeat;
}

export function shouldIgnoreComposerKey(event: {
  key: string;
  isComposing: boolean;
}): boolean {
  return event.key === "Enter" && event.isComposing;
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
  if (!match) {
    return text.trimStart().startsWith("/")
      ? { error: "This runtime does not advertise that slash command." }
      : undefined;
  }
  const command = commands.find((candidate) => candidate.name === match[1]);
  if (!command) {
    return { error: `The active provider does not advertise /${match[1]}.` };
  }
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
export const COMPOSER_MAX_FILES = 20;
export const COMPOSER_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const COMPOSER_MAX_MESSAGE_BYTES = 80 * 1024 * 1024;

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
  let bytes = current.reduce((total, file) => total + file.size, 0);
  for (const file of candidates) {
    if (
      current.length + accepted.length < maxFiles &&
      acceptedMediaTypes.has(file.type) &&
      file.size <= maxFileBytes &&
      bytes + file.size <= maxMessageBytes
    ) {
      accepted.push(file);
      bytes += file.size;
    }
  }
  const rejected = candidates.length - accepted.length;
  return {
    accepted,
    error:
      rejected > 0
        ? `${rejected} pasted or selected ${rejected === 1 ? "file was" : "files were"} not attached. Use up to ${maxFiles} supported files, ${Math.floor(maxFileBytes / 1024 / 1024)} MiB each and ${Math.floor(maxMessageBytes / 1024 / 1024)} MiB total.`
        : undefined,
  };
}

export type ComposerAttachmentState = { files: File[]; error?: string };
export type ComposerAttachmentAction =
  | { type: "add"; candidates: File[]; limits?: AssetLimitsDto }
  | { type: "remove"; index: number }
  | { type: "replace"; files: File[]; error?: string }
  | { type: "clear" };

export function composerAttachmentReducer(
  state: ComposerAttachmentState,
  action: ComposerAttachmentAction,
): ComposerAttachmentState {
  if (action.type === "clear") return { files: [] };
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
