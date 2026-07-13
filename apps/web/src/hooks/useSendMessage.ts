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
      const previous = queryClient.getQueryData<AgentDetailDto>(["agent", agentId]);
      const optimistic: MessageDto = {
        id: `optimistic-user-${Date.now()}`,
        agentId,
        seq: Number.MAX_SAFE_INTEGER,
        role: "user",
        text: request.text,
        createdAt: new Date().toISOString(),
      };
      queryClient.setQueryData<AgentDetailDto>(["agent", agentId], (detail) =>
        detail ? { ...detail, messages: [...detail.messages, optimistic] } : detail,
      );
      return { previous };
    },
    onError: (_error, _request, context) => {
      if (agentId && context?.previous) {
        queryClient.setQueryData(["agent", agentId], context.previous);
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
