import {
  agentMentionHandleBase,
  messageTagTokens,
  type AgentDto,
} from "@ponderosa/core";

const RESERVED_SCOPE_HANDLES = new Set(["broadcast", "user", "everyone"]);

/** Stable, typeable handle derived from the agent's current display name. */
export function agentMentionHandle(title: string): string {
  return agentMentionHandleBase(title);
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

/** Resolve every distinct #tag against the agents currently in a conversation. */
export function findMentionedAgents(text: string, agents: AgentDto[]): AgentDto[] {
  const byHandle = new Map(
    agents
      .map((agent) => [agent.handle.toLocaleLowerCase(), agent] as const)
      .filter(([handle]) => !RESERVED_SCOPE_HANDLES.has(handle)),
  );
  return findMentionedHandles(text, byHandle.keys())
    .map((handle) => byHandle.get(handle.toLocaleLowerCase()))
    .filter((agent): agent is AgentDto => Boolean(agent));
}
