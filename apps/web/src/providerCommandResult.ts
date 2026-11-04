import type { NativeGoalSnapshot } from "@ponderosa/core";

/** Preserve the full goal already returned by the authorized provider command. */
export function providerCommandResultText(result: { message?: string; goal?: NativeGoalSnapshot | null }): string | undefined {
  const goal = result.goal;
  if (!goal) return result.message;
  return `${goal.objective}\nStatus: ${goal.status}\nTokens: ${goal.tokensUsed} / ${goal.tokenBudget ?? "unlimited"}\nTime: ${goal.timeUsedSeconds}s`;
}

/** Keep long native results readable and reachable on desktop and mobile. */
export const providerCommandResultSx = {
  mx: 1.5, mt: 1, minWidth: 0, maxHeight: "min(40vh, 320px)", overflow: "auto",
  "& .MuiAlert-message": { minWidth: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" },
} as const;
