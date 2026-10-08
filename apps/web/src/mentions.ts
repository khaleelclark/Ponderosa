import {
  messageTagTokens,
  type AgentDto,
} from "@ponderosa/core";

const RESERVED_SCOPE_HANDLES = new Set(["broadcast", "user", "everyone"]);

export const MESSAGE_TAG_PREFIX = "#ponderosa-tag:";

/** Decode only Ponderosa's internal mention links; malformed authored Markdown
 * remains ordinary inert text instead of taking down the transcript. */
export function messageTagHandle(href: string | undefined): string | undefined {
  if (!href?.startsWith(MESSAGE_TAG_PREFIX)) return undefined;
  try {
    return decodeURIComponent(href.slice(MESSAGE_TAG_PREFIX.length)) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Return the distinct, canonical handles mentioned in text. Keeping this
 * independent of agent data lets the composer update its local UI without
 * causing the whole conversation transcript to re-render on every keystroke.
 */
export function findMentionedHandles(text: string, handles: Iterable<string>): string[] {
  const byHandle = new Map(
    [...handles].map((handle) => [handle.toLocaleLowerCase(), handle]),
  );
  const mentioned = new Map<string, string>();

  for (const token of messageTagTokens(text)) {
    const handle = byHandle.get(token.handle.toLocaleLowerCase());
    if (handle) mentioned.set(handle.toLocaleLowerCase(), handle);
  }

  return [...mentioned.values()];
}

/** Whether the reserved Project Broadcast scope handle is present. */
export function hasBroadcastMention(text: string): boolean {
  return hasMessageTag(text, "broadcast");
}

/** Whether the reserved collaboration-wide Agent handle is present. */
export function hasEveryoneMention(text: string): boolean {
  return hasMessageTag(text, "everyone");
}

function hasMessageTag(text: string, handle: string): boolean {
  const normalized = handle.toLocaleLowerCase();
  return messageTagTokens(text).some(
    token => token.handle.toLocaleLowerCase() === normalized,
  );
}

/** Resolve a displayed agent handle to its stable navigation identity. */
export function agentIdForMentionHandle(
  agents: readonly Pick<AgentDto, "id" | "title" | "handle">[],
  handle: string,
): string | undefined {
  const normalized = handle.toLocaleLowerCase();
  if (RESERVED_SCOPE_HANDLES.has(normalized)) return undefined;
  return agents.find((agent) => agent.handle.toLocaleLowerCase() === normalized)?.id;
}
