import { messageTagTokens } from "@ponderosa/core";

export const NEW_AGENT_DESTINATION_HANDLE = "new-agent";

export type ComposerDestinationMode =
  | "project-chat"
  | "fixed"
  | "target-required";

export function composerSupportsRoutingDestinations(
  destinationMode: ComposerDestinationMode | undefined,
): boolean {
  return (
    destinationMode === "project-chat" || destinationMode === "target-required"
  );
}

export function activeComposerMention(
  text: string,
): { handlePrefix: string; start: number } | undefined {
  const match = /(?:^|[^\p{L}\p{N}_-])#([\p{L}\p{N}_-]*)$/u.exec(text);
  if (!match) return undefined;
  return {
    handlePrefix: match[1]!,
    start: match.index + match[0].indexOf("#"),
  };
}

export function composerDestinationMention(handle: string): string {
  return `#${handle} `;
}

export function hasComposerDestination(
  text: string,
  handle: string,
): boolean {
  const normalized = handle.toLocaleLowerCase();
  return messageTagTokens(text).some(
    token => token.handle.toLocaleLowerCase() === normalized,
  );
}

function destinationRanges(
  text: string,
  handles: readonly string[],
): Array<{ start: number; end: number }> {
  const normalized = new Set(handles.map(handle => handle.toLocaleLowerCase()));
  return messageTagTokens(text)
    .filter(token => normalized.has(token.handle.toLocaleLowerCase()))
    .map(token => ({
      start: token.start > 0 && /\s/u.test(text[token.start - 1]!)
        ? token.start - 1
        : token.start,
      end: token.end,
    }));
}

export function removeComposerDestinations(
  text: string,
  handles: readonly string[],
): string {
  return destinationRanges(text, handles)
    .reverse()
    .reduce(
      (current, range) => current.slice(0, range.start) + current.slice(range.end),
      text,
    );
}

export function removeComposerDestinationsAroundSelection(
  text: string,
  start: number,
  end: number,
  handles: readonly string[],
): { text: string; start: number; end: number } {
  const ranges = destinationRanges(text, handles)
    .filter(range => range.end <= start || range.start >= end);
  const removedBeforeSelection = ranges
    .filter(range => range.end <= start)
    .reduce((total, range) => total + range.end - range.start, 0);
  return {
    text: ranges.reverse().reduce(
      (current, range) => current.slice(0, range.start) + current.slice(range.end),
      text,
    ),
    start: Math.max(0, start - removedBeforeSelection),
    end: Math.max(0, end - removedBeforeSelection),
  };
}

export function normalizeExclusiveNewAgentDestination(
  text: string,
  existingHandles: readonly string[],
  caret?: number,
): { text: string; caret: number } {
  const conflictingHandles = existingHandles.filter(
    handle =>
      handle.toLocaleLowerCase() !== NEW_AGENT_DESTINATION_HANDLE,
  );
  const normalizedExisting = new Set(
    conflictingHandles.map(handle => handle.toLocaleLowerCase()),
  );
  const destinations = messageTagTokens(text).filter(token => {
    const handle = token.handle.toLocaleLowerCase();
    return handle === NEW_AGENT_DESTINATION_HANDLE || normalizedExisting.has(handle);
  });
  const hasNewAgent = destinations.some(
    token => token.handle.toLocaleLowerCase() === NEW_AGENT_DESTINATION_HANDLE,
  );
  const hasExisting = destinations.some(
    token => token.handle.toLocaleLowerCase() !== NEW_AGENT_DESTINATION_HANDLE,
  );
  const selection = Math.max(0, Math.min(caret ?? text.length, text.length));
  if (!hasNewAgent || !hasExisting) return { text, caret: selection };

  const selected = caret === undefined
    ? destinations.at(-1)
    : [...destinations].reverse().find(
        token => token.start <= selection && selection <= token.end + 1,
      ) ?? destinations.at(-1);
  const keepNewAgent =
    selected?.handle.toLocaleLowerCase() === NEW_AGENT_DESTINATION_HANDLE;
  const normalized = removeComposerDestinationsAroundSelection(
    text,
    selection,
    selection,
    keepNewAgent ? conflictingHandles : [NEW_AGENT_DESTINATION_HANDLE],
  );
  const leadingSpace = /^\s+/u.exec(normalized.text)?.[0].length ?? 0;
  return {
    text: normalized.text.slice(leadingSpace),
    caret: Math.max(0, normalized.start - leadingSpace),
  };
}

export function normalizeExclusiveNewAgentDestinationForMode(
  destinationMode: ComposerDestinationMode | undefined,
  text: string,
  existingHandles: readonly string[],
  caret?: number,
): { text: string; caret: number } {
  if (!composerSupportsRoutingDestinations(destinationMode)) {
    return {
      text,
      caret: Math.max(0, Math.min(caret ?? text.length, text.length)),
    };
  }
  return normalizeExclusiveNewAgentDestination(text, existingHandles, caret);
}

export function singleComposerDestination(
  text: string,
  handle: string,
): string {
  const normalized = handle.toLocaleLowerCase();
  let found = false;
  const duplicates = messageTagTokens(text).filter(token => {
    if (token.handle.toLocaleLowerCase() !== normalized) return false;
    if (!found) {
      found = true;
      return false;
    }
    return true;
  });
  return duplicates.reverse().reduce(
    (current, token) => current.slice(0, token.start) + current.slice(token.end),
    text,
  );
}

export function clampComposerMenuIndex(index: number, count: number): number {
  return Math.max(0, Math.min(index, count - 1));
}

export function prependComposerDestination(
  text: string,
  handle: string,
): string {
  if (hasComposerDestination(text, handle)) return text;
  return `${composerDestinationMention(handle)}${text.replace(/^\s+/u, "")}`;
}

export function selectExclusiveNewAgentDestination(
  text: string,
  start: number,
  end: number,
  existingHandles: readonly string[],
): string {
  const selection = removeComposerDestinationsAroundSelection(
    text,
    start,
    end,
    [NEW_AGENT_DESTINATION_HANDLE, ...existingHandles],
  );
  return `${selection.text.slice(0, selection.start)}#${NEW_AGENT_DESTINATION_HANDLE} ${selection.text.slice(selection.end)}`.trimStart();
}
