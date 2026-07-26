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
  writeFileSync,
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
  ArtifactKind,
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
import { communicationHasProjectionTarget, deriveCommunicationBehavior, unifiedDiffLineTotals } from "@ponderosa/core";
import { highlightedSearchSnippet, searchProjectedChatMessages, type ProjectedChatSearchCandidate } from "./chat-search.js";
import { healthObservation, utf8Prefix } from "./store-activity.js";
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
import { publishManagedArtifactContent, readManagedArtifactContent } from "./managed-artifact-files.js";
import type { LogEvent, StoredLogEvent } from "./log-event.js";
import {
  initProjectionState,
  projectAll,
  projectEvent,
  type ProjectionOp,
  type ProjectionState,
} from "./projectors.js";

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

export interface ContextReadBoundary {
  createdAt: string;
  id: string;
}

export interface ContextSourcePage<T> {
  items: T[];
  hasMore: boolean;
}

interface ActivityProjectionReadRow {
  seq: number;
  execution_id: string | null;
  event_json: string;
  created_at: string;
  output_preview_utf8_bytes: number | null;
  output_total_utf8_bytes: number | null;
  output_sha256: string | null;
}

interface RunOutputEventRow {
  seq: number;
  payload_json: string;
  created_at: string;
}

interface RunOutputSegmentRow {
  first_seq: number;
  last_seq: number;
  event_type: "text" | "reasoning";
  execution_id: string;
}

interface ArtifactProjectionReadRow {
  id: string;
  agent_id: string;
  execution_id: string | null;
  kind: string;
  path: string;
  summary: string | null;
  created_at: string;
  source_path: string | null;
  media_type: string | null;
  visibility: string | null;
  pinned: number | null;
  size: number | null;
}

const ACTIVITY_OUTPUT_PREVIEW_BYTES = 4_096;
const RUN_OUTPUT_TEXT_PREVIEW_BYTES = 32 * 1_024;
const RUN_OUTPUT_TEXT_MAX_BYTES = 8 * 1_024 * 1_024;
const ACTIVITY_EVENT_TYPES = new Set([
  "command", "file_change", "test_result", "tool_call", "tool_result", "error",
  "browser_session", "browser_action", "browser_console", "browser_screenshot",
  "context_rollover_triggered",
]);
const RUN_OUTPUT_BREAKING_TYPES = [
  "command", "tool_call", "tool_result", "file_change", "test_result", "error",
  "browser_session", "browser_action", "browser_console", "browser_screenshot",
  "context_rollover_triggered",
] as const;

import {
  artifactsDir,
  artifactContentPath,
  managedArtifactContentPath,
  managedArtifactsLogPath,
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

interface ProjectJson {
  id: string;
  label: string;
  hostPath: string;
  createdAt: string;
  lastUsedAt?: string;
  defaultEngine: string;
  defaultModel?: string;
  defaultEffort?: string;
  lastConversationId?: string;
  instructions?: string;
}

export interface ManagedArtifactAccess {
  ownerKind: "project" | "communication" | "request_update";
  ownerId: string;
  audience: CommunicationAudience | { kind: "request_agents"; agentIds: string[]; userId?: string };
  senderAgentId?: string;
}

type ManagedArtifactEvent =
  | { type: "created"; artifact: ArtifactDto & { projectId: string; originAgentId: string }; access?: ManagedArtifactAccess }
  | { type: "visibility"; artifactId: string; visibility: "project" | "published"; pinned: boolean; at: string }
  | { type: "deleted"; artifactId: string; at: string; reason: string };

interface AgentJson {
  id: string;
  projectId: string;
  conversationId?: string;
  conversationIds?: string[];
  title: string;
  activeEngine: string;
  model?: string;
  effort?: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  deletedAt?: string;
  managementPermissions?: AgentDto["managementPermissions"];
  spawnedByAgentId?: string;
  spawnedByExecutionId?: string;
  spawnPrompt?: string;
  spawnIdempotencyKey?: string;
  presetSnapshot?: AgentDto["presetSnapshot"];
}

export interface AgentSpawnOrigin {
  agentId: string;
  executionId: string;
  idempotencyKey: string;
  prompt?: string;
}

type PresetEvent = { type: "upsert"; preset: AgentPresetDto } | { type: "delete"; id: string; at: string };
const BUILTIN_PRESETS: Array<Omit<CreateAgentPresetRequest, "engine"> & { engine: "codex" }> = [
  { name: "Frontend", description: "Accessible, polished product UI", guidance: "Act as a product-minded frontend engineer. Prioritize responsive UX, accessibility, and tested user flows.", engine: "codex" },
  { name: "Security", description: "Threat-model and harden changes", guidance: "Act as a security reviewer. Preserve trust boundaries, minimize authority, and test abuse cases.", engine: "codex" },
  { name: "QA", description: "Find regressions and verify behavior", guidance: "Act as a QA engineer. Build a risk-based test plan, reproduce failures, and report evidence precisely.", engine: "codex" },
  { name: "Documentation", description: "Create clear, accurate documentation", guidance: "Act as a technical writer. Verify behavior in the code and write concise task-oriented documentation.", engine: "codex" },
];

interface ConversationJson {
  id: string;
  projectId: string;
  title: string;
  defaultEngine?: string;
  defaultModel?: string;
  defaultEffort?: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface ConversationDeliveryIntent {
  targetAgentId: string;
  relayDepth: number;
  mentionTrail: string[];
  kind: "direct" | "tag";
  /** The selector that authorized this recipient when the message was recorded. */
  audience?: "mention" | "everyone";
  /** Explicit behavior when the recipient has an active durable wait. */
  /** Target-owned staged assets delivered with this recipient turn. */
  attachmentIds?: string[];
}

interface MessageDispatchRecord {
  schemaVersion: 1;
  eventId: string;
  messageId: string;
  conversationId: string;
  channel: ConversationChannel;
  role: "user" | "assistant" | "system";
  renderedText: string;
  createdAt: string;
  authorAgentId?: string;
  deliveryIntents?: ConversationDeliveryIntent[];
  messageReceiptKey?: string;
  orderKey: string;
  attachments?: import("@ponderosa/core").ImageAttachmentDto[];
}

export interface AgentDeletionReceipt {
  id: string;
  projectId: string;
  previewHash: string;
  rootAgentIds: string[];
  deletedAgentIds: string[];
  storageCleanupCompleted: boolean;
  serverCleanupCompleted: boolean;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ProjectDeletionReceipt {
  projectId: string;
  tombstoneName: string;
  storageCleanupCompleted: boolean;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentManagementAuthorization {
  planId: string;
  projectId: string;
  conversationId: string;
  ownerAgentId: string;
  runId: string;
  scopeHash: string;
  permission: "deletion" | "reorganization";
  approvalDecisionId?: string;
}

export class AgentStore {
  private readonly db: Db;
  private readonly client: Database.Database;
  private readonly logs = new Map<string, EventLog>();
  private readonly states = new Map<string, ProjectionState>();
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

  private globalChatSearchRowKey(projection: Pick<CommunicationProjection, "eventId" | "surface" | "projectionKey">): string {
    return JSON.stringify([projection.surface, projection.projectionKey, projection.eventId]);
  }

  /** Increment one rebuildable search row from one bounded projection record. */
  private upsertGlobalChatSearchProjection(projectId: string, projection: CommunicationProjection): void {
    const rowKey = this.globalChatSearchRowKey(projection);
    const chatKind = projection.surface === "conversation"
      ? "conversation"
      : projection.surface === "collaboration_view"
        ? "collaboration"
      : projection.surface === "direct_agent_audit"
        ? "agent"
        : undefined;
    const message = projection.message;
    const event = this.communicationIndex(projectId).byId.get(projection.eventId);
    if (!chatKind || !message || !event || !this.communicationProjectionAllowed(projectId, projection)) {
      this.db.delete(chatSearchMessages).where(eq(chatSearchMessages.rowKey, rowKey)).run();
      this.refreshAllChatFeedEvent(projectId, projection.eventId);
      return;
    }
    const canonicalRole = event.sender.kind === "agent"
      ? "assistant"
      : event.sender.kind === "user"
        ? "user"
        : message.role;
    const authorAgentId = event.sender.kind === "agent" ? event.sender.agentId : message.authorAgentId;
    const behavior = deriveCommunicationBehavior(event);
    this.db.insert(chatSearchMessages).values({
      rowKey,
      projectId,
      chatKind,
      chatId: projection.projectionKey,
      messageId: message.messageId,
      communicationEventId: event.eventId,
      role: canonicalRole,
      authorAgentId: authorAgentId ?? null,
      timestamp: message.createdAt,
      orderKey: message.orderKey ?? message.createdAt,
      text: message.renderedText ?? event.text,
      conversationId: event.conversationId ?? null,
      communicationIntent: event.intent,
      senderKind: event.sender.kind,
      senderAgentId: event.sender.kind === "agent" ? event.sender.agentId : null,
      contextPolicy: behavior.contextPolicy,
    }).onConflictDoUpdate({
      target: chatSearchMessages.rowKey,
      set: {
        projectId,
        chatKind,
        chatId: projection.projectionKey,
        messageId: message.messageId,
        communicationEventId: event.eventId,
        role: canonicalRole,
        authorAgentId: authorAgentId ?? null,
        timestamp: message.createdAt,
        orderKey: message.orderKey ?? message.createdAt,
        text: message.renderedText ?? event.text,
        conversationId: event.conversationId ?? null,
        communicationIntent: event.intent,
        senderKind: event.sender.kind,
        senderAgentId: event.sender.kind === "agent" ? event.sender.agentId : null,
        contextPolicy: behavior.contextPolicy,
      },
    }).run();
    this.refreshAllChatFeedEvent(projectId, projection.eventId);
  }

  /** Choose one active placement for a canonical communication. This work is
   * paid when a placement/lifecycle event changes, never on each Messages read. */
  private refreshAllChatFeedEvent(projectId: string, eventId: string): void {
    const row = this.client.prepare(`
      SELECT search.row_key AS rowKey, search.order_key AS orderKey
      FROM chat_search_messages search
      LEFT JOIN conversations conversation
        ON search.chat_kind IN ('conversation', 'collaboration')
        AND conversation.id = search.chat_id AND conversation.archived = 0
      LEFT JOIN agents chat_agent
        ON search.chat_kind = 'agent'
        AND chat_agent.id = search.chat_id AND chat_agent.archived = 0
      WHERE search.project_id = ? AND search.communication_event_id = ?
        AND (conversation.id IS NOT NULL OR chat_agent.id IS NOT NULL)
      ORDER BY CASE search.chat_kind
        WHEN 'conversation' THEN 0
        WHEN 'collaboration' THEN 1
        ELSE CASE WHEN search.chat_id = search.author_agent_id THEN 2 ELSE 3 END
      END, search.chat_id, search.row_key
      LIMIT 1
    `).get(projectId, eventId) as { rowKey: string; orderKey: string } | undefined;
    if (!row) {
      this.client.prepare(`
        DELETE FROM all_chat_feed_projection
        WHERE project_id = ? AND communication_event_id = ?
      `).run(projectId, eventId);
      return;
    }
    this.client.prepare(`
      INSERT INTO all_chat_feed_projection(
        project_id, communication_event_id, row_key, order_key
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, communication_event_id) DO UPDATE SET
        row_key = excluded.row_key, order_key = excluded.order_key
    `).run(projectId, eventId, row.rowKey, row.orderKey);
  }

  private refreshAllChatFeedProject(projectId: string): void {
    const eventIds = this.client.prepare(`
      SELECT DISTINCT communication_event_id AS eventId
      FROM chat_search_messages WHERE project_id = ?
    `).all(projectId) as Array<{ eventId: string }>;
    for (const { eventId } of eventIds) this.refreshAllChatFeedEvent(projectId, eventId);
  }

  /** Rebuild the disposable global Chat search index from canonical ledgers. */
  private rebuildGlobalChatSearchProjection(): void {
    this.db.delete(chatSearchMessages).run();
    this.client.prepare(`DELETE FROM all_chat_feed_projection`).run();
    for (const project of this.listProjects()) {
      for (const projection of this.projectionIndex(project.id).projections) {
        this.upsertGlobalChatSearchProjection(project.id, projection);
      }
    }
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
    const event = this.communicationIndex(projectId).byId.get(projection.eventId);
    if (!event) throw new Error("communication projection source event not found");
    // Deleted rooms are hard context boundaries. Their retained append-only
    // records are historical storage only and may not materialize anywhere.
    if (event.conversationId && !this.getConversation(event.conversationId)) return false;
    const roomKeyAllowed = event.conversationId === projection.projectionKey && (() => {
      const room = this.getConversation(projection.projectionKey);
      return Boolean(room && room.projectId === projectId && !room.archived);
    })();
    const targetAllowed = communicationHasProjectionTarget(event, projection.surface, projection.projectionKey);
    if (targetAllowed) {
      if (projection.surface === "conversation" || projection.surface === "collaboration_view") return roomKeyAllowed;
      if (projection.surface === "direct_agent_audit" || projection.surface === "agent_inbox") {
        const agent = this.getAgent(projection.projectionKey);
        return Boolean(agent && agent.projectId === projectId && !agent.archived);
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
      if (!existing.message && projection.message) {
        const enriched = { ...projection, revision: (existing.revision ?? 1) + 1 };
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
      const sameMaterialization = existing.message && projection.message
        && existing.message.role === projection.message.role
        && (existing.message.renderedText ?? "") === (projection.message.renderedText ?? "");
      if (projection.message && JSON.stringify(existing.message) !== JSON.stringify(projection.message) && !sameMaterialization) {
        throw new Error("communication projection metadata collision");
      }
      // Delivery retries may create new runtime-local IDs and timestamps. Keep
      // the first placement when the visible role and text are identical.
      this.upsertGlobalChatSearchProjection(projectId, existing);
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

  private materializeProjectedCommunicationMessages(
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
          text: latestRevision ? revisedRenderedText(renderedText, event.text, latestRevision.text) : renderedText,
          createdAt: message.createdAt,
          ...(message.orderKey ? { orderKey: message.orderKey } : {}),
          ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
          ...(canonicalAuthorAgentId ? { authorAgentId: canonicalAuthorAgentId } : {}),
          ...(event.sender.kind === "agent" ? { executionId: event.sender.executionId } : {}),
          ...(event.correctionOfEventId ? { correctionOfEventId: event.correctionOfEventId } : {}),
          ...(latestRevision ? { editedAt: latestRevision.createdAt, editRevision: targetRevisions.length } : {}),
          ...(message.attachmentIds?.length ? { attachmentIds: message.attachmentIds } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          ...(!latestRevision && event.document ? { document: communicationDocumentReference(projectId, event.document) } : {}),
          ...(event.citations?.length ? { citations: event.citations } : {}),
        }];
      })
      .sort((a, b) => (a.orderKey ?? a.createdAt).localeCompare(b.orderKey ?? b.createdAt) || a.eventId.localeCompare(b.eventId));
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

  private ensureCommunicationProjectionLedger(projectId: string): void {
    const canonicalEvents = this.readCommunicationEvents(projectId);
    for (const event of canonicalEvents) this.ensureCommunicationBehaviorProjections(event);
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
        },
      };
      if (this.communicationProjectionAllowed(projectId, projection)) {
        this.appendCommunicationProjection(projectId, projection);
      }
    }
    for (const agent of this.listAgents(projectId)) {
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
  }

  /** Verify that canonical events and their projections agree. */
  reconcileCommunicationEvents(projectId: string): CommunicationReconciliationReport {
    const canonical = this.readCommunicationEvents(projectId).filter((event) =>
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
    const canonicalById = new Map(canonical.map((event) => [event.eventId, event]));
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
    const canonicalizeAudience = (value: Record<string, unknown>): Record<string, unknown> => {
      if (value.schemaVersion !== 2 || !value.audience || typeof value.audience !== "object") return value;
      const audience = value.audience as Record<string, unknown>;
      if (value.intent === "collaboration" && audience.kind === "agents" && Array.isArray(audience.agentIds)) {
        return { ...value, audience: { ...audience, agentIds: [...new Set(audience.agentIds)].sort() } };
      }
      if (value.intent === "user_dm" && audience.kind === "user_agents" && Array.isArray(audience.agentIds)) {
        return { ...value, audience: { ...audience, agentIds: [...new Set(audience.agentIds)].sort() } };
      }
      return value;
    };
    const digest = (value: Record<string, unknown>) => createHash("sha256")
      .update(JSON.stringify(stable(canonicalizeAudience(value))))
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
      .filter((eventId) => !canonicalIds.has(eventId));
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
      this.logs.delete(agentId);
      this.states.delete(agentId);
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
    if (next.archived !== (row.archived === 1)) this.refreshAllChatFeedProject(row.projectId);
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
    this.refreshAllChatFeedProject(row.projectId);
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
    const conversation = this.getConversation(conversationId);
    if (!conversation) return [];
    return this.messageDispatches(conversation.projectId)
      .filter((dispatch) => dispatch.conversationId === conversationId &&
        (!createdAtOrAfter || dispatch.createdAt >= createdAtOrAfter))
      .flatMap((dispatch) => (dispatch.deliveryIntents ?? []).map((intent) => ({
      // Dispatch records are durable before projections and contain the complete
      // immutable message snapshot. Reconstruct directly instead of repeatedly
      // scanning the projected room timeline once per recipient intent.
      message: {
        id: dispatch.messageId,
        communicationEventId: dispatch.eventId,
        conversationId: dispatch.conversationId,
        role: dispatch.role,
        text: dispatch.renderedText,
        createdAt: dispatch.createdAt,
        authorAgentId: dispatch.authorAgentId,
        attachments: dispatch.attachments,
      },
      intent,
      messageReceiptKey: dispatch.messageReceiptKey,
      deliveryOrderKey: dispatch.orderKey,
    })));
  }

  getConversationMessageByReceiptKey(conversationId: string, receiptKey: string): ConversationMessageDto | undefined {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return undefined;
    const dispatch = this.messageDispatches(conversation.projectId)
      .find((candidate) => candidate.conversationId === conversationId && candidate.messageReceiptKey === receiptKey);
    return dispatch
      ? this.getConversationMessages(conversationId, dispatch.channel).find((message) => message.id === dispatch.messageId)
      : undefined;
  }

  getConversationMessages(conversationId: string, channel: ConversationChannel = "main"): ConversationMessageDto[] {
    return this.getProjectedConversationMessages(conversationId, channel);
  }

  /**
   * Materialize a project-chat timeline from canonical communication events
   * and their projection ledger.
   */
  getProjectedConversationMessages(
    conversationId: string,
    channel: ConversationChannel = "main",
    limit?: number,
  ): ConversationMessageDto[] {
    const master = this.getConversation(conversationId);
    if (!master) return [];
    const surface = channel === "collaboration" ? "collaboration_view" : "conversation";
    const projected = this.readProjectedCommunicationMessages(master.projectId, surface, conversationId, limit);
    return this.projectedConversationMessageDtos(conversationId, projected, channel !== "collaboration");
  }

  /** Full canonical room history for provider context, without UI-only file-activity hydration. */
  getCanonicalConversationContextMessages(
    conversationId: string,
    channel: ConversationChannel = "main",
  ): ConversationMessageDto[] {
    const master = this.getConversation(conversationId);
    if (!master) return [];
    const surface = channel === "collaboration" ? "collaboration_view" : "conversation";
    const projected = this.readProjectedCommunicationMessages(master.projectId, surface, conversationId);
    return this.projectedConversationMessageDtos(conversationId, projected, false);
  }

  /** Newest canonical organizational messages for bounded provider/context
   * selection. The keyset is the public `(createdAt, stable message ID)` order,
   * independent of delivery timestamps used by the UI timeline. */
  getOrganizationalConversationContextSourcePage(
    conversationId: string,
    input: { limit: number; before?: ContextReadBoundary; excludeCommunicationEventId?: string },
  ): ContextSourcePage<ConversationMessageDto> {
    const master = this.getConversation(conversationId);
    if (!master) return { items: [], hasMore: false };
    const limit = Math.max(1, Math.min(input.limit, 100));
    const rows = this.client.prepare(`
      SELECT communication_event_id AS eventId, timestamp AS createdAt, message_id AS messageId
      FROM chat_search_messages
      WHERE project_id = ? AND chat_kind = 'conversation' AND chat_id = ?
        AND context_policy = 'organizational'
        ${input.excludeCommunicationEventId ? "AND communication_event_id <> ?" : ""}
        ${input.before ? "AND (timestamp < ? OR (timestamp = ? AND message_id < ?))" : ""}
      ORDER BY timestamp DESC, message_id DESC LIMIT ?
    `).all(...[
      master.projectId,
      conversationId,
      ...(input.excludeCommunicationEventId ? [input.excludeCommunicationEventId] : []),
      ...(input.before ? [input.before.createdAt, input.before.createdAt, input.before.id] : []),
      limit + 1,
    ]) as Array<{ eventId: string; createdAt: string; messageId: string }>;
    const selected = rows.slice(0, limit);
    const index = this.projectionIndex(master.projectId);
    const projected = selected.flatMap((row) => {
      const projection = index.byTuple.get(`${row.eventId}\u0000conversation\u0000${conversationId}`);
      return projection ? [projection] : [];
    });
    return {
      hasMore: rows.length > limit,
      items: this.projectedConversationMessageDtos(
        conversationId,
        this.materializeProjectedCommunicationMessages(master.projectId, projected),
        false,
      ).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)),
    };
  }

  /** FIFO organizational delta after one previously accepted delivery cursor.
   * The lookup and source page are both indexed; a missing cursor target is
   * reported so the caller can deliberately reseed instead of skipping work. */
  getOrganizationalConversationDeltaPage(
    conversationId: string,
    input: { limit: number; afterMessageId?: string; excludeCommunicationEventId?: string },
  ): ContextSourcePage<ConversationMessageDto> & { cursorFound: boolean; latestMessageId?: string } {
    const master = this.getConversation(conversationId);
    if (!master) return { items: [], hasMore: false, cursorFound: false };
    const limit = Math.max(1, Math.min(input.limit, 100));
    const cursor = input.afterMessageId ? this.client.prepare(`
      SELECT order_key AS orderKey, row_key AS rowKey FROM chat_search_messages
      WHERE project_id = ? AND chat_kind = 'conversation' AND chat_id = ?
        AND context_policy = 'organizational' AND message_id = ?
      LIMIT 1
    `).get(master.projectId, conversationId, input.afterMessageId) as { orderKey: string; rowKey: string } | undefined : undefined;
    if (input.afterMessageId && !cursor) return { items: [], hasMore: false, cursorFound: false };
    const latest = this.client.prepare(`
      SELECT message_id AS messageId FROM chat_search_messages
      WHERE project_id = ? AND chat_kind = 'conversation' AND chat_id = ?
        AND context_policy = 'organizational'
      ORDER BY order_key DESC, row_key DESC LIMIT 1
    `).get(master.projectId, conversationId) as { messageId: string } | undefined;
    const rows = this.client.prepare(`
      SELECT communication_event_id AS eventId
      FROM chat_search_messages
      WHERE project_id = ? AND chat_kind = 'conversation' AND chat_id = ?
        AND context_policy = 'organizational'
        ${input.excludeCommunicationEventId ? "AND communication_event_id <> ?" : ""}
        ${cursor ? "AND (order_key > ? OR (order_key = ? AND row_key > ?))" : ""}
      ORDER BY order_key, row_key LIMIT ?
    `).all(...[
      master.projectId,
      conversationId,
      ...(input.excludeCommunicationEventId ? [input.excludeCommunicationEventId] : []),
      ...(cursor ? [cursor.orderKey, cursor.orderKey, cursor.rowKey] : []),
      limit + 1,
    ]) as Array<{ eventId: string }>;
    const selected = rows.slice(0, limit);
    const index = this.projectionIndex(master.projectId);
    const projected = selected.flatMap((row) => {
      const projection = index.byTuple.get(`${row.eventId}\u0000conversation\u0000${conversationId}`);
      return projection ? [projection] : [];
    });
    return {
      cursorFound: true,
      hasMore: rows.length > limit,
      ...(latest ? { latestMessageId: latest.messageId } : {}),
      items: this.projectedConversationMessageDtos(
        conversationId,
        this.materializeProjectedCommunicationMessages(master.projectId, projected),
        false,
      ),
    };
  }

  getProjectedConversationMessagePage(
    conversationId: string,
    channel: ConversationChannel,
    input: { limit: number; cursor?: string; focusId?: string },
  ): { messages: ConversationMessageDto[]; hasMore: boolean; cursor?: string } {
    const master = this.getConversation(conversationId);
    if (!master) return { messages: [], hasMore: false };
    const surface = channel === "collaboration" ? "collaboration_view" : "conversation";
    const page = this.readProjectedCommunicationMessagePage(master.projectId, surface, conversationId, input);
    return {
      ...page,
      // Team Chat renders communication and operational state, not per-Run file
      // summaries. Hydrating every author's full file history made this page
      // scale with organization size rather than its bounded message window.
      messages: this.projectedConversationMessageDtos(conversationId, page.messages, channel !== "collaboration"),
    };
  }

  getProjectedConversationMessageById(
    conversationId: string,
    channel: ConversationChannel,
    id: string,
  ): ConversationMessageDto | undefined {
    const master = this.getConversation(conversationId);
    if (!master) return undefined;
    const chatKind = channel === "collaboration" ? "collaboration" : "conversation";
    const surface = channel === "collaboration" ? "collaboration_view" : "conversation";
    const row = this.client.prepare(`
      SELECT communication_event_id AS eventId FROM chat_search_messages
      WHERE project_id = ? AND chat_kind = ? AND chat_id = ?
        AND (message_id = ? OR communication_event_id = ?)
      ORDER BY order_key DESC, row_key DESC LIMIT 1
    `).get(master.projectId, chatKind, conversationId, id, id) as { eventId: string } | undefined;
    if (!row) return undefined;
    const projection = this.projectionIndex(master.projectId).byTuple.get(
      `${row.eventId}\u0000${surface}\u0000${conversationId}`,
    );
    if (!projection) return undefined;
    return this.projectedConversationMessageDtos(
      conversationId,
      this.materializeProjectedCommunicationMessages(master.projectId, [projection]),
    )[0];
  }

  private projectedConversationMessageDtos(
    conversationId: string,
    projected: ProjectedCommunicationMessage[],
    includeFileActivity = true,
  ): ConversationMessageDto[] {
    const correctedBy = new Map(projected.flatMap((message) => message.correctionOfEventId ? [[message.correctionOfEventId, message.messageId] as const] : []));
    const runsByAgent = new Map<string, AgentRunDto[]>();
    const statusByAgentExecution = new Map<string, ResponseFileActivityDto["status"]>();
    const executionScopeByAgentAndStatus = new Map<string, {
      agentId: string;
      status: ResponseFileActivityDto["status"];
      executionIds: Set<string>;
    }>();
    if (includeFileActivity) for (const message of projected) {
      if (!message.authorAgentId || !message.executionId || !this.getAgent(message.authorAgentId)) continue;
      const runs = runsByAgent.get(message.authorAgentId) ?? this.getRuns(message.authorAgentId);
      runsByAgent.set(message.authorAgentId, runs);
      const status: ResponseFileActivityDto["status"] = runs.some((run) =>
        run.id === message.executionId && (run.status === "running" || run.status === "compacting")
      ) ? "in_progress" : "completed";
      const agentExecutionKey = `${message.authorAgentId}\0${message.executionId}`;
      statusByAgentExecution.set(agentExecutionKey, status);
      const scopeKey = `${message.authorAgentId}:${status}`;
      const scope = executionScopeByAgentAndStatus.get(scopeKey) ?? {
        agentId: message.authorAgentId,
        status,
        executionIds: new Set<string>(),
      };
      scope.executionIds.add(message.executionId);
      executionScopeByAgentAndStatus.set(scopeKey, scope);
    }
    const activityByAgentAndStatus = new Map(
      [...executionScopeByAgentAndStatus].map(([scopeKey, scope]) => [
        scopeKey,
        this.responseFileActivityByExecution(scope.agentId, scope.status, scope.executionIds),
      ] as const),
    );
    return projected.map((message) => {
      let fileActivity: ResponseFileActivityDto[] | undefined;
      if (includeFileActivity && message.authorAgentId && message.executionId) {
        const status = statusByAgentExecution.get(`${message.authorAgentId}\0${message.executionId}`);
        if (status) {
          const cacheKey = `${message.authorAgentId}:${status}`;
          fileActivity = activityByAgentAndStatus.get(cacheKey)?.get(message.executionId);
        }
      }
      return {
        id: message.messageId,
        communicationEventId: message.eventId,
        conversationId,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        canonicalOrderKey: message.orderKey ?? message.createdAt,
        ...(message.authorAgentId ? { authorAgentId: message.authorAgentId } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        ...(message.document ? { document: message.document } : {}),
        ...(message.citations?.length ? { citations: message.citations } : {}),
        ...(message.executionId ? { executionId: message.executionId } : {}),
        ...(fileActivity?.length ? { fileActivity } : {}),
        ...(message.correctionOfEventId ? { correctionOfMessageId: message.correctionOfEventId } : {}),
        ...(correctedBy.has(message.eventId) ? { correctedByMessageId: correctedBy.get(message.eventId) } : {}),
        ...(message.editedAt ? { editedAt: message.editedAt, editRevision: message.editRevision } : {}),
      };
    });
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
    if (archived !== (row.archived === 1)) this.refreshAllChatFeedProject(row.projectId);
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
    this.refreshAllChatFeedProject(committedPreview!.projectId);
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
      this.logs.delete(agentId);
      this.states.delete(agentId);
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
    const row = this.client.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN completed_at IS NOT NULL AND completed_at >= started_at
            THEN CAST(ROUND((julianday(completed_at) - julianday(started_at)) * 86400000) AS INTEGER)
          ELSE 0
        END
      ), 0) AS durationMs
      FROM runs
      WHERE agent_id = ?
    `).get(agentId) as { durationMs: number };
    return Math.max(0, Number(row.durationMs) || 0);
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

  private runOutputSegmentRows(
    agentId: string,
    input?: { beforeSeq?: number; endingAtSeq?: number; limit?: number },
  ): RunOutputSegmentRow[] {
    const breakingTypes = RUN_OUTPUT_BREAKING_TYPES.map((type) => `'${type}'`).join(", ");
    const limit = input?.limit === undefined ? "" : "LIMIT ?";
    const rows = this.client.prepare(`
      WITH visible AS (
        SELECT seq, type, payload_json,
          json_extract(payload_json, '$.executionId') AS execution_id
        FROM events
        WHERE agent_id = ?
          AND type IN ('text', 'reasoning', ${breakingTypes})
      ),
      annotated AS (
        SELECT *,
          lag(type) OVER (ORDER BY seq) AS previous_type,
          lag(execution_id) OVER (ORDER BY seq) AS previous_execution_id
        FROM visible
      ),
      marked AS (
        SELECT *,
          CASE
            WHEN type IN ('text', 'reasoning')
              AND type = previous_type
              AND execution_id IS previous_execution_id
            THEN 0
            WHEN type IN ('text', 'reasoning') THEN 1
            ELSE 0
          END AS starts_segment
        FROM annotated
      ),
      grouped AS (
        SELECT *,
          sum(starts_segment) OVER (ORDER BY seq) AS segment_number
        FROM marked
      ),
      segments AS (
        SELECT
          min(seq) AS first_seq,
          max(seq) AS last_seq,
          min(type) AS event_type,
          min(execution_id) AS execution_id
        FROM grouped
        WHERE type IN ('text', 'reasoning') AND execution_id IS NOT NULL
        GROUP BY segment_number
      )
      SELECT first_seq, last_seq, event_type, execution_id
      FROM segments
      WHERE 1 = 1
        ${input?.beforeSeq === undefined ? "" : "AND first_seq < ?"}
        ${input?.endingAtSeq === undefined ? "" : "AND first_seq <= ?"}
      ORDER BY first_seq DESC
      ${limit}
    `);
    const parameters: Array<string | number> = [agentId];
    if (input?.beforeSeq !== undefined) parameters.push(input.beforeSeq);
    if (input?.endingAtSeq !== undefined) parameters.push(input.endingAtSeq);
    if (input?.limit !== undefined) parameters.push(input.limit);
    return rows.all(...parameters) as RunOutputSegmentRow[];
  }

  private materializeRunOutputSegments(
    agentId: string,
    segmentRows: RunOutputSegmentRow[],
  ): RunOutputDto[] {
    if (segmentRows.length === 0) return [];
    const orderedSegments = [...segmentRows].sort((a, b) => a.first_seq - b.first_seq);
    const eventRows = this.client.prepare(`
      SELECT seq, payload_json, created_at
      FROM events
      WHERE agent_id = ? AND type IN ('text', 'reasoning')
        AND seq BETWEEN ? AND ?
      ORDER BY seq
    `);
    const byStart = new Map<number, RunOutputDto>();
    for (const segment of orderedSegments) {
      const previewParts: string[] = [];
      let previewUtf8Bytes = 0;
      let rawUtf8Bytes = 0;
      let canonicalUtf8Bytes = 0;
      let createdAt = "";
      for (const row of eventRows.iterate(
        agentId,
        segment.first_seq,
        segment.last_seq,
      ) as IterableIterator<RunOutputEventRow>) {
        const event = JSON.parse(row.payload_json) as LogEvent;
        if ((event.type === "text" || event.type === "reasoning") &&
            event.executionId === segment.execution_id) {
          createdAt ||= row.created_at;
          const deltaUtf8Bytes = Buffer.byteLength(event.delta, "utf8");
          const trimmedDelta = event.delta.trimEnd();
          if (trimmedDelta) {
            canonicalUtf8Bytes = rawUtf8Bytes + Buffer.byteLength(trimmedDelta, "utf8");
          }
          rawUtf8Bytes += deltaUtf8Bytes;
          if (previewUtf8Bytes < RUN_OUTPUT_TEXT_PREVIEW_BYTES) {
            const part = utf8Prefix(
              event.delta,
              RUN_OUTPUT_TEXT_PREVIEW_BYTES - previewUtf8Bytes,
            );
            previewParts.push(part);
            previewUtf8Bytes += Buffer.byteLength(part, "utf8");
          }
        }
      }
      if (canonicalUtf8Bytes === 0) continue;
      const preview = previewParts.join("");
      const text = canonicalUtf8Bytes <= previewUtf8Bytes
        ? utf8Prefix(preview, canonicalUtf8Bytes).trimEnd()
        : preview;
      previewUtf8Bytes = Buffer.byteLength(text, "utf8");
      byStart.set(segment.first_seq, {
        id: `${agentId}:runOutput:${segment.first_seq}`,
        agentId,
        executionId: segment.execution_id,
        kind: segment.event_type === "reasoning" ? "reasoning" : "response",
        text,
        completed: true,
        seq: segment.first_seq,
        sourceSeqStart: segment.first_seq,
        sourceSeqEnd: segment.last_seq,
        createdAt,
        ...(previewUtf8Bytes < canonicalUtf8Bytes ? {
          textPreview: {
            truncated: true,
            previewUtf8Bytes,
            totalUtf8Bytes: canonicalUtf8Bytes,
            retrievalUrl: `/api/agents/${encodeURIComponent(agentId)}/run-output/${segment.first_seq}/text`,
          },
        } : {}),
      });
    }
    const items = [...byStart.values()];
    const executionIds = new Set(items.map((item) => item.executionId));
    const fileActivityByExecution = this.responseFileActivityByExecution(
      agentId,
      "completed",
      executionIds,
    );
    const lastResponseByExecution = new Map<string, number>();
    for (const segment of this.runOutputSegmentRows(agentId)) {
      if (segment.event_type !== "text" || lastResponseByExecution.has(segment.execution_id)) continue;
      lastResponseByExecution.set(segment.execution_id, segment.first_seq);
    }
    return items.map((item) => {
      if (item.kind !== "response" || lastResponseByExecution.get(item.executionId) !== item.seq) return item;
      const fileActivity = fileActivityByExecution.get(item.executionId) ?? [];
      return fileActivity.length ? { ...item, fileActivity } : item;
    });
  }

  /** Durable response/reasoning segments interleaved by canonical event sequence. */
  getRunOutputs(agentId: string): RunOutputDto[] {
    return this.materializeRunOutputSegments(agentId, this.runOutputSegmentRows(agentId));
  }

  private eventSeqBoundary(cursor: string | undefined, stream: string, agentId: string): number | undefined {
    if (!cursor) return undefined;
    const decoded = this.decodeHistoryCursor(cursor, stream, agentId);
    const seq = Number(decoded.orderKey);
    if (!Number.isSafeInteger(seq) || seq < 1 || decoded.rowKey !== String(seq)) throw new Error("invalid history cursor");
    return seq;
  }

  private eventSeqFocus(focusId: string | undefined, stream: "runOutput" | "activity", agentId: string): number | undefined {
    if (!focusId) return undefined;
    const prefix = `${agentId}:${stream}:`;
    if (!focusId.startsWith(prefix)) throw new Error("invalid history focus");
    const seq = Number(focusId.slice(prefix.length));
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("invalid history focus");
    return seq;
  }

  getRunOutputPage(
    agentId: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ): HistoryPageDto<RunOutputDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    if (input.cursor && input.focusId) throw new Error("history cursor and focus cannot be combined");
    const focusSeq = this.eventSeqFocus(input.focusId, "runOutput", agentId);
    const boundary = this.eventSeqBoundary(input.cursor, "agent:runOutput", agentId);
    let endingAtSeq: number | undefined;
    if (focusSeq !== undefined) {
      const allSegments = this.runOutputSegmentRows(agentId);
      let containing = allSegments.find(
        (segment) => segment.first_seq <= focusSeq && segment.last_seq >= focusSeq,
      );
      if (!containing) {
        const legacy = this.client.prepare(`
          SELECT payload_json FROM events
          WHERE agent_id = ? AND seq = ? AND type = 'agent_output'
        `).get(agentId, focusSeq) as { payload_json: string } | undefined;
        if (legacy) {
          const event = JSON.parse(legacy.payload_json) as LogEvent;
          if (event.type === "agent_output") {
            containing = allSegments.find(
              (segment) => segment.first_seq <= event.sourceSeqEnd &&
                segment.last_seq >= event.sourceSeqEnd,
            );
          }
        }
      }
      if (!containing) return { items: [], history: { limit, hasMore: false } };
      endingAtSeq = containing.first_seq;
    }
    const rows = this.runOutputSegmentRows(agentId, {
      ...(boundary !== undefined ? { beforeSeq: boundary } : {}),
      ...(endingAtSeq !== undefined ? { endingAtSeq } : {}),
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = this.materializeRunOutputSegments(agentId, selected);
    const oldest = selected.at(-1);
    return {
      items,
      history: {
        limit,
        hasMore,
        ...(hasMore && oldest ? {
          cursor: this.encodeHistoryCursor({
            stream: "agent:runOutput", scope: agentId,
            orderKey: String(oldest.first_seq), rowKey: String(oldest.first_seq),
          }),
        } : {}),
      },
    };
  }

  getRunOutputText(agentId: string, seq: number): {
    agentId: string;
    runOutputId: string;
    seq: number;
    text: string;
    totalUtf8Bytes: number;
  } | undefined {
    const segment = this.runOutputSegmentRows(agentId).find((row) => row.first_seq === seq);
    if (!segment) return undefined;
    const item = this.materializeRunOutputSegments(agentId, [segment])[0];
    if (!item) return undefined;
    const boundedTotal = item.textPreview?.totalUtf8Bytes ?? Buffer.byteLength(item.text, "utf8");
    if (boundedTotal > RUN_OUTPUT_TEXT_MAX_BYTES) {
      throw new RangeError("run output segment exceeds the 8 MiB retrieval limit");
    }
    const rows = this.client.prepare(`
      SELECT payload_json
      FROM events
      WHERE agent_id = ? AND type IN ('text', 'reasoning')
        AND seq BETWEEN ? AND ?
      ORDER BY seq
    `).all(agentId, segment.first_seq, segment.last_seq) as Array<{ payload_json: string }>;
    const text = rows.flatMap((row) => {
      const event = JSON.parse(row.payload_json) as LogEvent;
      return (event.type === "text" || event.type === "reasoning") &&
        event.executionId === segment.execution_id ? [event.delta] : [];
    }).join("").trimEnd();
    const totalUtf8Bytes = Buffer.byteLength(text, "utf8");
    return {
      agentId,
      runOutputId: `${agentId}:runOutput:${seq}`,
      seq,
      text,
      totalUtf8Bytes,
    };
  }

  /** Execution activity is rebuilt from canonical log events, never from live-only UI state. */
  getActivity(agentId: string): AgentActivityDto[] {
    const rows = this.client.prepare(`
      SELECT seq, execution_id, event_json, created_at, output_preview_utf8_bytes,
        output_total_utf8_bytes, output_sha256
      FROM activity_projection WHERE agent_id = ? ORDER BY seq
    `).all(agentId) as ActivityProjectionReadRow[];
    return rows.map((row) => this.activityDtoFromProjectionRow(agentId, row));
  }

  private activityDtoFromProjectionRow(agentId: string, row: ActivityProjectionReadRow): AgentActivityDto {
    const event = JSON.parse(row.event_json) as AgentActivityDto["event"];
    const base: AgentActivityDto = {
      id: `${agentId}:activity:${row.seq}`,
      agentId,
      ...(row.execution_id ? { executionId: row.execution_id } : {}),
      seq: row.seq,
      createdAt: row.created_at,
      event,
    };
    if (event.type !== "tool_result" || row.output_total_utf8_bytes === null ||
        row.output_preview_utf8_bytes === null || !row.output_sha256 ||
        row.output_preview_utf8_bytes >= row.output_total_utf8_bytes) return base;
    return {
      ...base,
      outputPreview: {
        truncated: true,
        previewUtf8Bytes: row.output_preview_utf8_bytes,
        totalUtf8Bytes: row.output_total_utf8_bytes,
        sha256: row.output_sha256,
        retrievalUrl: `/api/agents/${encodeURIComponent(agentId)}/activity/${row.seq}/output`,
      },
    };
  }

  getActivityPage(
    agentId: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ): HistoryPageDto<AgentActivityDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    if (input.cursor && input.focusId) throw new Error("history cursor and focus cannot be combined");
    const focusSeq = this.eventSeqFocus(input.focusId, "activity", agentId);
    const boundary = focusSeq ?? this.eventSeqBoundary(input.cursor, "agent:activity", agentId);
    const rows = this.client.prepare(`
      SELECT seq, execution_id, event_json, created_at, output_preview_utf8_bytes,
        output_total_utf8_bytes, output_sha256
      FROM activity_projection
      WHERE agent_id = ?
        ${boundary === undefined ? "" : `AND seq ${focusSeq === undefined ? "<" : "<="} ?`}
      ORDER BY seq DESC LIMIT ?
    `).all(...(boundary === undefined ? [agentId, limit + 1] : [agentId, boundary, limit + 1])) as ActivityProjectionReadRow[];
    if (focusSeq !== undefined && rows[0]?.seq !== focusSeq) {
      return { items: [], history: { limit, hasMore: false } };
    }
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected.map((row) => this.activityDtoFromProjectionRow(agentId, row)).reverse();
    const oldest = selected.at(-1);
    return {
      items,
      history: {
        limit,
        hasMore,
        ...(hasMore && oldest ? {
          cursor: this.encodeHistoryCursor({
            stream: "agent:activity", scope: agentId,
            orderKey: String(oldest.seq), rowKey: String(oldest.seq),
          }),
        } : {}),
      },
    };
  }

  getActivityOutput(agentId: string, seq: number): {
    agentId: string;
    activityId: string;
    seq: number;
    output: string;
    totalUtf8Bytes: number;
    sha256: string;
  } | undefined {
    const row = this.client.prepare(`
      SELECT output, total_utf8_bytes, sha256
      FROM tool_output_projection WHERE agent_id = ? AND seq = ?
    `).get(agentId, seq) as { output: Buffer; total_utf8_bytes: number; sha256: string } | undefined;
    if (!row) return undefined;
    return {
      agentId,
      activityId: `${agentId}:activity:${seq}`,
      seq,
      output: Buffer.isBuffer(row.output) ? row.output.toString("utf8") : String(row.output),
      totalUtf8Bytes: row.total_utf8_bytes,
      sha256: row.sha256,
    };
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
    const row = this.client.prepare(`
      SELECT substr(output, ?, ?) AS page, total_utf8_bytes, sha256
      FROM tool_output_projection WHERE agent_id = ? AND seq = ?
    `).get(startUtf8Byte + 1, maxBytes + 3, agentId, seq) as {
      page: Buffer; total_utf8_bytes: number; sha256: string;
    } | undefined;
    if (!row) return undefined;
    if (!Number.isSafeInteger(startUtf8Byte) || startUtf8Byte < 0 || startUtf8Byte > row.total_utf8_bytes) {
      throw new Error("activity output cursor is outside the retained output");
    }
    const bytes = Buffer.isBuffer(row.page) ? row.page : Buffer.from(row.page);
    let pageBytes = Math.min(maxBytes, bytes.length);
    // The cursor is always emitted on a code-point boundary. Pulling three
    // lookahead bytes lets this page retreat from a split UTF-8 sequence while
    // still returning the largest valid prefix within maxBytes.
    while (pageBytes > 0) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, pageBytes));
        break;
      } catch {
        pageBytes -= 1;
      }
    }
    return {
      agentId,
      activityId: `${agentId}:activity:${seq}`,
      seq,
      output: bytes.subarray(0, pageBytes).toString("utf8"),
      pageUtf8Bytes: pageBytes,
      totalUtf8Bytes: row.total_utf8_bytes,
      sha256: row.sha256,
    };
  }

  /** Bounded newest-first keyset over one row per touched path. */
  getChangedFilePage(
    agentId: string,
    input: { limit: number; cursor?: string },
  ): HistoryPageDto<ChangedFileDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    const boundary = input.cursor
      ? this.decodeHistoryCursor(input.cursor, "agent:changedFiles", agentId)
      : undefined;
    const boundarySeq = boundary ? Number(boundary.orderKey) : undefined;
    if (boundary && (!Number.isSafeInteger(boundarySeq) || boundarySeq! < 1)) throw new Error("invalid history cursor");
    const rows = this.client.prepare(`
      SELECT path, kind, last_seq, last_changed_at, execution_count, diff IS NOT NULL AS diff_available
      FROM changed_file_projection
      WHERE agent_id = ?
        ${boundary ? "AND (last_seq < ? OR (last_seq = ? AND path < ?))" : ""}
      ORDER BY last_seq DESC, path DESC
      LIMIT ?
    `).all(...(boundary
      ? [agentId, boundarySeq, boundarySeq, boundary.rowKey, limit + 1]
      : [agentId, limit + 1])) as Array<{
      path: string; kind: ChangedFileDto["kind"]; last_seq: number; last_changed_at: string;
      execution_count: number; diff_available: number;
    }>;
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const oldest = selected.at(-1);
    return {
      items: selected.map((row) => ({
        path: row.path,
        kind: row.kind,
        lastSeq: row.last_seq,
        lastChangedAt: row.last_changed_at,
        executionCount: row.execution_count,
        diffAvailable: row.diff_available === 1,
      })),
      history: {
        limit,
        hasMore,
        ...(hasMore && oldest ? { cursor: this.encodeHistoryCursor({
          stream: "agent:changedFiles", scope: agentId,
          orderKey: String(oldest.last_seq), rowKey: oldest.path,
        }) } : {}),
      },
    };
  }

  getChangedFileDetail(agentId: string, path: string): ChangedFileDetailDto | undefined {
    const row = this.client.prepare(`
      SELECT path, kind, last_seq, last_changed_at, execution_ids_json, execution_count, diff
      FROM changed_file_projection WHERE agent_id = ? AND path = ?
    `).get(agentId, path) as {
      path: string; kind: ChangedFileDto["kind"]; last_seq: number; last_changed_at: string;
      execution_ids_json: string; execution_count: number; diff: string | null;
    } | undefined;
    if (!row) return undefined;
    const executionIds = JSON.parse(row.execution_ids_json) as string[];
    return {
      path: row.path,
      kind: row.kind,
      lastSeq: row.last_seq,
      lastChangedAt: row.last_changed_at,
      executionCount: row.execution_count,
      diffAvailable: row.diff !== null,
      executionIds,
      provenanceTruncated: executionIds.length < row.execution_count,
      ...(row.diff ? { diff: row.diff } : {}),
    };
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
    return this.responseFileActivityByExecution(agentId, status).get(executionId) ?? [];
  }

  private responseFileActivityByExecution(
    agentId: string,
    status: ResponseFileActivityDto["status"],
    executionFilter?: ReadonlySet<string>,
  ): Map<string, ResponseFileActivityDto[]> {
    const scopedArtifacts = executionFilter
      ? executionFilter.size ? (this.client.prepare(`
          SELECT id, agent_id, execution_id, kind, path, summary, created_at,
            source_path, media_type, visibility, pinned, size
          FROM artifacts WHERE agent_id = ? AND execution_id IN (${[...executionFilter].map(() => "?").join(", ")})
          ORDER BY created_at, id
        `).all(agentId, ...executionFilter) as ArtifactProjectionReadRow[]).flatMap((row) => {
          const artifact = this.artifactDtoFromProjectionRow(agentId, row);
          return artifact ? [artifact] : [];
        })
        : []
      : this.getArtifacts(agentId);
    const artifactById = new Map(scopedArtifacts.map((artifact) => [artifact.id, artifact] as const));
    const generatedByExecutionAndPath = new Map(scopedArtifacts.flatMap((artifact) =>
      artifact.kind === "generated_file" && artifact.executionId && artifact.sourcePath
        ? [[`${artifact.executionId}\0${artifact.sourcePath}`, artifact] as const]
        : []));
    const byExecution = new Map<string, Map<string, ResponseFileActivityDto>>();
    const activity = executionFilter
      ? executionFilter.size ? (this.client.prepare(`
          SELECT seq, execution_id, event_json, created_at, output_preview_utf8_bytes,
            output_total_utf8_bytes, output_sha256
          FROM activity_projection
          WHERE agent_id = ? AND event_type = 'file_change'
            AND execution_id IN (${[...executionFilter].map(() => "?").join(", ")})
          ORDER BY seq
        `).all(agentId, ...executionFilter) as ActivityProjectionReadRow[])
          .map((row) => this.activityDtoFromProjectionRow(agentId, row))
        : []
      : this.getActivity(agentId);
    for (const item of activity) {
      if (!item.executionId || item.event.type !== "file_change") continue;
      if (executionFilter && !executionFilter.has(item.executionId)) continue;
      const projectedArtifactId = artifactId(agentId, item.seq, 0);
      const artifact = generatedByExecutionAndPath.get(`${item.executionId}\0${item.event.path}`)
        ?? artifactById.get(projectedArtifactId);
      const totals = unifiedDiffLineTotals(item.event.diff);
      const byPath = byExecution.get(item.executionId) ?? new Map<string, ResponseFileActivityDto>();
      byPath.set(item.event.path, {
        path: item.event.path,
        kind: item.event.kind,
        status,
        sourceSeq: item.seq,
        ...(artifact ? { artifactId: artifact.id, artifactKind: artifact.kind } : {}),
        previewable: Boolean(item.event.diff && artifact?.kind === "diff"),
        ...(totals ? totals : {}),
      });
      byExecution.set(item.executionId, byPath);
    }
    return new Map([...byExecution].map(([executionId, byPath]) => [
      executionId,
      [...byPath.values()].sort((a, b) => a.sourceSeq - b.sourceSeq),
    ]));
  }

  getProjectedAgentMessages(agentId: string, limit?: number): MessageDto[] {
    const agent = this.rowToAgentDto(agentId);
    if (!agent) return [];
    const projected = this.readProjectedCommunicationMessages(agent.projectId, "direct_agent_audit", agentId, limit);
    return this.projectedAgentMessageDtos(agentId, projected);
  }

  getProjectedAgentMessagePage(
    agentId: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ): { messages: MessageDto[]; hasMore: boolean; cursor?: string } {
    const agent = this.rowToAgentDto(agentId);
    if (!agent) return { messages: [], hasMore: false };
    const page = this.readProjectedCommunicationMessagePage(agent.projectId, "direct_agent_audit", agentId, input);
    return { ...page, messages: this.projectedAgentMessageDtos(agentId, page.messages) };
  }

  getProjectedAgentMessageById(agentId: string, id: string): MessageDto | undefined {
    const agent = this.rowToAgentDto(agentId);
    if (!agent) return undefined;
    const row = this.client.prepare(`
      SELECT communication_event_id AS eventId FROM chat_search_messages
      WHERE project_id = ? AND chat_kind = 'agent' AND chat_id = ?
        AND (message_id = ? OR communication_event_id = ?)
      ORDER BY order_key DESC, row_key DESC LIMIT 1
    `).get(agent.projectId, agentId, id, id) as { eventId: string } | undefined;
    if (!row) return undefined;
    const projection = this.projectionIndex(agent.projectId).byTuple.get(
      `${row.eventId}\u0000direct_agent_audit\u0000${agentId}`,
    );
    if (!projection) return undefined;
    return this.projectedAgentMessageDtos(
      agentId,
      this.materializeProjectedCommunicationMessages(agent.projectId, [projection]),
    )[0];
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
    const agent = this.getAgent(agentId);
    if (!agent) return { items: [], hasMore: false };
    const limit = Math.max(1, Math.min(input.limit, 100));
    const read = (intentPredicate: string, extra: unknown[] = []) => this.client.prepare(`
        SELECT communication_event_id AS eventId, timestamp AS createdAt, message_id AS messageId
        FROM chat_search_messages
        WHERE project_id = ? AND chat_kind = 'agent' AND chat_id = ?
          AND ${input.conversationId ? "conversation_id = ?" : "conversation_id IS NULL"}
          AND ${intentPredicate}
          ${input.excludeCommunicationEventId ? "AND communication_event_id <> ?" : ""}
          ${input.before ? "AND (timestamp < ? OR (timestamp = ? AND message_id < ?))" : ""}
        ORDER BY timestamp DESC, message_id DESC LIMIT ?
      `).all(...[
        agent.projectId,
        agentId,
        ...(input.conversationId ? [input.conversationId] : []),
        ...extra,
        ...(input.excludeCommunicationEventId ? [input.excludeCommunicationEventId] : []),
        ...(input.before ? [input.before.createdAt, input.before.createdAt, input.before.id] : []),
        limit + 1,
      ]) as Array<{ eventId: string; createdAt: string; messageId: string }>;
    const privateRows = read("communication_intent IN ('user_dm', 'collaboration')");
    const authoredBroadcastRows = input.includeAuthoredBroadcasts
      ? read("communication_intent = 'broadcast' AND sender_agent_id = ?", [agentId])
      : [];
    const rows = [...privateRows, ...authoredBroadcastRows]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.messageId.localeCompare(left.messageId));
    const selected = rows.slice(0, limit);
    const index = this.projectionIndex(agent.projectId);
    const projected = selected.flatMap((row) => {
      const projection = index.byTuple.get(`${row.eventId}\u0000direct_agent_audit\u0000${agentId}`);
      return projection ? [projection] : [];
    });
    return {
      hasMore: privateRows.length > limit || authoredBroadcastRows.length > limit || rows.length > limit,
      items: this.projectedAgentMessageDtos(
        agentId,
        this.materializeProjectedCommunicationMessages(agent.projectId, projected),
      ).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)),
    };
  }

  private projectedAgentMessageDtos(agentId: string, projected: ProjectedCommunicationMessage[]): MessageDto[] {
    return projected
      .flatMap((message) => {
        if (message.sequence === undefined || message.role === "system") return [];
        return [{
          id: message.messageId,
          communicationEventId: message.eventId,
          ...(message.conversationId ? { conversationId: message.conversationId } : {}),
          agentId,
          seq: message.sequence,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
          ...(message.authorAgentId ? { authorAgentId: message.authorAgentId } : {}),
          ...(message.executionId ? { executionId: message.executionId } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          ...(message.document ? { document: message.document } : {}),
          ...(message.citations?.length ? { citations: message.citations } : {}),
        } satisfies MessageDto];
      });
  }

  /**
   * Bounded global search over rebuildable human-facing communication views.
   * Project chat is preferred when one canonical message is visible on both a
   * Project chat and an Agent audit timeline, avoiding duplicate search hits.
   */
  searchGlobalChats(input: {
    query?: string;
    limit?: number;
    recentLimit?: number;
    maxScannedMessages?: number;
    notifications?: Array<{ conversationId?: string; communicationEventId?: string; readAt?: string }>;
  } = {}): GlobalChatSearchResponseDto {
    const query = (input.query ?? "").trim();
    const limit = Math.max(1, Math.min(50, input.limit ?? 30));
    const recentLimit = Math.max(1, Math.min(20, input.recentLimit ?? 10));
    const maxScannedMessages = Math.max(limit, Math.min(20_000, input.maxScannedMessages ?? 10_000));
    const unreadNotifications = (input.notifications ?? []).filter((notification) => !notification.readAt);
    const unreadEventIds = new Set(unreadNotifications.flatMap((notification) =>
      notification.communicationEventId ? [notification.communicationEventId] : []));
    const unreadConversationCounts = new Map<string, number>();
    for (const notification of unreadNotifications) {
      if (!notification.conversationId) continue;
      unreadConversationCounts.set(notification.conversationId, (unreadConversationCounts.get(notification.conversationId) ?? 0) + 1);
    }

    type SearchProjectionRow = {
      projectId: string;
      projectLabel: string;
      chatKind: "conversation" | "agent";
      chatId: string;
      chatTitle: string;
      messageId: string;
      communicationEventId: string;
      role: "user" | "assistant" | "system";
      authorAgentId: string | null;
      authorTitle: string | null;
      timestamp: string;
      text: string;
    };
    // LIMIT is applied by SQLite while walking idx_chat_search_newest. The one
    // extra row is only a truncation sentinel; it never reaches result DTOs.
    const rows = this.client.prepare(`
      SELECT
        search.project_id AS projectId,
        project.label AS projectLabel,
        search.chat_kind AS chatKind,
        search.chat_id AS chatId,
        COALESCE(conversation.title, chat_agent.title) AS chatTitle,
        search.message_id AS messageId,
        search.communication_event_id AS communicationEventId,
        search.role AS role,
        search.author_agent_id AS authorAgentId,
        author_agent.title AS authorTitle,
        search.timestamp AS timestamp,
        search.text AS text
      FROM chat_search_messages search
      JOIN projects project ON project.id = search.project_id
      LEFT JOIN conversations conversation
        ON search.chat_kind = 'conversation' AND conversation.id = search.chat_id AND conversation.archived = 0
      LEFT JOIN agents chat_agent
        ON search.chat_kind = 'agent' AND chat_agent.id = search.chat_id AND chat_agent.archived = 0
      LEFT JOIN agents author_agent ON author_agent.id = search.author_agent_id
      WHERE (conversation.id IS NOT NULL OR chat_agent.id IS NOT NULL)
        AND NOT (
          search.chat_kind = 'agent' AND EXISTS (
            SELECT 1
            FROM chat_search_messages preferred
            JOIN conversations preferred_conversation
              ON preferred_conversation.id = preferred.chat_id AND preferred_conversation.archived = 0
            WHERE preferred.project_id = search.project_id
              AND preferred.communication_event_id = search.communication_event_id
              AND preferred.chat_kind = 'conversation'
          )
        )
      ORDER BY search.timestamp DESC, search.chat_kind DESC, search.row_key DESC
      LIMIT ?
    `).all(maxScannedMessages + 1) as SearchProjectionRow[];
    const candidates: ProjectedChatSearchCandidate[] = rows.map((row) => {
      const author: GlobalChatSearchAuthorDto = row.authorAgentId
        ? { kind: "agent", label: row.authorTitle ?? "Agent", agentId: row.authorAgentId }
        : row.role === "user"
          ? { kind: "user", label: "User" }
          : row.role === "system"
            ? { kind: "system", label: "System" }
            : { kind: "agent", label: "Agent" };
      return {
        project: { id: row.projectId, label: row.projectLabel },
        chat: { kind: row.chatKind, id: row.chatId, title: row.chatTitle },
        messageId: row.messageId,
        communicationEventId: row.communicationEventId,
        author,
        timestamp: row.timestamp,
        text: row.text,
        unread: unreadEventIds.has(row.communicationEventId),
      };
    });

    const searched = searchProjectedChatMessages(candidates, { query, limit, maxScannedMessages });
    const recentChats: GlobalChatSearchResponseDto["recentChats"] = [];
    const recentKeys = new Set<string>();
    const unreadAgentCounts = new Map<string, number>();
    for (const candidate of candidates.slice(0, maxScannedMessages)) {
      if (candidate.chat.kind === "agent" && candidate.unread) {
        unreadAgentCounts.set(candidate.chat.id, (unreadAgentCounts.get(candidate.chat.id) ?? 0) + 1);
      }
    }
    for (const candidate of candidates.slice(0, maxScannedMessages)) {
      const key = `${candidate.project.id}\u0000${candidate.chat.kind}\u0000${candidate.chat.id}`;
      if (recentKeys.has(key)) continue;
      recentKeys.add(key);
      recentChats.push({
        project: candidate.project,
        chat: candidate.chat,
        lastActivityAt: candidate.timestamp,
        ...(candidate.text ? { snippet: highlightedSearchSnippet(candidate.text, "").snippet } : {}),
        unreadCount: candidate.chat.kind === "conversation"
          ? unreadConversationCounts.get(candidate.chat.id) ?? 0
          : unreadAgentCounts.get(candidate.chat.id) ?? 0,
      });
      if (recentChats.length >= recentLimit) break;
    }
    if (!query) {
      const emptyConversationCandidates = this.client.prepare(`
        SELECT
          conversation.id AS chatId,
          conversation.title AS chatTitle,
          conversation.project_id AS projectId,
          project.label AS projectLabel,
          conversation.updated_at AS updatedAt
        FROM conversations conversation
        JOIN projects project ON project.id = conversation.project_id
        WHERE conversation.archived = 0
        ORDER BY conversation.updated_at DESC, conversation.id DESC
        LIMIT ?
      `).all(recentLimit) as Array<{
        chatId: string;
        chatTitle: string;
        projectId: string;
        projectLabel: string;
        updatedAt: string;
      }>;
      for (const conversation of emptyConversationCandidates) {
        const key = `${conversation.projectId}\u0000conversation\u0000${conversation.chatId}`;
        if (recentKeys.has(key)) continue;
        recentKeys.add(key);
        recentChats.push({
          project: { id: conversation.projectId, label: conversation.projectLabel },
          chat: { kind: "conversation", id: conversation.chatId, title: conversation.chatTitle },
          lastActivityAt: conversation.updatedAt,
          unreadCount: unreadConversationCounts.get(conversation.chatId) ?? 0,
        });
      }
      recentChats.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
      recentChats.splice(recentLimit);
    }
    return {
      ...searched,
      recentChats: query ? [] : recentChats,
    };
  }

  /**
   * Read one deduplicated, workspace-wide page of authored communication.
   * Project and Team placements are preferred over their duplicate Agent audit
   * projections. The rebuildable index supplies only bounded placement keys;
   * text is rematerialized from the canonical Communication ledger so edits are
   * reflected without making SQLite authoritative.
   */
  getAllChatPage(input: { limit?: number; cursor?: string } = {}): AllChatPageDto {
    const limit = Math.max(1, Math.min(100, input.limit ?? 50));
    const boundary = input.cursor
      ? this.decodeHistoryCursor(input.cursor, "all-chat", "workspace")
      : undefined;
    type AllChatRow = {
      rowKey: string;
      projectId: string;
      projectLabel: string;
      chatKind: "conversation" | "collaboration" | "agent";
      chatId: string;
      chatTitle: string;
      messageId: string;
      eventId: string;
      role: "user" | "assistant" | "system";
      authorAgentId: string | null;
      authorTitle: string | null;
      orderKey: string;
    };
    const rows = this.client.prepare(`
      SELECT
        search.row_key AS rowKey,
        search.project_id AS projectId,
        project.label AS projectLabel,
        search.chat_kind AS chatKind,
        search.chat_id AS chatId,
        COALESCE(conversation.title, chat_agent.title) AS chatTitle,
        search.message_id AS messageId,
        search.communication_event_id AS eventId,
        search.role AS role,
        search.author_agent_id AS authorAgentId,
        author_agent.title AS authorTitle,
        feed.order_key AS orderKey
      FROM all_chat_feed_projection feed
      JOIN chat_search_messages search ON search.row_key = feed.row_key
      JOIN projects project ON project.id = search.project_id
      LEFT JOIN conversations conversation
        ON search.chat_kind IN ('conversation', 'collaboration') AND conversation.id = search.chat_id
      LEFT JOIN agents chat_agent ON search.chat_kind = 'agent' AND chat_agent.id = search.chat_id
      LEFT JOIN agents author_agent ON author_agent.id = search.author_agent_id
      WHERE 1 = 1
        AND search.communication_intent IN ('broadcast', 'direct_to_user', 'user_dm')
        ${boundary ? "AND (feed.order_key < ? OR (feed.order_key = ? AND feed.row_key < ?))" : ""}
      ORDER BY feed.order_key DESC, feed.row_key DESC
      LIMIT ?
    `).all(...(boundary
      ? [boundary.orderKey, boundary.orderKey, boundary.rowKey, limit + 1]
      : [limit + 1])) as AllChatRow[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const activeAgentByProject = new Map([...new Set(selected.map((row) => row.projectId))].map((projectId) => [
      projectId,
      new Map(this.listAgents(projectId).filter((agent) => !agent.archived).map((agent) => [agent.id, agent] as const)),
    ]));
    const items = selected.flatMap((row): AllChatItemDto[] => {
      const surface: CommunicationProjection["surface"] = row.chatKind === "conversation"
        ? "conversation"
        : row.chatKind === "collaboration"
          ? "collaboration_view"
          : "direct_agent_audit";
      const projection = this.projectionIndex(row.projectId).byTuple.get(
        `${row.eventId}\u0000${surface}\u0000${row.chatId}`,
      );
      const message = projection
        ? this.materializeProjectedCommunicationMessages(row.projectId, [projection])[0]
        : undefined;
      const event = this.communicationIndex(row.projectId).byId.get(row.eventId);
      if (!message || !event) return [];
      const exactAudienceAgentId = event.schemaVersion === 2 && event.intent === "user_dm"
        ? event.audience.kind === "user_agent"
          ? event.audience.agentId
          : event.audience.agentIds.length === 1 ? event.audience.agentIds[0] : undefined
        : undefined;
      const targetAgentId = row.chatKind === "agent"
        ? row.chatId
        : row.authorAgentId ?? exactAudienceAgentId;
      const directMessageAgent = targetAgentId
        ? activeAgentByProject.get(row.projectId)?.get(targetAgentId)
        : undefined;
      const author: GlobalChatSearchAuthorDto = row.authorAgentId
        ? { kind: "agent", label: row.authorTitle ?? "Agent", agentId: row.authorAgentId }
        : row.role === "user"
          ? { kind: "user", label: "User" }
          : row.role === "system"
            ? { kind: "system", label: "System" }
            : { kind: "agent", label: "Agent" };
      const source: AllChatItemDto["source"] = row.chatKind === "conversation"
        ? { kind: "project", conversationId: row.chatId, title: row.chatTitle }
        : row.chatKind === "collaboration"
          ? { kind: "team", conversationId: row.chatId, title: row.chatTitle }
          : { kind: "agent", agentId: row.chatId, title: row.chatTitle };
      return [{
        communicationEventId: row.eventId,
        messageId: message.messageId,
        project: { id: row.projectId, label: row.projectLabel },
        source,
        author,
        text: message.text,
        createdAt: message.createdAt,
        ...(directMessageAgent ? {
          directMessageAgent: { id: directMessageAgent.id, title: directMessageAgent.title },
        } : {}),
      }];
    }).reverse();
    const oldest = selected.at(-1);
    return {
      items,
      history: {
        limit,
        hasMore,
        ...(hasMore && oldest ? {
          cursor: this.encodeHistoryCursor({
            stream: "all-chat", scope: "workspace", orderKey: oldest.orderKey, rowKey: oldest.rowKey,
          }),
        } : {}),
      },
    };
  }

  private runActivityCounts(agentId: string): Map<string, NonNullable<AgentRunDto["activityCounts"]>> {
    const rows = this.client.prepare(`
      SELECT execution_id, event_type,
        CASE
          WHEN event_type = 'file_change'
          THEN COUNT(DISTINCT json_extract(event_json, '$.path'))
          ELSE COUNT(*)
        END AS n
      FROM activity_projection
      WHERE agent_id = ? AND execution_id IS NOT NULL
        AND event_type IN ('command', 'tool_call', 'file_change', 'error')
      GROUP BY execution_id, event_type
    `).all(agentId) as Array<{ execution_id: string; event_type: string; n: number }>;
    const counts = new Map<string, NonNullable<AgentRunDto["activityCounts"]>>();
    for (const row of rows) {
      const current = counts.get(row.execution_id) ?? {
        commands: 0,
        tools: 0,
        files: 0,
        errors: 0,
      };
      if (row.event_type === "command") current.commands = row.n;
      else if (row.event_type === "tool_call") current.tools = row.n;
      else if (row.event_type === "file_change") current.files = row.n;
      else if (row.event_type === "error") current.errors = row.n;
      counts.set(row.execution_id, current);
    }
    return counts;
  }

  getRuns(agentId: string): AgentRunDto[] {
    const activityCounts = this.runActivityCounts(agentId);
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.agentId, agentId))
      .orderBy(asc(runs.startedAt))
      .all()
      .map((r) => {
        const providerInput = this.client.prepare(`
          SELECT prompt_hash, source_manifest_json FROM provider_inputs WHERE execution_id = ? AND agent_id = ?
        `).get(r.id, agentId) as { prompt_hash: string; source_manifest_json: string } | undefined;
        return ({
        id: r.id,
        agentId: r.agentId,
        title: r.title,
        status: r.status as AgentRunStatus,
        reason: r.reason as AgentLifecycleReason,
        engine: r.engine,
        model: r.model ?? undefined,
        effort: r.effort ?? undefined,
        communicationEventId: r.communicationEventId ?? undefined,
        wakeCause: r.wakeCause as AgentRunDto["wakeCause"] ?? undefined,
        ...([r.inputTokens, r.cachedInputTokens, r.cacheWriteInputTokens, r.outputTokens, r.reasoningOutputTokens, r.totalTokens].some((value) => value !== null)
          ? { usage: {
              ...(r.inputTokens !== null ? { inputTokens: r.inputTokens } : {}),
              ...(r.cachedInputTokens !== null ? { cachedInputTokens: r.cachedInputTokens } : {}),
              ...(r.cacheWriteInputTokens !== null ? { cacheWriteInputTokens: r.cacheWriteInputTokens } : {}),
              ...(r.outputTokens !== null ? { outputTokens: r.outputTokens } : {}),
              ...(r.reasoningOutputTokens !== null ? { reasoningOutputTokens: r.reasoningOutputTokens } : {}),
              ...(r.totalTokens !== null ? { totalTokens: r.totalTokens } : {}),
            } }
          : {}),
        startedAt: r.startedAt,
        updatedAt: r.updatedAt,
        completedAt: r.completedAt ?? undefined,
        ...(activityCounts.get(r.id) ? { activityCounts: activityCounts.get(r.id) } : {}),
        ...(providerInput ? { providerInput: {
          promptHash: providerInput.prompt_hash,
          sourceManifest: JSON.parse(providerInput.source_manifest_json) as ProviderInputSourceManifest,
          exactPromptAvailable: true as const,
        } } : {}),
      });
      });
  }

  getRunPage(agentId: string, input: { limit: number; cursor?: string; focusId?: string }): HistoryPageDto<AgentRunDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    if (input.cursor && input.focusId) throw new Error("history cursor and focus cannot be combined");
    const focusId = input.focusId;
    const focusBoundary = focusId ? this.client.prepare(`
      SELECT started_at AS orderKey, id AS rowKey FROM runs WHERE agent_id = ? AND id = ?
    `).get(agentId, focusId) as { orderKey: string; rowKey: string } | undefined : undefined;
    if (focusId && !focusBoundary) return { items: [], history: { limit, hasMore: false } };
    const boundary = focusBoundary ?? (input.cursor ? this.decodeHistoryCursor(input.cursor, "agent:runs", agentId) : undefined);
    const rows = this.client.prepare(`
      SELECT id, agent_id, title, status, reason, engine, model, effort, communication_event_id, wake_cause,
        input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
        started_at, updated_at, completed_at
      FROM runs
      WHERE agent_id = ?
        ${boundary ? `AND (started_at < ? OR (started_at = ? AND id ${focusBoundary ? "<=" : "<"} ?))` : ""}
      ORDER BY started_at DESC, id DESC LIMIT ?
    `).all(...(boundary
      ? [agentId, boundary.orderKey, boundary.orderKey, boundary.rowKey, limit + 1]
      : [agentId, limit + 1])) as Array<{
      id: string; agent_id: string; title: string; status: string; reason: string; engine: AgentRunDto["engine"];
      model: string | null; effort: string | null; communication_event_id: string | null; wake_cause: string | null;
      input_tokens: number | null; cached_input_tokens: number | null; cache_write_input_tokens: number | null;
      output_tokens: number | null; reasoning_output_tokens: number | null; total_tokens: number | null;
      started_at: string; updated_at: string; completed_at: string | null;
    }>;
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const activityCounts = this.runActivityCounts(agentId);
    const items = selected.map((row): AgentRunDto => {
      const providerInput = this.client.prepare(`
        SELECT prompt_hash, source_manifest_json FROM provider_inputs WHERE execution_id = ? AND agent_id = ?
      `).get(row.id, agentId) as { prompt_hash: string; source_manifest_json: string } | undefined;
      return {
        id: row.id, agentId: row.agent_id, title: row.title,
        status: row.status as AgentRunStatus, reason: row.reason as AgentLifecycleReason,
        engine: row.engine,
        ...(row.model ? { model: row.model } : {}),
        ...(row.effort ? { effort: row.effort } : {}),
        ...(row.communication_event_id ? { communicationEventId: row.communication_event_id } : {}),
        ...(row.wake_cause ? { wakeCause: row.wake_cause as AgentRunDto["wakeCause"] } : {}),
        ...([row.input_tokens, row.cached_input_tokens, row.cache_write_input_tokens, row.output_tokens, row.reasoning_output_tokens, row.total_tokens].some((value) => value !== null)
          ? { usage: {
              ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
              ...(row.cached_input_tokens !== null ? { cachedInputTokens: row.cached_input_tokens } : {}),
              ...(row.cache_write_input_tokens !== null ? { cacheWriteInputTokens: row.cache_write_input_tokens } : {}),
              ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
              ...(row.reasoning_output_tokens !== null ? { reasoningOutputTokens: row.reasoning_output_tokens } : {}),
              ...(row.total_tokens !== null ? { totalTokens: row.total_tokens } : {}),
            } }
          : {}),
        startedAt: row.started_at, updatedAt: row.updated_at,
        ...(row.completed_at ? { completedAt: row.completed_at } : {}),
        ...(activityCounts.get(row.id) ? { activityCounts: activityCounts.get(row.id) } : {}),
        ...(providerInput ? { providerInput: {
          promptHash: providerInput.prompt_hash,
          sourceManifest: JSON.parse(providerInput.source_manifest_json) as ProviderInputSourceManifest,
          exactPromptAvailable: true as const,
        } } : {}),
      };
    }).reverse();
    const oldest = selected.at(-1);
    return {
      items,
      history: {
        limit, hasMore,
        ...(hasMore && oldest ? { cursor: this.encodeHistoryCursor({
          stream: "agent:runs", scope: agentId, orderKey: oldest.started_at, rowKey: oldest.id,
        }) } : {}),
      },
    };
  }

  getProviderInput(executionId: string, includeExactPrompt = false): ProviderInputDto | undefined {
    const row = this.client.prepare(`
      SELECT execution_id, scheduler_run_id, provider_prompt, prompt_hash,
        source_manifest_json, created_at, updated_at
      FROM provider_inputs WHERE execution_id = ?
    `).get(executionId) as {
      execution_id: string; scheduler_run_id: string; provider_prompt: string; prompt_hash: string;
      source_manifest_json: string; created_at: string; updated_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      executionId: row.execution_id,
      schedulerRunId: row.scheduler_run_id,
      promptHash: row.prompt_hash,
      sourceManifest: JSON.parse(row.source_manifest_json) as ProviderInputSourceManifest,
      ...(includeExactPrompt ? { exactPrompt: row.provider_prompt } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getTokenUsage(
    scope: { type: "overall" } | { type: "project" | "agent"; id: string },
    range: TokenUsageRangeDto = {},
  ): TokenUsageSummaryDto {
    const rows = this.getUsageRows(scope, range);
    const finalizedRuns = rows.length;
    const reportedRuns = rows.filter((row) => row.totalTokens !== undefined).length;
    const providerRequests = rows.reduce((total, row) => {
      if (!row.providerRequestUsageJson) return total;
      try {
        const parsed = JSON.parse(row.providerRequestUsageJson) as unknown;
        return total + (Array.isArray(parsed) ? parsed.length : 0);
      } catch { return total; }
    }, 0);
    const durationMs = rows.reduce((total, row) => {
      if (!row.completedAt) return total;
      return total + Math.max(0, new Date(row.completedAt).getTime() - new Date(row.startedAt).getTime());
    }, 0);
    const keys: TokenUsageMetric[] = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
    const totals: TokenUsage = {};
    const metricAvailability = Object.fromEntries(keys.map((key) => [key, rows.some((row) => row.usage[key] !== undefined) ? "available" : "unavailable"])) as Record<TokenUsageMetric, "available" | "unavailable">;
    for (const row of rows) {
      for (const key of keys) {
        const value = row.usage[key];
        if (value !== undefined) totals[key] = (totals[key] ?? 0) + value;
      }
    }
    const grouped = new Map<string, TokenUsageBreakdownDto>();
    const wakeCauses = this.exactWakeCauses(rows.map((row) => row.executionId));
    for (const row of rows.filter((item) => item.totalTokens !== undefined)) {
      const key = [row.projectId, row.conversationId ?? "", row.agentId, row.engine, row.model ?? ""].join("\0");
      const current = grouped.get(key) ?? {
        projectId: row.projectId,
        ...(row.conversationId ? { conversationId: row.conversationId } : {}),
        agentId: row.agentId,
        agentTitle: row.agentTitle,
        engine: row.engine as TokenUsageBreakdownDto["engine"],
        ...(row.model ? { model: row.model } : {}),
        runs: 0,
        usage: {},
      };
      current.runs += 1;
      for (const keyName of keys) {
        const value = row.usage[keyName];
        if (value !== undefined) current.usage[keyName] = (current.usage[keyName] ?? 0) + value;
      }
      grouped.set(key, current);
    }
    return {
      scope: scope.type,
      ...(scope.type !== "overall" ? { scopeId: scope.id } : {}),
      ...totals,
      finalizedRuns,
      reportedRuns,
      unreportedRuns: finalizedRuns - reportedRuns,
      providerRequests,
      durationMs,
      coverage: finalizedRuns ? reportedRuns / finalizedRuns : null,
      ...(range.from || range.to ? { range } : {}),
      metricAvailability,
      breakdown: [...grouped.values()].sort((a, b) => b.runs - a.runs || a.agentTitle.localeCompare(b.agentTitle)),
      wakeCauses,
      recentTurns: rows
        .filter((row) => row.totalTokens !== undefined)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 10)
        .map((row) => ({
          projectId: row.projectId,
          ...(row.conversationId ? { conversationId: row.conversationId } : {}),
          agentId: row.agentId,
          agentTitle: row.agentTitle,
          executionId: row.executionId,
          engine: row.engine as TokenUsageBreakdownDto["engine"],
          ...(row.model ? { model: row.model } : {}),
          startedAt: row.startedAt,
          ...(row.completedAt ? { completedAt: row.completedAt } : {}),
          usage: row.usage,
        })),
    };
  }

  /** Metered canonical runs used by the server's adapter-owned pricing projection. */
  getMeteredRuns(scope: { type: "overall" } | { type: "project" | "agent"; id: string }, range: TokenUsageRangeDto = {}): Array<{
    projectId: string; conversationId?: string; agentId: string; agentTitle: string; executionId: string; engine: string; model?: string;
    startedAt: string; completedAt?: string; usage: NonNullable<AgentRunDto["usage"]>; providerRequestUsage?: TokenUsage[];
  }> {
    return this.getUsageRows(scope, range).filter((row) => row.totalTokens !== undefined).map((row) => {
      let providerRequestUsage: TokenUsage[] | undefined;
      if (row.providerRequestUsageJson) {
        try {
          const parsed = JSON.parse(row.providerRequestUsageJson) as unknown;
          if (Array.isArray(parsed)) providerRequestUsage = parsed as TokenUsage[];
        } catch {
          // A malformed rebuildable projection must not make the usage API fail.
        }
      }
      return {
        projectId: row.projectId,
        ...(row.conversationId ? { conversationId: row.conversationId } : {}),
        agentId: row.agentId,
        agentTitle: row.agentTitle,
        executionId: row.executionId,
        engine: row.engine,
        model: row.model ?? undefined,
        startedAt: row.startedAt,
        ...(row.completedAt ? { completedAt: row.completedAt } : {}),
        usage: row.usage,
        ...(providerRequestUsage ? { providerRequestUsage } : {}),
      };
    });
  }

  private getUsageRows(
    scope: { type: "overall" } | { type: "project" | "agent"; id: string },
    range: TokenUsageRangeDto,
  ): Array<{
    projectId: string; conversationId: string | null; agentId: string; agentTitle: string; executionId: string; engine: string; model: string | undefined;
    startedAt: string; completedAt: string | undefined; totalTokens: number | undefined; usage: TokenUsage; providerRequestUsageJson: string | null;
  }> {
    const predicates = ["runs.status IN ('cancelled', 'completed', 'failed', 'interrupted')"];
    const params: string[] = [];
    if (scope.type === "project") { predicates.push("agents.project_id = ?"); params.push(scope.id); }
    if (scope.type === "agent") { predicates.push("runs.agent_id = ?"); params.push(scope.id); }
    if (range.from) { predicates.push("COALESCE(runs.completed_at, runs.started_at) >= ?"); params.push(range.from); }
    if (range.to) { predicates.push("COALESCE(runs.completed_at, runs.started_at) < ?"); params.push(range.to); }
    const rows = this.client.prepare(`
      SELECT runs.id AS execution_id, runs.agent_id, agents.project_id, agents.conversation_id, agents.title AS agent_title,
        runs.communication_event_id, runs.engine, runs.model, runs.started_at, runs.completed_at, runs.input_tokens, runs.cached_input_tokens,
        runs.cache_write_input_tokens, runs.output_tokens, runs.reasoning_output_tokens, runs.total_tokens,
        runs.provider_request_usage_json
      FROM runs JOIN agents ON agents.id = runs.agent_id
      WHERE ${predicates.join(" AND ")}
    `).all(...params) as Array<{
      execution_id: string; agent_id: string; project_id: string; conversation_id: string | null; agent_title: string;
      communication_event_id: string | null; engine: string; model: string | null; started_at: string; completed_at: string | null;
      input_tokens: number | null; cached_input_tokens: number | null; cache_write_input_tokens: number | null; output_tokens: number | null;
      reasoning_output_tokens: number | null; total_tokens: number | null; provider_request_usage_json: string | null;
    }>;
    return rows.map((row) => ({
      projectId: row.project_id,
      // Prefer the immutable communication's room over mutable current
      // membership so historical usage remains scoped to its original chat.
      conversationId: row.communication_event_id
        ? this.getCommunicationEvent(row.project_id, row.communication_event_id)?.conversationId ?? row.conversation_id
        : row.conversation_id,
      agentId: row.agent_id,
      agentTitle: row.agent_title,
      executionId: row.execution_id,
      engine: row.engine,
      model: row.model ?? undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      totalTokens: row.total_tokens ?? undefined,
      usage: {
        ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
        ...(row.cached_input_tokens !== null ? { cachedInputTokens: row.cached_input_tokens } : {}),
        ...(row.cache_write_input_tokens !== null ? { cacheWriteInputTokens: row.cache_write_input_tokens } : {}),
        ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
        ...(row.reasoning_output_tokens !== null ? { reasoningOutputTokens: row.reasoning_output_tokens } : {}),
        ...(row.total_tokens !== null ? { totalTokens: row.total_tokens } : {}),
      },
      providerRequestUsageJson: row.provider_request_usage_json,
    }));
  }

  private exactWakeCauses(executionIds: string[]): TokenUsageSummaryDto["wakeCauses"] {
    const uniqueIds = [...new Set(executionIds)];
    const causedRunIds = new Set<string>();
    const aggregates = new Map<string, { runs: Set<string>; activations: number }>();
    for (let offset = 0; offset < uniqueIds.length; offset += 400) {
      const page = uniqueIds.slice(offset, offset + 400);
      if (!page.length) continue;
      const attached = this.client.prepare(`
        SELECT attached.run_id, activation.kind
        FROM scheduler_run_activations attached
        JOIN agent_activations activation ON activation.id = attached.activation_id
        WHERE attached.run_id IN (${page.map(() => "?").join(",")})
        ORDER BY attached.run_id, activation.kind, activation.id
      `).all(...page) as Array<{ run_id: string; kind: string }>;
      for (const row of attached) {
        causedRunIds.add(row.run_id);
        const aggregate = aggregates.get(row.kind) ?? { runs: new Set<string>(), activations: 0 };
        aggregate.runs.add(row.run_id);
        aggregate.activations += 1;
        aggregates.set(row.kind, aggregate);
      }
    }
    const otherRuns = uniqueIds.filter((id) => !causedRunIds.has(id)).length;
    const result = [...aggregates.entries()].map(([cause, aggregate]) => ({
      cause,
      runs: aggregate.runs.size,
      activations: aggregate.activations,
    }));
    if (otherRuns) result.push({ cause: "other", runs: otherRuns, activations: otherRuns });
    return result.sort((left, right) => right.runs - left.runs || right.activations - left.activations || left.cause.localeCompare(right.cause));
  }

  getWorkItems(agentId: string): WorkItemDto[] {
    return this.db
      .select()
      .from(workItems)
      .where(eq(workItems.agentId, agentId))
      .orderBy(asc(workItems.createdAt))
      .all()
      .map((r) => ({
        id: r.id,
        agentId: r.agentId,
        executionId: r.executionId ?? undefined,
        title: r.title,
        status: r.status as WorkItemStatus,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
  }

  getWorkItemPage(agentId: string, input: { limit: number; cursor?: string; focusId?: string }): HistoryPageDto<WorkItemDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    if (input.cursor && input.focusId) throw new Error("history cursor and focus cannot be combined");
    const focusId = input.focusId;
    const focusBoundary = focusId ? this.client.prepare(`
      SELECT created_at AS orderKey, id AS rowKey FROM work_items WHERE agent_id = ? AND id = ?
    `).get(agentId, focusId) as { orderKey: string; rowKey: string } | undefined : undefined;
    if (focusId && !focusBoundary) return { items: [], history: { limit, hasMore: false } };
    const boundary = focusBoundary ?? (input.cursor ? this.decodeHistoryCursor(input.cursor, "agent:workItems", agentId) : undefined);
    const rows = this.client.prepare(`
      SELECT id, agent_id, execution_id, title, status, created_at, updated_at
      FROM work_items
      WHERE agent_id = ?
        ${boundary ? `AND (created_at < ? OR (created_at = ? AND id ${focusBoundary ? "<=" : "<"} ?))` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...(boundary
      ? [agentId, boundary.orderKey, boundary.orderKey, boundary.rowKey, limit + 1]
      : [agentId, limit + 1])) as Array<{
      id: string; agent_id: string; execution_id: string | null; title: string; status: string;
      created_at: string; updated_at: string;
    }>;
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected.map((row): WorkItemDto => ({
      id: row.id, agentId: row.agent_id,
      ...(row.execution_id ? { executionId: row.execution_id } : {}),
      title: row.title, status: row.status as WorkItemStatus,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })).reverse();
    const oldest = selected.at(-1);
    return {
      items,
      history: {
        limit, hasMore,
        ...(hasMore && oldest ? { cursor: this.encodeHistoryCursor({
          stream: "agent:workItems", scope: agentId, orderKey: oldest.created_at, rowKey: oldest.id,
        }) } : {}),
      },
    };
  }

  getArtifacts(agentId: string): ArtifactDto[] {
    const rows = this.client.prepare(`
      SELECT id, agent_id, execution_id, kind, path, summary, created_at,
        source_path, media_type, visibility, pinned, size
      FROM artifacts WHERE agent_id = ? ORDER BY created_at, id
    `).all(agentId) as ArtifactProjectionReadRow[];
    return rows.flatMap((row) => {
      const artifact = this.artifactDtoFromProjectionRow(agentId, row);
      return artifact ? [artifact] : [];
    });
  }

  private artifactDtoFromProjectionRow(agentId: string, row: ArtifactProjectionReadRow): ArtifactDto | undefined {
    const agent = this.rowToAgentDto(agentId);
    if (!agent) return undefined;
    if (row.kind === "generated_file" && row.source_path && row.media_type && row.size !== null) {
      const root = `/api/projects/${encodeURIComponent(agent.projectId)}/agents/${encodeURIComponent(agentId)}/generated-artifacts/${encodeURIComponent(row.id)}`;
      return {
        id: row.id, agentId: row.agent_id, executionId: row.execution_id ?? undefined,
        kind: "generated_file", path: row.path, sourcePath: row.source_path,
        summary: row.summary ?? row.path, createdAt: row.created_at, mediaType: row.media_type,
        visibility: row.visibility === "published" ? "published" : "project",
        pinned: row.pinned === 1,
        size: row.size, previewUrl: `${root}/preview`, downloadUrl: `${root}/download`,
      };
    }
    if (row.kind === "diff" && row.source_path) {
      const captured = this.client.prepare(`
        SELECT 1 FROM artifacts WHERE agent_id = ? AND kind = 'generated_file' AND source_path = ? LIMIT 1
      `).get(agentId, row.source_path);
      if (captured) return undefined;
    }
    if (row.kind === "diff" && row.source_path?.toLowerCase().endsWith(".pdf")) {
      const root = `/api/projects/${encodeURIComponent(agent.projectId)}/agents/${encodeURIComponent(agentId)}/generated-artifacts/${encodeURIComponent(row.id)}`;
      return {
        id: row.id, agentId: row.agent_id, executionId: row.execution_id ?? undefined,
        kind: "document", path: row.source_path, summary: row.source_path, createdAt: row.created_at,
        mediaType: "application/pdf", previewUrl: `${root}/preview`, downloadUrl: `${root}/download`,
      };
    }
    if (row.kind === "screenshot") {
      const root = `/api/projects/${encodeURIComponent(agent.projectId)}/agents/${encodeURIComponent(agentId)}/browser-artifacts/${encodeURIComponent(row.id)}`;
      return {
        id: row.id, agentId: row.agent_id, executionId: row.execution_id ?? undefined,
        kind: "screenshot", path: row.path, summary: row.summary ?? undefined, createdAt: row.created_at,
        mediaType: "image/png", previewUrl: root, downloadUrl: `${root}?download=1`,
      };
    }
    return {
      id: row.id, agentId: row.agent_id, executionId: row.execution_id ?? undefined,
      kind: row.kind as ArtifactKind, path: row.path, summary: row.summary ?? undefined, createdAt: row.created_at,
    };
  }

  getArtifactPage(agentId: string, input: { limit: number; cursor?: string; focusId?: string }): HistoryPageDto<ArtifactDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    if (input.cursor && input.focusId) throw new Error("history cursor and focus cannot be combined");
    const focusId = input.focusId;
    const focusBoundary = focusId ? this.client.prepare(`
      SELECT created_at AS orderKey, id AS rowKey FROM artifacts WHERE agent_id = ? AND id = ?
    `).get(agentId, focusId) as { orderKey: string; rowKey: string } | undefined : undefined;
    if (focusId && !focusBoundary) return { items: [], history: { limit, hasMore: false } };
    const boundary = focusBoundary ?? (input.cursor ? this.decodeHistoryCursor(input.cursor, "agent:artifacts", agentId) : undefined);
    const rows = this.client.prepare(`
      SELECT id, agent_id, execution_id, kind, path, summary, created_at,
        source_path, media_type, visibility, pinned, size
      FROM artifacts
      WHERE agent_id = ?
        ${boundary ? `AND (created_at < ? OR (created_at = ? AND id ${focusBoundary ? "<=" : "<"} ?))` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...(boundary
      ? [agentId, boundary.orderKey, boundary.orderKey, boundary.rowKey, limit + 1]
      : [agentId, limit + 1])) as ArtifactProjectionReadRow[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected.flatMap((row) => {
      const artifact = this.artifactDtoFromProjectionRow(agentId, row);
      return artifact ? [artifact] : [];
    }).reverse();
    const oldest = selected.at(-1);
    return {
      items,
      history: {
        limit, hasMore,
        ...(hasMore && oldest ? { cursor: this.encodeHistoryCursor({
          stream: "agent:artifacts", scope: agentId, orderKey: oldest.created_at, rowKey: oldest.id,
        }) } : {}),
      },
    };
  }

  /** Durable Project-owned generated-artifact catalog. */
  getProjectArtifacts(projectId: string): ArtifactDto[] {
    const rows = this.client.prepare(`
      SELECT artifact_json FROM managed_artifact_projection
      WHERE project_id = ? ORDER BY created_at, artifact_id
    `).all(projectId) as Array<{ artifact_json: string }>;
    return rows.map((row) => JSON.parse(row.artifact_json) as ArtifactDto & { projectId: string; originAgentId: string }).map((artifact) => {
      const root = `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact.id)}`;
      return { ...artifact, previewUrl: `${root}/preview`, downloadUrl: `${root}/download` };
    });
  }

  private projectManagedArtifactEvent(projectId: string, event: ManagedArtifactEvent): void {
    if (event.type === "created") {
      const access = event.access ?? {
        ownerKind: "project" as const,
        ownerId: event.artifact.id,
        audience: { kind: "organization" as const, organizationId: projectId },
      };
      const prior = this.client.prepare(`
        SELECT artifact_json, owner_kind, owner_id, audience_json, sender_agent_id
        FROM managed_artifact_projection WHERE project_id = ? AND artifact_id = ?
      `).get(projectId, event.artifact.id) as {
        artifact_json: string;
        owner_kind: string;
        owner_id: string;
        audience_json: string;
        sender_agent_id: string | null;
      } | undefined;
      if (prior) {
        if (prior.artifact_json === JSON.stringify(event.artifact) &&
            prior.owner_kind === access.ownerKind && prior.owner_id === access.ownerId &&
            prior.audience_json === JSON.stringify(access.audience) &&
            prior.sender_agent_id === (access.senderAgentId ?? null)) return;
        throw new Error("managed artifact identity, provenance, and audience are immutable");
      }
      this.client.prepare(`
        INSERT INTO managed_artifact_projection(
          project_id, artifact_id, created_at, visibility, pinned, artifact_json,
          owner_kind, owner_id, audience_json, sender_agent_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId, event.artifact.id, event.artifact.createdAt,
        event.artifact.visibility ?? "project", event.artifact.pinned ? 1 : 0,
        JSON.stringify(event.artifact),
        access.ownerKind, access.ownerId, JSON.stringify(access.audience), access.senderAgentId ?? null,
      );
      return;
    }
    if (event.type === "deleted") {
      this.client.prepare(`DELETE FROM managed_artifact_projection WHERE project_id = ? AND artifact_id = ?`)
        .run(projectId, event.artifactId);
      return;
    }
    const row = this.client.prepare(`
      SELECT artifact_json FROM managed_artifact_projection WHERE project_id = ? AND artifact_id = ?
    `).get(projectId, event.artifactId) as { artifact_json: string } | undefined;
    if (!row) return;
    const artifact = JSON.parse(row.artifact_json) as ArtifactDto & { projectId: string; originAgentId: string };
    this.client.prepare(`
      UPDATE managed_artifact_projection SET visibility = ?, pinned = ?, artifact_json = ?
      WHERE project_id = ? AND artifact_id = ?
    `).run(
      event.visibility, event.pinned ? 1 : 0,
      JSON.stringify({ ...artifact, visibility: event.visibility, pinned: event.pinned }),
      projectId, event.artifactId,
    );
  }

  private rebuildManagedArtifactProjection(projectId: string): void {
    for (const event of readRepairableJsonl<ManagedArtifactEvent>(
      managedArtifactsLogPath(this.dataDir, projectId),
      `managed artifacts for project ${projectId}`,
    )) this.projectManagedArtifactEvent(projectId, event);
  }

  /** Bounded Project-wide file/result catalog. SQLite applies the boundary to
   * Agent execution artifacts; the usually-small authored catalog is merged by
   * the same stable key before the response page is formed. */
  getProjectArtifactPage(projectId: string, input: { limit: number; cursor?: string }): HistoryPageDto<ArtifactDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    const boundary = input.cursor ? this.decodeHistoryCursor(input.cursor, "project:artifacts", projectId) : undefined;
    const rows = this.client.prepare(`
      SELECT artifact.id, artifact.agent_id, artifact.execution_id, artifact.kind, artifact.path,
        artifact.summary, artifact.created_at, artifact.source_path, artifact.media_type,
        artifact.visibility, artifact.pinned, artifact.size
      FROM artifacts artifact
      JOIN agents agent ON agent.id = artifact.agent_id
      WHERE agent.project_id = ?
        ${boundary ? "AND (artifact.created_at < ? OR (artifact.created_at = ? AND artifact.id < ?))" : ""}
      ORDER BY artifact.created_at DESC, artifact.id DESC LIMIT ?
    `).all(...(boundary
      ? [projectId, boundary.orderKey, boundary.orderKey, boundary.rowKey, limit + 1]
      : [projectId, limit + 1])) as ArtifactProjectionReadRow[];
    const executionArtifacts = rows.flatMap((row) => {
      const artifact = this.artifactDtoFromProjectionRow(row.agent_id, row);
      return artifact ? [{ ...artifact, projectId }] : [];
    });
    const managedRows = this.client.prepare(`
      SELECT artifact_json FROM managed_artifact_projection
      WHERE project_id = ? AND json_extract(audience_json, '$.kind') = 'organization'
        ${boundary ? "AND (created_at < ? OR (created_at = ? AND artifact_id < ?))" : ""}
      ORDER BY created_at DESC, artifact_id DESC LIMIT ?
    `).all(...(boundary
      ? [projectId, boundary.orderKey, boundary.orderKey, boundary.rowKey, limit + 1]
      : [projectId, limit + 1])) as Array<{ artifact_json: string }>;
    const managed = managedRows.map((row) => {
      const artifact = JSON.parse(row.artifact_json) as ArtifactDto & { projectId: string; originAgentId: string };
      const root = `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact.id)}`;
      return { ...artifact, previewUrl: `${root}/preview`, downloadUrl: `${root}/download` };
    });
    const merged = new Map<string, ArtifactDto>();
    for (const artifact of executionArtifacts) merged.set(artifact.id, artifact);
    for (const artifact of managed) merged.set(artifact.id, artifact);
    const ordered = [...merged.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const hasMore = ordered.length > limit || rows.length > limit || managedRows.length > limit;
    const selected = ordered.slice(0, limit);
    const oldest = selected.at(-1);
    return {
      items: selected.reverse(),
      history: {
        limit, hasMore,
        ...(hasMore && oldest ? { cursor: this.encodeHistoryCursor({
          stream: "project:artifacts", scope: projectId, orderKey: oldest.createdAt, rowKey: oldest.id,
        }) } : {}),
      },
    };
  }

  getProjectArtifact(projectId: string, artifactIdValue: string): ArtifactDto | undefined {
    const row = this.client.prepare(`
      SELECT artifact_json FROM managed_artifact_projection WHERE project_id = ? AND artifact_id = ?
    `).get(projectId, artifactIdValue) as { artifact_json: string } | undefined;
    if (!row) return undefined;
    const artifact = JSON.parse(row.artifact_json) as ArtifactDto & { projectId: string; originAgentId: string };
    const root = `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact.id)}`;
    return { ...artifact, previewUrl: `${root}/preview`, downloadUrl: `${root}/download` };
  }

  getProjectArtifactAccess(projectId: string, artifactIdValue: string): ManagedArtifactAccess | undefined {
    const row = this.client.prepare(`
      SELECT owner_kind, owner_id, audience_json, sender_agent_id
      FROM managed_artifact_projection WHERE project_id = ? AND artifact_id = ?
    `).get(projectId, artifactIdValue) as {
      owner_kind: ManagedArtifactAccess["ownerKind"];
      owner_id: string;
      audience_json: string;
      sender_agent_id: string | null;
    } | undefined;
    if (!row) return undefined;
    try {
      return {
        ownerKind: row.owner_kind,
        ownerId: row.owner_id,
        audience: JSON.parse(row.audience_json) as ManagedArtifactAccess["audience"],
        ...(row.sender_agent_id ? { senderAgentId: row.sender_agent_id } : {}),
      };
    } catch { return undefined; }
  }

  projectArtifactIsOrganizationVisible(projectId: string, artifactIdValue: string): boolean {
    return this.getProjectArtifactAccess(projectId, artifactIdValue)?.audience.kind === "organization";
  }

  operatorCanReadProjectArtifact(projectId: string, artifactIdValue: string): boolean {
    // The single local operator owns the Project audit surfaces (including
    // Team Chat), but private artifacts still stay out of the organizational
    // catalog and future-agent context.
    return Boolean(this.getProject(projectId) && this.getProjectArtifactAccess(projectId, artifactIdValue));
  }

  agentCanReadProjectArtifact(projectId: string, artifactIdValue: string, agentId: string): boolean {
    const agent = this.getAgent(agentId);
    const access = this.getProjectArtifactAccess(projectId, artifactIdValue);
    if (!agent || agent.projectId !== projectId || agent.archived || !access) return false;
    if (access.audience.kind === "organization") return true;
    if (access.senderAgentId === agentId) return true;
    if (access.audience.kind === "agents" || access.audience.kind === "user_agents" ||
        access.audience.kind === "request_agents") return access.audience.agentIds.includes(agentId);
    return access.audience.kind === "user_agent" && access.audience.agentId === agentId;
  }

  getProjectContextArtifacts(projectId: string, limit = 100): ArtifactDto[] {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.client.prepare(`
      SELECT artifact_json FROM managed_artifact_projection
      WHERE project_id = ? AND json_extract(audience_json, '$.kind') = 'organization'
        AND (pinned = 1 OR visibility = 'published')
      ORDER BY created_at DESC, artifact_id DESC LIMIT ?
    `).all(projectId, boundedLimit) as Array<{ artifact_json: string }>;
    return rows.map((row) => {
      const artifact = JSON.parse(row.artifact_json) as ArtifactDto & { projectId: string; originAgentId: string };
      const root = `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact.id)}`;
      return { ...artifact, previewUrl: `${root}/preview`, downloadUrl: `${root}/download` };
    });
  }

  recordProjectArtifact(
    artifact: ArtifactDto & { projectId: string; originAgentId: string },
    access: ManagedArtifactAccess = {
      ownerKind: "project",
      ownerId: artifact.id,
      audience: { kind: "organization", organizationId: artifact.projectId },
    },
  ): void {
    if (!this.getProject(artifact.projectId)) throw new Error("artifact project not found");
    if (!artifact.summary?.trim() || !artifact.mediaType?.trim() || artifact.size === undefined ||
        !Number.isSafeInteger(artifact.size) || artifact.size < 1 || !/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? "") ||
        !artifact.originAgentId.trim()) {
      throw new Error("managed artifact immutable metadata is required");
    }
    const existing = this.getProjectArtifact(artifact.projectId, artifact.id);
    if (existing) {
      const immutableFields = [
        "id", "projectId", "agentId", "originAgentId", "executionId", "kind", "path",
        "summary", "createdAt", "mediaType", "sourcePath", "size", "sha256",
      ] as const;
      const existingAccess = this.getProjectArtifactAccess(artifact.projectId, artifact.id);
      if (immutableFields.every((field) => existing[field] === artifact[field]) &&
          JSON.stringify(existingAccess) === JSON.stringify(access)) return;
      throw new Error("managed artifact identity and provenance are immutable");
    }
    const event = { type: "created", artifact, access } satisfies ManagedArtifactEvent;
    appendFsyncedJsonl(managedArtifactsLogPath(this.dataDir, artifact.projectId), [event]);
    this.projectManagedArtifactEvent(artifact.projectId, event);
  }

  deleteProjectArtifact(projectId: string, artifactIdValue: string, reason: string): boolean {
    if (!this.getProjectArtifact(projectId, artifactIdValue)) return false;
    const event = {
      type: "deleted", artifactId: artifactIdValue, at: new Date().toISOString(), reason: reason.slice(0, 240),
    } satisfies ManagedArtifactEvent;
    appendFsyncedJsonl(managedArtifactsLogPath(this.dataDir, projectId), [event]);
    this.projectManagedArtifactEvent(projectId, event);
    return true;
  }

  updateProjectArtifactVisibility(
    projectId: string,
    artifactIdValue: string,
    visibility: "project" | "published",
    pinned: boolean,
  ): ArtifactDto | undefined {
    if (!this.getProjectArtifact(projectId, artifactIdValue)) return undefined;
    const event = {
      type: "visibility", artifactId: artifactIdValue, visibility, pinned, at: new Date().toISOString(),
    } satisfies ManagedArtifactEvent;
    appendFsyncedJsonl(managedArtifactsLogPath(this.dataDir, projectId), [event]);
    this.projectManagedArtifactEvent(projectId, event);
    return this.getProjectArtifact(projectId, artifactIdValue);
  }

  getGeneratedPdfPath(agentId: string, artifactIdValue: string): string | undefined {
    const stored = this.readEvents(agentId).find((candidate) =>
      artifactId(agentId, candidate.seq, 0) === artifactIdValue &&
      candidate.event.type === "file_change" &&
      candidate.event.path.toLowerCase().endsWith(".pdf")
    );
    return stored?.event.type === "file_change"
      ? stored.event.path
      : undefined;
  }

  getGeneratedArtifact(agentId: string, artifactIdValue: string): Extract<LogEvent, { type: "generated_artifact" }> | undefined {
    const stored = this.readEvents(agentId).find((candidate) =>
      candidate.event.type === "generated_artifact" &&
      (candidate.event.artifactId ?? artifactId(agentId, candidate.seq, 0)) === artifactIdValue
    );
    return stored?.event.type === "generated_artifact" ? stored.event : undefined;
  }

  getArtifact(agentId: string, artifactId: string): ArtifactDto | undefined {
    const row = this.client.prepare(`
      SELECT id, agent_id, execution_id, kind, path, summary, created_at,
        source_path, media_type, visibility, pinned, size
      FROM artifacts WHERE agent_id = ? AND id = ?
    `).get(agentId, artifactId) as ArtifactProjectionReadRow | undefined;
    return row ? this.artifactDtoFromProjectionRow(agentId, row) : undefined;
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
    const log = this.logFor(agentId, projectId);
    const stored = log.append(event);

    const state = this.stateFor(agentId, projectId);
    const { state: nextState, ops } = projectEvent(agentId, state, stored);
    this.states.set(agentId, nextState);
    this.applyOps(agentId, projectId, ops);
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
    return this.logFor(agentId, this.projectIdOf(agentId)).readAll();
  }

  readEventsSince(agentId: string, sinceSeq: number): StoredLogEvent[] {
    return (this.client.prepare(`
      SELECT seq, created_at, payload_json
      FROM events
      WHERE agent_id = ? AND seq > ?
      ORDER BY seq
    `).all(agentId, sinceSeq) as Array<{ seq: number; created_at: string; payload_json: string }>).map((row) => ({
      seq: row.seq,
      ts: row.created_at,
      event: JSON.parse(row.payload_json) as LogEvent,
    }));
  }

  lastSeqOf(agentId: string): number {
    const row = this.client.prepare(`
      SELECT last_seq FROM agent_event_head_projection WHERE agent_id = ?
    `).get(agentId) as { last_seq: number } | undefined;
    return row?.last_seq ?? 0;
  }

  latestHealthObservation(agentId: string): {
    status: AgentLifecycleStatus;
    statusTimestamp: string;
    reason: AgentLifecycleReason;
    executionId?: string;
  } | undefined {
    const row = this.client.prepare(`
      SELECT status, status_timestamp, reason, execution_id
      FROM agent_health_projection WHERE agent_id = ?
    `).get(agentId) as { status: AgentLifecycleStatus; status_timestamp: string; reason: AgentLifecycleReason; execution_id: string | null } | undefined;
    return row ? {
      status: row.status, statusTimestamp: row.status_timestamp, reason: row.reason,
      ...(row.execution_id ? { executionId: row.execution_id } : {}),
    } : undefined;
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
    this.logs.clear();
    this.states.clear();

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

      this.rebuildManagedArtifactProjection(projectId);

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
        const ops = projectAll(agentId, stored, t.activeEngine);
        this.applyOps(agentId, projectId, ops);
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
    this.rebuildGlobalChatSearchProjection();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.close();
    releaseDataDirectoryOwnership(this.ownership);
    this.ownership = undefined;
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private applyOps(agentId: string, projectId: string, ops: ProjectionOp[]): void {
    for (const op of ops) {
      if (op.kind === "insert_artifact") {
        let managed = op.managed;
        if (op.content !== undefined) {
          const target = artifactContentPath(this.dataDir, projectId, agentId, op.row.path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, op.content, "utf8");
          const published = publishManagedArtifactContent(this.dataDir, projectId, op.row.id, op.content);
          managed = {
            size: published.size,
            sha256: published.sha256,
            mediaType: op.row.kind === "diff" ? "text/x-diff" : "text/markdown",
          };
        }
        if (managed) {
          const artifact = {
            id: op.row.id,
            projectId,
            agentId: op.row.agentId,
            originAgentId: op.row.agentId,
            ...(op.row.executionId ? { executionId: op.row.executionId } : {}),
            kind: op.row.kind as ArtifactKind,
            path: op.row.path,
            ...(op.row.sourcePath ? { sourcePath: op.row.sourcePath } : {}),
            summary: op.row.summary ?? op.row.path,
            createdAt: op.row.createdAt,
            mediaType: managed.mediaType,
            visibility: op.row.visibility === "published" ? "published" as const : "project" as const,
            pinned: op.row.pinned === 1,
            size: managed.size,
            sha256: managed.sha256,
          };
          this.recordProjectArtifact(artifact);
        }
      }
    }

    // drizzle's transaction runs the callback immediately (all-or-nothing) and
    // provides a `tx` handle scoped to the transaction.
    this.db.transaction((tx) => {
      for (const op of ops) {
        switch (op.kind) {
          case "insert_message":
            tx.insert(messages).values(op.row).onConflictDoNothing().run();
            break;
          case "insert_event":
            tx.insert(events).values(op.row).onConflictDoNothing().run();
            this.client.prepare(`
              INSERT INTO agent_event_head_projection(agent_id, last_seq) VALUES (?, ?)
              ON CONFLICT(agent_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)
            `).run(agentId, op.row.seq);
            {
              const event = JSON.parse(op.row.payloadJson) as LogEvent;
              const observation = healthObservation(event, op.row.createdAt);
              if (observation) this.client.prepare(`
                INSERT INTO agent_health_projection(
                  agent_id, source_seq, status, status_timestamp, reason, execution_id
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(agent_id) DO UPDATE SET
                  source_seq = excluded.source_seq,
                  status = excluded.status,
                  status_timestamp = excluded.status_timestamp,
                  reason = excluded.reason,
                  execution_id = excluded.execution_id
                WHERE excluded.source_seq > agent_health_projection.source_seq
              `).run(
                agentId, op.row.seq, observation.status,
                observation.statusTimestamp, observation.reason, observation.executionId ?? null,
              );
            }
            if (ACTIVITY_EVENT_TYPES.has(op.row.type)) {
              const event = JSON.parse(op.row.payloadJson) as LogEvent;
              let eventJson = op.row.payloadJson;
              let previewUtf8Bytes: number | null = null;
              let totalUtf8Bytes: number | null = null;
              let outputSha256: string | null = null;
              if (event.type === "tool_result") {
                const output = Buffer.from(event.output, "utf8");
                const preview = utf8Prefix(event.output, ACTIVITY_OUTPUT_PREVIEW_BYTES);
                previewUtf8Bytes = Buffer.byteLength(preview, "utf8");
                totalUtf8Bytes = output.length;
                outputSha256 = createHash("sha256").update(output).digest("hex");
                eventJson = JSON.stringify({ ...event, output: preview });
                this.client.prepare(`
                  INSERT OR IGNORE INTO tool_output_projection
                    (agent_id, seq, output, total_utf8_bytes, sha256)
                  VALUES (?, ?, ?, ?, ?)
                `).run(agentId, op.row.seq, output, output.length, outputSha256);
              }
              this.client.prepare(`
                INSERT OR IGNORE INTO activity_projection(
                  agent_id, seq, event_type, execution_id, event_json, created_at,
                  output_preview_utf8_bytes, output_total_utf8_bytes, output_sha256
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                agentId, op.row.seq, op.row.type, op.executionId ?? null, eventJson, op.row.createdAt,
                previewUtf8Bytes, totalUtf8Bytes, outputSha256,
              );
              if (event.type === "file_change") {
                if (op.executionId) this.client.prepare(`
                  INSERT INTO changed_file_execution_projection(agent_id, path, execution_id, last_seq)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT(agent_id, path, execution_id) DO UPDATE SET last_seq = excluded.last_seq
                `).run(agentId, event.path, op.executionId, op.row.seq);
                const executionIds = (this.client.prepare(`
                  SELECT execution_id AS executionId
                  FROM changed_file_execution_projection
                  WHERE agent_id = ? AND path = ?
                  ORDER BY last_seq DESC, execution_id DESC LIMIT 100
                `).all(agentId, event.path) as Array<{ executionId: string }>).map((row) => row.executionId);
                const executionCount = (this.client.prepare(`
                  SELECT COUNT(*) AS count FROM changed_file_execution_projection
                  WHERE agent_id = ? AND path = ?
                `).get(agentId, event.path) as { count: number }).count;
                const boundedDiff = event.diff ? utf8Prefix(event.diff, ACTIVITY_OUTPUT_PREVIEW_BYTES) : null;
                this.client.prepare(`
                  INSERT INTO changed_file_projection(
                    agent_id, path, kind, last_seq, last_changed_at, execution_ids_json, execution_count, diff
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(agent_id, path) DO UPDATE SET
                    kind = excluded.kind,
                    last_seq = excluded.last_seq,
                    last_changed_at = excluded.last_changed_at,
                    execution_ids_json = excluded.execution_ids_json,
                    execution_count = excluded.execution_count,
                    diff = excluded.diff
                `).run(
                  agentId, event.path, event.kind, op.row.seq, op.row.createdAt,
                  JSON.stringify(executionIds), executionCount, boundedDiff,
                );
              }
            }
            if (op.row.type === "artifact_visibility") {
              const visibility = JSON.parse(op.row.payloadJson) as LogEvent;
              if (visibility.type === "artifact_visibility") {
                this.client.prepare(`
                  UPDATE artifacts SET visibility = ?, pinned = ? WHERE agent_id = ? AND id = ?
                `).run(visibility.visibility, visibility.pinned ? 1 : 0, agentId, visibility.artifactId);
              }
            }
            break;
          case "insert_artifact":
            tx.insert(artifacts).values(op.row).onConflictDoNothing().run();
            break;
          case "insert_run":
            tx.insert(runs)
              .values(op.row)
              .onConflictDoUpdate({
                target: [runs.agentId, runs.id],
                set: {
                  title: op.row.title,
                  status: op.row.status,
                  reason: op.row.reason,
                  engine: op.row.engine,
                  communicationEventId: op.row.communicationEventId,
                  wakeCause: op.row.wakeCause,
                  updatedAt: op.row.updatedAt,
                  completedAt: op.row.completedAt,
                },
              })
              .run();
            break;
          case "set_run_usage":
            tx.update(runs)
              .set({
                inputTokens: op.inputTokens ?? null,
                cachedInputTokens: op.cachedInputTokens ?? null,
                cacheWriteInputTokens: op.cacheWriteInputTokens ?? null,
                outputTokens: op.outputTokens ?? null,
                reasoningOutputTokens: op.reasoningOutputTokens ?? null,
                totalTokens: op.totalTokens ?? null,
                providerRequestUsageJson: op.providerRequestUsage ? JSON.stringify(op.providerRequestUsage) : null,
              })
              .where(and(eq(runs.agentId, agentId), eq(runs.id, op.id)))
              .run();
            break;
          case "update_run":
            tx.update(runs)
              .set({ status: op.status, reason: op.reason, updatedAt: op.updatedAt, completedAt: op.completedAt })
              .where(and(eq(runs.agentId, agentId), eq(runs.id, op.id)))
              .run();
            break;
          case "insert_work_item":
            tx.insert(workItems)
              .values(op.row)
              .onConflictDoUpdate({
                target: workItems.id,
                set: {
                  executionId: op.row.executionId,
                  title: op.row.title,
                  status: op.row.status,
                  updatedAt: op.row.updatedAt,
                },
              })
              .run();
            break;
          case "set_session":
            tx.update(agents)
              .set({
                activeSessionId: op.sessionId,
                activeSessionContractHash: op.toolContractHash,
                activeSessionArtifactIdsJson: JSON.stringify(op.artifactIds),
              })
              .where(eq(agents.id, agentId))
              .run();
            break;
          case "insert_continuation_handoff":
            tx.insert(continuationHandoffs)
              .values({
                id: op.id,
                agentId,
                sourceExecutionId: op.executionId,
                text: op.text,
                createdAt: op.createdAt,
              })
              .onConflictDoNothing()
              .run();
            break;
          case "consume_continuation_handoff":
            tx.update(continuationHandoffs)
              .set({ consumedByExecutionId: op.executionId, consumedAt: op.consumedAt })
              .where(and(eq(continuationHandoffs.id, op.id), eq(continuationHandoffs.agentId, agentId)))
              .run();
            break;
          case "set_state":
            tx.update(agents)
              .set({ stateBranch: op.branch ?? null, stateCommit: op.commit ?? null })
              .where(eq(agents.id, agentId))
              .run();
            break;
          case "touch_agent":
            tx.update(agents)
              .set({ updatedAt: op.updatedAt })
              .where(eq(agents.id, agentId))
              .run();
            break;
        }
      }
    });
  }

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

  private logFor(agentId: string, projectId: string): EventLog {
    let log = this.logs.get(agentId);
    if (!log) {
      log = new EventLog(eventsPath(this.dataDir, projectId, agentId));
      this.logs.set(agentId, log);
    }
    return log;
  }

  private stateFor(agentId: string, projectId: string): ProjectionState {
    let state = this.states.get(agentId);
    if (!state) {
      // Rebuild the in-memory reducer state by folding the existing log.
      const engine = this.activeEngineOf(agentId);
      state = initProjectionState(engine);
      const existing = new EventLog(eventsPath(this.dataDir, projectId, agentId)).readAll();
      for (const stored of existing) {
        state = projectEvent(agentId, state, stored).state;
      }
      this.states.set(agentId, state);
    }
    return state;
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
