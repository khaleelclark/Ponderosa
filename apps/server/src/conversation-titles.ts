export function conciseConversationTitle(text: string): string | undefined {
  const normalized = text
    .replace(/^\s*(?:#(?:broadcast|everyone|user|[\w-]+)\s+)+/i, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_#>\[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  const words = normalized.split(" ").filter(Boolean).slice(0, 5);
  if (words.length < 2) return undefined;
  return words.join(" ").replace(/[\s,.;:!?-]+$/g, "").slice(0, 48).trim() || undefined;
}

/** Deterministic title used when no provider title service is available.
 * The conversation belongs to the operator's request, not a keyword mash of
 * an agent's response. */
export function semanticConversationTitle(operatorText: string, agentText: string): string | undefined {
  void agentText;
  return conciseConversationTitle(operatorText);
}
