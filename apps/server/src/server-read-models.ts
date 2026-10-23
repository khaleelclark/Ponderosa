import {
  collaborationPresentation,
  TEAM_DIRECTORY_LIMITS,
  type TeamDirectoryCaller,
  type AgentDetailDto,
  type AgentDto,
  type AgentHealthProjectionDto,
  type CollaborationViewDto,
  type ConversationDetailDto,
  type DecisionDto,
  type TeamOperationalEventDto,
  type TeamDirectoryDto,
} from "@ponderosa/core";
import type {
  AgentStore,
  CoordinationV3Store,
  StoredLogEvent,
  WorkspaceStore,
} from "@ponderosa/agents";
import { createHash } from "node:crypto";
import { communicationMentionBindings } from "@ponderosa/agents";
import { projectAgentHealth, type ActiveRunObservation } from "./agent-health.js";
import { sqliteCollectionPage } from "./collection-page.js";
import { withDecisionRecipient } from "./decision-presentation.js";
import { decodeTimelineCursor, encodeTimelineCursor } from "./cursors.js";
import {
  agentMentionHandle,
  communicationRecipientAgentIds,
  recipientMentionIdentities,
  resolveAgentMentionBindings,
} from "./mention-bindings.js";
import type { ActiveRun, PersistentRuntime, RuntimeOwnershipState } from "./app-contracts.js";
import {
  isRequestCommunicationHandoffKind,
  requestUpdateCommunicationEventId,
  requestUpdateCommunicationLink,
} from "./request-update-communication.js";

interface ReadModelContext {
  runtimeCleanupPending?(agentId: string): boolean;
  admissionBlocker?(agent: AgentDto): import("@ponderosa/core").QueuedAdmissionBlockerDto | undefined;
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  managementPlans: ReadonlyMap<string, {
    id: string;
    agentId: string;
    conversationId: string;
    createdAt: string;
    appliedAt?: string;
    approvalDecisionId?: string;
  }>;
  activeRuns: Map<string, ActiveRun>;
  scheduledSessionRollovers: ReadonlyMap<string, string>;
  runtimeStallAfterMs: number;
  reusableRuntime(agentId: string): PersistentRuntime | undefined;
  transitionRun(agentId: string, run: ActiveRun, state: RuntimeOwnershipState): boolean;
  appendWorkspace(event: Parameters<WorkspaceStore["append"]>[0]): unknown;
  publish(agentId: string, stored: StoredLogEvent): void;
  reconcileCommunicationNotifications(): void;
  scheduleCoordinationAttentionNotifications(projectId: string): void;
  isClosed(): boolean;
}

const TEAM_ATTENTION_STATES = new Set([
  "blocked",
  "cancelled",
  "expired",
  "failed",
  "interrupted",
  "outcome_unknown",
  "recipient_unavailable",
  "rejected",
  "stalled",
  "superseded",
  "teardown_failed",
  "timed_out",
  "unavailable",
  "unknown",
]);

function teamOperationNeedsAttention(
  kind: TeamOperationalEventDto["kind"],
  state: string,
): boolean {
  return kind === "decision"
    ? state === "pending"
    : TEAM_ATTENTION_STATES.has(state);
}

export function createServerReadModels(context: ReadModelContext) {
  const {
    store,
    coordinationV3,
    workspace,
    managementPlans,
    activeRuns,
    scheduledSessionRollovers,
    runtimeStallAfterMs,
    reusableRuntime,
    transitionRun,
    appendWorkspace,
    publish,
    reconcileCommunicationNotifications,
    scheduleCoordinationAttentionNotifications,
    isClosed,
  } = context;
  // ponytail: at most 1,024 Agent fingerprints, never snapshots/history. An
  // eviction or restart permits one extra mirror; SQLite remains authority.
  const coordinationFingerprints = new Map<string, string>();

  function deliveryReceiptsForCommunications(projectId: string, communicationEventIds: string[]) {
    const receipts = coordinationV3.deliveryReceiptsForCommunications(projectId, communicationEventIds);
    const waiting = (receipt: import("@ponderosa/core").MessageDeliveryReceiptDto) =>
      (receipt.state === "queued" || receipt.state === "retrying") && !receipt.steeringWaitReason;
    const ids = new Set([...receipts.values()].flatMap(rows => rows.filter(waiting).map(row => row.targetAgentId)));
    if (!ids.size) return receipts;
    const current = new Map([...ids].flatMap(id => {
      const agent = store.getAgent(id);
      return agent?.projectId === projectId ? [[id, { agent, run: coordinationV3.activeAgentRun(id), blocked: coordinationV3.providerBlockedState(id) }] as const] : [];
    }));
    const admission = new Map<string, ReturnType<NonNullable<ReadModelContext["admissionBlocker"]>>>();
    for (const [id, rows] of receipts) receipts.set(id, rows.map(receipt => {
      if (!waiting(receipt)) return receipt;
      const target = current.get(receipt.targetAgentId);
      if (!target) return receipt;
      const engine = receipt.runtime?.engine ?? target.agent.activeEngine, key = receipt.targetAgentId + "\0" + engine;
      if (!admission.has(key)) admission.set(key, context.admissionBlocker?.({ ...target.agent, activeEngine: engine }));
      // Reuse exact Run/hold and selected-runtime admission authority. A
      // different pending question/dependency is not this message's blocker.
      const queueWaitReason = target.run ? "current_run"
        : target.blocked?.activationIds.includes(receipt.activationId) ? "provider_retry" : admission.get(key)?.kind;
      return queueWaitReason ? { ...receipt, queueWaitReason } : receipt;
    }));
    return receipts;
  }

  function withMessagePresentation<T extends { communicationEventId?: string; text: string; deliveryReceipts?: import("@ponderosa/core").MessageDeliveryReceiptDto[]; agentMentions?: import("@ponderosa/core").AgentMentionBindingDto[]; coordinationRequests?: import("@ponderosa/core").CoordinationRequestSummaryDto[] }>(projectId: string, messages: T[], displayedConversationId?: string): T[] {
    const projectAgents = store.listAgents(projectId);
    const communicationEventIds = messages.flatMap((message) =>
      message.communicationEventId ? [message.communicationEventId] : []);
    const communicationsByEvent = new Map(communicationEventIds.flatMap((eventId) => {
      const communication = store.getCommunicationEvent(projectId, eventId);
      return communication ? [[eventId, communication] as const] : [];
    }));
    const requestUpdateLinksByEvent = new Map(communicationEventIds.flatMap((eventId) => {
      const link = requestUpdateCommunicationLink(communicationsByEvent.get(eventId));
      return link ? [[eventId, link] as const] : [];
    }));
    const deliveryReceiptsByEvent = deliveryReceiptsForCommunications(
      projectId,
      communicationEventIds,
    );
    const requestsByEvent = coordinationV3.requestSummariesForCommunications(
      projectId,
      [
        ...communicationEventIds,
        ...[...requestUpdateLinksByEvent.values()].map(
          (link) => link.sourceCommunicationEventId,
        ),
      ],
    );
    return messages.map((message) => {
      if (!message.communicationEventId) return message;
      const communication = communicationsByEvent.get(message.communicationEventId);
      const recipientAgentIds = communicationRecipientAgentIds(communication);
      const directMessageAgents = communication?.schemaVersion === 2 && communication.intent === "user_dm"
        ? recipientAgentIds.map((agentId) => {
            const agent = projectAgents.find((candidate) => candidate.id === agentId);
            return {
              id: agentId,
              title: agent?.title ?? communication.identity?.recipientLabels?.[agentId] ?? "Deleted Agent",
              handle: agent?.handle ?? communication.identity?.recipientHandles?.[agentId] ?? agentMentionHandle(communication.identity?.recipientLabels?.[agentId] ?? "Deleted Agent"),
            };
          })
        : [];
      const collaboration = communication?.intent === "collaboration"
        ? collaborationPresentation({ ...communication, text: message.text }, projectAgents) : undefined;
      const collaborationRecipients = collaboration?.collaborationRecipients ?? [];
      const agentOpening = communication?.eventId.startsWith("agent-opening:") ?? false;
      const openingMentions = communication && agentOpening
        ? communicationMentionBindings(message.text, communication, (agentId) => store.getAgent(agentId), displayedConversationId)
            .filter((binding) => binding.handle === "new-agent")
        : [];
      const agentMentions = collaboration?.agentMentions ?? [...resolveAgentMentionBindings(
        projectId,
        message.text,
        recipientAgentIds,
        [
          ...projectAgents,
          ...recipientMentionIdentities(
            recipientAgentIds,
            projectAgents,
            communication?.identity?.recipientLabels,
            communication?.identity?.recipientHandles,
          ),
        ],
      ), ...openingMentions];
      const deliveryReceipts = deliveryReceiptsByEvent.get(message.communicationEventId) ?? [];
      const requestUpdateLink = requestUpdateLinksByEvent.get(
        message.communicationEventId,
      );
      const requestForUpdate = requestUpdateLink
        ? coordinationV3.requestForUpdate(requestUpdateLink.updateId)
        : undefined;
      const senderAgentId = communication?.sender.kind === "agent"
        ? communication.sender.agentId
        : undefined;
      let peerAgentId: string | undefined;
      if (requestForUpdate && senderAgentId) {
        if (senderAgentId === requestForUpdate.recipientAgentId) {
          peerAgentId = requestForUpdate.requesterAgentId;
        } else if (senderAgentId === requestForUpdate.requesterAgentId) {
          peerAgentId = requestForUpdate.recipientAgentId;
        }
      }
      const linkedRequest = requestUpdateLink
        && requestForUpdate?.id === requestUpdateLink.requestId
        && requestForUpdate.projectId === projectId
        && requestForUpdate.conversationId === communication?.conversationId
        && peerAgentId
        && communication?.audience.kind === "agents"
        && communication.audience.agentIds.length === 1
        && communication.audience.agentIds[0] === peerAgentId
        ? requestsByEvent.get(requestUpdateLink.sourceCommunicationEventId)
          ?.find((candidate) =>
            candidate.recordId === requestUpdateLink.requestId
            && candidate.communicationEventId === requestUpdateLink.sourceCommunicationEventId
            && candidate.conversationId === communication.conversationId)
        : undefined;
      const coordinationRequests = [...new Map([
        ...(message.coordinationRequests ?? []),
        ...(requestsByEvent.get(message.communicationEventId) ?? []),
        ...(linkedRequest ? [linkedRequest] : []),
      ].map((candidate) => [candidate.recordId, candidate] as const)).values()];
      return {
        ...message,
        ...(communication ? {
          communicationIntent: communication.intent,
          authoredText: communication.text,
          communicationSender: communication.sender,
        } : {}),
        ...(directMessageAgents.length ? { directMessageAgents } : {}),
        ...(collaborationRecipients.length ? { collaborationRecipients } : {}),
        ...(deliveryReceipts.length ? { deliveryReceipts } : {}),
        ...(coordinationRequests.length ? { coordinationRequests } : {}),
        ...(collaboration || agentOpening || agentMentions.length ? { agentMentions } : {}),
      };
    });
  }

  function conversationDetail(
    conversationId: string,
    input: { limit?: number; cursor?: string; focusId?: string } = {},
  ): ConversationDetailDto | undefined {
    const conversation = store.getConversation(conversationId);
    if (!conversation) return undefined;
    const limit = input.limit ?? 100;
    type CombinedCursor = {
      v: 1;
      messages?: string;
      messagesDone?: boolean;
      decisions?: { createdAt: string; id: string };
      decisionsDone?: boolean;
    };
    let combined: CombinedCursor | undefined;
    if (input.cursor) {
      const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Partial<CombinedCursor>;
      if (parsed.v !== 1) throw new Error("invalid conversation cursor");
      combined = parsed as CombinedCursor;
    }
    const page = combined?.messagesDone
      ? { messages: [], hasMore: false as const }
      : store.getProjectedConversationMessagePage(conversationId, "main", {
        limit,
        cursor: combined?.messages,
        focusId: input.focusId,
      });
    const decisionPage = combined?.decisionsDone
      ? { events: [], hasMore: false as const }
      : workspace.listDecisionEventPage({
      projectId: conversation.projectId,
      conversationId,
      limit,
        before: combined?.decisions,
      });
    const oldestDecisionEvent = decisionPage.events.at(-1);
    const hasMore = page.hasMore || decisionPage.hasMore;
    const nextCursor: CombinedCursor = {
      v: 1,
      ...(page.hasMore && page.cursor ? { messages: page.cursor } : { messagesDone: true }),
      ...(decisionPage.hasMore && oldestDecisionEvent
        ? { decisions: { createdAt: oldestDecisionEvent.createdAt, id: oldestDecisionEvent.id } }
        : { decisionsDone: true }),
    };
    const memberPage = sqliteCollectionPage(store.sqlite, { limit: "100" }, {
      baseSql: `
        SELECT agent.id, agent.title, agent.updated_at
        FROM agent_conversation_memberships membership
        JOIN agents agent ON agent.id = membership.agent_id
        WHERE membership.conversation_id = ? AND agent.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM agent_creation_operation_members creation_members
            JOIN agent_creation_operations creation_operations ON creation_operations.id = creation_members.operation_id
            WHERE creation_members.agent_id = agent.id
              AND creation_operations.status IN ('preparing', 'canonical_committed', 'rolling_back')
          )
      `,
      params: [conversationId],
      order: "title",
      scope: `conversation-members:${conversationId}`,
      hydrate: id => store.getAgent(id),
    });
    // Keep unresolved notices independent of timeline pagination. Seed only
    // exact failed deliveries on this Chat's indexed projection, then follow
    // their existing bounded required-reply lineage; never inspect Agent history.
    const failedMessages = store.sqlite.prepare(`
      WITH RECURSIVE chain(root, id, event_id) AS (
        SELECT root.id, root.id, message.communication_event_id
        FROM chat_search_messages message
        JOIN runtime_communications communication ON communication.project_id = message.project_id
          AND communication.id IN (
            SELECT id FROM runtime_communications WHERE id = message.communication_event_id
            UNION SELECT id FROM runtime_communications WHERE json_valid(payload_json)
              AND json_extract(payload_json, '$.communication.eventId') = message.communication_event_id
          )
        JOIN activation_sources source ON source.source_kind = 'communication' AND source.source_id = communication.id
        JOIN agent_activations root ON root.id = source.activation_id
        WHERE message.project_id = ? AND message.chat_kind = 'conversation' AND message.chat_id = ?
          AND root.state IN ('failed','outcome_unknown','retry_pending')
          AND EXISTS (SELECT 1 FROM scheduler_run_activations attached JOIN scheduler_runs run ON run.id = attached.run_id
            WHERE attached.activation_id = root.id AND json_extract(run.provider_failure_json, '$.category') IN ('quota_exhausted','rate_limit','throttled','capacity'))
        UNION
        SELECT chain.root, retry.successor_activation_id, chain.event_id FROM chain
        JOIN activation_delivery_retry_lineage retry ON retry.predecessor_activation_id = chain.id
        UNION
        SELECT chain.root, reply.recovery_activation_id, chain.event_id FROM chain
        JOIN required_reply_obligations reply ON reply.source_activation_id = chain.id
        JOIN agent_activations root ON root.id = chain.root
        WHERE reply.recovery_activation_id IS NOT NULL AND reply.project_id = root.project_id
          AND reply.agent_id = root.agent_id AND reply.scope_key = root.scope_key
      ), latest AS (
        SELECT chain.root, chain.event_id, run.status, run.provider_failure_json,
          ROW_NUMBER() OVER (PARTITION BY chain.root ORDER BY run.created_at DESC, run.rowid DESC) AS rank
        FROM chain JOIN scheduler_run_activations attached ON attached.activation_id = chain.id
        JOIN scheduler_runs run ON run.id = attached.run_id
      ) SELECT DISTINCT event_id FROM latest WHERE rank = 1 AND status <> 'completed'
        AND (provider_failure_json IS NULL OR json_extract(provider_failure_json, '$.category') IN ('quota_exhausted','rate_limit','throttled','capacity'))
      ORDER BY event_id LIMIT 101
    `).all(conversation.projectId, conversationId) as Array<{event_id:string}>;
    // ponytail: at most 100 full notices per response; expose overflow honestly.
    // If this ceiling is reached, add cursor paging to this same read projection.
    const failureMessages = withMessagePresentation(conversation.projectId, failedMessages.slice(0,100).flatMap(row => {
      const message = store.getProjectedConversationMessageById(conversationId, "main", row.event_id);
      return message ? [message] : [];
    }), conversationId).filter(message => message.deliveryReceipts?.some(receipt => receipt.providerFailure));
    return {
      conversation,
      providerFailureMessages: failureMessages,
      ...(failedMessages.length > 100 ? { providerFailuresHasMore: true as const } : {}),
      agents: memberPage.items,
      members: {
        total: memberPage.total,
        limit: memberPage.limit,
        hasMore: memberPage.hasMore,
        ...(memberPage.cursor ? { cursor: memberPage.cursor } : {}),
      },
      messages: withMessagePresentation(conversation.projectId, page.messages, conversationId),
      decisionEvents: decisionPage.events.map(event => withDecisionRecipient(store, event)),
      history: {
        limit,
        hasMore,
        ...(hasMore ? { cursor: Buffer.from(JSON.stringify(nextCursor)).toString("base64url") } : {}),
      },
    };
  }

  /** Provider context loads only room metadata here. Canonical messages are
   * selected separately through bounded indexed source readers. */
  function canonicalConversationContext(conversationId: string): ConversationDetailDto | undefined {
    const conversation = store.getConversation(conversationId);
    if (!conversation) return undefined;
    return {
      conversation,
      agents: store.listAgents(conversation.projectId).filter((agent) => agent.conversationId === conversationId),
      messages: [],
    };
  }

  function collaborationViewDetail(
    conversationId: string,
    input: { limit?: number; cursor?: string; focusId?: string; operationCursor?: string } = {},
  ): CollaborationViewDto | undefined {
    const conversation = store.getConversation(conversationId);
    if (!conversation) return undefined;
    const limit = input.limit ?? 100;
    const agents = store.listAgents(conversation.projectId).filter((agent) => agent.conversationId === conversationId);
    const names = new Map(agents.map((agent) => [agent.id, agent.title]));
    const operationBoundary = input.operationCursor
      ? decodeTimelineCursor(input.operationCursor, "team:operations", conversationId)
      : undefined;
    const coordinationRecords = coordinationV3.teamOperationalRecords({
      projectId: conversation.projectId,
      conversationId,
      limit: limit + 1,
      ...(operationBoundary ? { before: operationBoundary } : {}),
    });
    const operations: NonNullable<CollaborationViewDto["operations"]> = coordinationRecords.map((record) => {
      const owner = names.get(record.primaryAgentId) ??
        (record.kind === "request" ? "Deleted Agent" : "An Agent");
      const recipient = record.secondaryAgentId
        ? names.get(record.secondaryAgentId) ?? "Deleted Agent"
        : record.recipientAgentId
          ? names.get(record.recipientAgentId) ?? "Deleted Agent"
          : "another Agent";
      const terminal = [
        "completed",
        "blocked",
        "failed",
        "cancelled",
        "expired",
        "outcome_unknown",
        "recipient_unavailable",
        "superseded",
      ].includes(record.state);
      const text = record.kind === "run"
        ? ["leased", "running"].includes(record.state) ? `${owner} is running`
          : record.state === "completed" ? `${owner} finished`
            : ["cancelled", "interrupted"].includes(record.state) ? `${owner} stopped` : `${owner} failed`
        : record.kind === "activation"
          ? `${owner} has work queued`
          : record.kind === "request"
            ? record.state === "completed" ? `${recipient} finished work for ${owner}`
              : terminal ? `${recipient}'s work for ${owner} ended ${record.state.replaceAll("_", " ")}`
                : `${owner} asked ${recipient} to work`
            : record.kind === "join"
              ? record.state === "open" ? `${owner} is waiting for ${Math.max(0, (record.total ?? 0) - (record.completed ?? 0))} more result${(record.total ?? 0) - (record.completed ?? 0) === 1 ? "" : "s"}`
                : record.state === "satisfied" ? `${owner} received every result it was waiting for`
                  : `${owner}'s wait ended ${record.state}`
              : `${owner} has work queued`;
      return {
        id: record.id,
        kind: record.kind,
        operationGroupId: record.operationGroupId,
        state: record.state,
        attentionRequired: teamOperationNeedsAttention(
          record.kind,
          record.state,
        ),
        text,
        agentIds: [record.primaryAgentId, ...(record.secondaryAgentId ? [record.secondaryAgentId] : [])],
        createdAt: record.createdAt, updatedAt: record.updatedAt,
        ...(record.kind === "request" && record.recipientAgentId
          ? {
              request: {
                recordId: record.id.slice("request:".length),
                state: record.state as import("@ponderosa/core").CoordinationRequestState,
                ...(record.requesterAgentId
                  ? { requesterAgentId: record.requesterAgentId }
                  : {}),
                recipientAgentId: record.recipientAgentId,
                conversationId,
                ...(record.communicationEventId
                  ? { communicationEventId: record.communicationEventId }
                  : {}),
                ...(record.requestPreview ? { preview: record.requestPreview } : {}),
                hasUpdates: record.hasUpdates ?? false,
                ...(record.latestUpdateKind
                  ? { latestUpdateKind: record.latestUpdateKind }
                  : {}),
                ...(record.latestUpdateAt
                  ? { latestUpdateAt: record.latestUpdateAt }
                  : {}),
                hasResult: record.hasResult ?? false,
                updatedAt: record.updatedAt,
              },
            }
          : {}),
      };
    });
    for (const decision of workspace.listDecisions({ conversationId })) {
      const decisionId = `decision:${decision.id}`;
      if (operationBoundary && !(decision.createdAt < operationBoundary.createdAt ||
        (decision.createdAt === operationBoundary.createdAt && decisionId < operationBoundary.id))) continue;
      const agentName = names.get(decision.agentId) ?? "An Agent";
      operations.push({
        id: decisionId,
        kind: "decision",
        state: decision.status,
        attentionRequired: teamOperationNeedsAttention(
          "decision",
          decision.status,
        ),
        text: decision.status === "pending" ? `${agentName} is waiting for your decision` : `You answered ${agentName}'s decision`,
        agentIds: [decision.agentId],
        createdAt: decision.createdAt,
        updatedAt: decision.updatedAt,
      });
    }
    for (const plan of managementPlans.values()) if (plan.conversationId === conversationId) {
      const planId = `management:${plan.id}`;
      if (operationBoundary && !(plan.createdAt < operationBoundary.createdAt ||
        (plan.createdAt === operationBoundary.createdAt && planId < operationBoundary.id))) continue;
      const agentName = names.get(plan.agentId) ?? "An Agent";
      operations.push({
        id: planId,
        kind: "organization",
        state: plan.appliedAt ? "applied" : "planned",
        attentionRequired: false,
        text: plan.appliedAt
          ? `${agentName} updated its organization`
          : `${agentName} prepared an organization change`,
        agentIds: [plan.agentId],
        createdAt: plan.createdAt,
        updatedAt: plan.appliedAt ?? plan.createdAt,
      });
    }
    operations.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const hasMoreOperations = operations.length > limit;
    const selectedOperations = operations.slice(0, limit);
    const oldestOperation = selectedOperations.at(-1);
    const messagePage = store.getProjectedConversationMessagePage(conversationId, "collaboration", { limit, cursor: input.cursor, focusId: input.focusId });
    const projectedMessages = withMessagePresentation(
      conversation.projectId,
      messagePage.messages,
      conversationId,
    );
    const recoveredRequestHandoffs = selectedOperations.flatMap((operation) => {
      if (operation.kind !== "request" || !operation.request?.requesterAgentId) return [];
      const lifecycle = coordinationV3.requestLifecycleDetails({
        projectId: conversation.projectId,
        conversationId,
        recordId: operation.request.recordId,
      });
      const update = [...(lifecycle?.updates ?? [])].reverse().find((candidate) =>
        candidate.actorKind === "agent"
        && Boolean(candidate.actorId)
        && Boolean(candidate.text?.trim())
        && isRequestCommunicationHandoffKind(candidate.kind));
      if (!update?.actorId || !update.text?.trim()) return [];
      const eventId = requestUpdateCommunicationEventId(
        conversation.projectId,
        operation.request.recordId,
        update.id,
      );
      if (store.getProjectedConversationMessageById(
        conversationId,
        "collaboration",
        eventId,
      )) return [];
      return [{
        id: eventId,
        conversationId,
        role: "assistant" as const,
        text: update.text.trim(),
        createdAt: update.createdAt,
        authorAgentId: update.actorId,
        coordinationRequests: [operation.request],
      }];
    });
    const messages = [...projectedMessages, ...recoveredRequestHandoffs]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return {
      agents,
      operations: selectedOperations.reverse(),
      messages,
      history: { limit, hasMore: messagePage.hasMore, ...(messagePage.cursor ? { cursor: messagePage.cursor } : {}) },
      operationHistory: {
        limit, hasMore: hasMoreOperations,
        ...(hasMoreOperations && oldestOperation ? {
          cursor: encodeTimelineCursor("team:operations", conversationId, oldestOperation.createdAt, oldestOperation.id),
        } : {}),
      },
    };
  }

  function agentDetail(
    agentId: string,
    input: { limit?: number; cursor?: string; focusId?: string } = {},
  ): AgentDetailDto | undefined {
    const limit = input.limit ?? 100;
    // Chat is read through the indexed canonical projection below; do not also
    // hydrate the superseded Agent message table only to replace it.
    const detail = store.getAgentDetail(agentId, limit, false);
    if (!detail) return detail;
    type CombinedCursor = { v: 3; agentId: string; messages?: string; messagesDone?: boolean;
      decisions?: { createdAt: string; id: string }; decisionsDone?: boolean };
    let combined: CombinedCursor | undefined;
    if (input.cursor) {
      const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Partial<CombinedCursor>;
      if (parsed.v === 3) {
        if (parsed.agentId !== agentId) throw new Error("invalid Agent Chat cursor scope");
        combined = parsed as CombinedCursor;
      }
      // v2 canonical message cursors remain valid for an already open older client.
    }
    const messagePage = combined?.messagesDone ? { messages: [], hasMore: false as const }
      : store.getProjectedAgentMessagePage(agentId, { limit, cursor: combined ? combined.messages : input.cursor, focusId: input.focusId });
    const decisionPage = combined?.decisionsDone ? { events: [], hasMore: false as const }
      : workspace.listDecisionEventPage({ projectId: detail.agent.projectId, agentId, limit, before: combined?.decisions });
    const oldestDecision = decisionPage.events.at(-1);
    const hasMore = messagePage.hasMore || decisionPage.hasMore;
    const nextCursor: CombinedCursor = { v: 3, agentId,
      ...(messagePage.hasMore && messagePage.cursor ? { messages: messagePage.cursor } : { messagesDone: true }),
      ...(decisionPage.hasMore && oldestDecision ? { decisions: { createdAt: oldestDecision.createdAt, id: oldestDecision.id } } : { decisionsDone: true }) };
    return {
      ...detail,
      hasSubagentHistory:
        store.listAgents(detail.agent.projectId).some(candidate =>
          candidate.managerAgentId === agentId
        ) || store.readAgentOrganizationEvents(detail.agent.projectId).some(event =>
          event.managerAgentId === agentId
        ),
      messages: withMessagePresentation(detail.agent.projectId, messagePage.messages, detail.agent.conversationId ?? ""),
      decisionEvents: decisionPage.events.map(event => withDecisionRecipient(store, event)),
      history: { limit, hasMore, ...(hasMore ? { cursor: Buffer.from(JSON.stringify(nextCursor)).toString("base64url") } : {}) },
      coordinationV3: coordinationV3.agentSnapshot(agentId),
    };
  }

  function publishCoordinationV3Changed(
    agentId: string,
    options: {
      publishWorkspaceEvent?: boolean;
      conversationIds?: string[];
    } = {},
  ): void {
    const agent = store.getAgent(agentId);
    if (isClosed() || !agent) return;
    const coordination = coordinationV3.agentSnapshot(agentId);
    const fingerprint = createHash("sha256").update(JSON.stringify(coordination)).digest("hex");
    if (coordinationFingerprints.get(agentId) !== fingerprint) {
      const stored = store.appendEvent(agentId, { type: "coordination_v3_changed", coordination });
      coordinationFingerprints.delete(agentId);
      coordinationFingerprints.set(agentId, fingerprint);
      if (coordinationFingerprints.size > 1024) coordinationFingerprints.delete(coordinationFingerprints.keys().next().value!);
      publish(agentId, stored);
    }
    if (options.publishWorkspaceEvent !== false) {
      appendWorkspace({
        type: "coordination_changed",
        projectId: agent.projectId,
        agentId,
        conversationIds: options.conversationIds ?? [agent.conversationId],
      });
    }
    scheduleCoordinationAttentionNotifications(agent.projectId);
  }

  function publishMessageDeliveryChanged(agentId: string): void {
    const agent = store.getAgent(agentId);
    if (isClosed() || !agent) return;
    publishCoordinationV3Changed(agentId, { publishWorkspaceEvent: false });
    appendWorkspace({
      type: "message_delivery_changed",
      projectId: agent.projectId,
      agentId,
      conversationIds: [agent.conversationId],
    });
    reconcileCommunicationNotifications();
  }

  function ensureDecisionResponseActivation(decision: DecisionDto): string | undefined {
    if (!decision.response || (decision.status !== "resolved" &&
        !(decision.status === "cancelled" && decision.response.skipped))) return undefined;
    const project = store.getProject(decision.projectId);
    const agent = store.getAgent(decision.agentId);
    if (!project || !agent || agent.projectId !== project.id) return undefined;
    if (decision.conversationId) {
      const conversation = store.getConversation(decision.conversationId);
      if (!conversation || conversation.projectId !== project.id ||
          agent.conversationId !== conversation.id) return undefined;
    }
    const activationId = coordinationV3.enqueueMessageActivation({
      projectId: decision.projectId,
      agentId: decision.agentId,
      scopeKey: decision.conversationId ? `conversation:${decision.conversationId}` : `agent:${decision.agentId}`,
      messageId: `decision:${decision.id}:response`,
      kind: "human",
      payload: {
        decision: {
          id: decision.id,
          question: decision.question,
          response: decision.response,
          // Data for this exact continuation, not filesystem or routing authority.
          ...(decision.approvalScope?.kind === "artifact_publication" && decision.response.optionId === "approve"
            ? { publication: {
                sourcePath: decision.approvalScope.sourcePath,
                filename: decision.approvalScope.filename,
                operationId: decision.approvalScope.operationId,
                sha256: decision.approvalScope.sha256,
                size: decision.approvalScope.size,
                expiresAt: decision.approvalScope.expiresAt,
              } }
            : {}),
        },
      },
      bypassCapacity: true,
      ...(decision.continuationRequestIds?.length
        ? { questionDependency: { kind: "decision" as const, id: decision.id } }
        : {}),
      now: decision.response.respondedAt,
    });
    coordinationV3.attachTaskDecisionWake(decision.id, activationId, decision.response.respondedAt,
      decision.blocking ? decision.coordinationRunId : undefined);
    return activationId;
  }

  const agentMessages = (agentId: string) => store.getProjectedAgentMessages(agentId);

  function observeRuntimeStalls(): void {
    const now = Date.now();
    for (const [agentId, run] of activeRuns) {
      if (run.ownershipState !== "running" || !run.lastEventReceivedAt) continue;
      const received = Date.parse(run.lastEventReceivedAt);
      const persisted = run.lastEventPersistedAt ? Date.parse(run.lastEventPersistedAt) : 0;
      if (received > persisted && now - received >= runtimeStallAfterMs) transitionRun(agentId, run, "stalled");
    }
  }

  function agentHealth(scope: AgentHealthProjectionDto["scope"], agents: AgentDto[], options?: { includeRunHistory?: boolean }): AgentHealthProjectionDto {
    observeRuntimeStalls();
    const pendingDecisionAt = new Map<string, string>();
    for (const decision of workspace.listDecisions({ status: "pending" })) {
      if (!pendingDecisionAt.has(decision.agentId)) {
        pendingDecisionAt.set(decision.agentId, decision.updatedAt);
      }
    }
    const ownership = new Map<string, ActiveRunObservation>(
      [...activeRuns].map(([agentId, run]) => [agentId, {
        startedAt: run.startedAt,
        lastActivityAt: run.lastMeaningfulActivityAt,
        executionId: run.executionId,
        schedulerRunId: run.v3SchedulerRunId,
        leaseExpiresAt: run.leaseExpiresAt,
        ownershipState: run.ownershipState,
      }]),
    );
    for (const agent of agents) {
      if (ownership.has(agent.id) || !context.runtimeCleanupPending?.(agent.id)) continue;
      const retained = store.sqlite.prepare(`
        SELECT run_id, created_at FROM provider_process_authority
        WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(agent.id) as { run_id: string | null; created_at: string } | undefined;
      // The live cleanup registry also owns Windows Jobs, which have no
      // POSIX restart-recovery row. A missing row cannot mean healthy idle.
      ownership.set(agent.id, {
        startedAt: retained?.created_at ?? agent.updatedAt, ownershipState: "interrupted",
        ...(retained?.run_id ? { executionId: retained.run_id, schedulerRunId: retained.run_id } : {}),
      });
    }
    const preparingRuns = new Map(agents.flatMap((agent) => {
      if (ownership.has(agent.id)) return [];
      const run = coordinationV3.activeAgentRun(agent.id);
      return run ? [[agent.id, {
        runId: run.id,
        status: run.status,
        leaseStartedAt: run.leaseStartedAt,
        leaseExpiresAt: run.leaseExpiresAt,
        promptInjectionState: run.promptInjectionState,
      }]] as const : [];
    }));
    const durableRolloverAgents = new Map(
      coordinationV3.activeContextRollovers(scope.type === "project" ? scope.id : undefined)
        .filter((rollover) => agents.some((agent) => agent.id === rollover.agentId))
        .map((rollover) => [rollover.agentId, rollover.updatedAt]),
    );
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const projection = projectAgentHealth({
      scope,
      agents,
      activeRuns: ownership,
      preparingRuns,
      compactingAgents: new Map([...scheduledSessionRollovers, ...durableRolloverAgents]),
      availability: (agentId) => coordinationV3.getAgentAvailability(agentId),
      pendingDecisionAt: (agentId) => pendingDecisionAt.get(agentId),
      providerBlocked: (agentId) => coordinationV3.providerBlockedState(agentId),
      admissionBlocker: (agentId) => {
        const agent = agentsById.get(agentId);
        return agent ? context.admissionBlocker?.(agent) : undefined;
      },
      executionPhase: (agentId, executionId) =>
        store.activeExecutionPhase(agentId, executionId),
      waitingPhase: (agentId) =>
        coordinationV3.activeWaitDependency(agentId, scope),
      latestEvent: (agentId) => store.latestHealthObservation(agentId),
      runs: options?.includeRunHistory === false ? undefined : (agentId) => store.getRunHealthSummaries(agentId),
    });
    return {
      ...projection,
      agents: projection.agents.map((agent) => ({
        ...agent,
        providerSessionLive: Boolean(
          activeRuns.get(agent.agentId)?.runtimeSession ??
          reusableRuntime(agent.agentId)?.session
        ),
      })),
    };
  }

  function teamDirectory(
    projectId: string,
    conversationId?: string,
    fallbackAgentId?: string,
    selectedAgentIds?: readonly string[],
    caller?: TeamDirectoryCaller,
  ): TeamDirectoryDto {
    if (caller?.kind === "agent") {
      const author = store.getAgent(caller.agentId);
      if (!author || author.projectId !== projectId || caller.projectId !== projectId ||
          caller.conversationId !== conversationId || (conversationId && author.conversationId !== conversationId)) {
        throw new Error("directory caller scope mismatch");
      }
    }
    const selectedAgents = selectedAgentIds
      ? selectedAgentIds.flatMap((agentId) => {
        const agent = store.getAgent(agentId);
        return agent?.projectId === projectId && !store.agentCreationPending(agentId) ? [agent] : [];
      })
      : store.listAgents(projectId);
    const scopedAgents = selectedAgents.filter((agent) =>
      (conversationId
        ? agent.conversationId === conversationId
        : fallbackAgentId ? agent.id === fallbackAgentId : true));
    const agents = scopedAgents.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
      .slice(0, TEAM_DIRECTORY_LIMITS.agents);
    const health = agentHealth({ type: "project", id: projectId }, agents);
    const healthById = new Map(health.agents.map((agent) => [agent.agentId, agent]));
    const childIdsByParent = new Map<string, string[]>();
    for (const agent of agents) if (agent.managerAgentId) {
      const children = childIdsByParent.get(agent.managerAgentId) ?? [];
      children.push(agent.id);
      childIdsByParent.set(agent.managerAgentId, children);
    }
    const bounded = (text: string, limit: number = TEAM_DIRECTORY_LIMITS.textCharacters) => Array.from(text).slice(0, limit).join("");
    const directory: TeamDirectoryDto = {
      projectId, generatedAt: health.generatedAt,
      agents: agents.map((agent) => {
        // Directory convenience fields are not a second route to spawn prompts
        // or private preset prose, even when Request details are authorized.
        const profile = { role: "Agent", description: `Managed ${agent.activeEngine} Agent` };
        return {
          agentId: agent.id, displayName: bounded(agent.title, TEAM_DIRECTORY_LIMITS.identityCharacters),
          role: bounded(profile.role, TEAM_DIRECTORY_LIMITS.identityCharacters),
          description: bounded(profile.description),
          status: healthById.get(agent.id)?.status ?? "idle",
          ...(healthById.get(agent.id)?.admissionBlocker ? { admissionBlocker: healthById.get(agent.id)!.admissionBlocker } : {}),
          ...(agent.managerAgentId ? { managerAgentId: agent.managerAgentId } : {}),
          childAgentIds: (childIdsByParent.get(agent.id) ?? []).sort(),
          engine: agent.activeEngine,
          ...(agent.presetSnapshot ? { preset: { id: agent.presetSnapshot.id, name: bounded(agent.presetSnapshot.name, TEAM_DIRECTORY_LIMITS.identityCharacters) } } : {}),
        };
      }).sort((a, b) => a.displayName.localeCompare(b.displayName) || a.agentId.localeCompare(b.agentId)),
      ...(scopedAgents.length > agents.length ? { totalAgents: scopedAgents.length, hasMoreAgents: true } : {}),
    };
    // Assignment payloads are queried only for an authenticated caller.
    const workByAgent = new Map<string, import("@ponderosa/core").TeamDirectoryWorkDto>();
    if (caller) for (const entry of directory.agents) {
      const work = coordinationV3.directoryWork({ projectId, conversationId, agentId: entry.agentId, caller });
      for (const assignment of work.assignments) if (assignment.requesterAgentId) {
        const requester = store.getAgent(assignment.requesterAgentId);
        if (requester?.projectId === projectId) assignment.requesterName = bounded(requester.title, TEAM_DIRECTORY_LIMITS.identityCharacters);
      }
      const running = Boolean(store.sqlite.prepare(`SELECT 1 FROM scheduler_runs WHERE project_id = ? AND agent_id = ?
        AND status IN ('leased', 'running') LIMIT 1`).get(projectId, entry.agentId));
      entry.currentActivity = work.activeAssignmentDetails === "restricted"
        ? `${running ? "Working; " : ""}assignment details restricted`
        : running && work.activeAssignmentDetails === "none" ? "Working; no tracked assignment"
          : running ? "Working; see authorized assignments" : undefined;
      entry.workSummaryOmitted = true;
      workByAgent.set(entry.agentId, work);
    }
    // Reserve every operational label and omission flag before adding optional
    // details; later entries must not push an earlier accepted body over budget.
    for (const entry of directory.agents) {
      const work = workByAgent.get(entry.agentId);
      if (!work) continue;
      entry.work = work;
      delete entry.workSummaryOmitted;
      if (Buffer.byteLength(JSON.stringify(directory), "utf8") > TEAM_DIRECTORY_LIMITS.responseUtf8Bytes) {
        delete entry.work;
        entry.workSummaryOmitted = true;
      }
    }
    if (Buffer.byteLength(JSON.stringify(directory), "utf8") > TEAM_DIRECTORY_LIMITS.responseUtf8Bytes) {
      throw new Error("team directory response exceeds its bounded size");
    }
    return directory;
  }

  return {
    agentDetail,
    agentHealth,
    observeRuntimeStalls,
    agentMessages,
    canonicalConversationContext,
    collaborationViewDetail,
    conversationDetail,
    ensureDecisionResponseActivation,
    publishCoordinationV3Changed,
    publishMessageDeliveryChanged,
    teamDirectory,
    withMessagePresentation,
    deliveryReceiptsForCommunications,
  };
}
