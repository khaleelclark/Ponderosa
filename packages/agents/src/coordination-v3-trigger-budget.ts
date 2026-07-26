import type { TriggerRunBudgetDto } from "@ponderosa/core";

function triggerBudgetEndsAt(period: TriggerRunBudgetDto["period"], startedAt: string): string | undefined {
  if (period === "lifetime") return undefined;
  const start = new Date(startedAt);
  if (period === "month") {
    start.setUTCMonth(start.getUTCMonth() + 1);
    return start.toISOString();
  }
  start.setUTCDate(start.getUTCDate() + (period === "week" ? 7 : 1));
  return start.toISOString();
}

export { triggerBudgetEndsAt };
