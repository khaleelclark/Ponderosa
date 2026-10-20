import type { AgentDetailDto, AgentDto, CollectionPageDto } from "@ponderosa/core";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys.js";

/** Publish confirmed settings to every projection that can own a next-Run
 * picker, including members outside Chat detail's bounded Agent list. */
export function publishUpdatedAgent(client: QueryClient, updated: AgentDto): void {
  // TanStack cancels the retryer synchronously, including transports that do
  // not consume AbortSignal. An older member read cannot replace this result.
  void client.cancelQueries({ queryKey: queryKeys.conversations.membersAll });
  const replace = (items: AgentDto[]) => items.map(agent => agent.id === updated.id ? updated : agent);
  client.setQueriesData<AgentDetailDto>(
    { queryKey: queryKeys.agents.detailPrefix(updated.id) },
    current => current ? { ...current, agent: updated } : current,
  );
  client.setQueriesData<AgentDto[]>(
    { queryKey: queryKeys.agents.all },
    current => Array.isArray(current) ? replace(current) : current,
  );
  client.setQueriesData<unknown>(
    { queryKey: queryKeys.conversations.detailAll },
    (current: unknown) => replaceCachedConversationAgent(current, updated),
  );
  type Members = CollectionPageDto<AgentDto>;
  client.setQueriesData<Members | InfiniteData<Members>>(
    { queryKey: queryKeys.conversations.membersAll },
    current => !current ? current : "pages" in current
      ? { ...current, pages: current.pages.map(page => ({ ...page, items: replace(page.items) })) }
      : { ...current, items: replace(current.items) },
  );
}

export async function refreshAgentRuntime(client: QueryClient, agentId: string): Promise<void> {
  // A write may commit before its HTTP response is lost. Reconcile members as
  // well as detail on either outcome, including reads started before the write.
  await client.cancelQueries({ queryKey: queryKeys.conversations.membersAll });
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.agents.detailPrefix(agentId) }),
    client.invalidateQueries({ queryKey: queryKeys.conversations.detailAll }),
    client.invalidateQueries({ queryKey: queryKeys.conversations.membersAll }),
  ]);
}

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
