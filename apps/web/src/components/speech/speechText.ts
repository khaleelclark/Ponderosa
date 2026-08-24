export interface SpeechTextInsertion {
  caret: number;
  text: string;
}

function needsLeadingSpace(before: string, spoken: string): boolean {
  return Boolean(
    before &&
      !/\s$/u.test(before) &&
      !/^[,.;:!?\])}]/u.test(spoken),
  );
}

function needsTrailingSpace(spoken: string, after: string): boolean {
  return Boolean(
    after &&
      !/\s$/u.test(spoken) &&
      !/^[,.;:!?\])}]/u.test(after),
  );
}

export function insertSpeechText(
  current: string,
  spokenText: string,
  selectionStart: number,
  selectionEnd: number,
): SpeechTextInsertion {
  const spoken = spokenText.trim();
  if (!spoken) return { text: current, caret: selectionStart };
  const start = Math.max(0, Math.min(selectionStart, current.length));
  const end = Math.max(start, Math.min(selectionEnd, current.length));
  const before = current.slice(0, start);
  const after = current.slice(end);
  const leading = needsLeadingSpace(before, spoken) ? " " : "";
  const trailing = needsTrailingSpace(spoken, after) ? " " : "";
  const inserted = `${leading}${spoken}${trailing}`;
  return {
    text: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}

/** Make common Markdown read naturally without changing the durable message. */
export function speakableMessageText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gmu, "")
    .replace(/```(?:[^\n]*)\n?([\s\S]*?)```/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/[*_~]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
