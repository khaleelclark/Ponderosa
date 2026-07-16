import type { AgentDto } from "@ponderosa/core";

const RESERVED_HANDLES = new Set(["broadcast", "everyone", "user"]);

function mentionHandle(title: string): string {
  return title.trim().replace(/\s+/gu, "-").replace(/[^\p{L}\p{N}_-]/gu, "");
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
  const recipients = new Map(agents.filter((agent) => recipientAgentIds.includes(agent.id)).map((agent) => [agent.id, agent]));
  const handles = [...new Set([...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)(?=$|\s|[.,!?;:])/gu)]
    .map((match) => match[1]!)
    .filter((handle) => !RESERVED_HANDLES.has(handle.toLocaleLowerCase())))];
  const bound = new Map<string, string>();
  const usedAgentIds = new Set<string>();

  for (const handle of handles) {
    const matches = [...recipients.values()].filter((agent) =>
      mentionHandle(agent.title).toLocaleLowerCase() === handle.toLocaleLowerCase());
    if (matches.length !== 1) continue;
    bound.set(handle, matches[0]!.id);
    usedAgentIds.add(matches[0]!.id);
  }

  const remainingHandles = handles.filter((handle) => !bound.has(handle));
  const remainingAgentIds = [...recipients.keys()].filter((agentId) => !usedAgentIds.has(agentId));
  if (remainingHandles.length === 1 && remainingAgentIds.length === 1) {
    bound.set(remainingHandles[0]!, remainingAgentIds[0]!);
  }
  return [...bound].map(([handle, agentId]) => ({ handle, agentId }));
}
