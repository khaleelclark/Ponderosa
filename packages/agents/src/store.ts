// AgentStore — the library that apps/server consumes. Authored communication and
// execution telemetry remain event-log-owned and their SQLite views are
// rebuildable. Communication V3 scheduler state is different: its requests,
// joins, activations, Runs, leases, fences, injections, and idempotency records
// are authoritative SQLite state. Exposes NO HTTP (SPEC §7).

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { and, asc, eq } from "drizzle-orm";
import type {
  ArtifactDto,
  AgentActivityDto,
  ChangedFileDto,
  AgentOrganizationEvent,
  CommunicationEvent,
  CommunicationRevisionEvent,
  CommunicationDocumentRecord,
  CommunicationDocumentReference,
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

function communicationDocumentReference(projectId: string, document: CommunicationDocumentRecord): CommunicationDocumentReference {
  const { content: _content, ...metadata } = document;
  const root = `/api/projects/${encodeURIComponent(projectId)}/communication-documents/${encodeURIComponent(document.id)}`;
  return { ...metadata, previewUrl: root, downloadUrl: `${root}/download` };
}
import { openDb, type Db } from "./db.js";
import { EventLog } from "./eventlog.js";
import { artifactId, messageId as projectedMessageId } from "./ids.js";
import { appendFsyncedJsonl, readRepairableJsonl } from "./append-jsonl.js";
import type { LogEvent, StoredLogEvent } from "./log-event.js";
import {
  initProjectionState,
  projectAll,
  projectEvent,
  type ProjectionOp,
  type ProjectionState,
} from "./projectors.js";

function revisedRenderedText(rendered: string, original: string, replacement: string): string {
  if (rendered === original) return replacement;
  if (original && rendered.endsWith(original)) return `${rendered.slice(0, -original.length)}${replacement}`.trimEnd();
  return replacement;
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}
import {
  artifacts,
  agentPresets,
  events,
  conversations,
  messages,
  chatSearchMessages,
  projects,
  runs,
  workItems,
  agents,
  agentDeletionTombstones,
  agentDeletionReceipts,
  agentManagementApprovals,
  agentConversationMemberships,
} from "./schema.js";
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

type ManagedArtifactEvent =
  | { type: "created"; artifact: ArtifactDto & { projectId: string; originAgentId: string } }
  | { type: "visibility"; artifactId: string; visibility: "project" | "published"; pinned: boolean; at: string }
  | { type: "deleted"; artifactId: string; at: string; reason: string };

interface DataDirectoryOwnership {
  path: string;
  token: string;
}

function acquireDataDirectoryOwnership(dataDir: string): DataDirectoryOwnership {
  const path = join(dataDir, ".ponderosa-daemon.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), "utf8");
      } finally {
        closeSync(descriptor);
      }
      return { path, token };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      if (code !== "EEXIST") throw error;
      let owner: { pid?: number; token?: string } = {};
      try { owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; token?: string }; } catch { /* stale malformed lock */ }
      let alive = false;
      if (Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
        try { process.kill(owner.pid!, 0); alive = true; } catch { /* stale owner */ }
      }
      if (alive) throw new Error(`data directory is already owned by Ponderosa process ${owner.pid}`);
      // Remove only the stale record we inspected; a changed token means
      // another contender already acquired ownership.
      try {
        const current = JSON.parse(readFileSync(path, "utf8")) as { token?: string };
        if (current.token !== owner.token) continue;
      } catch { /* malformed stale record remains removable */ }
      rmSync(path, { force: true });
    }
  }
  throw new Error("could not acquire exclusive Ponderosa data-directory ownership");
}

function releaseDataDirectoryOwnership(ownership: DataDirectoryOwnership | undefined): void {
  if (!ownership) return;
  try {
    const current = JSON.parse(readFileSync(ownership.path, "utf8")) as { token?: string };
    if (current.token === ownership.token) rmSync(ownership.path, { force: true });
  } catch { /* a missing/replaced lock is no longer ours */ }
}

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

export class AgentDeletionConflictError extends Error {
  constructor(readonly currentPreview: AgentDeletionPreviewDto) {
    super("Agent organization changed after deletion preview");
    this.name = "AgentDeletionConflictError";
  }
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
  replyTo?: import("@ponderosa/core").MessageReferenceDto;
  attachments?: import("@ponderosa/core").ImageAttachmentDto[];
}

function writeJson(file: string, data: unknown): void {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.json.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", "utf8");
    const descriptor = openSync(temporary, "r");
    try { fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    renameSync(temporary, file);
    fsyncDirectory(directory);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function requireManagementPermissions(value: unknown): AgentDto["managementPermissions"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("management permissions must be an object");
  const permissions = value as Record<string, unknown>;
  if (typeof permissions.allowAutomaticDescendantDeletion !== "boolean" ||
      typeof permissions.allowAutomaticDescendantReorganization !== "boolean") {
    throw new Error("management permissions must contain exact boolean values");
  }
  return {
    allowAutomaticDescendantDeletion: permissions.allowAutomaticDescendantDeletion,
    allowAutomaticDescendantReorganization: permissions.allowAutomaticDescendantReorganization,
  };
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

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function readJsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/** Remove rebuildable/stale files while retaining bytes referenced by canonical events. */
function pruneArtifactDirectory(root: string, protectedPaths: ReadonlySet<string>, relative = ""): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const childRelative = relative ? join(relative, entry.name) : entry.name;
    const child = join(root, childRelative);
    if (entry.isDirectory()) {
      pruneArtifactDirectory(root, protectedPaths, childRelative);
      if (readdirSync(child).length === 0) rmSync(child, { recursive: false, force: true });
    } else if (!entry.isFile() || !protectedPaths.has(childRelative)) {
      rmSync(child, { force: true });
    }
  }
}

/** V1 is a destructive test-data cutover; managed source workspaces are external. */
function ensureV1Layout(dataDir: string): void {
  const marker = join(dataDir, ".ponderosa-layout-version");
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === "1") return;
  mkdirSync(dataDir, { recursive: true });
  for (const entry of readdirSync(dataDir)) {
    if (entry === "workspaces" || entry === ".ponderosa-layout-version") continue;
    rmSync(join(dataDir, entry), { recursive: true, force: true });
  }
  writeFileSync(marker, "1\n", "utf8");
}

function communicationMessageProjection(agentId: string, stored: StoredLogEvent): CommunicationProjection["message"] | undefined {
  const event = stored.event;
  if (event.type === "user_message") return {
    messageId: projectedMessageId(agentId, stored.seq), role: "user", renderedText: event.text, createdAt: stored.ts, sequence: stored.seq,
    ...(event.attachments?.length ? { attachmentIds: event.attachments.map((item) => item.id) } : {}),
    ...(event.replyTo ? { replyTo: event.replyTo } : {}),
    ...(event.attachments?.length ? { attachments: event.attachments } : {}),
  };
  if (event.type === "communication_projection") return {
    messageId: projectedMessageId(agentId, stored.seq), role: event.role ?? "assistant", renderedText: event.text, createdAt: stored.ts, sequence: stored.seq,
    ...(event.attachments?.length ? { attachmentIds: event.attachments.map((item) => item.id), attachments: event.attachments } : {}),
  };
  return undefined;
}

function userDmAgentIds(event: CommunicationEvent): string[] {
  if (event.schemaVersion !== 2 || event.intent !== "user_dm") return [];
  return event.audience.kind === "user_agent" ? [event.audience.agentId] : event.audience.agentIds;
}

function normalizedAgentIds(ids: readonly string[]): [string, ...string[]] {
  const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
  if (normalized.length === 0) throw new Error("collaboration requires at least one recipient agent ID");
  return normalized as [string, ...string[]];
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
    this.deliverySequence = readJsonLines<{ sequence: number }>(this.deliverySequenceFile)
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
    appendFileSync(this.deliverySequenceFile, `${JSON.stringify({ sequence: this.deliverySequence })}\n`, "utf8");
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
      return;
    }
    const canonicalRole = event.sender.kind === "agent"
      ? "assistant"
      : event.sender.kind === "user"
        ? "user"
        : message.role;
    const authorAgentId = event.sender.kind === "agent" ? event.sender.agentId : message.authorAgentId;
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
      },
    }).run();
  }

  /** Rebuild the disposable global Chat search index from canonical ledgers. */
  private rebuildGlobalChatSearchProjection(): void {
    this.db.delete(chatSearchMessages).run();
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
    if (!event.eventId || (!event.text.trim() && !event.attachments?.length) || !event.createdAt) {
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
    const file = managedArtifactContentPath(this.dataDir, projectId, event.document.artifactId);
    if (!existsSync(file)) return undefined;
    return { event, document: { ...event.document, content: readFileSync(file, "utf8") } };
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
          ...(!existing.message.replyTo && projection.message.replyTo ? { replyTo: projection.message.replyTo } : {}),
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
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
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
          ...(dispatch.replyTo ? { replyTo: dispatch.replyTo } : {}),
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

  /** Permanently remove the canonical project tree and every rebuildable
   * projection. The callback shares the projection-deletion transaction so
   * authoritative runtime state cannot survive a deleted Project row. */
  deleteProject(id: string, beforeProjectionDelete?: (projectId: string) => void): boolean {
    const current = this.getProject(id);
    if (!current) return false;
    const agentIds = this.listAgents(id).map((agent) => agent.id);
    const canonicalDir = projectDir(this.dataDir, id);
    const deletingDir = join(dirname(canonicalDir), `.${id}.deleting-${randomUUID()}`);
    renameSync(canonicalDir, deletingDir);
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
        this.client.prepare(`DELETE FROM agent_deletion_tombstones WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM agent_deletion_receipts WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM conversations WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM agents WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
      });
    } catch (error) {
      renameSync(deletingDir, canonicalDir);
      throw error;
    }
    // A crash before this cleanup leaves a hidden tombstone directory which
    // startup projection repair already discards rather than resurrecting.
    rmSync(deletingDir, { recursive: true, force: true });
    this.communicationEventCache.delete(id);
    this.communicationProjectionCache.delete(id);
    this.messageDispatchCache.delete(id);
    for (const agentId of agentIds) {
      this.logs.delete(agentId);
      this.states.delete(agentId);
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
    appendFileSync(agentPresetsPath(this.dataDir, projectId), JSON.stringify({ type: "upsert", preset } satisfies PresetEvent) + "\n");
    this.db.insert(agentPresets).values({ ...preset, enabled: preset.enabled ? 1 : 0 }).run(); return preset;
  }
  updateAgentPreset(id: string, patch: UpdateAgentPresetRequest): AgentPresetDto | undefined {
    const current = this.getAgentPreset(id); if (!current) return undefined;
    const next = { ...current, ...patch, model: patch.model === null ? undefined : patch.model ?? current.model, effort: patch.effort === null ? undefined : patch.effort ?? current.effort, updatedAt: new Date().toISOString() } as AgentPresetDto;
    appendFileSync(agentPresetsPath(this.dataDir, current.projectId), JSON.stringify({ type: "upsert", preset: next } satisfies PresetEvent) + "\n");
    this.db.update(agentPresets).set({ ...next, model: next.model ?? null, effort: next.effort ?? null, enabled: next.enabled ? 1 : 0 }).where(eq(agentPresets.id, id)).run(); return next;
  }
  deleteAgentPreset(id: string): boolean {
    const current = this.getAgentPreset(id); if (!current) return false;
    appendFileSync(agentPresetsPath(this.dataDir, current.projectId), JSON.stringify({ type: "delete", id, at: new Date().toISOString() } satisfies PresetEvent) + "\n");
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
    return true;
  }

  appendConversationMessage(
    conversationId: string,
    input: CreateConversationMessageRequest & { directReplyToAuthorAgentId?: string },
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
    const replyTo = input.replyToMessageId
      ? this.conversationReference(conversationId, channel, input.replyToMessageId)
      : undefined;
    if (input.directReplyToAuthorAgentId) {
      if (channel !== "main" || !replyTo || replyTo.authorAgentId !== input.directReplyToAuthorAgentId) {
        throw new Error("direct reply target must be the author of the referenced main-chat message");
      }
      const target = this.getAgent(input.directReplyToAuthorAgentId);
      if (!target || target.archived || !target.conversationIds.includes(conversationId)) {
        throw new Error("direct reply target is not an active agent in this conversation");
      }
    }
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
      ...(replyTo ? { replyTo } : {}),
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
        ...(dispatch.replyTo ? { replyTo: dispatch.replyTo } : {}),
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
      replyTo: dispatch.replyTo,
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
        replyTo: dispatch.replyTo,
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
    return this.projectedConversationMessageDtos(conversationId, projected);
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

  getProjectedConversationMessagePage(
    conversationId: string,
    channel: ConversationChannel,
    input: { limit: number; cursor?: string; focusId?: string },
  ): { messages: ConversationMessageDto[]; hasMore: boolean; cursor?: string } {
    const master = this.getConversation(conversationId);
    if (!master) return { messages: [], hasMore: false };
    const surface = channel === "collaboration" ? "collaboration_view" : "conversation";
    const page = this.readProjectedCommunicationMessagePage(master.projectId, surface, conversationId, input);
    return { ...page, messages: this.projectedConversationMessageDtos(conversationId, page.messages) };
  }

  private projectedConversationMessageDtos(
    conversationId: string,
    projected: ProjectedCommunicationMessage[],
    includeFileActivity = true,
  ): ConversationMessageDto[] {
    const correctedBy = new Map(projected.flatMap((message) => message.correctionOfEventId ? [[message.correctionOfEventId, message.messageId] as const] : []));
    const activityByAgentAndStatus = new Map<string, Map<string, ResponseFileActivityDto[]>>();
    const runsByAgent = new Map<string, AgentRunDto[]>();
    return projected.map((message) => {
      let fileActivity: ResponseFileActivityDto[] | undefined;
      if (includeFileActivity && message.authorAgentId && message.executionId && this.getAgent(message.authorAgentId)) {
        const runs = runsByAgent.get(message.authorAgentId) ?? this.getRuns(message.authorAgentId);
        runsByAgent.set(message.authorAgentId, runs);
        const status: ResponseFileActivityDto["status"] = runs.some((run) =>
          run.id === message.executionId && (run.status === "running" || run.status === "compacting")
        ) ? "in_progress" : "completed";
        const cacheKey = `${message.authorAgentId}:${status}`;
        const byExecution = activityByAgentAndStatus.get(cacheKey)
          ?? this.responseFileActivityByExecution(message.authorAgentId, status);
        activityByAgentAndStatus.set(cacheKey, byExecution);
        fileActivity = byExecution.get(message.executionId);
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
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
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

  private conversationReference(conversationId: string, channel: ConversationChannel, messageId: string) {
    const target = this.getConversationMessages(conversationId, channel).find((message) => message.id === messageId);
    if (!target) throw new Error("reply target was not found in this conversation");
    return {
      messageId: target.id,
      text: target.text,
      role: target.role,
      authorAgentId: target.authorAgentId,
    };
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
    )).get();
    return row ? this.agentRowToDto(row) : undefined;
  }

  listAgents(projectId: string): AgentDto[] {
    return this.db
      .select()
      .from(agents)
      .where(eq(agents.projectId, projectId))
      .all()
      .map((r) => this.agentRowToDto(r));
  }

  getAgent(id: string): AgentDto | undefined {
    return this.rowToAgentDto(id);
  }

  setImportedHistory(agentId: string, source: string, messages: PortableAgentHistoryMessageDto[]): void {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const bounded = messages.map((message) => ({
      role: message.role,
      text: message.text.slice(0, 100_000),
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    }));
    writeJson(importedAgentHistoryPath(this.dataDir, agent.projectId, agent.id), { source: source.slice(0, 240), importedAt: new Date().toISOString(), messages: bounded });
  }

  getImportedHistory(agentId: string): { source: string; importedAt: string; messages: PortableAgentHistoryMessageDto[] } | undefined {
    const agent = this.getAgent(agentId);
    if (!agent) return undefined;
    const file = importedAgentHistoryPath(this.dataDir, agent.projectId, agent.id);
    if (!existsSync(file)) return undefined;
    return readJson(file);
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
    if (!row) return undefined;
    const now = new Date().toISOString();
    const title = patch.title ?? row.title;
    const archived = patch.archived ?? row.archived === 1;
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
      managementPermissions,
      updatedAt: now,
    });
    this.db
      .update(agents)
      .set({
        title,
        archived: archived ? 1 : 0,
        allowAutomaticDescendantDeletion: managementPermissions.allowAutomaticDescendantDeletion ? 1 : 0,
        allowAutomaticDescendantReorganization: managementPermissions.allowAutomaticDescendantReorganization ? 1 : 0,
        updatedAt: now,
      })
      .where(eq(agents.id, id))
      .run();
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
        appendFsyncedJsonl(agentOrganizationEventsPath(this.dataDir, authorization.projectId), eventsToAppend);
        for (const event of eventsToAppend) this.client.prepare(`
          UPDATE agents SET manager_agent_id = ?, updated_at = ? WHERE id = ?
        `).run(event.managerAgentId, event.createdAt, event.agentId);
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
        // selected Agent projection commit or roll back as one unit.
        for (const agent of current.affectedAgents) beforeProjectionDelete?.(agent.id);
        for (const agent of current.affectedAgents) {
          tx.delete(events).where(eq(events.agentId, agent.id)).run();
          tx.delete(artifacts).where(eq(artifacts.agentId, agent.id)).run();
          tx.delete(workItems).where(eq(workItems.agentId, agent.id)).run();
          tx.delete(runs).where(eq(runs.agentId, agent.id)).run();
          this.client.prepare(`DELETE FROM provider_inputs WHERE agent_id = ?`).run(agent.id);
          tx.delete(messages).where(eq(messages.agentId, agent.id)).run();
          tx.delete(agentConversationMemberships).where(eq(agentConversationMemberships.agentId, agent.id)).run();
          tx.delete(agents).where(eq(agents.id, agent.id)).run();
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
    return committedPreview!;
  }

  finishAgentDeletionStorageCleanup(receipt: AgentDeletionReceipt): void {
    if (receipt.storageCleanupCompleted) return;
    const touchedDirectories = new Set<string>();
    for (const agentId of receipt.deletedAgentIds) {
      const row = this.client.prepare(`
        SELECT project_id, tombstone_name FROM agent_deletion_tombstones WHERE agent_id = ?
      `).get(agentId) as { project_id: string; tombstone_name: string } | undefined;
      if (row) {
        const directory = agentsDir(this.dataDir, row.project_id);
        rmSync(join(directory, row.tombstone_name), { recursive: true, force: true });
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
    const runPage = limit === undefined ? undefined : this.getRunPage(id, { limit });
    const workItemPage = limit === undefined ? undefined : this.getWorkItemPage(id, { limit });
    const artifactPage = limit === undefined ? undefined : this.getArtifactPage(id, { limit });
    return {
      agent,
      messages: limit === undefined ? messages : messages.slice(-limit),
      runOutput: runOutputPage?.items ?? this.getRunOutputs(id),
      activity: activityPage?.items ?? this.getActivity(id),
      changedFiles: this.getChangedFiles(id),
      runs: runPage?.items ?? this.getRuns(id),
      workItems: workItemPage?.items ?? this.getWorkItems(id),
      artifacts: artifactPage?.items ?? this.getArtifacts(id),
      state: agent.state,
      ...(limit !== undefined ? {
        history: { limit, hasMore: messages.length > limit },
        telemetryHistory: {
          runOutput: runOutputPage!.history,
          activity: activityPage!.history,
          runs: runPage!.history,
          workItems: workItemPage!.history,
          artifacts: artifactPage!.history,
        },
      } : {}),
    };
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
          replyTo: r.replyToJson ? JSON.parse(r.replyToJson) : undefined,
          attachments: r.attachmentsJson ? JSON.parse(r.attachmentsJson) : undefined,
        } satisfies MessageDto;
      });
  }

  /** Completed ordinary responses are read only from canonical agent_output records. */
  getRunOutputs(agentId: string): RunOutputDto[] {
    const entries: RunOutputDto[] = [];
    const fileActivityByExecution = this.responseFileActivityByExecution(agentId, "completed");
    for (const stored of this.readEvents(agentId)) {
      const { event } = stored;
      if (event.type === "agent_output" && event.text.trim()) {
        const fileActivity = fileActivityByExecution.get(event.executionId) ?? [];
        entries.push({
          id: `${agentId}:runOutput:${stored.seq}`,
          agentId,
          executionId: event.executionId,
          kind: "response",
          text: event.text,
          completed: true,
          seq: stored.seq,
          sourceSeqStart: event.sourceSeqStart,
          sourceSeqEnd: event.sourceSeqEnd,
          createdAt: stored.ts,
          ...(fileActivity.length ? { fileActivity } : {}),
        });
      }
    }
    return entries.sort((a, b) => a.seq - b.seq);
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
    const boundary = focusSeq ?? this.eventSeqBoundary(input.cursor, "agent:runOutput", agentId);
    const rows = this.client.prepare(`
      SELECT seq, payload_json, created_at
      FROM events
      WHERE agent_id = ? AND type = 'agent_output' ${boundary === undefined ? "" : `AND seq ${focusSeq === undefined ? "<" : "<="} ?`}
      ORDER BY seq DESC LIMIT ?
    `).all(...(boundary === undefined ? [agentId, limit + 1] : [agentId, boundary, limit + 1])) as Array<{
      seq: number; payload_json: string; created_at: string;
    }>;
    if (focusSeq !== undefined && rows[0]?.seq !== focusSeq) {
      return { items: [], history: { limit, hasMore: false } };
    }
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const executionIds = new Set(selected.flatMap((row) => {
      const event = JSON.parse(row.payload_json) as LogEvent;
      return event.type === "agent_output" ? [event.executionId] : [];
    }));
    const fileActivityByExecution = this.responseFileActivityByExecution(agentId, "completed", executionIds);
    const items = selected.flatMap((row) => {
      const event = JSON.parse(row.payload_json) as LogEvent;
      if (event.type !== "agent_output" || !event.text.trim()) return [];
      const fileActivity = fileActivityByExecution.get(event.executionId) ?? [];
      return [{
        id: `${agentId}:runOutput:${row.seq}`,
        agentId,
        executionId: event.executionId,
        kind: "response" as const,
        text: event.text,
        completed: true,
        seq: row.seq,
        sourceSeqStart: event.sourceSeqStart,
        sourceSeqEnd: event.sourceSeqEnd,
        createdAt: row.created_at,
        ...(fileActivity.length ? { fileActivity } : {}),
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
            stream: "agent:runOutput", scope: agentId,
            orderKey: String(oldest.seq), rowKey: String(oldest.seq),
          }),
        } : {}),
      },
    };
  }

  /** Execution activity is rebuilt from canonical log events, never from live-only UI state. */
  getActivity(agentId: string): AgentActivityDto[] {
    const activityTypes = new Set([
      "command", "file_change", "test_result", "tool_call", "tool_result", "error",
      "browser_session", "browser_action", "browser_console", "browser_screenshot",
    ]);
    let activeExecutionId: string | undefined;
    const result: AgentActivityDto[] = [];
    for (const stored of this.readEvents(agentId)) {
      const event = stored.event;
      if (event.type === "agent_lifecycle" && (event.status === "running" || event.status === "compacting")) activeExecutionId = event.executionId;
      if (activityTypes.has(event.type)) {
        result.push({
          id: `${agentId}:activity:${stored.seq}`,
          agentId,
          ...("executionId" in event && typeof event.executionId === "string"
            ? { executionId: event.executionId }
            : activeExecutionId ? { executionId: activeExecutionId } : {}),
          seq: stored.seq,
          createdAt: stored.ts,
          event: event as AgentActivityDto["event"],
        });
      }
      if (event.type === "turn_done" || (event.type === "agent_lifecycle" && ["cancelled", "completed", "failed", "interrupted"].includes(event.status))) {
        activeExecutionId = undefined;
      }
    }
    return result;
  }

  private executionIdAtEvent(agentId: string, seq: number, event: LogEvent): string | undefined {
    if ("executionId" in event && typeof event.executionId === "string") return event.executionId;
    const lifecycle = this.client.prepare(`
      SELECT payload_json
      FROM events
      WHERE agent_id = ? AND type = 'agent_lifecycle' AND seq < ?
      ORDER BY seq DESC LIMIT 1
    `).get(agentId, seq) as { payload_json: string } | undefined;
    if (!lifecycle) return undefined;
    const candidate = JSON.parse(lifecycle.payload_json) as LogEvent;
    return candidate.type === "agent_lifecycle" && ["running", "compacting"].includes(candidate.status)
      ? candidate.executionId : undefined;
  }

  private activityDto(agentId: string, row: { seq: number; payload_json: string; created_at: string }): AgentActivityDto | undefined {
    const event = JSON.parse(row.payload_json) as LogEvent;
    const activityTypes = new Set([
      "command", "file_change", "test_result", "tool_call", "tool_result", "error",
      "browser_session", "browser_action", "browser_console", "browser_screenshot",
    ]);
    if (!activityTypes.has(event.type)) return undefined;
    const executionId = this.executionIdAtEvent(agentId, row.seq, event);
    const base: AgentActivityDto = {
      id: `${agentId}:activity:${row.seq}`,
      agentId,
      ...(executionId ? { executionId } : {}),
      seq: row.seq,
      createdAt: row.created_at,
      event: event as AgentActivityDto["event"],
    };
    if (event.type !== "tool_result") return base;
    const totalUtf8Bytes = Buffer.byteLength(event.output, "utf8");
    const previewLimit = 4_096;
    if (totalUtf8Bytes <= previewLimit) return base;
    const preview = Buffer.from(event.output, "utf8").subarray(0, previewLimit).toString("utf8").replace(/\uFFFD$/u, "");
    const previewUtf8Bytes = Buffer.byteLength(preview, "utf8");
    return {
      ...base,
      event: { ...event, output: preview },
      outputPreview: {
        truncated: true,
        previewUtf8Bytes,
        totalUtf8Bytes,
        sha256: createHash("sha256").update(event.output).digest("hex"),
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
      SELECT seq, payload_json, created_at
      FROM events
      WHERE agent_id = ?
        AND type IN ('command', 'file_change', 'test_result', 'tool_call', 'tool_result', 'error',
          'browser_session', 'browser_action', 'browser_console', 'browser_screenshot')
        ${boundary === undefined ? "" : `AND seq ${focusSeq === undefined ? "<" : "<="} ?`}
      ORDER BY seq DESC LIMIT ?
    `).all(...(boundary === undefined ? [agentId, limit + 1] : [agentId, boundary, limit + 1])) as Array<{
      seq: number; payload_json: string; created_at: string;
    }>;
    if (focusSeq !== undefined && rows[0]?.seq !== focusSeq) {
      return { items: [], history: { limit, hasMore: false } };
    }
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected.flatMap((row) => {
      const item = this.activityDto(agentId, row);
      return item ? [item] : [];
    }).reverse();
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

  /** One persistent row per touched path, retaining the latest canonical change and executions. */
  getChangedFiles(agentId: string): ChangedFileDto[] {
    const byPath = new Map<string, ChangedFileDto>();
    const rows = this.client.prepare(`
      SELECT seq, payload_json, created_at FROM events
      WHERE agent_id = ? AND type = 'file_change' ORDER BY seq
    `).all(agentId) as Array<{ seq: number; payload_json: string; created_at: string }>;
    for (const row of rows) {
      const item = this.activityDto(agentId, row);
      if (!item) continue;
      if (item.event.type !== "file_change") continue;
      const previous = byPath.get(item.event.path);
      const executionIds = [...(previous?.executionIds ?? [])];
      if (item.executionId && !executionIds.includes(item.executionId)) executionIds.push(item.executionId);
      byPath.set(item.event.path, {
        path: item.event.path,
        kind: item.event.kind,
        lastSeq: item.seq,
        lastChangedAt: item.createdAt,
        executionIds,
        ...(item.event.diff ? { diff: item.event.diff } : {}),
      });
    }
    return [...byPath.values()].sort((a, b) => a.lastSeq - b.lastSeq);
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
          SELECT id, agent_id, execution_id, kind, path, summary, created_at
          FROM artifacts WHERE agent_id = ? AND execution_id IN (${[...executionFilter].map(() => "?").join(", ")})
          ORDER BY created_at, id
        `).all(agentId, ...executionFilter) as Array<{
          id: string; agent_id: string; execution_id: string | null; kind: string; path: string;
          summary: string | null; created_at: string;
        }>).flatMap((row) => {
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
      ? (this.client.prepare(`
          SELECT seq, payload_json, created_at FROM events
          WHERE agent_id = ? AND type = 'file_change' ORDER BY seq
        `).all(agentId) as Array<{ seq: number; payload_json: string; created_at: string }>)
          .flatMap((row) => {
            const item = this.activityDto(agentId, row);
            return item ? [item] : [];
          })
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
    const agent = this.getAgent(agentId);
    if (!agent) return [];
    const projected = this.readProjectedCommunicationMessages(agent.projectId, "direct_agent_audit", agentId, limit);
    return this.projectedAgentMessageDtos(agentId, projected);
  }

  getProjectedAgentMessagePage(
    agentId: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ): { messages: MessageDto[]; hasMore: boolean; cursor?: string } {
    const agent = this.getAgent(agentId);
    if (!agent) return { messages: [], hasMore: false };
    const page = this.readProjectedCommunicationMessagePage(agent.projectId, "direct_agent_audit", agentId, input);
    return { ...page, messages: this.projectedAgentMessageDtos(agentId, page.messages) };
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
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
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

  getRuns(agentId: string): AgentRunDto[] {
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
        pricingAvailableRuns: 0,
        unpricedRuns: 0,
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
      coverage: finalizedRuns ? reportedRuns / finalizedRuns : null,
      ...(range.from || range.to ? { range } : {}),
      metricAvailability,
      breakdown: [...grouped.values()].sort((a, b) => b.runs - a.runs || a.agentTitle.localeCompare(b.agentTitle)),
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
          pricingAvailable: false,
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
    const eventLog = this.readEvents(agentId);
    const capturedSourcePaths = new Set(eventLog.flatMap((stored) =>
      stored.event.type === "generated_artifact" ? [stored.event.sourcePath] : [],
    ));
    const generatedPdfs = new Map(eventLog.flatMap((stored) =>
      stored.event.type === "file_change" && stored.event.path.toLowerCase().endsWith(".pdf")
        && !capturedSourcePaths.has(stored.event.path)
        ? [[artifactId(agentId, stored.seq, 0), stored.event.path] as const]
        : [],
    ));
    const agent = this.getAgent(agentId);
    const generatedFiles = new Map(eventLog.flatMap((stored) =>
      stored.event.type === "generated_artifact"
        ? [[stored.event.artifactId ?? artifactId(agentId, stored.seq, 0), stored.event] as const]
        : [],
    ));
    const visibility = new Map<string, { visibility: "project" | "published"; pinned: boolean }>();
    for (const stored of eventLog) if (stored.event.type === "artifact_visibility") {
      visibility.set(stored.event.artifactId, { visibility: stored.event.visibility, pinned: stored.event.pinned });
    }
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.agentId, agentId))
      .orderBy(asc(artifacts.createdAt))
      .all()
      .filter((row) => !(row.kind === "diff" && [...capturedSourcePaths].some((source) => row.summary === `create ${source}` || row.summary === `edit ${source}`)))
      .map((r) => {
        const generated = generatedFiles.get(r.id);
        if (generated && agent) {
          const scope = visibility.get(r.id);
          const root = `/api/projects/${encodeURIComponent(agent.projectId)}/agents/${encodeURIComponent(agentId)}/generated-artifacts/${encodeURIComponent(r.id)}`;
          return {
            id: r.id, agentId: r.agentId, executionId: r.executionId ?? undefined,
            kind: "generated_file" as const, path: generated.path, sourcePath: generated.sourcePath,
            summary: generated.name, createdAt: r.createdAt, mediaType: generated.mediaType,
            visibility: scope?.visibility ?? generated.visibility, pinned: scope?.pinned ?? generated.pinned ?? false,
            size: generated.size,
            previewUrl: `${root}/preview`, downloadUrl: `${root}/download`,
          };
        }
        const generatedPath = generatedPdfs.get(r.id);
        if (generatedPath && agent) {
          const root = `/api/projects/${encodeURIComponent(agent.projectId)}/agents/${encodeURIComponent(agentId)}/generated-artifacts/${encodeURIComponent(r.id)}`;
          return {
            id: r.id, agentId: r.agentId, executionId: r.executionId ?? undefined,
            kind: "document" as const, path: generatedPath, summary: generatedPath,
            createdAt: r.createdAt, mediaType: "application/pdf" as const,
            previewUrl: `${root}/preview`, downloadUrl: `${root}/download`,
          };
        }
        if (r.kind === "screenshot" && agent) {
          const root = `/api/projects/${encodeURIComponent(agent.projectId)}/agents/${encodeURIComponent(agentId)}/browser-artifacts/${encodeURIComponent(r.id)}`;
          return {
            id: r.id, agentId: r.agentId, executionId: r.executionId ?? undefined,
            kind: "screenshot" as const, path: r.path, summary: r.summary ?? undefined,
            createdAt: r.createdAt, mediaType: "image/png" as const,
            previewUrl: root, downloadUrl: `${root}?download=1`,
          };
        }
        return {
          id: r.id, agentId: r.agentId, executionId: r.executionId ?? undefined,
          kind: r.kind as ArtifactKind, path: r.path, summary: r.summary ?? undefined,
          createdAt: r.createdAt,
        };
      });
  }

  private artifactDtoFromProjectionRow(agentId: string, row: {
    id: string; agent_id: string; execution_id: string | null; kind: string; path: string;
    summary: string | null; created_at: string;
  }): ArtifactDto | undefined {
    const agent = this.getAgent(agentId);
    if (!agent) return undefined;
    const legacySeqText = row.id.startsWith(`${agentId}:a:`) ? row.id.slice(`${agentId}:a:`.length).split(":", 1)[0] : undefined;
    const legacySeq = legacySeqText && /^\d+$/u.test(legacySeqText) ? Number(legacySeqText) : undefined;
    const generatedRow = this.client.prepare(`
      SELECT payload_json FROM events
      WHERE agent_id = ? AND type = 'generated_artifact'
        AND (json_extract(payload_json, '$.artifactId') = ?
          ${legacySeq === undefined ? "" : "OR (json_extract(payload_json, '$.artifactId') IS NULL AND seq = ?)"})
      ORDER BY seq DESC LIMIT 1
    `).get(...(legacySeq === undefined ? [agentId, row.id] : [agentId, row.id, legacySeq])) as { payload_json: string } | undefined;
    const generated = generatedRow ? JSON.parse(generatedRow.payload_json) as LogEvent : undefined;
    if (generated?.type === "generated_artifact") {
      const visibilityRow = this.client.prepare(`
        SELECT payload_json FROM events
        WHERE agent_id = ? AND type = 'artifact_visibility' AND json_extract(payload_json, '$.artifactId') = ?
        ORDER BY seq DESC LIMIT 1
      `).get(agentId, row.id) as { payload_json: string } | undefined;
      const visibilityEvent = visibilityRow ? JSON.parse(visibilityRow.payload_json) as LogEvent : undefined;
      const root = `/api/projects/${encodeURIComponent(agent.projectId)}/agents/${encodeURIComponent(agentId)}/generated-artifacts/${encodeURIComponent(row.id)}`;
      return {
        id: row.id, agentId: row.agent_id, executionId: row.execution_id ?? undefined,
        kind: "generated_file", path: generated.path, sourcePath: generated.sourcePath,
        summary: generated.name, createdAt: row.created_at, mediaType: generated.mediaType,
        visibility: visibilityEvent?.type === "artifact_visibility" ? visibilityEvent.visibility : generated.visibility,
        pinned: visibilityEvent?.type === "artifact_visibility" ? visibilityEvent.pinned : generated.pinned ?? false,
        size: generated.size, previewUrl: `${root}/preview`, downloadUrl: `${root}/download`,
      };
    }
    if (row.kind === "diff" && row.summary) {
      const sourcePath = /^(?:create|edit) (.+)$/u.exec(row.summary)?.[1];
      if (sourcePath) {
        const captured = this.client.prepare(`
          SELECT 1 FROM events
          WHERE agent_id = ? AND type = 'generated_artifact' AND json_extract(payload_json, '$.sourcePath') = ?
          LIMIT 1
        `).get(agentId, sourcePath);
        if (captured) return undefined;
      }
    }
    if (legacySeq !== undefined) {
      const source = this.client.prepare(`
        SELECT payload_json FROM events WHERE agent_id = ? AND seq = ? AND type = 'file_change'
      `).get(agentId, legacySeq) as { payload_json: string } | undefined;
      const event = source ? JSON.parse(source.payload_json) as LogEvent : undefined;
      if (event?.type === "file_change" && event.path.toLowerCase().endsWith(".pdf")) {
        const root = `/api/projects/${encodeURIComponent(agent.projectId)}/agents/${encodeURIComponent(agentId)}/generated-artifacts/${encodeURIComponent(row.id)}`;
        return {
          id: row.id, agentId: row.agent_id, executionId: row.execution_id ?? undefined,
          kind: "document", path: event.path, summary: event.path, createdAt: row.created_at,
          mediaType: "application/pdf", previewUrl: `${root}/preview`, downloadUrl: `${root}/download`,
        };
      }
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
      SELECT id, agent_id, execution_id, kind, path, summary, created_at
      FROM artifacts
      WHERE agent_id = ?
        ${boundary ? `AND (created_at < ? OR (created_at = ? AND id ${focusBoundary ? "<=" : "<"} ?))` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...(boundary
      ? [agentId, boundary.orderKey, boundary.orderKey, boundary.rowKey, limit + 1]
      : [agentId, limit + 1])) as Array<{
      id: string; agent_id: string; execution_id: string | null; kind: string; path: string;
      summary: string | null; created_at: string;
    }>;
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
    const resolved = new Map<string, ArtifactDto & { projectId: string; originAgentId: string }>();
    for (const event of readRepairableJsonl<ManagedArtifactEvent>(
      managedArtifactsLogPath(this.dataDir, projectId),
      `managed artifacts for project ${projectId}`,
    )) {
      if (event.type === "created") resolved.set(event.artifact.id, event.artifact);
      else if (event.type === "visibility") {
        const current = resolved.get(event.artifactId);
        if (current) resolved.set(event.artifactId, { ...current, visibility: event.visibility, pinned: event.pinned });
      } else resolved.delete(event.artifactId);
    }
    return [...resolved.values()].map((artifact) => {
      const root = `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact.id)}`;
      return { ...artifact, previewUrl: `${root}/preview`, downloadUrl: `${root}/download` };
    }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  /** Bounded Project-wide file/result catalog. SQLite applies the boundary to
   * Agent execution artifacts; the usually-small authored catalog is merged by
   * the same stable key before the response page is formed. */
  getProjectArtifactPage(projectId: string, input: { limit: number; cursor?: string }): HistoryPageDto<ArtifactDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    const boundary = input.cursor ? this.decodeHistoryCursor(input.cursor, "project:artifacts", projectId) : undefined;
    const rows = this.client.prepare(`
      SELECT artifact.id, artifact.agent_id, artifact.execution_id, artifact.kind, artifact.path,
        artifact.summary, artifact.created_at
      FROM artifacts artifact
      JOIN agents agent ON agent.id = artifact.agent_id
      WHERE agent.project_id = ?
        ${boundary ? "AND (artifact.created_at < ? OR (artifact.created_at = ? AND artifact.id < ?))" : ""}
      ORDER BY artifact.created_at DESC, artifact.id DESC LIMIT ?
    `).all(...(boundary
      ? [projectId, boundary.orderKey, boundary.orderKey, boundary.rowKey, limit + 1]
      : [projectId, limit + 1])) as Array<{
      id: string; agent_id: string; execution_id: string | null; kind: string; path: string;
      summary: string | null; created_at: string;
    }>;
    const executionArtifacts = rows.flatMap((row) => {
      const artifact = this.artifactDtoFromProjectionRow(row.agent_id, row);
      return artifact ? [{ ...artifact, projectId }] : [];
    });
    const managed = this.getProjectArtifacts(projectId).filter((artifact) => !boundary ||
      artifact.createdAt < boundary.orderKey || (artifact.createdAt === boundary.orderKey && artifact.id < boundary.rowKey));
    const merged = new Map<string, ArtifactDto>();
    for (const artifact of executionArtifacts) merged.set(artifact.id, artifact);
    for (const artifact of managed) merged.set(artifact.id, artifact);
    const ordered = [...merged.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const hasMore = ordered.length > limit || rows.length > limit;
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
    return this.getProjectArtifacts(projectId).find((artifact) => artifact.id === artifactIdValue);
  }

  recordProjectArtifact(artifact: ArtifactDto & { projectId: string; originAgentId: string }): void {
    if (!this.getProject(artifact.projectId)) throw new Error("artifact project not found");
    if (artifact.kind === "generated_file" &&
        (!artifact.summary?.trim() || !artifact.mediaType?.trim() || artifact.size === undefined ||
          !Number.isSafeInteger(artifact.size) || artifact.size < 1 || !/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? ""))) {
      throw new Error("generated artifact immutable metadata is required");
    }
    appendFsyncedJsonl(managedArtifactsLogPath(this.dataDir, artifact.projectId), [{ type: "created", artifact } satisfies ManagedArtifactEvent]);
  }

  deleteProjectArtifact(projectId: string, artifactIdValue: string, reason: string): boolean {
    if (!this.getProjectArtifact(projectId, artifactIdValue)) return false;
    appendFsyncedJsonl(managedArtifactsLogPath(this.dataDir, projectId), [{
      type: "deleted", artifactId: artifactIdValue, at: new Date().toISOString(), reason: reason.slice(0, 240),
    } satisfies ManagedArtifactEvent]);
    return true;
  }

  updateProjectArtifactVisibility(
    projectId: string,
    artifactIdValue: string,
    visibility: "project" | "published",
    pinned: boolean,
  ): ArtifactDto | undefined {
    if (!this.getProjectArtifact(projectId, artifactIdValue)) return undefined;
    appendFsyncedJsonl(managedArtifactsLogPath(this.dataDir, projectId), [{
      type: "visibility", artifactId: artifactIdValue, visibility, pinned, at: new Date().toISOString(),
    } satisfies ManagedArtifactEvent]);
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
    const r = this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .get();
    if (!r || r.agentId !== agentId) return undefined;
    return {
      id: r.id,
      agentId: r.agentId,
      executionId: r.executionId ?? undefined,
      kind: r.kind as ArtifactKind,
      path: r.path,
      summary: r.summary ?? undefined,
      createdAt: r.createdAt,
    };
  }

  // ─── Event log (append-only) + projection ──────────────────────────────────

  /**
   * Append one event to an agent's canonical log AND update its projections.
   * The log write happens (and fsyncs) BEFORE the projection, so the log is always
   * complete for replay (SPEC §8: log write before broadcast). Returns the stored
   * event (seq + ts) so the caller can broadcast it over SSE.
   */
  appendEvent(agentId: string, event: LogEvent): StoredLogEvent {
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
    return this.logFor(agentId, this.projectIdOf(agentId)).readSince(sinceSeq);
  }

  lastSeqOf(agentId: string): number {
    const evs = this.readEvents(agentId);
    return evs.length === 0 ? 0 : (evs[evs.length - 1]?.seq ?? 0);
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
      rmSync(join(directory, row.tombstoneName), { recursive: true, force: true });
      // A committed journal row is authoritative even if a filesystem rollback
      // resurrected the canonical name after the SQLite commit.
      rmSync(agentDir(this.dataDir, row.projectId, row.agentId), { recursive: true, force: true });
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

  rebuildProjections(): void {
    this.recoverAgentDeletionDirectories();
    this.client.prepare(`DELETE FROM tool_output_projection`).run();
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
      for (const event of readJsonLines<PresetEvent>(agentPresetsPath(this.dataDir, projectId))) event.type === "upsert" ? resolved.set(event.preset.id, event.preset) : resolved.delete(event.id);
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
      }
      this.sanitizeOrganizationProjection(projectId);
    }
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
      if (op.kind === "insert_artifact" && op.content !== undefined) {
        const target = artifactContentPath(this.dataDir, projectId, agentId, op.row.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, op.content, "utf8");
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
            if (op.row.type === "tool_result") {
              const event = JSON.parse(op.row.payloadJson) as LogEvent;
              if (event.type === "tool_result") {
                const output = Buffer.from(event.output, "utf8");
                this.client.prepare(`
                  INSERT OR IGNORE INTO tool_output_projection
                    (agent_id, seq, output, total_utf8_bytes, sha256)
                  VALUES (?, ?, ?, ?, ?)
                `).run(agentId, op.row.seq, output, output.length, createHash("sha256").update(output).digest("hex"));
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
      archived: row.archived === 1,
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
    reason: "explicit_compaction" | "resume_compaction_failed" | "request_context_rollover" | "tool_contract_changed",
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
