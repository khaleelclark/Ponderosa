import type { DecisionDto, WorkspaceNotificationDto } from "@ponderosa/core";

export type DecisionPrompt = Pick<
  DecisionDto,
  "id" | "mode" | "options" | "allowOther" | "status"
> & {
  question?: string;
  context?: string;
};

export interface DecisionResponse {
  optionId?: string;
  text?: string;
}

export function notificationDecision(
  notification: Pick<WorkspaceNotificationDto, "title" | "body" | "decision">,
): DecisionPrompt | undefined {
  if (!notification.decision) return undefined;
  return {
    ...notification.decision,
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
