import { messageTagTokens } from "@ponderosa/core";

export const NEW_AGENT_DESTINATION_HANDLE = "new-agent";

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
  const removable = new Set(
    [NEW_AGENT_DESTINATION_HANDLE, ...existingHandles].map(handle =>
      handle.toLocaleLowerCase()),
  );
  const ranges = destinationRanges(
    text,
    [...removable],
  ).filter(range => range.end <= start || range.start >= end);
  const removedBeforeSelection = ranges
    .filter(range => range.end <= start)
    .reduce((total, range) => total + range.end - range.start, 0);
  const cleaned = ranges.reverse().reduce(
    (current, range) => current.slice(0, range.start) + current.slice(range.end),
    text,
  );
  const insertion = Math.max(0, start - removedBeforeSelection);
  const selectionEnd = Math.max(insertion, end - removedBeforeSelection);
  return `${cleaned.slice(0, insertion)}#${NEW_AGENT_DESTINATION_HANDLE} ${cleaned.slice(selectionEnd)}`.trimStart();
}
