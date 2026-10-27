// AgentStore — the library that apps/server consumes. Authored communication and
// execution telemetry remain event-log-owned and their SQLite views are
// rebuildable. Communication V3 scheduler state is different: its requests,
// joins, activations, Runs, leases, fences, injections, and idempotency records
// are authoritative SQLite state. Exposes NO HTTP (SPEC §7).

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "@ponderosa/native-host/fs";
import path from "node:path";
import { readRepairableJsonl } from "./append-jsonl.js";
import { agentJsonPath, communicationEventsPath, communicationProjectionsPath, communicationRevisionsPath, conversationJsonPath, messageDispatchesPath } from "./paths.js";
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
import type { AgentCommunicationProjectionLedger, CommunicationProjectionRecoveryFilter } from "./store-communication-projection-ledger.js";
import type {
  AgentWorkspaceCatalogAuthority,
  WorkspaceCreationIdentity,
} from "./store-workspace-catalog-authority.js";
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
  consumeProjectionCheckpoint,
  ProjectionProgress,
  type ProjectionTail,
} from "./projection-checkpoint.js";
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
  ConversationDeletionReceipt,
  ProjectDeletionReceipt,
  AgentManagementAuthorization,
  ManagementPlan,
} from "./store-types.js";
export type {
  ContextReadBoundary,
  ContextSourcePage,
  ManagedArtifactAccess,
  AgentSpawnOrigin,
  ConversationDeliveryIntent,
  AgentDeletionReceipt,
  ConversationDeletionReceipt,
  ProjectDeletionReceipt,
  AgentManagementAuthorization,
} from "./store-types.js";

export type AgentCreationOperationStatus =
  | "preparing"
  | "canonical_committed"
  | "completed"
  | "rolling_back"
  | "rolled_back";

export interface AgentCreationArtifactIdentity {
  id: string;
  byteLength: number;
  sha256: string;
  generated?: {
    agentId: string;
    originAgentId: string;
    executionId?: string;
    path: string;
    sourcePath?: string;
    summary: string;
    createdAt: string;
    mediaType: string;
  };
}

export interface AgentCreationOperation {
  id: string;
  projectId: string;
  conversationId?: string;
  productScope?: "dev" | "branches";
  actorScope: string;
  kind: "human" | "managed" | "import";
  idempotencyKey: string;
  payloadHash: string;
  status: AgentCreationOperationStatus;
  agentIds: string[];
  artifactIds: string[];
  artifactIdentities: AgentCreationArtifactIdentity[];
  communicationEventId?: string;
  result?: unknown;
  lastError?: string;
}

const admittedStores = new WeakSet<object>();

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
  private dataDirectory = "";
  private closing = false;
  private readonly projectionProgress: ProjectionProgress;
  private compactionHistoryMaterialization = {
    indexedRows: 0,
    relationCandidateRows: 0,
    canonicalEvents: 0,
    canonicalRevisions: 0,
  };
  private startupProfileData: {
    mode: "clean" | "incremental" | "recovery";
    openMs: number;
    componentsMs: number;
    recoveryMs: number;
    totalMs: number;
    projectCount: number;
    recoveryIssues: ReadonlyArray<{ projectId: string; detail: string }>;
    phasesMs: Record<string, number>;
  } = { mode: "recovery", openMs: 0, componentsMs: 0, recoveryMs: 0, totalMs: 0, projectCount: 0, recoveryIssues: [], phasesMs: {} };

  constructor(dataDir: string) {
    super();
    const startupStartedAt = performance.now();
    const opened = openAgentStoreData(dataDir);
    dataDir = opened.dataDir;
    this.dataDirectory = dataDir;
    const openedAt = performance.now();
    this.db = opened.db;
    this.client = opened.client;
    this.ownership = opened.ownership;
    try {
      this.projectionProgress = new ProjectionProgress(dataDir, this.client);
      const phasesMs: Record<string, number> = {};
      const measure = <T>(phase: string, work: () => T): T => {
        const started = performance.now();
        try { return work(); }
        finally { phasesMs[phase] = Math.round(((phasesMs[phase] ?? 0) + performance.now() - started) * 10) / 10; }
      };
      this.support = new AgentStoreSupport(dataDir);
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
        authorizeAgentManagementPlan: (authorization, targetAgentIds, consumeApproval) =>
          this.authorizeAgentManagementPlan(authorization, targetAgentIds, consumeApproval),
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
      const components = createAgentStoreComponents(dataDir, opened, ports, this.projectionProgress);
      Object.assign(this, components);
      const componentsCreatedAt = performance.now();
      measure("creationRecovery", () => {
        this.workspaceCatalog.recoverCreationDirectories();
        this.agentCatalog.recoverCreationDirectories();
      });
      // A consumed proof covers committed projections. Apply only verified
      // unfinished suffixes; an unknown source or missing proof still rebuilds.
      let checkpoint = measure("checkpointValidation", () => consumeProjectionCheckpoint(dataDir, this.client));
      let incremental = false;
      if (checkpoint && checkpoint.tails.length) {
        try {
          measure("projectionTails", () => this.recoverProjectionTails(checkpoint ? checkpoint.tails : []));
          incremental = true;
        } catch {
          checkpoint = false;
        }
      }
      if (!checkpoint) measure("projectionReplay", () => this.rebuildProjections());
      // Repair canonical members before creation recovery can release quarantine.
      // Ordinary Agent lists must continue to hide pending creation operations.
      if (measure("workingDirectoryMigration", () => this.workspaceCatalog.migrateManagedWorkingDirectories(
        projectId => this.listAgents(projectId, { includePendingCreation: true }),
        (id, copy) => { this.updateAgentWorkingCopy(id, copy); },
      ))) {
        measure("projectionReplay", () => this.rebuildProjections());
        checkpoint = false;
        incremental = false;
      }
      if (!checkpoint) for (const project of this.listProjects()) {
        measure("communicationLedger", () => this.ensureCommunicationProjectionLedger(project.id));
        measure("compactionHistory", () => reconcileCompactionHistoryIndex(
          this.client,
          project.id,
          this.readCommunicationEvents(project.id),
          this.readCommunicationRevisions(project.id),
        ));
      }
      if (this.projectionRebuilder.listRecoveryIssues().length === 0) {
        try { measure("projectionProgress", () => this.projectionProgress.initialize()); }
        catch { /* Optional proof must not make a quarantined store unavailable. */ }
      }
      const completedAt = performance.now();
      this.startupProfileData = {
        mode: checkpoint ? (incremental ? "incremental" : "clean") : "recovery",
        openMs: Math.round((openedAt - startupStartedAt) * 10) / 10,
        componentsMs: Math.round((componentsCreatedAt - openedAt) * 10) / 10,
        recoveryMs: Math.round((completedAt - componentsCreatedAt) * 10) / 10,
        totalMs: Math.round((completedAt - startupStartedAt) * 10) / 10,
        projectCount: this.listProjects().length,
        recoveryIssues: this.projectionRebuilder.listRecoveryIssues(),
        phasesMs,
      };
      admittedStores.add(this);
    } catch (error) {
      this.agentCatalog?.invalidateImportedIndexes(true);
      releaseDataDirectoryOwnership(this.ownership);
      this.ownership = undefined;
      throw error;
    }
  }

  static assertCurrent(value: unknown): asserts value is AgentStore {
    if (!value || typeof value !== "object" || !admittedStores.has(value)) throw new Error("injected store has no current construction authority");
    const reference = AgentStore.prototype.stateAdmission.call(value);
    reference.close();
  }

  /** Live same-root permit for companion construction; no serialized marker can replace it. */
  stateAdmission(): import("./state-admission.js").StateAdmission {
    if (this.closing || !this.ownership) throw new Error("store admission is closed");
    return this.ownership.retain();
  }

  startupProfile(): Readonly<{
    mode: "clean" | "incremental" | "recovery";
    openMs: number;
    componentsMs: number;
    recoveryMs: number;
    totalMs: number;
    projectCount: number;
    recoveryIssues: ReadonlyArray<{ projectId: string; detail: string }>;
    phasesMs: Record<string, number>;
  }> {
    return { ...this.startupProfileData, phasesMs: { ...this.startupProfileData.phasesMs } };
  }

  nextDeliveryOrderKey(createdAt = new Date().toISOString()): string {
    return this.projectionProgress.run([path.join(this.dataDirectory, "delivery-order.jsonl")],
      () => this.communicationJournal.nextDeliveryOrderKey(createdAt));
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
    return this.projectionProgress.run([
      communicationEventsPath(this.dataDirectory, input.projectId),
      communicationProjectionsPath(this.dataDirectory, input.projectId),
    ], () => {
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
    });
  }

  private ensureCommunicationBehaviorProjections(event: CommunicationEvent): void {
    this.communicationJournal.ensureCommunicationBehaviorProjections(event);
  }

  appendCommunicationRevision(input: CommunicationRevisionEvent): { revision: CommunicationRevisionEvent; replayed: boolean } {
    return this.projectionProgress.run([communicationRevisionsPath(this.dataDirectory, input.projectId)], () => {
      const result = this.communicationJournal.appendCommunicationRevision(input);
      const event = this.communicationJournal.getCommunicationEvent(input.projectId, result.revision.targetEventId);
      const ordinal = this.communicationJournal.communicationOrdinal(input.projectId, result.revision.targetEventId);
      // An idempotent retry also repairs an accepted edit whose projection
      // previously failed; replaying an older edit must retain the latest text.
      if (event && ordinal) indexCompactionHistoryMessage(this.client, event, ordinal,
        this.communicationJournal.latestCommunicationRevision(input.projectId, event.eventId));
      return result;
    });
  }

  readCommunicationRevisions(projectId: string): CommunicationRevisionEvent[] {
    return this.communicationJournal.readCommunicationRevisions(projectId);
  }

  readCommunicationEvents(projectId: string): CommunicationEvent[] {
    return this.communicationJournal.readCommunicationEvents(projectId);
  }

  getLatestCommunicationRevision(projectId: string, eventId: string): CommunicationRevisionEvent | undefined {
    return this.communicationJournal.latestCommunicationRevision(projectId, eventId);
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
  private acceptedProviderSessionBoundary(agentId: string): {
    sessionId: string; executionId: string; rolloverId?: string;
  } | undefined {
    const accepted = this.resumeSessionState(agentId);
    if (!accepted) return undefined;
    // These are already verified canonical event projections. Read only the
    // latest matching accepted snapshots, never the Agent's full output log.
    const snapshots = ["session_snapshot", "context_rollover_session_accepted"].flatMap(type => {
      const row = this.client.prepare(`
        SELECT seq, payload_json FROM events
        WHERE agent_id=? AND type=? AND json_extract(payload_json, '$.sessionId')=?
        ORDER BY seq DESC LIMIT 1
      `).get(agentId, type, accepted.sessionId) as { seq: number; payload_json: string } | undefined;
      return row ? [{ seq: row.seq, event: JSON.parse(row.payload_json) as LogEvent }] : [];
    }).sort((left, right) => right.seq - left.seq);
    const snapshot = snapshots[0]?.event;
    const boundaryExecutionId = snapshot && (snapshot.type === "session_snapshot" || snapshot.type === "context_rollover_session_accepted")
      ? snapshot.executionId : undefined;
    const rolloverId = snapshot?.type === "context_rollover_session_accepted" ? snapshot.rolloverId : undefined;
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
    return { sessionId: accepted.sessionId, executionId: boundaryExecutionId, ...(rolloverId ? { rolloverId } : {}) };
  }

  /** Exact policy packet attributed to the currently accepted session, never
   * a later, unverified replacement candidate. */
  acceptedProviderSessionInput(agentId: string): ProviderInputDto | undefined {
    const boundary = this.acceptedProviderSessionBoundary(agentId);
    return boundary ? this.getProviderInput(boundary.executionId, true) : undefined;
  }

  /** A closed native process does not erase a measured accepted generation.
   * Reuse only the final observation inside its exact completed Run. Any newer
   * uncertain injection/steering invalidates it instead of charging stale data. */
  acceptedProviderSessionContextUsage(agentId: string): {
    usage: Extract<LogEvent, { type: "context_usage" }>;
    observedAt: string; executionId: string; postObservationUtf8Bytes: number;
  } | undefined {
    const boundary = this.acceptedProviderSessionBoundary(agentId);
    if (!boundary) return undefined;
    const run = this.client.prepare(`SELECT status, fencing_token FROM scheduler_runs
      WHERE id=? AND agent_id=?`).get(boundary.executionId, agentId) as { status: string; fencing_token: number } | undefined;
    if (run?.status !== "completed") return undefined;
    const later = this.client.prepare(`SELECT 1 FROM scheduler_runs
      WHERE agent_id=? AND (provider_session_id=? OR provider_session_id IS NULL) AND fencing_token>?
        AND prompt_injection_state <> 'not_injected' LIMIT 1`
    ).get(agentId, boundary.sessionId, run.fencing_token);
    if (later) return undefined;
    const range = (type: string, lifecycle = false) => this.client.prepare(`SELECT seq FROM events
      WHERE agent_id=? AND type=? AND json_extract(payload_json, '$.executionId')=?
        ${lifecycle ? "AND json_extract(payload_json, '$.status')='running'" : ""}
      ORDER BY seq DESC LIMIT 1`).get(agentId, type, boundary.executionId) as {seq: number} | undefined;
    const start = range("agent_lifecycle", true), terminal = range("turn_done");
    if (!start || !terminal || terminal.seq <= start.seq) return undefined;
    const row = this.client.prepare(`SELECT substr(payload_json,1,4096) AS payload_json,
        length(CAST(payload_json AS BLOB)) AS bytes, created_at, seq
      FROM events WHERE agent_id=? AND type='context_usage' AND seq>? AND seq<?
      ORDER BY seq DESC LIMIT 1`).get(agentId, start.seq, terminal.seq) as {
        payload_json: string; bytes: number; created_at: string; seq: number;
      } | undefined;
    if (!row || row.bytes > 4096) return undefined;
    const usage = JSON.parse(row.payload_json) as Extract<LogEvent, {type: "context_usage"}>;
    if (usage.type !== "context_usage" || usage.providerSessionId !== boundary.sessionId ||
        usage.providerSessionGeneration !== boundary.sessionId) return undefined;
    const steering = this.client.prepare(`SELECT 1 FROM scheduler_prompt_injections
      WHERE run_id=? AND kind='steer' AND (state IN ('submitted','outcome_unknown')
        OR (state='acknowledged' AND acknowledged_at>=?)) LIMIT 1`
    ).get(boundary.executionId, row.created_at);
    if (steering) return undefined;
    const unmeteredWork = this.client.prepare(`SELECT 1 FROM events WHERE agent_id=? AND seq>? AND seq<?
      AND type IN ('tool_call','tool_result','command','file_change') LIMIT 1`).get(agentId, row.seq, terminal.seq);
    if (unmeteredWork) return undefined;
    const tail = this.client.prepare(`SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) AS bytes
      FROM events WHERE agent_id=? AND seq>? AND seq<? AND type IN ('text','reasoning')`
    ).get(agentId, row.seq, terminal.seq) as {bytes: number};
    return { usage, observedAt: row.created_at, executionId: boundary.executionId, postObservationUtf8Bytes: tail.bytes };
  }

  acceptedProviderSessionCommunicationEventIds(agentId: string): string[] | undefined {
    const boundary = this.acceptedProviderSessionBoundary(agentId);
    if (!boundary) return undefined;
    const { sessionId, rolloverId } = boundary;
    const executionIds = new Set((this.client.prepare(`
      SELECT id FROM scheduler_runs
      WHERE agent_id = ? AND provider_session_id = ?
        AND prompt_injection_state = 'injected'
      ORDER BY created_at, id
    `).all(agentId, sessionId) as Array<{ id: string }>).map((row) => row.id));
    const projectId = this.getAgent(agentId)?.projectId;
    const canonicalHash = this.client.prepare('SELECT content_sha256 FROM compaction_history_messages WHERE project_id=? AND communication_event_id=?');
    const matches = (id: string, hash: string | undefined): boolean => Boolean(projectId && hash &&
      (canonicalHash.get(projectId, id) as {content_sha256:string}|undefined)?.content_sha256 === hash);
    const rolloverTail = rolloverId ? this.client.prepare(`
      SELECT recent_tail_event_ids_json, recent_tail_hashes_json FROM context_rollovers WHERE id=? AND agent_id=?
    `).get(rolloverId, agentId) as {recent_tail_event_ids_json:string;recent_tail_hashes_json:string}|undefined : undefined;
    const tailIds = rolloverTail ? JSON.parse(rolloverTail.recent_tail_event_ids_json) as string[] : [];
    const tailHashes = rolloverTail ? JSON.parse(rolloverTail.recent_tail_hashes_json) as string[] : [];
    const providerInputIds = [...executionIds].flatMap(executionId => {
      const manifest = this.getProviderInput(executionId)?.sourceManifest;
      return manifest?.schemaVersion === 3 ? (manifest.historyContext?.fullyIncludedCommunicationEventIds ?? []).filter(id =>
        manifest.sources.some(source => source.kind === 'communication' && source.ref === id && matches(id, source.hash))) : [];
    });
    return [...new Set([...tailIds.filter((id,index)=>matches(id,tailHashes[index])), ...providerInputIds])];
  }

  bindContextRolloverBoundary(input: {
    agentId: string;
    currentConversationId?: string;
    submittedCommunicationEventIds: readonly string[];
    maxUtf8Bytes?: number;
  }): ContextRolloverBoundaryBinding {
    const agent = this.getAgent(input.agentId);
    if (!agent) throw new Error("context rollover agent is unavailable");
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
    if (!agent) throw new Error("context rollover agent is unavailable");
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
    if (!agent) return false;
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
    if (!agent) throw new Error("compaction-history agent is unavailable");
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
    if (!agent) throw new Error("compaction-history agent is unavailable");
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
            AND NOT EXISTS (SELECT 1 FROM conversation_deletion_receipts deleting_chat WHERE deleting_chat.conversation_id = conversation.id)
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

  ensureCommunicationProjectionLedger(projectId: string, filter?: CommunicationProjectionRecoveryFilter): void {
    this.communicationProjectionLedger.ensureCommunicationProjectionLedger(projectId, filter);
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
    if (this.closing || !this.ownership) throw new Error("store admission is closed");
    return this.client;
  }

  beginAgentCreationOperation(input: {
    projectId: string;
    conversationId?: string;
    actorScope: string;
    kind: AgentCreationOperation["kind"];
    idempotencyKey: string;
    payloadHash: string;
  }): { operation: AgentCreationOperation; replayed: boolean } {
    const id = this.agentCreationOperationId(input);
    const productScope = input.conversationId
      ? this.getConversation(input.conversationId)?.branchId ? "branches" : "dev"
      : undefined;
    const sameOwner = (operation: AgentCreationOperation) =>
      operation.payloadHash === input.payloadHash &&
      operation.conversationId === input.conversationId &&
      operation.productScope === productScope;
    const existing = this.getAgentCreationOperation(id);
    if (existing) {
      if (!sameOwner(existing)) {
        throw new Error("Agent creation idempotency key was reused with different input");
      }
      if (existing.status === "rolled_back") {
        this.client.transaction(() => {
          this.client.prepare("DELETE FROM agent_creation_operation_members WHERE operation_id = ?").run(id);
          this.client.prepare(`
            UPDATE agent_creation_operations
            SET status = 'preparing', communication_event_id = NULL,
              artifact_ids_json = '[]', artifact_identities_json = '[]', last_error = NULL,
              updated_at = ? WHERE id = ?
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
          (id, project_id, actor_scope, kind, idempotency_key, payload_hash, conversation_id, product_scope, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)
      `).run(id, input.projectId, input.actorScope, input.kind, input.idempotencyKey, input.payloadHash, input.conversationId ?? null, productScope ?? null, now, now);
    } catch (error) {
      const raced = this.getAgentCreationOperation(id);
      if (!raced || !sameOwner(raced)) throw error;
      return { operation: raced, replayed: true };
    }
    return { operation: this.getAgentCreationOperation(id)!, replayed: false };
  }

  findAgentCreationOperation(input: {
    projectId: string;
    actorScope: string;
    kind: AgentCreationOperation["kind"];
    idempotencyKey: string;
  }): AgentCreationOperation | undefined {
    return this.getAgentCreationOperation(this.agentCreationOperationId(input));
  }

  private agentCreationOperationId(input: {
    projectId: string;
    actorScope: string;
    kind: AgentCreationOperation["kind"];
    idempotencyKey: string;
  }): string {
    return `agent-create-${createHash("sha256").update(
      `${input.projectId}\0${input.actorScope}\0${input.kind}\0${input.idempotencyKey}`,
    ).digest("hex")}`;
  }

  getAgentCreationOperation(id: string): AgentCreationOperation | undefined {
    const row = this.client.prepare(`
      SELECT id, project_id, conversation_id, product_scope, actor_scope, kind, idempotency_key, payload_hash, status,
        communication_event_id, artifact_ids_json, artifact_identities_json, result_json, last_error
      FROM agent_creation_operations WHERE id = ?
    `).get(id) as {
      id: string; project_id: string; conversation_id: string | null; product_scope: "dev" | "branches" | null; actor_scope: string; kind: AgentCreationOperation["kind"];
      idempotency_key: string; payload_hash: string; status: AgentCreationOperationStatus;
      communication_event_id: string | null; artifact_ids_json: string; artifact_identities_json: string;
      result_json: string | null; last_error: string | null;
    } | undefined;
    if (!row) return undefined;
    const members = this.client.prepare(`
      SELECT agent_id FROM agent_creation_operation_members WHERE operation_id = ? ORDER BY position
    `).all(id) as Array<{ agent_id: string }>;
    return {
      id: row.id,
      projectId: row.project_id,
      ...(row.conversation_id ? {conversationId:row.conversation_id} : {}),
      ...(row.product_scope ? {productScope:row.product_scope} : {}),
      actorScope: row.actor_scope,
      kind: row.kind,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      status: row.status,
      agentIds: members.map((member) => member.agent_id),
      artifactIds: JSON.parse(row.artifact_ids_json) as string[],
      artifactIdentities: JSON.parse(row.artifact_identities_json) as AgentCreationArtifactIdentity[],
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
      artifactIdentities?: readonly AgentCreationArtifactIdentity[];
      result?: unknown;
      lastError?: string | null;
    },
  ): AgentCreationOperation {
    const current = this.getAgentCreationOperation(id);
    if (!current) throw new Error("Agent creation operation not found");
    const nextStatus = patch.status ?? current.status;
    this.client.prepare(`
      UPDATE agent_creation_operations
      SET status = ?, communication_event_id = ?, artifact_ids_json = ?, artifact_identities_json = ?,
        result_json = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextStatus,
      patch.communicationEventId === undefined ? current.communicationEventId ?? null : patch.communicationEventId,
      JSON.stringify(patch.artifactIds ?? current.artifactIds),
      JSON.stringify(patch.artifactIdentities ?? current.artifactIdentities),
      patch.result === undefined ? current.result === undefined ? null : JSON.stringify(current.result) : JSON.stringify(patch.result),
      patch.lastError === undefined ? current.lastError ?? null : patch.lastError,
      new Date().toISOString(),
      id,
    );
    return this.getAgentCreationOperation(id)!;
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  createProject(
    input: Omit<CreateProjectRequest, "defaultEngine"> & {
      hostPath: string;
      chatOwned?: boolean;
      branchId?: string;
      executionId?: string;
      managedWorkspaceName?: string;
      creationHostPath?: string;
      defaultEngine?: CreateProjectRequest["defaultEngine"];
    },
    identity?: WorkspaceCreationIdentity,
  ): ProjectDto {
    return this.workspaceCatalog.createProject(input, identity);
  }

  getProjectCreation(identity: WorkspaceCreationIdentity): ProjectDto | undefined {
    return this.workspaceCatalog.getProjectCreation(identity);
  }

  getManagedCreationHostPath(key: string, name: string): string | undefined {
    return this.workspaceCatalog.getManagedCreationHostPath(key, name);
  }

  updateProject(id: string, input: UpdateProjectRequest): ProjectDto | undefined {
    return this.workspaceCatalog.updateProject(id, input);
  }

  markProjectDeletionPending(projectId: string, now = new Date().toISOString()): string[] {
    return this.projectDeletion.markProjectDeletionPending(projectId, now);
  }

  recordProjectDeletionCleanupError(projectId: string, error: string): void {
    this.projectDeletion.recordProjectDeletionCleanupError(projectId, error);
  }

  listPendingProjectDeletions(): Array<{ projectId: string; draftSurfaceIds: string[]; createdAt: string; lastError?: string }> {
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

  markProjectDeletionDraftCleanupComplete(projectId: string): void {
    this.projectDeletion.markProjectDeletionDraftCleanupComplete(projectId);
  }

  markProjectDeletionAssetAuthorityCleanupComplete(projectId: string): void {
    this.projectDeletion.markProjectDeletionAssetAuthorityCleanupComplete(projectId);
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

  getAgentPresetCreation(projectId: string, identity: WorkspaceCreationIdentity): AgentPresetDto | undefined {
    return this.workspaceCatalog.getAgentPresetCreation(projectId, identity);
  }

  createAgentPreset(
    projectId: string,
    input: CreateAgentPresetRequest,
    identity?: WorkspaceCreationIdentity,
  ): AgentPresetDto {
    return this.workspaceCatalog.createAgentPreset(projectId, input, identity);
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

  getNamespaceOwnerConversationId(projectId: string): string | undefined {
    return this.workspaceCatalog.getNamespaceOwnerConversationId(projectId);
  }

  getProject(id: string): ProjectDto | undefined {
    return this.workspaceCatalog.getProject(id);
  }

  markProjectUsed(projectId: string, conversationId?: string): ProjectDto | undefined {
    return this.workspaceCatalog.markProjectUsed(projectId, conversationId);
  }

  // ─── Conversations ─────────────────────────────────────────────────────────

  createConversation(
    projectId: string,
    input: CreateConversationRequest,
    identity?: WorkspaceCreationIdentity,
  ): ConversationDto {
    return this.workspaceCatalog.createConversation(projectId, input, identity);
  }

  getConversationCreation(
    projectId: string,
    identity: WorkspaceCreationIdentity,
  ): ConversationDto | undefined {
    return this.workspaceCatalog.getConversationCreation(projectId, identity);
  }

  listConversations(projectId: string): ConversationDto[] {
    return this.workspaceCatalog.listConversations(projectId);
  }

  getConversation(id: string, options?: { includeDeleting?: boolean }): ConversationDto | undefined {
    return this.workspaceCatalog.getConversation(id, options);
  }

  getChatContext(id: string): ProjectDto | undefined {
    return this.workspaceCatalog.getChatContext(id);
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

  getConversationDeletionReceipt(id: string): ConversationDeletionReceipt | undefined {
    return this.workspaceCatalog.getConversationDeletionReceipt(id);
  }

  listPendingConversationDeletionReceipts(): ConversationDeletionReceipt[] {
    return this.workspaceCatalog.listPendingConversationDeletionReceipts();
  }

  markConversationDeletionPending(id: string): ConversationDeletionReceipt {
    return this.workspaceCatalog.markConversationDeletionPending(id);
  }

  recordConversationDeletionCleanupError(id: string, error: string): void {
    this.workspaceCatalog.recordConversationDeletionCleanupError(id, error);
  }

  finishConversationDeletionStorageCleanup(
    receipt: ConversationDeletionReceipt,
    afterTombstoneRemoval?: (conversationId: string) => void,
  ): void {
    this.workspaceCatalog.finishConversationDeletionStorageCleanup(receipt, afterTombstoneRemoval);
  }

  refreshConversationDeletionProjection(receipt: ConversationDeletionReceipt): void {
    this.workspaceCatalog.refreshConversationDeletionProjection(receipt);
  }

  markConversationDeletionServerCleanupComplete(id: string): void {
    this.workspaceCatalog.markConversationDeletionServerCleanupComplete(id);
  }

  commitConversationDeletion(
    id: string,
    beforeProjectionDelete?: (conversationId: string) => void,
  ): ConversationDeletionReceipt | undefined {
    return this.workspaceCatalog.commitConversationDeletion(
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
    const conversation = this.getConversation(conversationId);
    if (!conversation) return undefined;
    return this.projectionProgress.run([
      conversationJsonPath(this.dataDirectory, conversation.projectId, conversationId),
      messageDispatchesPath(this.dataDirectory, conversation.projectId),
      communicationProjectionsPath(this.dataDirectory, conversation.projectId),
      path.join(this.dataDirectory, "delivery-order.jsonl"),
    ], () => this.communicationJournal.appendConversationMessage(
        conversationId,
        input,
        authorAgentId,
        channel,
        deliveryIntents,
        messageReceiptKey,
        communicationEventId,
      ));
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
    resolvedPresetSnapshot?: AgentDto["presetSnapshot"] | null,
  ): AgentDto {
    return this.agentCatalog.createAgent(
      projectId,
      input,
      origin,
      predeterminedId,
      resolvedPresetSnapshot,
    );
  }

  findAgentSpawn(agentId: string, executionId: string, idempotencyKey: string): AgentDto | undefined {
    return this.agentCatalog.findAgentSpawn(agentId, executionId, idempotencyKey);
  }

  findAgentCreation(projectId: string, idempotencyKey: string): AgentDto | undefined {
    return this.agentCatalog.findAgentCreation(projectId, idempotencyKey);
  }

  listAgents(
    projectId: string,
    options: { includePendingCreation?: boolean } = {},
  ): AgentDto[] {
    const agents = this.agentCatalog.listAgents(projectId);
    if (options.includePendingCreation) return agents;
    const pending = new Set(this.pendingAgentCreationIds(projectId));
    return pending.size ? agents.filter((agent) => !pending.has(agent.id)) : agents;
  }

  pendingAgentCreationIds(projectId?: string): string[] {
    return (this.client.prepare(`
      SELECT members.agent_id
      FROM agent_creation_operation_members AS members
      JOIN agent_creation_operations AS operations ON operations.id = members.operation_id
      WHERE operations.status IN ('preparing', 'canonical_committed', 'rolling_back')
        AND (? IS NULL OR operations.project_id = ?)
      ORDER BY members.agent_id
    `).all(projectId ?? null, projectId ?? null) as Array<{ agent_id: string }>)
      .map((row) => row.agent_id);
  }

  agentCreationPending(agentId: string): boolean {
    return Boolean(this.client.prepare(`
      SELECT 1
      FROM agent_creation_operation_members AS members
      JOIN agent_creation_operations AS operations ON operations.id = members.operation_id
      WHERE members.agent_id = ?
        AND operations.status IN ('preparing', 'canonical_committed', 'rolling_back')
      LIMIT 1
    `).get(agentId));
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

  getAgentProjectId(id: string): string | undefined {
    return this.agentCatalog.getAgentProjectId(id);
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

  setImportedHistory(agentId: string, source: string, messages: PortableAgentHistoryMessageDto[], initialInstructions?: string): void {
    this.agentCatalog.setImportedHistory(agentId, source, messages, initialInstructions);
  }

  setImportedHistoryAsync(agentId: string, source: string, messages: PortableAgentHistoryMessageDto[], initialInstructions?: string): Promise<void> {
    return this.agentCatalog.setImportedHistoryAsync(agentId, source, messages, initialInstructions);
  }

  getImportedHistory(agentId: string): { source: string; importedAt: string; messages: PortableAgentHistoryMessageDto[]; initialInstructions?: string } | undefined {
    return this.agentCatalog.getImportedHistory(agentId);
  }

  getImportedHistoryMessagePage(
    agentId: string,
    input: { limit: number; before?: ContextReadBoundary; maxTextUtf8Bytes?: number },
  ): ContextSourcePage<MessageDto> & { hasClippedMessages: boolean } {
    return this.agentCatalog.getImportedHistoryMessagePage(agentId, input);
  }

  getImportedHistoryAvailability(agentId: string) {
    return this.agentCatalog.getImportedHistoryAvailability(agentId);
  }

  searchImportedHistory(input: Parameters<AgentCatalogAuthority["searchImportedHistory"]>[0]) {
    return this.agentCatalog.searchImportedHistory(input);
  }

  readImportedHistory(input: Parameters<AgentCatalogAuthority["readImportedHistory"]>[0]) {
    return this.agentCatalog.readImportedHistory(input);
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

  createAgentManagementPlan(plan: ManagementPlan): { plan: ManagementPlan; replayed: boolean } {
    return this.agentManagement.createAgentManagementPlan(plan);
  }

  getAgentManagementPlan(id: string): ManagementPlan | undefined {
    return this.agentManagement.getAgentManagementPlan(id);
  }

  findAgentManagementPlan(ownerAgentId: string, runId: string, idempotencyKey: string): ManagementPlan | undefined {
    return this.agentManagement.findAgentManagementPlan(ownerAgentId, runId, idempotencyKey);
  }

  listAgentManagementPlans(): ManagementPlan[] {
    return this.agentManagement.listAgentManagementPlans();
  }

  updateAgentManagementPlan(
    id: string,
    patch: Parameters<AgentManagementAuthority["updateAgentManagementPlan"]>[1],
  ): ManagementPlan {
    return this.agentManagement.updateAgentManagementPlan(id, patch);
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
    const agent = this.getAgent(id);
    if (!agent) return undefined;
    return this.projectionProgress.run([agentJsonPath(this.dataDirectory, agent.projectId, id)],
      () => this.agentManagement.updateAgent(id, patch));
  }

  /** Internal installation compensation; preserves the exact reserved handle. */
  restoreAgentConfiguration(id: string, snapshot: Pick<AgentDto,"title"|"handle"|"activeEngine"|"managementPermissions"> & {model:string|null;effort:string|null;speed:string|null}): AgentDto | undefined {
    return this.agentManagement.restoreAgentConfiguration(id,snapshot);
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

  applyAuthorizedAgentReorganizationAndCompletePlan(
    authorization: AgentManagementAuthorization,
    operations: ReadonlyArray<{ targetAgentId: string; managerAgentId: string }>,
    appliedAt: string,
  ): { changedAgentIds: string[]; plan: ManagementPlan } {
    return this.agentManagement.applyAuthorizedAgentReorganizationAndCompletePlan(
      authorization,
      operations,
      appliedAt,
    );
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

  finishAgentDeletionStorageCleanup(
    receipt: AgentDeletionReceipt,
    afterAuditRename?: (agentId: string) => void,
  ): void {
    this.agentDeletion.finishAgentDeletionStorageCleanup(receipt, afterAuditRename);
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

  getMessageAttachmentIds(agentId: string): Set<string> {
    return this.auditReadModel.getMessageAttachmentIds(agentId);
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
  getResponseFileReview(agentId: string, executionId: string) {
    return this.telemetry.getResponseFileReview(agentId, executionId);
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

  getAllChatPage(input: { limit?: number; cursor?: string;productScope?:'dev'|'branches' } = {}): AllChatPageDto {
    return this.chatFeed.getAllChatPage(input);
  }

  getLatestRun(agentId: string): ReturnType<AgentRunUsageReadModel["getLatestRun"]> {
    return this.runUsage.getLatestRun(agentId);
  }

  getRunStatus(agentId: string, runId: string): AgentRunDto["status"] | undefined {
    return this.runUsage.getRunStatus(agentId, runId);
  }

  getRunHealthSummaries(agentId: string): ReturnType<AgentRunUsageReadModel["getRunHealthSummaries"]> {
    return this.runUsage.getRunHealthSummaries(agentId);
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
    scope: ({ type: "overall" } | { type: "project" | "agent" | "conversation" | "branch"; id: string }) & {productScope?:'dev'|'branches'},
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

  getProjectArtifactPage(projectId: string, input: { limit: number; cursor?: string; conversationId?: string; search?: string;productScope?:'dev'|'branches' }): HistoryPageDto<ArtifactDto> {
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

  projectArtifactBelongsToConversation(projectId: string, artifactId: string, conversationId: string): boolean {
    return this.artifactCatalog.projectArtifactBelongsToConversation(projectId, artifactId, conversationId);
  }

  operatorCanReadProjectArtifact(projectId: string, artifactIdValue: string): boolean {
    return this.artifactCatalog.operatorCanReadProjectArtifact(projectId, artifactIdValue);
  }

  agentCanReadProjectArtifact(projectId: string, artifactIdValue: string, agentId: string): boolean {
    return this.artifactCatalog.agentCanReadProjectArtifact(projectId, artifactIdValue, agentId);
  }

  getProjectContextArtifacts(projectId: string, limit = 100, conversationId?: string): ArtifactDto[] {
    return this.artifactCatalog.getProjectContextArtifacts(projectId, limit, conversationId);
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

  private recoverProjectionTails(tails: ProjectionTail[]): void {
    this.client.transaction(() => {
      for (const tail of tails) {
        const event = /^projects\/([^/]+)\/agents\/([^/]+)\/events\.jsonl$/u.exec(tail.path);
        if (event) {
          this.eventSession.recoverEventTail(event[2]!, event[1]!, tail.offset);
          continue;
        }
        const communication = /^projects\/([^/]+)\/(communication-events|communication-revisions|communication-projections)\.jsonl$/u.exec(tail.path);
        if (!communication) throw new Error("unsupported projection suffix");
        const file = path.join(this.dataDirectory, tail.path);
        const prefix = readFileSync(file).subarray(0, tail.offset).toString("utf8");
        if (tail.offset && !prefix.endsWith("\n")) throw new Error("invalid communication prefix boundary");
        const count = prefix.split("\n").filter(line => line.trim()).length;
        const suffix = readRepairableJsonl<CommunicationEvent | CommunicationRevisionEvent | CommunicationProjection>(file, "projection recovery", true).slice(count);
        for (const record of suffix) {
          if (communication[2] !== "communication-projections" &&
              (record as CommunicationEvent | CommunicationRevisionEvent).projectId !== communication[1]) {
            throw new Error("communication recovery owner mismatch");
          }
          if (communication[2] === "communication-events") this.appendCommunicationEvent(record as CommunicationEvent);
          else if (communication[2] === "communication-revisions") this.appendCommunicationRevision(record as CommunicationRevisionEvent);
          else {
            const placement = record as CommunicationProjection;
            const tuple = `${placement.eventId}\u0000${placement.surface}\u0000${placement.projectionKey}`;
            const current = this.projectionIndex(communication[1]!).byTuple.get(tuple);
            if (!current || !this.canProjectCommunication(communication[1]!, current)) throw new Error("unrecoverable communication placement");
            this.chatFeed.upsertGlobalChatSearchProjection(communication[1]!, current);
          }
        }
      }
    })();
  }


  abortStartup(): void {
    if (!this.ownership) return;
    this.closing = true;
    this.agentCatalog.invalidateImportedIndexes(true);
    admittedStores.delete(this);
    releaseDataDirectoryOwnership(this.ownership);
    this.ownership = undefined;
  }

  close(options: { checkpointWrites?: boolean } = {}): void {
    if (!this.ownership) return;
    if (!this.closing) {
      this.closing = true;
      this.agentCatalog.invalidateImportedIndexes(true);
      admittedStores.delete(this);
      // Completion receipts certify successful writes without replaying history
      // during shutdown. Missing/inconsistent proof leaves full recovery intact.
      try {
        if (options.checkpointWrites) {
          this.rebuildProjections();
          for (const project of this.listProjects()) {
            this.ensureCommunicationProjectionLedger(project.id);
            reconcileCompactionHistoryIndex(this.client, project.id,
              this.readCommunicationEvents(project.id), this.readCommunicationRevisions(project.id));
          }
          if (this.projectionRebuilder.listRecoveryIssues().length === 0) this.projectionProgress.initialize();
        }
        if (this.projectionRebuilder.listRecoveryIssues().length === 0) this.projectionProgress.checkpoint();
      }
      catch { /* full projection recovery remains authoritative */ }
    }
    // Fenced teardown may retry this same reference after SQLite was busy.
    // Checkpoint work above runs only on the first orderly close attempt.
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
