// ThreadStore — the library that apps/server consumes. Ties together the on-disk
// event logs (source of truth), the SQLite projections, and the pure projectors.
// Exposes NO HTTP (SPEC §7). SQLite is never a source of truth: everything here is
// derivable from the logs + the *.json files, and `rebuildProjections()` proves it.

import { randomUUID } from "node:crypto";
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
import { asc, eq } from "drizzle-orm";
import type {
  ArtifactDto,
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
  masterChatJsonPath,
  masterChatMessagesPath,
  masterChatsDir,
  projectJsonPath,
  agentPresetsPath,
  projectsDir,
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
  kind: "tag" | "delegation_completion";
  delegatedRunId?: string;
}

interface MasterChatMessageJson {
  id: string;
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

export class ThreadStore {
  private readonly db: Db;
  private readonly client: Database.Database;
  private readonly logs = new Map<string, EventLog>();
  private readonly states = new Map<string, ProjectionState>();
  private readonly deliverySequenceFile: string;
  private deliverySequence: number;

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
  }

  nextDeliveryOrderKey(createdAt = new Date().toISOString()): string {
    this.deliverySequence += 1;
    appendFileSync(this.deliverySequenceFile, `${JSON.stringify({ sequence: this.deliverySequence })}\n`, "utf8");
    return `${createdAt}:${String(this.deliverySequence).padStart(16, "0")}`;
  }

  /** Expose the drizzle db for advanced/read-only queries (e.g. the v2 search). */
  get database(): Db {
    return this.db;
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
    input: CreateMasterChatMessageRequest,
    authorThreadId?: string,
    channel: MasterChatChannel = "main",
    deliveryIntents?: MasterChatDeliveryIntent[],
    messageReceiptKey?: string,
  ): MasterChatMessageDto | undefined {
    const masterChat = this.getMasterChat(masterChatId);
    if (!masterChat) return undefined;
    const now = new Date().toISOString();
    const messagePath = channel === "collaboration"
      ? collaborationChatMessagesPath(this.dataDir, masterChat.projectId, masterChatId)
      : masterChatMessagesPath(this.dataDir, masterChat.projectId, masterChatId);
    const message: MasterChatMessageJson = {
      id: randomUUID(),
      masterChatId,
      role: input.role ?? "user",
      text: input.text,
      createdAt: now,
      authorThreadId: authorThreadId ?? null,
      channel,
      ...(input.replyToMessageId
        ? { replyTo: this.masterChatReference(masterChatId, channel, input.replyToMessageId) }
        : {}),
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
    return {
      id: message.id,
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
    return readJsonLines<MasterChatMessageJson>(
      collaborationChatMessagesPath(this.dataDir, masterChat.projectId, masterChatId),
    ).flatMap((message) => (message.deliveryIntents ?? []).map((intent) => ({
      message: {
        id: message.id,
        masterChatId: message.masterChatId,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        authorThreadId: message.authorThreadId ?? undefined,
      },
      intent,
      messageReceiptKey: message.messageReceiptKey,
      deliveryOrderKey: message.deliveryOrderKey ?? `${message.createdAt}:${String(0).padStart(12, "0")}`,
    })));
  }

  getMasterChatMessageDeliveryOrderKey(masterChatId: string, messageId: string): string | undefined {
    const masterChat = this.getMasterChat(masterChatId);
    if (!masterChat) return undefined;
    return readJsonLines<MasterChatMessageJson>(
      collaborationChatMessagesPath(this.dataDir, masterChat.projectId, masterChatId),
    ).find((message) => message.id === messageId)?.deliveryOrderKey;
  }

  getMasterChatMessages(masterChatId: string, channel: MasterChatChannel = "main"): MasterChatMessageDto[] {
    return this.db
      .select()
      .from(masterChatMessages)
      .where(eq(masterChatMessages.masterChatId, masterChatId))
      .orderBy(asc(masterChatMessages.createdAt))
      .all()
      .filter((row) => row.channel === channel)
      .map((row) => ({
        id: row.id,
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
      }));
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
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.seq))
      .all()
      .map((r) => ({
        id: r.id,
        threadId: r.threadId,
        seq: r.seq,
        role: r.role === "user" ? "user" : "assistant",
        text: r.text,
        createdAt: r.createdAt,
        replyTo: r.replyToJson ? JSON.parse(r.replyToJson) : undefined,
        attachments: r.attachmentsJson ? JSON.parse(r.attachmentsJson) : undefined,
      }));
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
}
