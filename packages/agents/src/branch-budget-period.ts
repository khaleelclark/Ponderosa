import type { TriggerBudgetPeriod } from "@ponderosa/core";

function branchBudgetEndsAt(period: TriggerBudgetPeriod, startedAt: string): string | undefined {
  if (period === "lifetime") return undefined;
  const start = new Date(startedAt);
  if (period === "month") {
    start.setUTCMonth(start.getUTCMonth() + 1);
    return start.toISOString();
  }
  start.setUTCDate(start.getUTCDate() + (period === "week" ? 7 : 1));
  return start.toISOString();
}

export { branchBudgetEndsAt };
