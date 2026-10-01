import type { SendMessageRequest } from "@ponderosa/core";
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
    // Composer owns the immediate, explicitly pending presentation. Do not
    // fabricate MessageDto records or roll back SSE updates on a send failure.
    onSettled: async (_data, _error, { agentId }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.detailPrefix(agentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
    },
  });
}
