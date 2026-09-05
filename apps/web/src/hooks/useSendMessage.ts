import type { MessageDto, SendMessageRequest, AgentDetailDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "../queryKeys";

export interface SendMessageAttempt {
  agentId: string;
  request: SendMessageRequest;
}

export function useSendMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ agentId, request }: SendMessageAttempt) =>
      api.sendMessage(agentId, request),
    onMutate: async ({ agentId, request }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.agents.detailPrefix(agentId) });
      const previous = queryClient.getQueriesData<AgentDetailDto>({ queryKey: queryKeys.agents.detailPrefix(agentId) });
      const optimistic: MessageDto = {
        id: `optimistic-user-${Date.now()}`,
        agentId,
        seq: Number.MAX_SAFE_INTEGER,
        role: "user",
        text: request.text,
        createdAt: new Date().toISOString(),
      };
      queryClient.setQueriesData<AgentDetailDto>({ queryKey: queryKeys.agents.detailPrefix(agentId) }, (detail) =>
        detail ? { ...detail, messages: [...detail.messages, optimistic] } : detail,
      );
      return { previous };
    },
    onError: (_error, _attempt, context) => {
      if (context?.previous) {
        for (const [queryKey, value] of context.previous) queryClient.setQueryData(queryKey, value);
      }
    },
    onSettled: (_data, _error, { agentId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detailPrefix(agentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
    },
  });
}
