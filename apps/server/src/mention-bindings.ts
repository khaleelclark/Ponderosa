import {
  messageTagTokens,
  type AgentDto,
  type CommunicationEvent,
} from "@ponderosa/core";

const RESERVED_HANDLES = new Set([
  "broadcast",
  "everyone",
  "new-agent",
  "operator",
  "pto",
  "user",
]);
const NUMERIC_HANDLE_PATTERN = /^\p{N}+$/u;

export function agentMentionHandle(title: string): string {
  return title.trim().replace(/\s+/gu, "-").replace(/[^\p{L}\p{N}_-]/gu, "");
}

/** Canonical Agent audience for mention presentation; prose never supplies it. */
export function communicationRecipientAgentIds(
  communication: CommunicationEvent | undefined,
): string[] {
  if (communication?.intent === "collaboration") {
    return communication.audience.agentIds;
  }
  if (communication?.schemaVersion !== 2 || communication.intent !== "user_dm") {
    return [];
  }
  return communication.audience.kind === "user_agent"
    ? [communication.audience.agentId]
    : communication.audience.agentIds;
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
 * Resolve display handles against every Agent in the Project while keeping the
 * canonical audience authoritative. Current titles drive presentation; the
 * authored handle remains only as an immutable alias for audit/tooltips.
 */
export function resolveAgentMentionBindings(
  text: string,
  recipientAgentIds: readonly string[],
  agents: readonly Pick<AgentDto, "id" | "title">[],
): Array<{ handle: string; agentId: string; currentTitle: string }> {
  const currentTitleById = new Map<string, string>();
  for (const agent of agents) {
    if (!currentTitleById.has(agent.id)) currentTitleById.set(agent.id, agent.title);
  }
  const handles = [...new Set(messageTagTokens(text)
    .map(token => token.handle)
    .filter((handle) => !RESERVED_HANDLES.has(handle.toLocaleLowerCase())))];
  const bound = new Map<string, string>();
  const usedAgentIds = new Set<string>();

  for (const handle of handles) {
    const matches = [...new Set(agents
      .filter(agent =>
        agentMentionHandle(agent.title).toLocaleLowerCase() ===
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

  // Canonical Direct/Collaboration recipients remain visible even when the
  // provider omitted the routing handle from rendered prose.
  for (const agentId of [...new Set(recipientAgentIds)]) {
    if (usedAgentIds.has(agentId)) continue;
    const title = currentTitleById.get(agentId);
    if (title) bound.set(agentMentionHandle(title), agentId);
  }

  return [...bound].flatMap(([handle, agentId]) => {
    const currentTitle = currentTitleById.get(agentId);
    return currentTitle ? [{ handle, agentId, currentTitle }] : [];
  });
}
