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
import { AgentEventSessionAuthority } from "./store-event-session-authority.js";
import { AgentConversationProjectionReadModel } from "./store-conversation-projection-read-model.js";
import { AgentCommunicationProjectionLedger } from "./store-communication-projection-ledger.js";
import { AgentWorkspaceCatalogAuthority } from "./store-workspace-catalog-authority.js";
import { AgentCatalogAuthority } from "./store-agent-catalog-authority.js";
import { AgentCommunicationJournalAuthority } from "./store-communication-journal-authority.js";
import { AgentManagementAuthority } from "./store-agent-management-authority.js";
import { AgentProjectDeletionAuthority } from "./store-project-deletion-authority.js";
import { AgentDeletionAuthority } from "./store-agent-deletion-authority.js";
import { AgentProjectionRebuilder } from "./store-projection-rebuilder.js";
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
export class AgentStore {
  private readonly db: Db;
  private readonly client: Database.Database;
  private readonly telemetry!: AgentTelemetryReadModel;
  private readonly fileActivity!: AgentFileActivityReadModel;
  private readonly chatFeed!: AgentChatFeedProjection;
  private readonly runUsage!: AgentRunUsageReadModel;
  private readonly artifactCatalog!: AgentArtifactCatalog;
  private readonly eventProjection!: AgentEventProjectionStore;
  private readonly eventSession!: AgentEventSessionAuthority;
  private readonly conversationProjection!: AgentConversationProjectionReadModel;
  private readonly communicationProjectionLedger!: AgentCommunicationProjectionLedger;
  private readonly workspaceCatalog!: AgentWorkspaceCatalogAuthority;
  private readonly agentCatalog!: AgentCatalogAuthority;
  private readonly communicationJournal!: AgentCommunicationJournalAuthority;
  private readonly agentManagement!: AgentManagementAuthority;
  private readonly projectDeletion!: AgentProjectDeletionAuthority;
  private readonly agentDeletion!: AgentDeletionAuthority;
  private readonly projectionRebuilder!: AgentProjectionRebuilder;
  private readonly communicationProjectionCache = new Map<string, {
    projections: CommunicationProjection[];
    byTuple: Map<string, CommunicationProjection>;
  }>();
  private ownership?: DataDirectoryOwnership;
  private closed = false;

  constructor(private readonly dataDir: string) {
    ensureV1Layout(dataDir);
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(projectsDir(dataDir), { recursive: true });
    this.ownership = acquireDataDirectoryOwnership(dataDir);
    const deliverySequenceFile = `${dataDir}/delivery-order.jsonl`;
    const deliverySequence = readRepairableJsonl<{ sequence: number }>(deliverySequenceFile, "delivery order journal", true)
      .reduce((maximum, record) => Math.max(maximum, record.sequence), 0);
    try {
      const opened = openDb(dbPath(dataDir));
      this.db = opened.db;
      this.client = opened.client;
      this.workspaceCatalog = new AgentWorkspaceCatalogAuthority(
        dataDir,
        this.db,
        this.client,
        projectId => this.listAgents(projectId),
        (conversationId, channel) =>
          this.getConversationMessages(conversationId, channel),
        (agentId, conversationIds, primaryConversationId) =>
          this.persistAgentMemberships(
            agentId,
            conversationIds,
            primaryConversationId,
          ),
        projectId => this.chatFeed.refreshAllChatFeedProject(projectId),
      );
      this.agentCatalog = new AgentCatalogAuthority(
        dataDir,
        this.db,
        this.client,
        presetId => this.getAgentPreset(presetId),
        (agentId, input) => this.updateAgentOrganization(agentId, input),
      );
      this.communicationJournal = new AgentCommunicationJournalAuthority(
        dataDir,
        this.db,
        deliverySequenceFile,
        deliverySequence,
        projectId => this.getProject(projectId),
        conversationId => this.getConversation(conversationId),
        agentId => this.getAgent(agentId),
        (projectId, artifactIdValue) =>
          this.getProjectArtifact(projectId, artifactIdValue),
        (projectId, projection) =>
          this.communicationProjectionAllowed(projectId, projection),
        (projectId, projection) =>
          this.appendCommunicationProjection(projectId, projection),
      );
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
      this.eventSession = new AgentEventSessionAuthority(
        this.db,
        this.client,
        this.eventProjection,
        agentId => this.getAgent(agentId),
        agentId => this.projectIdOf(agentId),
        () => this.listProjects(),
        projectId => this.listAgents(projectId),
        (projectId, projection) =>
          this.communicationProjectionAllowed(projectId, projection),
        (projectId, projection) =>
          this.appendCommunicationProjection(projectId, projection),
      );
      this.projectDeletion = new AgentProjectDeletionAuthority(
        dataDir,
        this.db,
        this.client,
        projectId => this.getProject(projectId),
        projectId => this.listAgents(projectId),
        (projectId, agentIds) => {
          this.communicationJournal.clearProject(projectId);
          this.communicationProjectionCache.delete(projectId);
          for (const agentId of agentIds) this.eventProjection.forgetAgent(agentId);
        },
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
      this.agentManagement = new AgentManagementAuthority(
        dataDir,
        this.db,
        this.client,
        agentId => this.getAgent(agentId),
        projectId => this.listAgents(projectId),
        projectId => this.getProject(projectId),
        conversationId => this.getConversation(conversationId),
        agentId => this.rowToAgentDto(agentId),
        (agentId, conversationIds, primaryConversationId, beforeProjectionChange) =>
          this.persistAgentMemberships(
            agentId,
            conversationIds,
            primaryConversationId,
            beforeProjectionChange,
          ),
        projectId => this.chatFeed.refreshAllChatFeedProject(projectId),
      );
      this.agentDeletion = new AgentDeletionAuthority(
        dataDir,
        this.db,
        this.client,
        agentId => this.getAgent(agentId),
        projectId => this.listAgents(projectId),
        (authorization, targetAgentIds) =>
          this.authorizeAgentManagementPlan(authorization, targetAgentIds),
        projectId => this.chatFeed.refreshAllChatFeedProject(projectId),
        agentId => this.eventProjection.forgetAgent(agentId),
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
      this.projectionRebuilder = new AgentProjectionRebuilder(
        dataDir,
        this.db,
        this.client,
        this.artifactCatalog,
        this.agentCatalog,
        this.eventProjection,
        () => this.recoverProjectDeletionDirectories(),
        () => this.recoverAgentDeletionDirectories(),
        projectId => this.sanitizeOrganizationProjection(projectId),
        () => this.chatFeed.rebuildGlobalChatSearchProjection(),
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
    return this.communicationJournal.nextDeliveryOrderKey(createdAt);
  }

  private communicationIndex(projectId: string) {
    return this.communicationJournal.communicationIndex(projectId);
  }

  private communicationRevisionIndex(projectId: string) {
    return this.communicationJournal.communicationRevisionIndex(projectId);
  }

  private messageDispatches(projectId: string): MessageDispatchRecord[] {
    return this.communicationJournal.messageDispatches(projectId);
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
    return this.communicationJournal.appendCommunicationEvent(input);
  }

  private ensureCommunicationBehaviorProjections(event: CommunicationEvent): void {
    this.communicationJournal.ensureCommunicationBehaviorProjections(event);
  }

  appendCommunicationRevision(input: CommunicationRevisionEvent): { revision: CommunicationRevisionEvent; replayed: boolean } {
    return this.communicationJournal.appendCommunicationRevision(input);
  }

  readCommunicationRevisions(projectId: string): CommunicationRevisionEvent[] {
    return this.communicationJournal.readCommunicationRevisions(projectId);
  }

  readCommunicationEvents(projectId: string): CommunicationEvent[] {
    return this.communicationJournal.readCommunicationEvents(projectId);
  }

  getCommunicationEvent(projectId: string, eventId: string): CommunicationEvent | undefined {
    return this.communicationJournal.getCommunicationEvent(projectId, eventId);
  }

  getCommunicationDocument(projectId: string, documentId: string) {
    return this.communicationJournal.getCommunicationDocument(projectId, documentId);
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
    return this.eventSession.recoverInterruptedExecutions();
  }

  /** The raw better-sqlite3 handle (read-only queries, PRAGMAs, tests). */
  get sqlite(): Database.Database {
    return this.client;
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  createProject(input: Omit<CreateProjectRequest, "defaultEngine"> & { hostPath: string; defaultEngine?: CreateProjectRequest["defaultEngine"] }): ProjectDto {
    return this.workspaceCatalog.createProject(input);
  }

  updateProject(id: string, input: UpdateProjectRequest): ProjectDto | undefined {
    return this.workspaceCatalog.updateProject(id, input);
  }

  markProjectDeletionPending(projectId: string, now = new Date().toISOString()): void {
    this.projectDeletion.markProjectDeletionPending(projectId, now);
  }

  recordProjectDeletionCleanupError(projectId: string, error: string): void {
    this.projectDeletion.recordProjectDeletionCleanupError(projectId, error);
  }

  listPendingProjectDeletions(): Array<{ projectId: string; createdAt: string; lastError?: string }> {
    return this.projectDeletion.listPendingProjectDeletions();
  }

  getProjectDeletionReceipt(projectId: string): ProjectDeletionReceipt | undefined {
    return this.projectDeletion.getProjectDeletionReceipt(projectId);
  }

  listPendingProjectDeletionReceipts(): ProjectDeletionReceipt[] {
    return this.projectDeletion.listPendingProjectDeletionReceipts();
  }

  recordProjectDeletionReceiptCleanupError(projectId: string, error: string): void {
    this.projectDeletion.recordProjectDeletionReceiptCleanupError(projectId, error);
  }

  finishProjectDeletionStorageCleanup(
    receipt: ProjectDeletionReceipt,
    afterTombstoneRemoval?: (projectId: string) => void,
  ): void {
    this.projectDeletion.finishProjectDeletionStorageCleanup(receipt, afterTombstoneRemoval);
  }

  commitProjectDeletion(id: string, beforeProjectionDelete?: (projectId: string) => void): ProjectDeletionReceipt | undefined {
    return this.projectDeletion.commitProjectDeletion(id, beforeProjectionDelete);
  }

  deleteProject(id: string, beforeProjectionDelete?: (projectId: string) => void): boolean {
    return this.projectDeletion.deleteProject(id, beforeProjectionDelete);
  }

  listAgentPresets(projectId: string): AgentPresetDto[] {
    return this.workspaceCatalog.listAgentPresets(projectId);
  }

  getAgentPreset(id: string): AgentPresetDto | undefined {
    return this.workspaceCatalog.getAgentPreset(id);
  }

  createAgentPreset(projectId: string, input: CreateAgentPresetRequest): AgentPresetDto {
    return this.workspaceCatalog.createAgentPreset(projectId, input);
  }

  updateAgentPreset(id: string, patch: UpdateAgentPresetRequest): AgentPresetDto | undefined {
    return this.workspaceCatalog.updateAgentPreset(id, patch);
  }

  deleteAgentPreset(id: string): boolean {
    return this.workspaceCatalog.deleteAgentPreset(id);
  }

  listProjects(): ProjectDto[] {
    return this.workspaceCatalog.listProjects();
  }

  getProject(id: string): ProjectDto | undefined {
    return this.workspaceCatalog.getProject(id);
  }

  markProjectUsed(projectId: string, conversationId?: string): ProjectDto | undefined {
    return this.workspaceCatalog.markProjectUsed(projectId, conversationId);
  }

  // ─── Conversations ─────────────────────────────────────────────────────────

  createConversation(projectId: string, input: CreateConversationRequest): ConversationDto {
    return this.workspaceCatalog.createConversation(projectId, input);
  }

  listConversations(projectId: string): ConversationDto[] {
    return this.workspaceCatalog.listConversations(projectId);
  }

  getConversation(id: string): ConversationDto | undefined {
    return this.workspaceCatalog.getConversation(id);
  }

  getConversationDetail(id: string): ConversationDetailDto | undefined {
    return this.workspaceCatalog.getConversationDetail(id);
  }

  getCollaborationViewDetail(id: string): CollaborationViewDto | undefined {
    return this.workspaceCatalog.getCollaborationViewDetail(id);
  }

  updateConversation(id: string, patch: UpdateConversationRequest): ConversationDto | undefined {
    return this.workspaceCatalog.updateConversation(id, patch);
  }

  deleteConversation(id: string, beforeMembershipDelete?: (agentId: string, conversationId: string) => void): boolean {
    return this.workspaceCatalog.deleteConversation(id, beforeMembershipDelete);
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
    return this.communicationJournal.appendConversationMessage(
      conversationId,
      input,
      authorAgentId,
      channel,
      deliveryIntents,
      messageReceiptKey,
      communicationEventId,
    );
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
    return this.agentCatalog.createAgent(projectId, input, origin);
  }

  findAgentSpawn(agentId: string, executionId: string, idempotencyKey: string): AgentDto | undefined {
    return this.agentCatalog.findAgentSpawn(agentId, executionId, idempotencyKey);
  }

  listAgents(projectId: string): AgentDto[] {
    return this.agentCatalog.listAgents(projectId);
  }

  getAgent(id: string): AgentDto | undefined {
    return this.agentCatalog.getAgent(id);
  }

  setImportedHistory(agentId: string, source: string, messages: PortableAgentHistoryMessageDto[]): void {
    this.agentCatalog.setImportedHistory(agentId, source, messages);
  }

  getImportedHistory(agentId: string): { source: string; importedAt: string; messages: PortableAgentHistoryMessageDto[] } | undefined {
    return this.agentCatalog.getImportedHistory(agentId);
  }

  getImportedHistoryMessagePage(
    agentId: string,
    input: { limit: number; before?: ContextReadBoundary },
  ): ContextSourcePage<MessageDto> {
    return this.agentCatalog.getImportedHistoryMessagePage(agentId, input);
  }

  listAgentSubtree(id: string): AgentDto[] {
    return this.agentManagement.listAgentSubtree(id);
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
    this.agentManagement.createAgentManagementApproval(input);
  }

  resolveAgentManagementApproval(decisionId: string, approved: boolean, at = new Date().toISOString()): boolean {
    return this.agentManagement.resolveAgentManagementApproval(decisionId, approved, at);
  }

  authorizeAgentManagementPlan(
    authorization: AgentManagementAuthorization,
    targetAgentIds: readonly string[],
    consumeApproval = true,
  ): void {
    this.agentManagement.authorizeAgentManagementPlan(authorization, targetAgentIds, consumeApproval);
  }

  getAgentDeletionReceiptByPreviewHash(previewHash: string): AgentDeletionReceipt | undefined {
    return this.agentDeletion.getAgentDeletionReceiptByPreviewHash(previewHash);
  }

  listPendingAgentDeletionReceipts(): AgentDeletionReceipt[] {
    return this.agentDeletion.listPendingAgentDeletionReceipts();
  }

  recordAgentDeletionCleanupError(receiptId: string, error: string): void {
    this.agentDeletion.recordAgentDeletionCleanupError(receiptId, error);
  }

  markAgentDeletionServerCleanupComplete(receiptId: string): void {
    this.agentDeletion.markAgentDeletionServerCleanupComplete(receiptId);
  }

  updateAgent(id: string, patch: UpdateAgentRequest): AgentDto | undefined {
    return this.agentManagement.updateAgent(id, patch);
  }

  updateAgentOrganization(id: string, input: UpdateAgentOrganizationRequest): AgentDto | undefined {
    return this.agentManagement.updateAgentOrganization(id, input);
  }

  applyAuthorizedAgentReorganization(
    authorization: AgentManagementAuthorization,
    operations: ReadonlyArray<{ targetAgentId: string; managerAgentId: string }>,
  ): string[] {
    return this.agentManagement.applyAuthorizedAgentReorganization(authorization, operations);
  }

  readAgentOrganizationEvents(projectId: string): AgentOrganizationEvent[] {
    return this.agentManagement.readAgentOrganizationEvents(projectId);
  }

  updateAgentConversationMemberships(
    id: string,
    input: UpdateAgentConversationMembershipsRequest,
    beforeMembershipProjectionChange?: (agentId: string, removedConversationIds: string[]) => void,
  ): AgentDto | undefined {
    return this.agentManagement.updateAgentConversationMemberships(
      id,
      input,
      beforeMembershipProjectionChange,
    );
  }

  previewAgentDeletion(rootAgentIds: string[]): AgentDeletionPreviewDto {
    return this.agentDeletion.previewAgentDeletion(rootAgentIds);
  }

  deleteAgentSubtrees(
    rootAgentIds: string[],
    expectedPreviewHash: string,
    beforeProjectionDelete?: (agentId: string) => void,
    authorization?: AgentManagementAuthorization,
  ): AgentDeletionPreviewDto {
    return this.agentDeletion.deleteAgentSubtrees(
      rootAgentIds,
      expectedPreviewHash,
      beforeProjectionDelete,
      authorization,
    );
  }

  finishAgentDeletionStorageCleanup(receipt: AgentDeletionReceipt): void {
    this.agentDeletion.finishAgentDeletionStorageCleanup(receipt);
  }

  deleteAgent(id: string, beforeProjectionDelete?: (agentId: string) => void): boolean {
    return this.agentDeletion.deleteAgent(id, beforeProjectionDelete);
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
    return this.eventSession.appendEvent(agentId, event);
  }

  readEvents(agentId: string): StoredLogEvent[] {
    return this.eventSession.readEvents(agentId);
  }

  readEventsSince(agentId: string, sinceSeq: number): StoredLogEvent[] {
    return this.eventSession.readEventsSince(agentId, sinceSeq);
  }

  lastSeqOf(agentId: string): number {
    return this.eventSession.lastSeqOf(agentId);
  }

  latestHealthObservation(agentId: string): {
    status: AgentLifecycleStatus;
    statusTimestamp: string;
    reason: AgentLifecycleReason;
    executionId?: string;
  } | undefined {
    return this.eventSession.latestHealthObservation(agentId);
  }

  // ─── Rebuild (SQLite is disposable; the log is truth) ──────────────────────

  /**
   * Wipe every projection table and replay from disk (the *.json files + each
   * `events.jsonl`). After this, projections are byte-identical to the incremental
   * result — the property the rebuild test asserts.
   */
  private recoverAgentDeletionDirectories(): void {
    this.agentDeletion.recoverAgentDeletionDirectories();
  }

  /** Recover the filesystem side of Project deletion before projection rebuild
   * can discard hidden directories or prune quarantine rows. A journal row means
   * the SQLite purge did not commit, so its exact rename is rolled back. Without
   * a row, a tombstone is committed cleanup and must never be resurrected. */
  private recoverProjectDeletionDirectories(): void {
    this.projectDeletion.recoverProjectDeletionDirectories();
  }

  rebuildProjections(): void {
    this.projectionRebuilder.rebuildProjections();
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
    this.agentManagement.sanitizeOrganizationProjection(projectId);
  }

  private projectIdOf(agentId: string): string {
    return this.agentCatalog.projectIdOf(agentId);
  }

  private activeEngineOf(agentId: string): string {
    return this.agentCatalog.activeEngineOf(agentId);
  }

  private rowToAgentDto(id: string): AgentDto | undefined {
    return this.agentCatalog.rowToAgentDto(id);
  }

  private persistAgentMemberships(
    id: string,
    conversationIds: string[],
    primaryConversationId?: string,
    beforeProjectionChange?: () => void,
  ): void {
    this.agentCatalog.persistAgentMemberships(
      id,
      conversationIds,
      primaryConversationId,
      beforeProjectionChange,
    );
  }

  continuationHandoffForRun(agentId: string, executionId: string): {
    id: string; executionId: string; text: string; createdAt: string; consumedAt?: string;
  } | undefined {
    return this.eventSession.continuationHandoffForRun(agentId, executionId);
  }

  pendingContinuationHandoff(agentId: string): {
    id: string; executionId: string; text: string; createdAt: string;
  } | undefined {
    return this.eventSession.pendingContinuationHandoff(agentId);
  }

  consumeContinuationHandoff(agentId: string, handoffId: string, executionId: string): boolean {
    return this.eventSession.consumeContinuationHandoff(agentId, handoffId, executionId);
  }

  resumeSessionState(agentId: string): {
    sessionId: string;
    toolContractHash?: string;
    artifactIds: string[];
  } | undefined {
    return this.eventSession.resumeSessionState(agentId);
  }

  resumeSessionId(agentId: string): string | undefined {
    return this.eventSession.resumeSessionId(agentId);
  }

  clearResumeSession(
    agentId: string,
    reason: "explicit_compaction" | "resume_compaction_failed" | "request_context_rollover" | "tool_contract_changed" | "provider_root_exit",
  ): boolean {
    return this.eventSession.clearResumeSession(agentId, reason);
  }

}
