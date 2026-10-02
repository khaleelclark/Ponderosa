import type { WorkspaceNotificationDto } from "@ponderosa/core";

/** Resolve an issue to the canonical technical record that best explains it. */
export function notificationTechnicalFocusId(item: WorkspaceNotificationDto): string | undefined {
  if (item.workContext) return `${item.workContext.kind}:${item.workContext.recordId}`;
  if (item.resolution?.requestId) return `request:${item.resolution.requestId}`;
  if (item.decision?.id) return `decision:${item.decision.id}`;
  const triggerId = /^trigger:(.+):(?:budget-held|watcher-failed|filesystem-persistence)$/u.exec(item.dedupeKey ?? "")?.[1];
  if (triggerId) return `trigger:${triggerId}`;
  return item.communicationEventId;
}
