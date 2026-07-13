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
  assignmentId?: string;
  createdAt: string;
}

export type CommunicationDocumentReference = Omit<CommunicationDocumentRecord, "content"> & {
  previewUrl: string;
  downloadUrl: string;
};

interface CommunicationEventBase {
  eventId: string;
  schemaVersion: 1;
  projectId: string;
  /** Workstream of origin; event identity remains project-global. */
  masterChatId?: string;
  sender: CommunicationActor;
  text: string;
  document?: CommunicationDocumentRecord;
  createdAt: string;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
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
    /** Direct-audit ordering key from the canonical thread log. */
    sequence?: number;
    authorAgentId?: string;
    replyToLegacyMessageId?: string;
    attachmentIds?: string[];
    /** Immutable snapshots required to retire legacy chat storage reads. */
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
  sequence?: number;
  authorAgentId?: string;
  replyToLegacyMessageId?: string;
  attachmentIds?: string[];
  replyTo?: MessageReferenceDto;
  attachments?: ImageAttachmentDto[];
  document?: CommunicationDocumentReference;
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
  /** Legacy room rows that cannot yet be served from a canonical event. */
  unlinkedLegacyMessageIds: string[];
  /** Linked room rows whose authoritative materialization is not DTO-equivalent. */
  projectionReadMismatchMessageIds: string[];
  ok: boolean;
}
