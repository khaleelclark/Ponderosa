import type { DecisionDto, WorkspaceNotificationDto } from "@ponderosa/core";

export type DecisionPrompt = Pick<
  DecisionDto,
  "id" | "mode" | "options" | "allowOther" | "status" | "runtimeAction"
> & Partial<Pick<DecisionDto, "projectId" | "conversationId" | "agentId" | "approvalScope">> & {
  question?: string;
  context?: string;
};

export interface DecisionResponse {
  skip?: true;
  optionId?: string;
  text?: string;
  content?: unknown;
}

export function notificationDecision(
  notification: Pick<WorkspaceNotificationDto, "title" | "body" | "decision" | "projectId" | "conversationId" | "agentId">,
): DecisionPrompt | undefined {
  if (!notification.decision) return undefined;
  return {
    ...notification.decision,
    projectId: notification.projectId,
    conversationId: notification.conversationId,
    agentId: notification.agentId,
    question: notification.title,
    context: notification.body,
  };
}

export function decisionAcceptsText(decision: DecisionPrompt): boolean {
  return decision.mode === "text" || decision.allowOther;
}

export function decisionTextActionLabel(decision: DecisionPrompt): string {
  return decision.mode === "text" ? "Answer" : "Something Else";
}

export function validateDecisionResponse(
  decision: DecisionPrompt,
  response: DecisionResponse,
): DecisionResponse | undefined {
  const text = response.text?.trim();
  if (text) return { text };
  if (response.optionId && decision.options.some((option) => option.id === response.optionId)) {
    return { optionId: response.optionId };
  }
  return undefined;
}
