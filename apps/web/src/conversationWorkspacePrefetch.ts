import type {QueryClient} from '@tanstack/react-query';
import {api} from './api';
import {queryKeys} from './queryKeys';

/** Warm canonical entries only; route owners still validate membership before rendering. */
export function prefetchConversationWorkspace(
  client: QueryClient,
  conversationId: string,
  projectId: string | undefined,
  transport: Pick<typeof api, 'getConversation' | 'listConversations' | 'listAgents'> = api,
): Promise<void[]> {
  return Promise.all([
    client.prefetchQuery({
      queryKey: queryKeys.conversations.detail(conversationId, 100),
      queryFn: () => transport.getConversation(conversationId, 100),
    }),
    ...(projectId ? [
      client.prefetchQuery({
        queryKey: queryKeys.conversations.project(projectId),
        queryFn: () => transport.listConversations(projectId),
      }),
      client.prefetchQuery({
        queryKey: queryKeys.agents.project(projectId),
        queryFn: () => transport.listAgents(projectId),
      }),
    ] : []),
  ]);
}
