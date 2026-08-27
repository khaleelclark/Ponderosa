import {
  agentMentionHandleBase,
  messageTagTokens,
  RESERVED_AGENT_MENTION_HANDLES,
  type AgentDto,
  type CommunicationEvent,
} from "@ponderosa/core";

const NUMERIC_HANDLE_PATTERN = /^\p{N}+$/u;

export function agentMentionHandle(title: string): string {
  return agentMentionHandleBase(title);
}

/** Canonical Agent audience for mention presentation; prose never supplies it. */
export function communicationRecipientAgentIds(
  communication: CommunicationEvent | undefined,
): string[] {
  if (communication?.intent === "broadcast") {
    return [...new Set([
      ...Object.keys(communication.identity?.recipientHandles ?? {}),
      ...Object.keys(communication.identity?.recipientLabels ?? {}),
    ])];
  }
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
  agents: readonly Pick<AgentDto, "id" | "title" | "handle">[],
  sendTimeLabels?: Readonly<Record<string, string>>,
  sendTimeHandles?: Readonly<Record<string, string>>,
): Array<{ id: string; title: string; handle?: string }> {
  return recipientAgentIds.flatMap(agentId => {
    const current = agents.find(agent => agent.id === agentId);
    const sendTimeTitle = sendTimeLabels?.[agentId];
    return [
      ...(current ? [{ id: agentId, title: current.title, handle: current.handle }] : []),
      ...(sendTimeTitle && sendTimeTitle !== current?.title
        ? [{ id: agentId, title: sendTimeTitle, handle: sendTimeHandles?.[agentId] }]
        : []),
    ];
  });
}

/**
 * Resolve display handles against every Agent in the Project while keeping the
 * canonical audience authoritative. Current titles drive presentation; the
 * authored handle remains only as an immutable alias for audit/tooltips.
 */
export function resolveAgentMentionBindings(
  projectId: string,
  text: string,
  recipientAgentIds: readonly string[],
  agents: ReadonlyArray<{ id: string; title: string; handle?: string }>,
): Array<{ projectId: string; handle: string; agentId: string; currentHandle: string; currentTitle: string }> {
  const currentTitleById = new Map<string, string>();
  const currentHandleById = new Map<string, string>();
  for (const agent of agents) {
    if (!currentTitleById.has(agent.id)) currentTitleById.set(agent.id, agent.title);
    if (agent.handle && !currentHandleById.has(agent.id)) {
      currentHandleById.set(agent.id, agent.handle);
    }
  }
  const handles = [...new Set(messageTagTokens(text)
    .map(token => token.handle)
    .filter((handle) => !RESERVED_AGENT_MENTION_HANDLES.has(handle.toLocaleLowerCase())))];
  const bound = new Map<string, string>();
  const usedAgentIds = new Set<string>();

  for (const handle of handles) {
    const matches = [...new Set(agents
      .filter(agent =>
        (agent.handle ?? agentMentionHandle(agent.title)).toLocaleLowerCase() ===
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
    const handle = currentHandleById.get(agentId) ?? (title ? agentMentionHandle(title) : undefined);
    if (handle) bound.set(handle, agentId);
  }

  return [...bound].flatMap(([handle, agentId]) => {
    const currentTitle = currentTitleById.get(agentId);
    return currentTitle ? [{
      projectId,
      handle,
      agentId,
      currentHandle: currentHandleById.get(agentId) ?? handle,
      currentTitle,
    }] : [];
  });
}
