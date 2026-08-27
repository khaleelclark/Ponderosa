import { mkdirSync } from "node:fs";
import type Database from "better-sqlite3";
import type {
  AgentDto,
  AgentPresetDto,
  AgentRunDto,
  ArtifactDto,
  CommunicationEvent,
  CommunicationProjection,
  ConversationChannel,
  ConversationDto,
  ConversationMessageDto,
  ProjectDto,
  ProjectedCommunicationMessage,
} from "@ponderosa/core";
import { openDb, type Db } from "./db.js";
import { readRepairableJsonl } from "./append-jsonl.js";
import {
  acquireDataDirectoryOwnership,
  ensureV1Layout,
  releaseDataDirectoryOwnership,
  type DataDirectoryOwnership,
} from "./store-data-directory.js";
import { dbPath, projectsDir } from "./paths.js";
import type { StoredLogEvent } from "./log-event.js";
import type {
  AgentManagementAuthorization,
  MessageDispatchRecord,
} from "./store-types.js";
import { AgentArtifactCatalog } from "./store-artifact-catalog.js";
import { AgentAuditReadModel } from "./store-agent-audit-read-model.js";
import { AgentCatalogAuthority } from "./store-agent-catalog-authority.js";
import { AgentChatFeedProjection } from "./store-chat-feed-projection.js";
import { AgentCommunicationJournalAuthority } from "./store-communication-journal-authority.js";
import { AgentCommunicationProjectionLedger } from "./store-communication-projection-ledger.js";
import { AgentConversationProjectionReadModel } from "./store-conversation-projection-read-model.js";
import { AgentDeletionAuthority } from "./store-agent-deletion-authority.js";
import { AgentEventProjectionStore } from "./store-event-projection.js";
import { AgentEventSessionAuthority } from "./store-event-session-authority.js";
import { AgentFileActivityReadModel } from "./store-file-activity-read-model.js";
import { AgentManagementAuthority } from "./store-agent-management-authority.js";
import { AgentProjectDeletionAuthority } from "./store-project-deletion-authority.js";
import { AgentProjectionRebuilder } from "./store-projection-rebuilder.js";
import { AgentRunUsageReadModel } from "./store-run-usage-read-model.js";
import { AgentPhaseReadModel } from "./store-agent-phase-read-model.js";
import { AgentTelemetryReadModel } from "./store-telemetry-read-model.js";
import { AgentWorkspaceCatalogAuthority } from "./store-workspace-catalog-authority.js";
import { setCompactionHistoryConversationVisibility } from "./compaction-history-retrieval.js";

type HistoryCursorInput = {
  stream: string;
  scope: string;
  orderKey: string;
  rowKey: string;
};
type ProjectionIndex = {
  projections: CommunicationProjection[];
  byTuple: Map<string, CommunicationProjection>;
};

export interface AgentStoreComponentPorts {
  listAgents(projectId: string): AgentDto[];
  getConversationMessages(
    conversationId: string,
    channel?: ConversationChannel,
  ): ConversationMessageDto[];
  getAgentPreset(presetId: string): AgentPresetDto | undefined;
  updateAgentOrganization(agentId: string, input: Parameters<AgentCatalogAuthority["updateAgentOrganization"]>[1]): AgentDto | undefined;
  getProject(projectId: string): ProjectDto | undefined;
  getConversation(conversationId: string): ConversationDto | undefined;
  getAgent(agentId: string): AgentDto | undefined;
  getProjectArtifact(projectId: string, artifactId: string): ArtifactDto | undefined;
  communicationProjectionAllowed(
    projectId: string,
    projection: Pick<CommunicationProjection, "eventId" | "surface" | "projectionKey" | "message">,
  ): boolean;
  appendCommunicationProjection(projectId: string, projection: CommunicationProjection): unknown;
  encodeHistoryCursor(input: HistoryCursorInput): string;
  decodeHistoryCursor(cursor: string, stream: string, scope: string): { orderKey: string; rowKey: string };
  rowToAgentDto(agentId: string): AgentDto | undefined;
  readEvents(agentId: string): StoredLogEvent[];
  activeEngineOf(agentId: string): string;
  projectIdOf(agentId: string): string;
  authorizeAgentManagementPlan(
    authorization: AgentManagementAuthorization,
    targetAgentIds: readonly string[],
  ): void;
  communicationIndex(projectId: string): ReturnType<AgentCommunicationJournalAuthority["communicationIndex"]>;
  communicationRevisionIndex(projectId: string): ReturnType<AgentCommunicationJournalAuthority["communicationRevisionIndex"]>;
  messageDispatches(projectId: string): MessageDispatchRecord[];
  projectionIndex(projectId: string): ProjectionIndex;
  readProjectedCommunicationMessages(
    projectId: string,
    surface: CommunicationProjection["surface"],
    projectionKey: string,
    limit?: number,
  ): ProjectedCommunicationMessage[];
  readProjectedCommunicationMessagePage(
    projectId: string,
    surface: CommunicationProjection["surface"],
    projectionKey: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ): { messages: ProjectedCommunicationMessage[]; hasMore: boolean; cursor?: string };
  materializeProjectedCommunicationMessages(
    projectId: string,
    projections: CommunicationProjection[],
  ): ProjectedCommunicationMessage[];
  listProjects(): ProjectDto[];
  ensureCommunicationBehaviorProjections(event: CommunicationEvent): void;
  getCommunicationEvent(projectId: string, eventId: string): CommunicationEvent | undefined;
  getRuns(agentId: string): AgentRunDto[];
  recoverProjectDeletionDirectories(): void;
  recoverAgentDeletionDirectories(): void;
  sanitizeOrganizationProjection(projectId: string): void;
  clearCommunicationProjectionCache(projectId: string): void;
  getRunOutputs: ConstructorParameters<typeof AgentAuditReadModel>[4];
  getRunOutputPage: ConstructorParameters<typeof AgentAuditReadModel>[5];
  getActivity: ConstructorParameters<typeof AgentAuditReadModel>[6];
  getActivityPage: ConstructorParameters<typeof AgentAuditReadModel>[7];
  getChangedFilePage: ConstructorParameters<typeof AgentAuditReadModel>[8];
  getRunPage: ConstructorParameters<typeof AgentAuditReadModel>[10];
  getFinalizedWorkDurationMs: ConstructorParameters<typeof AgentAuditReadModel>[11];
  getWorkItems: ConstructorParameters<typeof AgentAuditReadModel>[12];
  getWorkItemPage: ConstructorParameters<typeof AgentAuditReadModel>[13];
  getArtifacts: ConstructorParameters<typeof AgentAuditReadModel>[14];
  getArtifactPage: ConstructorParameters<typeof AgentAuditReadModel>[15];
}

export interface OpenAgentStoreData {
  db: Db;
  client: Database.Database;
  ownership: DataDirectoryOwnership;
  deliverySequenceFile: string;
  deliverySequence: number;
}

export interface AgentStoreComponents {
  phaseReadModel: AgentPhaseReadModel;
  telemetry: AgentTelemetryReadModel;
  fileActivity: AgentFileActivityReadModel;
  chatFeed: AgentChatFeedProjection;
  runUsage: AgentRunUsageReadModel;
  artifactCatalog: AgentArtifactCatalog;
  eventSession: AgentEventSessionAuthority;
  conversationProjection: AgentConversationProjectionReadModel;
  communicationProjectionLedger: AgentCommunicationProjectionLedger;
  workspaceCatalog: AgentWorkspaceCatalogAuthority;
  agentCatalog: AgentCatalogAuthority;
  communicationJournal: AgentCommunicationJournalAuthority;
  agentManagement: AgentManagementAuthority;
  projectDeletion: AgentProjectDeletionAuthority;
  agentDeletion: AgentDeletionAuthority;
  projectionRebuilder: AgentProjectionRebuilder;
  auditReadModel: AgentAuditReadModel;
}

export function openAgentStoreData(dataDir: string): OpenAgentStoreData {
  ensureV1Layout(dataDir);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectsDir(dataDir), { recursive: true });
  const ownership = acquireDataDirectoryOwnership(dataDir);
  try {
    const deliverySequenceFile = `${dataDir}/delivery-order.jsonl`;
    const deliverySequence = readRepairableJsonl<{ sequence: number }>(
      deliverySequenceFile,
      "delivery order journal",
      true,
    ).reduce((maximum, record) => Math.max(maximum, record.sequence), 0);
    const opened = openDb(dbPath(dataDir));
    return { ...opened, ownership, deliverySequenceFile, deliverySequence };
  } catch (error) {
    releaseDataDirectoryOwnership(ownership);
    throw error;
  }
}

export function createAgentStoreComponents(
  dataDir: string,
  opened: OpenAgentStoreData,
  ports: AgentStoreComponentPorts,
): AgentStoreComponents {
  const { db, client, deliverySequenceFile, deliverySequence } = opened;
  let chatFeed!: AgentChatFeedProjection;
  let communicationProjectionLedger!: AgentCommunicationProjectionLedger;

  const workspaceCatalog = new AgentWorkspaceCatalogAuthority(
    dataDir,
    db,
    client,
    ports.listAgents,
    ports.getConversationMessages,
    projectId => chatFeed.refreshAllChatFeedProject(projectId),
    (projectId, conversationId, visible) =>
      setCompactionHistoryConversationVisibility(client, projectId, conversationId, visible),
  );
  const agentCatalog = new AgentCatalogAuthority(
    dataDir,
    db,
    client,
    ports.getAgentPreset,
    ports.getProject,
    ports.updateAgentOrganization,
  );
  const communicationJournal = new AgentCommunicationJournalAuthority(
    dataDir,
    db,
    deliverySequenceFile,
    deliverySequence,
    ports.getProject,
    ports.getConversation,
    ports.getAgent,
    ports.getProjectArtifact,
    ports.communicationProjectionAllowed,
    ports.appendCommunicationProjection,
  );
  const artifactCatalog = new AgentArtifactCatalog(
    dataDir,
    client,
    ports.encodeHistoryCursor,
    ports.decodeHistoryCursor,
    ports.rowToAgentDto,
    projectId => Boolean(ports.getProject(projectId)),
    ports.readEvents,
  );
  const eventProjection = new AgentEventProjectionStore(
    dataDir,
    db,
    client,
    ports.activeEngineOf,
    artifact => artifactCatalog.recordProjectArtifact(artifact),
  );
  const eventSession = new AgentEventSessionAuthority(
    db,
    client,
    eventProjection,
    ports.getAgent,
    ports.projectIdOf,
    ports.listProjects,
    ports.listAgents,
    ports.communicationProjectionAllowed,
    ports.appendCommunicationProjection,
  );
  const projectDeletion = new AgentProjectDeletionAuthority(
    dataDir,
    db,
    client,
    ports.getProject,
    ports.listAgents,
    (projectId, agentIds) => {
      communicationJournal.clearProject(projectId);
      ports.clearCommunicationProjectionCache(projectId);
      for (const agentId of agentIds) eventProjection.forgetAgent(agentId);
    },
  );
  chatFeed = new AgentChatFeedProjection(
    db,
    client,
    ports.communicationIndex,
    ports.projectionIndex,
    ports.communicationProjectionAllowed,
    ports.readProjectedCommunicationMessages,
    ports.readProjectedCommunicationMessagePage,
    ports.materializeProjectedCommunicationMessages,
    ports.rowToAgentDto,
    ports.getAgent,
    ports.listAgents,
    ports.listProjects,
    ports.encodeHistoryCursor,
    ports.decodeHistoryCursor,
  );
  const agentManagement = new AgentManagementAuthority(
    dataDir,
    db,
    client,
    ports.getAgent,
    ports.listAgents,
    ports.getProject,
    ports.getConversation,
    ports.rowToAgentDto,
    projectId => chatFeed.refreshAllChatFeedProject(projectId),
  );
  const agentDeletion = new AgentDeletionAuthority(
    dataDir,
    db,
    client,
    ports.getAgent,
    ports.listAgents,
    ports.authorizeAgentManagementPlan,
    projectId => chatFeed.refreshAllChatFeedProject(projectId),
    agentId => eventProjection.forgetAgent(agentId),
  );
  communicationProjectionLedger = new AgentCommunicationProjectionLedger(
    dataDir,
    client,
    ports.getProject,
    ports.getConversation,
    ports.getAgent,
    ports.listAgents,
    ports.readEvents,
    projectId => communicationJournal.readCommunicationEvents(projectId),
    ports.communicationIndex,
    ports.communicationRevisionIndex,
    ports.projectionIndex,
    ports.messageDispatches,
    ports.ensureCommunicationBehaviorProjections,
    (projectId, projection) =>
      chatFeed.upsertGlobalChatSearchProjection(projectId, projection),
    ports.encodeHistoryCursor,
    ports.decodeHistoryCursor,
    (projectId, artifactIds, metadataAuthority) =>
      artifactCatalog.communicationAttachmentsForOperator(
        projectId,
        artifactIds,
        metadataAuthority,
      ),
  );
  const fileActivity = new AgentFileActivityReadModel(
    client,
    agentId => artifactCatalog.getArtifacts(agentId),
    (agentId, row) => artifactCatalog.artifactDtoFromProjectionRow(agentId, row),
  );
  const telemetry = new AgentTelemetryReadModel(
    client,
    ports.encodeHistoryCursor,
    ports.decodeHistoryCursor,
    (agentId, status, executionFilter) =>
      fileActivity.byExecution(agentId, status, executionFilter),
  );
  const phaseReadModel = new AgentPhaseReadModel(client);
  const runUsage = new AgentRunUsageReadModel(
    db,
    client,
    ports.encodeHistoryCursor,
    ports.decodeHistoryCursor,
    (projectId, eventId) =>
      ports.getCommunicationEvent(projectId, eventId)?.conversationId,
  );
  const conversationProjection = new AgentConversationProjectionReadModel(
    client,
    ports.getConversation,
    ports.messageDispatches,
    ports.readProjectedCommunicationMessages,
    ports.readProjectedCommunicationMessagePage,
    (projectId, eventId, surface, projectionKey) =>
      ports.projectionIndex(projectId).byTuple.get(
        `${eventId}\u0000${surface}\u0000${projectionKey}`,
      ),
    ports.materializeProjectedCommunicationMessages,
    agentId => Boolean(ports.getAgent(agentId)),
    ports.getRuns,
    (agentId, status, executionIds) =>
      fileActivity.byExecution(agentId, status, executionIds),
  );
  const projectionRebuilder = new AgentProjectionRebuilder(
    dataDir,
    db,
    client,
    artifactCatalog,
    agentCatalog,
    eventProjection,
    ports.recoverProjectDeletionDirectories,
    ports.recoverAgentDeletionDirectories,
    ports.sanitizeOrganizationProjection,
    () => chatFeed.rebuildGlobalChatSearchProjection(),
  );
  const auditReadModel = new AgentAuditReadModel(
    db,
    ports.projectIdOf,
    ports.getCommunicationEvent,
    ports.rowToAgentDto,
    ports.getRunOutputs,
    ports.getRunOutputPage,
    ports.getActivity,
    ports.getActivityPage,
    ports.getChangedFilePage,
    ports.getRuns,
    ports.getRunPage,
    ports.getFinalizedWorkDurationMs,
    ports.getWorkItems,
    ports.getWorkItemPage,
    ports.getArtifacts,
    ports.getArtifactPage,
  );

  return {
    phaseReadModel,
    telemetry,
    fileActivity,
    chatFeed,
    runUsage,
    artifactCatalog,
    eventSession,
    conversationProjection,
    communicationProjectionLedger,
    workspaceCatalog,
    agentCatalog,
    communicationJournal,
    agentManagement,
    projectDeletion,
    agentDeletion,
    projectionRebuilder,
    auditReadModel,
  };
}
