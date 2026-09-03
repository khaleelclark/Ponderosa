// AgentStore — the library that apps/server consumes. Authored communication and
// execution telemetry remain event-log-owned and their SQLite views are
// rebuildable. Communication V3 scheduler state is different: its requests,
// joins, activations, Runs, leases, fences, injections, and idempotency records
// are authoritative SQLite state. Exposes NO HTTP (SPEC §7).

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type {
  ArtifactDto,
  AgentActivityDto,
  ChangedFileDto,
  ChangedFileDetailDto,
  AgentOrganizationEvent,
  CommunicationEvent,
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
  WorkItemDto,
  AgentDetailDto,
  HistoryPageDto,
  AgentDto,
  AgentDeletionPreviewDto,
  PortableAgentHistoryMessageDto,
  TokenUsageSummaryDto,
  TokenUsageRangeDto,
  TokenUsage,
  GlobalChatSearchResponseDto,
  AllChatPageDto,
  RunOutputDto,
  ResponseFileActivityDto,
  UpdateProjectRequest,
  UpdateConversationRequest,
  UpdateAgentRequest,
  UpdateAgentOrganizationRequest,
  AgentPhaseDto,
} from "@ponderosa/core";
import type { GlobalChatSearchInput } from "./store-chat-search-read-model.js";
import {
  bindContextRolloverBoundary,
  hasCompactionHistory,
  indexCompactionHistoryMessage,
  readCompactionHistory,
  reconcileCompactionHistoryIndex,
  resolveContextRolloverTail,
  searchCompactionHistory,
  type CompactionHistoryBoundary,
  type CompactionHistoryMaterializationKind,
  type ContextRolloverBoundaryBinding,
  type ContextRolloverTailBinding,
  type ReadCompactionHistoryInput,
  type ResolvedContextRolloverTailMessage,
  type SearchCompactionHistoryInput,
} from "./compaction-history-retrieval.js";
import type { AgentChatFeedProjection } from "./store-chat-feed-projection.js";
import type { AgentTelemetryReadModel } from "./store-telemetry-read-model.js";
import type { AgentPhaseReadModel } from "./store-agent-phase-read-model.js";
import type { AgentFileActivityReadModel } from "./store-file-activity-read-model.js";
import type { AgentRunUsageReadModel } from "./store-run-usage-read-model.js";
import type { AgentArtifactCatalog } from "./store-artifact-catalog.js";
import type { AgentEventSessionAuthority } from "./store-event-session-authority.js";
import type { AgentConversationProjectionReadModel } from "./store-conversation-projection-read-model.js";
import type { AgentCommunicationProjectionLedger } from "./store-communication-projection-ledger.js";
import type { AgentWorkspaceCatalogAuthority } from "./store-workspace-catalog-authority.js";
import type { AgentCatalogAuthority } from "./store-agent-catalog-authority.js";
import type { AgentCommunicationJournalAuthority } from "./store-communication-journal-authority.js";
import type { AgentManagementAuthority } from "./store-agent-management-authority.js";
import type { AgentProjectDeletionAuthority } from "./store-project-deletion-authority.js";
import type { AgentDeletionAuthority } from "./store-agent-deletion-authority.js";
import type { AgentProjectionRebuilder } from "./store-projection-rebuilder.js";
import type { AgentAuditReadModel } from "./store-agent-audit-read-model.js";
import {
  createAgentStoreComponents,
  openAgentStoreData,
  type AgentStoreComponentPorts,
} from "./store-component-factory.js";
import { AgentStoreSupport } from "./store-support.js";
import { AgentEventSessionFacade } from "./store-event-session-facade.js";
import {
  releaseDataDirectoryOwnership,
  type DataDirectoryOwnership,
} from "./store-data-directory.js";
export { AgentDeletionConflictError } from "./store-agent-management.js";
import type { Db } from "./db.js";
import type { LogEvent } from "./log-event.js";
import type {
  ContextReadBoundary,
  ContextSourcePage,
  ManagedArtifactAccess,
  AgentSpawnOrigin,
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

export type AgentCreationOperationStatus =
  | "preparing"
  | "canonical_committed"
  | "completed"
  | "rolling_back"
  | "rolled_back";

export interface AgentCreationOperation {
  id: string;
  projectId: string;
  actorScope: string;
  kind: "human" | "managed" | "import";
  idempotencyKey: string;
  payloadHash: string;
  status: AgentCreationOperationStatus;
  agentIds: string[];
  artifactIds: string[];
  communicationEventId?: string;
  result?: unknown;
  lastError?: string;
}

export class AgentStore extends AgentEventSessionFacade {
  private readonly phaseReadModel!: AgentPhaseReadModel;
  private readonly db: Db;
  private readonly client: Database.Database;
  private readonly telemetry!: AgentTelemetryReadModel;
  private readonly fileActivity!: AgentFileActivityReadModel;
  private readonly chatFeed!: AgentChatFeedProjection;
  private readonly runUsage!: AgentRunUsageReadModel;
  private readonly artifactCatalog!: AgentArtifactCatalog;
  protected readonly eventSession!: AgentEventSessionAuthority;
  private readonly conversationProjection!: AgentConversationProjectionReadModel;
  private readonly communicationProjectionLedger!: AgentCommunicationProjectionLedger;
  private readonly workspaceCatalog!: AgentWorkspaceCatalogAuthority;
  private readonly agentCatalog!: AgentCatalogAuthority;
  private readonly communicationJournal!: AgentCommunicationJournalAuthority;
  private readonly agentManagement!: AgentManagementAuthority;
  private readonly projectDeletion!: AgentProjectDeletionAuthority;
  private readonly agentDeletion!: AgentDeletionAuthority;
  private readonly projectionRebuilder!: AgentProjectionRebuilder;
  private readonly auditReadModel!: AgentAuditReadModel;
  private readonly support: AgentStoreSupport;
  private ownership?: DataDirectoryOwnership;
  private closed = false;
  private compactionHistoryMaterialization = {
    indexedRows: 0,
    relationCandidateRows: 0,
    canonicalEvents: 0,
    canonicalRevisions: 0,
  };
  private startupProfileData: {
    mode: "clean" | "recovery";
    openMs: number;
    componentsMs: number;
    recoveryMs: number;
    totalMs: number;
    projectCount: number;
  } = { mode: "recovery", openMs: 0, componentsMs: 0, recoveryMs: 0, totalMs: 0, projectCount: 0 };

  constructor(dataDir: string) {
    super();
    const startupStartedAt = performance.now();
    this.support = new AgentStoreSupport(dataDir);
    const opened = openAgentStoreData(dataDir);
    const openedAt = performance.now();
    this.db = opened.db;
    this.client = opened.client;
    this.ownership = opened.ownership;
    try {
      const ports: AgentStoreComponentPorts = {
        listAgents: projectId => this.listAgents(projectId),
        getConversationMessages: (conversationId, channel) => this.getConversationMessages(conversationId, channel),
        getAgentPreset: presetId => this.getAgentPreset(presetId),
        getProject: projectId => this.getProject(projectId),
        getConversation: conversationId => this.getConversation(conversationId),
        getAgent: agentId => this.getAgent(agentId),
        getProjectArtifact: (projectId, artifactId) => this.getProjectArtifact(projectId, artifactId),
        communicationProjectionAllowed: (projectId, projection) => this.canProjectCommunication(projectId, projection),
        appendCommunicationProjection: (projectId, projection) => this.appendCommunicationProjection(projectId, projection),
        encodeHistoryCursor: input => this.encodeHistoryCursor(input),
        decodeHistoryCursor: (cursor, stream, scope) => this.decodeHistoryCursor(cursor, stream, scope),
        rowToAgentDto: agentId => this.rowToAgentDto(agentId),
        readEvents: agentId => this.readEvents(agentId),
        activeEngineOf: agentId => this.activeEngineOf(agentId),
        projectIdOf: agentId => this.projectIdOf(agentId),
        authorizeAgentManagementPlan: (authorization, targetAgentIds) =>
          this.authorizeAgentManagementPlan(authorization, targetAgentIds),
        communicationIndex: projectId => this.communicationIndex(projectId),
        communicationRevisionIndex: projectId => this.communicationRevisionIndex(projectId),
        messageDispatches: projectId => this.messageDispatches(projectId),
        projectionIndex: projectId => this.projectionIndex(projectId),
        readProjectedCommunicationMessages: (projectId, surface, projectionKey, limit) =>
          this.readProjectedCommunicationMessages(projectId, surface, projectionKey, limit),
        readProjectedCommunicationMessagePage: (projectId, surface, projectionKey, input) =>
          this.readProjectedCommunicationMessagePage(projectId, surface, projectionKey, input),
        materializeProjectedCommunicationMessages: (projectId, projections) =>
          this.materializeProjectedCommunicationMessages(projectId, projections),
        listProjects: () => this.listProjects(),
        ensureCommunicationBehaviorProjections: event => this.ensureCommunicationBehaviorProjections(event),
        getCommunicationEvent: (projectId, eventId) => this.getCommunicationEvent(projectId, eventId),
        getRuns: agentId => this.getRuns(agentId),
        recoverProjectDeletionDirectories: () => this.recoverProjectDeletionDirectories(),
        recoverAgentDeletionDirectories: () => this.recoverAgentDeletionDirectories(),
        sanitizeOrganizationProjection: projectId => this.sanitizeOrganizationProjection(projectId),
        clearCommunicationProjectionCache: projectId => this.support.clearCommunicationProjectionCache(projectId),
        getRunOutputs: agentId => this.getRunOutputs(agentId),
        getRunOutputPage: (agentId, input) => this.getRunOutputPage(agentId, input),
        getActivity: agentId => this.getActivity(agentId),
        getActivityPage: (agentId, input) => this.getActivityPage(agentId, input),
        getChangedFilePage: (agentId, input) => this.getChangedFilePage(agentId, input),
        getRunPage: (agentId, input) => this.getRunPage(agentId, input),
        getFinalizedWorkDurationMs: agentId => this.getFinalizedWorkDurationMs(agentId),
        getWorkItems: agentId => this.getWorkItems(agentId),
        getWorkItemPage: (agentId, input) => this.getWorkItemPage(agentId, input),
        getArtifacts: agentId => this.getArtifacts(agentId),
        getArtifactPage: (agentId, input) => this.getArtifactPage(agentId, input),
      };
      const components = createAgentStoreComponents(dataDir, opened, ports);
      Object.assign(this, components);
      const componentsCreatedAt = performance.now();
      this.agentCatalog.recoverCreationDirectories();
      // Canonical files are written before their SQLite projections. Rebuild
      // transactionally on every startup so a crash or torn append cannot leave
      // a partially repaired projection visible to ordinary requests.
      this.rebuildProjections();
      for (const project of this.listProjects()) {
        this.ensureCommunicationProjectionLedger(project.id);
        reconcileCompactionHistoryIndex(
          this.client,
          project.id,
          this.readCommunicationEvents(project.id),
          this.readCommunicationRevisions(project.id),
        );
      }
      const completedAt = performance.now();
      this.startupProfileData = {
        mode: "recovery",
        openMs: Math.round((openedAt - startupStartedAt) * 10) / 10,
        componentsMs: Math.round((componentsCreatedAt - openedAt) * 10) / 10,
        recoveryMs: Math.round((completedAt - componentsCreatedAt) * 10) / 10,
        totalMs: Math.round((completedAt - startupStartedAt) * 10) / 10,
        projectCount: this.listProjects().length,
      };
    } catch (error) {
      releaseDataDirectoryOwnership(this.ownership);
      this.ownership = undefined;
      throw error;
    }
  }

  startupProfile(): Readonly<typeof this.startupProfileData> {
    return { ...this.startupProfileData };
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
    return this.support.projectionIndex(projectId);
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
    const result = this.communicationJournal.appendCommunicationEvent(input);
    const ordinal = this.communicationJournal.communicationOrdinal(result.event.projectId, result.event.eventId);
    if (!ordinal) throw new Error("communication append ordinal is unavailable");
    // A canonical append may have committed before its derived index
    // transaction failed. Exact idempotent replay is therefore also the
    // bounded live repair path; startup reconciliation remains the full repair.
    indexCompactionHistoryMessage(
      this.client,
      result.event,
      ordinal,
      this.communicationJournal.latestCommunicationRevision(
        result.event.projectId,
        result.event.eventId,
      ),
    );
    return result;
  }

  private ensureCommunicationBehaviorProjections(event: CommunicationEvent): void {
    this.communicationJournal.ensureCommunicationBehaviorProjections(event);
  }

  appendCommunicationRevision(input: CommunicationRevisionEvent): { revision: CommunicationRevisionEvent; replayed: boolean } {
    const result = this.communicationJournal.appendCommunicationRevision(input);
    if (!result.replayed) {
      const event = this.communicationJournal.getCommunicationEvent(
        result.revision.projectId,
        result.revision.targetEventId,
      );
      const ordinal = this.communicationJournal.communicationOrdinal(
        result.revision.projectId,
        result.revision.targetEventId,
      );
      if (event && ordinal) {
        indexCompactionHistoryMessage(
          this.client,
          event,
          ordinal,
          result.revision,
        );
      }
    }
    return result;
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

  /** Current append-only authored-communication boundary. This generic
   * rollover primitive does not depend on any retrieval index or tool. */
  communicationJournalBoundary(projectId: string): {
    canonicalOrdinal: number;
    communicationEventId?: string;
  } {
    return this.communicationJournal.communicationBoundary(projectId);
  }

  communicationHistoryBoundary(projectId: string): CompactionHistoryBoundary {
    return this.communicationJournalBoundary(projectId);
  }

  /** Exact canonical Communication identities known to occupy the currently
   * accepted provider session. Scheduler Runs carry the provider-session
   * identity observed after acknowledged injection; rejected replacement
   * candidates therefore cannot contaminate the old accepted session merely by
   * appearing later in the Agent event log. Legacy snapshots without a creating
   * execution ID return undefined so rollover fails closed. */
  acceptedProviderSessionCommunicationEventIds(agentId: string): string[] | undefined {
    const accepted = this.resumeSessionState(agentId);
    if (!accepted) return undefined;
    const events = this.readEvents(agentId);
    let boundaryExecutionId: string | undefined;
    let rolloverId: string | undefined;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!.event;
      if ((event.type === "session_snapshot" || event.type === "context_rollover_session_accepted") &&
          event.sessionId === accepted.sessionId) {
        boundaryExecutionId = event.executionId;
        rolloverId = event.type === "context_rollover_session_accepted" ? event.rolloverId : undefined;
        break;
      }
    }
    if (!boundaryExecutionId) return undefined;
    const boundaryRun = this.client.prepare(`
      SELECT provider_session_id, prompt_injection_state FROM scheduler_runs
      WHERE id = ? AND agent_id = ?
    `).get(boundaryExecutionId, agentId) as {
      provider_session_id: string | null;
      prompt_injection_state: string;
    } | undefined;
    // Imported legacy logs may predate scheduler session binding.
    // They are not safe evidence for a new rollover boundary.
    if (!boundaryRun || boundaryRun.provider_session_id !== accepted.sessionId ||
        boundaryRun.prompt_injection_state !== "injected") return undefined;
    const executionIds = new Set((this.client.prepare(`
      SELECT id FROM scheduler_runs
      WHERE agent_id = ? AND provider_session_id = ?
        AND prompt_injection_state = 'injected'
      ORDER BY created_at, id
    `).all(agentId, accepted.sessionId) as Array<{ id: string }>).map((row) => row.id));
    const selectedHistoryIds: string[] = [];
    for (const stored of events) {
      const event = stored.event;
      if (event.type === "compaction_history_retrieval" && executionIds.has(event.executionId)) {
        selectedHistoryIds.push(...event.selected.map((selected) => selected.communicationEventId));
      }
    }
    const rolloverTail = rolloverId
      ? (this.client.prepare(`
          SELECT recent_tail_event_ids_json FROM context_rollovers WHERE id = ? AND agent_id = ?
        `).get(rolloverId, agentId) as { recent_tail_event_ids_json: string } | undefined)
      : undefined;
    const providerInputIds = [...executionIds].flatMap((executionId) =>
      this.getProviderInput(executionId)?.sourceManifest.communicationEventIds ?? []);
    return [...new Set([
      ...(rolloverTail ? JSON.parse(rolloverTail.recent_tail_event_ids_json) as string[] : []),
      ...providerInputIds,
      ...selectedHistoryIds,
    ])];
  }

  bindContextRolloverBoundary(input: {
    agentId: string;
    currentConversationId?: string;
    submittedCommunicationEventIds: readonly string[];
  }): ContextRolloverBoundaryBinding {
    const agent = this.getAgent(input.agentId);
    if (!agent || agent.archived) throw new Error("context rollover agent is unavailable");
    return bindContextRolloverBoundary({
      ...input,
      sqlite: this.client,
      agent,
      getConversation: id => this.getConversation(id),
      getAgent: id => this.getAgent(id),
      getCommunicationEvent: (projectId, eventId) =>
        this.communicationJournal.getCommunicationEvent(projectId, eventId),
      getLatestCommunicationRevision: (projectId, targetEventId) =>
        this.communicationJournal.latestCommunicationRevision(projectId, targetEventId),
      observeMaterialization: (kind, count) => this.observeCompactionHistoryMaterialization(kind, count),
    });
  }

  resolveContextRolloverTail(input: {
    agentId: string;
    currentConversationId?: string;
    boundary: CompactionHistoryBoundary;
    recentTail: readonly ContextRolloverTailBinding[];
  }): ResolvedContextRolloverTailMessage[] {
    const agent = this.getAgent(input.agentId);
    if (!agent || agent.archived) throw new Error("context rollover agent is unavailable");
    return resolveContextRolloverTail({
      ...input,
      sqlite: this.client,
      agent,
      getConversation: id => this.getConversation(id),
      getAgent: id => this.getAgent(id),
      getCommunicationEvent: (projectId, eventId) =>
        this.communicationJournal.getCommunicationEvent(projectId, eventId),
      getLatestCommunicationRevision: (projectId, targetEventId) =>
        this.communicationJournal.latestCommunicationRevision(projectId, targetEventId),
      observeMaterialization: (kind, count) => this.observeCompactionHistoryMaterialization(kind, count),
    });
  }

  hasCompactionHistory(input: {
    agentId: string;
    currentConversationId?: string;
    boundary: CompactionHistoryBoundary;
    excludedCommunicationEventIds: ReadonlySet<string>;
  }): boolean {
    const agent = this.getAgent(input.agentId);
    if (!agent || agent.archived) return false;
    return hasCompactionHistory({
      ...input,
      sqlite: this.client,
      agent,
      getConversation: id => this.getConversation(id),
      getAgent: id => this.getAgent(id),
      getCommunicationEvent: (projectId, eventId) =>
        this.communicationJournal.getCommunicationEvent(projectId, eventId),
      getLatestCommunicationRevision: (projectId, targetEventId) =>
        this.communicationJournal.latestCommunicationRevision(projectId, targetEventId),
      observeMaterialization: (kind, count) => this.observeCompactionHistoryMaterialization(kind, count),
    });
  }

  /** Search only canonical authored Communication visible to one active Agent.
   * The caller supplies the frozen current-context exclusions for its Run. */
  searchCompactionHistory(input: Omit<
    SearchCompactionHistoryInput,
    "sqlite" | "agent" | "getConversation" | "getAgent" | "getCommunicationEvent" |
    "getLatestCommunicationRevision" | "observeMaterialization" | "boundary"
  > & { agentId: string; boundary?: CompactionHistoryBoundary }) {
    const agent = this.getAgent(input.agentId);
    if (!agent || agent.archived) throw new Error("compaction-history agent is unavailable");
    return searchCompactionHistory({
      ...input,
      boundary: input.boundary ?? this.communicationHistoryBoundary(agent.projectId),
      sqlite: this.client,
      agent,
      getConversation: id => this.getConversation(id),
      getAgent: id => this.getAgent(id),
      getCommunicationEvent: (projectId, eventId) =>
        this.communicationJournal.getCommunicationEvent(projectId, eventId),
      getLatestCommunicationRevision: (projectId, targetEventId) =>
        this.communicationJournal.latestCommunicationRevision(projectId, targetEventId),
      observeMaterialization: (kind, count) => this.observeCompactionHistoryMaterialization(kind, count),
    });
  }

  readCompactionHistory(input: Omit<
    ReadCompactionHistoryInput,
    "sqlite" | "agent" | "getConversation" | "getAgent" | "getCommunicationEvent" |
    "getLatestCommunicationRevision" | "observeMaterialization" | "boundary"
  > & { agentId: string; boundary?: CompactionHistoryBoundary }) {
    const agent = this.getAgent(input.agentId);
    if (!agent || agent.archived) throw new Error("compaction-history agent is unavailable");
    return readCompactionHistory({
      ...input,
      boundary: input.boundary ?? this.communicationHistoryBoundary(agent.projectId),
      sqlite: this.client,
      agent,
      getConversation: id => this.getConversation(id),
      getAgent: id => this.getAgent(id),
      getCommunicationEvent: (projectId, eventId) =>
        this.communicationJournal.getCommunicationEvent(projectId, eventId),
      getLatestCommunicationRevision: (projectId, targetEventId) =>
        this.communicationJournal.latestCommunicationRevision(projectId, targetEventId),
      observeMaterialization: (kind, count) => this.observeCompactionHistoryMaterialization(kind, count),
    });
  }

  /** Derived-index qualification evidence. Counts contain no message text. */
  compactionHistoryIndexStats(projectId: string): {
    messages: number;
    lexicalRows: number;
  } {
    const messages = this.client.prepare(`
      SELECT COUNT(*) AS count
      FROM compaction_history_messages message
      WHERE message.project_id = ? AND (
        message.conversation_id IS NULL OR EXISTS (
          SELECT 1 FROM conversations conversation
          WHERE conversation.id = message.conversation_id
            AND conversation.project_id = message.project_id
            AND conversation.archived = 0
        )
      )
    `).get(projectId) as { count: number } | undefined;
    const lexicalRows = this.client.prepare(`
      SELECT COUNT(*) AS count FROM compaction_history_fts WHERE project_id = ?
    `).get(projectId) as { count: number } | undefined;
    return {
      messages: messages?.count ?? 0,
      lexicalRows: lexicalRows?.count ?? 0,
    };
  }

  private observeCompactionHistoryMaterialization(
    kind: CompactionHistoryMaterializationKind,
    count: number,
  ): void {
    if (kind === "indexed_rows") this.compactionHistoryMaterialization.indexedRows += count;
    else if (kind === "relation_candidates") this.compactionHistoryMaterialization.relationCandidateRows += count;
    else if (kind === "canonical_events") this.compactionHistoryMaterialization.canonicalEvents += count;
    else this.compactionHistoryMaterialization.canonicalRevisions += count;
  }

  /** Qualification-only counters. They expose counts, never canonical text. */
  compactionHistoryMaterializationStats(): {
    journalEventArrayReads: number;
    journalEventRowsCopied: number;
    journalRevisionArrayReads: number;
    journalRevisionRowsCopied: number;
    indexedRows: number;
    relationCandidateRows: number;
    canonicalEvents: number;
    canonicalRevisions: number;
  } {
    const journal = this.communicationJournal.communicationMaterializationStats();
    return {
      journalEventArrayReads: journal.eventArrayReads,
      journalEventRowsCopied: journal.eventRowsCopied,
      journalRevisionArrayReads: journal.revisionArrayReads,
      journalRevisionRowsCopied: journal.revisionRowsCopied,
      ...this.compactionHistoryMaterialization,
    };
  }

  resetCompactionHistoryMaterializationStats(): void {
    this.communicationJournal.resetCommunicationMaterializationStats();
    this.compactionHistoryMaterialization = {
      indexedRows: 0,
      relationCandidateRows: 0,
      canonicalEvents: 0,
      canonicalRevisions: 0,
    };
  }

  getCommunicationDocument(projectId: string, documentId: string) {
    return this.communicationJournal.getCommunicationDocument(projectId, documentId);
  }

  canProjectCommunication(
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

  getCommunicationProjection(
    projectId: string,
    eventId: string,
    surface: CommunicationProjection["surface"],
    projectionKey: string,
  ): CommunicationProjection | undefined {
    return this.communicationProjectionLedger.getCommunicationProjection(
      projectId,
      eventId,
      surface,
      projectionKey,
    );
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
    return this.support.encodeHistoryCursor(input);
  }

  private decodeHistoryCursor(cursor: string, stream: string, scope: string): { orderKey: string; rowKey: string } {
    return this.support.decodeHistoryCursor(cursor, stream, scope);
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

  /** The raw better-sqlite3 handle for read models, transactions, and PRAGMAs. */
  get sqlite(): Database.Database {
    return this.client;
  }

  beginAgentCreationOperation(input: {
    projectId: string;
    actorScope: string;
    kind: AgentCreationOperation["kind"];
    idempotencyKey: string;
    payloadHash: string;
  }): { operation: AgentCreationOperation; replayed: boolean } {
    const id = `agent-create-${createHash("sha256").update(
      `${input.projectId}\0${input.actorScope}\0${input.kind}\0${input.idempotencyKey}`,
    ).digest("hex")}`;
    const existing = this.getAgentCreationOperation(id);
    if (existing) {
      if (existing.payloadHash !== input.payloadHash) {
        throw new Error("Agent creation idempotency key was reused with different input");
      }
      if (existing.status === "rolled_back") {
        this.client.transaction(() => {
          this.client.prepare("DELETE FROM agent_creation_operation_members WHERE operation_id = ?").run(id);
          this.client.prepare(`
            UPDATE agent_creation_operations
            SET status = 'preparing', communication_event_id = NULL, result_json = NULL,
              artifact_ids_json = '[]', last_error = NULL, updated_at = ? WHERE id = ?
          `).run(new Date().toISOString(), id);
        })();
        return { operation: this.getAgentCreationOperation(id)!, replayed: false };
      }
      return { operation: existing, replayed: true };
    }
    const now = new Date().toISOString();
    try {
      this.client.prepare(`
        INSERT INTO agent_creation_operations
          (id, project_id, actor_scope, kind, idempotency_key, payload_hash, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?, ?)
      `).run(id, input.projectId, input.actorScope, input.kind, input.idempotencyKey, input.payloadHash, now, now);
    } catch (error) {
      const raced = this.getAgentCreationOperation(id);
      if (!raced || raced.payloadHash !== input.payloadHash) throw error;
      return { operation: raced, replayed: true };
    }
    return { operation: this.getAgentCreationOperation(id)!, replayed: false };
  }

  getAgentCreationOperation(id: string): AgentCreationOperation | undefined {
    const row = this.client.prepare(`
      SELECT id, project_id, actor_scope, kind, idempotency_key, payload_hash, status,
        communication_event_id, artifact_ids_json, result_json, last_error
      FROM agent_creation_operations WHERE id = ?
    `).get(id) as {
      id: string; project_id: string; actor_scope: string; kind: AgentCreationOperation["kind"];
      idempotency_key: string; payload_hash: string; status: AgentCreationOperationStatus;
      communication_event_id: string | null; artifact_ids_json: string; result_json: string | null; last_error: string | null;
    } | undefined;
    if (!row) return undefined;
    const members = this.client.prepare(`
      SELECT agent_id FROM agent_creation_operation_members WHERE operation_id = ? ORDER BY position
    `).all(id) as Array<{ agent_id: string }>;
    return {
      id: row.id,
      projectId: row.project_id,
      actorScope: row.actor_scope,
      kind: row.kind,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      status: row.status,
      agentIds: members.map((member) => member.agent_id),
      artifactIds: JSON.parse(row.artifact_ids_json) as string[],
      ...(row.communication_event_id ? { communicationEventId: row.communication_event_id } : {}),
      ...(row.result_json ? { result: JSON.parse(row.result_json) as unknown } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
    };
  }

  listRecoverableAgentCreationOperations(): AgentCreationOperation[] {
    return (this.client.prepare(`
      SELECT id FROM agent_creation_operations
      WHERE status IN ('preparing', 'canonical_committed', 'rolling_back')
      ORDER BY created_at, id
    `).all() as Array<{ id: string }>).flatMap(({ id }) => {
      const operation = this.getAgentCreationOperation(id);
      return operation ? [operation] : [];
    });
  }

  addAgentCreationOperationMember(operationId: string, agentId: string, position: number): void {
    this.client.prepare(`
      INSERT INTO agent_creation_operation_members (operation_id, agent_id, position)
      VALUES (?, ?, ?)
      ON CONFLICT(operation_id, agent_id) DO UPDATE SET position = excluded.position
    `).run(operationId, agentId, position);
  }

  updateAgentCreationOperation(
    id: string,
    patch: {
      status?: AgentCreationOperationStatus;
      communicationEventId?: string | null;
      artifactIds?: readonly string[];
      result?: unknown;
      lastError?: string | null;
    },
  ): AgentCreationOperation {
    const current = this.getAgentCreationOperation(id);
    if (!current) throw new Error("Agent creation operation not found");
    const nextStatus = patch.status ?? current.status;
    this.client.prepare(`
      UPDATE agent_creation_operations
      SET status = ?, communication_event_id = ?, artifact_ids_json = ?, result_json = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextStatus,
      patch.communicationEventId === undefined ? current.communicationEventId ?? null : patch.communicationEventId,
      JSON.stringify(patch.artifactIds ?? current.artifactIds),
      patch.result === undefined ? current.result === undefined ? null : JSON.stringify(current.result) : JSON.stringify(patch.result),
      patch.lastError === undefined ? current.lastError ?? null : patch.lastError,
      new Date().toISOString(),
      id,
    );
    return this.getAgentCreationOperation(id)!;
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

  listProjectDeletionReceipts(): ProjectDeletionReceipt[] {
    return this.projectDeletion.listProjectDeletionReceipts();
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

  deleteConversation(
    id: string,
    beforeProjectionDelete?: (conversationId: string) => void,
  ): boolean {
    return this.workspaceCatalog.deleteConversation(
      id,
      beforeProjectionDelete,
    );
  }

  appendConversationMessage(
    conversationId: string,
    input: CreateConversationMessageRequest & {
      role?: "user" | "assistant" | "system";
      artifactIds?: string[];
    },
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

  createAgent(
    projectId: string,
    input: CreateAgentRequest,
    origin?: AgentSpawnOrigin,
    predeterminedId?: string,
  ): AgentDto {
    return this.agentCatalog.createAgent(projectId, input, origin, predeterminedId);
  }

  findAgentSpawn(agentId: string, executionId: string, idempotencyKey: string): AgentDto | undefined {
    return this.agentCatalog.findAgentSpawn(agentId, executionId, idempotencyKey);
  }

  findAgentCreation(projectId: string, idempotencyKey: string): AgentDto | undefined {
    return this.agentCatalog.findAgentCreation(projectId, idempotencyKey);
  }

  listAgents(projectId: string): AgentDto[] {
    return this.agentCatalog.listAgents(projectId);
  }

  listAgentEngineAssignments(): Array<{ id: string; activeEngine: string }> {
    return this.agentCatalog.listAgentEngineAssignments();
  }

  getAgentTitleProjection(agentIds: readonly string[]): ReadonlyMap<string, string> {
    return this.agentCatalog.getAgentTitleProjection(agentIds);
  }

  getAgent(id: string): AgentDto | undefined {
    return this.agentCatalog.getAgent(id);
  }

  listProjectWorkingCopies(projectId: string): Array<{
    agentId: string;
    deleted: boolean;
    workingCopy: AgentDto["workingCopy"];
  }> {
    return this.agentCatalog.listProjectWorkingCopies(projectId);
  }

  updateAgentWorkingCopy(
    id: string,
    workingCopy: AgentDto["workingCopy"],
  ): AgentDto | undefined {
    return this.agentCatalog.updateAgentWorkingCopy(id, workingCopy);
  }

  updateDeletedAgentWorkingCopy(
    id: string,
    workingCopy: AgentDto["workingCopy"],
  ): boolean {
    return this.agentCatalog.updateDeletedAgentWorkingCopy(id, workingCopy);
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
    return this.auditReadModel.getAgentDetail(id, limit, includeMessages);
  }

  getFinalizedWorkDurationMs(agentId: string): number {
    return this.telemetry.getFinalizedWorkDurationMs(agentId);
  }

  getMessages(agentId: string): MessageDto[] {
    return this.auditReadModel.getMessages(agentId);
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

  /** Exact open call evidence is rebuilt from canonical log events. */
  activeExecutionPhase(
    agentId: string,
    executionId: string,
  ): Extract<AgentPhaseDto, { kind: "running_command" | "using_tool" }> | undefined {
    return this.phaseReadModel.activeExecutionPhase(agentId, executionId);
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
      scope: "current_chat" | "agent_private";
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

  getRunPage(agentId: string, input: {
    limit: number;
    cursor?: string;
    focusId?: string;
    includeProviderInputManifest?: boolean;
  }): HistoryPageDto<AgentRunDto> {
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

  projectHasArtifactSourcePath(projectId: string, sourcePath: string): boolean {
    return this.artifactCatalog.projectHasArtifactSourcePath(projectId, sourcePath);
  }

  getProjectArtifactPage(projectId: string, input: { limit: number; cursor?: string; conversationId?: string }): HistoryPageDto<ArtifactDto> {
    return this.artifactCatalog.getProjectArtifactPage(projectId, input);
  }

  getProjectArtifact(projectId: string, artifactIdValue: string): ArtifactDto | undefined {
    return this.artifactCatalog.getProjectArtifact(projectId, artifactIdValue);
  }

  /** Server-owned publication-ledger authority for managed attachments. It is
   * applied whenever canonical Communications are materialized for an operator. */
  configureCommunicationAttachmentMetadataAuthority(
    authority: (projectId: string, artifact: ArtifactDto) => boolean,
  ): void {
    this.communicationProjectionLedger.configureManagedArtifactAttachmentMetadataAuthority(authority);
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

  recordProjectArtifacts(
    entries: ReadonlyArray<{
      artifact: ArtifactDto & { projectId: string; originAgentId: string };
      access?: ManagedArtifactAccess;
    }>,
  ): void {
    this.artifactCatalog.recordProjectArtifacts(entries);
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

  getGeneratedArtifact(agentId: string, artifactIdValue: string): Extract<LogEvent, { type: "generated_artifact" }> | undefined {
    return this.artifactCatalog.getGeneratedArtifact(agentId, artifactIdValue);
  }

  getArtifact(agentId: string, artifactIdValue: string): ArtifactDto | undefined {
    return this.artifactCatalog.getArtifact(agentId, artifactIdValue);
  }

  // ─── Rebuild (SQLite is disposable; the log is truth) ──────────────────────

  /**
   * Wipe every projection table and replay from disk (the *.json files + each
   * `events.jsonl`). After this, projections are byte-identical to the incremental
   * result.
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

}
