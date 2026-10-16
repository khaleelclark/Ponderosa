import type { WorkspaceNotificationDto } from "@ponderosa/core";

/** Resolve an issue to the canonical technical record that best explains it. */
export function notificationTechnicalFocusId(item: WorkspaceNotificationDto): string | undefined {
  if (item.workContext) return `${item.workContext.kind}:${item.workContext.recordId}`;
  if (item.resolution?.requestId) return `request:${item.resolution.requestId}`;
  if (item.decision?.id) return `decision:${item.decision.id}`;
  return item.communicationEventId;
}
