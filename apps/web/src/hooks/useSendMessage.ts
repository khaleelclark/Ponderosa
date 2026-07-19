import type { MessageDto, SendMessageRequest, AgentDetailDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export function useSendMessage(agentId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: SendMessageRequest) => {
      if (!agentId) {
        throw new Error("No agent selected");
      }
      return api.sendMessage(agentId, request);
    },
    onMutate: async (request) => {
      if (!agentId) {
        return undefined;
      }
      await queryClient.cancelQueries({ queryKey: ["agent", agentId] });
      const previous = queryClient.getQueriesData<AgentDetailDto>({ queryKey: ["agent", agentId] });
      const optimistic: MessageDto = {
        id: `optimistic-user-${Date.now()}`,
        agentId,
        seq: Number.MAX_SAFE_INTEGER,
        role: "user",
        text: request.text,
        createdAt: new Date().toISOString(),
      };
      queryClient.setQueriesData<AgentDetailDto>({ queryKey: ["agent", agentId] }, (detail) =>
        detail ? { ...detail, messages: [...detail.messages, optimistic] } : detail,
      );
      return { previous };
    },
    onError: (_error, _request, context) => {
      if (agentId && context?.previous) {
        for (const [queryKey, value] of context.previous) queryClient.setQueryData(queryKey, value);
      }
    },
    onSettled: () => {
      if (agentId) {
        void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
        void queryClient.invalidateQueries({ queryKey: ["agents"] });
      }
    },
  });
}
