import type { AgentDto } from "@ponderosa/core";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys.js";

/** Publish only a server-confirmed Agent, before its initial Communication can
 * be refetched. Absence from a lagging roster is not evidence of deletion. */
export function publishCreatedAgent(client: QueryClient, agent: AgentDto): void {
  client.setQueryData<AgentDto[]>(queryKeys.agents.project(agent.projectId), (current = []) =>
    [...current.filter(item => item.id !== agent.id), agent]);
  if (!agent.conversationId) return;
  client.setQueriesData({ queryKey: queryKeys.conversations.detailPrefix(agent.conversationId) }, current => {
    if (!current || typeof current !== "object" || !("conversation" in current) ||
        !current.conversation || typeof current.conversation !== "object" ||
        !("id" in current.conversation) || current.conversation.id !== agent.conversationId ||
        !("agents" in current) || !Array.isArray(current.agents)) return current;
    return { ...current, agents: [...current.agents.filter(item => item?.id !== agent.id), agent] };
  });
}

/** Conversation detail shares a key prefix with receipt queries; ignore other shapes. */
export function replaceCachedConversationAgent(
  current: unknown,
  updated: AgentDto,
): unknown {
  if (!current || typeof current !== "object" || !("agents" in current) ||
      !Array.isArray(current.agents)) return current;
  return {
    ...current,
    agents: current.agents.map(agent =>
      agent && typeof agent === "object" && "id" in agent && agent.id === updated.id
        ? updated
        : agent),
  };
}
