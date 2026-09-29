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
export function decisionResponseSummary(decision: Pick<DecisionDto, "mode" | "response">, choice: string): string {
  const verb = decision.response?.text !== undefined ? "You answered" : decision.mode === "approval" ? "Your approval response" : "You chose";
  return `${verb}${decision.mode === "approval" && decision.response?.text === undefined ? ":" : ""} ${choice}`;
}
