import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  communicationHasProjectionTarget,
  type AgentDto,
  type ArtifactDto,
  type CommunicationAttachmentDto,
  type CommunicationEvent,
  type CommunicationProjection,
  type CommunicationReconciliationReport,
  type CommunicationRevisionEvent,
  type ConversationDto,
  type ProjectDto,
  type ProjectedCommunicationMessage,
} from "@ponderosa/core";
import { appendFsyncedJsonl } from "./append-jsonl.js";
import {
  communicationDocumentReference,
  communicationMessageProjection,
  revisedRenderedText,
} from "./store-communication.js";
import { communicationProjectionsPath } from "./paths.js";
import type { StoredLogEvent } from "./log-event.js";
import type { MessageDispatchRecord } from "./store-types.js";

type CommunicationIndex = {
  events: CommunicationEvent[];
  byId: Map<string, CommunicationEvent>;
};

type CommunicationRevisionIndex = {
  revisions: CommunicationRevisionEvent[];
  byId: Map<string, CommunicationRevisionEvent>;
  byIdempotency: Map<string, CommunicationRevisionEvent>;
  byTarget: Map<string, CommunicationRevisionEvent[]>;
};

type ProjectionIndex = {
  projections: CommunicationProjection[];
  byTuple: Map<string, CommunicationProjection>;
};

export interface CommunicationProjectionRecoveryFilter {
  eventIds: ReadonlySet<string>;
  agentIds: ReadonlySet<string>;
}

export class AgentCommunicationProjectionLedger {
  private managedArtifactAttachmentMetadataAuthority?: (
    projectId: string,
    artifact: ArtifactDto,
  ) => boolean;
  private suppressReplaySearchRefresh = false;

  constructor(
    private readonly dataDir: string,
    private readonly client: Database.Database,
    private readonly getProject: (projectId: string) => ProjectDto | undefined,
    private readonly getConversation: (
      conversationId: string,
    ) => ConversationDto | undefined,
    private readonly getAgent: (agentId: string) => AgentDto | undefined,
    private readonly listAgents: (projectId: string) => AgentDto[],
    private readonly readEvents: (agentId: string) => StoredLogEvent[],
    private readonly readCommunicationEvents: (
      projectId: string,
    ) => CommunicationEvent[],
    private readonly communicationIndex: (
      projectId: string,
    ) => CommunicationIndex,
    private readonly communicationRevisionIndex: (
      projectId: string,
    ) => CommunicationRevisionIndex,
    private readonly projectionIndex: (projectId: string) => ProjectionIndex,
    private readonly messageDispatches: (
      projectId: string,
    ) => MessageDispatchRecord[],
    private readonly ensureCommunicationBehaviorProjections: (
      event: CommunicationEvent,
    ) => void,
    private readonly upsertGlobalChatSearchProjection: (
      projectId: string,
      projection: CommunicationProjection,
    ) => void,
    private readonly encodeHistoryCursor: (input: {
      stream: string;
      scope: string;
      orderKey: string;
      rowKey: string;
    }) => string,
    private readonly decodeHistoryCursor: (
      cursor: string,
      stream: string,
      scope: string,
    ) => { orderKey: string; rowKey: string },
    private readonly resolveManagedArtifactAttachments: (
      projectId: string,
      artifactIds: readonly string[],
      metadataAuthority?: (projectId: string, artifact: ArtifactDto) => boolean,
    ) => CommunicationAttachmentDto[],
  ) {}

  configureManagedArtifactAttachmentMetadataAuthority(
    authority: (projectId: string, artifact: ArtifactDto) => boolean,
  ): void {
    this.managedArtifactAttachmentMetadataAuthority = authority;
  }

  communicationProjectionAllowed(
    projectId: string,
    projection: Pick<CommunicationProjection, "eventId" | "surface" | "projectionKey" | "message">,
  ): boolean {
    const event = this.communicationIndex(projectId).byId.get(projection.eventId);
    if (!event) throw new Error("communication projection source event not found");
    // Deleted rooms are hard context boundaries. Their retained append-only
    // records are historical storage only and may not materialize anywhere.
    if (event.conversationId && !this.getConversation(event.conversationId)) return false;
    const roomKeyAllowed = event.conversationId === projection.projectionKey && (() => {
      const room = this.getConversation(projection.projectionKey);
      return Boolean(room && room.projectId === projectId);
    })();
    // A user-authored Project message remains an organization-scoped
    // Broadcast. Its exact responsible Agents are canonical Activation
    // recipients in SQLite, not members of the immutable Broadcast audience.
    const runtimeRecipientAllowed = event.intent === "broadcast" &&
      event.sender.kind === "user" &&
      projection.surface === "direct_agent_audit" &&
      Boolean(this.client.prepare(`
        SELECT 1
        FROM activation_sources source
        JOIN agent_activations activation ON activation.id = source.activation_id
        JOIN runtime_communications communication ON communication.id = source.source_id
        WHERE source.source_kind = 'communication'
          AND communication.project_id = ?
          AND activation.project_id = communication.project_id
          AND activation.agent_id = ?
          AND (source.source_id = ? OR json_extract(communication.payload_json, '$.communication.eventId') = ?)
        LIMIT 1
      `).get(projectId, projection.projectionKey, event.eventId, event.eventId));
    const targetAllowed = runtimeRecipientAllowed ||
      communicationHasProjectionTarget(event, projection.surface, projection.projectionKey);
    if (targetAllowed) {
      if (projection.surface === "conversation" || projection.surface === "collaboration_view") return roomKeyAllowed;
      if (projection.surface === "direct_agent_audit" || projection.surface === "agent_inbox") {
        const agent = this.getAgent(projection.projectionKey);
        return Boolean(agent && agent.projectId === projectId);
      }
      return true;
    }
    return false;
  }

  appendCommunicationProjection(projectId: string, projection: CommunicationProjection): { projection: CommunicationProjection; replayed: boolean } {
    if (!this.communicationProjectionAllowed(projectId, projection)) {
      throw new Error("communication scope cannot project to requested surface");
    }
    const file = communicationProjectionsPath(this.dataDir, projectId);
    const index = this.projectionIndex(projectId);
    const tuple = `${projection.eventId}\u0000${projection.surface}\u0000${projection.projectionKey}`;
    const existing = index.byTuple.get(tuple);
    if (existing) {
      if (existing.message && projection.message) {
        const existingText = existing.message.renderedText ?? "";
        const projectionText = projection.message.renderedText ?? "";
        const canonicalText = this.communicationIndex(projectId).byId.get(projection.eventId)?.text;
        const hasStrictRoutingPrefix = (renderedText: string): boolean => {
          if (!canonicalText || !renderedText.endsWith(canonicalText)) return false;
          const routingPrefix = renderedText.slice(0, -canonicalText.length);
          return /^#[\p{L}\p{N}_-]+(?: #[\p{L}\p{N}_-]+)* $/u.test(routingPrefix);
        };
        const sameCanonicalAuditMaterialization = projection.surface === "direct_agent_audit"
          && canonicalText !== undefined
          && canonicalText.length > 0
          && ((existingText === canonicalText && hasStrictRoutingPrefix(projectionText))
            || (projectionText === canonicalText && hasStrictRoutingPrefix(existingText)));
        const sameMaterialization = existing.message.role === projection.message.role
          && (existingText === projectionText || sameCanonicalAuditMaterialization);
        if (!sameMaterialization) {
          throw new Error("communication projection metadata collision");
        }
      }
      if (!existing.message && projection.message) {
        const enriched = {
          ...existing,
          revision: (existing.revision ?? 1) + 1,
          message: projection.message,
        };
        appendFsyncedJsonl(file, [enriched]);
        const position = index.projections.findIndex((candidate) => candidate === existing);
        if (position >= 0) index.projections[position] = enriched;
        index.byTuple.set(tuple, enriched);
        this.upsertGlobalChatSearchProjection(projectId, enriched);
        return { projection: enriched, replayed: false };
      }
      if (existing.message && projection.message) {
        const enrichedMessage = {
          ...existing.message,
          ...(existing.message.sequence === undefined && projection.message.sequence !== undefined
            ? { sequence: projection.message.sequence }
            : {}),
          ...(!existing.message.authorAgentId && projection.message.authorAgentId
            ? { authorAgentId: projection.message.authorAgentId }
            : {}),
          ...(!existing.message.attachmentIds?.length && projection.message.attachmentIds?.length
            ? { attachmentIds: projection.message.attachmentIds }
            : {}),
          ...(!existing.message.attachments?.length && projection.message.attachments?.length
            ? { attachments: projection.message.attachments }
            : {}),
        };
        if (JSON.stringify(enrichedMessage) !== JSON.stringify(existing.message)) {
          const enriched = { ...existing, revision: (existing.revision ?? 1) + 1, message: enrichedMessage };
          appendFsyncedJsonl(file, [enriched]);
          const position = index.projections.findIndex((candidate) => candidate === existing);
          if (position >= 0) index.projections[position] = enriched;
          index.byTuple.set(tuple, enriched);
          this.upsertGlobalChatSearchProjection(projectId, enriched);
          return { projection: enriched, replayed: false };
        }
      }
      // Delivery retries may create new runtime-local IDs and timestamps, and
      // passive audit replay may add or omit a presentation-only routing
      // prefix. Keep the first placement when materialization agrees.
      // Startup has already rebuilt this disposable index from the canonical
      // projection ledger. Replaying an unchanged placement must not repeat the
      // same SQL work for every communication. Enriched and newly recovered
      // placements still refresh immediately through the branches above/below.
      if (!this.suppressReplaySearchRefresh) {
        this.upsertGlobalChatSearchProjection(projectId, existing);
      }
      return { projection: existing, replayed: true };
    }
    appendFsyncedJsonl(file, [projection]);
    index.projections.push(projection);
    index.byTuple.set(tuple, projection);
    this.upsertGlobalChatSearchProjection(projectId, projection);
    return { projection, replayed: false };
  }

  readCommunicationProjections(projectId: string): CommunicationProjection[] {
    if (!this.getProject(projectId)) throw new Error("communication project not found");
    return this.projectionIndex(projectId).projections.filter((projection) =>
      this.communicationProjectionAllowed(projectId, projection));
  }

  getCommunicationProjection(
    projectId: string,
    eventId: string,
    surface: CommunicationProjection["surface"],
    projectionKey: string,
  ): CommunicationProjection | undefined {
    if (!this.getProject(projectId)) throw new Error("communication project not found");
    const projection = this.projectionIndex(projectId).byTuple
      .get(`${eventId}\u0000${surface}\u0000${projectionKey}`);
    return projection && this.communicationProjectionAllowed(projectId, projection)
      ? projection
      : undefined;
  }

  readProjectedCommunicationMessages(
    projectId: string,
    surface: CommunicationProjection["surface"],
    projectionKey: string,
    limit?: number,
  ): ProjectedCommunicationMessage[] {
    const matching = this.projectionIndex(projectId).projections
      .filter((projection) => projection.surface === surface && projection.projectionKey === projectionKey &&
        projection.message && this.communicationProjectionAllowed(projectId, projection));
    return this.materializeProjectedCommunicationMessages(projectId, limit === undefined ? matching : matching.slice(-limit));
  }

  materializeProjectedCommunicationMessages(
    projectId: string,
    projections: CommunicationProjection[],
  ): ProjectedCommunicationMessage[] {
    const events = this.communicationIndex(projectId).byId;
    const revisions = this.communicationRevisionIndex(projectId).byTarget;
    return projections
      .flatMap((projection) => {
        const event = events.get(projection.eventId);
        const message = projection.message;
        if (!event || !message) return [];
        const canonicalAuthorAgentId = event.sender.kind === "agent" ? event.sender.agentId : undefined;
        const canonicalRole = event.sender.kind === "agent"
          ? "assistant"
          : event.sender.kind === "user"
            ? "user"
            : message.role;
        const targetRevisions = revisions.get(event.eventId) ?? [];
        const latestRevision = targetRevisions.at(-1);
        const renderedText = message.renderedText ?? event.text;
        return [{
          eventId: event.eventId,
          ...(event.conversationId ? { conversationId: event.conversationId } : {}),
          surface: projection.surface, projectionKey: projection.projectionKey, messageId: message.messageId,
          role: canonicalRole,
          text: event.intent === "collaboration" ? latestRevision?.text ?? event.text
            : latestRevision ? revisedRenderedText(renderedText, event.text, latestRevision.text) : renderedText,
          createdAt: message.createdAt,
          ...(message.orderKey ? { orderKey: message.orderKey } : {}),
          ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
          ...(canonicalAuthorAgentId ? { authorAgentId: canonicalAuthorAgentId } : {}),
          ...(event.sender.kind === "agent" ? { executionId: event.sender.executionId } : {}),
          ...(event.correctionOfEventId ? { correctionOfEventId: event.correctionOfEventId } : {}),
          ...(latestRevision ? { editedAt: latestRevision.createdAt, editRevision: targetRevisions.length } : {}),
          ...(message.attachmentIds?.length || event.artifactIds?.length
            ? { attachmentIds: [...(message.attachmentIds ?? []), ...(event.artifactIds ?? [])] }
            : {}),
          ...(message.attachments?.length || event.artifactIds?.length
            ? { attachments: [
                ...(message.attachments ?? []),
                ...this.resolveManagedArtifactAttachments(
                  projectId,
                  event.artifactIds ?? [],
                  this.managedArtifactAttachmentMetadataAuthority,
                ),
              ] }
            : {}),
          ...(event.artifactIds?.length ? { artifactIds: event.artifactIds } : {}),
          ...(!latestRevision && event.document ? { document: communicationDocumentReference(projectId, event.document) } : {}),
          ...(event.citations?.length ? { citations: event.citations } : {}),
        }];
      })
      .sort((a, b) => (a.orderKey ?? a.createdAt).localeCompare(b.orderKey ?? b.createdAt) || a.eventId.localeCompare(b.eventId));
  }

  private encodeChatHistoryCursor(input: { chatKind: string; chatId: string; orderKey: string; rowKey: string }): string {
    return this.encodeHistoryCursor({ stream: `chat:${input.chatKind}`, scope: input.chatId, orderKey: input.orderKey, rowKey: input.rowKey });
  }

  private decodeChatHistoryCursor(cursor: string, chatKind: string, chatId: string): { orderKey: string; rowKey: string } {
    return this.decodeHistoryCursor(cursor, `chat:${chatKind}`, chatId);
  }

  readProjectedCommunicationMessagePage(
    projectId: string,
    surface: CommunicationProjection["surface"],
    projectionKey: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ): { messages: ProjectedCommunicationMessage[]; hasMore: boolean; cursor?: string } {
    const chatKind = surface === "conversation" ? "conversation"
      : surface === "collaboration_view" ? "collaboration"
        : surface === "direct_agent_audit" ? "agent" : undefined;
    if (!chatKind) return { messages: [], hasMore: false };
    let boundary = input.cursor ? this.decodeChatHistoryCursor(input.cursor, chatKind, projectionKey) : undefined;
    let inclusiveBoundary = false;
    if (input.focusId) {
      const focus = this.client.prepare(`
        SELECT order_key AS orderKey, row_key AS rowKey
        FROM chat_search_messages
        WHERE project_id = ? AND chat_kind = ? AND chat_id = ?
          AND (message_id = ? OR communication_event_id = ?)
        ORDER BY order_key DESC, row_key DESC
        LIMIT 1
      `).get(projectId, chatKind, projectionKey, input.focusId, input.focusId) as { orderKey: string; rowKey: string } | undefined;
      if (!focus) return { messages: [], hasMore: false };
      boundary = focus;
      inclusiveBoundary = true;
    }
    const rows = this.client.prepare(`
      SELECT row_key AS rowKey, communication_event_id AS eventId, order_key AS orderKey
      FROM chat_search_messages
      WHERE project_id = ? AND chat_kind = ? AND chat_id = ?
        ${boundary ? `AND (order_key < ? OR (order_key = ? AND row_key ${inclusiveBoundary ? "<=" : "<"} ?))` : ""}
      ORDER BY order_key DESC, row_key DESC
      LIMIT ?
    `).all(...(boundary
      ? [projectId, chatKind, projectionKey, boundary.orderKey, boundary.orderKey, boundary.rowKey, input.limit + 1]
      : [projectId, chatKind, projectionKey, input.limit + 1])) as Array<{ rowKey: string; eventId: string; orderKey: string }>;
    const hasMore = rows.length > input.limit;
    const selected = rows.slice(0, input.limit);
    const index = this.projectionIndex(projectId);
    const projections = selected.flatMap((row) => {
      const projection = index.byTuple.get(`${row.eventId}\u0000${surface}\u0000${projectionKey}`);
      return projection ? [projection] : [];
    });
    const messages = this.materializeProjectedCommunicationMessages(projectId, projections);
    const oldest = selected.at(-1);
    return {
      messages,
      hasMore,
      ...(hasMore && oldest ? { cursor: this.encodeChatHistoryCursor({ chatKind, chatId: projectionKey, orderKey: oldest.orderKey, rowKey: oldest.rowKey }) } : {}),
    };
  }

  ensureCommunicationProjectionLedger(projectId: string, filter?: CommunicationProjectionRecoveryFilter): void {
    this.suppressReplaySearchRefresh = true;
    try {
      const canonicalEvents = filter
        ? [...filter.eventIds].flatMap(id => {
            const event = this.communicationIndex(projectId).byId.get(id);
            return event ? [event] : [];
          })
        : this.readCommunicationEvents(projectId);
      if (!filter) for (const event of canonicalEvents) this.ensureCommunicationBehaviorProjections(event);
      const canonicalIds = new Set(canonicalEvents.map((event) => event.eventId));
      if (canonicalIds.size === 0) return;
      for (const dispatch of this.messageDispatches(projectId)) {
        if (!canonicalIds.has(dispatch.eventId)) continue;
        const projection: CommunicationProjection = {
          eventId: dispatch.eventId,
          surface: dispatch.channel === "collaboration" ? "collaboration_view" : "conversation",
          projectionKey: dispatch.conversationId,
          projectedAt: dispatch.createdAt,
          message: {
            messageId: dispatch.messageId,
            role: dispatch.role,
            renderedText: dispatch.renderedText,
            createdAt: dispatch.createdAt,
            orderKey: dispatch.orderKey,
            ...(dispatch.authorAgentId ? { authorAgentId: dispatch.authorAgentId } : {}),
            ...(dispatch.attachments?.length ? { attachmentIds: dispatch.attachments.map((item) => item.id) } : {}),
            ...(dispatch.attachments?.length ? { attachments: dispatch.attachments } : {}),
            ...(dispatch.artifactIds?.length ? { artifactIds: dispatch.artifactIds } : {}),
          },
        };
        if (this.communicationProjectionAllowed(projectId, projection)) {
          this.appendCommunicationProjection(projectId, projection);
        }
      }
      for (const agent of this.listAgents(projectId)) {
        if (filter && !filter.agentIds.has(agent.id)) continue;
        for (const stored of this.readEvents(agent.id)) {
          const eventId = stored.event.type === "communication_projection" || stored.event.type === "user_message"
            ? stored.event.communicationEventId : undefined;
          const message = communicationMessageProjection(agent.id, stored);
          if (eventId && message && canonicalIds.has(eventId)) {
            const projection: CommunicationProjection = {
              eventId, surface: "direct_agent_audit", projectionKey: agent.id, projectedAt: stored.ts,
              message,
            };
            if (this.communicationProjectionAllowed(projectId, projection)) {
              this.appendCommunicationProjection(projectId, projection);
            }
          }
        }
      }
    } finally {
      this.suppressReplaySearchRefresh = false;
    }
  }

  /** Verify that canonical events and their projections agree. */
  reconcileCommunicationEvents(projectId: string): CommunicationReconciliationReport {
    const allCanonical = this.readCommunicationEvents(projectId);
    const canonical = allCanonical.filter((event) =>
      !event.conversationId || Boolean(this.getConversation(event.conversationId)));
    const canonicalIds = new Set(canonical.map((event) => event.eventId));
    const projections = this.readCommunicationProjections(projectId);
    const counts = new Map<string, number>();
    for (const projection of projections) counts.set(projection.eventId, (counts.get(projection.eventId) ?? 0) + 1);
    const tupleCounts = new Map<string, number>();
    for (const projection of projections) {
      const key = `${projection.eventId}\u0000${projection.surface}\u0000${projection.projectionKey}`;
      tupleCounts.set(key, (tupleCounts.get(key) ?? 0) + 1);
    }
    const missingProjectionEventIds = canonical
      .filter((event) => !counts.has(event.eventId)).map((event) => event.eventId);
    const duplicateProjectionEventIds = [...new Set(projections
      .filter((projection) => (tupleCounts.get(`${projection.eventId}\u0000${projection.surface}\u0000${projection.projectionKey}`) ?? 0) > 1)
      .map((projection) => projection.eventId))];
    const orphanProjectionEventIds = [...counts.keys()].filter((id) => !canonicalIds.has(id));
    const missingProjectionMetadataEventIds = [...new Set(projections
      .filter((projection) => (projection.surface === "conversation" || projection.surface === "collaboration_view" || projection.surface === "direct_agent_audit") && !projection.message)
      .map((projection) => projection.eventId))];
    // Deleted rooms are intentionally absent from active projections, but their
    // append-only communication and runtime records remain valid historical
    // evidence rather than becoming orphans.
    const canonicalById = new Map(allCanonical.map((event) => [event.eventId, event]));
    const runtimeRows = this.client.prepare(`
      SELECT payload_json FROM runtime_communications WHERE project_id = ? ORDER BY id
    `).all(projectId) as Array<{ payload_json: string }>;
    const orphanRuntimeCommunicationEventIds: string[] = [];
    const runtimePayloadConflicts: CommunicationReconciliationReport["runtimePayloadConflicts"] = [];
    const stable = (value: unknown): unknown => Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, stable(item)]))
        : value;
    const comparableRuntimePayload = (value: Record<string, unknown>): Record<string, unknown> => {
      // Canonical append enriches identity with send-time display labels after
      // the runtime payload is durably recorded. Those labels are explicitly
      // presentation fallback, not authored content or routing authority.
      const comparable = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "identity"),
      );
      if (comparable.schemaVersion !== 2 || !comparable.audience || typeof comparable.audience !== "object") {
        return comparable;
      }
      const audience = comparable.audience as Record<string, unknown>;
      if (comparable.intent === "collaboration" && audience.kind === "agents" && Array.isArray(audience.agentIds)) {
        return { ...comparable, audience: { ...audience, agentIds: [...new Set(audience.agentIds)].sort() } };
      }
      if (comparable.intent === "user_dm" && audience.kind === "user_agents" && Array.isArray(audience.agentIds)) {
        return { ...comparable, audience: { ...audience, agentIds: [...new Set(audience.agentIds)].sort() } };
      }
      return comparable;
    };
    const digest = (value: Record<string, unknown>) => createHash("sha256")
      .update(JSON.stringify(stable(comparableRuntimePayload(value))))
      .digest("hex");
    for (const row of runtimeRows) {
      const payload = JSON.parse(row.payload_json) as unknown;
      if (!payload || typeof payload !== "object") continue;
      const root = payload as Record<string, unknown>;
      const candidate = root.communication && typeof root.communication === "object"
        ? root.communication as Record<string, unknown>
        : root;
      if (typeof candidate.eventId !== "string") continue;
      const expected = canonicalById.get(candidate.eventId);
      if (!expected) {
        orphanRuntimeCommunicationEventIds.push(candidate.eventId);
        continue;
      }
      const canonicalHash = digest(expected as unknown as Record<string, unknown>);
      const runtimeHash = digest(candidate);
      if (canonicalHash !== runtimeHash) runtimePayloadConflicts.push({
        eventId: candidate.eventId,
        canonicalHash,
        runtimeHash,
      });
    }
    const orphanRequestCommunicationEventIds = (this.client.prepare(`
      SELECT DISTINCT communication_event_id
      FROM coordination_requests
      WHERE project_id = ? AND communication_event_id IS NOT NULL
      ORDER BY communication_event_id
    `).all(projectId) as Array<{ communication_event_id: string }>)
      .map((row) => row.communication_event_id)
      .filter((eventId) => !canonicalById.has(eventId));
    return {
      projectId,
      canonicalEvents: canonical.length,
      linkedProjections: projections.length,
      missingProjectionEventIds,
      duplicateProjectionEventIds,
      orphanProjectionEventIds,
      missingProjectionMetadataEventIds,
      orphanRuntimeCommunicationEventIds: [...new Set(orphanRuntimeCommunicationEventIds)].sort(),
      orphanRequestCommunicationEventIds,
      runtimePayloadConflicts,
      ok: missingProjectionEventIds.length === 0 && duplicateProjectionEventIds.length === 0 &&
        orphanProjectionEventIds.length === 0 &&
        missingProjectionMetadataEventIds.length === 0 && orphanRuntimeCommunicationEventIds.length === 0 &&
        orphanRequestCommunicationEventIds.length === 0 && runtimePayloadConflicts.length === 0,
    };
  }
}
