/** Canonical communication contracts shared by persistence, routing, and UI. */

import type { ImageAttachmentDto, MessageReferenceDto } from "./dto.js";

export type CommunicationIntent = "broadcast" | "direct_to_user" | "collaboration" | "user_dm";

export type CommunicationActor =
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string; executionId?: string }
  | { kind: "system"; component: string };

/** Long-form Markdown owned by exactly one immutable communication event. */
export interface CommunicationDocumentRecord {
  id: string;
  title: string;
  mediaType: "text/markdown";
  content: string;
  byteLength: number;
  authorAgentId: string;
  executionId: string;
  createdAt: string;
}

export type CommunicationDocumentReference = Omit<CommunicationDocumentRecord, "content"> & {
  previewUrl: string;
  downloadUrl: string;
};

/** Citation metadata accepted only after server-side URL/title normalization. */
export interface VerifiedCitationRecord {
  url: string;
  title: string;
  verifiedAt: string;
}

interface CommunicationEventBase {
  eventId: string;
  schemaVersion: 1;
  projectId: string;
  /** Workstream of origin; event identity remains project-global. */
  conversationId?: string;
  sender: CommunicationActor;
  text: string;
  /** Immutable, server-validated artifact references authored with this event. */
  attachments?: ImageAttachmentDto[];
  document?: CommunicationDocumentRecord;
  citations?: VerifiedCitationRecord[];
  createdAt: string;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
  /** Immutable link from an operator correction to the original communication. */
  correctionOfEventId?: string;
  /** Auditable selector used when a collaboration audience was resolved. */
  audienceSelector?: "mention" | "everyone";
  /** Durable send-time labels are display fallback only; IDs remain authoritative. */
  identity?: {
    senderLabel: string;
    recipientLabels?: Record<string, string>;
  };
}

/** Runtime validation must additionally reject empty collaboration audiences. */
export type CommunicationEventV1 = CommunicationEventBase & (
  | { intent: "broadcast"; audience: { kind: "organization"; organizationId: string } }
  | { intent: "direct_to_user"; audience: { kind: "user"; userId: string } }
  | { intent: "collaboration"; audience: { kind: "agents"; agentIds: [string, ...string[]] } }
);

/**
 * V2 makes a user DM genuinely bidirectional. A user-authored DM may address
 * one or more explicit stable agents; an agent-authored DM remains between that
 * agent and the local user.
 */
export type CommunicationEventV2 = Omit<CommunicationEventBase, "schemaVersion"> & {
  schemaVersion: 2;
} & (
  | { intent: "broadcast"; audience: { kind: "organization"; organizationId: string } }
  | { intent: "user_dm"; audience:
      | { kind: "user_agent"; userId: string; agentId: string }
      | { kind: "user_agents"; userId: string; agentIds: [string, ...string[]] } }
  | { intent: "collaboration"; audience: { kind: "agents"; agentIds: [string, ...string[]] } }
);

/** V1 is retained for append-only replay; all new communication uses V2. */
export type CommunicationEvent = CommunicationEventV1 | CommunicationEventV2;

/**
 * Append-only replacement text for one immutable communication. The original
 * event continues to own scope, audience, attachments, and send provenance.
 * Revisions are presentation/context projection inputs only: they never create
 * deliveries or wake a runtime.
 */
export interface CommunicationRevisionEvent {
  eventId: string;
  schemaVersion: 1;
  kind: "edit";
  projectId: string;
  conversationId: string;
  targetEventId: string;
  sender: CommunicationActor;
  text: string;
  createdAt: string;
  idempotencyKey: string;
}

export type CommunicationProjectionSurface =
  | "conversation"
  | "collaboration_view"
  | "direct_agent_audit"
  | "agent_inbox"
  | "user_inbox";

export type CommunicationRecipient =
  | { kind: "agent"; agentId: string }
  | { kind: "user"; userId: string };

/**
 * The complete, deterministic routing result for one canonical communication.
 *
 * This is deliberately independent of HTTP routes, rendered tags, and chat
 * rooms. Every adapter and projection writer must consume this policy instead
 * of re-interpreting intent locally.
 */
export interface CommunicationBehavior {
  contextPolicy: CommunicationContextPolicy;
  projectionTargets: Array<{
    surface: CommunicationProjectionSurface;
    projectionKey: string;
  }>;
  deliveryRecipients: CommunicationRecipient[];
  /** Agent recipients for which the authored event is actionable. */
  actionableAgentIds: string[];
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function eventAgentIds(event: CommunicationEvent): string[] {
  if (event.intent === "collaboration") return uniqueSorted(event.audience.agentIds);
  if (event.schemaVersion === 2 && event.intent === "user_dm") {
    return uniqueSorted(event.audience.kind === "user_agent"
      ? [event.audience.agentId]
      : event.audience.agentIds);
  }
  return [];
}

function eventUserId(event: CommunicationEvent): string | undefined {
  if (event.schemaVersion === 2 && event.intent === "user_dm") return event.audience.userId;
  if (event.schemaVersion === 1 && event.intent === "direct_to_user") return event.audience.userId;
  return undefined;
}

/**
 * Executable communication behavior matrix. The returned ordering is stable so
 * it can be snapshot-tested and used to materialize projections idempotently.
 */
export function deriveCommunicationBehavior(event: CommunicationEvent): CommunicationBehavior {
  const projectionTargets: CommunicationBehavior["projectionTargets"] = [];
  const agentIds = eventAgentIds(event);
  const userId = eventUserId(event);
  const addProjection = (surface: CommunicationProjectionSurface, projectionKey?: string) => {
    if (projectionKey && !projectionTargets.some((item) => item.surface === surface && item.projectionKey === projectionKey)) {
      projectionTargets.push({ surface, projectionKey });
    }
  };

  if (event.intent === "broadcast") {
    addProjection("conversation", event.conversationId);
    if (event.sender.kind === "agent") addProjection("direct_agent_audit", event.sender.agentId);
  } else if (event.schemaVersion === 2 && event.intent === "user_dm") {
    addProjection("conversation", event.conversationId);
    for (const agentId of agentIds) {
      addProjection("direct_agent_audit", agentId);
      if (event.sender.kind === "user") addProjection("agent_inbox", agentId);
    }
    addProjection("user_inbox", userId);
  } else if (event.intent === "collaboration") {
    addProjection("collaboration_view", event.conversationId);
    if (event.sender.kind === "agent") addProjection("direct_agent_audit", event.sender.agentId);
    for (const agentId of agentIds) {
      addProjection("direct_agent_audit", agentId);
      addProjection("agent_inbox", agentId);
    }
  } else {
    // V1 direct_to_user is replay-only. Preserve its historical placements,
    // while all new bidirectional user communication uses V2 user_dm.
    addProjection("conversation", event.conversationId);
    addProjection("collaboration_view", event.conversationId);
    if (event.sender.kind === "agent") addProjection("direct_agent_audit", event.sender.agentId);
    addProjection("user_inbox", userId);
  }

  const deliveryRecipients: CommunicationRecipient[] = [];
  const actionableAgentIds: string[] = [];
  if (event.intent === "collaboration") {
    for (const agentId of agentIds) {
      deliveryRecipients.push({ kind: "agent", agentId });
      actionableAgentIds.push(agentId);
    }
  } else if (event.schemaVersion === 2 && event.intent === "user_dm") {
    if (event.sender.kind === "user") {
      for (const agentId of agentIds) {
        deliveryRecipients.push({ kind: "agent", agentId });
        actionableAgentIds.push(agentId);
      }
    } else if (userId) {
      deliveryRecipients.push({ kind: "user", userId });
    }
  } else if (event.schemaVersion === 1 && event.intent === "direct_to_user" && userId) {
    deliveryRecipients.push({ kind: "user", userId });
  }

  return {
    contextPolicy: event.intent === "broadcast" ? "organizational" : "local_only",
    projectionTargets,
    deliveryRecipients,
    actionableAgentIds: uniqueSorted(actionableAgentIds),
  };
}

export function communicationHasProjectionTarget(
  event: CommunicationEvent,
  surface: CommunicationProjectionSurface,
  projectionKey: string,
): boolean {
  return deriveCommunicationBehavior(event).projectionTargets.some((target) =>
    target.surface === surface && target.projectionKey === projectionKey);
}

/** Rebuildable placement; unique by (eventId, surface, projectionKey). */
export interface CommunicationProjection {
  eventId: string;
  surface: CommunicationProjectionSurface;
  projectionKey: string;
  projectedAt: string;
  /** Later append-only revisions may enrich pre-cutover placement-only records. */
  revision?: number;
  /** Deterministic materialization metadata; the canonical event still owns text. */
  message?: {
    messageId: string;
    role: "user" | "assistant" | "system";
    /** Server-rendered text may add display handles without changing event text. */
    renderedText?: string;
    createdAt: string;
    /** Stable per-project materialization order for identical timestamps. */
    orderKey?: string;
    /** Direct-audit ordering key from the canonical agent log. */
    sequence?: number;
    authorAgentId?: string;
    attachmentIds?: string[];
    /** Immutable presentation snapshots owned by the canonical projection. */
    replyTo?: MessageReferenceDto;
    attachments?: ImageAttachmentDto[];
  };
}

export interface ProjectedCommunicationMessage {
  eventId: string;
  surface: CommunicationProjectionSurface;
  projectionKey: string;
  messageId: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  orderKey?: string;
  sequence?: number;
  authorAgentId?: string;
  attachmentIds?: string[];
  replyTo?: MessageReferenceDto;
  attachments?: ImageAttachmentDto[];
  document?: CommunicationDocumentReference;
  citations?: VerifiedCitationRecord[];
  executionId?: string;
  correctionOfEventId?: string;
  editedAt?: string;
  editRevision?: number;
}

export type CommunicationDeliveryStatus =
  | "accepted"
  | "routed"
  | "available"
  | "claimed"
  | "acknowledged"
  | "processed"
  | "failed";

/** Mutable operational state, deliberately outside the immutable event. */
export interface CommunicationDelivery {
  eventId: string;
  recipient: { kind: "agent"; agentId: string } | { kind: "user"; userId: string };
  status: CommunicationDeliveryStatus;
  attempt: number;
  updatedAt: string;
  failure?: { code: string; message: string; retryable: boolean };
}

export type CommunicationContextPolicy = "local_only" | "organizational";

/** Context eligibility is derived once from the event's immutable intent. */
export interface CommunicationContextClassification {
  eventId: string;
  policy: CommunicationContextPolicy;
  classifiedAt: string;
  classifiedBy: CommunicationActor;
}

/** Integrity report computed entirely from canonical communication records. */
export interface CommunicationReconciliationReport {
  projectId: string;
  canonicalEvents: number;
  linkedProjections: number;
  missingProjectionEventIds: string[];
  duplicateProjectionEventIds: string[];
  orphanProjectionEventIds: string[];
  missingClassificationEventIds: string[];
  missingProjectionMetadataEventIds: string[];
  orphanRuntimeCommunicationEventIds: string[];
  orphanRequestCommunicationEventIds: string[];
  runtimePayloadConflicts: Array<{
    eventId: string;
    canonicalHash: string;
    runtimeHash: string;
  }>;
  ok: boolean;
}
