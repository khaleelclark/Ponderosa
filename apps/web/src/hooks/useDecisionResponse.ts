import type { AllChatPageDto, ConversationDecisionEventDto, DecisionDto, ResolveDecisionRequest, WorkspaceNotificationPageDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { ApiRequestError } from "../api/types";
import type { DecisionPrompt } from "../decisions";
import { queryKeys } from "../queryKeys";

const DECISION_REFRESH_KEYS = [
  queryKeys.notifications.all,
  queryKeys.decisions.all,
  queryKeys.agentWork.all,
  queryKeys.agents.detailAll,
  queryKeys.agents.healthAll,
  queryKeys.workspaceDirectory.all,
  queryKeys.collaborationAll,
  queryKeys.conversations.detailAll,
  queryKeys.allChatAll,
] as const;

export function useDecisionResponse(onSuccess?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async ({ decision, response }: {
      decision: DecisionPrompt;
      response: ResolveDecisionRequest;
    }) => {
      try {
        // ponytail: bound confirmation to 15s plus one 10s canonical read;
        // retry uses the existing idempotent response route, never a new queue.
        const saved = await api.respondDecision(decision.id, response, AbortSignal.timeout(15_000));
        if (saved?.id !== decision.id || saved.status === "pending") throw new Error("Decision save returned no confirmed outcome.");
        return saved;
      } catch (error) {
        const approval = decision.mode === "approval" || decision.approvalScope || decision.runtimeAction;
        if (error instanceof ApiRequestError && (approval || (error.status < 500 && error.status !== 409))) throw error;
        const uncertain = "Connection lost. Saving could not be confirmed. Your response is kept; try again.";
        if (!decision.projectId && !decision.agentId && !decision.conversationId) throw new Error(uncertain);
        let current: DecisionDto | undefined;
        try {
          current = (await api.listDecisions({ projectId: decision.projectId, agentId: decision.agentId, conversationId: decision.conversationId }, AbortSignal.timeout(10_000)))
            .find(item => item.id === decision.id);
        } catch { throw new Error(uncertain); }
        if (current && current.status !== "pending") {
          if (current.status === "resolved" && (approval || current.approvalScope || current.runtimeAction)) {
            throw new Error("Your response is recorded, but completion could not be confirmed. Retry this Decision response.");
          }
          return current;
        }
        if (error instanceof ApiRequestError) throw error;
        throw new Error(current ? "This question is still pending. Your response is kept; try again." : uncertain);
      }
    },
    onSuccess: decision => {
      const update = <T extends { decision: DecisionDto }>(items: T[]) => items.map(item => item.decision.id === decision.id ? { ...item, decision } : item);
      // Cancel reads started before the save before replacing their old data.
      for (const queryKey of [queryKeys.decisions.all, queryKeys.agents.detailAll, queryKeys.conversations.detailAll, queryKeys.allChatAll, queryKeys.notifications.all]) {
        void queryClient.cancelQueries({ queryKey });
      }
      queryClient.setQueriesData<DecisionDto[]>({ queryKey: queryKeys.decisions.all }, current => current?.map(item => item.id === decision.id ? decision : item));
      for (const queryKey of [queryKeys.agents.detailAll, queryKeys.conversations.detailAll]) {
        queryClient.setQueriesData<{ decisionEvents?: ConversationDecisionEventDto[] }>({ queryKey }, current => current?.decisionEvents ? { ...current, decisionEvents: update(current.decisionEvents) } : current);
      }
      queryClient.setQueriesData<AllChatPageDto>({ queryKey: queryKeys.allChatAll }, current => current?.decisions ? { ...current, decisions: update(current.decisions) } : current);
      queryClient.setQueryData<WorkspaceNotificationPageDto>(queryKeys.notifications.all, current => {
        if (!current) return current;
        const closing = current.items.filter(item => item.decision?.id === decision.id && (item.status ?? "open") === "open");
        if (!closing.length) return current;
        return { ...current, items: current.items.map(item => item.decision?.id === decision.id ? { ...item, decision, status: "resolved", resolvedAt: decision.updatedAt } : item),
          openActionCount: Math.max(0, current.openActionCount - closing.length), unacknowledgedActionCount: Math.max(0, current.unacknowledgedActionCount - closing.filter(item => !item.acknowledgedAt).length) };
      });
      void Promise.allSettled(
        DECISION_REFRESH_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      onSuccess?.();
    },
  });
}
