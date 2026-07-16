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
  CommunicationDocumentRecord,
  CommunicationDocumentReference,
  CommunicationContextClassification,
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
  WorkItemDto,
  WorkItemStatus,
  AgentLifecycleReason,
  AgentRunStatus,
  AgentDetailDto,
  AgentDto,
  AgentState,
  TokenUsageSummaryDto,
  TokenUsageBreakdownDto,
  TokenUsageMetric,
  TokenUsageRangeDto,
  TokenUsage,
  RunOutputDto,
  UpdateProjectRequest,
  UpdateAgentConversationMembershipsRequest,
  UpdateConversationRequest,
  UpdateAgentRequest,
  UpdateAgentOrganizationRequest,
} from "@ponderosa/core";
import { communicationHasProjectionTarget, deriveCommunicationBehavior } from "@ponderosa/core";

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

function unifiedDiffTotals(diff: string | undefined): { additions: number; deletions: number } | undefined {
  if (!diff) return undefined;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return additions || deletions ? { additions, deletions } : undefined;
}
import {
  artifacts,
  agentPresets,
  events,
  conversations,
  messages,
  projects,
  runs,
  workItems,
  agents,
  agentConversationMemberships,
} from "./schema.js";
import {
  artifactsDir,
  artifactContentPath,
  attachmentsDir,
  dbPath,
  eventsPath,
  conversationDir,
  communicationEventsPath,
  communicationContextPath,
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
  agentsDir,
} from "./paths.js";

interface ProjectJson {
  id: string;
  label: string;
  hostPath: string;
  createdAt: string;
  lastUsedAt?: string;
  defaultEngine: string;
  lastConversationId?: string;
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
  replyTo?: import("@ponderosa/core").MessageReferenceDto;
  attachments?: import("@ponderosa/core").ImageAttachmentDto[];
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
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
  private readonly contextClassificationCache = new Map<string, Map<string, CommunicationContextClassification>>();
  private readonly communicationProjectionCache = new Map<string, {
    projections: CommunicationProjection[];
    byTuple: Map<string, CommunicationProjection>;
  }>();
  private readonly messageDispatchCache = new Map<string, MessageDispatchRecord[]>();

  constructor(private readonly dataDir: string) {
    ensureV1Layout(dataDir);
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(projectsDir(dataDir), { recursive: true });
    this.deliverySequenceFile = `${dataDir}/delivery-order.jsonl`;
    this.deliverySequence = readJsonLines<{ sequence: number }>(this.deliverySequenceFile)
      .reduce((maximum, record) => Math.max(maximum, record.sequence), 0);
    const opened = openDb(dbPath(dataDir));
    this.db = opened.db;
    this.client = opened.client;
    // Canonical files are written before their SQLite projections. Rebuilding
    // on startup closes the crash window where a durable append succeeded but
    // the projection write did not, and keeps every read path deterministic.
    this.rebuildProjections();
    for (const project of this.listProjects()) this.ensureCommunicationProjectionLedger(project.id);
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

  private contextIndex(projectId: string): Map<string, CommunicationContextClassification> {
    let cached = this.contextClassificationCache.get(projectId);
    if (cached) return cached;
    const records = readRepairableJsonl<CommunicationContextClassification>(communicationContextPath(this.dataDir, projectId), "communication context log", true);
    cached = new Map(records.map((record) => [record.eventId, record]));
    this.contextClassificationCache.set(projectId, cached);
    return cached;
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
      if (event.sender.kind !== "agent" || event.document.authorAgentId !== event.sender.agentId ||
          event.document.executionId !== event.sender.executionId || event.document.mediaType !== "text/markdown" ||
          !event.document.id || !event.document.title.trim() || !event.document.content.trim() ||
          event.document.byteLength !== Buffer.byteLength(event.document.content, "utf8")) {
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
    const behavior = deriveCommunicationBehavior(event);
    const classification: CommunicationContextClassification = {
      eventId: event.eventId,
      policy: behavior.contextPolicy,
      classifiedAt: event.createdAt,
      classifiedBy: { kind: "system", component: "communication-router" },
    };
    const index = this.communicationIndex(event.projectId);
    const idempotent = event.idempotencyKey
      ? index.byIdempotency.get(`${JSON.stringify(event.sender)}\u0000${event.idempotencyKey}`) : undefined;
    if (idempotent) {
      const equivalent = idempotent.projectId === event.projectId && idempotent.conversationId === event.conversationId &&
        idempotent.intent === event.intent && JSON.stringify(idempotent.audience) === JSON.stringify(event.audience) &&
        idempotent.text === event.text && JSON.stringify(idempotent.attachments) === JSON.stringify(event.attachments) &&
        JSON.stringify(idempotent.document) === JSON.stringify(event.document);
      if (!equivalent) throw new Error("communication idempotency collision");
      this.appendContextClassification(event.projectId, {
        eventId: idempotent.eventId,
        policy: deriveCommunicationBehavior(idempotent).contextPolicy,
        classifiedAt: idempotent.createdAt,
        classifiedBy: { kind: "system", component: "communication-router" },
      });
      this.ensureCommunicationBehaviorProjections(idempotent);
      return { event: idempotent, replayed: true };
    }
    const existing = index.byId.get(event.eventId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) throw new Error("communication event ID collision");
      this.appendContextClassification(event.projectId, classification);
      this.ensureCommunicationBehaviorProjections(existing);
      return { event: existing, replayed: true };
    }
    appendFsyncedJsonl(file, [event]);
    index.events.push(event);
    index.byId.set(event.eventId, event);
    if (event.idempotencyKey) index.byIdempotency.set(`${JSON.stringify(event.sender)}\u0000${event.idempotencyKey}`, event);
    this.appendContextClassification(event.projectId, classification);
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
    return event?.document ? { event, document: event.document } : undefined;
  }

  private appendContextClassification(projectId: string, classification: CommunicationContextClassification): void {
    const file = communicationContextPath(this.dataDir, projectId);
    const index = this.contextIndex(projectId);
    const existing = index.get(classification.eventId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(classification)) throw new Error("communication context classification collision");
      return;
    }
    appendFsyncedJsonl(file, [classification]);
    index.set(classification.eventId, classification);
  }

  readContextClassifications(projectId: string): CommunicationContextClassification[] {
    if (!this.getProject(projectId)) throw new Error("communication project not found");
    return [...this.contextIndex(projectId).values()];
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
      return { projection: existing, replayed: true };
    }
    appendFsyncedJsonl(file, [projection]);
    index.projections.push(projection);
    index.byTuple.set(tuple, projection);
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
  ): ProjectedCommunicationMessage[] {
    const events = this.communicationIndex(projectId).byId;
    return this.projectionIndex(projectId).projections
      .filter((projection) => projection.surface === surface && projection.projectionKey === projectionKey &&
        projection.message && this.communicationProjectionAllowed(projectId, projection))
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
        return [{
          eventId: event.eventId, surface, projectionKey, messageId: message.messageId,
          role: canonicalRole, text: message.renderedText ?? event.text, createdAt: message.createdAt,
          ...(message.orderKey ? { orderKey: message.orderKey } : {}),
          ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
          ...(canonicalAuthorAgentId ? { authorAgentId: canonicalAuthorAgentId } : {}),
          ...(event.sender.kind === "agent" ? { executionId: event.sender.executionId } : {}),
          ...(event.correctionOfEventId ? { correctionOfEventId: event.correctionOfEventId } : {}),
          ...(message.attachmentIds?.length ? { attachmentIds: message.attachmentIds } : {}),
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          ...(event.document ? { document: communicationDocumentReference(projectId, event.document) } : {}),
          ...(event.citations?.length ? { citations: event.citations } : {}),
        }];
      })
      .sort((a, b) => (a.orderKey ?? a.createdAt).localeCompare(b.orderKey ?? b.createdAt));
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

  /** Verify that canonical events, classifications, and projections agree. */
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
    const classifiedIds = new Set(this.readContextClassifications(projectId).map((item) => item.eventId));
    const missingClassificationEventIds = canonical
      .filter((event) => !classifiedIds.has(event.eventId)).map((event) => event.eventId);
    const missingProjectionMetadataEventIds = [...new Set(projections
      .filter((projection) => (projection.surface === "conversation" || projection.surface === "collaboration_view" || projection.surface === "direct_agent_audit") && !projection.message)
      .map((projection) => projection.eventId))];
    return {
      projectId,
      canonicalEvents: canonical.length,
      linkedProjections: projections.length,
      missingProjectionEventIds,
      duplicateProjectionEventIds,
      orphanProjectionEventIds,
      missingClassificationEventIds,
      missingProjectionMetadataEventIds,
      ok: missingProjectionEventIds.length === 0 && duplicateProjectionEventIds.length === 0 &&
        orphanProjectionEventIds.length === 0 && missingClassificationEventIds.length === 0 &&
        missingProjectionMetadataEventIds.length === 0,
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
      lastConversationId: conversationId,
    };
    const conversation: ConversationJson = {
      id: conversationId, projectId: id, title: "New Chat", defaultEngine,
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
        tx.insert(projects).values({ id, label: input.label, hostPath: input.hostPath, createdAt: now, lastUsedAt: now, defaultEngine, lastConversationId: conversationId }).run();
        tx.insert(conversations).values({ id: conversationId, projectId: id, title: "New Chat", defaultEngine, defaultModel: null, defaultEffort: null, createdAt: now, updatedAt: now, archived: 0 }).run();
      });
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true });
      rmSync(projectDir(this.dataDir, id), { recursive: true, force: true });
      throw error;
    }
    for (const preset of BUILTIN_PRESETS) this.createAgentPreset(id, preset);
    return { id, label: input.label, hostPath: input.hostPath, createdAt: now, lastUsedAt: now, defaultEngine, lastConversationId: conversationId };
  }

  updateProject(id: string, input: UpdateProjectRequest): ProjectDto | undefined {
    const current = this.getProject(id);
    if (!current) return undefined;
    const label = input.label.trim();
    if (!label) throw new Error("project label is required");
    const record: ProjectJson = { ...current, label };
    writeJson(projectJsonPath(this.dataDir, id), record);
    this.db.update(projects).set({ label }).where(eq(projects.id, id)).run();
    return { ...current, label };
  }

  /** Permanently remove the canonical project tree and every rebuildable projection. */
  deleteProject(id: string): boolean {
    const current = this.getProject(id);
    if (!current) return false;
    const agentIds = this.listAgents(id).map((agent) => agent.id);
    rmSync(projectDir(this.dataDir, id), { recursive: true, force: true });
    this.communicationEventCache.delete(id);
    this.contextClassificationCache.delete(id);
    this.communicationProjectionCache.delete(id);
    this.messageDispatchCache.delete(id);
    for (const agentId of agentIds) {
      this.logs.delete(agentId);
      this.states.delete(agentId);
    }
    this.rebuildProjections();
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
        lastConversationId: r.lastConversationId ?? undefined,
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
      lastConversationId: r.lastConversationId ?? undefined,
    };
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
  deleteConversation(id: string): boolean {
    const row = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!row) return false;
    const linkedAgents = this.listAgents(row.projectId).filter((agent) => agent.conversationIds.includes(id));
    this.db.transaction((tx) => {
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

  getConversationMessageDeliveryOrderKey(conversationId: string, messageId: string): string | undefined {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return undefined;
    return this.messageDispatches(conversation.projectId)
      .find((dispatch) => dispatch.conversationId === conversationId && dispatch.messageId === messageId)?.orderKey;
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
  ): ConversationMessageDto[] {
    const master = this.getConversation(conversationId);
    if (!master) return [];
    const surface = channel === "collaboration" ? "collaboration_view" : "conversation";
    const projected = this.readProjectedCommunicationMessages(master.projectId, surface, conversationId);
    const correctedBy = new Map(projected.flatMap((message) => message.correctionOfEventId ? [[message.correctionOfEventId, message.messageId] as const] : []));
    return projected.map((message) => {
      const fileActivity = message.authorAgentId && message.executionId && this.getAgent(message.authorAgentId)
        ? this.getChangedFiles(message.authorAgentId)
          .filter((file) => file.executionIds.includes(message.executionId!))
          .map((file) => {
            const totals = unifiedDiffTotals(file.diff);
            return {
              path: file.path,
              kind: file.kind,
              status: "completed" as const,
              ...(totals ? totals : {}),
            };
          })
        : undefined;
      return {
        id: message.messageId,
        communicationEventId: message.eventId,
        conversationId,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        ...(message.authorAgentId ? { authorAgentId: message.authorAgentId } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        ...(message.document ? { document: message.document } : {}),
        ...(message.citations?.length ? { citations: message.citations } : {}),
        ...(message.executionId ? { executionId: message.executionId } : {}),
        ...(fileActivity ? { fileActivity } : {}),
        ...(message.correctionOfEventId ? { correctionOfMessageId: message.correctionOfEventId } : {}),
        ...(correctedBy.has(message.eventId) ? { correctedByMessageId: correctedBy.get(message.eventId) } : {}),
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

  updateAgent(id: string, patch: UpdateAgentRequest): AgentDto | undefined {
    const row = this.db.select().from(agents).where(eq(agents.id, id)).get();
    if (!row) return undefined;
    const now = new Date().toISOString();
    const title = patch.title ?? row.title;
    const archived = patch.archived ?? row.archived === 1;
    if (archived && row.archived !== 1) {
      for (const child of this.listAgents(row.projectId).filter((agent) => agent.managerAgentId === id)) {
        this.updateAgentOrganization(child.id, { managerAgentId: null });
      }
      if (this.getAgent(id)?.managerAgentId) this.updateAgentOrganization(id, { managerAgentId: null });
    }
    this.db
      .update(agents)
      .set({ title, archived: archived ? 1 : 0, updatedAt: now })
      .where(eq(agents.id, id))
      .run();
    // Keep the on-disk metadata (source of truth for these fields) in sync.
    const json = readJson<AgentJson>(agentJsonPath(this.dataDir, row.projectId, id));
    writeJson(agentJsonPath(this.dataDir, row.projectId, id), {
      ...json,
      title,
      archived,
      updatedAt: now,
    });
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

  readAgentOrganizationEvents(projectId: string): AgentOrganizationEvent[] {
    if (!this.getProject(projectId)) throw new Error("organization project not found");
    return readRepairableJsonl<AgentOrganizationEvent>(
      agentOrganizationEventsPath(this.dataDir, projectId), "agent organization log", true,
    );
  }

  updateAgentConversationMemberships(
    id: string,
    input: UpdateAgentConversationMembershipsRequest,
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
    this.persistAgentMemberships(id, ids, input.primaryConversationId);
    return this.getAgent(id);
  }

  /**
   * Permanently delete an agent: its projection rows AND its on-disk canonical
   * log directory (`agent.json`, `events.jsonl`, artifacts, attachments). This is
   * a whole-agent removal — a deliberate user action, distinct from the
   * append-only rule (which forbids mutating events *within* a live agent, not
   * discarding an entire agent). Returns false if the agent didn't exist.
   */
  deleteAgent(id: string, beforeProjectionDelete?: (agentId: string) => void): boolean {
    const row = this.db.select().from(agents).where(eq(agents.id, id)).get();
    if (!row) return false;

    for (const child of this.listAgents(row.projectId).filter((agent) => agent.managerAgentId === id)) {
      this.deleteAgent(child.id, beforeProjectionDelete);
    }

    this.db.transaction((tx) => {
      // Coordination V3 uses the same underlying SQLite connection. Its nested
      // transaction is a savepoint, so join cancellation, recipient outcomes,
      // pending-activation invalidation, and the agent projection deletion
      // commit or roll back together.
      beforeProjectionDelete?.(id);
      tx.delete(events).where(eq(events.agentId, id)).run();
      tx.delete(artifacts).where(eq(artifacts.agentId, id)).run();
      tx.delete(workItems).where(eq(workItems.agentId, id)).run();
      tx.delete(runs).where(eq(runs.agentId, id)).run();
      tx.delete(messages).where(eq(messages.agentId, id)).run();
      tx.delete(agentConversationMemberships).where(eq(agentConversationMemberships.agentId, id)).run();
      tx.delete(agents).where(eq(agents.id, id)).run();
    });

    // Remove the on-disk agent directory (the canonical log lives here).
    rmSync(agentDir(this.dataDir, row.projectId, id), { recursive: true, force: true });

    // Drop any cached log writer / projection state.
    this.logs.delete(id);
    this.states.delete(id);
    return true;
  }

  /** Full agent-detail hydration for GET /api/agents/:id (SPEC §8). */
  getAgentDetail(id: string): AgentDetailDto | undefined {
    const agent = this.rowToAgentDto(id);
    if (!agent) return undefined;
    return {
      agent,
      messages: this.getMessages(id),
      runOutput: this.getRunOutputs(id),
      activity: this.getActivity(id),
      changedFiles: this.getChangedFiles(id),
      runs: this.getRuns(id),
      workItems: this.getWorkItems(id),
      artifacts: this.getArtifacts(id),
      state: agent.state,
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
    for (const stored of this.readEvents(agentId)) {
      const { event } = stored;
      if (event.type === "agent_output" && event.text.trim()) {
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
        });
      }
    }
    return entries.sort((a, b) => a.seq - b.seq);
  }

  /** Execution activity is rebuilt from canonical log events, never from live-only UI state. */
  getActivity(agentId: string): AgentActivityDto[] {
    const activityTypes = new Set(["command", "file_change", "test_result", "tool_call", "tool_result", "error"]);
    let activeExecutionId: string | undefined;
    const result: AgentActivityDto[] = [];
    for (const stored of this.readEvents(agentId)) {
      const event = stored.event;
      if (event.type === "agent_lifecycle" && event.status === "running") activeExecutionId = event.executionId;
      if (activityTypes.has(event.type)) {
        result.push({
          id: `${agentId}:activity:${stored.seq}`,
          agentId,
          ...(activeExecutionId ? { executionId: activeExecutionId } : {}),
          seq: stored.seq,
          createdAt: stored.ts,
          event: event as AgentActivityDto["event"],
        });
      }
      if (event.type === "turn_done" || (event.type === "agent_lifecycle" && event.status !== "running")) {
        activeExecutionId = undefined;
      }
    }
    return result;
  }

  /** One persistent row per touched path, retaining the latest canonical change and executions. */
  getChangedFiles(agentId: string): ChangedFileDto[] {
    const byPath = new Map<string, ChangedFileDto>();
    for (const item of this.getActivity(agentId)) {
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

  getProjectedAgentMessages(agentId: string): MessageDto[] {
    const agent = this.getAgent(agentId);
    if (!agent) return [];
    return this.readProjectedCommunicationMessages(agent.projectId, "direct_agent_audit", agentId)
      .flatMap((message) => {
        if (message.sequence === undefined || message.role === "system") return [];
        return [{
          id: message.messageId,
          communicationEventId: message.eventId,
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

  getRuns(agentId: string): AgentRunDto[] {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.agentId, agentId))
      .orderBy(asc(runs.startedAt))
      .all()
      .map((r) => ({
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
      }));
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

  getArtifacts(agentId: string): ArtifactDto[] {
    const generatedPdfs = new Map(this.readEvents(agentId).flatMap((stored) =>
      stored.event.type === "file_change" && stored.event.path.toLowerCase().endsWith(".pdf")
        ? [[artifactId(agentId, stored.seq, 0), stored.event.path] as const]
        : [],
    ));
    const agent = this.getAgent(agentId);
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.agentId, agentId))
      .orderBy(asc(artifacts.createdAt))
      .all()
      .map((r) => {
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
        return {
          id: r.id, agentId: r.agentId, executionId: r.executionId ?? undefined,
          kind: r.kind as ArtifactKind, path: r.path, summary: r.summary ?? undefined,
          createdAt: r.createdAt,
        };
      });
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
  rebuildProjections(): void {
    this.db.delete(events).run();
    this.db.delete(artifacts).run();
    this.db.delete(workItems).run();
    this.db.delete(runs).run();
    this.db.delete(messages).run();
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
        rmSync(artifactsDir(this.dataDir, projectId, agentId), {
          recursive: true,
          force: true,
        });
        mkdirSync(artifactsDir(this.dataDir, projectId, agentId), { recursive: true });
        if (!existsSync(logFile)) continue;
        const stored = new EventLog(logFile).readAll();
        const ops = projectAll(agentId, stored, t.activeEngine);
        this.applyOps(agentId, projectId, ops);
      }
      this.sanitizeOrganizationProjection(projectId);
    }
  }

  close(): void {
    this.client.close();
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
              .set({ activeSessionId: op.sessionId })
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
      spawnedByAgentId: row.spawnedByAgentId ?? undefined,
      spawnedByExecutionId: row.spawnedByExecutionId ?? undefined,
      spawnPrompt: row.spawnPrompt ?? undefined,
      presetSnapshot: row.presetSnapshotJson ? JSON.parse(row.presetSnapshotJson) as AgentDto["presetSnapshot"] : undefined,
    };
  }


  private persistAgentMemberships(id: string, conversationIds: string[], primaryConversationId?: string): void {
    const row = this.db.select().from(agents).where(eq(agents.id, id)).get();
    if (!row) throw new Error(`unknown agent: ${id}`);
    const now = new Date().toISOString();
    const jsonPath = agentJsonPath(this.dataDir, row.projectId, id);
    const json = readJson<AgentJson>(jsonPath);
    // Canonical metadata is committed first; SQLite remains a rebuildable projection.
    writeJson(jsonPath, { ...json, conversationId: primaryConversationId, conversationIds, updatedAt: now });
    this.db.transaction((tx) => {
      tx.delete(agentConversationMemberships).where(eq(agentConversationMemberships.agentId, id)).run();
      conversationIds.forEach((conversationId, position) => {
        tx.insert(agentConversationMemberships).values({ agentId: id, conversationId, position }).run();
      });
      tx.update(agents).set({ conversationId: primaryConversationId ?? null, updatedAt: now }).where(eq(agents.id, id)).run();
    });
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

  /** The engine session id to resume for an agent (undefined if none yet). */
  resumeSessionId(agentId: string): string | undefined {
    const row = this.db
      .select({
        sessionId: agents.activeSessionId,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();
    if (!row) return undefined;
    return row.sessionId ?? undefined;
  }

  /**
   * Forget only the provider runtime session so the next turn seeds a fresh
   * session from canonical history. Agent identity, memberships, event logs,
   * and queued collaboration deliveries are intentionally untouched.
   */
  clearResumeSession(
    agentId: string,
    reason: "explicit_compaction" | "resume_compaction_failed" | "request_context_rollover",
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
