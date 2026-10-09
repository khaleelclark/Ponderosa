import type { AgentWorkItemDto, ReviewedTriggerDefinition, TriggerDefinitionDto } from "@ponderosa/core";
import { intervalSummary } from "../TriggerSourceFields";

export function reviewedDefinition(trigger: TriggerDefinitionDto): ReviewedTriggerDefinition {
  return {
    id: trigger.id, projectId: trigger.projectId, conversationId: trigger.conversationId,
    targetAgentId: trigger.targetAgentId ?? null, branchId: trigger.branchId ?? null,
    name: trigger.name, instructions: trigger.instructions, sourceKind: trigger.sourceKind,
    sourceConfig: trigger.sourceConfig, enabled: trigger.enabled, fullAccess: trigger.fullAccess,
    runBudget: trigger.runBudget ?? null,
  };
}

export function responsibilitySchedule(trigger: Pick<TriggerDefinitionDto, "sourceKind" | "sourceConfig">): string {
  const config = trigger.sourceConfig;
  if (trigger.sourceKind !== "schedule" || !("scheduleKind" in config)) return `${trigger.sourceKind} · manage in Automations`;
  if (config.scheduleKind === "cron") return `Cron ${config.expression} · ${config.timezone}`;
  if (config.scheduleKind === "interval") return `${intervalSummary(config.everyMs)} · starts ${config.startsAt} (UTC)`;
  return `Once · ${config.at} (UTC)`;
}

/** State labels only; authored text is never inspected to determine readiness. */
export function pineconeWorkLabel(item: AgentWorkItemDto, agentId: string): string {
  if (item.kind === "decision" && item.state === "pending") return "Needs your decision";
  if (item.kind === "request" && item.requesterAgentId === agentId && item.state === "completed") return "Result ready";
  if (item.kind === "join" && item.state === "satisfied") return "Results ready for review";
  if (item.kind === "join" && item.state === "open") return "Waiting for assigned work";
  if (item.state === "outcome_unknown") return "Outcome unconfirmed";
  return `${item.kind === "activation" ? "Wake-up" : item.kind} · ${item.state.replaceAll("_", " ")}`;
}
