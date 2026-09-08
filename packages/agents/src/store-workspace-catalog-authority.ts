import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import type {
  AgentDto,
  AgentPresetDto,
  CollaborationViewDto,
  ConversationChannel,
  ConversationDetailDto,
  ConversationDto,
  ConversationMessageDto,
  CreateAgentPresetRequest,
  CreateConversationRequest,
  CreateProjectRequest,
  ProjectDto,
  UpdateAgentPresetRequest,
  UpdateConversationRequest,
  UpdateProjectRequest,
} from "@ponderosa/core";
import type { Db } from "./db.js";
import { appendFsyncedJsonl, readRepairableJsonl, writeAtomicFsyncedJsonl } from "./append-jsonl.js";
import { fsyncDirectory, readJson, writeJson } from "./store-filesystem.js";
import type {
  ConversationDeletionReceipt,
  ConversationJson,
  PresetEvent,
  ProjectJson,
} from "./store-types.js";
import {
  agentPresets,
  conversationDeletionReceipts,
  conversations,
  projectDeletionReceipts,
  projects,
} from "./schema.js";
import {
  agentPresetsPath,
  agentsDir,
  conversationDir,
  conversationsDir,
  conversationJsonPath,
  projectDir,
  projectJsonPath,
  projectsDir,
} from "./paths.js";

export interface WorkspaceCreationIdentity {
  idempotencyKey: string;
  payloadHash: string;
}

const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function creationId(kind: "project" | "conversation", scope: string, key: string): string {
  const hash = createHash("sha256").update(`${kind}\0${scope}\0${key}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${
    ((Number.parseInt(hash[16]!, 16) & 3) | 8).toString(16)
  }${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function assertCreationIdentity(
  record: Pick<ProjectJson | ConversationJson, "creationIdempotencyKey" | "creationPayloadHash">,
  identity: WorkspaceCreationIdentity,
): void {
  if (record.creationIdempotencyKey !== identity.idempotencyKey ||
      record.creationPayloadHash !== identity.payloadHash) {
    throw new Error("Creation idempotency key was reused with different input");
  }
}

const BUILTIN_PRESETS: Array<Omit<CreateAgentPresetRequest, "engine"> & { engine: "codex" }> = [
  { name: "Frontend", description: "Accessible, polished product UI", guidance: "Act as a product-minded frontend engineer. Prioritize responsive UX, accessibility, and coherent user flows.", engine: "codex" },
  { name: "Security", description: "Threat-model and harden changes", guidance: "Act as a security reviewer. Preserve trust boundaries, minimize authority, and inspect abuse cases and security-sensitive edge cases.", engine: "codex" },
  { name: "QA", description: "Find regressions and verify behavior", guidance: "Act as a QA engineer. Build a risk-based manual qualification plan, reproduce failures through focused live workflows, and report evidence precisely.", engine: "codex" },
  { name: "Documentation", description: "Create clear, accurate documentation", guidance: "Act as a technical writer. Verify behavior in the code and write concise task-oriented documentation.", engine: "codex" },
];

export class AgentWorkspaceCatalogAuthority {
  constructor(
    private readonly dataDir: string,
    private readonly db: Db,
    private readonly listAgents: (projectId: string) => AgentDto[],
    private readonly getConversationMessages: (
      conversationId: string,
      channel?: ConversationChannel,
    ) => ConversationMessageDto[],
    private readonly refreshAllChatFeedProject: (projectId: string) => void,
    private readonly setHistoryConversationVisibility: (
      projectId: string,
      conversationId: string,
      visible: boolean,
    ) => void,
  ) {}

  recoverCreationDirectories(): void {
    const projectsRoot = projectsDir(this.dataDir);
    if (!existsSync(projectsRoot)) return;
    for (const entry of readdirSync(projectsRoot)) {
      const projectMatch = /^\.(.+)\.creating$/u.exec(entry);
      if (projectMatch && workspaceIdPattern.test(projectMatch[1]!)) {
        this.recoverProjectCreation(entry, projectMatch[1]!);
      }
    }
    for (const projectId of readdirSync(projectsRoot)) {
      if (projectId.startsWith(".")) continue;
      const root = conversationsDir(this.dataDir, projectId);
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root)) {
        const conversationMatch = /^\.(.+)\.creating$/u.exec(entry);
        if (conversationMatch && workspaceIdPattern.test(conversationMatch[1]!)) {
          this.recoverConversationCreation(projectId, entry, conversationMatch[1]!);
        }
      }
      this.recoverConversationRecency(projectId);
    }
  }

  private recoverConversationRecency(projectId: string): void {
    try {
      const projectPath = projectJsonPath(this.dataDir, projectId);
      const project = readJson<ProjectJson>(projectPath);
      const unfinished = readdirSync(conversationsDir(this.dataDir, projectId))
        .filter((id) => !id.startsWith(".") && !this.db.select({ id: conversations.id })
          .from(conversations).where(eq(conversations.id, id)).get())
        .map((id) => readJson<ConversationJson>(conversationJsonPath(this.dataDir, projectId, id)))
        .filter((record) => record.id && record.projectId === projectId &&
          record.creationIdempotencyKey && record.creationPayloadHash &&
          record.updatedAt >= (project.lastUsedAt ?? project.createdAt))
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) ||
          left.id.localeCompare(right.id))
        .at(-1);
      if (!unfinished) return;
      writeJson(projectPath, {
        ...project,
        lastUsedAt: unfinished.updatedAt,
        lastConversationId: unfinished.id,
      });
    } catch {
      // Incomplete or foreign current storage is left untouched for projection validation.
    }
  }

  private recoverProjectCreation(stagingId: string, id: string): void {
    try {
      const record = readJson<ProjectJson>(projectJsonPath(this.dataDir, stagingId));
      const defaultConversation = record.lastConversationId
        ? readJson<ConversationJson>(
          conversationJsonPath(this.dataDir, stagingId, record.lastConversationId),
        )
        : undefined;
      if (record.id !== id || !record.creationIdempotencyKey || !record.creationPayloadHash ||
          !record.lastConversationId ||
          defaultConversation?.id !== record.lastConversationId ||
          defaultConversation.projectId !== id) return;
      const presets = readRepairableJsonl<PresetEvent>(
        agentPresetsPath(this.dataDir, stagingId),
        "staged Agent preset journal",
      );
      if (BUILTIN_PRESETS.some((preset) => !presets.some((event) =>
        event.type === "upsert" && event.preset.name === preset.name))) return;
      const finalRoot = projectDir(this.dataDir, id);
      if (existsSync(finalRoot)) {
        const current = readJson<ProjectJson>(projectJsonPath(this.dataDir, id));
        assertCreationIdentity(current, {
          idempotencyKey: record.creationIdempotencyKey,
          payloadHash: record.creationPayloadHash,
        });
        rmSync(projectDir(this.dataDir, stagingId), { recursive: true });
      } else {
        renameSync(projectDir(this.dataDir, stagingId), finalRoot);
      }
      fsyncDirectory(projectsDir(this.dataDir));
    } catch {
      // Unauthenticated or incomplete staging is preserved for forensic recovery.
    }
  }

  private recoverConversationCreation(projectId: string, stagingId: string, id: string): void {
    try {
      const record = readJson<ConversationJson>(conversationJsonPath(this.dataDir, projectId, stagingId));
      if (record.id !== id || record.projectId !== projectId ||
          !record.creationIdempotencyKey || !record.creationPayloadHash) return;
      const finalRoot = conversationDir(this.dataDir, projectId, id);
      if (existsSync(finalRoot)) {
        const current = readJson<ConversationJson>(conversationJsonPath(this.dataDir, projectId, id));
        assertCreationIdentity(current, {
          idempotencyKey: record.creationIdempotencyKey,
          payloadHash: record.creationPayloadHash,
        });
        rmSync(conversationDir(this.dataDir, projectId, stagingId), { recursive: true });
      } else {
        renameSync(conversationDir(this.dataDir, projectId, stagingId), finalRoot);
      }
      fsyncDirectory(conversationsDir(this.dataDir, projectId));
    } catch {
      // Unauthenticated or incomplete staging is preserved for forensic recovery.
    }
  }

  getProjectCreation(identity: WorkspaceCreationIdentity): ProjectDto | undefined {
    const id = creationId("project", "workspace", identity.idempotencyKey);
    if (this.db.select({ projectId: projectDeletionReceipts.projectId })
      .from(projectDeletionReceipts).where(eq(projectDeletionReceipts.projectId, id)).get()) {
      throw new Error("This Project creation was already deleted");
    }
    if (!existsSync(projectJsonPath(this.dataDir, id))) return undefined;
    assertCreationIdentity(readJson<ProjectJson>(projectJsonPath(this.dataDir, id)), identity);
    return this.getProject(id);
  }

  createProject(
    input: Omit<CreateProjectRequest, "defaultEngine"> & {
      hostPath: string;
      defaultEngine?: CreateProjectRequest["defaultEngine"];
    },
    identity?: WorkspaceCreationIdentity,
  ): ProjectDto {
    const replay = identity ? this.getProjectCreation(identity) : undefined;
    if (replay) return replay;
    const id = identity ? creationId("project", "workspace", identity.idempotencyKey) : randomUUID();
    const conversationId = identity
      ? creationId("conversation", id, `${identity.idempotencyKey}:default`)
      : randomUUID();
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
      ...(identity ? {
        creationIdempotencyKey: identity.idempotencyKey,
        creationPayloadHash: identity.payloadHash,
      } : {}),
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
      if (existsSync(stagingRoot)) {
        const staged = readJson<ProjectJson>(projectJsonPath(this.dataDir, stagingId));
        if (!identity) throw new Error("Project creation staging is already present");
        assertCreationIdentity(staged, identity);
        rmSync(stagingRoot, { recursive: true });
      }
      writeJson(projectJsonPath(this.dataDir, stagingId), record);
      mkdirSync(conversationDir(this.dataDir, stagingId, conversationId), { recursive: true });
      writeJson(conversationJsonPath(this.dataDir, stagingId, conversationId), conversation);
      mkdirSync(agentsDir(this.dataDir, stagingId), { recursive: true });
      const presets = BUILTIN_PRESETS.map((preset) => ({
        type: "upsert" as const,
        preset: {
          id: creationId("project", `${id}:preset`, preset.name),
          projectId: id,
          ...preset,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        } satisfies AgentPresetDto,
      } satisfies PresetEvent));
      writeAtomicFsyncedJsonl(agentPresetsPath(this.dataDir, stagingId), presets);
      renameSync(stagingRoot, projectDir(this.dataDir, id));
      fsyncDirectory(projectsDir(this.dataDir));
      this.db.transaction((tx) => {
        tx.insert(projects).values({ id, label: input.label, hostPath: input.hostPath, createdAt: now, lastUsedAt: now, defaultEngine, defaultModel: input.defaultModel ?? null, defaultEffort: input.defaultEffort ?? null, lastConversationId: conversationId }).run();
        tx.insert(conversations).values({ id: conversationId, projectId: id, title: "New Chat", defaultEngine, defaultModel: input.defaultModel ?? null, defaultEffort: input.defaultEffort ?? null, createdAt: now, updatedAt: now, archived: 0 }).run();
        for (const event of presets) {
          tx.insert(agentPresets).values({ ...event.preset, enabled: 1 }).run();
        }
      });
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true });
      rmSync(projectDir(this.dataDir, id), { recursive: true, force: true });
      fsyncDirectory(projectsDir(this.dataDir));
      throw error;
    }
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
    const canonical = readJson<ProjectJson>(projectJsonPath(this.dataDir, id));
    const record: ProjectJson = {
      ...canonical,
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
    writeJson(projectJsonPath(this.dataDir, projectId), {
      ...readJson<ProjectJson>(projectJsonPath(this.dataDir, projectId)),
      ...next,
    });
    this.db.update(projects).set({ lastUsedAt, ...(conversationId ? { lastConversationId: conversationId } : {}) }).where(eq(projects.id, projectId)).run();
    return next;
  }

  // ─── Conversations ─────────────────────────────────────────────────────────

  getConversationCreation(
    projectId: string,
    identity: WorkspaceCreationIdentity,
  ): ConversationDto | undefined {
    const id = creationId("conversation", projectId, identity.idempotencyKey);
    if (this.db.select({ conversationId: conversationDeletionReceipts.conversationId })
      .from(conversationDeletionReceipts)
      .where(eq(conversationDeletionReceipts.conversationId, id)).get()) {
      throw new Error("This Chat creation was already deleted");
    }
    if (!existsSync(conversationJsonPath(this.dataDir, projectId, id))) return undefined;
    assertCreationIdentity(
      readJson<ConversationJson>(conversationJsonPath(this.dataDir, projectId, id)),
      identity,
    );
    return this.getConversation(id);
  }

  createConversation(
    projectId: string,
    input: CreateConversationRequest,
    identity?: WorkspaceCreationIdentity,
  ): ConversationDto {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`unknown project: ${projectId}`);
    const replay = identity ? this.getConversationCreation(projectId, identity) : undefined;
    if (replay) return replay;
    const id = identity ? creationId("conversation", projectId, identity.idempotencyKey) : randomUUID();
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
      ...(identity ? {
        creationIdempotencyKey: identity.idempotencyKey,
        creationPayloadHash: identity.payloadHash,
      } : {}),
    };
    const stagingId = `.${id}.creating`;
    const stagingRoot = conversationDir(this.dataDir, projectId, stagingId);
    const canonicalRoot = conversationDir(this.dataDir, projectId, id);
    const previousProjectRecord = readJson<ProjectJson>(projectJsonPath(this.dataDir, projectId));
    try {
      if (existsSync(stagingRoot)) {
        const staged = readJson<ConversationJson>(
          conversationJsonPath(this.dataDir, projectId, stagingId),
        );
        if (!identity) throw new Error("Chat creation staging is already present");
        assertCreationIdentity(staged, identity);
        rmSync(stagingRoot, { recursive: true });
      }
      mkdirSync(stagingRoot, { recursive: true });
      writeJson(conversationJsonPath(this.dataDir, projectId, stagingId), record);
      renameSync(stagingRoot, canonicalRoot);
      fsyncDirectory(conversationsDir(this.dataDir, projectId));
      writeJson(projectJsonPath(this.dataDir, projectId), {
        ...previousProjectRecord,
        lastUsedAt: now,
        lastConversationId: id,
      });
      this.db.transaction((tx) => {
        tx.insert(conversations).values({
          id,
          projectId,
          title: record.title,
          defaultEngine: record.defaultEngine ?? null,
          defaultModel: record.defaultModel ?? null,
          defaultEffort: record.defaultEffort ?? null,
          createdAt: now,
          updatedAt: now,
          archived: 0,
        }).run();
        tx.update(projects).set({ lastUsedAt: now, lastConversationId: id })
          .where(eq(projects.id, projectId)).run();
      });
    } catch (error) {
      try {
        rmSync(stagingRoot, { recursive: true, force: true });
        rmSync(canonicalRoot, { recursive: true, force: true });
        fsyncDirectory(conversationsDir(this.dataDir, projectId));
        writeJson(projectJsonPath(this.dataDir, projectId), previousProjectRecord);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Chat creation and rollback both failed");
      }
      throw error;
    }
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
      agents: this.listAgents(conversation.projectId).filter((agent) => agent.conversationId === id),
    };
  }

  getCollaborationViewDetail(id: string): CollaborationViewDto | undefined {
    const conversation = this.getConversation(id);
    if (!conversation) return undefined;
    return {
      messages: this.getConversationMessages(id, "collaboration"),
      agents: this.listAgents(conversation.projectId).filter((agent) => agent.conversationId === id),
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
    this.db.transaction((tx) => {
      tx.update(conversations)
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
      if (next.archived !== (row.archived === 1)) {
        this.setHistoryConversationVisibility(row.projectId, id, !next.archived);
      }
    });
    const json = readJson<ConversationJson>(
      conversationJsonPath(this.dataDir, row.projectId, id),
    );
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

  getConversationDeletionReceipt(id: string): ConversationDeletionReceipt | undefined {
    const row = this.db.select().from(conversationDeletionReceipts)
      .where(eq(conversationDeletionReceipts.conversationId, id)).get();
    return row ? {
      conversationId: row.conversationId,
      projectId: row.projectId,
      canonicalDeletionCompleted: row.canonicalDeletionCompleted === 1,
      storageCleanupCompleted: row.storageCleanupCompleted === 1,
      serverCleanupCompleted: row.serverCleanupCompleted === 1,
      ...(row.lastError ? { lastError: row.lastError } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    } : undefined;
  }

  listPendingConversationDeletionReceipts(): ConversationDeletionReceipt[] {
    return this.db.select().from(conversationDeletionReceipts).all()
      .filter(row => row.canonicalDeletionCompleted !== 1 ||
        row.storageCleanupCompleted !== 1 || row.serverCleanupCompleted !== 1)
      .map(row => ({
        conversationId: row.conversationId,
        projectId: row.projectId,
        canonicalDeletionCompleted: row.canonicalDeletionCompleted === 1,
        storageCleanupCompleted: row.storageCleanupCompleted === 1,
        serverCleanupCompleted: row.serverCleanupCompleted === 1,
        ...(row.lastError ? { lastError: row.lastError } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.completedAt ? { completedAt: row.completedAt } : {}),
      }));
  }

  markConversationDeletionPending(id: string): ConversationDeletionReceipt {
    const prior = this.getConversationDeletionReceipt(id);
    if (prior) return prior;
    const row = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!row) throw new Error("conversation not found");
    const now = new Date().toISOString();
    this.db.insert(conversationDeletionReceipts).values({
      conversationId: id,
      projectId: row.projectId,
      canonicalDeletionCompleted: 0,
      storageCleanupCompleted: 0,
      serverCleanupCompleted: 0,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({ target: conversationDeletionReceipts.conversationId }).run();
    const receipt = this.getConversationDeletionReceipt(id);
    if (!receipt || receipt.projectId !== row.projectId) {
      throw new Error("Chat deletion intent could not be persisted");
    }
    return receipt;
  }

  recordConversationDeletionCleanupError(id: string, error: string): void {
    this.db.update(conversationDeletionReceipts).set({
      lastError: error.slice(0, 4_000),
      updatedAt: new Date().toISOString(),
    }).where(eq(conversationDeletionReceipts.conversationId, id)).run();
  }

  finishConversationDeletionStorageCleanup(
    receipt: ConversationDeletionReceipt,
  ): void {
    const current = this.getConversationDeletionReceipt(receipt.conversationId);
    if (!current) throw new Error("Chat deletion receipt not found");
    if (!current.canonicalDeletionCompleted) {
      throw new Error("Chat canonical deletion must finish before storage cleanup");
    }
    if (current.storageCleanupCompleted) return;
    rmSync(conversationDir(this.dataDir, current.projectId, current.conversationId), {
      recursive: true,
      force: true,
    });
    this.db.update(conversationDeletionReceipts).set({
      storageCleanupCompleted: 1,
      lastError: null,
      updatedAt: new Date().toISOString(),
    }).where(eq(conversationDeletionReceipts.conversationId, current.conversationId)).run();
  }

  refreshConversationDeletionProjection(receipt: ConversationDeletionReceipt): void {
    this.refreshAllChatFeedProject(receipt.projectId);
  }

  markConversationDeletionServerCleanupComplete(id: string): void {
    const current = this.getConversationDeletionReceipt(id);
    if (!current) throw new Error("Chat deletion receipt not found");
    if (!current.storageCleanupCompleted) {
      throw new Error("Chat storage cleanup must finish before server cleanup");
    }
    if (!current.canonicalDeletionCompleted) {
      throw new Error("Chat canonical deletion must finish before server cleanup");
    }
    const now = new Date().toISOString();
    this.db.update(conversationDeletionReceipts).set({
      serverCleanupCompleted: 1,
      lastError: null,
      updatedAt: now,
      completedAt: now,
    }).where(eq(conversationDeletionReceipts.conversationId, id)).run();
  }

  /** Permanently commit removal of an empty Chat after its owned Agents have
   * been deleted. Fallible storage and server cleanup use the returned receipt. */
  commitConversationDeletion(
    id: string,
    beforeProjectionDelete?: (conversationId: string) => void,
  ): ConversationDeletionReceipt | undefined {
    const prior = this.getConversationDeletionReceipt(id);
    if (prior?.canonicalDeletionCompleted) return prior;
    const row = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!row) {
      if (!prior || this.getProject(prior.projectId) ||
          !this.db.select({ projectId: projectDeletionReceipts.projectId })
            .from(projectDeletionReceipts)
            .where(eq(projectDeletionReceipts.projectId, prior.projectId)).get()) {
        return undefined;
      }
      this.db.update(conversationDeletionReceipts).set({
        canonicalDeletionCompleted: 1,
        lastError: null,
        updatedAt: new Date().toISOString(),
      }).where(eq(conversationDeletionReceipts.conversationId, id)).run();
      return this.getConversationDeletionReceipt(id)!;
    }
    const intent = prior ?? this.markConversationDeletionPending(id);
    if (intent.projectId !== row.projectId) {
      throw new Error("Chat deletion intent belongs to a different Project");
    }
    const linkedAgents = this.listAgents(row.projectId).filter((agent) => agent.conversationId === id);
    if (linkedAgents.length > 0) throw new Error("delete the Chat's Agents before deleting the Chat");
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      // Communication and Automation cleanup share this SQLite connection, so
      // no new work can target the Chat after its projection disappears.
      beforeProjectionDelete?.(id);
      this.setHistoryConversationVisibility(row.projectId, id, false);
      tx.delete(conversations).where(eq(conversations.id, id)).run();
      tx.update(conversationDeletionReceipts).set({
        canonicalDeletionCompleted: 1,
        lastError: null,
        updatedAt: now,
      }).where(eq(conversationDeletionReceipts.conversationId, id)).run();
    });
    return this.getConversationDeletionReceipt(id)!;
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

}
