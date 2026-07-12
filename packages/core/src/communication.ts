/** Canonical communication contracts shared by persistence, routing, and UI. */

export type CommunicationIntent = "broadcast" | "direct_to_user" | "collaboration";

export type CommunicationActor =
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string; executionId?: string }
  | { kind: "system"; component: string };

interface CommunicationEventBase {
  eventId: string;
  schemaVersion: 1;
  projectId: string;
  /** Workstream of origin; event identity remains project-global. */
  masterChatId?: string;
  sender: CommunicationActor;
  text: string;
  createdAt: string;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
}

/** Runtime validation must additionally reject empty collaboration audiences. */
export type CommunicationEventV1 = CommunicationEventBase & (
  | { intent: "broadcast"; audience: { kind: "organization"; organizationId: string } }
  | { intent: "direct_to_user"; audience: { kind: "user"; userId: string } }
  | { intent: "collaboration"; audience: { kind: "agents"; agentIds: [string, ...string[]] } }
);

export type CommunicationEvent = CommunicationEventV1;

export type CommunicationProjectionSurface =
  | "master_chat"
  | "collaboration_chat"
  | "direct_agent_audit"
  | "agent_inbox"
  | "user_inbox";

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
    authorAgentId?: string;
    replyToLegacyMessageId?: string;
    attachmentIds?: string[];
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
  authorAgentId?: string;
  replyToLegacyMessageId?: string;
  attachmentIds?: string[];
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

export type CommunicationContextPolicy = "local_only" | "organizational_candidate";

/** Context eligibility is explicit and independent of projection visibility. */
export interface CommunicationContextClassification {
  eventId: string;
  policy: CommunicationContextPolicy;
  classifiedAt: string;
  classifiedBy: CommunicationActor;
}

/** Append-only authorization to expose selected local knowledge organizationally. */
export interface KnowledgePromotion {
  promotionId: string;
  sourceEventId: string;
  organizationId: string;
  summary: string;
  promotedBy: CommunicationActor;
  promotedAt: string;
  supersedesPromotionId?: string;
  expiresAt?: string;
  idempotencyKey?: string;
}

export interface CreateKnowledgePromotionRequest {
  sourceEventId: string;
  summary: string;
  idempotencyKey: string;
  expiresAt?: string;
}

export interface CreateKnowledgePromotionResponse {
  promotion: KnowledgePromotion;
  replayed: boolean;
}

/** Shadow-migration parity report computed from canonical disk records. */
export interface CommunicationReconciliationReport {
  projectId: string;
  canonicalEvents: number;
  linkedProjections: number;
  missingProjectionEventIds: string[];
  duplicateProjectionEventIds: string[];
  orphanProjectionEventIds: string[];
  missingClassificationEventIds: string[];
  missingProjectionMetadataEventIds: string[];
  ok: boolean;
}
