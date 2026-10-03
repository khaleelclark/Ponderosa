import { messageTagTokens, type CommunicationEvent } from "./communication.js";
import { agentMentionHandleBase, RESERVED_AGENT_MENTION_HANDLES } from "./agent-handles.js";
import type { AgentDto, AgentMentionBindingDto, CollaborationRecipientDto } from "./dto.js";

/** A display projection only. Audience IDs and immutable identity own historical aliases. */
export function collaborationPresentation(event: CommunicationEvent, agents: readonly Pick<AgentDto, "id" | "title" | "handle">[]): {
  collaborationRecipients: CollaborationRecipientDto[];
  agentMentions: AgentMentionBindingDto[];
} {
  if (event.intent !== "collaboration") return { collaborationRecipients: [], agentMentions: [] };
  const collaborationRecipients = [...new Set(event.audience.agentIds)].map(id => {
    const current = agents.find(agent => agent.id === id);
    const title = event.identity?.recipientLabels?.[id] || current?.title;
    const handle = event.identity?.recipientHandles?.[id]
      || (event.identity?.recipientLabels?.[id] ? agentMentionHandleBase(event.identity.recipientLabels[id]!) : undefined)
      || current?.handle;
    return { id, title: title || "Unavailable recipient", ...(handle ? { handle } : {}), available: Boolean(current),
      ...(current ? { currentTitle: current.title, currentHandle: current.handle } : {}) };
  });
  const agentMentions: AgentMentionBindingDto[] = [];
  for (const handle of new Set(messageTagTokens(event.text).map(token => token.handle))) {
    if (RESERVED_AGENT_MENTION_HANDLES.has(handle.toLocaleLowerCase())) continue;
    // A reused current name must not steal a canonical send-time identity.
    const historical = collaborationRecipients.filter(recipient => recipient.handle?.toLocaleLowerCase() === handle.toLocaleLowerCase());
    const matches = historical.length ? historical : agents
      .filter(agent => agent.handle.toLocaleLowerCase() === handle.toLocaleLowerCase())
      .map(agent => ({ id: agent.id, title: agent.title, currentTitle: agent.title, currentHandle: agent.handle, available: true }));
    if (matches.length !== 1) continue;
    const match = matches[0]!;
    agentMentions.push({ projectId: event.projectId, handle, agentId: match.id,
      currentHandle: match.currentHandle ?? handle, currentTitle: match.currentTitle ?? match.title, available: match.available });
  }
  return { collaborationRecipients, agentMentions };
}

/** Recipient completeness is by ID, never spelling or the number of unknown hashtags. */
export function missingCollaborationRecipients(text: string, recipients: readonly CollaborationRecipientDto[], mentions: readonly AgentMentionBindingDto[] = []): CollaborationRecipientDto[] {
  const tokens = new Set(messageTagTokens(text).map(token => token.handle));
  const representedIds = new Set(mentions.filter(mention => tokens.has(mention.handle)).map(mention => mention.agentId));
  return [...new Map(recipients.filter(recipient => !representedIds.has(recipient.id)).map(recipient => [recipient.id, recipient])).values()];
}
