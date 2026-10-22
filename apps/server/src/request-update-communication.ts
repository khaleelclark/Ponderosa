import { createHash } from "node:crypto";
import type { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import type {
  CommunicationEvent,
  CoordinationRequestUpdateKind,
} from "@ponderosa/core";

const REQUEST_COMMUNICATION_HANDOFF_KINDS:
  ReadonlySet<CoordinationRequestUpdateKind> = new Set([
    "answer",
    "completed",
    "blocked",
    "failed",
  ]);

/** Only consequential Request handoffs belong in Team and Agent chat audits. */
export function isRequestCommunicationHandoffKind(
  kind: CoordinationRequestUpdateKind,
): boolean {
  return REQUEST_COMMUNICATION_HANDOFF_KINDS.has(kind);
}

/** Stable identity shared by immediate passive projection and read recovery. */
export function requestUpdateCommunicationEventId(
  projectId: string,
  requestId: string,
  updateId: string,
): string {
  return `request-update-${createHash("sha256")
    .update(`${projectId}\0${requestId}\0${updateId}`)
    .digest("hex")}`;
}

/** Resolve only server-authored passive Request handoffs. Rendered text and
 * artifact pointers never establish this relationship. */
export function requestUpdateCommunicationLink(
  communication: CommunicationEvent | undefined,
): {
  requestId: string;
  updateId: string;
  sourceCommunicationEventId: string;
} | undefined {
  if (
    !communication
    || communication.intent !== "collaboration"
    || communication.sender.kind !== "agent"
    || communication.audience.kind !== "agents"
  ) return undefined;
  const requestId = communication.correlationId?.trim();
  const sourceCommunicationEventId = communication.causationId?.trim();
  const idempotencyKey = communication.idempotencyKey?.trim();
  if (!requestId || !sourceCommunicationEventId || !idempotencyKey) {
    return undefined;
  }
  const prefix = `request-update:${requestId}:`;
  if (!idempotencyKey.startsWith(prefix)) return undefined;
  const updateId = idempotencyKey.slice(prefix.length);
  if (
    !updateId
    || communication.eventId !== requestUpdateCommunicationEventId(
      communication.projectId,
      requestId,
      updateId,
    )
  ) return undefined;
  return { requestId, updateId, sourceCommunicationEventId };
}

interface RequestUpdateProjectionContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  projectDeletionInProgress(projectId: string): boolean;
  conversationDeletionInProgress(conversationId: string): boolean;
  agentDeletionInProgress(agentId: string): boolean;
  projectCommunicationToAgentAudit(agentId: string, event: CommunicationEvent, text: string): void;
}

/** Complete only an already-authored passive copy. This never sends a handoff
 * or changes its Request, and never reconstructs authored text from a view. */
export function requestUpdateCommunicationProjection(
  context: RequestUpdateProjectionContext,
  identity: Pick<CommunicationEvent, "projectId" | "eventId">,
): {
  event: CommunicationEvent;
  authorAgentId: string;
  conversationId: string;
  targets: string[];
  roomAllowed: boolean;
} | undefined {
  const { store, coordinationV3 } = context;
  const event = store.getCommunicationEvent(identity.projectId, identity.eventId);
  if (!event || event.schemaVersion !== 2 || event.intent !== "collaboration" ||
      event.sender.kind !== "agent" || event.audience.kind !== "agents" ||
      event.audience.agentIds.length !== 1 || !event.conversationId ||
      !event.correlationId || !event.idempotencyKey || !event.text.trim()) return undefined;
  const requestId = event.correlationId;
  const prefix = `request-update:${requestId}:`;
  if (!event.idempotencyKey.startsWith(prefix)) return undefined;
  const updateId = event.idempotencyKey.slice(prefix.length);
  if (!updateId || event.eventId !== requestUpdateCommunicationEventId(event.projectId, requestId, updateId)) return undefined;
  const request = coordinationV3.getRequest(requestId);
  if (!request || request.projectId !== event.projectId || request.conversationId !== event.conversationId) return undefined;
  // The inspector retains only the latest100 updates. Recovery must validate
  // this exact canonical row, including older handoffs outside that UI window.
  const update = store.sqlite.prepare(`
    SELECT u.kind, u.actor_kind, u.actor_id, u.payload_json, u.created_at,
      r.communication_event_id
    FROM coordination_request_updates u JOIN coordination_requests r ON r.id = u.request_id
    WHERE u.request_id = ? AND u.id = ?
  `).get(requestId, updateId) as {
    kind: CoordinationRequestUpdateKind; actor_kind: string; actor_id: string | null;
    payload_json: string; created_at: string; communication_event_id: string | null;
  } | undefined;
  if (!update || !isRequestCommunicationHandoffKind(update.kind) || update.actor_kind !== "agent" ||
      update.actor_id !== event.sender.agentId || update.created_at !== event.createdAt ||
      event.causationId !== (update.communication_event_id ?? undefined)) return undefined;
  const payload = JSON.parse(update.payload_json) as { text?: unknown };
  if (typeof payload.text !== "string" || payload.text.trim() !== event.text) return undefined;
  const peerId = request.recipientAgentId === event.sender.agentId ? request.requesterAgentId
    : request.requesterAgentId === event.sender.agentId ? request.recipientAgentId : undefined;
  if (!peerId || peerId === event.sender.agentId || event.audience.agentIds[0] !== peerId) return undefined;
  const conversation = store.getConversation(event.conversationId);
  if (!store.getProject(event.projectId) || !conversation || conversation.projectId !== event.projectId ||
      context.projectDeletionInProgress(event.projectId) || context.conversationDeletionInProgress(conversation.id)) return undefined;
  const targets = [event.sender.agentId, peerId].filter(agentId => {
    const agent = store.getAgent(agentId);
    return agent && agent.projectId === event.projectId && agent.conversationId === conversation.id &&
      !store.agentCreationPending(agentId) && !context.agentDeletionInProgress(agentId) &&
      store.canProjectCommunication(event.projectId, { eventId: event.eventId, surface: "direct_agent_audit", projectionKey: agentId });
  });
  const roomAllowed = store.canProjectCommunication(event.projectId, {
    eventId: event.eventId, surface: "collaboration_view", projectionKey: conversation.id,
  });
  return { event, authorAgentId: event.sender.agentId, conversationId: conversation.id, targets, roomAllowed };
}

export function materializeRequestUpdateCommunication(
  context: RequestUpdateProjectionContext,
  identity: Pick<CommunicationEvent, "projectId" | "eventId">,
  recoverExistingMetadata?: (event: CommunicationEvent, agentIds: readonly string[]) => void,
): number {
  const plan = requestUpdateCommunicationProjection(context, identity);
  if (!plan) return 0;
  const { event, authorAgentId, conversationId, targets, roomAllowed } = plan;
  const { store } = context;
  const missingRoom = roomAllowed && !store.getProjectedConversationMessageById(conversationId, "collaboration", event.eventId);
  const missingAgents = targets.filter(agentId => store.getCommunicationProjection(event.projectId, event.eventId, "direct_agent_audit", agentId)?.message?.sequence === undefined);
  if (recoverExistingMetadata && (missingRoom || missingAgents.length)) {
    // Reuse durable dispatch/audit records before appending another placement.
    // Only known replay/repair callers take this filtered recovery path.
    recoverExistingMetadata(event, targets);
  }
  let repaired = Number(missingRoom && Boolean(store.getProjectedConversationMessageById(conversationId, "collaboration", event.eventId)))
    + missingAgents.filter(agentId => store.getCommunicationProjection(event.projectId, event.eventId, "direct_agent_audit", agentId)?.message?.sequence !== undefined).length;
  if (roomAllowed && !store.getProjectedConversationMessageById(conversationId, "collaboration", event.eventId)) {
    store.appendConversationMessage(conversationId, { role: "assistant", text: event.text },
      authorAgentId, "collaboration", undefined, undefined, event.eventId);
    repaired += 1;
  }
  for (const agentId of targets) {
    if (store.getCommunicationProjection(event.projectId, event.eventId, "direct_agent_audit", agentId)?.message?.sequence !== undefined) continue;
    context.projectCommunicationToAgentAudit(agentId, event, event.text);
    repaired += 1;
  }
  return repaired;
}
