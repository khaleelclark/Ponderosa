// ThreadStore — the library that apps/server consumes. Ties together the on-disk
// event logs (source of truth), the SQLite projections, and the pure projectors.
// Exposes NO HTTP (SPEC §7). SQLite is never a source of truth: everything here is
// derivable from the logs + the *.json files, and `rebuildProjections()` proves it.

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
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
  CreateThreadRequest,
  ConversationDetailDto,
  ConversationChannel,
  ConversationDto,
  ConversationMessageDto,
  MessageDto,
  ProjectDto,
  TaskDto,
  TaskStatus,
  ThreadDetailDto,
  ThreadDto,
  ThreadState,
  RunOutputDto,
  UpdateProjectRequest,
  UpdateThreadConversationMembershipsRequest,
  UpdateConversationRequest,
  UpdateThreadRequest,
  UpdateAgentOrganizationRequest,
} from "@ponderosa/core";
import { communicationHasProjectionTarget, deriveCommunicationBehavior } from "@ponderosa/core";

function communicationDocumentReference(projectId: string, document: CommunicationDocumentRecord): CommunicationDocumentReference {
  const { content: _content, ...metadata } = document;
  const root = `/api/projects/${encodeURIComponent(projectId)}/communication-documents/${encodeURIComponent(document.id)}`;
  return { ...metadata, previewUrl: root, downloadUrl: `${root}/download` };
}
import { openDb, type Db } from "./db.js";
import type Database from "better-sqlite3";
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
import {
  artifacts,
  agentPresets,
  events,
  conversationMessages,
  conversations,
  messages,
  projects,
  tasks,
  threads,
  threadConversationMemberships,
} from "./schema.js";
import {
  artifactsDir,
  artifactContentPath,
  attachmentsDir,
  dbPath,
  eventsPath,
  conversationDir,
  collaborationMessagesPath,
  communicationEventsPath,
  communicationContextPath,
  communicationProjectionsPath,
  conversationJsonPath,
  conversationMessagesPath,
  conversationsDir,
  projectJsonPath,
  agentPresetsPath,
  agentOrganizationEventsPath,
  projectsDir,
  projectDir,
  threadDir,
  threadJsonPath,
  threadsDir,
} from "./paths.js";

interface ProjectJson {
  id: string;
  label: string;
  hostPath: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface ThreadJson {
  id: string;
  projectId: string;
  conversationId?: string;
  conversationIds?: string[];
  title: string;
  activeEngine: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  spawnedByAgentId?: string;
  spawnedByExecutionId?: string;
  spawnPrompt?: string;
  spawnIdempotencyKey?: string;
  presetSnapshot?: ThreadDto["presetSnapshot"];
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
  targetThreadId: string;
  relayDepth: number;
  mentionTrail: string[];
  kind: "direct" | "tag";
  /** The selector that authorized this recipient when the message was recorded. */
  audience?: "mention" | "everyone";
  /** Target-owned staged assets delivered with this recipient turn. */
  attachmentIds?: string[];
}

interface ConversationMessageJson {
  id: string;
  communicationEventId?: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  authorThreadId?: string | null;
  channel?: ConversationChannel;
  deliveryIntents?: ConversationDeliveryIntent[];
  messageReceiptKey?: string;
  deliveryOrderKey?: string;
  replyTo?: import("@ponderosa/core").MessageReferenceDto;
  directReplyToAuthorThreadId?: string;
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

function communicationMessageProjection(threadId: string, stored: StoredLogEvent): CommunicationProjection["message"] | undefined {
  const event = stored.event;
  if (event.type === "user_message") return {
    messageId: projectedMessageId(threadId, stored.seq), role: "user", renderedText: event.text, createdAt: stored.ts, sequence: stored.seq,
    ...(event.replyTo ? { replyToLegacyMessageId: event.replyTo.messageId } : {}),
    ...(event.attachments?.length ? { attachmentIds: event.attachments.map((item) => item.id) } : {}),
    ...(event.replyTo ? { replyTo: event.replyTo } : {}),
    ...(event.attachments?.length ? { attachments: event.attachments } : {}),
  };
  if (event.type === "communication_projection") return {
    messageId: projectedMessageId(threadId, stored.seq), role: event.role ?? "assistant", renderedText: event.text, createdAt: stored.ts, sequence: stored.seq,
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

export class ThreadStore {
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

  constructor(private readonly dataDir: string) {
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
    for (const project of this.listProjects()) this.repairCommunicationProjectionLedger(project.id);
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
    if (!event.eventId || !event.text.trim() || !event.createdAt) throw new Error("communication event is incomplete");
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
      const agent = this.getThread(agentId);
      if (!agent || agent.projectId !== event.projectId || agent.archived) throw new Error("communication recipient must be an active agent in its project");
      if (event.conversationId && !agent.conversationIds.includes(event.conversationId)) throw new Error("communication recipient must belong to its conversation");
    }
    if (event.schemaVersion === 2 && event.intent === "collaboration") {
      if (event.sender.kind === "agent") {
        const sender = this.getThread(event.sender.agentId);
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
        idempotent.text === event.text && JSON.stringify(idempotent.document) === JSON.stringify(event.document);
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
        const thread = this.getThread(projection.projectionKey);
        return Boolean(thread && thread.projectId === projectId && !thread.archived);
      }
      return true;
    }
    // Replay-only bridge for the pre-RunTrigger representation of an unscoped
    // user request. No new API should rely on rendered text to authorize scope.
    const behavior = deriveCommunicationBehavior(event);
    if (projection.surface === "direct_agent_audit" && behavior.permitsLegacyUserBroadcastRunAudit) {
      const thread = this.getThread(projection.projectionKey);
      return Boolean(thread && thread.projectId === projectId && !thread.archived &&
        projection.message?.role === "user" && projection.message.renderedText === event.text);
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
          ...(!existing.message.replyToLegacyMessageId && projection.message.replyToLegacyMessageId
            ? { replyToLegacyMessageId: projection.message.replyToLegacyMessageId }
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
          ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
          ...(canonicalAuthorAgentId ? { authorAgentId: canonicalAuthorAgentId } : {}),
          ...(message.replyToLegacyMessageId ? { replyToLegacyMessageId: message.replyToLegacyMessageId } : {}),
          ...(message.attachmentIds?.length ? { attachmentIds: message.attachmentIds } : {}),
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          ...(event.document ? { document: communicationDocumentReference(projectId, event.document) } : {}),
        }];
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.eventId.localeCompare(b.eventId));
  }

  private repairCommunicationProjectionLedger(projectId: string): void {
    const canonicalEvents = this.readCommunicationEvents(projectId);
    for (const event of canonicalEvents) this.ensureCommunicationBehaviorProjections(event);
    const canonicalIds = new Set(canonicalEvents.map((event) => event.eventId));
    if (canonicalIds.size === 0) return;
    for (const master of this.listConversations(projectId)) {
      for (const [surface, file] of [
        ["conversation", conversationMessagesPath(this.dataDir, projectId, master.id)],
        ["collaboration_view", collaborationMessagesPath(this.dataDir, projectId, master.id)],
      ] as const) {
        for (const message of readJsonLines<ConversationMessageJson>(file)) {
          if (message.communicationEventId && canonicalIds.has(message.communicationEventId)) {
            this.appendCommunicationProjection(projectId, {
              eventId: message.communicationEventId, surface, projectionKey: master.id, projectedAt: message.createdAt,
              message: {
                messageId: message.id, role: message.role, renderedText: message.text, createdAt: message.createdAt,
                ...(message.authorThreadId ? { authorAgentId: message.authorThreadId } : {}),
                ...(message.replyTo ? { replyToLegacyMessageId: message.replyTo.messageId } : {}),
                ...(message.attachments?.length ? { attachmentIds: message.attachments.map((item) => item.id) } : {}),
                ...(message.replyTo ? { replyTo: message.replyTo } : {}),
                ...(message.attachments?.length ? { attachments: message.attachments } : {}),
              },
            });
          }
        }
      }
    }
    for (const thread of this.listThreads(projectId)) {
      for (const stored of this.readEvents(thread.id)) {
        const eventId = stored.event.type === "communication_projection" || stored.event.type === "user_message"
          ? stored.event.communicationEventId : undefined;
        const message = communicationMessageProjection(thread.id, stored);
        if (eventId && message && canonicalIds.has(eventId)) {
          const projection: CommunicationProjection = {
            eventId, surface: "direct_agent_audit", projectionKey: thread.id, projectedAt: stored.ts,
            message,
          };
          if (this.communicationProjectionAllowed(projectId, projection)) {
            this.appendCommunicationProjection(projectId, projection);
          }
        }
      }
    }
  }

  /** Compare canonical events with legacy disk projections during shadow mode. */
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
    const unlinkedLegacyMessageIds: string[] = [];
    const projectionReadMismatchMessageIds: string[] = [];
    for (const master of this.listConversations(projectId)) {
      for (const channel of ["main", "collaboration"] as const) {
        const legacy = this.getConversationMessages(master.id, channel);
        const projected = new Map(this.getProjectedConversationMessages(master.id, channel).map((message) => [message.id, message]));
        for (const message of legacy) {
          if (!message.communicationEventId) {
            unlinkedLegacyMessageIds.push(message.id);
            continue;
          }
          const candidate = projected.get(message.id);
          const parityKey = (item: ConversationMessageDto) => JSON.stringify([
            item.id, item.communicationEventId, item.conversationId, item.role, item.text, item.createdAt,
            item.authorThreadId, item.replyTo, item.attachments ?? [],
          ]);
          if (!candidate || parityKey(candidate) !== parityKey(message)) {
            projectionReadMismatchMessageIds.push(message.id);
          }
        }
      }
    }
    for (const thread of this.listThreads(projectId)) {
      const projected = new Map(this.getProjectedThreadMessages(thread.id).map((message) => [message.id, message]));
      for (const message of this.getMessages(thread.id)) {
        if (!message.communicationEventId) {
          unlinkedLegacyMessageIds.push(message.id);
          continue;
        }
        const candidate = projected.get(message.id);
        const parityKey = (item: MessageDto) => JSON.stringify([
          item.id, item.communicationEventId, item.threadId, item.seq, item.role, item.text,
          item.createdAt, item.authorThreadId, item.replyTo, item.attachments ?? [],
        ]);
        if (!candidate || parityKey(candidate) !== parityKey(message)) {
          projectionReadMismatchMessageIds.push(message.id);
        }
      }
    }
    return {
      projectId,
      canonicalEvents: canonical.length,
      linkedProjections: projections.length,
      missingProjectionEventIds,
      duplicateProjectionEventIds,
      orphanProjectionEventIds,
      missingClassificationEventIds,
      missingProjectionMetadataEventIds,
      unlinkedLegacyMessageIds,
      projectionReadMismatchMessageIds,
      ok: missingProjectionEventIds.length === 0 && duplicateProjectionEventIds.length === 0 &&
        orphanProjectionEventIds.length === 0 && missingClassificationEventIds.length === 0 &&
        missingProjectionMetadataEventIds.length === 0 && unlinkedLegacyMessageIds.length === 0 &&
        projectionReadMismatchMessageIds.length === 0,
    };
  }

  /** Mark executions whose durable start survived a daemon crash without a terminal record. */
  recoverInterruptedExecutions(): string[] {
    const recovered: string[] = [];
    for (const project of this.listProjects()) {
      for (const thread of this.listThreads(project.id)) {
        const events = this.readEvents(thread.id);
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
          stored.event.type === "turn_done" || stored.event.type === "error" ||
          (stored.event.type === "agent_lifecycle" && ["cancelled", "completed", "failed"].includes(stored.event.status)));
        if (terminal) continue;
        const executionId = start.event.type === "agent_lifecycle" ? start.event.executionId : undefined;
        this.appendEvent(thread.id, {
          type: "agent_lifecycle", status: "failed", reason: "execution_interrupted",
          ...(executionId ? { executionId } : {}),
        });
        recovered.push(thread.id);
      }
    }
    return recovered;
  }

  /** The raw better-sqlite3 handle (read-only queries, PRAGMAs, tests). */
  get sqlite(): Database.Database {
    return this.client;
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  createProject(input: CreateProjectRequest & { hostPath: string }): ProjectDto {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: ProjectJson = {
      id,
      label: input.label,
      hostPath: input.hostPath,
      createdAt: now,
    };
    writeJson(projectJsonPath(this.dataDir, id), record);
    mkdirSync(conversationsDir(this.dataDir, id), { recursive: true });
    mkdirSync(threadsDir(this.dataDir, id), { recursive: true });
    this.db
      .insert(projects)
      .values({ id, label: input.label, hostPath: input.hostPath, createdAt: now })
      .run();
    for (const preset of BUILTIN_PRESETS) this.createAgentPreset(id, preset);
    return { id, label: input.label, hostPath: input.hostPath, createdAt: now };
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
    const threadIds = this.listThreads(id).map((thread) => thread.id);
    rmSync(projectDir(this.dataDir, id), { recursive: true, force: true });
    this.communicationEventCache.delete(id);
    this.contextClassificationCache.delete(id);
    this.communicationProjectionCache.delete(id);
    for (const threadId of threadIds) {
      this.logs.delete(threadId);
      this.states.delete(threadId);
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
    };
  }

  // ─── Conversations ─────────────────────────────────────────────────────────

  createConversation(projectId: string, input: CreateConversationRequest): ConversationDto {
    if (!this.getProject(projectId)) throw new Error(`unknown project: ${projectId}`);
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: ConversationJson = {
      id,
      projectId,
      title: input.title,
      defaultEngine: input.defaultEngine,
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
        title: input.title,
        defaultEngine: input.defaultEngine ?? null,
        defaultModel: input.defaultModel ?? null,
        defaultEffort: input.defaultEffort ?? null,
        createdAt: now,
        updatedAt: now,
        archived: 0,
      })
      .run();
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
      threads: this.listThreads(conversation.projectId).filter((thread) => thread.conversationIds.includes(id)),
    };
  }

  getCollaborationViewDetail(id: string): CollaborationViewDto | undefined {
    const conversation = this.getConversation(id);
    if (!conversation) return undefined;
    return {
      messages: this.getConversationMessages(id, "collaboration"),
      threads: this.listThreads(conversation.projectId).filter((thread) => thread.conversationIds.includes(id)),
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

  /** Permanently remove a conversation while preserving its agents as unassigned threads. */
  deleteConversation(id: string): boolean {
    const row = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!row) return false;
    const linkedThreads = this.listThreads(row.projectId).filter((thread) => thread.conversationIds.includes(id));
    this.db.transaction((tx) => {
      tx.delete(threadConversationMemberships).where(eq(threadConversationMemberships.conversationId, id)).run();
      tx.delete(conversationMessages).where(eq(conversationMessages.conversationId, id)).run();
      tx.delete(conversations).where(eq(conversations.id, id)).run();
    });
    for (const thread of linkedThreads) {
      const remaining = thread.conversationIds.filter((memberId) => memberId !== id);
      const primary = thread.conversationId === id ? remaining[0] : thread.conversationId;
      this.persistThreadMemberships(thread.id, remaining, primary);
    }
    rmSync(conversationDir(this.dataDir, row.projectId, id), { recursive: true, force: true });
    return true;
  }

  appendConversationMessage(
    conversationId: string,
    input: CreateConversationMessageRequest & { directReplyToAuthorThreadId?: string },
    authorThreadId?: string,
    channel: ConversationChannel = "main",
    deliveryIntents?: ConversationDeliveryIntent[],
    messageReceiptKey?: string,
    communicationEventId?: string,
  ): ConversationMessageDto | undefined {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return undefined;
    if (communicationEventId && !this.communicationProjectionAllowed(conversation.projectId, {
      eventId: communicationEventId,
      surface: channel === "collaboration" ? "collaboration_view" : "conversation",
      projectionKey: conversationId,
    })) {
      // Validate the canonical communication before writing a legacy placement.
      // A failed projection must never leave a chat row that startup repair will
      // later reinterpret or reject.
      throw new Error("communication scope cannot project to requested surface");
    }
    const now = new Date().toISOString();
    const messagePath = channel === "collaboration"
      ? collaborationMessagesPath(this.dataDir, conversation.projectId, conversationId)
      : conversationMessagesPath(this.dataDir, conversation.projectId, conversationId);
    const replyTo = input.replyToMessageId
      ? this.conversationReference(conversationId, channel, input.replyToMessageId)
      : undefined;
    if (input.directReplyToAuthorThreadId) {
      if (channel !== "main" || !replyTo || replyTo.authorThreadId !== input.directReplyToAuthorThreadId) {
        throw new Error("direct reply target must be the author of the referenced main-chat message");
      }
      const target = this.getThread(input.directReplyToAuthorThreadId);
      if (!target || target.archived || !target.conversationIds.includes(conversationId)) {
        throw new Error("direct reply target is not an active agent in this conversation");
      }
    }
    const message: ConversationMessageJson = {
      id: randomUUID(),
      ...(communicationEventId ? { communicationEventId } : {}),
      conversationId,
      role: input.role ?? "user",
      text: input.text,
      createdAt: now,
      authorThreadId: authorThreadId ?? null,
      channel,
      ...(replyTo ? { replyTo } : {}),
      ...(input.directReplyToAuthorThreadId ? { directReplyToAuthorThreadId: input.directReplyToAuthorThreadId } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(deliveryIntents?.length ? { deliveryIntents } : {}),
      ...(messageReceiptKey ? { messageReceiptKey } : {}),
      ...(channel === "collaboration"
        ? { deliveryOrderKey: this.nextDeliveryOrderKey(now) }
        : {}),
    };
    mkdirSync(conversationDir(this.dataDir, conversation.projectId, conversationId), { recursive: true });
    appendFileSync(
      messagePath,
      JSON.stringify(message) + "\n",
      "utf8",
    );
    this.db.insert(conversationMessages).values({
      id: message.id,
      communicationEventId: message.communicationEventId ?? null,
      conversationId: message.conversationId,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      authorThreadId: message.authorThreadId,
      channel: message.channel,
      replyToJson: message.replyTo ? JSON.stringify(message.replyTo) : null,
      attachmentsJson: message.attachments?.length ? JSON.stringify(message.attachments) : null,
    }).run();
    this.db
      .update(conversations)
      .set({ updatedAt: now })
      .where(eq(conversations.id, conversationId))
      .run();
    const jsonPath = conversationJsonPath(this.dataDir, conversation.projectId, conversationId);
    const json = readJson<ConversationJson>(jsonPath);
    writeJson(jsonPath, { ...json, updatedAt: now });
    if (message.communicationEventId) {
      this.appendCommunicationProjection(conversation.projectId, {
        eventId: message.communicationEventId,
        surface: channel === "collaboration" ? "collaboration_view" : "conversation",
        projectionKey: conversationId,
        projectedAt: now,
        message: {
          messageId: message.id, role: message.role, renderedText: message.text, createdAt: message.createdAt,
          ...(authorThreadId ? { authorAgentId: authorThreadId } : {}),
          ...(message.replyTo ? { replyToLegacyMessageId: message.replyTo.messageId } : {}),
          ...(message.attachments?.length ? { attachmentIds: message.attachments.map((item) => item.id) } : {}),
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        },
      });
    }
    return {
      id: message.id,
      communicationEventId: message.communicationEventId,
      conversationId: message.conversationId,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      authorThreadId: authorThreadId ?? undefined,
      replyTo: message.replyTo,
      attachments: message.attachments,
    };
  }

  getConversationDeliveryIntents(conversationId: string): Array<{
    message: ConversationMessageDto;
    intent: ConversationDeliveryIntent;
    messageReceiptKey?: string;
    deliveryOrderKey: string;
  }> {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return [];
    const messages = [
      ...readJsonLines<ConversationMessageJson>(conversationMessagesPath(this.dataDir, conversation.projectId, conversationId)),
      ...readJsonLines<ConversationMessageJson>(collaborationMessagesPath(this.dataDir, conversation.projectId, conversationId)),
    ];
    return messages.flatMap((message) => (message.deliveryIntents ?? []).map((intent) => ({
      message: {
        id: message.id,
        communicationEventId: message.communicationEventId,
        conversationId: message.conversationId,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        authorThreadId: message.authorThreadId ?? undefined,
        replyTo: message.replyTo,
        attachments: message.attachments,
      },
      intent,
      messageReceiptKey: message.messageReceiptKey,
      deliveryOrderKey: message.deliveryOrderKey ?? `${message.createdAt}:${String(0).padStart(12, "0")}`,
    })));
  }

  getConversationMessageByReceiptKey(conversationId: string, receiptKey: string): ConversationMessageDto | undefined {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return undefined;
    const message = readJsonLines<ConversationMessageJson>(
      conversationMessagesPath(this.dataDir, conversation.projectId, conversationId),
    ).find((candidate) => candidate.messageReceiptKey === receiptKey);
    return message ? {
      id: message.id,
      communicationEventId: message.communicationEventId,
      conversationId: message.conversationId,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      authorThreadId: message.authorThreadId ?? undefined,
      replyTo: message.replyTo,
      attachments: message.attachments,
    } : undefined;
  }

  getConversationMessageDeliveryOrderKey(conversationId: string, messageId: string): string | undefined {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return undefined;
    return readJsonLines<ConversationMessageJson>(
      collaborationMessagesPath(this.dataDir, conversation.projectId, conversationId),
    ).find((message) => message.id === messageId)?.deliveryOrderKey;
  }

  getConversationMessages(conversationId: string, channel: ConversationChannel = "main"): ConversationMessageDto[] {
    const master = this.getConversation(conversationId);
    if (!master) return [];
    return this.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(asc(conversationMessages.createdAt))
      .all()
      .filter((row) => row.channel === channel)
      .map((row) => {
        const communication = row.communicationEventId
          ? this.getCommunicationEvent(master.projectId, row.communicationEventId)
          : undefined;
        const authorThreadId = communication?.sender.kind === "agent"
          ? communication.sender.agentId
          : row.authorThreadId ?? undefined;
        const role = communication?.sender.kind === "agent"
          ? "assistant"
          : communication?.sender.kind === "user"
            ? "user"
            : row.role === "assistant" || row.role === "system"
              ? row.role
              : "user";
        return {
          id: row.id,
          communicationEventId: row.communicationEventId ?? undefined,
          conversationId: row.conversationId,
          role,
          text: row.text,
          createdAt: row.createdAt,
          authorThreadId,
          replyTo: row.replyToJson ? JSON.parse(row.replyToJson) : undefined,
          attachments: row.attachmentsJson ? JSON.parse(row.attachmentsJson) : undefined,
        };
      });
  }

  /**
   * Materialize a room timeline from canonical communication events and their
   * projection ledger. Legacy rows are consulted only for ancillary snapshots
   * (attachments and quoted replies) until those immutable payloads move into
   * the canonical envelope; they do not select membership, ordering, or text.
   */
  getProjectedConversationMessages(
    conversationId: string,
    channel: ConversationChannel = "main",
  ): ConversationMessageDto[] {
    const master = this.getConversation(conversationId);
    if (!master) return [];
    const surface = channel === "collaboration" ? "collaboration_view" : "conversation";
    return this.readProjectedCommunicationMessages(master.projectId, surface, conversationId).map((message) => {
      return {
        id: message.messageId,
        communicationEventId: message.eventId,
        conversationId,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        ...(message.authorAgentId ? { authorThreadId: message.authorAgentId } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        ...(message.document ? { document: message.document } : {}),
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
      authorThreadId: target.authorThreadId,
    };
  }

  // ─── Threads ───────────────────────────────────────────────────────────────

  createThread(projectId: string, input: CreateThreadRequest, origin?: AgentSpawnOrigin): ThreadDto {
    const id = randomUUID();
    const now = new Date().toISOString();
    const preset = input.presetId ? this.getAgentPreset(input.presetId) : undefined;
    if (input.presetId && (!preset || preset.projectId !== projectId || !preset.enabled)) throw new Error("invalid preset");
    const presetSnapshot = preset ? { id: preset.id, name: preset.name, description: preset.description, guidance: preset.guidance, engine: preset.engine, model: preset.model, effort: preset.effort } : undefined;
    const record: ThreadJson = {
      id,
      projectId,
      conversationId: input.conversationId,
      conversationIds: input.conversationId ? [input.conversationId] : [],
      title: input.title,
      activeEngine: input.engine,
      createdAt: now,
      updatedAt: now,
      archived: false,
      spawnedByAgentId: origin?.agentId,
      spawnedByExecutionId: origin?.executionId,
      spawnPrompt: origin?.prompt,
      spawnIdempotencyKey: origin?.idempotencyKey,
      presetSnapshot,
    };
    mkdirSync(threadDir(this.dataDir, projectId, id), { recursive: true });
    mkdirSync(artifactsDir(this.dataDir, projectId, id), { recursive: true });
    mkdirSync(attachmentsDir(this.dataDir, projectId, id), { recursive: true });
    writeJson(threadJsonPath(this.dataDir, projectId, id), record);
    this.db
      .insert(threads)
      .values({
        id,
        projectId,
        conversationId: input.conversationId ?? null,
        title: input.title,
        activeEngine: input.engine,
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
      this.db.insert(threadConversationMemberships).values({ threadId: id, conversationId: input.conversationId, position: 0 }).run();
    }
    if (input.managerAgentId) this.updateAgentOrganization(id, { managerAgentId: input.managerAgentId });
    return this.rowToThreadDto(id)!;
  }

  findAgentSpawn(agentId: string, executionId: string, idempotencyKey: string): ThreadDto | undefined {
    const row = this.db.select().from(threads).where(and(
      eq(threads.spawnedByAgentId, agentId),
      eq(threads.spawnedByExecutionId, executionId),
      eq(threads.spawnIdempotencyKey, idempotencyKey),
    )).get();
    return row ? this.threadRowToDto(row) : undefined;
  }

  listThreads(projectId: string): ThreadDto[] {
    return this.db
      .select()
      .from(threads)
      .where(eq(threads.projectId, projectId))
      .all()
      .map((r) => this.threadRowToDto(r));
  }

  getThread(id: string): ThreadDto | undefined {
    return this.rowToThreadDto(id);
  }

  listAgentSubtree(id: string): ThreadDto[] {
    const root = this.getThread(id);
    if (!root) return [];
    const projectAgents = this.listThreads(root.projectId);
    const children = new Map<string, ThreadDto[]>();
    for (const agent of projectAgents) {
      if (!agent.managerAgentId) continue;
      children.set(agent.managerAgentId, [...(children.get(agent.managerAgentId) ?? []), agent]);
    }
    const ordered: ThreadDto[] = [];
    const visit = (agent: ThreadDto) => {
      ordered.push(agent);
      for (const child of children.get(agent.id) ?? []) visit(child);
    };
    visit(root);
    return ordered;
  }

  updateThread(id: string, patch: UpdateThreadRequest): ThreadDto | undefined {
    const row = this.db.select().from(threads).where(eq(threads.id, id)).get();
    if (!row) return undefined;
    const now = new Date().toISOString();
    const title = patch.title ?? row.title;
    const archived = patch.archived ?? row.archived === 1;
    if (archived && row.archived !== 1) {
      for (const child of this.listThreads(row.projectId).filter((thread) => thread.managerAgentId === id)) {
        this.updateAgentOrganization(child.id, { managerAgentId: null });
      }
      if (this.getThread(id)?.managerAgentId) this.updateAgentOrganization(id, { managerAgentId: null });
    }
    this.db
      .update(threads)
      .set({ title, archived: archived ? 1 : 0, updatedAt: now })
      .where(eq(threads.id, id))
      .run();
    // Keep the on-disk metadata (source of truth for these fields) in sync.
    const json = readJson<ThreadJson>(threadJsonPath(this.dataDir, row.projectId, id));
    writeJson(threadJsonPath(this.dataDir, row.projectId, id), {
      ...json,
      title,
      archived,
      updatedAt: now,
    });
    return this.rowToThreadDto(id);
  }

  /** Change only the mutable organizational reporting line. */
  updateAgentOrganization(id: string, input: UpdateAgentOrganizationRequest): ThreadDto | undefined {
    const agent = this.getThread(id);
    if (!agent) return undefined;
    if (agent.archived) throw new Error("archived agents cannot be reorganized");
    const parentId = input.managerAgentId ?? undefined;
    if (parentId === id) throw new Error("an agent cannot report to itself");
    if (parentId) {
      const parent = this.getThread(parentId);
      if (!parent || parent.projectId !== agent.projectId) throw new Error("organizational parent must belong to the same project");
      if (parent.archived) throw new Error("organizational parent must be active");
      const visited = new Set<string>([id]);
      let cursor: ThreadDto | undefined = parent;
      while (cursor) {
        if (visited.has(cursor.id)) throw new Error("organizational parent would create a cycle");
        if (cursor.projectId !== agent.projectId || cursor.archived) throw new Error("organizational ancestry must contain active agents from the same project");
        visited.add(cursor.id);
        cursor = cursor.managerAgentId ? this.getThread(cursor.managerAgentId) : undefined;
      }
    }
    if (agent.managerAgentId === parentId) return agent;
    const event: AgentOrganizationEvent = {
      eventId: randomUUID(), type: "manager_changed", projectId: agent.projectId,
      agentId: id, managerAgentId: parentId ?? null, createdAt: new Date().toISOString(),
    };
    appendFsyncedJsonl(agentOrganizationEventsPath(this.dataDir, agent.projectId), [event]);
    this.db.update(threads).set({
      managerAgentId: parentId ?? null,
      updatedAt: event.createdAt,
    }).where(eq(threads.id, id)).run();
    return this.getThread(id);
  }

  readAgentOrganizationEvents(projectId: string): AgentOrganizationEvent[] {
    if (!this.getProject(projectId)) throw new Error("organization project not found");
    return readRepairableJsonl<AgentOrganizationEvent>(
      agentOrganizationEventsPath(this.dataDir, projectId), "agent organization log", true,
    );
  }

  updateThreadConversationMemberships(
    id: string,
    input: UpdateThreadConversationMembershipsRequest,
  ): ThreadDto | undefined {
    const thread = this.getThread(id);
    if (!thread) return undefined;
    const ids = [...new Set(input.conversationIds)];
    if (ids.length !== input.conversationIds.length) throw new Error("duplicate conversation membership");
    if (ids.length > 0 && !input.primaryConversationId) throw new Error("primary conversation is required");
    if (input.primaryConversationId && !ids.includes(input.primaryConversationId)) {
      throw new Error("primary conversation must be a member");
    }
    for (const conversationId of ids) {
      const master = this.getConversation(conversationId);
      if (!master || master.projectId !== thread.projectId) throw new Error("conversation does not belong to project");
      if (master.archived && !thread.conversationIds.includes(conversationId)) throw new Error("archived conversation cannot accept agents");
    }
    this.persistThreadMemberships(id, ids, input.primaryConversationId);
    return this.getThread(id);
  }

  /**
   * Permanently delete a thread: its projection rows AND its on-disk canonical
   * log directory (`thread.json`, `events.jsonl`, artifacts, attachments). This is
   * a whole-thread removal — a deliberate user action, distinct from the
   * append-only rule (which forbids mutating events *within* a live thread, not
   * discarding an entire thread). Returns false if the thread didn't exist.
   */
  deleteThread(id: string): boolean {
    const row = this.db.select().from(threads).where(eq(threads.id, id)).get();
    if (!row) return false;

    for (const child of this.listThreads(row.projectId).filter((thread) => thread.managerAgentId === id)) {
      this.deleteThread(child.id);
    }

    this.db.transaction((tx) => {
      tx.delete(events).where(eq(events.threadId, id)).run();
      tx.delete(artifacts).where(eq(artifacts.threadId, id)).run();
      tx.delete(tasks).where(eq(tasks.threadId, id)).run();
      tx.delete(messages).where(eq(messages.threadId, id)).run();
      tx.delete(threadConversationMemberships).where(eq(threadConversationMemberships.threadId, id)).run();
      tx.delete(threads).where(eq(threads.id, id)).run();
    });

    // Remove the on-disk thread directory (the canonical log lives here).
    rmSync(threadDir(this.dataDir, row.projectId, id), { recursive: true, force: true });

    // Drop any cached log writer / projection state.
    this.logs.delete(id);
    this.states.delete(id);
    return true;
  }

  /** Full agent-detail hydration for GET /api/threads/:id (SPEC §8). */
  getThreadDetail(id: string): ThreadDetailDto | undefined {
    const thread = this.rowToThreadDto(id);
    if (!thread) return undefined;
    return {
      thread,
      messages: this.getMessages(id),
      runOutput: this.getRunOutputs(id),
      activity: this.getActivity(id),
      changedFiles: this.getChangedFiles(id),
      tasks: this.getTasks(id),
      artifacts: this.getArtifacts(id),
      state: thread.state,
    };
  }

  getMessages(threadId: string): MessageDto[] {
    const projectId = this.projectIdOf(threadId);
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.seq))
      .all()
      .map((r) => {
        const communication = r.communicationEventId
          ? this.getCommunicationEvent(projectId, r.communicationEventId)
          : undefined;
        const authorThreadId = communication?.sender.kind === "agent"
          ? communication.sender.agentId
          : undefined;
        return {
          id: r.id,
          communicationEventId: r.communicationEventId ?? undefined,
          threadId: r.threadId,
          seq: r.seq,
          role: authorThreadId ? "assistant" : r.role === "user" ? "user" : "assistant",
          text: r.text,
          createdAt: r.createdAt,
          ...(authorThreadId ? { authorThreadId } : {}),
          replyTo: r.replyToJson ? JSON.parse(r.replyToJson) : undefined,
          attachments: r.attachmentsJson ? JSON.parse(r.attachmentsJson) : undefined,
        } satisfies MessageDto;
      });
  }

  /**
   * Completed ordinary responses are read from the canonical thread log. Legacy
   * text events are grouped by their surrounding execution and fail closed into
   * Work log rather than being inferred as communication.
   */
  getRunOutputs(threadId: string): RunOutputDto[] {
    const storedEvents = this.readEvents(threadId);
    const completedExecutionIds = new Set(storedEvents.flatMap(({ event }) =>
      event.type === "agent_output" ? [event.executionId] : [],
    ));
    const entries: RunOutputDto[] = [];
    const legacy = new Map<string, { text: string; firstSeq: number; lastSeq: number; createdAt: string }>();
    let activeExecutionId: string | undefined;
    let fallbackExecutionId: string | undefined;

    for (const stored of storedEvents) {
      const { event } = stored;
      if (event.type === "agent_lifecycle" && event.status === "running") {
        activeExecutionId = event.executionId;
        fallbackExecutionId = undefined;
      } else if (event.type === "user_message") {
        fallbackExecutionId = undefined;
      } else if (event.type === "text" && !event.executionId) {
        const executionId = activeExecutionId ?? fallbackExecutionId ?? `legacy:${stored.seq}`;
        fallbackExecutionId = executionId;
        if (!completedExecutionIds.has(executionId)) {
          const current = legacy.get(executionId);
          legacy.set(executionId, current ? {
            ...current,
            text: `${current.text}${event.delta}`,
            lastSeq: stored.seq,
            createdAt: stored.ts,
          } : {
            text: event.delta,
            firstSeq: stored.seq,
            lastSeq: stored.seq,
            createdAt: stored.ts,
          });
        }
      } else if (event.type === "turn_done") {
        fallbackExecutionId = undefined;
      } else if (event.type === "agent_lifecycle" && event.status !== "running" && event.executionId === activeExecutionId) {
        activeExecutionId = undefined;
        fallbackExecutionId = undefined;
      }

      if (event.type === "agent_output" && event.text.trim()) {
        entries.push({
          id: `${threadId}:runOutput:${stored.seq}`,
          threadId,
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

    for (const [executionId, item] of legacy) {
      if (!item.text.trim()) continue;
      entries.push({
        id: `${threadId}:runOutput:legacy:${item.lastSeq}`,
        threadId,
        executionId,
        kind: "response",
        text: item.text,
        completed: true,
        seq: item.lastSeq,
        sourceSeqStart: item.firstSeq,
        sourceSeqEnd: item.lastSeq,
        createdAt: item.createdAt,
      });
    }
    return entries.sort((a, b) => a.seq - b.seq);
  }

  /** Execution activity is rebuilt from canonical log events, never from live-only UI state. */
  getActivity(threadId: string): AgentActivityDto[] {
    const activityTypes = new Set(["command", "file_change", "test_result", "tool_call", "tool_result", "error"]);
    let activeExecutionId: string | undefined;
    const result: AgentActivityDto[] = [];
    for (const stored of this.readEvents(threadId)) {
      const event = stored.event;
      if (event.type === "agent_lifecycle" && event.status === "running") activeExecutionId = event.executionId;
      if (activityTypes.has(event.type)) {
        result.push({
          id: `${threadId}:activity:${stored.seq}`,
          threadId,
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
  getChangedFiles(threadId: string): ChangedFileDto[] {
    const byPath = new Map<string, ChangedFileDto>();
    for (const item of this.getActivity(threadId)) {
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

  getProjectedThreadMessages(threadId: string): MessageDto[] {
    const thread = this.getThread(threadId);
    if (!thread) return [];
    return this.readProjectedCommunicationMessages(thread.projectId, "direct_agent_audit", threadId)
      .flatMap((message) => {
        if (message.sequence === undefined || message.role === "system") return [];
        return [{
          id: message.messageId,
          communicationEventId: message.eventId,
          threadId,
          seq: message.sequence,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
          ...(message.authorAgentId ? { authorThreadId: message.authorAgentId } : {}),
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          ...(message.document ? { document: message.document } : {}),
        } satisfies MessageDto];
      });
  }

  getTasks(threadId: string): TaskDto[] {
    return this.db
      .select()
      .from(tasks)
      .where(eq(tasks.threadId, threadId))
      .orderBy(asc(tasks.createdAt))
      .all()
      .map((r) => ({
        id: r.id,
        threadId: r.threadId,
        title: r.title,
        status: r.status as TaskStatus,
        engine: r.engine,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
  }

  getArtifacts(threadId: string): ArtifactDto[] {
    const generatedPdfs = new Map(this.readEvents(threadId).flatMap((stored) =>
      stored.event.type === "file_change" && stored.event.path.toLowerCase().endsWith(".pdf")
        ? [[artifactId(threadId, stored.seq, 0), stored.event.path] as const]
        : [],
    ));
    const thread = this.getThread(threadId);
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.threadId, threadId))
      .orderBy(asc(artifacts.createdAt))
      .all()
      .map((r) => {
        const generatedPath = generatedPdfs.get(r.id);
        if (generatedPath && thread) {
          const root = `/api/projects/${encodeURIComponent(thread.projectId)}/threads/${encodeURIComponent(threadId)}/generated-artifacts/${encodeURIComponent(r.id)}`;
          return {
            id: r.id, threadId: r.threadId, taskId: r.taskId ?? undefined,
            kind: "document" as const, path: generatedPath, summary: generatedPath,
            createdAt: r.createdAt, mediaType: "application/pdf" as const,
            previewUrl: `${root}/preview`, downloadUrl: `${root}/download`,
          };
        }
        return {
          id: r.id, threadId: r.threadId, taskId: r.taskId ?? undefined,
          kind: r.kind as ArtifactKind, path: r.path, summary: r.summary ?? undefined,
          createdAt: r.createdAt,
        };
      });
  }

  getGeneratedPdfPath(threadId: string, artifactIdValue: string): string | undefined {
    const stored = this.readEvents(threadId).find((candidate) =>
      artifactId(threadId, candidate.seq, 0) === artifactIdValue &&
      candidate.event.type === "file_change" &&
      candidate.event.path.toLowerCase().endsWith(".pdf")
    );
    return stored?.event.type === "file_change"
      ? stored.event.path
      : undefined;
  }

  getArtifact(threadId: string, artifactId: string): ArtifactDto | undefined {
    const r = this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .get();
    if (!r || r.threadId !== threadId) return undefined;
    return {
      id: r.id,
      threadId: r.threadId,
      taskId: r.taskId ?? undefined,
      kind: r.kind as ArtifactKind,
      path: r.path,
      summary: r.summary ?? undefined,
      createdAt: r.createdAt,
    };
  }

  // ─── Event log (append-only) + projection ──────────────────────────────────

  /**
   * Append one event to a thread's canonical log AND update its projections.
   * The log write happens (and fsyncs) BEFORE the projection, so the log is always
   * complete for replay (SPEC §8: log write before broadcast). Returns the stored
   * event (seq + ts) so the caller can broadcast it over SSE.
   */
  appendEvent(threadId: string, event: LogEvent): StoredLogEvent {
    const projectId = this.projectIdOf(threadId);
    const log = this.logFor(threadId, projectId);
    const stored = log.append(event);

    const state = this.stateFor(threadId, projectId);
    const { state: nextState, ops } = projectEvent(threadId, state, stored);
    this.states.set(threadId, nextState);
    this.applyOps(threadId, projectId, ops);
    const communicationEventId = event.type === "communication_projection" || event.type === "user_message"
      ? event.communicationEventId : undefined;
    const message = communicationMessageProjection(threadId, stored);
    if (communicationEventId && message) {
      this.appendCommunicationProjection(projectId, {
        eventId: communicationEventId,
        surface: "direct_agent_audit",
        projectionKey: threadId,
        projectedAt: stored.ts,
        message,
      });
    }
    return stored;
  }

  readEvents(threadId: string): StoredLogEvent[] {
    return this.logFor(threadId, this.projectIdOf(threadId)).readAll();
  }

  readEventsSince(threadId: string, sinceSeq: number): StoredLogEvent[] {
    return this.logFor(threadId, this.projectIdOf(threadId)).readSince(sinceSeq);
  }

  lastSeqOf(threadId: string): number {
    const evs = this.readEvents(threadId);
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
    this.db.delete(tasks).run();
    this.db.delete(messages).run();
    this.db.delete(threads).run();
    this.db.delete(threadConversationMemberships).run();
    this.db.delete(conversationMessages).run();
    this.db.delete(conversations).run();
    this.db.delete(projects).run();
    this.db.delete(agentPresets).run();
    this.logs.clear();
    this.states.clear();

    const root = projectsDir(this.dataDir);
    if (!existsSync(root)) return;

    for (const projectId of readdirSync(root)) {
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
          for (const [channel, messagePath] of [
            ["main", conversationMessagesPath(this.dataDir, projectId, conversationId)],
            ["collaboration", collaborationMessagesPath(this.dataDir, projectId, conversationId)],
          ] as const) {
            for (const message of readJsonLines<ConversationMessageJson>(messagePath)) {
              this.db.insert(conversationMessages).values({
                id: message.id,
                communicationEventId: message.communicationEventId ?? null,
                conversationId: message.conversationId,
                role: message.role,
                text: message.text,
                createdAt: message.createdAt,
                authorThreadId: message.authorThreadId,
                channel: message.channel ?? channel,
                replyToJson: message.replyTo ? JSON.stringify(message.replyTo) : null,
                attachmentsJson: message.attachments?.length ? JSON.stringify(message.attachments) : null,
              }).run();
            }
          }
        }
      }

      const tDir = threadsDir(this.dataDir, projectId);
      if (!existsSync(tDir)) continue;
      for (const threadId of readdirSync(tDir)) {
        const tj = threadJsonPath(this.dataDir, projectId, threadId);
        if (!existsSync(tj)) continue;
        const t = readJson<ThreadJson>(tj);
        const membershipIds = [...new Set(t.conversationIds ?? (t.conversationId ? [t.conversationId] : []))];
        const primaryConversationId = t.conversationId && membershipIds.includes(t.conversationId)
          ? t.conversationId
          : membershipIds[0];
        this.db
          .insert(threads)
          .values({
            id: t.id,
            projectId: t.projectId,
            conversationId: primaryConversationId ?? null,
            title: t.title,
            activeEngine: t.activeEngine,
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
          this.db.insert(threadConversationMemberships).values({ threadId: t.id, conversationId, position }).run();
        });
        if (t.conversationIds === undefined || t.conversationId !== primaryConversationId) {
          writeJson(tj, { ...t, conversationId: primaryConversationId, conversationIds: membershipIds });
        }

        const logFile = eventsPath(this.dataDir, projectId, threadId);
        rmSync(artifactsDir(this.dataDir, projectId, threadId), {
          recursive: true,
          force: true,
        });
        mkdirSync(artifactsDir(this.dataDir, projectId, threadId), { recursive: true });
        if (!existsSync(logFile)) continue;
        const stored = new EventLog(logFile).readAll();
        const ops = projectAll(threadId, stored, t.activeEngine);
        this.applyOps(threadId, projectId, ops);
      }
      this.sanitizeOrganizationProjection(projectId);
    }
  }

  close(): void {
    this.client.close();
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private applyOps(threadId: string, projectId: string, ops: ProjectionOp[]): void {
    for (const op of ops) {
      if (op.kind === "insert_artifact" && op.content !== undefined) {
        const target = artifactContentPath(this.dataDir, projectId, threadId, op.row.path);
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
          case "insert_task":
            tx.insert(tasks)
              .values(op.row)
              .onConflictDoUpdate({
                target: tasks.id,
                set: {
                  title: op.row.title,
                  status: op.row.status,
                  engine: op.row.engine,
                  updatedAt: op.row.updatedAt,
                },
              })
              .run();
            break;
          case "update_task":
            tx.update(tasks)
              .set({ status: op.status, updatedAt: op.updatedAt })
              .where(eq(tasks.id, op.id))
              .run();
            break;
          case "set_session":
            tx.update(threads)
              .set({ activeSessionId: op.sessionId })
              .where(eq(threads.id, threadId))
              .run();
            break;
          case "set_state":
            tx.update(threads)
              .set({ stateBranch: op.branch ?? null, stateCommit: op.commit ?? null })
              .where(eq(threads.id, threadId))
              .run();
            break;
          case "touch_thread":
            tx.update(threads)
              .set({ updatedAt: op.updatedAt })
              .where(eq(threads.id, threadId))
              .run();
            break;
        }
      }
    });
  }

  private sanitizeOrganizationProjection(projectId: string): void {
    const agents = this.listThreads(projectId);
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    for (const agent of agents) {
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
      if (!valid) this.db.update(threads).set({ managerAgentId: null }).where(eq(threads.id, agent.id)).run();
    }
  }

  private projectIdOf(threadId: string): string {
    const row = this.db
      .select({ projectId: threads.projectId })
      .from(threads)
      .where(eq(threads.id, threadId))
      .get();
    if (!row) throw new Error(`unknown thread: ${threadId}`);
    return row.projectId;
  }

  private logFor(threadId: string, projectId: string): EventLog {
    let log = this.logs.get(threadId);
    if (!log) {
      log = new EventLog(eventsPath(this.dataDir, projectId, threadId));
      this.logs.set(threadId, log);
    }
    return log;
  }

  private stateFor(threadId: string, projectId: string): ProjectionState {
    let state = this.states.get(threadId);
    if (!state) {
      // Rebuild the in-memory reducer state by folding the existing log.
      const engine = this.activeEngineOf(threadId);
      state = initProjectionState(engine);
      const existing = new EventLog(eventsPath(this.dataDir, projectId, threadId)).readAll();
      for (const stored of existing) {
        state = projectEvent(threadId, state, stored).state;
      }
      this.states.set(threadId, state);
    }
    return state;
  }

  private activeEngineOf(threadId: string): string {
    const row = this.db
      .select({ engine: threads.activeEngine })
      .from(threads)
      .where(eq(threads.id, threadId))
      .get();
    return row?.engine ?? "codex";
  }

  private rowToThreadDto(id: string): ThreadDto | undefined {
    const row = this.db.select().from(threads).where(eq(threads.id, id)).get();
    return row ? this.threadRowToDto(row) : undefined;
  }

  private threadRowToDto(row: typeof threads.$inferSelect): ThreadDto {
    const state: ThreadState = {};
    if (row.stateBranch) state.branch = row.stateBranch;
    if (row.stateCommit) state.commit = row.stateCommit;
    return {
      id: row.id,
      projectId: row.projectId,
      conversationId: row.conversationId ?? undefined,
      conversationIds: this.db.select().from(threadConversationMemberships)
        .where(eq(threadConversationMemberships.threadId, row.id))
        .orderBy(asc(threadConversationMemberships.position)).all().map((membership) => membership.conversationId),
      title: row.title,
      activeEngine: row.activeEngine,
      state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archived: row.archived === 1,
      managerAgentId: row.managerAgentId ?? undefined,
      spawnedByAgentId: row.spawnedByAgentId ?? undefined,
      spawnedByExecutionId: row.spawnedByExecutionId ?? undefined,
      spawnPrompt: row.spawnPrompt ?? undefined,
      presetSnapshot: row.presetSnapshotJson ? JSON.parse(row.presetSnapshotJson) as ThreadDto["presetSnapshot"] : undefined,
    };
  }


  private persistThreadMemberships(id: string, conversationIds: string[], primaryConversationId?: string): void {
    const row = this.db.select().from(threads).where(eq(threads.id, id)).get();
    if (!row) throw new Error(`unknown thread: ${id}`);
    const now = new Date().toISOString();
    const jsonPath = threadJsonPath(this.dataDir, row.projectId, id);
    const json = readJson<ThreadJson>(jsonPath);
    // Canonical metadata is committed first; SQLite remains a rebuildable projection.
    writeJson(jsonPath, { ...json, conversationId: primaryConversationId, conversationIds, updatedAt: now });
    this.db.transaction((tx) => {
      tx.delete(threadConversationMemberships).where(eq(threadConversationMemberships.threadId, id)).run();
      conversationIds.forEach((conversationId, position) => {
        tx.insert(threadConversationMemberships).values({ threadId: id, conversationId, position }).run();
      });
      tx.update(threads).set({ conversationId: primaryConversationId ?? null, updatedAt: now }).where(eq(threads.id, id)).run();
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

  /** The engine session id to resume for a thread (undefined if none yet). */
  resumeSessionId(threadId: string): string | undefined {
    const row = this.db
      .select({
        sessionId: threads.activeSessionId,
      })
      .from(threads)
      .where(eq(threads.id, threadId))
      .get();
    if (!row) return undefined;
    return row.sessionId ?? undefined;
  }

  /**
   * Forget only the provider runtime session so the next turn seeds a fresh
   * session from canonical history. Thread identity, memberships, event logs,
   * and queued collaboration deliveries are intentionally untouched.
   */
  clearResumeSession(
    threadId: string,
    reason: "explicit_compaction" | "resume_compaction_failed",
  ): boolean {
    const row = this.db
      .select({ id: threads.id, activeSessionId: threads.activeSessionId })
      .from(threads)
      .where(eq(threads.id, threadId))
      .get();
    if (!row?.activeSessionId) return false;

    this.appendEvent(threadId, { type: "session_reset", reason });
    return true;
  }
}
