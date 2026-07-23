import type { ResolveDecisionRequest } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

const DECISION_REFRESH_KEYS = [
  ["notifications"],
  ["decisions"],
  ["agent-work"],
  ["collaboration-chat"],
] as const;

export function useDecisionResponse(onSuccess?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ decisionId, response }: {
      decisionId: string;
      response: ResolveDecisionRequest;
    }) => api.respondDecision(decisionId, response),
    onSuccess: async () => {
      await Promise.all(
        DECISION_REFRESH_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      onSuccess?.();
    },
  });
}
