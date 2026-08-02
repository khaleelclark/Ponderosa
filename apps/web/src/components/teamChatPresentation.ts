import type { TeamOperationalEventDto } from "@ponderosa/core";

export type PresentedTeamOperationalEvent = TeamOperationalEventDto & {
  relatedLifecycleCount: number;
};

const OPERATION_PRIORITY: Record<TeamOperationalEventDto["kind"], number> = {
  request: 6,
  join: 5,
  run: 4,
  activation: 3,
  trigger: 2,
  organization: 1,
  decision: 0,
};

function sharesAgent(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const rightIds = new Set(right);
  return left.some(agentId => rightIds.has(agentId));
}

/**
 * One cancellation can terminally update a Request, Run, Activation, and Join
 * in the same authoritative transaction. Team Chat presents that canonical
 * lifecycle cluster once while retaining every underlying record elsewhere.
 */
export function coalesceTeamOperationalEvents(
  events: readonly TeamOperationalEventDto[],
): PresentedTeamOperationalEvent[] {
  const groups: PresentedTeamOperationalEvent[] = [];
  for (const event of events) {
    const groupIndex = event.kind === "decision"
      ? -1
      : groups.findIndex(group =>
          group.kind !== "decision" &&
          Boolean(group.operationGroupId) &&
          group.operationGroupId === event.operationGroupId &&
          group.state === event.state &&
          group.updatedAt === event.updatedAt &&
          sharesAgent(group.agentIds, event.agentIds),
        );
    if (groupIndex < 0) {
      groups.push({ ...event, relatedLifecycleCount: 1 });
      continue;
    }
    const group = groups[groupIndex]!;
    const preferred = OPERATION_PRIORITY[event.kind] > OPERATION_PRIORITY[group.kind]
      ? event
      : group;
    groups[groupIndex] = {
      ...preferred,
      agentIds: [...new Set([...group.agentIds, ...event.agentIds])],
      relatedLifecycleCount: group.relatedLifecycleCount + 1,
    };
  }
  return groups;
}
