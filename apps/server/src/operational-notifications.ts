import { promises as fs } from "@ponderosa/native-host/fs";
import { outcomeCauseExplanation, type WorkspaceNotificationDto } from "@ponderosa/core";
import type {
  AgentStore,
  CommunicationAttentionActivationV3View,
  CoordinationAttentionCandidateV3View,
  CoordinationV3Store,
  WorkspaceStore,
} from "@ponderosa/agents";
import { AgentWorkProjection } from "./routes/agent-work.js";
import { setImmediate } from "node:timers/promises";

interface OperationalNotificationsContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  publishWorkspaceSince(cursor: number): void;
  logError(meta: Record<string, unknown>, message: string): void;
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
    informational?: boolean;
    renewAfterRecovery?: boolean;
    push?:boolean;
    branchId?:string;
    branchExecutionId?:string;
    category: "communication" | "provider" | "coordination" | "decision" | "system";
    severity: "info" | "attention" | "urgent";
    title: string;
    body: string;
    contextPreview?: string;
    workContext?: WorkspaceNotificationDto["workContext"];
    projectId?: string;
    conversationId?: string;
    conversationIds?: string[];
    agentId?: string;
    agentIds?: string[];
    action?: WorkspaceNotificationDto["action"];
    resolution?: WorkspaceNotificationDto["resolution"];
  }): WorkspaceNotificationDto => {
    const cursor = workspace.cursor();
    const { informational, push, renewAfterRecovery, ...notificationInput } = input;
    const notification = workspace.createNotification({ kind: informational ? "information" : "operational", status: "open", ...notificationInput }, push ?? input.severity !== "info", renewAfterRecovery);
    publishWorkspaceSince(cursor);
    return notification;
  };
  const resolveOperationalNotification = (dedupeKey: string): void => {
    const current = workspace.getNotificationByDedupeKey(dedupeKey);
    if (!current || !["operational", "information"].includes(current.kind) || (current.status ?? "open") !== "open") return;
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
      const agent = store.getAgent(failure.agentId);
      const communication = store.getCommunicationEvent(failure.projectId, failure.communicationEventId);
      const excerpt = communication?.text.replace(/\s+/gu, " ").trim().slice(0, 120);
      const outcomeUnknown = failure.state === "outcome_unknown";
      const requiredReplyExhausted = failure.terminalOutcome === "retry_exhausted";
      const issue = failure.lastDeliveryError
        ?? (failure.terminalOutcome ?? failure.state).replaceAll("_", " ");
      createOperationalNotification({
        dedupeKey: key,
        category: "communication",
        severity: "urgent",
        title: `${agent?.title ?? "Agent"} · ${requiredReplyExhausted ? "reply needs review" : outcomeUnknown ? "message result needs review" : "message delivery needs help"}`,
        body: requiredReplyExhausted
          ? `Ponderosa did not publish the required Chat reply after ${failure.deliveryFailures} Agent ${failure.deliveryFailures === 1 ? "attempt" : "attempts"}. Review the Agent's work before retrying; earlier work may exist.`
          : outcomeUnknown
          ? "Ponderosa cannot confirm this message's result. Review the Agent's work before retrying; earlier changes may exist."
          : `Ponderosa could not deliver this message after ${failure.deliveryFailures} ${failure.deliveryFailures === 1 ? "attempt" : "attempts"}. ${issue}`,
        ...(excerpt ? { contextPreview: excerpt } : {}),
        workContext: { kind: "activation", recordId: failure.id,
          state: failure.terminalOutcome ?? failure.state, occurredAt: failure.updatedAt,
          ...(excerpt ? { assignment: excerpt } : {}) },
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
  const dirtyCoordinationProjects = new Set<string>();
  let coordinationNotificationsStopped = false;
  let coordinationNotificationWork: Promise<void> | undefined;
  function* coordinationAttentionNotifications(projectId?: string): Generator<void> {
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
        yield;
        if (projectId && candidate.projectId !== projectId) continue;
        const project = store.getProject(candidate.projectId);
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
        // The exact Request/Join owns the outcome; a graph's display state or
        // unrelated completed Run cannot establish recovery.
        const trace = inspector.traces.find(entry => entry.itemIds.includes(focusId));
        const failedWork = items.get(focusId);
        if (!trace || !failedWork || !["blocked", "failed", "outcome_unknown", "expired", "recipient_unavailable", "impossible"].includes(failedWork.state)) continue;
        if (trace.itemIds.some(id => items.get(id)?.kind === "decision" && items.get(id)?.state === "pending")) continue;
        const retry = candidateRequest ? coordinationV3.requestRetryStatus(candidateRequest.id) : undefined;
        if ((retry?.recoveryState ?? retry?.successorState) === "completed") continue;
        if (retry?.successorRequestId) continue;
        const join = candidate.kind === "join" ? coordinationV3.getJoin(candidate.recordId) : undefined;
        const ownerId = candidateRequest?.requesterAgentId ?? join?.ownerAgentId;
        const owner = ownerId ? store.getAgent(ownerId) : undefined;
        const ownerConversation = candidateRequest?.conversationId ?? join?.conversationId;
        const internallyOwned = owner?.projectId === project.id && (!ownerConversation || owner.conversationId === ownerConversation);
        // The canonical requester/Join wake handles this failure. Only a failed
        // explicit recovery or missing owner needs an operator's intervention.
        const operatorRecovery = candidateRequest ? coordinationV3.requestIsOperatorRecovery(candidateRequest.id) : false;
        if (internallyOwned && !operatorRecovery) continue;
        const failedRequest = failedWork.kind === "request" ? failedWork : undefined;
        const responsibleAgentId = failedRequest?.recipientAgentId ?? failedRequest?.requesterAgentId
          ?? failedWork.agentIds[0] ?? trace.agentIds[0];
        const agent = responsibleAgentId ? store.getAgent(responsibleAgentId) : undefined;
        const affectedAgents = trace.agentIds.flatMap((agentId) => {
          const affected = store.getAgent(agentId);
          return affected ? [affected] : [];
        });
        const requestRecord = failedRequest ? coordinationV3.getRequest(failedRequest.recordId) : undefined;
        const conversationIds = [...new Set([
          requestRecord?.conversationId,
          ...affectedAgents.map((affected) => affected.conversationId),
        ].filter((id): id is string => Boolean(id)))].sort();
        const primaryConversationId = requestRecord?.conversationId
          ?? agent?.conversationId ?? conversationIds[0];
        const requestPayload = requestRecord?.payload && typeof requestRecord.payload === "object" && !Array.isArray(requestRecord.payload)
          ? requestRecord.payload as Record<string, unknown>
          : undefined;
        const rawAssignmentValue = [requestPayload?.text, requestPayload?.assignment, requestPayload?.task, requestPayload?.request, requestPayload?.prompt,
          typeof requestRecord?.payload === "string" ? requestRecord.payload : undefined].find((value): value is string => typeof value === "string");
        const rawAssignment = rawAssignmentValue?.replace(/\s+/gu, " ").trim() ?? "";
        const assignment = rawAssignment
          ? `${rawAssignment.slice(0, 220)}${rawAssignment.length > 220 ? "…" : ""}`
          : "Assignment description unavailable";
        const recipient = failedRequest?.recipientAgentId ? store.getAgent(failedRequest.recipientAgentId) : undefined;
        const outcome = failedWork.state;
        const lifecycle = failedRequest ? coordinationV3.requestLifecycleDetails({
          projectId: project.id,
          recordId: failedRequest.recordId,
        }) : undefined;
        const cause = [...(lifecycle?.updates ?? [])].reverse().find(update => update.kind === "outcome_unknown")?.outcomeCause;
        const terminalUpdate = [...(lifecycle?.updates ?? [])].reverse().find(update => update.resultingState === outcome);
        const detail = terminalUpdate?.text?.replace(/\s+/gu, " ").trim().slice(0, 800);
        const outcomeExplanation = outcome === "outcome_unknown"
          ? outcomeCauseExplanation(cause ?? { code: "cause_unavailable" })
          : failedWork.kind === "join"
            ? outcome === "expired"
              ? "The wait for required assignment results reached its deadline. Related work may already be complete."
              : "The required combination of assignment results could no longer be collected. Related work may already be complete."
          : outcome === "recipient_unavailable"
            ? "The assigned Agent is no longer available to finish this work."
            : outcome === "blocked"
              ? "The Agent reported that the assignment is blocked."
              : outcome === "expired"
                ? "The assignment reached its deadline without a result."
                : outcome === "failed"
                  ? "The Agent reported that the assignment failed."
                  : "The coordinated workflow could not finish automatically.";
        const key = `coordination-attention:${failedWork.kind}:${failedWork.recordId}`;
        createOperationalNotification({
          dedupeKey: key,
          category: "coordination",
          severity: "attention",
          title: operatorRecovery ? "Assignment recovery needs your review" : "Assignment has no available recovery owner",
          body: operatorRecovery
            ? "The recovery attempt did not finish. Review its activity before deciding whether to repeat work."
            : `${outcomeExplanation} Review the activity and choose who should continue this work.`,
          ...(rawAssignment ? { contextPreview: assignment.slice(0, 120) } : {}),
          workContext: {
            kind: failedWork.kind as "request" | "join", recordId: failedWork.recordId,
            traceId: trace.id, state: outcome, occurredAt: terminalUpdate?.createdAt ?? failedWork.updatedAt,
            ...(detail && outcome !== "outcome_unknown" ? { detail } : {}),
            ...(rawAssignment ? { assignment } : {}),
          },
          projectId: project.id,
          ...(primaryConversationId ? { conversationId: primaryConversationId, conversationIds } : {}),
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
              retryAvailable: Boolean(requestRecord?.requesterAgentId
                && store.getAgent(requestRecord.requesterAgentId)
                && ["blocked", "expired", "outcome_unknown", "failed", "recipient_unavailable"].includes(outcome)),
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
    // A yielded pass may have observed different revisions. Let its queued
    // follow-up finish before resolving notices from an incomplete retained set.
    if (coordinationNotificationsStopped || (projectId && dirtyCoordinationProjects.has(projectId))) return;
    const retained: WorkspaceNotificationDto[] = [];
    workspace.forEachCoordinationNotification(notification => {
      if (!projectId || notification.projectId === projectId) retained.push(notification);
    });
    for (const notification of retained) {
      yield;
      if (coordinationNotificationsStopped || (projectId && dirtyCoordinationProjects.has(projectId))) return;
      const work = notification.workContext;
      let resolved = false, internal = !work;
      if (work?.kind === "request") {
        const request = coordinationV3.getRequest(work.recordId);
        const retry = request ? coordinationV3.requestRetryStatus(request.id) : undefined;
        resolved = !request || ["completed", "cancelled"].includes(request.state) || (retry?.recoveryState ?? retry?.successorState) === "completed";
        const owner = request?.requesterAgentId ? store.getAgent(request.requesterAgentId) : undefined;
        internal = Boolean(retry?.successorRequestId
          || (request && !coordinationV3.requestIsOperatorRecovery(request.id) && owner?.projectId === request.projectId && (!request?.conversationId || owner?.conversationId === request.conversationId)));
      } else if (work?.kind === "join") {
        const join = coordinationV3.getJoin(work.recordId);
        resolved = !join || ["satisfied", "cancelled"].includes(join.state);
        const owner = join ? store.getAgent(join.ownerAgentId) : undefined;
        internal = Boolean(owner?.projectId === join?.projectId && (!join?.conversationId || owner?.conversationId === join.conversationId));
      }
      if (resolved && notification.dedupeKey) resolveOperationalNotification(notification.dedupeKey);
      else if (internal) { const cursor = workspace.cursor(); workspace.classifyNotificationAsInternal(notification.id); publishWorkspaceSince(cursor); }
    }

  }
  const reconcileCoordinationAttentionNotifications = (): void => {
    for (const _ of coordinationAttentionNotifications()) { /* synchronous startup repair */ }
  };
  const scheduleCoordinationAttentionNotifications = (projectId: string): Promise<void> => {
    if (coordinationNotificationsStopped) return Promise.resolve();
    dirtyCoordinationProjects.add(projectId);
    if (!coordinationNotificationWork) {
      coordinationNotificationWork = (async () => {
        try {
          await setImmediate();
          while (!coordinationNotificationsStopped && dirtyCoordinationProjects.size) {
            const nextProject = dirtyCoordinationProjects.values().next().value!;
            dirtyCoordinationProjects.delete(nextProject);
            try {
              // ponytail: one synchronous inspection per turn. If one inspection
              // outgrows this ceiling, bound the inspector's graph traversal.
              for (const _ of coordinationAttentionNotifications(nextProject)) {
                await setImmediate();
                if (coordinationNotificationsStopped) break;
              }
            } catch (err) {
              context.logError({ err, projectId: nextProject }, "Workflow notification reconciliation failed");
            }
          }
        } finally {
          coordinationNotificationWork = undefined;
        }
      })();
    }
    return coordinationNotificationWork;
  };
  const stopCoordinationAttentionNotifications = async (): Promise<void> => {
    coordinationNotificationsStopped = true;
    dirtyCoordinationProjects.clear();
    await coordinationNotificationWork;
  };
  const reconcileContextRolloverFormatNotifications = (): void => {
    // An episode observes this host's retained handles. After a host restart
    // that observation has ended; canonical Run recovery/unknown-outcome
    // notices remain independent. Do not keep a departed host's status live.
    const restartCursor = workspace.cursor();
    workspace.forEachNotification(notification => {
      const key = notification.dedupeKey;
      if (notification.kind === "information" && key?.startsWith("runtime-cleanup-status:")
        && (notification.status ?? "open") === "open") workspace.setNotificationStatus(notification.id, "resolved");
    });
    // Earlier builds presented automatic cleanup as an operator obligation.
    // Reclassify those retained projections on restart without settling work,
    // declaring a process exited, or clearing actionable uncertain outcomes.
    const demotedCleanupIds = new Set<string>();
    for (const prefix of ["runtime-teardown:", "provider-run-cleanup:", "context-rollover:"]) {
      workspace.forEachOpenOperationalNotification(prefix, notification => {
        const key = notification.dedupeKey;
        if (!key || (prefix === "context-rollover:" && !key.endsWith(":session-retirement"))) return;
        demotedCleanupIds.add(notification.id);
        createOperationalNotification({
          dedupeKey: key, informational: true, category: "system", severity: "info",
          title: "Previous automatic cleanup status",
          body: "The previous host recorded delayed provider cleanup. Agent activity shows current recovery details. This status does not establish a work outcome or require a user decision.",
          projectId: notification.projectId,
          conversationId: notification.conversationId,
          agentId: notification.agentId,
          ...(notification.agentId ? { action: { kind: "open_agent", targetId: notification.agentId } } : {}),
        });
      });
    }
    // Already queued urgent pushes must not outlive their reclassification.
    if (demotedCleanupIds.size) for (const delivery of workspace.listPushDeliveries()) {
      if (delivery.status === "pending" && demotedCleanupIds.has(delivery.notificationId)) {
        workspace.updatePushDelivery({ notificationId: delivery.notificationId,
          deviceId: delivery.deviceId, status: "abandoned", lastError: "Automatic cleanup has no user-owned resolution" });
      }
    }
    publishWorkspaceSince(restartCursor);
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
      if (receipt?.storageCleanupCompleted && receipt.draftCleanupCompleted &&
          receipt.assetAuthorityCleanupCompleted) {
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
    scheduleCoordinationAttentionNotifications,
    stopCoordinationAttentionNotifications,
    reconcileProjectDeletionOperationalNotifications,
    reconcileProjectWorkspace,
    resolveOperationalNotification,
  };
}
