import { randomUUID } from "node:crypto";
import {
  publicProviderFailureSummary,
  type AssetDto,
  type CommunicationEvent,
  type ConversationMessageDto,
} from "@ponderosa/core";
import type {
  AgentStore,
  CoordinationV3Store,
  ConversationDeliveryIntent,
  StoredLogEvent,
  WorkspaceStore,
} from "@ponderosa/agents";
import type { Subscriber } from "./app-contracts.js";
import {
  advanceMentionTrail,
  mentionRelayFingerprint,
  renderScopedMessage,
} from "./agent-mentions.js";
import { workspaceAgentEventCategory } from "./notification-routing.js";

interface AgentEventServiceContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  subscribers: Map<string, Set<Subscriber>>;
  recordCommunication(event: CommunicationEvent): CommunicationEvent;
  refreshProviderUsageAfterRun(engineId: string): void;
  appendWorkspace(event: Parameters<WorkspaceStore["append"]>[0]): unknown;
  notifyScheduler(): void;
  isClosed(): boolean;
  publishCoordinationV3Changed(
    agentId: string,
    options?: { conversationIds?: string[] },
  ): void;
}

export function createAgentEventService(context: AgentEventServiceContext) {
  const {
    store,
    coordinationV3,
    subscribers,
    recordCommunication,
    refreshProviderUsageAfterRun,
    appendWorkspace,
    notifyScheduler,
    isClosed,
    publishCoordinationV3Changed,
  } = context;

  function publish(agentId: string, stored: StoredLogEvent): void {
    for (const subscriber of subscribers.get(agentId) ?? []) subscriber(stored);
    const agent = store.getAgent(agentId);
    if (!agent) return;
    const event = stored.event;
    const category = workspaceAgentEventCategory(event);
    if (event.type === "turn_done") {
      refreshProviderUsageAfterRun(agent.activeEngine);
      appendWorkspace({
        type: "usage_changed",
        projectId: agent.projectId,
        agentId,
        conversationIds: [agent.conversationId],
        seq: stored.seq,
        ...(("executionId" in event && typeof event.executionId === "string") ? { executionId: event.executionId } : {}),
      });
      return;
    }
    if (!category) return;
    appendWorkspace({
      type: "agent_event",
      projectId: agent.projectId,
      agentId,
      conversationIds: [agent.conversationId],
      seq: stored.seq,
      eventType: event.type,
      category,
      ...("executionId" in event && typeof event.executionId === "string" ? { executionId: event.executionId } : {}),
    });
  }

  function projectBroadcastToAgentAudit(
    agentId: string,
    event: Extract<CommunicationEvent, { intent: "broadcast" }>,
    attachments?: AssetDto[],
  ): void {
    if (store.getCommunicationProjection(
      event.projectId,
      event.eventId,
      "direct_agent_audit",
      agentId,
    )?.message) return;
    const role = event.sender.kind === "user" ? "user" : event.sender.kind === "system" ? "system" : "assistant";
    const stored = store.appendEvent(agentId, {
      type: "communication_projection",
      communicationEventId: event.eventId,
      text: renderScopedMessage("broadcast", event.text),
      role,
      attachments,
    });
    publish(agentId, stored);
  }

  function projectBroadcastToAgentAudits(
    event: Extract<CommunicationEvent, { intent: "broadcast" }>,
    excludedAgentIds: Iterable<string> = [],
    attachments?: AssetDto[],
  ): void {
    const excluded = new Set(excludedAgentIds);
    // A Broadcast is shared through its Conversation context, not copied into
    // every agent's private history. Only its actual agent author owns a local
    // audit projection; user/system broadcasts have no individual author.
    if (event.sender.kind !== "agent" || excluded.has(event.sender.agentId)) return;
    const author = store.getAgent(event.sender.agentId);
    if (author) projectBroadcastToAgentAudit(author.id, event, attachments);
  }

  /** Materialize canonical Communication in the Agent audit log. The
   * presentation-only communication_projection supplies the stable sequence
   * required by Agent Chat; V3 Activations remain the actionable prompt and
   * prevent this audit copy from becoming a second provider handoff. */
  function projectCommunicationToAgentAudit(
    agentId: string,
    event: CommunicationEvent,
    renderedText: string,
    attachments?: AssetDto[],
  ): void {
    const existing = store.getCommunicationProjection(
      event.projectId,
      event.eventId,
      "direct_agent_audit",
      agentId,
    );
    if (existing?.message?.sequence !== undefined) {
      if (attachments?.length && !existing.message.attachments?.length) {
        store.appendCommunicationProjection(event.projectId, {
          ...existing,
          message: { ...existing.message, attachments },
        });
      }
      return;
    }
    const stored = store.appendEvent(agentId, {
      type: "communication_projection",
      communicationEventId: event.eventId,
      text: renderedText,
      role: event.sender.kind === "user" ? "user" : event.sender.kind === "system" ? "system" : "assistant",
      ...(attachments?.length ? { attachments } : {}),
    });
    publish(agentId, stored);
  }

  function subscribe(agentId: string, subscriber: Subscriber): () => void {
    let set = subscribers.get(agentId);
    if (!set) {
      set = new Set();
      subscribers.set(agentId, set);
    }
    set.add(subscriber);
    return () => {
      set?.delete(subscriber);
      if (set?.size === 0) subscribers.delete(agentId);
    };
  }

  function resolveExplicitCollaborationIntents(
    conversationId: string,
    authorAgentId: string,
    recipientAgentIds: string[],
    text: string,
    _relayDepth: number,
    mentionTrail: string[],
  ): { text: string; intents: ConversationDeliveryIntent[]; error?: string } {
    const detail = store.getCollaborationViewDetail(conversationId);
    const members = new Map((detail?.agents ?? []).map((agent) => [agent.id, agent]));
    const targetIds = [...new Set(recipientAgentIds)];
    const targets = targetIds.map((id) => members.get(id));
    if (targets.some((target) => !target || target.id === authorAgentId)) {
      return { text, intents: [], error: "every collaboration recipient must be a different active agent in this conversation" };
    }
    const renderedText = `${targets.map((target) => `#${target!.handle}`).join(" ")} ${text}`;
    const intents: ConversationDeliveryIntent[] = [];
    for (const target of targets) {
      const fingerprint = mentionRelayFingerprint(authorAgentId, target!.id, renderedText);
      if (mentionTrail.includes(fingerprint)) {
        return { text, intents: [], error: "the same collaboration handoff already occurred in this delivery chain" };
      }
      const nextTrail = advanceMentionTrail(mentionTrail, fingerprint);
      intents.push({
        targetAgentId: target!.id,
        relayDepth: nextTrail.length,
        mentionTrail: nextTrail,
        kind: "tag",
        audience: "mention",
      });
    }
    return { text: renderedText, intents };
  }

  function appendBlockedMentionWarnings(
    conversationId: string,
    blocked: Array<{ handle: string; reason: string }>,
  ): void {
    for (const item of blocked) {
      appendCollaborationSystemNotice(
        conversationId,
        `⚠️ #${item.handle} was not notified because ${item.reason}. Please ask the manager to continue the conversation.`,
      );
    }
  }

  function appendCollaborationSystemNotice(
    conversationId: string,
    text: string,
    idempotencyKey?: string,
  ): ConversationMessageDto | undefined {
    const master = store.getConversation(conversationId);
    if (!master) return undefined;
    const communication = recordCommunication({
      eventId: randomUUID(), schemaVersion: 2, projectId: master.projectId, conversationId,
      sender: { kind: "system", component: "collaboration-supervision" },
      intent: "user_dm", audience: { kind: "user", userId: "local-operator" },
      text, createdAt: new Date().toISOString(), ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    const existing = communication
      ? store.getConversationMessages(conversationId, "collaboration").find((message) => message.communicationEventId === communication.eventId)
      : undefined;
    if (existing) return existing;
    return store.appendConversationMessage(
      conversationId, { role: "system", text }, undefined, "collaboration", undefined, undefined, communication?.eventId,
    );
  }

  function notifyManagerOfChildFailure(childAgentId: string, executionId: string, failure: string): void {
    if (isClosed()) return;
    const child = store.getAgent(childAgentId);
    const manager = child?.managerAgentId ? store.getAgent(child.managerAgentId) : undefined;
    if (!child || !manager) return;
    // The attached Request and optional Join are the canonical failure
    // handoff. If this manager requested this exact Run, failing it will already
    // terminalize that Request and wake the manager once.
    const correlatedManagerOutcome = coordinationV3
      .requestIdsAttachedToRun(executionId, child.id)
      .some((requestId) => coordinationV3.getRequest(requestId)?.requesterAgentId === manager.id);
    if (correlatedManagerOutcome) return;
    // Raw provider evidence belongs to the fenced Run audit record, never
    // manager-visible runtime communication or Activation payloads.
    const publicFailure = publicProviderFailureSummary(failure) ?? "Provider execution failed.";
    const createdAt = new Date().toISOString();
    const id = `managed-agent:${child.id}:${executionId}:failure`;
    const text = [
        "Internal managed-agent update (not a chat message).",
        `${child.title} (${child.id}) encountered a runtime failure during execution ${executionId}.`,
        `Failure: ${publicFailure}`,
        "The agent remains in your organization and can be steered or retried.",
      ].join("\n");
    const sharedConversationId = child.conversationId
      && manager.conversationId === child.conversationId
      ? child.conversationId
      : undefined;
    coordinationV3.recordRuntimeCommunication({
      id,
      projectId: child.projectId,
      sender: { kind: "system", component: "runtime-supervisor" },
      intent: "managed_child_failure",
      audience: { kind: "agents", agentIds: [manager.id] },
      payload: { text, childAgentId: child.id, executionId, failure: publicFailure },
      scopeKey: sharedConversationId
        ? `conversation:${sharedConversationId}`
        : `agent:${manager.id}`,
      activation: {
        agentId: manager.id,
        kind: "managed_child_failure",
        priority: 90,
        dispatchPolicy: "steer_or_run",
        promptClass: "blocker",
      },
      now: createdAt,
    });
    try {
      publishCoordinationV3Changed(manager.id, {
        conversationIds: sharedConversationId ? [sharedConversationId] : [],
      });
      notifyScheduler();
    } catch {
      // The failure communication and Activation are already canonical.
    }
  }

  return {
    appendBlockedMentionWarnings,
    appendCollaborationSystemNotice,
    notifyManagerOfChildFailure,
    projectBroadcastToAgentAudit,
    projectBroadcastToAgentAudits,
    projectCommunicationToAgentAudit,
    publish,
    resolveExplicitCollaborationIntents,
    subscribe,
  };
}
