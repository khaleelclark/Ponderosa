import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import type {
  AgentDto,
  ArtifactDto,
  CommunicationEvent,
  CommunicationProjection,
  CommunicationRevisionEvent,
  ConversationChannel,
  ConversationDto,
  ConversationMessageDto,
  CreateConversationMessageRequest,
  ProjectDto,
} from "@ponderosa/core";
import { deriveCommunicationBehavior } from "@ponderosa/core";
import type { Db } from "./db.js";
import { appendFsyncedJsonl, readRepairableJsonl } from "./append-jsonl.js";
import { readManagedArtifactContent } from "./managed-artifact-files.js";
import { normalizedAgentIds, userDmAgentIds } from "./store-communication.js";
import { readJson, writeJson } from "./store-filesystem.js";
import type {
  ConversationDeliveryIntent,
  ConversationJson,
  MessageDispatchRecord,
} from "./store-types.js";
import { conversations } from "./schema.js";
import {
  communicationEventsPath,
  communicationRevisionsPath,
  conversationJsonPath,
  managedArtifactContentPath,
  messageDispatchesPath,
} from "./paths.js";

export class AgentCommunicationJournalAuthority {
  private deliverySequence: number;
  private readonly communicationEventCache = new Map<string, {
    events: CommunicationEvent[];
    byId: Map<string, CommunicationEvent>;
    byIdempotency: Map<string, CommunicationEvent>;
  }>();
  private readonly communicationRevisionCache = new Map<string, {
    revisions: CommunicationRevisionEvent[];
    byId: Map<string, CommunicationRevisionEvent>;
    byIdempotency: Map<string, CommunicationRevisionEvent>;
    byTarget: Map<string, CommunicationRevisionEvent[]>;
  }>();
  private readonly messageDispatchCache = new Map<string, MessageDispatchRecord[]>();

  constructor(
    private readonly dataDir: string,
    private readonly db: Db,
    private readonly deliverySequenceFile: string,
    initialDeliverySequence: number,
    private readonly getProject: (projectId: string) => ProjectDto | undefined,
    private readonly getConversation: (conversationId: string) => ConversationDto | undefined,
    private readonly getAgent: (agentId: string) => AgentDto | undefined,
    private readonly getProjectArtifact: (projectId: string, artifactId: string) => ArtifactDto | undefined,
    private readonly communicationProjectionAllowed: (
      projectId: string,
      projection: Pick<CommunicationProjection, "eventId" | "surface" | "projectionKey" | "message">,
    ) => boolean,
    private readonly appendCommunicationProjection: (
      projectId: string,
      projection: CommunicationProjection,
    ) => unknown,
  ) {
    this.deliverySequence = initialDeliverySequence;
  }

  clearProject(projectId: string): void {
    this.communicationEventCache.delete(projectId);
    this.communicationRevisionCache.delete(projectId);
    this.messageDispatchCache.delete(projectId);
  }

  nextDeliveryOrderKey(createdAt = new Date().toISOString()): string {
    this.deliverySequence += 1;
    appendFsyncedJsonl(this.deliverySequenceFile, [{ sequence: this.deliverySequence }]);
    return `${createdAt}:${String(this.deliverySequence).padStart(16, "0")}`;
  }

  communicationIndex(projectId: string) {
    let cached = this.communicationEventCache.get(projectId);
    if (cached) return cached;
    const events = readRepairableJsonl<CommunicationEvent>(communicationEventsPath(this.dataDir, projectId), "communication log", true);
    const byId = new Map(events.map((event) => [event.eventId, event]));
    const byIdempotency = new Map<string, CommunicationEvent>();
    for (const event of events) {
      if (event.idempotencyKey) byIdempotency.set(`${JSON.stringify(event.sender)}\u0000${event.idempotencyKey}`, event);
    }
    cached = { events, byId, byIdempotency };
    this.communicationEventCache.set(projectId, cached);
    return cached;
  }

  communicationRevisionIndex(projectId: string) {
    let cached = this.communicationRevisionCache.get(projectId);
    if (cached) return cached;
    const revisions = readRepairableJsonl<CommunicationRevisionEvent>(
      communicationRevisionsPath(this.dataDir, projectId),
      "communication revision log",
      true,
    );
    const byId = new Map(revisions.map((revision) => [revision.eventId, revision]));
    const byIdempotency = new Map(revisions.map((revision) => [
      `${JSON.stringify(revision.sender)}\u0000${revision.idempotencyKey}`,
      revision,
    ]));
    const byTarget = new Map<string, CommunicationRevisionEvent[]>();
    for (const revision of revisions) {
      const target = byTarget.get(revision.targetEventId) ?? [];
      target.push(revision);
      byTarget.set(revision.targetEventId, target);
    }
    cached = { revisions, byId, byIdempotency, byTarget };
    this.communicationRevisionCache.set(projectId, cached);
    return cached;
  }

  messageDispatches(projectId: string): MessageDispatchRecord[] {
    let cached = this.messageDispatchCache.get(projectId);
    if (cached) return cached;
    cached = readRepairableJsonl<MessageDispatchRecord>(
      messageDispatchesPath(this.dataDir, projectId),
      "message dispatch log",
      true,
    );
    this.messageDispatchCache.set(projectId, cached);
    return cached;
  }

  private appendMessageDispatch(projectId: string, record: MessageDispatchRecord): void {
    const records = this.messageDispatches(projectId);
    const existing = records.find((candidate) => candidate.messageId === record.messageId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error("message dispatch collision");
      return;
    }
    if (record.messageReceiptKey && records.some((candidate) => candidate.messageReceiptKey === record.messageReceiptKey)) {
      throw new Error("message dispatch receipt collision");
    }
    appendFsyncedJsonl(messageDispatchesPath(this.dataDir, projectId), [record]);
    records.push(record);
  }

  appendCommunicationEvent(input: CommunicationEvent): { event: CommunicationEvent; replayed: boolean } {
    const event: CommunicationEvent = input.schemaVersion === 2 && input.intent === "collaboration"
      ? { ...input, audience: { kind: "agents", agentIds: normalizedAgentIds(input.audience.agentIds) } } as CommunicationEvent
      : input.schemaVersion === 2 && input.intent === "user_dm" && input.audience.kind === "user_agents"
        ? { ...input, audience: { ...input.audience, agentIds: normalizedAgentIds(input.audience.agentIds) } } as CommunicationEvent
        : input;
    if (!this.getProject(event.projectId)) throw new Error("communication project not found");
    if (event.schemaVersion !== 1 && event.schemaVersion !== 2) throw new Error("unsupported communication schema version");
    if (!event.eventId || (!event.text.trim() && !event.attachments?.length && !event.document) || !event.createdAt) {
      throw new Error("communication event is incomplete");
    }
    if (event.attachments) {
      if (new Set(event.attachments.map((attachment) => attachment.id)).size !== event.attachments.length) {
        throw new Error("communication attachments must have unique IDs");
      }
      for (const attachment of event.attachments) {
        if (!attachment.id || !attachment.agentId || !attachment.name.trim() || !attachment.mediaType ||
            !Number.isSafeInteger(attachment.size) || attachment.size < 1 || !attachment.url.trim()) {
          throw new Error("communication attachment is incomplete");
        }
        const owner = this.getAgent(attachment.agentId);
        if (!owner || owner.projectId !== event.projectId || owner.archived) {
          throw new Error("communication attachment owner must be an active agent in its project");
        }
      }
    }
    if (event.document) {
      const artifactContent = event.document.artifactId
        ? managedArtifactContentPath(this.dataDir, event.projectId, event.document.artifactId)
        : undefined;
      const validAuthor = event.sender.kind === "agent"
        ? event.document.authorAgentId === event.sender.agentId &&
          event.document.executionId === event.sender.executionId && !event.document.authorUserId
        : event.sender.kind === "user"
          ? event.document.authorUserId === event.sender.userId && !event.document.authorAgentId && !event.document.executionId
          : false;
      if (!validAuthor || event.document.mediaType !== "text/markdown" ||
          !event.document.id || !event.document.title.trim() ||
          (!event.document.content?.trim() && !event.document.artifactId) ||
          (event.document.content !== undefined && event.document.byteLength !== Buffer.byteLength(event.document.content, "utf8")) ||
          (artifactContent && !existsSync(artifactContent))) {
        throw new Error("communication document provenance is invalid");
      }
    }
    if (event.intent === "collaboration" && event.audience.agentIds.length === 0) {
      throw new Error("collaboration requires at least one recipient");
    }
    if (event.schemaVersion === 2 && event.intent === "user_dm") {
      const agentIds = userDmAgentIds(event);
      if (agentIds.length === 0) throw new Error("user DM requires at least one recipient");
      if (event.sender.kind === "system" || (event.sender.kind === "agent" && (agentIds.length !== 1 || event.sender.agentId !== agentIds[0]))) {
        throw new Error("user DM sender must be its local user or target agent");
      }
      if (event.sender.kind === "user" && event.sender.userId !== event.audience.userId) throw new Error("user DM user identity mismatch");
    }
    if (event.intent === "broadcast" && event.audience.organizationId !== event.projectId) {
      throw new Error("broadcast organization must match its project");
    }
    const audienceIds = event.schemaVersion === 2 && event.intent === "collaboration" ? event.audience.agentIds
      : userDmAgentIds(event);
    for (const agentId of audienceIds) {
      const agent = this.getAgent(agentId);
      if (!agent || agent.projectId !== event.projectId || agent.archived) throw new Error("communication recipient must be an active agent in its project");
      if (event.conversationId && !agent.conversationIds.includes(event.conversationId)) throw new Error("communication recipient must belong to its conversation");
    }
    if (event.schemaVersion === 2 && event.intent === "collaboration") {
      if (event.sender.kind === "agent") {
        const sender = this.getAgent(event.sender.agentId);
        if (!sender || sender.projectId !== event.projectId || sender.archived) {
          throw new Error("collaboration sender must be an active agent in its project");
        }
        if (event.conversationId && !sender.conversationIds.includes(event.conversationId)) {
          throw new Error("collaboration sender must belong to its conversation");
        }
        if (event.audience.agentIds.includes(event.sender.agentId)) {
          throw new Error("collaboration cannot target its sender");
        }
      }
    }
    if (event.conversationId) {
      const master = this.getConversation(event.conversationId);
      if (!master || master.projectId !== event.projectId || master.archived) throw new Error("communication conversation must be active in its project");
    }
    const file = communicationEventsPath(this.dataDir, event.projectId);
    const index = this.communicationIndex(event.projectId);
    const idempotent = event.idempotencyKey
      ? index.byIdempotency.get(`${JSON.stringify(event.sender)}\u0000${event.idempotencyKey}`) : undefined;
    if (idempotent) {
      const equivalent = idempotent.projectId === event.projectId && idempotent.conversationId === event.conversationId &&
        idempotent.intent === event.intent && JSON.stringify(idempotent.audience) === JSON.stringify(event.audience) &&
        idempotent.text === event.text && JSON.stringify(idempotent.attachments) === JSON.stringify(event.attachments) &&
        JSON.stringify(idempotent.document) === JSON.stringify(event.document);
      if (!equivalent) throw new Error("communication idempotency collision");
      this.ensureCommunicationBehaviorProjections(idempotent);
      return { event: idempotent, replayed: true };
    }
    const existing = index.byId.get(event.eventId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) throw new Error("communication event ID collision");
      this.ensureCommunicationBehaviorProjections(existing);
      return { event: existing, replayed: true };
    }
    appendFsyncedJsonl(file, [event]);
    index.events.push(event);
    index.byId.set(event.eventId, event);
    if (event.idempotencyKey) index.byIdempotency.set(`${JSON.stringify(event.sender)}\u0000${event.idempotencyKey}`, event);
    this.ensureCommunicationBehaviorProjections(event);
    return { event, replayed: false };
  }

  /**
   * Materialize every placement declared by the behavior matrix immediately
   * after the canonical append. Message metadata can enrich these records later;
   * missing route-specific writes can no longer erase a surface from the ledger.
   */
  ensureCommunicationBehaviorProjections(event: CommunicationEvent): void {
    for (const target of deriveCommunicationBehavior(event).projectionTargets) {
      const projection: CommunicationProjection = {
        eventId: event.eventId,
        surface: target.surface,
        projectionKey: target.projectionKey,
        projectedAt: event.createdAt,
      };
      // Replayable V1 records can reference agents or rooms that predate the
      // current store. Ambiguous historical placement fails closed.
      if (this.communicationProjectionAllowed(event.projectId, projection)) {
        this.appendCommunicationProjection(event.projectId, projection);
      }
    }
  }

  /**
   * Append a passive text edit without changing the original communication or
   * any sent attachment. The immutable target retains scope and audience, so a
   * revision cannot create a delivery or alter context eligibility.
   */
  appendCommunicationRevision(input: CommunicationRevisionEvent): { revision: CommunicationRevisionEvent; replayed: boolean } {
    const project = this.getProject(input.projectId);
    if (!project) throw new Error("communication revision project not found");
    const target = this.getCommunicationEvent(input.projectId, input.targetEventId);
    if (!target || target.conversationId !== input.conversationId) throw new Error("communication revision target not found");
    if (input.schemaVersion !== 1 || input.kind !== "edit" || !input.eventId || !input.idempotencyKey || !input.createdAt) {
      throw new Error("communication revision is incomplete");
    }
    if (target.sender.kind !== "user" || input.sender.kind !== "user" || target.sender.userId !== input.sender.userId) {
      throw new Error("communication revision author does not own its target");
    }
    if (!input.text.trim() && !target.attachments?.length) throw new Error("communication revision text is required");
    const index = this.communicationRevisionIndex(input.projectId);
    const idempotency = `${JSON.stringify(input.sender)}\u0000${input.idempotencyKey}`;
    const equivalent = (candidate: CommunicationRevisionEvent) =>
      candidate.projectId === input.projectId && candidate.conversationId === input.conversationId &&
      candidate.targetEventId === input.targetEventId && candidate.kind === input.kind && candidate.text === input.text;
    const replay = index.byIdempotency.get(idempotency);
    if (replay) {
      if (!equivalent(replay)) throw new Error("communication revision idempotency collision");
      return { revision: replay, replayed: true };
    }
    const existing = index.byId.get(input.eventId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(input)) throw new Error("communication revision event ID collision");
      return { revision: existing, replayed: true };
    }
    appendFsyncedJsonl(communicationRevisionsPath(this.dataDir, input.projectId), [input]);
    index.revisions.push(input);
    index.byId.set(input.eventId, input);
    index.byIdempotency.set(idempotency, input);
    const targetRevisions = index.byTarget.get(input.targetEventId) ?? [];
    targetRevisions.push(input);
    index.byTarget.set(input.targetEventId, targetRevisions);
    return { revision: input, replayed: false };
  }

  readCommunicationRevisions(projectId: string): CommunicationRevisionEvent[] {
    if (!this.getProject(projectId)) throw new Error("communication project not found");
    return [...this.communicationRevisionIndex(projectId).revisions];
  }

  readCommunicationEvents(projectId: string): CommunicationEvent[] {
    if (!this.getProject(projectId)) throw new Error("communication project not found");
    return [...this.communicationIndex(projectId).events];
  }

  getCommunicationEvent(projectId: string, eventId: string): CommunicationEvent | undefined {
    if (!this.getProject(projectId)) throw new Error("communication project not found");
    return this.communicationIndex(projectId).byId.get(eventId);
  }

  getCommunicationDocument(projectId: string, documentId: string) {
    const event = this.readCommunicationEvents(projectId).find((candidate) => candidate.document?.id === documentId);
    if (!event?.document) return undefined;
    if (event.document.content !== undefined) return { event, document: event.document };
    if (!event.document.artifactId) return undefined;
    const artifact = this.getProjectArtifact(projectId, event.document.artifactId);
    if (!artifact?.size || !artifact.sha256) return undefined;
    const file = readManagedArtifactContent(
      this.dataDir, projectId, event.document.artifactId, artifact.size, artifact.sha256,
    );
    return file ? { event, document: { ...event.document, content: file.body.toString("utf8") } } : undefined;
  }

  appendConversationMessage(
    conversationId: string,
    input: CreateConversationMessageRequest,
    authorAgentId?: string,
    channel: ConversationChannel = "main",
    deliveryIntents?: ConversationDeliveryIntent[],
    messageReceiptKey?: string,
    communicationEventId?: string,
  ): ConversationMessageDto | undefined {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return undefined;
    if (!communicationEventId) {
      throw new Error("conversation projections require a canonical communication event");
    }
    if (!this.communicationProjectionAllowed(conversation.projectId, {
      eventId: communicationEventId,
      surface: channel === "collaboration" ? "collaboration_view" : "conversation",
      projectionKey: conversationId,
    })) {
      throw new Error("communication scope cannot project to requested surface");
    }
    const now = new Date().toISOString();
    const dispatch: MessageDispatchRecord = {
      schemaVersion: 1,
      eventId: communicationEventId,
      // One authored communication has one stable identity across every view.
      messageId: communicationEventId,
      conversationId,
      channel,
      role: input.role ?? "user",
      renderedText: input.text,
      createdAt: now,
      ...(authorAgentId ? { authorAgentId } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(deliveryIntents?.length ? { deliveryIntents } : {}),
      ...(messageReceiptKey ? { messageReceiptKey } : {}),
      orderKey: this.nextDeliveryOrderKey(now),
    };
    // The dispatch record is durable first and contains enough immutable
    // presentation metadata to reconstruct a projection after a crash.
    this.appendMessageDispatch(conversation.projectId, dispatch);
    this.appendCommunicationProjection(conversation.projectId, {
      eventId: dispatch.eventId,
      surface: channel === "collaboration" ? "collaboration_view" : "conversation",
      projectionKey: conversationId,
      projectedAt: now,
      message: {
        messageId: dispatch.messageId,
        role: dispatch.role,
        renderedText: dispatch.renderedText,
        createdAt: dispatch.createdAt,
        orderKey: dispatch.orderKey,
        ...(authorAgentId ? { authorAgentId } : {}),
        ...(dispatch.attachments?.length ? { attachmentIds: dispatch.attachments.map((item) => item.id) } : {}),
        ...(dispatch.attachments?.length ? { attachments: dispatch.attachments } : {}),
      },
    });
    this.db
      .update(conversations)
      .set({ updatedAt: now })
      .where(eq(conversations.id, conversationId))
      .run();
    const jsonPath = conversationJsonPath(this.dataDir, conversation.projectId, conversationId);
    const json = readJson<ConversationJson>(jsonPath);
    writeJson(jsonPath, { ...json, updatedAt: now });
    return {
      id: dispatch.messageId,
      communicationEventId: dispatch.eventId,
      conversationId: dispatch.conversationId,
      role: dispatch.role,
      text: dispatch.renderedText,
      createdAt: dispatch.createdAt,
      authorAgentId: authorAgentId ?? undefined,
      attachments: dispatch.attachments,
    };
  }

}
