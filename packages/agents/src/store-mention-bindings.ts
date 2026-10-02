import {
  messageTagTokens,
  RESERVED_AGENT_MENTION_HANDLES,
  type AgentDto,
  type AgentMentionBindingDto,
  type CommunicationEvent,
} from "@ponderosa/core";

function recipientIds(event: CommunicationEvent): string[] {
  if (event.intent === "collaboration") return event.audience.agentIds;
  if (event.intent === "user_dm") {
    return event.audience.kind === "user_agent"
      ? [event.audience.agentId]
      : event.audience.kind === "user_agents" ? event.audience.agentIds : [];
  }
  if (event.intent === "broadcast") {
    return [...new Set([
      ...Object.keys(event.identity?.recipientHandles ?? {}),
      ...Object.keys(event.identity?.recipientLabels ?? {}),
    ])];
  }
  return [];
}

/** Rebuild structural mention presentation from canonical recipients and their
 * immutable send-time handles. Recipient IDs, never prose, remain authority. */
export function communicationMentionBindings(
  text: string,
  event: CommunicationEvent,
  getAgent: (agentId: string) => AgentDto | undefined,
): AgentMentionBindingDto[] {
  const recipients = recipientIds(event).map(agentId => {
    const current = getAgent(agentId);
    const authoredHandle = event.identity?.recipientHandles?.[agentId];
    const currentHandle = current?.handle ?? authoredHandle;
    const currentTitle = current?.title ?? event.identity?.recipientLabels?.[agentId];
    return currentHandle && currentTitle
      ? { agentId, current, authoredHandle, currentHandle, currentTitle }
      : undefined;
  }).filter((recipient): recipient is NonNullable<typeof recipient> => Boolean(recipient));
  const tokens = messageTagTokens(text).filter(token =>
    !RESERVED_AGENT_MENTION_HANDLES.has(token.handle.toLocaleLowerCase()));
  const result = new Map<string, AgentMentionBindingDto>();
  for (const token of tokens) {
    const matches = recipients.filter(recipient =>
      [recipient.currentHandle, recipient.authoredHandle]
        .filter(Boolean)
        .some(handle => handle!.toLocaleLowerCase() === token.handle.toLocaleLowerCase()));
    if (matches.length !== 1) continue;
    const recipient = matches[0]!;
    result.set(recipient.agentId, {
      projectId: event.projectId,
      handle: token.handle,
      agentId: recipient.agentId,
      currentHandle: recipient.currentHandle,
      currentTitle: recipient.currentTitle,
    });
  }
  for (const recipient of recipients) {
    if (result.has(recipient.agentId)) continue;
    result.set(recipient.agentId, {
      projectId: event.projectId,
      handle: recipient.authoredHandle ?? recipient.currentHandle,
      agentId: recipient.agentId,
      currentHandle: recipient.currentHandle,
      currentTitle: recipient.currentTitle,
    });
  }
  // A creation tag is display-only. The exact canonical opening identity owns
  // its replacement; ordinary #new-agent prose never identifies a recipient.
  const openingId = event.eventId.startsWith("agent-opening:")
    ? event.eventId.slice("agent-opening:".length) : undefined;
  const openingAgent = openingId ? getAgent(openingId) : undefined;
  const openingMention = openingAgent?.projectId === event.projectId
    ? [{ projectId: event.projectId, agentId: openingAgent.id, handle: "new-agent",
        currentHandle: openingAgent.handle, currentTitle: openingAgent.title }]
    : [];
  return [...result.values(), ...openingMention];
}
