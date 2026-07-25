import type { ResolveDecisionRequest } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "../queryKeys";

const DECISION_REFRESH_KEYS = [
  queryKeys.notifications.all,
  queryKeys.decisions.all,
  queryKeys.agentWork.all,
  queryKeys.collaborationAll,
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
