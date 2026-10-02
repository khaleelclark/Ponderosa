import type { ConversationDecisionEventDto } from "@ponderosa/core";
import type { AgentStore } from "@ponderosa/agents";

/** Resolve only the canonical recipient ID, never answer text or a loaded roster. */
export function withDecisionRecipient<T extends ConversationDecisionEventDto>(store: Pick<AgentStore, "getAgent">, event: T): T {
  const agent = store.getAgent(event.decision.agentId);
  return { ...event, recipientAgent: agent && agent.id === event.decision.agentId && agent.projectId === event.decision.projectId
    ? { id: agent.id, title: agent.title, handle: agent.handle }
    : null };
}
