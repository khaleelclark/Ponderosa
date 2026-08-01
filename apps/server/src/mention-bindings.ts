import type { AgentDto } from "@ponderosa/core";

const RESERVED_HANDLES = new Set(["broadcast", "everyone", "user"]);
const NUMERIC_HANDLE_PATTERN = /^\p{N}+$/u;

function mentionHandle(title: string): string {
  return title.trim().replace(/\s+/gu, "-").replace(/[^\p{L}\p{N}_-]/gu, "");
}

/** Current names and immutable send-time labels are aliases for one recipient. */
export function recipientMentionIdentities(
  recipientAgentIds: readonly string[],
  agents: readonly Pick<AgentDto, "id" | "title">[],
  sendTimeLabels?: Readonly<Record<string, string>>,
): Array<Pick<AgentDto, "id" | "title">> {
  return recipientAgentIds.flatMap(agentId => {
    const currentTitle = agents.find(agent => agent.id === agentId)?.title;
    const sendTimeTitle = sendTimeLabels?.[agentId];
    return [...new Set([currentTitle, sendTimeTitle].filter(
      (title): title is string => Boolean(title?.trim()),
    ))].map(title => ({ id: agentId, title }));
  });
}

/**
 * Bind authored display handles to immutable recipient identities. Exact
 * current-name matches are deterministic. A single renamed recipient can also
 * be recovered from the canonical audience without guessing across agents.
 */
export function resolveAgentMentionBindings(
  text: string,
  recipientAgentIds: readonly string[],
  agents: readonly Pick<AgentDto, "id" | "title">[],
): Array<{ handle: string; agentId: string }> {
  const recipients = agents.filter(agent => recipientAgentIds.includes(agent.id));
  const handles = [...new Set([...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)(?=$|\s|[.,!?;:])/gu)]
    .map((match) => match[1]!)
    .filter((handle) => !RESERVED_HANDLES.has(handle.toLocaleLowerCase())))];
  const bound = new Map<string, string>();
  const usedAgentIds = new Set<string>();

  for (const handle of handles) {
    const matches = [...new Set(recipients
      .filter(agent =>
        mentionHandle(agent.title).toLocaleLowerCase() ===
          handle.toLocaleLowerCase())
      .map(agent => agent.id))];
    if (matches.length !== 1) continue;
    bound.set(handle, matches[0]!);
    usedAgentIds.add(matches[0]!);
  }

  const remainingHandles = handles.filter((handle) =>
    !bound.has(handle) && !NUMERIC_HANDLE_PATTERN.test(handle));
  const remainingAgentIds = [...new Set(recipientAgentIds)]
    .filter(agentId => !usedAgentIds.has(agentId));
  if (remainingHandles.length === 1 && remainingAgentIds.length === 1) {
    bound.set(remainingHandles[0]!, remainingAgentIds[0]!);
  }
  return [...bound].map(([handle, agentId]) => ({ handle, agentId }));
}
