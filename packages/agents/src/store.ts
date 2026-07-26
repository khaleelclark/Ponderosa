// AgentStore — the library that apps/server consumes. Authored communication and
// execution telemetry remain event-log-owned and their SQLite views are
// rebuildable. Communication V3 scheduler state is different: its requests,
// joins, activations, Runs, leases, fences, injections, and idempotency records
// are authoritative SQLite state. Exposes NO HTTP (SPEC §7).

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { and, asc, eq, isNull } from "drizzle-orm";
import type {
  ArtifactDto,
  AgentActivityDto,
  ChangedFileDto,
  ChangedFileDetailDto,
  AgentOrganizationEvent,
  CommunicationEvent,
  CommunicationAudience,
  CommunicationRevisionEvent,
  CommunicationProjection,
  CommunicationReconciliationReport,
  ProjectedCommunicationMessage,
  AgentPresetDto, CreateAgentPresetRequest, UpdateAgentPresetRequest,
  CollaborationViewDto,
  CreateConversationMessageRequest,
  CreateConversationRequest,
  CreateProjectRequest,
  CreateAgentRequest,
  ConversationDetailDto,
  ConversationChannel,
  ConversationDto,
  ConversationMessageDto,
  MessageDto,
  ProjectDto,
  AgentRunDto,
  ProviderInputDto,
  ProviderInputSourceManifest,
  WorkItemDto,
  WorkItemStatus,
  AgentLifecycleReason,
  AgentLifecycleStatus,
  AgentRunStatus,
  AgentDetailDto,
  HistoryPageDto,
  AgentDto,
  AgentDeletionPreviewDto,
  PortableAgentHistoryMessageDto,
  AgentState,
  TokenUsageSummaryDto,
  TokenUsageBreakdownDto,
  TokenUsageMetric,
  TokenUsageRangeDto,
  TokenUsage,
  GlobalChatSearchAuthorDto,
  GlobalChatSearchResponseDto,
  AllChatItemDto,
  AllChatPageDto,
  RunOutputDto,
  ResponseFileActivityDto,
  UpdateProjectRequest,
  UpdateAgentConversationMembershipsRequest,
  UpdateConversationRequest,
  UpdateAgentRequest,
  UpdateAgentOrganizationRequest,
} from "@ponderosa/core";
import { communicationHasProjectionTarget, deriveCommunicationBehavior } from "@ponderosa/core";
import type { GlobalChatSearchInput } from "./store-chat-search-read-model.js";
import { AgentChatFeedProjection } from "./store-chat-feed-projection.js";
import { AgentTelemetryReadModel } from "./store-telemetry-read-model.js";
import { AgentFileActivityReadModel } from "./store-file-activity-read-model.js";
import { AgentRunUsageReadModel } from "./store-run-usage-read-model.js";
import { AgentArtifactCatalog } from "./store-artifact-catalog.js";
import { AgentEventProjectionStore } from "./store-event-projection.js";
import { AgentConversationProjectionReadModel } from "./store-conversation-projection-read-model.js";
import { AgentCommunicationProjectionLedger } from "./store-communication-projection-ledger.js";
import { AgentDeletionConflictError, requireManagementPermissions } from "./store-agent-management.js";
import {
  communicationDocumentReference,
  communicationMessageProjection,
  normalizedAgentIds,
  revisedRenderedText,
  userDmAgentIds,
} from "./store-communication.js";
import {
  acquireDataDirectoryOwnership,
  ensureV1Layout,
  releaseDataDirectoryOwnership,
  type DataDirectoryOwnership,
} from "./store-data-directory.js";
import { fsyncDirectory, pruneArtifactDirectory, readJson, readJsonLines, writeJson } from "./store-filesystem.js";
export { AgentDeletionConflictError } from "./store-agent-management.js";
import { openDb, type Db } from "./db.js";
import { EventLog } from "./eventlog.js";
import { artifactId } from "./ids.js";
import { appendFsyncedJsonl, readRepairableJsonl } from "./append-jsonl.js";
import { readManagedArtifactContent } from "./managed-artifact-files.js";
import type { LogEvent, StoredLogEvent } from "./log-event.js";
import type {
  ContextReadBoundary,
  ContextSourcePage,
  ProjectJson,
  ManagedArtifactAccess,
  AgentJson,
  AgentSpawnOrigin,
  PresetEvent,
  ConversationJson,
  ConversationDeliveryIntent,
  MessageDispatchRecord,
  AgentDeletionReceipt,
  ProjectDeletionReceipt,
  AgentManagementAuthorization,
} from "./store-types.js";
export type {
  ContextReadBoundary,
  ContextSourcePage,
  ManagedArtifactAccess,
  AgentSpawnOrigin,
  ConversationDeliveryIntent,
  AgentDeletionReceipt,
  ProjectDeletionReceipt,
  AgentManagementAuthorization,
} from "./store-types.js";
import {
  artifacts,
  agentPresets,
  events,
  conversations,
  messages,
  chatSearchMessages,
  importedHistoryMessages,
  activityProjection,
  changedFileProjection,
  managedArtifactProjection,
  projects,
  runs,
  workItems,
  agents,
  agentDeletionTombstones,
  agentDeletionReceipts,
  agentManagementApprovals,
  agentConversationMemberships,
  continuationHandoffs,
  projectDeletionPending,
  projectDeletionReceipts,
} from "./schema.js";

import {
  artifactsDir,
  managedArtifactContentPath,
  attachmentsDir,
  dbPath,
  eventsPath,
  conversationDir,
  communicationEventsPath,
  communicationRevisionsPath,
  communicationProjectionsPath,
  messageDispatchesPath,
  conversationJsonPath,
  conversationsDir,
  projectJsonPath,
  agentPresetsPath,
  agentOrganizationEventsPath,
  projectsDir,
  projectDir,
  agentDir,
  agentJsonPath,
  importedAgentHistoryPath,
  agentsDir,
} from "./paths.js";
const BUILTIN_PRESETS: Array<Omit<CreateAgentPresetRequest, "engine"> & { engine: "codex" }> = [
  { name: "Frontend", description: "Accessible, polished product UI", guidance: "Act as a product-minded frontend engineer. Prioritize responsive UX, accessibility, and tested user flows.", engine: "codex" },
  { name: "Security", description: "Threat-model and harden changes", guidance: "Act as a security reviewer. Preserve trust boundaries, minimize authority, and test abuse cases.", engine: "codex" },
  { name: "QA", description: "Find regressions and verify behavior", guidance: "Act as a QA engineer. Build a risk-based test plan, reproduce failures, and report evidence precisely.", engine: "codex" },
  { name: "Documentation", description: "Create clear, accurate documentation", guidance: "Act as a technical writer. Verify behavior in the code and write concise task-oriented documentation.", engine: "codex" },
];

export class AgentStore {
  private readonly db: Db;
  private readonly client: Database.Database;
  private readonly telemetry!: AgentTelemetryReadModel;
  private readonly fileActivity!: AgentFileActivityReadModel;
  private readonly chatFeed!: AgentChatFeedProjection;
  private readonly runUsage!: AgentRunUsageReadModel;
  private readonly artifactCatalog!: AgentArtifactCatalog;
  private readonly eventProjection!: AgentEventProjectionStore;
  private readonly conversationProjection!: AgentConversationProjectionReadModel;
  private readonly communicationProjectionLedger!: AgentCommunicationProjectionLedger;
  private readonly deliverySequenceFile: string;
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
  private readonly communicationProjectionCache = new Map<string, {
    projections: CommunicationProjection[];
    byTuple: Map<string, CommunicationProjection>;
  }>();
  private readonly messageDispatchCache = new Map<string, MessageDispatchRecord[]>();
  private ownership?: DataDirectoryOwnership;
  private closed = false;

  constructor(private readonly dataDir: string) {
    ensureV1Layout(dataDir);
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(projectsDir(dataDir), { recursive: true });
    this.ownership = acquireDataDirectoryOwnership(dataDir);
    this.deliverySequenceFile = `${dataDir}/delivery-order.jsonl`;
    this.deliverySequence = readRepairableJsonl<{ sequence: number }>(this.deliverySequenceFile, "delivery order journal", true)
      .reduce((maximum, record) => Math.max(maximum, record.sequence), 0);
    try {
      const opened = openDb(dbPath(dataDir));
      this.db = opened.db;
      this.client = opened.client;
      this.artifactCatalog = new AgentArtifactCatalog(
        dataDir,
        this.client,
        input => this.encodeHistoryCursor(input),
        (cursor, stream, scope) => this.decodeHistoryCursor(cursor, stream, scope),
        agentId => this.rowToAgentDto(agentId),
        projectId => Boolean(this.getProject(projectId)),
        agentId => this.readEvents(agentId),
      );
      this.eventProjection = new AgentEventProjectionStore(
        dataDir,
        this.db,
        this.client,
        agentId => this.activeEngineOf(agentId),
        artifact => this.artifactCatalog.recordProjectArtifact(artifact),
      );
      this.chatFeed = new AgentChatFeedProjection(
        this.db,
        this.client,
        projectId => this.communicationIndex(projectId),
        projectId => this.projectionIndex(projectId),
        (projectId, projection) =>
          this.communicationProjectionAllowed(projectId, projection),
        (projectId, surface, projectionKey, limit) =>
          this.readProjectedCommunicationMessages(
            projectId,
            surface,
            projectionKey,
            limit,
          ),
        (projectId, surface, projectionKey, input) =>
          this.readProjectedCommunicationMessagePage(
            projectId,
            surface,
            projectionKey,
            input,
          ),
        (projectId, projections) =>
          this.materializeProjectedCommunicationMessages(projectId, projections),
        agentId => this.rowToAgentDto(agentId),
        agentId => this.getAgent(agentId),
        projectId => this.listAgents(projectId),
        () => this.listProjects(),
        input => this.encodeHistoryCursor(input),
        (cursor, stream, scope) =>
          this.decodeHistoryCursor(cursor, stream, scope),
      );
      this.communicationProjectionLedger = new AgentCommunicationProjectionLedger(
        dataDir,
        this.client,
        projectId => this.getProject(projectId),
        conversationId => this.getConversation(conversationId),
        agentId => this.getAgent(agentId),
        projectId => this.listAgents(projectId),
        agentId => this.readEvents(agentId),
        projectId => this.readCommunicationEvents(projectId),
        projectId => this.communicationIndex(projectId),
        projectId => this.communicationRevisionIndex(projectId),
        projectId => this.projectionIndex(projectId),
        projectId => this.messageDispatches(projectId),
        event => this.ensureCommunicationBehaviorProjections(event),
        (projectId, projection) =>
          this.chatFeed.upsertGlobalChatSearchProjection(projectId, projection),
        input => this.encodeHistoryCursor(input),
        (cursor, stream, scope) =>
          this.decodeHistoryCursor(cursor, stream, scope),
      );
      this.fileActivity = new AgentFileActivityReadModel(
        this.client,
        agentId => this.artifactCatalog.getArtifacts(agentId),
        (agentId, row) => this.artifactCatalog.artifactDtoFromProjectionRow(agentId, row),
      );
      this.telemetry = new AgentTelemetryReadModel(
        this.client,
        (input) => this.encodeHistoryCursor(input),
        (cursor, stream, scope) => this.decodeHistoryCursor(cursor, stream, scope),
        (agentId, status, executionFilter) =>
          this.fileActivity.byExecution(agentId, status, executionFilter),
      );
      this.runUsage = new AgentRunUsageReadModel(
        this.db,
        this.client,
        input => this.encodeHistoryCursor(input),
        (cursor, stream, scope) =>
          this.decodeHistoryCursor(cursor, stream, scope),
        (projectId, eventId) =>
          this.getCommunicationEvent(projectId, eventId)?.conversationId,
      );
      this.conversationProjection = new AgentConversationProjectionReadModel(
        this.client,
        conversationId => this.getConversation(conversationId),
        projectId => this.messageDispatches(projectId),
        (projectId, surface, projectionKey, limit) =>
          this.readProjectedCommunicationMessages(
            projectId,
            surface,
            projectionKey,
            limit,
          ),
        (projectId, surface, projectionKey, input) =>
          this.readProjectedCommunicationMessagePage(
            projectId,
            surface,
            projectionKey,
            input,
          ),
        (projectId, eventId, surface, projectionKey) =>
          this.projectionIndex(projectId).byTuple.get(
            `${eventId}\u0000${surface}\u0000${projectionKey}`,
          ),
        (projectId, projections) =>
          this.materializeProjectedCommunicationMessages(projectId, projections),
        agentId => Boolean(this.getAgent(agentId)),
        agentId => this.getRuns(agentId),
        (agentId, status, executionIds) =>
          this.fileActivity.byExecution(agentId, status, executionIds),
      );
      // Canonical files are written before their SQLite projections. Rebuilding
      // on startup closes the crash window where a durable append succeeded but
      // the projection write did not, and keeps every read path deterministic.
      this.rebuildProjections();
      for (const project of this.listProjects()) this.ensureCommunicationProjectionLedger(project.id);
    } catch (error) {
      releaseDataDirectoryOwnership(this.ownership);
      this.ownership = undefined;
      throw error;
    }
  }

  nextDeliveryOrderKey(createdAt = new Date().toISOString()): string {
    this.deliverySequence += 1;
    appendFsyncedJsonl(this.deliverySequenceFile, [{ sequence: this.deliverySequence }]);
    return `${createdAt}:${String(this.deliverySequence).padStart(16, "0")}`;
  }

  private communicationIndex(projectId: string) {
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

  private communicationRevisionIndex(projectId: string) {
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

  private messageDispatches(projectId: string): MessageDispatchRecord[] {
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

  private projectionIndex(projectId: string) {
    let cached = this.communicationProjectionCache.get(projectId);
    if (cached) return cached;
    const records = readRepairableJsonl<CommunicationProjection>(communicationProjectionsPath(this.dataDir, projectId), "communication projection log", true);
    const byTuple = new Map(records.map((projection) => [
      `${projection.eventId}\u0000${projection.surface}\u0000${projection.projectionKey}`, projection,
    ]));
    cached = { projections: [...byTuple.values()], byTuple };
    this.communicationProjectionCache.set(projectId, cached);
    return cached;
  }

  /** Expose the drizzle db for advanced/read-only queries (e.g. the v2 search). */
  get database(): Db {
    return this.db;
  }

  /**
   * Append one canonical communication before creating any projections.
   * Duplicate IDs are accepted only when the complete event is byte-equivalent,
   * making transport retries idempotent while detecting identity collisions.
   */
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
  private ensureCommunicationBehaviorProjections(event: CommunicationEvent): void {
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

  private communicationProjectionAllowed(
    projectId: string,
    projection: Pick<CommunicationProjection, "eventId" | "surface" | "projectionKey" | "message">,
  ): boolean {
    return this.communicationProjectionLedger.communicationProjectionAllowed(
      projectId,
      projection,
    );
  }

  appendCommunicationProjection(
    projectId: string,
    projection: CommunicationProjection,
  ): { projection: CommunicationProjection; replayed: boolean } {
    return this.communicationProjectionLedger.appendCommunicationProjection(
      projectId,
      projection,
    );
  }

  readCommunicationProjections(projectId: string): CommunicationProjection[] {
    return this.communicationProjectionLedger.readCommunicationProjections(projectId);
  }

  readProjectedCommunicationMessages(
    projectId: string,
    surface: CommunicationProjection["surface"],
    projectionKey: string,
    limit?: number,
  ): ProjectedCommunicationMessage[] {
    return this.communicationProjectionLedger.readProjectedCommunicationMessages(
      projectId,
      surface,
      projectionKey,
      limit,
    );
  }

  private materializeProjectedCommunicationMessages(
    projectId: string,
    projections: CommunicationProjection[],
  ): ProjectedCommunicationMessage[] {
    return this.communicationProjectionLedger.materializeProjectedCommunicationMessages(
      projectId,
      projections,
    );
  }

  private encodeHistoryCursor(input: { stream: string; scope: string; orderKey: string; rowKey: string }): string {
    return Buffer.from(JSON.stringify({ v: 1, ...input }), "utf8").toString("base64url");
  }

  private decodeHistoryCursor(cursor: string, stream: string, scope: string): { orderKey: string; rowKey: string } {
    let parsed: unknown;
    try {
      const decoded = Buffer.from(cursor, "base64url");
      if (decoded.toString("base64url") !== cursor) throw new Error("non-canonical cursor");
      parsed = JSON.parse(decoded.toString("utf8"));
    } catch {
      throw new Error("invalid history cursor");
    }
    if (!parsed || typeof parsed !== "object") throw new Error("invalid history cursor");
    const value = parsed as Record<string, unknown>;
    if (value.v !== 1 || value.stream !== stream || value.scope !== scope ||
      typeof value.orderKey !== "string" || typeof value.rowKey !== "string") {
      throw new Error("invalid history cursor");
    }
    return { orderKey: value.orderKey, rowKey: value.rowKey };
  }

  readProjectedCommunicationMessagePage(
    projectId: string,
    surface: CommunicationProjection["surface"],
    projectionKey: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ): { messages: ProjectedCommunicationMessage[]; hasMore: boolean; cursor?: string } {
    return this.communicationProjectionLedger.readProjectedCommunicationMessagePage(
      projectId,
      surface,
      projectionKey,
      input,
    );
  }

  private ensureCommunicationProjectionLedger(projectId: string): void {
    this.communicationProjectionLedger.ensureCommunicationProjectionLedger(projectId);
  }

  reconcileCommunicationEvents(
    projectId: string,
  ): CommunicationReconciliationReport {
    return this.communicationProjectionLedger.reconcileCommunicationEvents(projectId);
  }

  /** Mark executions whose durable start survived a daemon crash without a terminal record. */
  recoverInterruptedExecutions(): string[] {
    const recovered: string[] = [];
    for (const project of this.listProjects()) {
      for (const agent of this.listAgents(project.id)) {
        const events = this.readEvents(agent.id);
        let startedIndex = -1;
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]!.event;
          if (event.type === "agent_lifecycle" && event.status === "running") {
            startedIndex = index;
            break;
          }
        }
        if (startedIndex < 0) continue;
        const start = events[startedIndex]!;
        const terminal = events.slice(startedIndex + 1).some((stored) =>
          stored.event.type === "agent_lifecycle" && ["cancelled", "completed", "failed", "interrupted"].includes(stored.event.status));
        if (terminal) continue;
        const executionId = start.event.type === "agent_lifecycle" ? start.event.executionId : `recovered:${agent.id}`;
        this.appendEvent(agent.id, {
          type: "agent_lifecycle", status: "failed", reason: "execution_interrupted",
          executionId,
        });
        recovered.push(agent.id);
      }
    }
    return recovered;
  }

  /** The raw better-sqlite3 handle (read-only queries, PRAGMAs, tests). */
  get sqlite(): Database.Database {
    return this.client;
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  createProject(input: Omit<CreateProjectRequest, "defaultEngine"> & { hostPath: string; defaultEngine?: CreateProjectRequest["defaultEngine"] }): ProjectDto {
    const id = randomUUID();
    const conversationId = randomUUID();
    const now = new Date().toISOString();
    const defaultEngine = input.defaultEngine ?? "codex";
    const record: ProjectJson = {
      id,
      label: input.label,
      hostPath: input.hostPath,
      createdAt: now,
      lastUsedAt: now,
      defaultEngine,
      ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
      ...(input.defaultEffort ? { defaultEffort: input.defaultEffort } : {}),
      lastConversationId: conversationId,
    };
    const conversation: ConversationJson = {
      id: conversationId, projectId: id, title: "New Chat", defaultEngine,
      ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
      ...(input.defaultEffort ? { defaultEffort: input.defaultEffort } : {}),
      createdAt: now, updatedAt: now, archived: false,
    };
    const stagingId = `.${id}.creating`;
    const stagingRoot = projectDir(this.dataDir, stagingId);
    try {
      writeJson(projectJsonPath(this.dataDir, stagingId), record);
      mkdirSync(conversationDir(this.dataDir, stagingId, conversationId), { recursive: true });
      writeJson(conversationJsonPath(this.dataDir, stagingId, conversationId), conversation);
      mkdirSync(agentsDir(this.dataDir, stagingId), { recursive: true });
      renameSync(stagingRoot, projectDir(this.dataDir, id));
      this.db.transaction((tx) => {
        tx.insert(projects).values({ id, label: input.label, hostPath: input.hostPath, createdAt: now, lastUsedAt: now, defaultEngine, defaultModel: input.defaultModel ?? null, defaultEffort: input.defaultEffort ?? null, lastConversationId: conversationId }).run();
        tx.insert(conversations).values({ id: conversationId, projectId: id, title: "New Chat", defaultEngine, defaultModel: input.defaultModel ?? null, defaultEffort: input.defaultEffort ?? null, createdAt: now, updatedAt: now, archived: 0 }).run();
      });
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true });
      rmSync(projectDir(this.dataDir, id), { recursive: true, force: true });
      throw error;
    }
    for (const preset of BUILTIN_PRESETS) this.createAgentPreset(id, preset);
    return { id, label: input.label, hostPath: input.hostPath, createdAt: now, lastUsedAt: now, defaultEngine, ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}), ...(input.defaultEffort ? { defaultEffort: input.defaultEffort } : {}), lastConversationId: conversationId };
  }

  updateProject(id: string, input: UpdateProjectRequest): ProjectDto | undefined {
    const current = this.getProject(id);
    if (!current) return undefined;
    const label = (input.label ?? current.label).trim();
    if (!label) throw new Error("project label is required");
    const instructions = (input.instructions ?? current.instructions ?? "").slice(0, 100_000);
    const defaultEngine = input.defaultEngine ?? current.defaultEngine;
    const defaultModel = input.defaultModel === null ? undefined : input.defaultModel ?? current.defaultModel;
    const defaultEffort = input.defaultEffort === null ? undefined : input.defaultEffort ?? current.defaultEffort;
    const { instructions: _previousInstructions, ...projectWithoutInstructions } = current;
    const record: ProjectJson = {
      ...projectWithoutInstructions,
      label,
      defaultEngine,
      ...(defaultModel ? { defaultModel } : { defaultModel: undefined }),
      ...(defaultEffort ? { defaultEffort } : { defaultEffort: undefined }),
      ...(instructions ? { instructions } : {}),
    };
    writeJson(projectJsonPath(this.dataDir, id), record);
    this.db.update(projects).set({ label, defaultEngine, defaultModel: defaultModel ?? null, defaultEffort: defaultEffort ?? null }).where(eq(projects.id, id)).run();
    return { ...projectWithoutInstructions, label, defaultEngine, ...(defaultModel ? { defaultModel } : {}), ...(defaultEffort ? { defaultEffort } : {}), ...(instructions ? { instructions } : {}) };
  }

  markProjectDeletionPending(projectId: string, now = new Date().toISOString()): void {
    if (!this.getProject(projectId)) throw new Error("project not found");
    this.db.insert(projectDeletionPending).values({ projectId, createdAt: now })
      .onConflictDoNothing({ target: projectDeletionPending.projectId }).run();
  }

  recordProjectDeletionCleanupError(projectId: string, error: string): void {
    this.db.update(projectDeletionPending).set({ lastError: error.slice(0, 4_000) })
      .where(eq(projectDeletionPending.projectId, projectId)).run();
  }

  listPendingProjectDeletions(): Array<{ projectId: string; createdAt: string; lastError?: string }> {
    return this.db.select().from(projectDeletionPending).all().map((row) => ({
      projectId: row.projectId,
      createdAt: row.createdAt,
      ...(row.lastError ? { lastError: row.lastError } : {}),
    }));
  }

  getProjectDeletionReceipt(projectId: string): ProjectDeletionReceipt | undefined {
    const row = this.db.select().from(projectDeletionReceipts)
      .where(eq(projectDeletionReceipts.projectId, projectId)).get();
    return row ? {
      projectId: row.projectId,
      tombstoneName: row.tombstoneName,
      storageCleanupCompleted: row.storageCleanupCompleted === 1,
      ...(row.lastError ? { lastError: row.lastError } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    } : undefined;
  }

  listPendingProjectDeletionReceipts(): ProjectDeletionReceipt[] {
    return this.db.select().from(projectDeletionReceipts)
      .where(eq(projectDeletionReceipts.storageCleanupCompleted, 0)).all()
      .map((row) => ({
        projectId: row.projectId,
        tombstoneName: row.tombstoneName,
        storageCleanupCompleted: false,
        ...(row.lastError ? { lastError: row.lastError } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.completedAt ? { completedAt: row.completedAt } : {}),
      }));
  }

  recordProjectDeletionReceiptCleanupError(projectId: string, error: string): void {
    this.db.update(projectDeletionReceipts).set({
      lastError: error.slice(0, 4_000),
      updatedAt: new Date().toISOString(),
    }).where(eq(projectDeletionReceipts.projectId, projectId)).run();
  }

  finishProjectDeletionStorageCleanup(
    receipt: ProjectDeletionReceipt,
    afterTombstoneRemoval?: (projectId: string) => void,
  ): void {
    const current = this.getProjectDeletionReceipt(receipt.projectId);
    if (!current) throw new Error("Project deletion receipt not found");
    if (current.storageCleanupCompleted) return;
    const prefix = `.${current.projectId}.deleting-`;
    if (current.tombstoneName.includes("/") || current.tombstoneName.includes("\\") ||
        !current.tombstoneName.startsWith(prefix)) {
      throw new Error("invalid Project deletion receipt");
    }
    const root = projectsDir(this.dataDir);
    const canonical = projectDir(this.dataDir, current.projectId);
    if (existsSync(canonical)) throw new Error("committed Project deletion storage was resurrected");
    const tombstone = join(root, current.tombstoneName);
    if (existsSync(tombstone)) {
      rmSync(tombstone, { recursive: true, force: true });
      afterTombstoneRemoval?.(current.projectId);
    }
    // Also fsync when the tombstone was already absent: a previous attempt may
    // have removed it and failed before durably recording the directory entry.
    fsyncDirectory(root);
    const now = new Date().toISOString();
    this.db.update(projectDeletionReceipts).set({
      storageCleanupCompleted: 1,
      lastError: null,
      updatedAt: now,
      completedAt: now,
    }).where(eq(projectDeletionReceipts.projectId, current.projectId)).run();
  }

  /** Commit the irreversible SQLite purge and its durable receipt. Fallible
   * tombstone removal is deliberately a separate retryable operation. */
  commitProjectDeletion(id: string, beforeProjectionDelete?: (projectId: string) => void): ProjectDeletionReceipt | undefined {
    const priorReceipt = this.getProjectDeletionReceipt(id);
    if (priorReceipt) return priorReceipt;
    const current = this.getProject(id);
    if (!current) return undefined;
    const agentIds = this.listAgents(id).map((agent) => agent.id);
    const canonicalDir = projectDir(this.dataDir, id);
    this.markProjectDeletionPending(id);
    const pending = this.db.select().from(projectDeletionPending)
      .where(eq(projectDeletionPending.projectId, id)).get();
    const tombstoneName = pending?.tombstoneName ?? `.${id}.deleting-${randomUUID()}`;
    if (tombstoneName.includes("/") || tombstoneName.includes("\\") ||
        !tombstoneName.startsWith(`.${id}.deleting-`)) {
      throw new Error("invalid Project deletion recovery journal");
    }
    this.db.update(projectDeletionPending).set({ tombstoneName })
      .where(eq(projectDeletionPending.projectId, id)).run();
    const parentDir = dirname(canonicalDir);
    const deletingDir = join(parentDir, tombstoneName);
    renameSync(canonicalDir, deletingDir);
    fsyncDirectory(parentDir);
    const now = new Date().toISOString();
    try {
      this.db.transaction(() => {
        beforeProjectionDelete?.(id);
        this.client.prepare(`DELETE FROM events WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`)
          .run(id);
        this.client.prepare(`DELETE FROM artifacts WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`)
          .run(id);
        this.client.prepare(`DELETE FROM work_items WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`)
          .run(id);
        this.client.prepare(`DELETE FROM runs WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`)
          .run(id);
        this.client.prepare(`DELETE FROM provider_inputs WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM messages WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`)
          .run(id);
        this.client.prepare(`DELETE FROM agent_conversation_memberships WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`)
          .run(id);
        this.client.prepare(`DELETE FROM agent_presets WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM agent_management_approvals WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM project_deletion_pending WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM agent_deletion_tombstones WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM agent_deletion_receipts WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM all_chat_feed_projection WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM chat_search_messages WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM managed_artifact_projection WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM conversations WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM agents WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
        this.db.insert(projectDeletionReceipts).values({
          projectId: id,
          tombstoneName,
          storageCleanupCompleted: 0,
          createdAt: now,
          updatedAt: now,
        }).run();
      });
    } catch (error) {
      renameSync(deletingDir, canonicalDir);
      fsyncDirectory(parentDir);
      throw error;
    }
    this.communicationEventCache.delete(id);
    this.communicationRevisionCache.delete(id);
    this.communicationProjectionCache.delete(id);
    this.messageDispatchCache.delete(id);
    for (const agentId of agentIds) {
      this.eventProjection.forgetAgent(agentId);
    }
    return this.getProjectDeletionReceipt(id)!;
  }

  /** Permanently remove the canonical project tree and every rebuildable
   * projection. The callback shares the projection-deletion transaction so
   * authoritative runtime state cannot survive a deleted Project row. */
  deleteProject(id: string, beforeProjectionDelete?: (projectId: string) => void): boolean {
    const receipt = this.commitProjectDeletion(id, beforeProjectionDelete);
    if (!receipt) return false;
    try { this.finishProjectDeletionStorageCleanup(receipt); }
    catch (error) {
      this.recordProjectDeletionReceiptCleanupError(id, error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  listAgentPresets(projectId: string): AgentPresetDto[] {
    return this.db.select().from(agentPresets).where(eq(agentPresets.projectId, projectId)).orderBy(asc(agentPresets.name)).all().map((r) => ({ ...r, model: r.model ?? undefined, effort: r.effort ?? undefined, enabled: r.enabled === 1, engine: r.engine as AgentPresetDto["engine"] }));
  }
  getAgentPreset(id: string): AgentPresetDto | undefined {
    const r = this.db.select().from(agentPresets).where(eq(agentPresets.id, id)).get();
    return r ? { ...r, model: r.model ?? undefined, effort: r.effort ?? undefined, enabled: r.enabled === 1, engine: r.engine as AgentPresetDto["engine"] } : undefined;
  }
  createAgentPreset(projectId: string, input: CreateAgentPresetRequest): AgentPresetDto {
    if (!this.getProject(projectId)) throw new Error("unknown project");
    const now = new Date().toISOString();
    const preset: AgentPresetDto = { id: randomUUID(), projectId, ...input, enabled: input.enabled ?? true, createdAt: now, updatedAt: now };
    appendFsyncedJsonl(agentPresetsPath(this.dataDir, projectId), [{ type: "upsert", preset } satisfies PresetEvent]);
    this.db.insert(agentPresets).values({ ...preset, enabled: preset.enabled ? 1 : 0 }).run(); return preset;
  }
  updateAgentPreset(id: string, patch: UpdateAgentPresetRequest): AgentPresetDto | undefined {
    const current = this.getAgentPreset(id); if (!current) return undefined;
    const next = { ...current, ...patch, model: patch.model === null ? undefined : patch.model ?? current.model, effort: patch.effort === null ? undefined : patch.effort ?? current.effort, updatedAt: new Date().toISOString() } as AgentPresetDto;
    appendFsyncedJsonl(agentPresetsPath(this.dataDir, current.projectId), [{ type: "upsert", preset: next } satisfies PresetEvent]);
    this.db.update(agentPresets).set({ ...next, model: next.model ?? null, effort: next.effort ?? null, enabled: next.enabled ? 1 : 0 }).where(eq(agentPresets.id, id)).run(); return next;
  }
  deleteAgentPreset(id: string): boolean {
    const current = this.getAgentPreset(id); if (!current) return false;
    appendFsyncedJsonl(agentPresetsPath(this.dataDir, current.projectId), [{ type: "delete", id, at: new Date().toISOString() } satisfies PresetEvent]);
    this.db.delete(agentPresets).where(eq(agentPresets.id, id)).run(); return true;
  }

  listProjects(): ProjectDto[] {
    return this.db
      .select()
      .from(projects)
      .all()
      .map((r) => ({
        id: r.id,
        label: r.label,
        hostPath: r.hostPath,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt ?? undefined,
        defaultEngine: r.defaultEngine as ProjectDto["defaultEngine"],
        defaultModel: r.defaultModel ?? undefined,
        defaultEffort: r.defaultEffort ?? undefined,
        lastConversationId: r.lastConversationId ?? undefined,
        ...this.projectInstructions(r.id),
      }));
  }

  getProject(id: string): ProjectDto | undefined {
    const r = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!r) return undefined;
    return {
      id: r.id,
      label: r.label,
      hostPath: r.hostPath,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt ?? undefined,
      defaultEngine: r.defaultEngine as ProjectDto["defaultEngine"],
      defaultModel: r.defaultModel ?? undefined,
      defaultEffort: r.defaultEffort ?? undefined,
      lastConversationId: r.lastConversationId ?? undefined,
      ...this.projectInstructions(r.id),
    };
  }

  private projectInstructions(id: string): Pick<ProjectDto, "instructions"> {
    try {
      const value = readJson<ProjectJson>(projectJsonPath(this.dataDir, id)).instructions;
      return value ? { instructions: value } : {};
    } catch {
      return {};
    }
  }

  markProjectUsed(projectId: string, conversationId?: string): ProjectDto | undefined {
    const project = this.getProject(projectId);
    if (!project) return undefined;
    if (conversationId) {
      const conversation = this.getConversation(conversationId);
      if (!conversation || conversation.projectId !== projectId || conversation.archived) throw new Error("conversation is unavailable");
    }
    const lastUsedAt = new Date().toISOString();
    const next = { ...project, lastUsedAt, lastConversationId: conversationId ?? project.lastConversationId };
    writeJson(projectJsonPath(this.dataDir, projectId), next);
    this.db.update(projects).set({ lastUsedAt, ...(conversationId ? { lastConversationId: conversationId } : {}) }).where(eq(projects.id, projectId)).run();
    return next;
  }

  // ─── Conversations ─────────────────────────────────────────────────────────

  createConversation(projectId: string, input: CreateConversationRequest): ConversationDto {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`unknown project: ${projectId}`);
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: ConversationJson = {
      id,
      projectId,
      title: input.title || "New Chat",
      defaultEngine: input.defaultEngine ?? project.defaultEngine,
      defaultModel: input.defaultModel,
      defaultEffort: input.defaultEffort,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    mkdirSync(conversationDir(this.dataDir, projectId, id), { recursive: true });
    writeJson(conversationJsonPath(this.dataDir, projectId, id), record);
    this.db
      .insert(conversations)
      .values({
        id,
        projectId,
      title: input.title || "New Chat",
        defaultEngine: input.defaultEngine ?? project.defaultEngine,
        defaultModel: input.defaultModel ?? null,
        defaultEffort: input.defaultEffort ?? null,
        createdAt: now,
        updatedAt: now,
        archived: 0,
      })
      .run();
    this.markProjectUsed(projectId, id);
    return this.conversationRowToDto(
      this.db.select().from(conversations).where(eq(conversations.id, id)).get()!,
    );
  }

  listConversations(projectId: string): ConversationDto[] {
    return this.db
      .select()
      .from(conversations)
      .where(eq(conversations.projectId, projectId))
      .orderBy(asc(conversations.createdAt))
      .all()
      .map((row) => this.conversationRowToDto(row));
  }

  getConversation(id: string): ConversationDto | undefined {
    const row = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    return row ? this.conversationRowToDto(row) : undefined;
  }

  getConversationDetail(id: string): ConversationDetailDto | undefined {
    const conversation = this.getConversation(id);
    if (!conversation) return undefined;
    return {
      conversation,
      messages: this.getConversationMessages(id, "main"),
      agents: this.listAgents(conversation.projectId).filter((agent) => agent.conversationIds.includes(id)),
    };
  }

  getCollaborationViewDetail(id: string): CollaborationViewDto | undefined {
    const conversation = this.getConversation(id);
    if (!conversation) return undefined;
    return {
      messages: this.getConversationMessages(id, "collaboration"),
      agents: this.listAgents(conversation.projectId).filter((agent) => agent.conversationIds.includes(id)),
    };
  }

  updateConversation(id: string, patch: UpdateConversationRequest): ConversationDto | undefined {
    const row = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!row) return undefined;
    const now = new Date().toISOString();
    const next = {
      title: patch.title ?? row.title,
      defaultEngine: patch.defaultEngine === undefined ? row.defaultEngine : patch.defaultEngine,
      defaultModel: patch.defaultModel === undefined ? row.defaultModel : patch.defaultModel,
      defaultEffort: patch.defaultEffort === undefined ? row.defaultEffort : patch.defaultEffort,
      archived: patch.archived ?? row.archived === 1,
    };
    this.db
      .update(conversations)
      .set({
        title: next.title,
        defaultEngine: next.defaultEngine,
        defaultModel: next.defaultModel,
        defaultEffort: next.defaultEffort,
        archived: next.archived ? 1 : 0,
        updatedAt: now,
      })
      .where(eq(conversations.id, id))
      .run();
    const json = readJson<ConversationJson>(conversationJsonPath(this.dataDir, row.projectId, id));
    writeJson(conversationJsonPath(this.dataDir, row.projectId, id), {
      ...json,
      ...next,
      defaultEngine: next.defaultEngine ?? undefined,
      defaultModel: next.defaultModel ?? undefined,
      defaultEffort: next.defaultEffort ?? undefined,
      updatedAt: now,
    });
    if (next.archived !== (row.archived === 1)) this.chatFeed.refreshAllChatFeedProject(row.projectId);
    return this.getConversation(id);
  }

  /** Permanently remove a conversation while preserving its agents as unassigned agents. */
  deleteConversation(id: string, beforeMembershipDelete?: (agentId: string, conversationId: string) => void): boolean {
    const row = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!row) return false;
    const linkedAgents = this.listAgents(row.projectId).filter((agent) => agent.conversationIds.includes(id));
    this.db.transaction((tx) => {
      // Communication V3 shares this SQLite connection, so Trigger deletion,
      // pending-work cancellation, and membership removal commit atomically.
      for (const agent of linkedAgents) beforeMembershipDelete?.(agent.id, id);
      tx.delete(agentConversationMemberships).where(eq(agentConversationMemberships.conversationId, id)).run();
      tx.delete(conversations).where(eq(conversations.id, id)).run();
    });
    for (const agent of linkedAgents) {
      const remaining = agent.conversationIds.filter((memberId) => memberId !== id);
      const primary = agent.conversationId === id ? remaining[0] : agent.conversationId;
      this.persistAgentMemberships(agent.id, remaining, primary);
    }
    rmSync(conversationDir(this.dataDir, row.projectId, id), { recursive: true, force: true });
    this.chatFeed.refreshAllChatFeedProject(row.projectId);
    return true;
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

  getConversationDeliveryIntents(conversationId: string, createdAtOrAfter?: string): Array<{
    message: ConversationMessageDto;
    intent: ConversationDeliveryIntent;
    messageReceiptKey?: string;
    deliveryOrderKey: string;
  }> {
    return this.conversationProjection.getDeliveryIntents(conversationId, createdAtOrAfter);
  }

  getConversationMessageByReceiptKey(
    conversationId: string,
    receiptKey: string,
  ): ConversationMessageDto | undefined {
    return this.conversationProjection.getMessageByReceiptKey(conversationId, receiptKey);
  }

  getConversationMessages(
    conversationId: string,
    channel: ConversationChannel = "main",
  ): ConversationMessageDto[] {
    return this.conversationProjection.getMessages(conversationId, channel);
  }

  getProjectedConversationMessages(
    conversationId: string,
    channel: ConversationChannel = "main",
    limit?: number,
  ): ConversationMessageDto[] {
    return this.conversationProjection.getProjectedMessages(conversationId, channel, limit);
  }

  getCanonicalConversationContextMessages(
    conversationId: string,
    channel: ConversationChannel = "main",
  ): ConversationMessageDto[] {
    return this.conversationProjection.getCanonicalContextMessages(conversationId, channel);
  }

  getOrganizationalConversationContextSourcePage(
    conversationId: string,
    input: { limit: number; before?: ContextReadBoundary; excludeCommunicationEventId?: string },
  ): ContextSourcePage<ConversationMessageDto> {
    return this.conversationProjection.getOrganizationalContextSourcePage(conversationId, input);
  }

  getOrganizationalConversationDeltaPage(
    conversationId: string,
    input: { limit: number; afterMessageId?: string; excludeCommunicationEventId?: string },
  ): ContextSourcePage<ConversationMessageDto> & { cursorFound: boolean; latestMessageId?: string } {
    return this.conversationProjection.getOrganizationalDeltaPage(conversationId, input);
  }

  getProjectedConversationMessagePage(
    conversationId: string,
    channel: ConversationChannel,
    input: { limit: number; cursor?: string; focusId?: string },
  ): { messages: ConversationMessageDto[]; hasMore: boolean; cursor?: string } {
    return this.conversationProjection.getMessagePage(conversationId, channel, input);
  }

  getProjectedConversationMessageById(
    conversationId: string,
    channel: ConversationChannel,
    id: string,
  ): ConversationMessageDto | undefined {
    return this.conversationProjection.getMessageById(conversationId, channel, id);
  }

  // ─── Agents ───────────────────────────────────────────────────────────────

  createAgent(projectId: string, input: CreateAgentRequest, origin?: AgentSpawnOrigin): AgentDto {
    const id = randomUUID();
    const now = new Date().toISOString();
    const preset = input.presetId ? this.getAgentPreset(input.presetId) : undefined;
    if (input.presetId && (!preset || preset.projectId !== projectId || !preset.enabled)) throw new Error("invalid preset");
    const presetSnapshot = preset ? { id: preset.id, name: preset.name, description: preset.description, guidance: preset.guidance, engine: preset.engine, model: preset.model, effort: preset.effort } : undefined;
    const model = preset?.model ?? input.model;
    const effort = preset?.effort ?? input.effort;
    const managementPermissions = input.managementPermissions
      ? requireManagementPermissions(input.managementPermissions)
      : { allowAutomaticDescendantDeletion: false, allowAutomaticDescendantReorganization: false };
    const record: AgentJson = {
      id,
      projectId,
      conversationId: input.conversationId,
      conversationIds: input.conversationId ? [input.conversationId] : [],
      title: input.title,
      activeEngine: input.engine,
      model,
      effort,
      createdAt: now,
      updatedAt: now,
      archived: false,
      managementPermissions,
      spawnedByAgentId: origin?.agentId,
      spawnedByExecutionId: origin?.executionId,
      spawnPrompt: origin?.prompt,
      spawnIdempotencyKey: origin?.idempotencyKey,
      presetSnapshot,
    };
    mkdirSync(agentDir(this.dataDir, projectId, id), { recursive: true });
    mkdirSync(artifactsDir(this.dataDir, projectId, id), { recursive: true });
    mkdirSync(attachmentsDir(this.dataDir, projectId, id), { recursive: true });
    writeJson(agentJsonPath(this.dataDir, projectId, id), record);
    this.db
      .insert(agents)
      .values({
        id,
        projectId,
        conversationId: input.conversationId ?? null,
        title: input.title,
        activeEngine: input.engine,
        model: model ?? null,
        effort: effort ?? null,
        createdAt: now,
        updatedAt: now,
        archived: 0,
        allowAutomaticDescendantDeletion: managementPermissions.allowAutomaticDescendantDeletion ? 1 : 0,
        allowAutomaticDescendantReorganization: managementPermissions.allowAutomaticDescendantReorganization ? 1 : 0,
        spawnedByAgentId: origin?.agentId ?? null,
        spawnedByExecutionId: origin?.executionId ?? null,
        spawnPrompt: origin?.prompt ?? null,
        spawnIdempotencyKey: origin?.idempotencyKey ?? null,
        presetSnapshotJson: presetSnapshot ? JSON.stringify(presetSnapshot) : null,
      })
      .run();
    if (input.conversationId) {
      this.db.insert(agentConversationMemberships).values({ agentId: id, conversationId: input.conversationId, position: 0 }).run();
    }
    if (input.managerAgentId) this.updateAgentOrganization(id, { managerAgentId: input.managerAgentId });
    return this.rowToAgentDto(id)!;
  }

  findAgentSpawn(agentId: string, executionId: string, idempotencyKey: string): AgentDto | undefined {
    const row = this.db.select().from(agents).where(and(
      eq(agents.spawnedByAgentId, agentId),
      eq(agents.spawnedByExecutionId, executionId),
      eq(agents.spawnIdempotencyKey, idempotencyKey),
      isNull(agents.deletedAt),
    )).get();
    return row ? this.agentRowToDto(row) : undefined;
  }

  listAgents(projectId: string): AgentDto[] {
    return this.db
      .select()
      .from(agents)
      .where(and(eq(agents.projectId, projectId), isNull(agents.deletedAt)))
      .all()
      .map((r) => this.agentRowToDto(r));
  }

  getAgent(id: string): AgentDto | undefined {
    const row = this.db.select().from(agents).where(and(eq(agents.id, id), isNull(agents.deletedAt))).get();
    return row ? this.agentRowToDto(row) : undefined;
  }

  setImportedHistory(agentId: string, source: string, messages: PortableAgentHistoryMessageDto[]): void {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const bounded = messages.map((message) => ({
      role: message.role,
      text: message.text.slice(0, 100_000),
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    }));
    const imported = { source: source.slice(0, 240), importedAt: new Date().toISOString(), messages: bounded };
    writeJson(importedAgentHistoryPath(this.dataDir, agent.projectId, agent.id), imported);
    this.projectImportedHistory(agent.id, imported);
  }

  getImportedHistory(agentId: string): { source: string; importedAt: string; messages: PortableAgentHistoryMessageDto[] } | undefined {
    const agent = this.getAgent(agentId);
    if (!agent) return undefined;
    const file = importedAgentHistoryPath(this.dataDir, agent.projectId, agent.id);
    if (!existsSync(file)) return undefined;
    return readJson(file);
  }

  private projectImportedHistory(
    agentId: string,
    imported: { source: string; importedAt: string; messages: PortableAgentHistoryMessageDto[] },
  ): void {
    this.db.transaction((tx) => {
      tx.delete(importedHistoryMessages).where(eq(importedHistoryMessages.agentId, agentId)).run();
      imported.messages.forEach((message, sequence) => {
        tx.insert(importedHistoryMessages).values({
          agentId,
          messageId: `imported:${agentId}:${String(sequence).padStart(12, "0")}`,
          sequence,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt ?? imported.importedAt,
        }).run();
      });
    });
  }

  getImportedHistoryMessagePage(
    agentId: string,
    input: { limit: number; before?: ContextReadBoundary },
  ): ContextSourcePage<MessageDto> {
    const limit = Math.max(1, Math.min(input.limit, 100));
    const rows = this.client.prepare(`
      SELECT message_id, sequence, role, text, created_at
      FROM imported_history_messages
      WHERE agent_id = ?
        ${input.before ? "AND (created_at < ? OR (created_at = ? AND message_id < ?))" : ""}
      ORDER BY created_at DESC, message_id DESC
      LIMIT ?
    `).all(...(input.before
      ? [agentId, input.before.createdAt, input.before.createdAt, input.before.id, limit + 1]
      : [agentId, limit + 1])) as Array<{
      message_id: string; sequence: number; role: PortableAgentHistoryMessageDto["role"];
      text: string; created_at: string;
    }>;
    return {
      hasMore: rows.length > limit,
      items: rows.slice(0, limit).map((row) => ({
        id: row.message_id,
        agentId,
        seq: -(row.sequence + 1),
        role: row.role === "assistant" ? "assistant" : "user",
        text: row.role === "system" ? `[Imported private context]\n${row.text}` : row.text,
        createdAt: row.created_at,
      })),
    };
  }

  listAgentSubtree(id: string): AgentDto[] {
    const root = this.getAgent(id);
    if (!root) return [];
    const projectAgents = this.listAgents(root.projectId);
    const children = new Map<string, AgentDto[]>();
    for (const agent of projectAgents) {
      if (!agent.managerAgentId) continue;
      children.set(agent.managerAgentId, [...(children.get(agent.managerAgentId) ?? []), agent]);
    }
    const ordered: AgentDto[] = [];
    const visit = (agent: AgentDto) => {
      ordered.push(agent);
      for (const child of children.get(agent.id) ?? []) visit(child);
    };
    visit(root);
    return ordered;
  }

  createAgentManagementApproval(input: {
    decisionId: string;
    planId: string;
    projectId: string;
    conversationId: string;
    ownerAgentId: string;
    runId: string;
    scopeHash: string;
  }): void {
    const now = new Date().toISOString();
    this.client.prepare(`
      INSERT INTO agent_management_approvals (
        decision_id, plan_id, project_id, conversation_id, owner_agent_id,
        run_id, scope_hash, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      input.decisionId, input.planId, input.projectId, input.conversationId,
      input.ownerAgentId, input.runId, input.scopeHash, now,
    );
  }

  resolveAgentManagementApproval(decisionId: string, approved: boolean, at = new Date().toISOString()): boolean {
    return this.client.transaction(() => {
      const row = this.client.prepare(`
        SELECT status FROM agent_management_approvals WHERE decision_id = ?
      `).get(decisionId) as { status: string } | undefined;
      if (!row) return false;
      const desired = approved ? "approved" : "denied";
      if (row.status === desired) return true;
      if (row.status !== "pending") throw new Error("management approval is already terminal");
      this.client.prepare(`
        UPDATE agent_management_approvals SET status = ?, resolved_at = ? WHERE decision_id = ?
      `).run(desired, at, decisionId);
      return true;
    })();
  }

  /** Revalidate current owner authority and consume one exact approval in the
   * same SQLite transaction as the caller's destructive projection mutation. */
  authorizeAgentManagementPlan(
    authorization: AgentManagementAuthorization,
    targetAgentIds: readonly string[],
    consumeApproval = true,
  ): void {
    const owner = this.getAgent(authorization.ownerAgentId);
    if (!owner || owner.projectId !== authorization.projectId || owner.archived) {
      throw new Error("management owner is no longer active in this Project");
    }
    const descendants = new Set(this.listAgentSubtree(owner.id).slice(1).map((agent) => agent.id));
    if (targetAgentIds.some((id) => !descendants.has(id))) {
      throw new Error("management authority changed; a target is no longer inside the owner's subtree");
    }
    const permissionEnabled = authorization.permission === "deletion"
      ? owner.managementPermissions.allowAutomaticDescendantDeletion
      : owner.managementPermissions.allowAutomaticDescendantReorganization;
    if (!authorization.approvalDecisionId) {
      if (!permissionEnabled) throw new Error(`automatic descendant ${authorization.permission} permission was revoked`);
      return;
    }
    const approval = this.client.prepare(`
      SELECT plan_id, project_id, conversation_id, owner_agent_id, run_id,
             scope_hash, status
      FROM agent_management_approvals WHERE decision_id = ?
    `).get(authorization.approvalDecisionId) as {
      plan_id: string; project_id: string; conversation_id: string;
      owner_agent_id: string; run_id: string; scope_hash: string; status: string;
    } | undefined;
    if (!approval || approval.plan_id !== authorization.planId ||
        approval.project_id !== authorization.projectId ||
        approval.conversation_id !== authorization.conversationId ||
        approval.owner_agent_id !== authorization.ownerAgentId ||
        approval.run_id !== authorization.runId ||
        approval.scope_hash !== authorization.scopeHash) {
      throw new Error("management approval does not match this exact plan and Run");
    }
    if (approval.status !== "approved") throw new Error("management approval is not approved or was already consumed");
    if (!consumeApproval) return;
    const consumedAt = new Date().toISOString();
    const consumed = this.client.prepare(`
      UPDATE agent_management_approvals
      SET status = 'consumed', consumed_at = ?
      WHERE decision_id = ? AND status = 'approved'
    `).run(consumedAt, authorization.approvalDecisionId);
    if (consumed.changes !== 1) throw new Error("management approval was already consumed");
  }

  getAgentDeletionReceiptByPreviewHash(previewHash: string): AgentDeletionReceipt | undefined {
    const row = this.client.prepare(`SELECT * FROM agent_deletion_receipts WHERE preview_hash = ?`).get(previewHash) as {
      id: string; project_id: string; preview_hash: string; root_agent_ids_json: string;
      deleted_agent_ids_json: string; storage_cleanup_completed: number; server_cleanup_completed: number;
      last_error: string | null; created_at: string; updated_at: string; completed_at: string | null;
    } | undefined;
    return row ? {
      id: row.id,
      projectId: row.project_id,
      previewHash: row.preview_hash,
      rootAgentIds: JSON.parse(row.root_agent_ids_json) as string[],
      deletedAgentIds: JSON.parse(row.deleted_agent_ids_json) as string[],
      storageCleanupCompleted: row.storage_cleanup_completed === 1,
      serverCleanupCompleted: row.server_cleanup_completed === 1,
      ...(row.last_error ? { lastError: row.last_error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    } : undefined;
  }

  listPendingAgentDeletionReceipts(): AgentDeletionReceipt[] {
    const hashes = this.client.prepare(`
      SELECT preview_hash FROM agent_deletion_receipts
      WHERE storage_cleanup_completed = 0 OR server_cleanup_completed = 0
      ORDER BY created_at
    `).all() as Array<{ preview_hash: string }>;
    return hashes.flatMap(({ preview_hash }) => {
      const receipt = this.getAgentDeletionReceiptByPreviewHash(preview_hash);
      return receipt ? [receipt] : [];
    });
  }

  recordAgentDeletionCleanupError(receiptId: string, error: string): void {
    this.client.prepare(`
      UPDATE agent_deletion_receipts SET last_error = ?, updated_at = ? WHERE id = ?
    `).run(error.slice(0, 4_000), new Date().toISOString(), receiptId);
  }

  markAgentDeletionServerCleanupComplete(receiptId: string): void {
    const now = new Date().toISOString();
    this.client.prepare(`
      UPDATE agent_deletion_receipts
      SET server_cleanup_completed = 1, last_error = NULL, updated_at = ?,
          completed_at = CASE WHEN storage_cleanup_completed = 1 THEN ? ELSE completed_at END
      WHERE id = ?
    `).run(now, now, receiptId);
  }

  updateAgent(id: string, patch: UpdateAgentRequest): AgentDto | undefined {
    const row = this.db.select().from(agents).where(eq(agents.id, id)).get();
    if (!row || row.deletedAt) return undefined;
    const now = new Date().toISOString();
    const title = patch.title ?? row.title;
    const archived = patch.archived ?? row.archived === 1;
    const activeEngine = patch.activeEngine?.trim() || row.activeEngine;
    const model = patch.model === undefined ? row.model ?? undefined : patch.model?.trim() || undefined;
    const effort = patch.effort === undefined ? row.effort ?? undefined : patch.effort?.trim() || undefined;
    const managementPermissions = patch.managementPermissions
      ? requireManagementPermissions(patch.managementPermissions)
      : {
          allowAutomaticDescendantDeletion: row.allowAutomaticDescendantDeletion === 1,
          allowAutomaticDescendantReorganization: row.allowAutomaticDescendantReorganization === 1,
        };
    if (archived && row.archived !== 1) {
      for (const child of this.listAgents(row.projectId).filter((agent) => agent.managerAgentId === id)) {
        this.updateAgentOrganization(child.id, { managerAgentId: null });
      }
      if (this.getAgent(id)?.managerAgentId) this.updateAgentOrganization(id, { managerAgentId: null });
    }
    // Canonical metadata is crash-safe and durable before its rebuildable
    // SQLite projection changes. A crash can therefore never resurrect a
    // permission that the operator just revoked.
    const json = readJson<AgentJson>(agentJsonPath(this.dataDir, row.projectId, id));
    writeJson(agentJsonPath(this.dataDir, row.projectId, id), {
      ...json,
      title,
      archived,
      activeEngine,
      model,
      effort,
      managementPermissions,
      updatedAt: now,
    });
    this.db
      .update(agents)
      .set({
        title,
        archived: archived ? 1 : 0,
        activeEngine,
        model: model ?? null,
        effort: effort ?? null,
        allowAutomaticDescendantDeletion: managementPermissions.allowAutomaticDescendantDeletion ? 1 : 0,
        allowAutomaticDescendantReorganization: managementPermissions.allowAutomaticDescendantReorganization ? 1 : 0,
        updatedAt: now,
      })
      .where(eq(agents.id, id))
      .run();
    if (archived !== (row.archived === 1)) this.chatFeed.refreshAllChatFeedProject(row.projectId);
    return this.rowToAgentDto(id);
  }

  /** Change only the mutable organizational reporting line. */
  updateAgentOrganization(id: string, input: UpdateAgentOrganizationRequest): AgentDto | undefined {
    const agent = this.getAgent(id);
    if (!agent) return undefined;
    if (agent.archived) throw new Error("archived agents cannot be reorganized");
    const parentId = input.managerAgentId ?? undefined;
    if (parentId === id) throw new Error("an agent cannot report to itself");
    if (parentId) {
      const parent = this.getAgent(parentId);
      if (!parent || parent.projectId !== agent.projectId) throw new Error("organizational parent must belong to the same project");
      if (parent.archived) throw new Error("organizational parent must be active");
      const visited = new Set<string>([id]);
      let cursor: AgentDto | undefined = parent;
      while (cursor) {
        if (visited.has(cursor.id)) throw new Error("organizational parent would create a cycle");
        if (cursor.projectId !== agent.projectId || cursor.archived) throw new Error("organizational ancestry must contain active agents from the same project");
        visited.add(cursor.id);
        cursor = cursor.managerAgentId ? this.getAgent(cursor.managerAgentId) : undefined;
      }
    }
    if (agent.managerAgentId === parentId) return agent;
    const event: AgentOrganizationEvent = {
      eventId: randomUUID(), type: "manager_changed", projectId: agent.projectId,
      agentId: id, managerAgentId: parentId ?? null, createdAt: new Date().toISOString(),
    };
    appendFsyncedJsonl(agentOrganizationEventsPath(this.dataDir, agent.projectId), [event]);
    this.db.update(agents).set({
      managerAgentId: parentId ?? null,
      updatedAt: event.createdAt,
    }).where(eq(agents.id, id)).run();
    return this.getAgent(id);
  }

  applyAuthorizedAgentReorganization(
    authorization: AgentManagementAuthorization,
    operations: ReadonlyArray<{ targetAgentId: string; managerAgentId: string }>,
  ): string[] {
    return this.client.transaction(() => {
      this.authorizeAgentManagementPlan(
        authorization,
        [...new Set(operations.map((operation) => operation.targetAgentId))],
      );
      const projectAgents = this.listAgents(authorization.projectId);
      const byId = new Map(projectAgents.map((agent) => [agent.id, agent]));
      const managerById = new Map(projectAgents.map((agent) => [agent.id, agent.managerAgentId]));
      const currentDescendants = new Set(this.listAgentSubtree(authorization.ownerAgentId).slice(1).map((agent) => agent.id));
      for (const operation of operations) {
        const target = byId.get(operation.targetAgentId);
        const manager = byId.get(operation.managerAgentId);
        if (!target || !manager || target.archived || manager.archived) throw new Error("reorganization Agents must remain active");
        if (manager.id !== authorization.ownerAgentId && !currentDescendants.has(manager.id)) {
          throw new Error("management authority changed; a new manager is no longer inside the owner's subtree");
        }
        if (target.id === authorization.ownerAgentId || target.id === manager.id) throw new Error("reorganization cannot move the owner or create a self-cycle");
        managerById.set(target.id, manager.id);
        const visited = new Set<string>([target.id]);
        let cursor: string | undefined = manager.id;
        while (cursor) {
          if (visited.has(cursor)) throw new Error("organizational parent would create a cycle");
          visited.add(cursor);
          cursor = managerById.get(cursor);
        }
      }
      const createdAt = new Date().toISOString();
      const eventsToAppend: AgentOrganizationEvent[] = operations
        .filter((operation) => managerById.get(operation.targetAgentId) !== byId.get(operation.targetAgentId)?.managerAgentId)
        .map((operation) => ({
          eventId: randomUUID(),
          type: "manager_changed",
          projectId: authorization.projectId,
          agentId: operation.targetAgentId,
          managerAgentId: operation.managerAgentId,
          createdAt,
        }));
      if (eventsToAppend.length > 0) {
        for (const event of eventsToAppend) this.client.prepare(`
          UPDATE agents SET manager_agent_id = ?, updated_at = ? WHERE id = ?
        `).run(event.managerAgentId, event.createdAt, event.agentId);
        // The canonical log append is the last statement in the transaction. A
        // failing UPDATE now rolls back before anything reaches the log, rather
        // than leaving a durable record of a reorganization SQLite rejected --
        // which a later projection rebuild would have replayed as real. The
        // remaining window, a crash between this append and COMMIT, is the one
        // setAgentManager already has and resolves the same way: the log is
        // canonical and the rebuild reapplies it.
        appendFsyncedJsonl(agentOrganizationEventsPath(this.dataDir, authorization.projectId), eventsToAppend);
      }
      return [...new Set(operations.map((operation) => operation.targetAgentId))];
    })();
  }

  readAgentOrganizationEvents(projectId: string): AgentOrganizationEvent[] {
    if (!this.getProject(projectId)) throw new Error("organization project not found");
    return readRepairableJsonl<AgentOrganizationEvent>(
      agentOrganizationEventsPath(this.dataDir, projectId), "agent organization log", true,
    );
  }

  updateAgentConversationMemberships(
    id: string,
    input: UpdateAgentConversationMembershipsRequest,
    beforeMembershipProjectionChange?: (agentId: string, removedConversationIds: string[]) => void,
  ): AgentDto | undefined {
    const agent = this.getAgent(id);
    if (!agent) return undefined;
    const ids = [...new Set(input.conversationIds)];
    if (ids.length !== input.conversationIds.length) throw new Error("duplicate conversation membership");
    if (ids.length > 0 && !input.primaryConversationId) throw new Error("primary conversation is required");
    if (input.primaryConversationId && !ids.includes(input.primaryConversationId)) {
      throw new Error("primary conversation must be a member");
    }
    for (const conversationId of ids) {
      const master = this.getConversation(conversationId);
      if (!master || master.projectId !== agent.projectId) throw new Error("conversation does not belong to project");
      if (master.archived && !agent.conversationIds.includes(conversationId)) throw new Error("archived conversation cannot accept agents");
    }
    const removedConversationIds = agent.conversationIds.filter((conversationId) => !ids.includes(conversationId));
    this.persistAgentMemberships(id, ids, input.primaryConversationId, () =>
      beforeMembershipProjectionChange?.(id, removedConversationIds));
    return this.getAgent(id);
  }

  /** Compute the exact server-authoritative cascade the operator will confirm. */
  previewAgentDeletion(rootAgentIds: string[]): AgentDeletionPreviewDto {
    const requested = [...new Set(rootAgentIds)].sort();
    if (requested.length < 1 || requested.length > 100) throw new Error("deletion requires 1 to 100 root Agent IDs");
    const roots = requested.map((id) => this.getAgent(id));
    if (roots.some((agent) => !agent)) throw new Error("agent not found");
    const projectId = roots[0]!.projectId;
    if (roots.some((agent) => agent!.projectId !== projectId)) throw new Error("deletion roots must belong to one Project");
    const projectAgents = this.listAgents(projectId);
    const byId = new Map(projectAgents.map((agent) => [agent.id, agent]));
    const requestedSet = new Set(requested);
    const normalizedRoots = roots.filter((agent) => {
      let managerId = agent!.managerAgentId;
      const visited = new Set<string>();
      while (managerId && !visited.has(managerId)) {
        if (requestedSet.has(managerId)) return false;
        visited.add(managerId);
        managerId = byId.get(managerId)?.managerAgentId;
      }
      return true;
    }).map((agent) => agent!.id).sort();
    const children = new Map<string, AgentDto[]>();
    for (const agent of projectAgents) if (agent.managerAgentId) {
      children.set(agent.managerAgentId, [...(children.get(agent.managerAgentId) ?? []), agent]);
    }
    const affectedIds = new Set<string>();
    const visit = (id: string): void => {
      if (affectedIds.has(id)) return;
      affectedIds.add(id);
      for (const child of children.get(id) ?? []) visit(child.id);
    };
    normalizedRoots.forEach(visit);
    const affectedAgents = [...affectedIds].sort().map((id) => {
      const agent = byId.get(id)!;
      return { id: agent.id, title: agent.title, ...(agent.managerAgentId ? { managerAgentId: agent.managerAgentId } : {}) };
    });
    const previewHash = createHash("sha256").update(JSON.stringify({
      projectId,
      rootAgentIds: normalizedRoots,
      affectedAgents: affectedAgents.map((agent) => ({
        id: agent.id,
        title: agent.title,
        managerAgentId: agent.managerAgentId ?? null,
      })),
    })).digest("hex");
    return { projectId, rootAgentIds: normalizedRoots, affectedAgents, previewHash };
  }

  /**
   * Validate and permanently delete every confirmed subtree in one SQLite
   * transaction. Canonical directories are first renamed to hidden tombstones;
   * a crash can therefore never resurrect a committed deletion during rebuild.
   */
  deleteAgentSubtrees(
    rootAgentIds: string[],
    expectedPreviewHash: string,
    beforeProjectionDelete?: (agentId: string) => void,
    authorization?: AgentManagementAuthorization,
  ): AgentDeletionPreviewDto {
    let committedPreview: AgentDeletionPreviewDto | undefined;
    const stagedDirectories = new Map<string, { canonical: string; tombstone: string; tombstoneName: string }>();
    try {
      this.db.transaction((tx) => {
        const current = this.previewAgentDeletion(rootAgentIds);
        if (current.previewHash !== expectedPreviewHash) throw new AgentDeletionConflictError(current);
        if (authorization) {
          this.authorizeAgentManagementPlan(authorization, current.affectedAgents.map((agent) => agent.id));
        }
        committedPreview = current;
        for (const agent of current.affectedAgents) {
          const canonical = agentDir(this.dataDir, current.projectId, agent.id);
          const tombstoneName = `.${agent.id}.deleting-${randomUUID()}`;
          const tombstone = join(agentsDir(this.dataDir, current.projectId), tombstoneName);
          renameSync(canonical, tombstone);
          stagedDirectories.set(agent.id, { canonical, tombstone, tombstoneName });
        }
        // Make every rename durable before SQLite is allowed to commit. The
        // journal rows below distinguish a committed deletion from a crash
        // before commit and let startup either finish or restore it.
        fsyncDirectory(agentsDir(this.dataDir, current.projectId));
        const createdAt = new Date().toISOString();
        const receiptId = `agent-deletion-${current.previewHash}`;
        tx.insert(agentDeletionReceipts).values({
          id: receiptId,
          projectId: current.projectId,
          previewHash: current.previewHash,
          rootAgentIdsJson: JSON.stringify(current.rootAgentIds),
          deletedAgentIdsJson: JSON.stringify(current.affectedAgents.map((agent) => agent.id)),
          storageCleanupCompleted: 0,
          serverCleanupCompleted: 0,
          createdAt,
          updatedAt: createdAt,
        }).run();
        for (const [agentId, staged] of stagedDirectories) tx.insert(agentDeletionTombstones).values({
          agentId,
          projectId: current.projectId,
          tombstoneName: staged.tombstoneName,
          createdAt,
        }).run();
        // Coordination V3 shares this SQLite connection. Its nested
        // transactions become savepoints, so all scheduler outcomes and every
        // selected Agent authority fence commit or roll back as one unit.
        for (const agent of current.affectedAgents) beforeProjectionDelete?.(agent.id);
        for (const agent of current.affectedAgents) {
          tx.delete(agentConversationMemberships).where(eq(agentConversationMemberships.agentId, agent.id)).run();
          tx.update(agents).set({
            conversationId: null,
            activeSessionId: null,
            activeSessionContractHash: null,
            activeSessionArtifactIdsJson: "[]",
            archived: 1,
            managerAgentId: null,
            allowAutomaticDescendantDeletion: 0,
            allowAutomaticDescendantReorganization: 0,
            deletedAt: createdAt,
            updatedAt: createdAt,
          }).where(eq(agents.id, agent.id)).run();
        }
      });
    } catch (error) {
      for (const { canonical, tombstone } of [...stagedDirectories.values()].reverse()) {
        if (existsSync(tombstone) && !existsSync(canonical)) renameSync(tombstone, canonical);
      }
      for (const directory of new Set([...stagedDirectories.values()].map(({ canonical }) => dirname(canonical)))) {
        if (existsSync(directory)) fsyncDirectory(directory);
      }
      throw error;
    }
    // The irreversible SQLite commit already succeeded. Storage cleanup is an
    // idempotent receipt-backed follow-up and must never turn success into an
    // HTTP failure.
    const receipt = this.getAgentDeletionReceiptByPreviewHash(expectedPreviewHash)!;
    try { this.finishAgentDeletionStorageCleanup(receipt); }
    catch (error) {
      this.recordAgentDeletionCleanupError(receipt.id, error instanceof Error ? error.message : "Agent storage cleanup failed");
    }
    this.chatFeed.refreshAllChatFeedProject(committedPreview!.projectId);
    return committedPreview!;
  }

  finishAgentDeletionStorageCleanup(receipt: AgentDeletionReceipt): void {
    if (receipt.storageCleanupCompleted) return;
    const touchedDirectories = new Set<string>();
    for (const agentId of receipt.deletedAgentIds) {
      const row = this.client.prepare(`
        SELECT project_id, tombstone_name, created_at FROM agent_deletion_tombstones WHERE agent_id = ?
      `).get(agentId) as { project_id: string; tombstone_name: string; created_at: string } | undefined;
      if (row) {
        const directory = agentsDir(this.dataDir, row.project_id);
        const tombstone = join(directory, row.tombstone_name);
        const canonical = agentDir(this.dataDir, row.project_id, agentId);
        if (existsSync(tombstone)) {
          // Upload staging and attachment capability state are live authority,
          // not deletion-surviving execution audit.
          rmSync(join(tombstone, "attachments"), { recursive: true, force: true });
          const metadataPath = join(tombstone, "agent.json");
          const metadata = readJson<AgentJson>(metadataPath);
          writeJson(metadataPath, {
            ...metadata,
            conversationId: undefined,
            conversationIds: [],
            archived: true,
            deletedAt: row.created_at,
            updatedAt: row.created_at,
            managementPermissions: {
              allowAutomaticDescendantDeletion: false,
              allowAutomaticDescendantReorganization: false,
            },
          });
          if (existsSync(canonical)) throw new Error("deleted Agent audit destination already exists");
          renameSync(tombstone, canonical);
        }
        touchedDirectories.add(directory);
      }
      this.eventProjection.forgetAgent(agentId);
    }
    for (const directory of touchedDirectories) if (existsSync(directory)) fsyncDirectory(directory);
    this.db.transaction((tx) => {
      for (const agentId of receipt.deletedAgentIds) {
        tx.delete(agentDeletionTombstones).where(eq(agentDeletionTombstones.agentId, agentId)).run();
      }
      const now = new Date().toISOString();
      tx.update(agentDeletionReceipts).set({
        storageCleanupCompleted: 1,
        lastError: null,
        updatedAt: now,
        completedAt: receipt.serverCleanupCompleted ? now : null,
      }).where(eq(agentDeletionReceipts.id, receipt.id)).run();
    });
  }

  /** Internal exact-current deletion convenience for rollback and fixtures. */
  deleteAgent(id: string, beforeProjectionDelete?: (agentId: string) => void): boolean {
    if (!this.getAgent(id)) return false;
    const preview = this.previewAgentDeletion([id]);
    this.deleteAgentSubtrees(preview.rootAgentIds, preview.previewHash, beforeProjectionDelete);
    return true;
  }

  /** Full agent-detail hydration for GET /api/agents/:id (SPEC §8). */
  getAgentDetail(id: string, limit?: number, includeMessages = true): AgentDetailDto | undefined {
    const agent = this.rowToAgentDto(id);
    if (!agent) return undefined;
    const messages = includeMessages ? this.getMessages(id) : [];
    const runOutputPage = limit === undefined ? undefined : this.getRunOutputPage(id, { limit });
    const activityPage = limit === undefined ? undefined : this.getActivityPage(id, { limit });
    const changedFilePage = this.getChangedFilePage(id, { limit: limit ?? 100 });
    const runPage = limit === undefined ? undefined : this.getRunPage(id, { limit });
    const workItemPage = limit === undefined ? undefined : this.getWorkItemPage(id, { limit });
    const artifactPage = limit === undefined ? undefined : this.getArtifactPage(id, { limit });
    return {
      agent,
      messages: limit === undefined ? messages : messages.slice(-limit),
      runOutput: runOutputPage?.items ?? this.getRunOutputs(id),
      activity: activityPage?.items ?? this.getActivity(id),
      changedFiles: changedFilePage.items,
      runs: runPage?.items ?? this.getRuns(id),
      finalizedWorkDurationMs: this.getFinalizedWorkDurationMs(id),
      workItems: workItemPage?.items ?? this.getWorkItems(id),
      artifacts: artifactPage?.items ?? this.getArtifacts(id),
      state: agent.state,
      ...(limit !== undefined ? {
        history: { limit, hasMore: messages.length > limit },
        telemetryHistory: {
          runOutput: runOutputPage!.history,
          activity: activityPage!.history,
          changedFiles: changedFilePage.history,
          runs: runPage!.history,
          workItems: workItemPage!.history,
          artifacts: artifactPage!.history,
        },
      } : {}),
    };
  }

  getFinalizedWorkDurationMs(agentId: string): number {
    return this.telemetry.getFinalizedWorkDurationMs(agentId);
  }

  getMessages(agentId: string): MessageDto[] {
    const projectId = this.projectIdOf(agentId);
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.agentId, agentId))
      .orderBy(asc(messages.seq))
      .all()
      .map((r) => {
        const communication = r.communicationEventId
          ? this.getCommunicationEvent(projectId, r.communicationEventId)
          : undefined;
        const authorAgentId = communication?.sender.kind === "agent"
          ? communication.sender.agentId
          : undefined;
        return {
          id: r.id,
          communicationEventId: r.communicationEventId ?? undefined,
          agentId: r.agentId,
          seq: r.seq,
          role: authorAgentId ? "assistant" : r.role === "user" ? "user" : "assistant",
          text: r.text,
          createdAt: r.createdAt,
          ...(authorAgentId ? { authorAgentId } : {}),
          attachments: r.attachmentsJson ? JSON.parse(r.attachmentsJson) : undefined,
        } satisfies MessageDto;
      });
  }

  /** Durable response/reasoning segments interleaved by canonical event sequence. */
  getRunOutputs(agentId: string): RunOutputDto[] {
    return this.telemetry.getRunOutputs(agentId);
  }

  getRunOutputPage(
    agentId: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ): HistoryPageDto<RunOutputDto> {
    return this.telemetry.getRunOutputPage(agentId, input);
  }

  getRunOutputText(agentId: string, seq: number): {
    agentId: string;
    runOutputId: string;
    seq: number;
    text: string;
    totalUtf8Bytes: number;
  } | undefined {
    return this.telemetry.getRunOutputText(agentId, seq);
  }

  /** Execution activity is rebuilt from canonical log events, never from live-only UI state. */
  getActivity(agentId: string): AgentActivityDto[] {
    return this.telemetry.getActivity(agentId);
  }

  getActivityPage(
    agentId: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ): HistoryPageDto<AgentActivityDto> {
    return this.telemetry.getActivityPage(agentId, input);
  }

  getActivityOutput(agentId: string, seq: number): {
    agentId: string;
    activityId: string;
    seq: number;
    output: string;
    totalUtf8Bytes: number;
    sha256: string;
  } | undefined {
    return this.telemetry.getActivityOutput(agentId, seq);
  }

  getActivityOutputPage(agentId: string, seq: number, startUtf8Byte: number, maxBytes: number): {
    agentId: string;
    activityId: string;
    seq: number;
    output: string;
    pageUtf8Bytes: number;
    totalUtf8Bytes: number;
    sha256: string;
  } | undefined {
    return this.telemetry.getActivityOutputPage(agentId, seq, startUtf8Byte, maxBytes);
  }

  /** Bounded newest-first keyset over one row per touched path. */
  getChangedFilePage(
    agentId: string,
    input: { limit: number; cursor?: string },
  ): HistoryPageDto<ChangedFileDto> {
    return this.telemetry.getChangedFilePage(agentId, input);
  }

  getChangedFileDetail(agentId: string, path: string): ChangedFileDetailDto | undefined {
    return this.telemetry.getChangedFileDetail(agentId, path);
  }

  /**
   * Compact file provenance for one exact Run. This deliberately groups the
   * canonical activity stream by (execution, path) instead of consulting the
   * agent-wide latest-file view, which could attribute a later Run's diff to an
   * earlier response.
   */
  getResponseFileActivity(
    agentId: string,
    executionId: string,
    status: ResponseFileActivityDto["status"],
  ): ResponseFileActivityDto[] {
    return this.fileActivity.byExecution(agentId, status).get(executionId) ?? [];
  }

  getProjectedAgentMessages(agentId: string, limit?: number): MessageDto[] {
    return this.chatFeed.getProjectedAgentMessages(agentId, limit);
  }

  getProjectedAgentMessagePage(
    agentId: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ): { messages: MessageDto[]; hasMore: boolean; cursor?: string } {
    return this.chatFeed.getProjectedAgentMessagePage(agentId, input);
  }

  getProjectedAgentMessageById(agentId: string, id: string): MessageDto | undefined {
    return this.chatFeed.getProjectedAgentMessageById(agentId, id);
  }

  getAgentPrivateContextSourcePage(
    agentId: string,
    input: {
      limit: number;
      conversationId?: string;
      before?: ContextReadBoundary;
      excludeCommunicationEventId?: string;
      includeAuthoredBroadcasts: boolean;
    },
  ): ContextSourcePage<MessageDto> {
    return this.chatFeed.getAgentPrivateContextSourcePage(agentId, input);
  }

  searchGlobalChats(input: GlobalChatSearchInput = {}): GlobalChatSearchResponseDto {
    return this.chatFeed.searchGlobalChats(input);
  }

  getAllChatPage(input: { limit?: number; cursor?: string } = {}): AllChatPageDto {
    return this.chatFeed.getAllChatPage(input);
  }

  getRuns(agentId: string): AgentRunDto[] {
    return this.runUsage.getRuns(agentId);
  }

  getRunPage(agentId: string, input: { limit: number; cursor?: string; focusId?: string }): HistoryPageDto<AgentRunDto> {
    return this.runUsage.getRunPage(agentId, input);
  }

  getProviderInput(executionId: string, includeExactPrompt = false): ProviderInputDto | undefined {
    return this.runUsage.getProviderInput(executionId, includeExactPrompt);
  }

  getTokenUsage(
    scope: { type: "overall" } | { type: "project" | "agent"; id: string },
    range: TokenUsageRangeDto = {},
  ): TokenUsageSummaryDto {
    return this.runUsage.getTokenUsage(scope, range);
  }

  /** Metered canonical runs used by the server's adapter-owned pricing projection. */
  getMeteredRuns(scope: { type: "overall" } | { type: "project" | "agent"; id: string }, range: TokenUsageRangeDto = {}): Array<{
    projectId: string; conversationId?: string; agentId: string; agentTitle: string; executionId: string; engine: string; model?: string;
    startedAt: string; completedAt?: string; usage: NonNullable<AgentRunDto["usage"]>; providerRequestUsage?: TokenUsage[];
  }> {
    return this.runUsage.getMeteredRuns(scope, range);
  }

  getWorkItems(agentId: string): WorkItemDto[] {
    return this.runUsage.getWorkItems(agentId);
  }

  getWorkItemPage(agentId: string, input: { limit: number; cursor?: string; focusId?: string }): HistoryPageDto<WorkItemDto> {
    return this.runUsage.getWorkItemPage(agentId, input);
  }

  getArtifacts(agentId: string): ArtifactDto[] {
    return this.artifactCatalog.getArtifacts(agentId);
  }

  getArtifactPage(agentId: string, input: { limit: number; cursor?: string; focusId?: string }): HistoryPageDto<ArtifactDto> {
    return this.artifactCatalog.getArtifactPage(agentId, input);
  }

  getProjectArtifacts(projectId: string): ArtifactDto[] {
    return this.artifactCatalog.getProjectArtifacts(projectId);
  }

  getProjectArtifactPage(projectId: string, input: { limit: number; cursor?: string }): HistoryPageDto<ArtifactDto> {
    return this.artifactCatalog.getProjectArtifactPage(projectId, input);
  }

  getProjectArtifact(projectId: string, artifactIdValue: string): ArtifactDto | undefined {
    return this.artifactCatalog.getProjectArtifact(projectId, artifactIdValue);
  }

  getProjectArtifactAccess(projectId: string, artifactIdValue: string): ManagedArtifactAccess | undefined {
    return this.artifactCatalog.getProjectArtifactAccess(projectId, artifactIdValue);
  }

  projectArtifactIsOrganizationVisible(projectId: string, artifactIdValue: string): boolean {
    return this.artifactCatalog.projectArtifactIsOrganizationVisible(projectId, artifactIdValue);
  }

  operatorCanReadProjectArtifact(projectId: string, artifactIdValue: string): boolean {
    return this.artifactCatalog.operatorCanReadProjectArtifact(projectId, artifactIdValue);
  }

  agentCanReadProjectArtifact(projectId: string, artifactIdValue: string, agentId: string): boolean {
    return this.artifactCatalog.agentCanReadProjectArtifact(projectId, artifactIdValue, agentId);
  }

  getProjectContextArtifacts(projectId: string, limit = 100): ArtifactDto[] {
    return this.artifactCatalog.getProjectContextArtifacts(projectId, limit);
  }

  recordProjectArtifact(
    artifact: ArtifactDto & { projectId: string; originAgentId: string },
    access?: ManagedArtifactAccess,
  ): void {
    this.artifactCatalog.recordProjectArtifact(artifact, access);
  }

  deleteProjectArtifact(projectId: string, artifactIdValue: string, reason: string): boolean {
    return this.artifactCatalog.deleteProjectArtifact(projectId, artifactIdValue, reason);
  }

  updateProjectArtifactVisibility(
    projectId: string,
    artifactIdValue: string,
    visibility: "project" | "published",
    pinned: boolean,
  ): ArtifactDto | undefined {
    return this.artifactCatalog.updateProjectArtifactVisibility(
      projectId, artifactIdValue, visibility, pinned,
    );
  }

  getGeneratedPdfPath(agentId: string, artifactIdValue: string): string | undefined {
    return this.artifactCatalog.getGeneratedPdfPath(agentId, artifactIdValue);
  }

  getGeneratedArtifact(agentId: string, artifactIdValue: string): Extract<LogEvent, { type: "generated_artifact" }> | undefined {
    return this.artifactCatalog.getGeneratedArtifact(agentId, artifactIdValue);
  }

  getArtifact(agentId: string, artifactIdValue: string): ArtifactDto | undefined {
    return this.artifactCatalog.getArtifact(agentId, artifactIdValue);
  }

  // ─── Event log (append-only) + projection ──────────────────────────────────

  /**
   * Append one event to an agent's canonical log AND update its projections.
   * The log write happens (and fsyncs) BEFORE the projection, so the log is always
   * complete for replay (SPEC §8: log write before broadcast). Returns the stored
   * event (seq + ts) so the caller can broadcast it over SSE.
   */
  appendEvent(agentId: string, event: LogEvent): StoredLogEvent {
    if (!this.getAgent(agentId)) throw new Error(`unknown or deleted agent: ${agentId}`);
    const projectId = this.projectIdOf(agentId);
    const communicationEventId = event.type === "communication_projection" || event.type === "user_message"
      ? event.communicationEventId : undefined;
    if (communicationEventId && !this.communicationProjectionAllowed(projectId, {
      eventId: communicationEventId,
      surface: "direct_agent_audit",
      projectionKey: agentId,
    })) {
      // Scope validation must precede the canonical agent append. A rejected
      // projection may not leave an unprojectable user_message in events.jsonl.
      throw new Error("communication scope cannot project to requested surface");
    }
    const stored = this.eventProjection.append(agentId, projectId, event);
    const message = communicationMessageProjection(agentId, stored);
    if (communicationEventId && message) {
      this.appendCommunicationProjection(projectId, {
        eventId: communicationEventId,
        surface: "direct_agent_audit",
        projectionKey: agentId,
        projectedAt: stored.ts,
        message,
      });
    }
    return stored;
  }

  readEvents(agentId: string): StoredLogEvent[] {
    return this.eventProjection.readAll(agentId, this.projectIdOf(agentId));
  }

  readEventsSince(agentId: string, sinceSeq: number): StoredLogEvent[] {
    return this.eventProjection.readSince(agentId, sinceSeq);
  }

  lastSeqOf(agentId: string): number {
    return this.eventProjection.lastSeq(agentId);
  }

  latestHealthObservation(agentId: string): {
    status: AgentLifecycleStatus;
    statusTimestamp: string;
    reason: AgentLifecycleReason;
    executionId?: string;
  } | undefined {
    return this.eventProjection.latestHealth(agentId);
  }

  // ─── Rebuild (SQLite is disposable; the log is truth) ──────────────────────

  /**
   * Wipe every projection table and replay from disk (the *.json files + each
   * `events.jsonl`). After this, projections are byte-identical to the incremental
   * result — the property the rebuild test asserts.
   */
  private recoverAgentDeletionDirectories(): void {
    const committed = this.db.select().from(agentDeletionTombstones).all();
    const committedNames = new Set(committed.map((row) => `${row.projectId}\0${row.tombstoneName}`));
    const touchedDirectories = new Set<string>();
    for (const row of committed) {
      if (row.tombstoneName.includes("/") || row.tombstoneName.includes("\\") ||
          !row.tombstoneName.startsWith(`.${row.agentId}.deleting-`)) {
        throw new Error("invalid Agent deletion recovery journal");
      }
      const directory = agentsDir(this.dataDir, row.projectId);
      const tombstone = join(directory, row.tombstoneName);
      const canonical = agentDir(this.dataDir, row.projectId, row.agentId);
      const auditDirectory = existsSync(tombstone) ? tombstone : canonical;
      if (!existsSync(auditDirectory)) throw new Error("committed Agent deletion lost its audit directory");
      rmSync(join(auditDirectory, "attachments"), { recursive: true, force: true });
      const metadataPath = join(auditDirectory, "agent.json");
      const metadata = readJson<AgentJson>(metadataPath);
      writeJson(metadataPath, {
        ...metadata,
        conversationId: undefined,
        conversationIds: [],
        archived: true,
        deletedAt: row.createdAt,
        updatedAt: row.createdAt,
        managementPermissions: {
          allowAutomaticDescendantDeletion: false,
          allowAutomaticDescendantReorganization: false,
        },
      });
      if (auditDirectory === tombstone) {
        if (existsSync(canonical)) throw new Error("deleted Agent audit destination already exists");
        renameSync(tombstone, canonical);
      }
      if (existsSync(directory)) touchedDirectories.add(directory);
    }
    const root = projectsDir(this.dataDir);
    if (existsSync(root)) for (const projectId of readdirSync(root)) {
      const directory = agentsDir(this.dataDir, projectId);
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory)) {
        const separator = name.indexOf(".deleting-", 1);
        if (!name.startsWith(".") || separator < 2 || committedNames.has(`${projectId}\0${name}`)) continue;
        const agentId = name.slice(1, separator);
        const tombstone = join(directory, name);
        const canonical = agentDir(this.dataDir, projectId, agentId);
        if (existsSync(canonical)) rmSync(tombstone, { recursive: true, force: true });
        else renameSync(tombstone, canonical);
        touchedDirectories.add(directory);
      }
    }
    for (const directory of touchedDirectories) fsyncDirectory(directory);
    this.db.transaction((tx) => {
      tx.delete(agentDeletionTombstones).run();
      const now = new Date().toISOString();
      this.client.prepare(`
        UPDATE agent_deletion_receipts
        SET storage_cleanup_completed = 1, last_error = NULL, updated_at = ?,
            completed_at = CASE WHEN server_cleanup_completed = 1 THEN ? ELSE completed_at END
        WHERE storage_cleanup_completed = 0
      `).run(now, now);
    });
  }

  /** Recover the filesystem side of Project deletion before projection rebuild
   * can discard hidden directories or prune quarantine rows. A journal row means
   * the SQLite purge did not commit, so its exact rename is rolled back. Without
   * a row, a tombstone is committed cleanup and must never be resurrected. */
  private recoverProjectDeletionDirectories(): void {
    const root = projectsDir(this.dataDir);
    if (!existsSync(root)) return;
    const pending = this.db.select().from(projectDeletionPending).all();
    const journalNames = new Set<string>();
    for (const row of pending) {
      const prefix = `.${row.projectId}.deleting-`;
      const candidates = readdirSync(root).filter((name) => name.startsWith(prefix));
      const tombstoneName = row.tombstoneName ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (tombstoneName && (tombstoneName.includes("/") || tombstoneName.includes("\\") ||
          !tombstoneName.startsWith(prefix))) {
        throw new Error("invalid Project deletion recovery journal");
      }
      const canonical = projectDir(this.dataDir, row.projectId);
      if (existsSync(canonical)) {
        if (tombstoneName && existsSync(join(root, tombstoneName))) {
          throw new Error(`Project ${row.projectId} has ambiguous deletion storage`);
        }
        if (tombstoneName) journalNames.add(tombstoneName);
        continue;
      }
      if (!tombstoneName || !existsSync(join(root, tombstoneName))) {
        throw new Error(`Project ${row.projectId} deletion quarantine has no recoverable canonical storage`);
      }
      renameSync(join(root, tombstoneName), canonical);
      fsyncDirectory(root);
      journalNames.add(tombstoneName);
      if (!row.tombstoneName) {
        this.db.update(projectDeletionPending).set({ tombstoneName })
          .where(eq(projectDeletionPending.projectId, row.projectId)).run();
      }
    }
    const receiptNames = new Set<string>();
    for (const receipt of this.db.select().from(projectDeletionReceipts).all()) {
      receiptNames.add(receipt.tombstoneName);
      if (receipt.storageCleanupCompleted === 1) continue;
      try { this.finishProjectDeletionStorageCleanup(this.getProjectDeletionReceipt(receipt.projectId)!); }
      catch (error) {
        this.recordProjectDeletionReceiptCleanupError(
          receipt.projectId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    let removedCommitted = false;
    for (const name of readdirSync(root)) {
      if (!/^\..+\.deleting-.+$/.test(name) || journalNames.has(name) || receiptNames.has(name)) continue;
      rmSync(join(root, name), { recursive: true, force: true });
      removedCommitted = true;
    }
    if (removedCommitted) fsyncDirectory(root);
  }

  rebuildProjections(): void {
    this.recoverProjectDeletionDirectories();
    this.recoverAgentDeletionDirectories();
    this.client.prepare(`DELETE FROM all_chat_feed_projection`).run();
    this.client.prepare(`DELETE FROM agent_health_projection`).run();
    this.client.prepare(`DELETE FROM agent_event_head_projection`).run();
    this.client.prepare(`DELETE FROM tool_output_projection`).run();
    this.db.delete(continuationHandoffs).run();
    this.db.delete(activityProjection).run();
    this.client.prepare(`DELETE FROM changed_file_execution_projection`).run();
    this.db.delete(changedFileProjection).run();
    this.db.delete(managedArtifactProjection).run();
    this.db.delete(importedHistoryMessages).run();
    this.db.delete(events).run();
    this.db.delete(artifacts).run();
    this.db.delete(workItems).run();
    this.db.delete(runs).run();
    this.db.delete(messages).run();
    this.db.delete(chatSearchMessages).run();
    this.db.delete(agents).run();
    this.db.delete(agentConversationMemberships).run();
    this.db.delete(conversations).run();
    this.db.delete(projects).run();
    this.db.delete(agentPresets).run();
    this.eventProjection.clearCaches();

    const root = projectsDir(this.dataDir);
    if (!existsSync(root)) return;

    for (const projectId of readdirSync(root)) {
      if (projectId.startsWith(".") || projectId.endsWith(".creating")) {
        rmSync(projectDir(this.dataDir, projectId), { recursive: true, force: true });
        continue;
      }
      const pj = projectJsonPath(this.dataDir, projectId);
      if (!existsSync(pj)) continue;
      const p = readJson<ProjectJson>(pj);
      this.db
        .insert(projects)
        .values({
          id: p.id,
          label: p.label,
          hostPath: p.hostPath,
          createdAt: p.createdAt,
          lastUsedAt: p.lastUsedAt ?? null,
          defaultEngine: p.defaultEngine ?? "codex",
          defaultModel: p.defaultModel ?? null,
          defaultEffort: p.defaultEffort ?? null,
          lastConversationId: p.lastConversationId ?? null,
        })
        .run();
      const resolved = new Map<string, AgentPresetDto>();
      for (const event of readRepairableJsonl<PresetEvent>(agentPresetsPath(this.dataDir, projectId), "agent preset journal", true)) event.type === "upsert" ? resolved.set(event.preset.id, event.preset) : resolved.delete(event.id);
      for (const preset of resolved.values()) this.db.insert(agentPresets).values({ ...preset, enabled: preset.enabled ? 1 : 0 }).run();
      const organizationalParents = new Map<string, string | null>();
      for (const event of readJsonLines<AgentOrganizationEvent>(agentOrganizationEventsPath(this.dataDir, projectId))) {
        if (event.projectId === projectId && event.type === "manager_changed") {
          organizationalParents.set(event.agentId, event.managerAgentId);
        }
      }

      const mDir = conversationsDir(this.dataDir, projectId);
      if (existsSync(mDir)) {
        for (const conversationId of readdirSync(mDir)) {
          const mj = conversationJsonPath(this.dataDir, projectId, conversationId);
          if (!existsSync(mj)) continue;
          const m = readJson<ConversationJson>(mj);
          this.db
            .insert(conversations)
            .values({
              id: m.id,
              projectId: m.projectId,
              title: m.title,
              defaultEngine: m.defaultEngine ?? null,
              defaultModel: m.defaultModel ?? null,
              defaultEffort: m.defaultEffort ?? null,
              createdAt: m.createdAt,
              updatedAt: m.updatedAt,
              archived: m.archived ? 1 : 0,
            })
            .run();
        }
      }

      this.artifactCatalog.rebuildProjectProjection(projectId);

      const tDir = agentsDir(this.dataDir, projectId);
      if (!existsSync(tDir)) continue;
      for (const agentId of readdirSync(tDir)) {
        if (agentId.startsWith(".") || agentId.endsWith(".creating")) {
          rmSync(agentDir(this.dataDir, projectId, agentId), { recursive: true, force: true });
          continue;
        }
        const tj = agentJsonPath(this.dataDir, projectId, agentId);
        if (!existsSync(tj)) continue;
        const t = readJson<AgentJson>(tj);
        const membershipIds = [...new Set(t.conversationIds ?? (t.conversationId ? [t.conversationId] : []))];
        const primaryConversationId = t.conversationId && membershipIds.includes(t.conversationId)
          ? t.conversationId
          : membershipIds[0];
        this.db
          .insert(agents)
          .values({
            id: t.id,
            projectId: t.projectId,
            conversationId: primaryConversationId ?? null,
            title: t.title,
            activeEngine: t.activeEngine,
            model: t.model ?? null,
            effort: t.effort ?? null,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            deletedAt: t.deletedAt ?? null,
            archived: t.archived ? 1 : 0,
            managerAgentId: organizationalParents.get(t.id) ?? null,
            allowAutomaticDescendantDeletion: t.managementPermissions?.allowAutomaticDescendantDeletion ? 1 : 0,
            allowAutomaticDescendantReorganization: t.managementPermissions?.allowAutomaticDescendantReorganization ? 1 : 0,
            spawnedByAgentId: t.spawnedByAgentId ?? null,
            spawnedByExecutionId: t.spawnedByExecutionId ?? null,
            spawnPrompt: t.spawnPrompt ?? null,
            spawnIdempotencyKey: t.spawnIdempotencyKey ?? null,
            presetSnapshotJson: t.presetSnapshot ? JSON.stringify(t.presetSnapshot) : null,
          })
          .run();
        membershipIds.forEach((conversationId, position) => {
          this.db.insert(agentConversationMemberships).values({ agentId: t.id, conversationId, position }).run();
        });
        if (t.conversationIds === undefined || t.conversationId !== primaryConversationId) {
          writeJson(tj, { ...t, conversationId: primaryConversationId, conversationIds: membershipIds });
        }

        const importedHistoryFile = importedAgentHistoryPath(this.dataDir, projectId, agentId);
        if (existsSync(importedHistoryFile)) {
          this.projectImportedHistory(agentId, readJson(importedHistoryFile));
        }

        const logFile = eventsPath(this.dataDir, projectId, agentId);
        mkdirSync(artifactsDir(this.dataDir, projectId, agentId), { recursive: true });
        if (!existsSync(logFile)) continue;
        const stored = new EventLog(logFile).readAll();
        const protectedArtifactPaths = new Set(stored.flatMap(({ event }) =>
          event.type === "generated_artifact" || event.type === "browser_screenshot" ? [event.path] : [],
        ));
        // Provider-generated bytes are authored state. Other artifact files are
        // projections and are safely rebuilt from canonical events below.
        pruneArtifactDirectory(artifactsDir(this.dataDir, projectId, agentId), protectedArtifactPaths);
        this.eventProjection.projectStored(agentId, projectId, stored, t.activeEngine);
        if (t.deletedAt) {
          this.db.update(agents).set({
            conversationId: null,
            activeSessionId: null,
            activeSessionContractHash: null,
            activeSessionArtifactIdsJson: "[]",
            archived: 1,
            managerAgentId: null,
            allowAutomaticDescendantDeletion: 0,
            allowAutomaticDescendantReorganization: 0,
            deletedAt: t.deletedAt,
            updatedAt: t.deletedAt,
          }).where(eq(agents.id, t.id)).run();
        }
      }
      this.sanitizeOrganizationProjection(projectId);
    }
    // Project rows are rebuildable and are deleted/reinserted above. The
    // deletion quarantine is authoritative, so prune it only after canonical
    // Project folders have been fully reconstructed.
    this.client.prepare(`
      DELETE FROM project_deletion_pending
      WHERE project_id NOT IN (SELECT id FROM projects)
    `).run();
    this.chatFeed.rebuildGlobalChatSearchProjection();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.close();
    releaseDataDirectoryOwnership(this.ownership);
    this.ownership = undefined;
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private sanitizeOrganizationProjection(projectId: string): void {
    const projectAgents = this.listAgents(projectId);
    const byId = new Map(projectAgents.map((agent) => [agent.id, agent]));
    for (const agent of projectAgents) {
      if (!agent.managerAgentId) continue;
      const seen = new Set<string>([agent.id]);
      let parentId: string | undefined = agent.managerAgentId;
      let valid = true;
      while (parentId) {
        const parent = byId.get(parentId);
        if (!parent || parent.archived || seen.has(parentId)) {
          valid = false;
          break;
        }
        seen.add(parentId);
        parentId = parent.managerAgentId;
      }
      if (!valid) this.db.update(agents).set({ managerAgentId: null }).where(eq(agents.id, agent.id)).run();
    }
  }

  private projectIdOf(agentId: string): string {
    const row = this.db
      .select({ projectId: agents.projectId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();
    if (!row) throw new Error(`unknown agent: ${agentId}`);
    return row.projectId;
  }

  private activeEngineOf(agentId: string): string {
    const row = this.db
      .select({ engine: agents.activeEngine })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();
    return row?.engine ?? "codex";
  }

  private rowToAgentDto(id: string): AgentDto | undefined {
    const row = this.db.select().from(agents).where(eq(agents.id, id)).get();
    return row ? this.agentRowToDto(row) : undefined;
  }

  private agentRowToDto(row: typeof agents.$inferSelect): AgentDto {
    const state: AgentState = {};
    if (row.stateBranch) state.branch = row.stateBranch;
    if (row.stateCommit) state.commit = row.stateCommit;
    let imported: { source: string; messages: PortableAgentHistoryMessageDto[] } | undefined;
    try {
      const file = importedAgentHistoryPath(this.dataDir, row.projectId, row.id);
      if (existsSync(file)) imported = readJson(file);
    } catch { /* malformed optional import history stays out of runtime metadata */ }
    return {
      id: row.id,
      projectId: row.projectId,
      conversationId: row.conversationId ?? undefined,
      conversationIds: this.db.select().from(agentConversationMemberships)
        .where(eq(agentConversationMemberships.agentId, row.id))
        .orderBy(asc(agentConversationMemberships.position)).all().map((membership) => membership.conversationId),
      title: row.title,
      activeEngine: row.activeEngine,
      model: row.model ?? undefined,
      effort: row.effort ?? undefined,
      state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archived: row.archived === 1 || Boolean(row.deletedAt),
      ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
      managerAgentId: row.managerAgentId ?? undefined,
      managementPermissions: {
        allowAutomaticDescendantDeletion: row.allowAutomaticDescendantDeletion === 1,
        allowAutomaticDescendantReorganization: row.allowAutomaticDescendantReorganization === 1,
      },
      spawnedByAgentId: row.spawnedByAgentId ?? undefined,
      spawnedByExecutionId: row.spawnedByExecutionId ?? undefined,
      spawnPrompt: row.spawnPrompt ?? undefined,
      presetSnapshot: row.presetSnapshotJson ? JSON.parse(row.presetSnapshotJson) as AgentDto["presetSnapshot"] : undefined,
      ...(imported ? { importedHistoryCount: imported.messages.length, importedFrom: imported.source } : {}),
    };
  }


  private persistAgentMemberships(
    id: string,
    conversationIds: string[],
    primaryConversationId?: string,
    beforeProjectionChange?: () => void,
  ): void {
    const row = this.db.select().from(agents).where(eq(agents.id, id)).get();
    if (!row) throw new Error(`unknown agent: ${id}`);
    const now = new Date().toISOString();
    const jsonPath = agentJsonPath(this.dataDir, row.projectId, id);
    const json = readJson<AgentJson>(jsonPath);
    // Canonical metadata is committed first; SQLite remains a rebuildable projection.
    writeJson(jsonPath, { ...json, conversationId: primaryConversationId, conversationIds, updatedAt: now });
    try {
      this.db.transaction((tx) => {
        beforeProjectionChange?.();
        tx.delete(agentConversationMemberships).where(eq(agentConversationMemberships.agentId, id)).run();
        conversationIds.forEach((conversationId, position) => {
          tx.insert(agentConversationMemberships).values({ agentId: id, conversationId, position }).run();
        });
        tx.update(agents).set({ conversationId: primaryConversationId ?? null, updatedAt: now }).where(eq(agents.id, id)).run();
      });
    } catch (error) {
      writeJson(jsonPath, json);
      throw error;
    }
  }

  private conversationRowToDto(row: typeof conversations.$inferSelect): ConversationDto {
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      defaultEngine: row.defaultEngine ?? undefined,
      defaultModel: row.defaultModel ?? undefined,
      defaultEffort: row.defaultEffort ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archived: row.archived === 1,
    };
  }

  continuationHandoffForRun(agentId: string, executionId: string): {
    id: string; executionId: string; text: string; createdAt: string; consumedAt?: string;
  } | undefined {
    const row = this.db.select().from(continuationHandoffs)
      .where(and(eq(continuationHandoffs.agentId, agentId), eq(continuationHandoffs.sourceExecutionId, executionId)))
      .get();
    return row ? {
      id: row.id,
      executionId: row.sourceExecutionId,
      text: row.text,
      createdAt: row.createdAt,
      ...(row.consumedAt ? { consumedAt: row.consumedAt } : {}),
    } : undefined;
  }

  pendingContinuationHandoff(agentId: string): {
    id: string; executionId: string; text: string; createdAt: string;
  } | undefined {
    const row = this.client.prepare(`
      SELECT handoff.id, handoff.source_execution_id, handoff.text, handoff.created_at
      FROM continuation_handoffs handoff
      JOIN runs source_run ON source_run.id = handoff.source_execution_id
      WHERE handoff.agent_id = ? AND handoff.consumed_at IS NULL
        AND source_run.status = 'completed'
      ORDER BY handoff.created_at ASC, handoff.id ASC LIMIT 1
    `).get(agentId) as { id: string; source_execution_id: string; text: string; created_at: string } | undefined;
    return row ? { id: row.id, executionId: row.source_execution_id, text: row.text, createdAt: row.created_at } : undefined;
  }

  consumeContinuationHandoff(agentId: string, handoffId: string, executionId: string): boolean {
    const pending = this.client.prepare(`
      SELECT 1 FROM continuation_handoffs
      WHERE id = ? AND agent_id = ? AND consumed_at IS NULL
    `).get(handoffId, agentId);
    if (!pending) return false;
    this.appendEvent(agentId, { type: "continuation_handoff_consumed", handoffId, executionId });
    return true;
  }

  /** Durable compatibility and reachability state for the accepted provider session. */
  resumeSessionState(agentId: string): {
    sessionId: string;
    toolContractHash?: string;
    artifactIds: string[];
  } | undefined {
    const row = this.db
      .select({
        sessionId: agents.activeSessionId,
        toolContractHash: agents.activeSessionContractHash,
        artifactIdsJson: agents.activeSessionArtifactIdsJson,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();
    if (!row?.sessionId) return undefined;
    let artifactIds: string[] = [];
    try {
      const parsed = JSON.parse(row.artifactIdsJson) as unknown;
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) artifactIds = parsed;
    } catch {
      // A malformed rebuildable projection fails closed to no retained roots.
    }
    return {
      sessionId: row.sessionId,
      ...(row.toolContractHash ? { toolContractHash: row.toolContractHash } : {}),
      artifactIds: [...new Set(artifactIds)].sort(),
    };
  }

  /** The engine session id to resume for an agent (undefined if none yet). */
  resumeSessionId(agentId: string): string | undefined {
    return this.resumeSessionState(agentId)?.sessionId;
  }

  /**
   * Forget only the provider runtime session so the next turn seeds a fresh
   * session from canonical history. Agent identity, memberships, event logs,
   * and queued collaboration deliveries are intentionally untouched.
   */
  clearResumeSession(
    agentId: string,
    reason: "explicit_compaction" | "resume_compaction_failed" | "request_context_rollover" | "tool_contract_changed" | "provider_root_exit",
  ): boolean {
    const row = this.db
      .select({ id: agents.id, activeSessionId: agents.activeSessionId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();
    if (!row?.activeSessionId) return false;

    this.appendEvent(agentId, { type: "session_reset", reason });
    return true;
  }
}
