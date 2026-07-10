import type { MessageDto, SendMessageRequest, ThreadDetailDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export function useSendMessage(threadId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: SendMessageRequest) => {
      if (!threadId) {
        throw new Error("No thread selected");
      }
      return api.sendMessage(threadId, request);
    },
    onMutate: async (request) => {
      if (!threadId) {
        return undefined;
      }
      await queryClient.cancelQueries({ queryKey: ["thread", threadId] });
      const previous = queryClient.getQueryData<ThreadDetailDto>(["thread", threadId]);
      const optimistic: MessageDto = {
        id: `optimistic-user-${Date.now()}`,
        threadId,
        seq: Number.MAX_SAFE_INTEGER,
        role: "user",
        text: request.text,
        createdAt: new Date().toISOString(),
      };
      queryClient.setQueryData<ThreadDetailDto>(["thread", threadId], (detail) =>
        detail ? { ...detail, messages: [...detail.messages, optimistic] } : detail,
      );
      return { previous };
    },
    onError: (_error, _request, context) => {
      if (threadId && context?.previous) {
        queryClient.setQueryData(["thread", threadId], context.previous);
      }
    },
    onSettled: () => {
      if (threadId) {
        void queryClient.invalidateQueries({ queryKey: ["thread", threadId] });
        void queryClient.invalidateQueries({ queryKey: ["threads"] });
      }
    },
  });
}
