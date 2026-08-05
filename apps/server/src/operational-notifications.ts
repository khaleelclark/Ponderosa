import { promises as fs } from "node:fs";
import type { WorkspaceNotificationDto } from "@ponderosa/core";
import type { AgentStore, CoordinationV3Store, WorkspaceStore } from "@ponderosa/agents";
import { AgentWorkProjection } from "./routes/agent-work.js";

interface OperationalNotificationsContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  publishWorkspaceSince(cursor: number): void;
}

export function createOperationalNotifications(context: OperationalNotificationsContext) {
  const { store, coordinationV3, workspace, publishWorkspaceSince } = context;

  const createOperationalNotification = (input: {
    dedupeKey: string;
    category: "communication" | "provider" | "trigger" | "budget" | "coordination" | "decision" | "system";
    severity: "info" | "attention" | "urgent";
    title: string;
    body: string;
    projectId?: string;
    conversationId?: string;
    conversationIds?: string[];
    agentId?: string;
    agentIds?: string[];
    action?: WorkspaceNotificationDto["action"];
    resolution?: WorkspaceNotificationDto["resolution"];
  }): WorkspaceNotificationDto => {
    const cursor = workspace.cursor();
    const notification = workspace.createNotification({ kind: "operational", status: "open", ...input }, input.severity !== "info");
    publishWorkspaceSince(cursor);
    return notification;
  };
  const resolveOperationalNotification = (dedupeKey: string): void => {
    const current = workspace.listNotifications().find((item) => item.dedupeKey === dedupeKey && (item.status ?? "open") === "open");
    if (!current) return;
    const cursor = workspace.cursor();
    workspace.setNotificationStatus(current.id, "resolved");
    publishWorkspaceSince(cursor);
  };
  const projectWorkspaceNotificationKey = (projectId: string): string =>
    `project:${projectId}:workspace-unavailable`;
  const projectWorkspaceIssue = async (project: { hostPath: string }): Promise<string | undefined> => {
    try {
      const metadata = await fs.stat(project.hostPath);
      return metadata.isDirectory()
        ? undefined
        : `The Project working folder ${project.hostPath} is not a directory.`;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return `The Project working folder ${project.hostPath} is unavailable. ${detail}`;
    }
  };
  const reconcileProjectWorkspace = async (
    project: { id: string; hostPath: string },
    agent: { id: string; conversationId?: string },
  ): Promise<string | undefined> => {
    const issue = await projectWorkspaceIssue(project);
    const notificationKey = projectWorkspaceNotificationKey(project.id);
    if (!issue) {
      resolveOperationalNotification(notificationKey);
      return undefined;
    }
    createOperationalNotification({
      dedupeKey: notificationKey,
      category: "system",
      severity: "urgent",
      title: "Project folder is unavailable",
      body: `${issue} Restore the folder before retrying this message. Ponderosa did not start the provider and will not retry automatically.`,
      projectId: project.id,
      ...(agent.conversationId ? { conversationId: agent.conversationId } : {}),
      agentId: agent.id,
      action: { kind: "open_project", targetId: project.id },
    });
    return issue;
  };
  const reconcileCommunicationFailureNotifications = (): void => {
    for (const failure of coordinationV3.terminalActivations(undefined, 500)) {
      const key = `communication-delivery:${failure.id}:${failure.outcome}`;
      if (failure.supersededByRetry || failure.state === "cancelled") continue;
      if (!["human_message", "urgent_message", "ordinary_message"].includes(failure.kind)) continue;
      // Intent, not priority or rendered text, keeps internal Collaboration out
      // of the operator notification tree.
      if (!failure.communicationEventId || failure.communicationIntent === "collaboration") continue;
      const conversationId = failure.scopeKey?.startsWith("conversation:")
        ? failure.scopeKey.slice("conversation:".length)
        : undefined;
      const conversation = conversationId ? store.getConversation(conversationId) : undefined;
      const issue = failure.lastDeliveryError ?? failure.outcome.replaceAll("_", " ");
      createOperationalNotification({
        dedupeKey: key,
        category: "communication",
        severity: "urgent",
        title: "Message delivery needs your help",
        body: `Ponderosa could not deliver this message after ${failure.deliveryFailures} ${failure.deliveryFailures === 1 ? "attempt" : "attempts"}. ${issue}`,
        projectId: failure.projectId,
        ...(conversation ? { conversationId: conversation.id } : {}),
        ...(failure.communicationEventId ? { communicationEventId: failure.communicationEventId } : {}),
        action: conversation
          ? { kind: "open_conversation", targetId: conversation.id }
          : { kind: "open_project", targetId: failure.projectId },
      });
    }
    for (const notification of workspace.listNotifications()) {
      const key = notification.dedupeKey;
      if (!key?.startsWith("communication-delivery:")
        || (notification.status ?? "open") !== "open") continue;
      const activationId = /^communication-delivery:([^:]+):/u.exec(key)?.[1];
      if (!activationId) continue;
      const disposition = coordinationV3.terminalActivationDisposition(activationId);
      if (!disposition
        || (!disposition.supersededByRetry && disposition.state !== "cancelled")) continue;
      resolveOperationalNotification(key);
    }
  };
  const agentWorkProjection = new AgentWorkProjection(store, coordinationV3, workspace);
  let lastCoordinationAttentionReconciliationAt = 0;
  const reconcileCoordinationAttentionNotifications = (): void => {
    const now = Date.now();
    if (now - lastCoordinationAttentionReconciliationAt < 5_000) return;
    lastCoordinationAttentionReconciliationAt = now;
    const retained = new Set<string>();
    const communicationFailureActivationIds = new Set(coordinationV3.terminalActivations(undefined, 500)
      .filter((failure) => failure.communicationEventId && failure.communicationIntent !== "collaboration"
        && ["human_message", "urgent_message", "ordinary_message"].includes(failure.kind))
      .map((failure) => failure.id));
    for (const project of store.listProjects()) {
      const inspector = agentWorkProjection.inspect({ projectId: project.id, limit: 200 });
      const items = new Map(inspector.items.map((item) => [item.id, item]));
      for (const trace of inspector.traces.filter((candidate) => candidate.state === "attention")) {
        const related = trace.itemIds.flatMap((id) => items.get(id) ? [items.get(id)!] : []);
        if (related.some((item) => item.kind === "decision" && item.state === "pending")) continue;
        if (related.some((item) => item.kind === "activation" && communicationFailureActivationIds.has(item.recordId))) continue;
        const failedRequest = [...related].reverse().find((item) => item.kind === "request"
          && ["blocked", "failed", "outcome_unknown", "expired", "recipient_unavailable"].includes(item.state));
        const responsibleAgentId = failedRequest?.recipientAgentId ?? failedRequest?.requesterAgentId ?? trace.agentIds[0];
        const agent = responsibleAgentId ? store.getAgent(responsibleAgentId) : undefined;
        const affectedAgents = trace.agentIds.flatMap((agentId) => {
          const affected = store.getAgent(agentId);
          return affected && !affected.archived ? [affected] : [];
        });
        const conversationIds = [...new Set(affectedAgents.flatMap((affected) => affected.conversationIds))].sort();
        const requestRecord = failedRequest ? coordinationV3.getRequest(failedRequest.recordId) : undefined;
        const requestPayload = requestRecord?.payload && typeof requestRecord.payload === "object" && !Array.isArray(requestRecord.payload)
          ? requestRecord.payload as Record<string, unknown>
          : undefined;
        const rawAssignmentValue = [requestPayload?.text, requestPayload?.assignment, requestPayload?.task, requestPayload?.request, requestPayload?.prompt].find((value): value is string => typeof value === "string");
        const rawAssignment = rawAssignmentValue?.replace(/\s+/gu, " ").trim() ?? "";
        const assignment = rawAssignment
          ? `${rawAssignment.slice(0, 220)}${rawAssignment.length > 220 ? "…" : ""}`
          : "Coordinated assignment";
        const recipient = failedRequest?.recipientAgentId ? store.getAgent(failedRequest.recipientAgentId) : undefined;
        const outcome = failedRequest?.state ?? "unresolved";
        const outcomeExplanation = outcome === "outcome_unknown"
          ? "Ponderosa could not confirm whether the Agent finished or published a result."
          : outcome === "recipient_unavailable"
            ? "The assigned Agent is no longer available to finish this work."
            : outcome === "blocked"
              ? "The Agent reported that the assignment is blocked."
              : outcome === "expired"
                ? "The assignment reached its deadline without a result."
                : outcome === "failed"
                  ? "The Agent reported that the assignment failed."
                  : "The coordinated workflow could not finish automatically.";
        const key = `coordination-attention:${trace.id}:${failedRequest?.recordId ?? "trace"}`;
        retained.add(key);
        createOperationalNotification({
          dedupeKey: key,
          category: "coordination",
          severity: "attention",
          title: recipient ? `${recipient.title}'s assignment needs a decision` : "A coordinated assignment needs a decision",
          body: `${outcomeExplanation} Review the current state before deciding whether to retry it.`,
          projectId: project.id,
          ...(conversationIds[0] ? { conversationId: conversationIds[0], conversationIds } : {}),
          ...(affectedAgents.length ? { agentIds: affectedAgents.map((affected) => affected.id) } : {}),
          ...(agent ? { agentId: agent.id, action: { kind: "open_agent" as const, targetId: agent.id } } : {
            action: { kind: "open_project" as const, targetId: project.id },
          }),
          ...(failedRequest && recipient ? {
            resolution: {
              kind: "coordination_request" as const,
              traceId: trace.id,
              requestId: failedRequest.recordId,
              recipientAgentId: recipient.id,
              recipientTitle: recipient.title,
              assignment,
              outcome,
              retryAvailable: ["blocked", "expired", "outcome_unknown", "failed", "recipient_unavailable"].includes(outcome),
            },
          } : {}),
        });
      }
    }
    for (const notification of workspace.listNotifications()) {
      if (!notification.dedupeKey?.startsWith("coordination-attention:")) continue;
      if ((notification.status ?? "open") !== "open" || retained.has(notification.dedupeKey)) continue;
      resolveOperationalNotification(notification.dedupeKey);
    }
  };
  const reconcileTriggerOperationalNotifications = (): void => {
    const triggers = coordinationV3.listTriggerDefinitions();
    const retained = new Set<string>();
    for (const trigger of triggers) {
      if (trigger.budgetState?.held) {
        const key = `trigger:${trigger.id}:budget-held`;
        retained.add(key);
        createOperationalNotification({
          dedupeKey: key,
          category: "budget",
          severity: "attention",
          title: `${trigger.name} reached its automatic Run budget`,
          body: `${trigger.budgetState.used} of ${trigger.runBudget!.limit + trigger.budgetState.allowance} ${trigger.runBudget!.period === "lifetime" ? "lifetime automatic Runs" : `automatic Runs per ${trigger.runBudget!.period}`} have been used. New outside events remain queued until the period resets or you allow more Runs.`,
          projectId: trigger.projectId,
          conversationId: trigger.conversationId,
          action: { kind: "open_agent", targetId: trigger.agentId },
        });
      }
      if (trigger.sourceKind === "filesystem" && !trigger.enabled) retained.add(`trigger:${trigger.id}:watcher-failed`);
      if (trigger.sourceKind === "filesystem" && trigger.enabled) retained.add(`trigger:${trigger.id}:filesystem-persistence`);
    }
    for (const notification of workspace.listNotifications()) {
      const key = notification.dedupeKey;
      if (!key?.startsWith("trigger:") || (notification.status ?? "open") !== "open") continue;
      if (![":budget-held", ":watcher-failed", ":filesystem-persistence"].some((suffix) => key.endsWith(suffix))) continue;
      if (!retained.has(key)) resolveOperationalNotification(key);
    }
  };
  const reconcileProjectDeletionOperationalNotifications = (): void => {
    for (const receipt of store.listPendingProjectDeletionReceipts()) {
      createOperationalNotification({
        dedupeKey: `project-deletion:${receipt.projectId}`,
        category: "system",
        severity: "attention",
        title: "Project deletion cleanup needs attention",
        body: `The Project was deleted, but filesystem cleanup is still retrying. ${receipt.lastError ?? "Retry deletion to continue cleanup."}`.slice(0, 1_000),
        projectId: receipt.projectId,
      });
    }
    for (const notification of workspace.listNotifications()) {
      const key = notification.dedupeKey;
      if (!key?.startsWith("project-deletion:") || (notification.status ?? "open") !== "open") continue;
      const projectId = key.slice("project-deletion:".length);
      const receipt = store.getProjectDeletionReceipt(projectId);
      if (receipt?.storageCleanupCompleted) resolveOperationalNotification(key);
    }
  };

  return {
    agentWorkProjection,
    createOperationalNotification,
    projectWorkspaceNotificationKey,
    reconcileCommunicationFailureNotifications,
    reconcileCoordinationAttentionNotifications,
    reconcileProjectDeletionOperationalNotifications,
    reconcileProjectWorkspace,
    reconcileTriggerOperationalNotifications,
    resolveOperationalNotification,
  };
}
