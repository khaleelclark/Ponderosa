// ThreadStore — the library that apps/server consumes. Ties together the on-disk
// event logs (source of truth), the SQLite projections, and the pure projectors.
// Exposes NO HTTP (SPEC §7). SQLite is never a source of truth: everything here is
// derivable from the logs + the *.json files, and `rebuildProjections()` proves it.

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { asc, eq } from "drizzle-orm";
import type {
  ArtifactDto,
  CommunicationEvent,
  CommunicationContextClassification,
  CommunicationProjection,
  CommunicationReconciliationReport,
  KnowledgePromotion,
  LegacyCommunicationBackfillRequest,
  LegacyCommunicationBackfillResponse,
  ProjectedCommunicationMessage,
  AgentPresetDto, CreateAgentPresetRequest, UpdateAgentPresetRequest,
  ArtifactKind,
  CollaborationChatDetailDto,
  CreateMasterChatMessageRequest,
  CreateMasterChatRequest,
  CreateProjectRequest,
  CreateThreadRequest,
  MasterChatDetailDto,
  MasterChatChannel,
  MasterChatDto,
  MasterChatMessageDto,
  MessageReactionDto,
  ReactionActor,
  ReactionEmoji,
  MessageDto,
  ProjectDto,
  TaskDto,
  TaskStatus,
  ThreadDetailDto,
  ThreadDto,
  ThreadState,
  UpdateThreadMasterChatMembershipsRequest,
  UpdateMasterChatRequest,
  UpdateThreadRequest,
} from "@ponderosa/core";
import { openDb, type Db } from "./db.js";
import type Database from "better-sqlite3";
import { EventLog } from "./eventlog.js";
import { messageId as projectedMessageId } from "./ids.js";
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
  masterChatMessages,
  masterChats,
  messages,
  projects,
  tasks,
  threads,
  threadMasterChatMemberships,
} from "./schema.js";
import {
  artifactsDir,
  artifactContentPath,
  attachmentsDir,
  dbPath,
  eventsPath,
  masterChatDir,
  collaborationChatMessagesPath,
  communicationEventsPath,
  communicationContextPath,
  communicationProjectionsPath,
  knowledgePromotionsPath,
  masterChatJsonPath,
  masterChatMessagesPath,
  masterChatsDir,
  projectJsonPath,
  agentPresetsPath,
  projectsDir,
  reactionEventsPath,
  threadDir,
  threadJsonPath,
  threadsDir,
} from "./paths.js";

interface ReactionEventJson {
  kind?: "occurrence";
  occurrenceId: string;
  idempotencyKey: string;
  actor: ReactionActor;
  masterChatId: string;
  channel: MasterChatChannel;
  messageId: string;
  emoji: ReactionEmoji;
  active: boolean;
  createdAt: string;
  notifyAuthorThreadId?: string;
  notificationInitial: "pending" | "suppressed" | "not_applicable";
}

interface ReactionNotificationOutcomeJson {
  kind: "notification_outcome";
  occurrenceId: string;
  outcome: "delivered" | "suppressed";
  reason: string;
  createdAt: string;
}

type ReactionLogRecord = ReactionEventJson | ReactionNotificationOutcomeJson;

const REACTION_COOLDOWN_MS = 500;
const MAX_REACTION_EVENTS = 100_000;
const REACTION_EMOJIS = new Set<ReactionEmoji>(["👍", "👎", "❤️", "🎉", "👀", "🚀"]);

function reactionActorKey(actor: ReactionActor): string {
  return actor.kind === "manager" ? "manager" : `agent:${actor.threadId}`;
}

function readReactionLog(file: string, repair = false): ReactionLogRecord[] {
  if (!existsSync(file)) return [];
  const fd = openSync(file, "r+");
  try {
    const bytes = readFileSync(fd);
    if (bytes.length === 0) return [];
    const text = bytes.toString("utf8");
    const lines = text.split("\n");
    const completeCount = text.endsWith("\n") ? lines.length - 1 : lines.length;
    const records: ReactionLogRecord[] = [];
    let offset = 0;
    for (let index = 0; index < completeCount; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) { offset += Buffer.byteLength(line) + 1; continue; }
      try {
        records.push(JSON.parse(line) as ReactionLogRecord);
        offset += Buffer.byteLength(line) + (index < lines.length - 1 ? 1 : 0);
        if (repair && index === completeCount - 1 && !text.endsWith("\n")) {
          writeSync(fd, "\n");
          fsyncSync(fd);
        }
      } catch (error) {
        const finalUnterminated = index === completeCount - 1 && !text.endsWith("\n");
        if (!finalUnterminated) throw new Error("reaction log contains non-tail corruption", { cause: error });
        if (repair) {
          ftruncateSync(fd, offset);
          fsyncSync(fd);
        }
      }
    }
    return records;
  } finally {
    closeSync(fd);
  }
}

function appendReactionRecords(file: string, records: ReactionLogRecord[]): void {
  if (!records.length) return;
  const fd = openSync(file, "a");
  try {
    const bytes = Buffer.from(records.map((record) => JSON.stringify(record) + "\n").join(""));
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written);
      if (count <= 0) throw new Error("reaction log append made no progress");
      written += count;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function reactionOccurrences(records: ReactionLogRecord[]): ReactionEventJson[] {
  return records.filter((record): record is ReactionEventJson => record.kind !== "notification_outcome");
}

function notificationStates(records: ReactionLogRecord[]): Map<string, "pending" | "delivered" | "suppressed" | "not_applicable"> {
  const states = new Map<string, "pending" | "delivered" | "suppressed" | "not_applicable">();
  for (const record of records) {
    if (record.kind === "notification_outcome") states.set(record.occurrenceId, record.outcome);
    else states.set(record.occurrenceId, record.notificationInitial);
  }
  return states;
}

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
  masterChatId?: string;
  masterChatIds?: string[];
  title: string;
  activeEngine: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  presetSnapshot?: ThreadDto["presetSnapshot"];
}

type PresetEvent = { type: "upsert"; preset: AgentPresetDto } | { type: "delete"; id: string; at: string };
const BUILTIN_PRESETS: Array<Omit<CreateAgentPresetRequest, "engine"> & { engine: "codex" }> = [
  { name: "Frontend", description: "Accessible, polished product UI", guidance: "Act as a product-minded frontend engineer. Prioritize responsive UX, accessibility, and tested user flows.", engine: "codex" },
  { name: "Security", description: "Threat-model and harden changes", guidance: "Act as a security reviewer. Preserve trust boundaries, minimize authority, and test abuse cases.", engine: "codex" },
  { name: "QA", description: "Find regressions and verify behavior", guidance: "Act as a QA engineer. Build a risk-based test plan, reproduce failures, and report evidence precisely.", engine: "codex" },
  { name: "Documentation", description: "Create clear, accurate documentation", guidance: "Act as a technical writer. Verify behavior in the code and write concise task-oriented documentation.", engine: "codex" },
];

interface MasterChatJson {
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

export interface MasterChatDeliveryIntent {
  targetThreadId: string;
  relayDepth: number;
  mentionTrail: string[];
  kind: "direct" | "tag" | "delegation_completion";
  /** The selector that authorized this recipient when the message was recorded. */
  audience?: "mention" | "everyone";
  delegatedRunId?: string;
}

interface MasterChatMessageJson {
  id: string;
  communicationEventId?: string;
  masterChatId: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  authorThreadId?: string | null;
  channel?: MasterChatChannel;
  deliveryIntents?: MasterChatDeliveryIntent[];
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
    messageId: projectedMessageId(threadId, stored.seq), role: "user", renderedText: event.text, createdAt: stored.ts,
    ...(event.replyTo ? { replyToLegacyMessageId: event.replyTo.messageId } : {}),
    ...(event.attachments?.length ? { attachmentIds: event.attachments.map((item) => item.id) } : {}),
  };
  if (event.type === "text") return {
    messageId: projectedMessageId(threadId, stored.seq), role: "assistant", renderedText: event.delta, createdAt: stored.ts,
  };
  if (event.type === "communication_projection") return {
    messageId: projectedMessageId(threadId, stored.seq), role: "assistant", renderedText: event.text, createdAt: stored.ts,
  };
  return undefined;
}

function legacyCommunicationEventId(projectId: string, source: string, sourceId: string): string {
  const hex = createHash("sha256").update(`ponderosa-legacy-communication\0${projectId}\0${source}\0${sourceId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
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
  private readonly knowledgePromotionCache = new Map<string, KnowledgePromotion[]>();

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
  appendCommunicationEvent(event: CommunicationEvent): { event: CommunicationEvent; replayed: boolean } {
    if (!this.getProject(event.projectId)) throw new Error("communication project not found");
    if (event.schemaVersion !== 1) throw new Error("unsupported communication schema version");
    if (!event.eventId || !event.text.trim() || !event.createdAt) throw new Error("communication event is incomplete");
    if (event.intent === "collaboration" && event.audience.agentIds.length === 0) {
      throw new Error("collaboration requires at least one recipient agent ID");
    }
    const file = communicationEventsPath(this.dataDir, event.projectId);
    const classification: CommunicationContextClassification = {
      eventId: event.eventId,
      policy: event.intent === "broadcast" ? "organizational_candidate" : "local_only",
      classifiedAt: event.createdAt,
      classifiedBy: { kind: "system", component: "communication-router" },
    };
    const index = this.communicationIndex(event.projectId);
    const idempotent = event.idempotencyKey
      ? index.byIdempotency.get(`${JSON.stringify(event.sender)}\u0000${event.idempotencyKey}`) : undefined;
    if (idempotent) {
      const equivalent = idempotent.projectId === event.projectId && idempotent.masterChatId === event.masterChatId &&
        idempotent.intent === event.intent && JSON.stringify(idempotent.audience) === JSON.stringify(event.audience) &&
        idempotent.text === event.text;
      if (!equivalent) throw new Error("communication idempotency collision");
      this.appendContextClassification(event.projectId, {
        eventId: idempotent.eventId,
        policy: idempotent.intent === "broadcast" ? "organizational_candidate" : "local_only",
        classifiedAt: idempotent.createdAt,
        classifiedBy: { kind: "system", component: "communication-router" },
      });
      return { event: idempotent, replayed: true };
    }
    const existing = index.byId.get(event.eventId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) throw new Error("communication event ID collision");
      this.appendContextClassification(event.projectId, classification);
      return { event: existing, replayed: true };
    }
    appendFsyncedJsonl(file, [event]);
    index.events.push(event);
    index.byId.set(event.eventId, event);
    if (event.idempotencyKey) index.byIdempotency.set(`${JSON.stringify(event.sender)}\u0000${event.idempotencyKey}`, event);
    this.appendContextClassification(event.projectId, classification);
    return { event, replayed: false };
  }

  readCommunicationEvents(projectId: string): CommunicationEvent[] {
    if (!this.getProject(projectId)) throw new Error("communication project not found");
    return [...this.communicationIndex(projectId).events];
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

  appendCommunicationProjection(projectId: string, projection: CommunicationProjection): { projection: CommunicationProjection; replayed: boolean } {
    const eventExists = this.communicationIndex(projectId).byId.has(projection.eventId);
    if (!eventExists) throw new Error("communication projection source event not found");
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
    return [...this.projectionIndex(projectId).projections];
  }

  readProjectedCommunicationMessages(
    projectId: string,
    surface: CommunicationProjection["surface"],
    projectionKey: string,
  ): ProjectedCommunicationMessage[] {
    const events = this.communicationIndex(projectId).byId;
    return this.projectionIndex(projectId).projections
      .filter((projection) => projection.surface === surface && projection.projectionKey === projectionKey && projection.message)
      .flatMap((projection) => {
        const event = events.get(projection.eventId);
        const message = projection.message;
        if (!event || !message) return [];
        return [{
          eventId: event.eventId, surface, projectionKey, messageId: message.messageId,
          role: message.role, text: message.renderedText ?? event.text, createdAt: message.createdAt,
          ...(message.authorAgentId ? { authorAgentId: message.authorAgentId } : {}),
          ...(message.replyToLegacyMessageId ? { replyToLegacyMessageId: message.replyToLegacyMessageId } : {}),
          ...(message.attachmentIds?.length ? { attachmentIds: message.attachmentIds } : {}),
        }];
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.eventId.localeCompare(b.eventId));
  }

  private repairCommunicationProjectionLedger(projectId: string): void {
    const canonicalIds = new Set(this.readCommunicationEvents(projectId).map((event) => event.eventId));
    if (canonicalIds.size === 0) return;
    for (const master of this.listMasterChats(projectId)) {
      for (const [surface, file] of [
        ["master_chat", masterChatMessagesPath(this.dataDir, projectId, master.id)],
        ["collaboration_chat", collaborationChatMessagesPath(this.dataDir, projectId, master.id)],
      ] as const) {
        for (const message of readJsonLines<MasterChatMessageJson>(file)) {
          if (message.communicationEventId && canonicalIds.has(message.communicationEventId)) {
            this.appendCommunicationProjection(projectId, {
              eventId: message.communicationEventId, surface, projectionKey: master.id, projectedAt: message.createdAt,
              message: {
                messageId: message.id, role: message.role, renderedText: message.text, createdAt: message.createdAt,
                ...(message.authorThreadId ? { authorAgentId: message.authorThreadId } : {}),
                ...(message.replyTo ? { replyToLegacyMessageId: message.replyTo.messageId } : {}),
                ...(message.attachments?.length ? { attachmentIds: message.attachments.map((item) => item.id) } : {}),
              },
            });
          }
        }
      }
    }
    for (const thread of this.listThreads(projectId)) {
      for (const stored of this.readEvents(thread.id)) {
        const eventId = stored.event.type === "communication_projection" || stored.event.type === "user_message" || stored.event.type === "text"
          ? stored.event.communicationEventId : undefined;
        const message = communicationMessageProjection(thread.id, stored);
        if (eventId && message && canonicalIds.has(eventId)) {
          this.appendCommunicationProjection(projectId, {
            eventId, surface: "direct_agent_audit", projectionKey: thread.id, projectedAt: stored.ts,
            message,
          });
        }
      }
    }
  }

  promoteKnowledge(promotion: KnowledgePromotion): { promotion: KnowledgePromotion; replayed: boolean } {
    if (!this.getProject(promotion.organizationId)) throw new Error("promotion organization not found");
    const source = this.readCommunicationEvents(promotion.organizationId)
      .find((event) => event.eventId === promotion.sourceEventId);
    if (!source) throw new Error("promotion source event not found");
    const classification = this.readContextClassifications(promotion.organizationId)
      .find((candidate) => candidate.eventId === promotion.sourceEventId);
    if (classification?.policy !== "local_only") throw new Error("only local knowledge requires promotion");
    if (!promotion.summary.trim()) throw new Error("promotion summary is required");
    const file = knowledgePromotionsPath(this.dataDir, promotion.organizationId);
    let existing = this.knowledgePromotionCache.get(promotion.organizationId);
    if (!existing) {
      existing = readRepairableJsonl<KnowledgePromotion>(file, "knowledge promotion log", true);
      this.knowledgePromotionCache.set(promotion.organizationId, existing);
    }
    const prior = promotion.idempotencyKey
      ? existing.find((candidate) => candidate.idempotencyKey === promotion.idempotencyKey)
      : existing.find((candidate) => candidate.promotionId === promotion.promotionId);
    if (prior) {
      const equivalent = prior.sourceEventId === promotion.sourceEventId && prior.summary === promotion.summary &&
        JSON.stringify(prior.promotedBy) === JSON.stringify(promotion.promotedBy);
      if (!equivalent) throw new Error("knowledge promotion idempotency collision");
      return { promotion: prior, replayed: true };
    }
    appendFsyncedJsonl(file, [promotion]);
    existing.push(promotion);
    return { promotion, replayed: false };
  }

  readKnowledgePromotions(projectId: string): KnowledgePromotion[] {
    if (!this.getProject(projectId)) throw new Error("promotion organization not found");
    let cached = this.knowledgePromotionCache.get(projectId);
    if (!cached) {
      cached = readRepairableJsonl<KnowledgePromotion>(knowledgePromotionsPath(this.dataDir, projectId), "knowledge promotion log", true);
      this.knowledgePromotionCache.set(projectId, cached);
    }
    return [...cached];
  }

  activeKnowledgePromotions(projectId: string, at = new Date().toISOString()): KnowledgePromotion[] {
    const all = this.readKnowledgePromotions(projectId);
    const superseded = new Set(all.flatMap((promotion) => promotion.supersedesPromotionId ? [promotion.supersedesPromotionId] : []));
    const now = Date.parse(at);
    return all.filter((promotion) => !superseded.has(promotion.promotionId) &&
      (!promotion.expiresAt || Date.parse(promotion.expiresAt) > now));
  }

  /** Compare canonical events with legacy disk projections during shadow mode. */
  reconcileCommunicationEvents(projectId: string): CommunicationReconciliationReport {
    const canonical = this.readCommunicationEvents(projectId);
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
      .filter((projection) => (projection.surface === "master_chat" || projection.surface === "collaboration_chat" || projection.surface === "direct_agent_audit") && !projection.message)
      .map((projection) => projection.eventId))];
    const unlinkedLegacyMessageIds: string[] = [];
    const projectionReadMismatchMessageIds: string[] = [];
    for (const master of this.listMasterChats(projectId)) {
      for (const channel of ["main", "collaboration"] as const) {
        const legacy = this.getMasterChatMessages(master.id, channel);
        const projected = new Map(this.getProjectedMasterChatMessages(master.id, channel).map((message) => [message.id, message]));
        for (const message of legacy) {
          if (!message.communicationEventId) {
            unlinkedLegacyMessageIds.push(message.id);
            continue;
          }
          const candidate = projected.get(message.id);
          const parityKey = (item: MasterChatMessageDto) => JSON.stringify([
            item.id, item.communicationEventId, item.masterChatId, item.role, item.text, item.createdAt,
            item.authorThreadId, item.replyTo, item.attachments ?? [], item.reactions ?? [],
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
          item.createdAt, item.replyTo, item.attachments ?? [],
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

  /**
   * Expand-only migration from legacy room/thread logs into canonical events.
   * IDs are content-location deterministic, so a crash or repeated operator
   * request resumes safely. Ambiguous Collaboration audiences are never guessed.
   */
  backfillLegacyCommunications(
    projectId: string,
    request: LegacyCommunicationBackfillRequest = {},
  ): LegacyCommunicationBackfillResponse {
    if (!this.getProject(projectId)) throw new Error("communication project not found");
    const dryRun = request.dryRun ?? true;
    const blocked: LegacyCommunicationBackfillResponse["blocked"] = [];
    let candidates = 0;
    let migrated = 0;
    let alreadyLinked = 0;
    const projectionByMessage = new Map<string, CommunicationProjection>(
      this.readCommunicationProjections(projectId).flatMap((projection) => projection.message
        ? [[`${projection.surface}\0${projection.projectionKey}\0${projection.message.messageId}`, projection] as const]
        : []),
    );
    const senderFor = (role: MasterChatMessageJson["role"], authorThreadId?: string | null): CommunicationEvent["sender"] =>
      authorThreadId ? { kind: "agent", agentId: authorThreadId }
        : role === "user" ? { kind: "user", userId: "local-operator" }
          : { kind: "system", component: "legacy-communication-backfill" };

    for (const master of this.listMasterChats(projectId)) {
      const memberIds = new Set(this.listThreads(projectId)
        .filter((thread) => thread.masterChatIds.includes(master.id))
        .map((thread) => thread.id));
      for (const [channel, surface, file] of [
        ["main", "master_chat", masterChatMessagesPath(this.dataDir, projectId, master.id)],
        ["collaboration", "collaboration_chat", collaborationChatMessagesPath(this.dataDir, projectId, master.id)],
      ] as const) {
        for (const message of readJsonLines<MasterChatMessageJson>(file)) {
          const placementKey = `${surface}\0${master.id}\0${message.id}`;
          if (message.communicationEventId || projectionByMessage.has(placementKey)) {
            alreadyLinked += 1;
            continue;
          }
          candidates += 1;
          const inferred = channel === "collaboration"
            ? [...new Set((message.deliveryIntents ?? []).map((intent) => intent.targetThreadId))]
            : [];
          const override = request.collaborationRecipientsByMessageId?.[message.id];
          const recipients = [...new Set(override ?? inferred)];
          if (channel === "collaboration" && recipients.length === 0) {
            blocked.push({ source: "collaboration_chat", sourceId: message.id, reason: "explicit_recipients_required" });
            continue;
          }
          if (channel === "collaboration" && recipients.some((id) => !memberIds.has(id))) {
            blocked.push({ source: "collaboration_chat", sourceId: message.id, reason: "recipient_not_room_member" });
            continue;
          }
          if (dryRun) continue;
          const eventId = legacyCommunicationEventId(projectId, surface, message.id);
          const event: CommunicationEvent = channel === "collaboration"
            ? {
                eventId, schemaVersion: 1, projectId, masterChatId: master.id,
                sender: senderFor(message.role, message.authorThreadId), intent: "collaboration",
                audience: { kind: "agents", agentIds: recipients as [string, ...string[]] },
                text: message.text, createdAt: message.createdAt,
                idempotencyKey: `legacy:${surface}:${message.id}`,
              }
            : {
                eventId, schemaVersion: 1, projectId, masterChatId: master.id,
                sender: senderFor(message.role, message.authorThreadId), intent: "broadcast",
                audience: { kind: "organization", organizationId: projectId },
                text: message.text, createdAt: message.createdAt,
                idempotencyKey: `legacy:${surface}:${message.id}`,
              };
          this.appendCommunicationEvent(event);
          const projection: CommunicationProjection = {
            eventId, surface, projectionKey: master.id, projectedAt: message.createdAt,
            message: {
              messageId: message.id, role: message.role, renderedText: message.text, createdAt: message.createdAt,
              ...(message.authorThreadId ? { authorAgentId: message.authorThreadId } : {}),
              ...(message.replyTo ? { replyToLegacyMessageId: message.replyTo.messageId } : {}),
              ...(message.attachments?.length ? { attachmentIds: message.attachments.map((item) => item.id) } : {}),
            },
          };
          this.appendCommunicationProjection(projectId, projection);
          projectionByMessage.set(placementKey, projection);
          migrated += 1;
        }
      }
    }

    for (const thread of this.listThreads(projectId)) {
      for (const stored of this.readEvents(thread.id)) {
        const message = communicationMessageProjection(thread.id, stored);
        if (!message || (stored.event.type !== "user_message" && stored.event.type !== "text")) continue;
        const placementKey = `direct_agent_audit\0${thread.id}\0${message.messageId}`;
        if (stored.event.communicationEventId || projectionByMessage.has(placementKey)) {
          alreadyLinked += 1;
          continue;
        }
        candidates += 1;
        if (dryRun) continue;
        const eventId = legacyCommunicationEventId(projectId, "direct_agent_audit", message.messageId);
        const event: CommunicationEvent = stored.event.type === "user_message"
          ? {
              eventId, schemaVersion: 1, projectId, ...(thread.masterChatId ? { masterChatId: thread.masterChatId } : {}),
              sender: { kind: "user", userId: "local-operator" }, intent: "collaboration",
              audience: { kind: "agents", agentIds: [thread.id] }, text: stored.event.text,
              createdAt: stored.ts, idempotencyKey: `legacy:direct_agent_audit:${message.messageId}`,
            }
          : {
              eventId, schemaVersion: 1, projectId, ...(thread.masterChatId ? { masterChatId: thread.masterChatId } : {}),
              sender: { kind: "agent", agentId: thread.id }, intent: "direct_to_user",
              audience: { kind: "user", userId: "local-operator" }, text: stored.event.delta,
              createdAt: stored.ts, idempotencyKey: `legacy:direct_agent_audit:${message.messageId}`,
            };
        this.appendCommunicationEvent(event);
        const projection = {
          eventId, surface: "direct_agent_audit" as const, projectionKey: thread.id,
          projectedAt: stored.ts, message,
        };
        this.appendCommunicationProjection(projectId, projection);
        projectionByMessage.set(placementKey, projection);
        migrated += 1;
      }
    }
    return { dryRun, candidates, migrated, alreadyLinked, blocked };
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

  createProject(input: CreateProjectRequest): ProjectDto {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: ProjectJson = {
      id,
      label: input.label,
      hostPath: input.hostPath,
      createdAt: now,
    };
    writeJson(projectJsonPath(this.dataDir, id), record);
    mkdirSync(masterChatsDir(this.dataDir, id), { recursive: true });
    mkdirSync(threadsDir(this.dataDir, id), { recursive: true });
    this.db
      .insert(projects)
      .values({ id, label: input.label, hostPath: input.hostPath, createdAt: now })
      .run();
    for (const preset of BUILTIN_PRESETS) this.createAgentPreset(id, preset);
    return { id, label: input.label, hostPath: input.hostPath, createdAt: now };
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

  // ─── Master chats ─────────────────────────────────────────────────────────

  createMasterChat(projectId: string, input: CreateMasterChatRequest): MasterChatDto {
    if (!this.getProject(projectId)) throw new Error(`unknown project: ${projectId}`);
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: MasterChatJson = {
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
    mkdirSync(masterChatDir(this.dataDir, projectId, id), { recursive: true });
    writeJson(masterChatJsonPath(this.dataDir, projectId, id), record);
    this.db
      .insert(masterChats)
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
    return this.masterChatRowToDto(
      this.db.select().from(masterChats).where(eq(masterChats.id, id)).get()!,
    );
  }

  listMasterChats(projectId: string): MasterChatDto[] {
    return this.db
      .select()
      .from(masterChats)
      .where(eq(masterChats.projectId, projectId))
      .orderBy(asc(masterChats.createdAt))
      .all()
      .map((row) => this.masterChatRowToDto(row));
  }

  getMasterChat(id: string): MasterChatDto | undefined {
    const row = this.db.select().from(masterChats).where(eq(masterChats.id, id)).get();
    return row ? this.masterChatRowToDto(row) : undefined;
  }

  getMasterChatDetail(id: string): MasterChatDetailDto | undefined {
    const masterChat = this.getMasterChat(id);
    if (!masterChat) return undefined;
    return {
      masterChat,
      messages: this.getMasterChatMessages(id, "main"),
      threads: this.listThreads(masterChat.projectId).filter((thread) => thread.masterChatIds.includes(id)),
    };
  }

  getCollaborationChatDetail(id: string): CollaborationChatDetailDto | undefined {
    const masterChat = this.getMasterChat(id);
    if (!masterChat) return undefined;
    return {
      messages: this.getMasterChatMessages(id, "collaboration"),
      threads: this.listThreads(masterChat.projectId).filter((thread) => thread.masterChatIds.includes(id)),
    };
  }

  updateMasterChat(id: string, patch: UpdateMasterChatRequest): MasterChatDto | undefined {
    const row = this.db.select().from(masterChats).where(eq(masterChats.id, id)).get();
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
      .update(masterChats)
      .set({
        title: next.title,
        defaultEngine: next.defaultEngine,
        defaultModel: next.defaultModel,
        defaultEffort: next.defaultEffort,
        archived: next.archived ? 1 : 0,
        updatedAt: now,
      })
      .where(eq(masterChats.id, id))
      .run();
    const json = readJson<MasterChatJson>(masterChatJsonPath(this.dataDir, row.projectId, id));
    writeJson(masterChatJsonPath(this.dataDir, row.projectId, id), {
      ...json,
      ...next,
      defaultEngine: next.defaultEngine ?? undefined,
      defaultModel: next.defaultModel ?? undefined,
      defaultEffort: next.defaultEffort ?? undefined,
      updatedAt: now,
    });
    return this.getMasterChat(id);
  }

  /** Permanently remove a master chat while preserving its agents as unassigned threads. */
  deleteMasterChat(id: string): boolean {
    const row = this.db.select().from(masterChats).where(eq(masterChats.id, id)).get();
    if (!row) return false;
    const linkedThreads = this.listThreads(row.projectId).filter((thread) => thread.masterChatIds.includes(id));
    this.db.transaction((tx) => {
      tx.delete(threadMasterChatMemberships).where(eq(threadMasterChatMemberships.masterChatId, id)).run();
      tx.delete(masterChatMessages).where(eq(masterChatMessages.masterChatId, id)).run();
      tx.delete(masterChats).where(eq(masterChats.id, id)).run();
    });
    for (const thread of linkedThreads) {
      const remaining = thread.masterChatIds.filter((memberId) => memberId !== id);
      const primary = thread.masterChatId === id ? remaining[0] : thread.masterChatId;
      this.persistThreadMemberships(thread.id, remaining, primary);
    }
    rmSync(masterChatDir(this.dataDir, row.projectId, id), { recursive: true, force: true });
    return true;
  }

  appendMasterChatMessage(
    masterChatId: string,
    input: CreateMasterChatMessageRequest & { directReplyToAuthorThreadId?: string },
    authorThreadId?: string,
    channel: MasterChatChannel = "main",
    deliveryIntents?: MasterChatDeliveryIntent[],
    messageReceiptKey?: string,
    communicationEventId?: string,
  ): MasterChatMessageDto | undefined {
    const masterChat = this.getMasterChat(masterChatId);
    if (!masterChat) return undefined;
    const now = new Date().toISOString();
    const messagePath = channel === "collaboration"
      ? collaborationChatMessagesPath(this.dataDir, masterChat.projectId, masterChatId)
      : masterChatMessagesPath(this.dataDir, masterChat.projectId, masterChatId);
    const replyTo = input.replyToMessageId
      ? this.masterChatReference(masterChatId, channel, input.replyToMessageId)
      : undefined;
    if (input.directReplyToAuthorThreadId) {
      if (channel !== "main" || !replyTo || replyTo.authorThreadId !== input.directReplyToAuthorThreadId) {
        throw new Error("direct reply target must be the author of the referenced main-chat message");
      }
      const target = this.getThread(input.directReplyToAuthorThreadId);
      if (!target || target.archived || !target.masterChatIds.includes(masterChatId)) {
        throw new Error("direct reply target is not an active agent in this master chat");
      }
    }
    const message: MasterChatMessageJson = {
      id: randomUUID(),
      ...(communicationEventId ? { communicationEventId } : {}),
      masterChatId,
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
    mkdirSync(masterChatDir(this.dataDir, masterChat.projectId, masterChatId), { recursive: true });
    appendFileSync(
      messagePath,
      JSON.stringify(message) + "\n",
      "utf8",
    );
    this.db.insert(masterChatMessages).values({
      id: message.id,
      communicationEventId: message.communicationEventId ?? null,
      masterChatId: message.masterChatId,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      authorThreadId: message.authorThreadId,
      channel: message.channel,
      replyToJson: message.replyTo ? JSON.stringify(message.replyTo) : null,
      attachmentsJson: message.attachments?.length ? JSON.stringify(message.attachments) : null,
    }).run();
    this.db
      .update(masterChats)
      .set({ updatedAt: now })
      .where(eq(masterChats.id, masterChatId))
      .run();
    const jsonPath = masterChatJsonPath(this.dataDir, masterChat.projectId, masterChatId);
    const json = readJson<MasterChatJson>(jsonPath);
    writeJson(jsonPath, { ...json, updatedAt: now });
    if (message.communicationEventId) {
      this.appendCommunicationProjection(masterChat.projectId, {
        eventId: message.communicationEventId,
        surface: channel === "collaboration" ? "collaboration_chat" : "master_chat",
        projectionKey: masterChatId,
        projectedAt: now,
        message: {
          messageId: message.id, role: message.role, renderedText: message.text, createdAt: message.createdAt,
          ...(authorThreadId ? { authorAgentId: authorThreadId } : {}),
          ...(message.replyTo ? { replyToLegacyMessageId: message.replyTo.messageId } : {}),
          ...(message.attachments?.length ? { attachmentIds: message.attachments.map((item) => item.id) } : {}),
        },
      });
    }
    return {
      id: message.id,
      communicationEventId: message.communicationEventId,
      masterChatId: message.masterChatId,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      authorThreadId: authorThreadId ?? undefined,
      replyTo: message.replyTo,
      attachments: message.attachments,
    };
  }

  getMasterChatDeliveryIntents(masterChatId: string): Array<{
    message: MasterChatMessageDto;
    intent: MasterChatDeliveryIntent;
    messageReceiptKey?: string;
    deliveryOrderKey: string;
  }> {
    const masterChat = this.getMasterChat(masterChatId);
    if (!masterChat) return [];
    const messages = [
      ...readJsonLines<MasterChatMessageJson>(masterChatMessagesPath(this.dataDir, masterChat.projectId, masterChatId)),
      ...readJsonLines<MasterChatMessageJson>(collaborationChatMessagesPath(this.dataDir, masterChat.projectId, masterChatId)),
    ];
    return messages.flatMap((message) => (message.deliveryIntents ?? []).map((intent) => ({
      message: {
        id: message.id,
        communicationEventId: message.communicationEventId,
        masterChatId: message.masterChatId,
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

  getMasterChatMessageByReceiptKey(masterChatId: string, receiptKey: string): MasterChatMessageDto | undefined {
    const masterChat = this.getMasterChat(masterChatId);
    if (!masterChat) return undefined;
    const message = readJsonLines<MasterChatMessageJson>(
      masterChatMessagesPath(this.dataDir, masterChat.projectId, masterChatId),
    ).find((candidate) => candidate.messageReceiptKey === receiptKey);
    return message ? {
      id: message.id,
      communicationEventId: message.communicationEventId,
      masterChatId: message.masterChatId,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      authorThreadId: message.authorThreadId ?? undefined,
      replyTo: message.replyTo,
      attachments: message.attachments,
    } : undefined;
  }

  getMasterChatMessageDeliveryOrderKey(masterChatId: string, messageId: string): string | undefined {
    const masterChat = this.getMasterChat(masterChatId);
    if (!masterChat) return undefined;
    return readJsonLines<MasterChatMessageJson>(
      collaborationChatMessagesPath(this.dataDir, masterChat.projectId, masterChatId),
    ).find((message) => message.id === messageId)?.deliveryOrderKey;
  }

  setMasterChatReaction(input: {
    masterChatId: string; channel: MasterChatChannel; messageId: string; actor: ReactionActor;
    emoji: ReactionEmoji; active: boolean; idempotencyKey: string;
  }): { event: ReactionEventJson; replayed: boolean; notification: "pending" | "delivered" | "suppressed" | "not_applicable"; reactions: MessageReactionDto[] } {
    this.client.exec("BEGIN IMMEDIATE");
    try {
      const result = this.setMasterChatReactionLocked(input);
      this.client.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.client.exec("ROLLBACK"); } catch { /* transaction did not begin */ }
      throw error;
    }
  }

  private setMasterChatReactionLocked(input: {
    masterChatId: string; channel: MasterChatChannel; messageId: string; actor: ReactionActor;
    emoji: ReactionEmoji; active: boolean; idempotencyKey: string;
  }): { event: ReactionEventJson; replayed: boolean; notification: "pending" | "delivered" | "suppressed" | "not_applicable"; reactions: MessageReactionDto[] } {
    if (!REACTION_EMOJIS.has(input.emoji)) throw new Error("unsupported reaction");
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new Error("invalid idempotency key");
    const master = this.getMasterChat(input.masterChatId);
    if (!master || master.archived) throw new Error("master chat not found");
    const message = this.getMasterChatMessages(input.masterChatId, input.channel)
      .find((candidate) => candidate.id === input.messageId);
    if (!message) throw new Error("message not found in this conversation");
    if (input.actor.kind === "agent") {
      const actor = this.getThread(input.actor.threadId);
      if (!actor || actor.archived || !actor.masterChatIds.includes(input.masterChatId)) {
        throw new Error("reaction actor is not an active member");
      }
    }
    const file = reactionEventsPath(this.dataDir);
    const records = readReactionLog(file, true);
    const events = reactionOccurrences(records);
    const states = notificationStates(records);
    const actorKey = reactionActorKey(input.actor);
    const prior = events.find((candidate) =>
      reactionActorKey(candidate.actor) === actorKey && candidate.idempotencyKey === input.idempotencyKey,
    );
    if (prior) {
      const same = prior.masterChatId === input.masterChatId && prior.channel === input.channel &&
        prior.messageId === input.messageId && prior.emoji === input.emoji && prior.active === input.active;
      if (!same) throw new Error("idempotency key was used for another reaction");
      return { event: prior, replayed: true, notification: states.get(prior.occurrenceId) ?? prior.notificationInitial, reactions: this.getMessageReactions(input.masterChatId, input.channel, input.messageId, input.actor) };
    }
    if (events.length >= MAX_REACTION_EVENTS) throw new Error("reaction history bound reached");
    const latest = [...events].reverse().find((candidate) => reactionActorKey(candidate.actor) === actorKey &&
      candidate.masterChatId === input.masterChatId && candidate.channel === input.channel &&
      candidate.messageId === input.messageId && candidate.emoji === input.emoji);
    const now = new Date();
    if (latest && now.getTime() - Date.parse(latest.createdAt) < REACTION_COOLDOWN_MS) {
      throw new Error("reaction cooldown active");
    }
    const notifyTarget = message.authorThreadId && message.authorThreadId !== (input.actor.kind === "agent" ? input.actor.threadId : undefined)
      ? this.getThread(message.authorThreadId) : undefined;
    const canNotify = Boolean(notifyTarget && !notifyTarget.archived && notifyTarget.masterChatIds.includes(input.masterChatId));
    const event: ReactionEventJson = {
      kind: "occurrence",
      occurrenceId: randomUUID(), idempotencyKey: input.idempotencyKey, actor: input.actor,
      masterChatId: input.masterChatId, channel: input.channel, messageId: input.messageId,
      emoji: input.emoji, active: input.active, createdAt: now.toISOString(),
      ...(canNotify ? { notifyAuthorThreadId: message.authorThreadId } : {}),
      notificationInitial: canNotify ? "pending" : message.authorThreadId ? "suppressed" : "not_applicable",
    };
    const superseded = [...events].reverse().find((candidate) =>
      reactionActorKey(candidate.actor) === actorKey && candidate.masterChatId === input.masterChatId &&
      candidate.channel === input.channel && candidate.messageId === input.messageId && candidate.emoji === input.emoji &&
      states.get(candidate.occurrenceId) === "pending");
    const writes: ReactionLogRecord[] = [];
    if (superseded) writes.push({ kind: "notification_outcome", occurrenceId: superseded.occurrenceId, outcome: "suppressed", reason: "superseded", createdAt: now.toISOString() });
    writes.push(event);
    appendReactionRecords(file, writes);
    return { event, replayed: false, notification: event.notificationInitial, reactions: this.getMessageReactions(input.masterChatId, input.channel, input.messageId, input.actor) };
  }

  getMessageReactions(masterChatId: string, channel: MasterChatChannel, messageId: string, currentActor: ReactionActor): MessageReactionDto[] {
    const state = new Map<string, ReactionEventJson>();
    for (const event of reactionOccurrences(readReactionLog(reactionEventsPath(this.dataDir)))) {
      if (event.masterChatId === masterChatId && event.channel === channel && event.messageId === messageId) {
        state.set(`${reactionActorKey(event.actor)}:${event.emoji}`, event);
      }
    }
    return [...REACTION_EMOJIS].map((emoji) => {
      const active = [...state.values()].filter((event) => event.emoji === emoji && event.active);
      return { emoji, count: active.length, reactedByCurrentActor: active.some((event) => reactionActorKey(event.actor) === reactionActorKey(currentActor)) };
    }).filter((reaction) => reaction.count > 0 || reaction.reactedByCurrentActor);
  }

  /** Rebuildable notification outbox. Reading revalidates current membership. */
  getReactionNotificationOutbox(): Array<{ occurrenceId: string; targetThreadId: string; messageId: string; emoji: ReactionEmoji }> {
    const records = readReactionLog(reactionEventsPath(this.dataDir));
    const states = notificationStates(records);
    const invalid: string[] = [];
    const pending = reactionOccurrences(records).flatMap((event) => {
      if (states.get(event.occurrenceId) !== "pending" || !event.notifyAuthorThreadId) return [];
      const target = this.getThread(event.notifyAuthorThreadId);
      const master = this.getMasterChat(event.masterChatId);
      const messageExists = master && this.getMasterChatMessages(event.masterChatId, event.channel).some((message) => message.id === event.messageId);
      if (!target || target.archived || !target.masterChatIds.includes(event.masterChatId) || !master || master.archived || !messageExists) {
        invalid.push(event.occurrenceId);
        return [];
      }
      return [{ occurrenceId: event.occurrenceId, targetThreadId: target.id, messageId: event.messageId, emoji: event.emoji }];
    });
    for (const occurrenceId of invalid) this.completeReactionNotification(occurrenceId, "suppressed", "membership_or_message_unavailable");
    return pending;
  }

  completeReactionNotification(occurrenceId: string, outcome: "delivered" | "suppressed", reason: string = outcome): "delivered" | "suppressed" {
    this.client.exec("BEGIN IMMEDIATE");
    try {
      const file = reactionEventsPath(this.dataDir);
      const records = readReactionLog(file, true);
      const event = reactionOccurrences(records).find((candidate) => candidate.occurrenceId === occurrenceId);
      if (!event) throw new Error("reaction occurrence not found");
      const state = notificationStates(records).get(occurrenceId);
      if (state === "delivered" || state === "suppressed") { this.client.exec("COMMIT"); return state; }
      let final = outcome;
      const target = event.notifyAuthorThreadId ? this.getThread(event.notifyAuthorThreadId) : undefined;
      const master = this.getMasterChat(event.masterChatId);
      const messageExists = master && this.getMasterChatMessages(event.masterChatId, event.channel).some((message) => message.id === event.messageId);
      if (!target || target.archived || !target.masterChatIds.includes(event.masterChatId) || !master || master.archived || !messageExists) final = "suppressed";
      appendReactionRecords(file, [{ kind: "notification_outcome", occurrenceId, outcome: final, reason, createdAt: new Date().toISOString() }]);
      this.client.exec("COMMIT");
      return final;
    } catch (error) {
      try { this.client.exec("ROLLBACK"); } catch { /* no transaction */ }
      throw error;
    }
  }

  getMasterChatMessages(masterChatId: string, channel: MasterChatChannel = "main", currentActor: ReactionActor = { kind: "manager" }): MasterChatMessageDto[] {
    const master = this.getMasterChat(masterChatId);
    const backfillLinks = new Map<string, string>();
    if (master) {
      const surface = channel === "collaboration" ? "collaboration_chat" : "master_chat";
      for (const projection of this.projectionIndex(master.projectId).projections) {
        if (projection.surface === surface && projection.projectionKey === masterChatId && projection.message) {
          backfillLinks.set(projection.message.messageId, projection.eventId);
        }
      }
    }
    return this.db
      .select()
      .from(masterChatMessages)
      .where(eq(masterChatMessages.masterChatId, masterChatId))
      .orderBy(asc(masterChatMessages.createdAt))
      .all()
      .filter((row) => row.channel === channel)
      .map((row) => ({
        id: row.id,
        communicationEventId: row.communicationEventId ?? backfillLinks.get(row.id),
        masterChatId: row.masterChatId,
        role:
          row.role === "assistant" || row.role === "system"
            ? row.role
            : "user",
        text: row.text,
        createdAt: row.createdAt,
        authorThreadId: row.authorThreadId ?? undefined,
        replyTo: row.replyToJson ? JSON.parse(row.replyToJson) : undefined,
        attachments: row.attachmentsJson ? JSON.parse(row.attachmentsJson) : undefined,
        reactions: this.getMessageReactions(masterChatId, channel, row.id, currentActor),
      }));
  }

  /**
   * Materialize a room timeline from canonical communication events and their
   * projection ledger. Legacy rows are consulted only for ancillary snapshots
   * (attachments and quoted replies) until those immutable payloads move into
   * the canonical envelope; they do not select membership, ordering, or text.
   */
  getProjectedMasterChatMessages(
    masterChatId: string,
    channel: MasterChatChannel = "main",
    currentActor: ReactionActor = { kind: "manager" },
  ): MasterChatMessageDto[] {
    const master = this.getMasterChat(masterChatId);
    if (!master) return [];
    const surface = channel === "collaboration" ? "collaboration_chat" : "master_chat";
    const legacy = new Map(this.getMasterChatMessages(masterChatId, channel, currentActor).map((message) => [message.id, message]));
    return this.readProjectedCommunicationMessages(master.projectId, surface, masterChatId).map((message) => {
      const ancillary = legacy.get(message.messageId);
      return {
        id: message.messageId,
        communicationEventId: message.eventId,
        masterChatId,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        ...(message.authorAgentId ? { authorThreadId: message.authorAgentId } : {}),
        ...(ancillary?.replyTo ? { replyTo: ancillary.replyTo } : {}),
        ...(ancillary?.attachments?.length ? { attachments: ancillary.attachments } : {}),
        reactions: this.getMessageReactions(masterChatId, channel, message.messageId, currentActor),
      };
    });
  }

  private masterChatReference(masterChatId: string, channel: MasterChatChannel, messageId: string) {
    const target = this.getMasterChatMessages(masterChatId, channel).find((message) => message.id === messageId);
    if (!target) throw new Error("reply target was not found in this conversation");
    return {
      messageId: target.id,
      text: target.text,
      role: target.role,
      authorThreadId: target.authorThreadId,
    };
  }

  // ─── Threads ───────────────────────────────────────────────────────────────

  createThread(projectId: string, input: CreateThreadRequest): ThreadDto {
    const id = randomUUID();
    const now = new Date().toISOString();
    const preset = input.presetId ? this.getAgentPreset(input.presetId) : undefined;
    if (input.presetId && (!preset || preset.projectId !== projectId || !preset.enabled)) throw new Error("invalid preset");
    const presetSnapshot = preset ? { id: preset.id, name: preset.name, description: preset.description, guidance: preset.guidance, engine: preset.engine, model: preset.model, effort: preset.effort } : undefined;
    const record: ThreadJson = {
      id,
      projectId,
      masterChatId: input.masterChatId,
      masterChatIds: input.masterChatId ? [input.masterChatId] : [],
      title: input.title,
      activeEngine: input.engine,
      createdAt: now,
      updatedAt: now,
      archived: false,
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
        masterChatId: input.masterChatId ?? null,
        title: input.title,
        activeEngine: input.engine,
        createdAt: now,
        updatedAt: now,
        archived: 0,
        presetSnapshotJson: presetSnapshot ? JSON.stringify(presetSnapshot) : null,
      })
      .run();
    if (input.masterChatId) {
      this.db.insert(threadMasterChatMemberships).values({ threadId: id, masterChatId: input.masterChatId, position: 0 }).run();
    }
    return this.rowToThreadDto(id)!;
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

  updateThread(id: string, patch: UpdateThreadRequest): ThreadDto | undefined {
    const row = this.db.select().from(threads).where(eq(threads.id, id)).get();
    if (!row) return undefined;
    const now = new Date().toISOString();
    const title = patch.title ?? row.title;
    const archived = patch.archived ?? row.archived === 1;
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

  updateThreadMasterChatMemberships(
    id: string,
    input: UpdateThreadMasterChatMembershipsRequest,
  ): ThreadDto | undefined {
    const thread = this.getThread(id);
    if (!thread) return undefined;
    const ids = [...new Set(input.masterChatIds)];
    if (ids.length !== input.masterChatIds.length) throw new Error("duplicate master chat membership");
    if (ids.length > 0 && !input.primaryMasterChatId) throw new Error("primary master chat is required");
    if (input.primaryMasterChatId && !ids.includes(input.primaryMasterChatId)) {
      throw new Error("primary master chat must be a member");
    }
    for (const masterChatId of ids) {
      const master = this.getMasterChat(masterChatId);
      if (!master || master.projectId !== thread.projectId) throw new Error("master chat does not belong to project");
      if (master.archived && !thread.masterChatIds.includes(masterChatId)) throw new Error("archived master chat cannot accept assignments");
    }
    this.persistThreadMemberships(id, ids, input.primaryMasterChatId);
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

    this.db.transaction((tx) => {
      tx.delete(events).where(eq(events.threadId, id)).run();
      tx.delete(artifacts).where(eq(artifacts.threadId, id)).run();
      tx.delete(tasks).where(eq(tasks.threadId, id)).run();
      tx.delete(messages).where(eq(messages.threadId, id)).run();
      tx.delete(threadMasterChatMemberships).where(eq(threadMasterChatMemberships.threadId, id)).run();
      tx.delete(threads).where(eq(threads.id, id)).run();
    });

    // Remove the on-disk thread directory (the canonical log lives here).
    rmSync(threadDir(this.dataDir, row.projectId, id), { recursive: true, force: true });

    // Drop any cached log writer / projection state.
    this.logs.delete(id);
    this.states.delete(id);
    return true;
  }

  /** Full four-pane hydration for GET /api/threads/:id (SPEC §8). */
  getThreadDetail(id: string): ThreadDetailDto | undefined {
    const thread = this.rowToThreadDto(id);
    if (!thread) return undefined;
    return {
      thread,
      messages: this.getMessages(id),
      tasks: this.getTasks(id),
      artifacts: this.getArtifacts(id),
      state: thread.state,
    };
  }

  getMessages(threadId: string): MessageDto[] {
    const thread = this.getThread(threadId);
    const backfillLinks = new Map<string, string>();
    if (thread) {
      for (const projection of this.projectionIndex(thread.projectId).projections) {
        if (projection.surface === "direct_agent_audit" && projection.projectionKey === threadId && projection.message) {
          backfillLinks.set(projection.message.messageId, projection.eventId);
        }
      }
    }
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.seq))
      .all()
      .map((r) => ({
        id: r.id,
        communicationEventId: r.communicationEventId ?? backfillLinks.get(r.id),
        threadId: r.threadId,
        seq: r.seq,
        role: r.role === "user" ? "user" : "assistant",
        text: r.text,
        createdAt: r.createdAt,
        replyTo: r.replyToJson ? JSON.parse(r.replyToJson) : undefined,
        attachments: r.attachmentsJson ? JSON.parse(r.attachmentsJson) : undefined,
      }));
  }

  getProjectedThreadMessages(threadId: string): MessageDto[] {
    const thread = this.getThread(threadId);
    if (!thread) return [];
    const legacy = new Map(this.getMessages(threadId).map((message) => [message.id, message]));
    return this.readProjectedCommunicationMessages(thread.projectId, "direct_agent_audit", threadId)
      .flatMap((message) => {
        const ancillary = legacy.get(message.messageId);
        if (!ancillary || message.role === "system") return [];
        return [{
          id: message.messageId,
          communicationEventId: message.eventId,
          threadId,
          seq: ancillary.seq,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
          ...(ancillary.replyTo ? { replyTo: ancillary.replyTo } : {}),
          ...(ancillary.attachments?.length ? { attachments: ancillary.attachments } : {}),
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
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.threadId, threadId))
      .orderBy(asc(artifacts.createdAt))
      .all()
      .map((r) => ({
        id: r.id,
        threadId: r.threadId,
        taskId: r.taskId ?? undefined,
        kind: r.kind as ArtifactKind,
        path: r.path,
        summary: r.summary ?? undefined,
        createdAt: r.createdAt,
      }));
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
    const communicationEventId = event.type === "communication_projection" || event.type === "user_message" || event.type === "text"
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
    this.db.delete(threadMasterChatMemberships).run();
    this.db.delete(masterChatMessages).run();
    this.db.delete(masterChats).run();
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

      const mDir = masterChatsDir(this.dataDir, projectId);
      if (existsSync(mDir)) {
        for (const masterChatId of readdirSync(mDir)) {
          const mj = masterChatJsonPath(this.dataDir, projectId, masterChatId);
          if (!existsSync(mj)) continue;
          const m = readJson<MasterChatJson>(mj);
          this.db
            .insert(masterChats)
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
            ["main", masterChatMessagesPath(this.dataDir, projectId, masterChatId)],
            ["collaboration", collaborationChatMessagesPath(this.dataDir, projectId, masterChatId)],
          ] as const) {
            for (const message of readJsonLines<MasterChatMessageJson>(messagePath)) {
              this.db.insert(masterChatMessages).values({
                id: message.id,
                communicationEventId: message.communicationEventId ?? null,
                masterChatId: message.masterChatId,
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
        const membershipIds = [...new Set(t.masterChatIds ?? (t.masterChatId ? [t.masterChatId] : []))];
        const primaryMasterChatId = t.masterChatId && membershipIds.includes(t.masterChatId)
          ? t.masterChatId
          : membershipIds[0];
        this.db
          .insert(threads)
          .values({
            id: t.id,
            projectId: t.projectId,
            masterChatId: primaryMasterChatId ?? null,
            title: t.title,
            activeEngine: t.activeEngine,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            archived: t.archived ? 1 : 0,
            presetSnapshotJson: t.presetSnapshot ? JSON.stringify(t.presetSnapshot) : null,
          })
          .run();
        membershipIds.forEach((masterChatId, position) => {
          this.db.insert(threadMasterChatMemberships).values({ threadId: t.id, masterChatId, position }).run();
        });
        if (t.masterChatIds === undefined || t.masterChatId !== primaryMasterChatId) {
          writeJson(tj, { ...t, masterChatId: primaryMasterChatId, masterChatIds: membershipIds });
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
      masterChatId: row.masterChatId ?? undefined,
      masterChatIds: this.db.select().from(threadMasterChatMemberships)
        .where(eq(threadMasterChatMemberships.threadId, row.id))
        .orderBy(asc(threadMasterChatMemberships.position)).all().map((membership) => membership.masterChatId),
      title: row.title,
      activeEngine: row.activeEngine,
      state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archived: row.archived === 1,
      presetSnapshot: row.presetSnapshotJson ? JSON.parse(row.presetSnapshotJson) as ThreadDto["presetSnapshot"] : undefined,
    };
  }


  private persistThreadMemberships(id: string, masterChatIds: string[], primaryMasterChatId?: string): void {
    const row = this.db.select().from(threads).where(eq(threads.id, id)).get();
    if (!row) throw new Error(`unknown thread: ${id}`);
    const now = new Date().toISOString();
    const jsonPath = threadJsonPath(this.dataDir, row.projectId, id);
    const json = readJson<ThreadJson>(jsonPath);
    // Canonical metadata is committed first; SQLite remains a rebuildable projection.
    writeJson(jsonPath, { ...json, masterChatId: primaryMasterChatId, masterChatIds, updatedAt: now });
    this.db.transaction((tx) => {
      tx.delete(threadMasterChatMemberships).where(eq(threadMasterChatMemberships.threadId, id)).run();
      masterChatIds.forEach((masterChatId, position) => {
        tx.insert(threadMasterChatMemberships).values({ threadId: id, masterChatId, position }).run();
      });
      tx.update(threads).set({ masterChatId: primaryMasterChatId ?? null, updatedAt: now }).where(eq(threads.id, id)).run();
    });
  }

  private masterChatRowToDto(row: typeof masterChats.$inferSelect): MasterChatDto {
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
