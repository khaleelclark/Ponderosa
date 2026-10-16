import type { WorkspaceNotificationDto } from "@ponderosa/core";
import { markdownPreviewText } from "./markdownPreviewText.js";

/** Presentation of retained evidence only; never decide a work outcome here. */
export function attentionPresentation(item: WorkspaceNotificationDto) {
  const work = item.workContext;
  const resolution = item.resolution;
  const agent = item.agentTitle ?? resolution?.recipientTitle;
  const state = work?.state ?? resolution?.outcome;
  const task = work?.assignment ?? resolution?.assignment ?? item.contextPreview;
  const knownTask = task && !["Coordinated assignment", "Assignment description unavailable"].includes(task)
    ? markdownPreviewText(task).slice(0, 800) : undefined;
  const genericTitle = item.title === "A coordinated assignment needs a decision";
  const title = genericTitle ? `${agent ?? "Assigned work"} needs review` : item.title;
  const uncertainty = state === "outcome_unknown"
    ? "Ponderosa cannot confirm whether this work finished or what changes it made. Check its activity before retrying; retrying may duplicate changes."
    : work?.kind === "join"
      ? "This wait ended without the required results. That does not mean every related assignment failed."
      : resolution || work?.kind === "request"
          ? "This assignment needs review. Its earlier changes may still exist; check its activity before trying again."
          : item.kind === "decision"
            ? "This question is still open. Answer it to tell the Agent how to proceed."
            : work || item.category === "coordination" || item.category === "communication" || genericTitle
              ? "This notice does not establish whether the work finished or whether it made changes. Check the related activity before trying again."
              : undefined;
  const explanation = markdownPreviewText([item.body, work?.detail].filter(Boolean).join(" ")) || "No explanation was retained for this notice.";
  // A single state-backed warning replaces overlapping generic cause/safety prose.
  // Retain the full evidence separately for Details and the support report.
  const summary = state === "outcome_unknown"
    ? "Result unconfirmed. Check activity before retrying; retrying may duplicate changes."
    : explanation;
  const compactScope = item.conversationId
    ? `Chat: ${item.conversationTitle ?? `Name unavailable (${item.conversationId.slice(-8)})`}`
    : item.projectId ? `Project: ${item.projectLabel ?? `Name unavailable (${item.projectId.slice(-8)})`}` : "Ponderosa workspace";
  return {
    title,
    explanation,
    summary,
    compactScope,
    task: knownTask,
    taskUnavailableLabel: item.category === "coordination" || resolution
      ? "Assignment description unavailable." : undefined,
    uncertainty,
    detailWarning: state === "outcome_unknown" ? undefined : uncertainty,
    scopes: [
      item.projectId ? `Project: ${item.projectLabel ?? `Name unavailable (${item.projectId.slice(-8)})`}` : "Ponderosa workspace",
      item.conversationId ? `Chat: ${item.conversationTitle ?? `Name unavailable (${item.conversationId.slice(-8)})`}` : undefined,
      agent ? `Agent: ${agent}` : item.agentId ? `Agent: Name unavailable (${item.agentId.slice(-8)})` : undefined,
    ].filter((label): label is string => Boolean(label)),
    occurredAt: work?.occurredAt ?? item.createdAt,
    reference: `${work?.kind === "join" ? "Wait" : work?.kind === "activation" ? "Message delivery" : work?.kind === "request" || resolution ? "Assignment" : "Notice"} ${
      (work?.recordId ?? resolution?.requestId ?? item.id).slice(-12)}`,
    evidenceUnavailable: !work && !resolution && item.kind !== "decision"
      && (item.category === "coordination" || item.category === "communication" || genericTitle),
  };
}

export function attentionSupportReport(item: WorkspaceNotificationDto): string {
  const copy = attentionPresentation(item);
  return ["Ponderosa Support Report", `Issue: ${copy.title}`, ...copy.scopes,
    `When: ${copy.occurredAt}`, `Task: ${copy.task ?? "Description unavailable"}`,
    `What happened: ${copy.explanation}`, copy.uncertainty ? `What remains uncertain: ${copy.uncertainty}` : undefined,
    `Notification ID: ${item.id}`, item.projectId ? `Project ID: ${item.projectId}` : undefined,
    item.conversationId ? `Chat ID: ${item.conversationId}` : undefined,
    item.agentId ? `Agent ID: ${item.agentId}` : undefined,
    item.workContext ? `Work record: ${item.workContext.kind}:${item.workContext.recordId}` : undefined,
    item.workContext?.state ?? item.resolution?.outcome
      ? `Recorded outcome: ${item.workContext?.state ?? item.resolution?.outcome}` : undefined,
    item.resolution ? `Request ID: ${item.resolution.requestId}` : undefined,
    item.workContext?.traceId ?? item.resolution?.traceId
      ? `Trace ID: ${item.workContext?.traceId ?? item.resolution?.traceId}` : undefined,
    copy.evidenceUnavailable ? "Additional historical evidence was not retained." : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function isOpenAttention(item: WorkspaceNotificationDto): boolean {
  return (item.status ?? "open") === "open" && (
    item.kind === "decision" || item.kind === "operational" || item.severity === "attention" || item.severity === "urgent"
  );
}

export function isUnacknowledgedAction(item: WorkspaceNotificationDto): boolean {
  return isOpenAttention(item) && !item.acknowledgedAt;
}

export function visibleNotification(item: WorkspaceNotificationDto): boolean {
  return (item.status ?? "open") === "open";
}

export function isUnreadNotificationUpdate(item: WorkspaceNotificationDto): boolean {
  return visibleNotification(item) && !isOpenAttention(item) && !item.readAt;
}

export function notificationSummary(notifications: WorkspaceNotificationDto[]): {
  openActionCount: number;
  unacknowledgedActionCount: number;
  unreadUpdateCount: number;
} {
  return notifications.reduce((summary, item) => {
    if (isOpenAttention(item)) {
      summary.openActionCount += 1;
      if (!item.acknowledgedAt) summary.unacknowledgedActionCount += 1;
    }
    else if (isUnreadNotificationUpdate(item)) summary.unreadUpdateCount += 1;
    return summary;
  }, { openActionCount: 0, unacknowledgedActionCount: 0, unreadUpdateCount: 0 });
}

export function notificationOpenActionCount(
  notifications: WorkspaceNotificationDto[],
  summary?: { openActionCount: number },
): number {
  return summary?.openActionCount ?? notificationSummary(notifications).openActionCount;
}

/** A Project-scoped notification has no actionable destination after its
 * Project leaves the canonical Project collection. */
export function notificationsForAvailableProjects(
  notifications: WorkspaceNotificationDto[],
  projectIds: ReadonlySet<string>,
): WorkspaceNotificationDto[] {
  return notifications.filter(item =>
    !item.projectId || projectIds.has(item.projectId)
  );
}

export function scopedAttention(notifications: WorkspaceNotificationDto[], scope: {
  projectId?: string;
  conversationId?: string;
  agentId?: string;
} = {}): WorkspaceNotificationDto[] {
  return notifications.filter((item) => isOpenAttention(item)
    && (!scope.projectId || item.projectId === scope.projectId)
    && (!scope.conversationId
      || item.conversationId === scope.conversationId
      || item.conversationIds?.includes(scope.conversationId))
    && (!scope.agentId
      || item.agentId === scope.agentId
      || item.agentIds?.includes(scope.agentId)
      || (item.action?.kind === "open_agent" && item.action.targetId === scope.agentId)))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}
