import { promises as fs } from "node:fs";
import type { WorkspaceNotificationDto } from "@ponderosa/core";
import type {
  AgentStore,
  CommunicationAttentionActivationV3View,
  CoordinationAttentionCandidateV3View,
  CoordinationV3Store,
  WorkspaceStore,
} from "@ponderosa/agents";
import { AgentWorkProjection } from "./routes/agent-work.js";

interface OperationalNotificationsContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  publishWorkspaceSince(cursor: number): void;
}

export function createOperationalNotifications(context: OperationalNotificationsContext) {
  const { store, coordinationV3, workspace, publishWorkspaceSince } = context;
  const communicationAttentionActivations = (): CommunicationAttentionActivationV3View[] => {
    const pageSize = 500;
    const failures: CommunicationAttentionActivationV3View[] = [];
    let cursor: Pick<CommunicationAttentionActivationV3View, "updatedAt" | "id"> | undefined;
    for (;;) {
      const page = coordinationV3.communicationAttentionActivations(undefined, pageSize, cursor);
      failures.push(...page);
      if (page.length < pageSize) return failures;
      const last = page.at(-1)!;
      cursor = { updatedAt: last.updatedAt, id: last.id };
    }
  };

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
    const current = workspace.openOperationalNotification(dedupeKey);
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
    for (const failure of communicationAttentionActivations()) {
      const key = `communication-delivery:${failure.id}:${failure.terminalOutcome ?? failure.state}`;
      if (failure.supersededByRetry) continue;
      if (!["human_message", "urgent_message", "ordinary_message"].includes(failure.kind)) continue;
      // Intent, not priority or rendered text, keeps internal Collaboration out
      // of the operator notification tree.
      if (!failure.communicationEventId || failure.communicationIntent === "collaboration") continue;
      const conversationId = failure.scopeKey?.startsWith("conversation:")
        ? failure.scopeKey.slice("conversation:".length)
        : undefined;
      const conversation = conversationId ? store.getConversation(conversationId) : undefined;
      const outcomeUnknown = failure.state === "outcome_unknown";
      const requiredReplyExhausted = failure.terminalOutcome === "retry_exhausted";
      const issue = failure.lastDeliveryError
        ?? (failure.terminalOutcome ?? failure.state).replaceAll("_", " ");
      createOperationalNotification({
        dedupeKey: key,
        category: "communication",
        severity: "urgent",
        title: requiredReplyExhausted
          ? "Required reply recovery exhausted"
          : outcomeUnknown
          ? "Message outcome needs your review"
          : "Message delivery needs your help",
        body: requiredReplyExhausted
          ? `Ponderosa did not publish the required Chat reply after ${failure.deliveryFailures} provider Runs. Automatic recovery stopped. Review prior work before trying delivery again; retrying may duplicate work.`
          : outcomeUnknown
          ? "Ponderosa lost contact with the provider before it could confirm whether this message finished. Retrying may duplicate work if the provider completed it before the interruption."
          : `Ponderosa could not deliver this message after ${failure.deliveryFailures} ${failure.deliveryFailures === 1 ? "attempt" : "attempts"}. ${issue}`,
        projectId: failure.projectId,
        ...(conversation ? { conversationId: conversation.id } : {}),
        ...(failure.communicationEventId ? { communicationEventId: failure.communicationEventId } : {}),
        action: conversation
          ? { kind: "open_conversation", targetId: conversation.id }
          : { kind: "open_project", targetId: failure.projectId },
      });
    }
    workspace.forEachOpenOperationalNotification("communication-delivery:", (notification) => {
      const key = notification.dedupeKey;
      if (!key) return;
      const activationId = /^communication-delivery:([^:]+):/u.exec(key)?.[1];
      if (!activationId) return;
      const disposition = coordinationV3.terminalActivationDisposition(activationId);
      if (!disposition
        || (!disposition.supersededByRetry && disposition.state !== "cancelled")) return;
      resolveOperationalNotification(key);
    });
  };
  const agentWorkProjection = new AgentWorkProjection(store, coordinationV3, workspace);
  const reconcileCoordinationAttentionNotifications = (): void => {
    const retained = new Set<string>();
    const projects = new Map(
      store.listProjects().map((project) => [project.id, project]),
    );
    const pageSize = 200;
    let candidateCursor: Pick<
      CoordinationAttentionCandidateV3View,
      "updatedAt" | "kind" | "recordId"
    > | undefined;
    for (;;) {
      const candidates = coordinationV3.coordinationAttentionCandidates(
        pageSize,
        candidateCursor,
      );
      for (const candidate of candidates) {
        const project = projects.get(candidate.projectId);
        if (!project) continue;
        const focusId = `${candidate.kind}:${candidate.recordId}`;
        const inspector = agentWorkProjection.inspect({
          projectId: project.id,
          agentId: candidate.agentId,
          focusId,
          limit: 200,
        });
        const items = new Map(inspector.items.map((item) => [item.id, item]));
        const candidateRequest = candidate.kind === "request"
          ? coordinationV3.getRequest(candidate.recordId)
          : undefined;
        const pendingDirectRecovery = Boolean(
          candidateRequest?.recoverySuccessorRequestId &&
          ["failed", "outcome_unknown"].includes(candidateRequest.state) &&
          coordinationV3.requestRetryStatus(candidateRequest.id).successorState !== "completed",
        );
        const trace = inspector.traces.find((entry) =>
          entry.state === "attention" && entry.itemIds.includes(focusId))
          ?? (pendingDirectRecovery
            ? inspector.traces.find((entry) => entry.itemIds.includes(focusId))
            : undefined);
        if (!trace) continue;
        const related = trace.itemIds.flatMap((id) => items.get(id) ? [items.get(id)!] : []);
        if (related.some((item) => item.kind === "decision" && item.state === "pending")) continue;
        const focusedRecoveryRequest = pendingDirectRecovery
          ? items.get(focusId)
          : undefined;
        const failedRequest = focusedRecoveryRequest?.kind === "request"
          ? focusedRecoveryRequest
          : [...related].reverse().find((item) => {
          if (item.kind !== "request" || ![
            "blocked",
            "failed",
            "outcome_unknown",
            "expired",
            "recipient_unavailable",
          ].includes(item.state)) return false;
          return !(
            ["failed", "outcome_unknown"].includes(item.state) &&
            coordinationV3.requestRetryStatus(item.recordId).successorState === "completed"
          );
        });
        const failedJoin = [...related].reverse().find((item) => item.kind === "join"
          && ["impossible", "expired"].includes(item.state));
        const failedTrigger = [...related].reverse().find((item) => item.kind === "trigger"
          && item.state === "dead_lettered");
        // Plain user messages and internal context-rollover Runs have their own
        // recovery surfaces. They are not coordinated assignments merely
        // because their execution trace ended uncertain.
        if (!failedRequest && !failedJoin && !failedTrigger) continue;
        const responsibleAgentId = failedRequest?.recipientAgentId ?? failedRequest?.requesterAgentId ?? trace.agentIds[0];
        const agent = responsibleAgentId ? store.getAgent(responsibleAgentId) : undefined;
        const affectedAgents = trace.agentIds.flatMap((agentId) => {
          const affected = store.getAgent(agentId);
          return affected && !affected.archived ? [affected] : [];
        });
        const conversationIds = [...new Set(affectedAgents.map((affected) => affected.conversationId))].sort();
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
      if (candidates.length < pageSize) break;
      const last = candidates.at(-1)!;
      candidateCursor = {
        updatedAt: last.updatedAt,
        kind: last.kind,
        recordId: last.recordId,
      };
    }
    workspace.forEachOpenOperationalNotification("coordination-attention:", (notification) => {
      if (!notification.dedupeKey || retained.has(notification.dedupeKey)) return;
      resolveOperationalNotification(notification.dedupeKey);
    });
  };
  const reconcileContextRolloverFormatNotifications = (): void => {
    // Older builds incorrectly classified a rejected handoff format as an
    // operator decision. The retained provider context is still authoritative,
    // and corrected builds retry unusable output internally, so these notices
    // have no user-owned resolution and must disappear after deployment.
    workspace.forEachOpenOperationalNotification("context-rollover:", (notification) => {
      const key = notification.dedupeKey;
      if (!key || ![":handoff-missing", ":outcome-unknown"].some(
        (suffix) => key.endsWith(suffix),
      )) return;
      resolveOperationalNotification(key);
    });
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
          action: { kind: "open_agent", targetId: trigger.targetAgentId },
        });
      }
      if (trigger.sourceKind === "filesystem" && !trigger.enabled) retained.add(`trigger:${trigger.id}:watcher-failed`);
      if (trigger.sourceKind === "filesystem" && trigger.enabled) retained.add(`trigger:${trigger.id}:filesystem-persistence`);
    }
    workspace.forEachOpenOperationalNotification("trigger:", (notification) => {
      const key = notification.dedupeKey;
      if (!key) return;
      if (![":budget-held", ":watcher-failed", ":filesystem-persistence"].some((suffix) => key.endsWith(suffix))) return;
      if (!retained.has(key)) resolveOperationalNotification(key);
    });
  };
  const reconcileProjectDeletionOperationalNotifications = (): void => {
    for (const receipt of store.listPendingProjectDeletionReceipts()) {
      createOperationalNotification({
        dedupeKey: `project-deletion:${receipt.projectId}`,
        category: "system",
        severity: "attention",
        title: "Project deletion cleanup needs attention",
        body: `The Project was deleted, but filesystem cleanup is still retrying. ${receipt.lastError ?? "Retry deletion to continue cleanup."}`.slice(0, 1_000),
      });
    }
    workspace.forEachOpenOperationalNotification("project-deletion:", (notification) => {
      const key = notification.dedupeKey;
      if (!key) return;
      const projectId = key.slice("project-deletion:".length);
      const receipt = store.getProjectDeletionReceipt(projectId);
      if (receipt?.storageCleanupCompleted && receipt.draftCleanupCompleted) {
        resolveOperationalNotification(key);
      }
    });
  };

  return {
    agentWorkProjection,
    createOperationalNotification,
    projectWorkspaceNotificationKey,
    reconcileCommunicationFailureNotifications,
    reconcileContextRolloverFormatNotifications,
    reconcileCoordinationAttentionNotifications,
    reconcileProjectDeletionOperationalNotifications,
    reconcileProjectWorkspace,
    reconcileTriggerOperationalNotifications,
    resolveOperationalNotification,
  };
}
