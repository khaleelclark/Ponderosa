/** Canonical communication contracts shared by persistence, routing, and UI. */

import type { ImageAttachmentDto } from "./dto.js";

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
  /** Legacy/small inline body. Artifact-backed documents omit this copy. */
  content?: string;
  artifactId?: string;
  byteLength: number;
  authorAgentId?: string;
  authorUserId?: string;
  executionId?: string;
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
export type CommunicationAudience = CommunicationEvent["audience"];

const communicationIntentValues: ReadonlySet<string> = new Set<CommunicationIntent>([
  "broadcast",
  "direct_to_user",
  "collaboration",
  "user_dm",
]);

function communicationRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonEmptyStringArray(value: unknown): value is [string, ...string[]] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

/** Structural runtime guard for the canonical authored-identity union. */
export function isCommunicationActor(value: unknown): value is CommunicationActor {
  const actor = communicationRecord(value);
  if (!actor || !nonEmptyString(actor.kind)) return false;
  if (actor.kind === "user") return nonEmptyString(actor.userId);
  if (actor.kind === "agent") {
    return nonEmptyString(actor.agentId) &&
      (actor.executionId === undefined || nonEmptyString(actor.executionId));
  }
  return actor.kind === "system" && nonEmptyString(actor.component);
}

/** Structural runtime guard for every canonical audience discriminator. */
export function isCommunicationAudience(value: unknown): value is CommunicationAudience {
  const audience = communicationRecord(value);
  if (!audience || !nonEmptyString(audience.kind)) return false;
  if (audience.kind === "organization") return nonEmptyString(audience.organizationId);
  if (audience.kind === "user") return nonEmptyString(audience.userId);
  if (audience.kind === "agents") return nonEmptyStringArray(audience.agentIds);
  if (audience.kind === "user_agent") {
    return nonEmptyString(audience.userId) && nonEmptyString(audience.agentId);
  }
  return audience.kind === "user_agents" && nonEmptyString(audience.userId) &&
    nonEmptyStringArray(audience.agentIds);
}

/**
 * Validate the required structural fields and correlated discriminators of one
 * canonical Communication. Project membership and conversation authority remain
 * persistence concerns and are checked transactionally by the owning store.
 */
export function isCommunicationEvent(value: unknown): value is CommunicationEvent {
  const event = communicationRecord(value);
  if (!event || (event.schemaVersion !== 1 && event.schemaVersion !== 2) ||
      !nonEmptyString(event.eventId) || !nonEmptyString(event.projectId) ||
      (event.conversationId !== undefined && !nonEmptyString(event.conversationId)) ||
      !isCommunicationActor(event.sender) || !nonEmptyString(event.intent) ||
      !communicationIntentValues.has(event.intent) || !isCommunicationAudience(event.audience) ||
      typeof event.text !== "string" || !nonEmptyString(event.createdAt)) return false;

  const audience = event.audience;
  if (event.schemaVersion === 1) {
    return (event.intent === "broadcast" && audience.kind === "organization") ||
      (event.intent === "direct_to_user" && audience.kind === "user") ||
      (event.intent === "collaboration" && audience.kind === "agents");
  }
  return (event.intent === "broadcast" && audience.kind === "organization") ||
    (event.intent === "user_dm" && (audience.kind === "user_agent" || audience.kind === "user_agents")) ||
    (event.intent === "collaboration" && audience.kind === "agents");
}

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
    attachments?: ImageAttachmentDto[];
  };
}

export interface ProjectedCommunicationMessage {
  eventId: string;
  conversationId?: string;
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
  attachments?: ImageAttachmentDto[];
  document?: CommunicationDocumentReference;
  citations?: VerifiedCitationRecord[];
  executionId?: string;
  correctionOfEventId?: string;
  editedAt?: string;
  editRevision?: number;
}

export type CommunicationContextPolicy = "local_only" | "organizational";

/** Integrity report computed entirely from canonical communication records. */
export interface CommunicationReconciliationReport {
  projectId: string;
  canonicalEvents: number;
  linkedProjections: number;
  missingProjectionEventIds: string[];
  duplicateProjectionEventIds: string[];
  orphanProjectionEventIds: string[];
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
