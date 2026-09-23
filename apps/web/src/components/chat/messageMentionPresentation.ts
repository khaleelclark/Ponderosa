import { messageTagTokens } from "@ponderosa/core";
import type { AgentMentionBindingDto } from "@ponderosa/core";

/**
 * Resolve only durable Agent mention bindings. An unbound #token may be a PR,
 * issue, or ordinary hashtag; missing identity is not evidence of an unavailable
 * Agent.
 */
export function resolveMessageMentionText(
  text: string,
  mentions: readonly AgentMentionBindingDto[] | undefined,
): string {
  const tokens = messageTagTokens(text);
  if (!tokens.length) return text;
  let cursor = 0;
  let resolved = "";
  for (const token of tokens) {
    resolved += text.slice(cursor, token.start);
    const binding = mentions?.find(mention =>
      mention.handle.toLocaleLowerCase() === token.handle.toLocaleLowerCase());
    resolved += binding
      ? `#${binding.currentHandle}`
      : text.slice(token.start, token.end);
    cursor = token.end;
  }
  return resolved + text.slice(cursor);
}
