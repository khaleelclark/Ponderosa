export async function settleDecisionResponse<T>(
  response: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await response();
  } catch {
    return undefined;
  }
}
import type { DecisionDto } from "@ponderosa/core";

/** Response wording follows the persisted response kind, never its prose. */
export function decisionResponseVerb(decision: Pick<DecisionDto, "mode" | "response">): string {
  return decision.response?.text !== undefined ? "Answered" : decision.mode === "approval" ? "Approval response to" : "Chose for";
}

export function decisionResponseChoice(decision: Pick<DecisionDto, "options" | "response">): string {
  if (decision.response?.optionId === "auto_allowed") return decision.response.text ?? "Response unavailable";
  return decision.options.find(option => option.id === decision.response?.optionId)?.label ?? decision.response?.text ?? "Response unavailable";
}

export function decisionResponseSummary(decision: Pick<DecisionDto, "mode" | "response">, choice: string, recipient: string): string {
  return `${decisionResponseVerb(decision)} ${recipient}: ${choice}`;
}
