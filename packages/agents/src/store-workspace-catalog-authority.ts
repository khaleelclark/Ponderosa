import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
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
import { appendFsyncedJsonl } from "./append-jsonl.js";
import { readJson, writeJson } from "./store-filesystem.js";
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
  projects,
} from "./schema.js";
import {
  agentPresetsPath,
  agentsDir,
  conversationDir,
  conversationJsonPath,
  projectDir,
  projectJsonPath,
} from "./paths.js";

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
      .filter(row => row.storageCleanupCompleted !== 1 || row.serverCleanupCompleted !== 1)
      .map(row => ({
        conversationId: row.conversationId,
        projectId: row.projectId,
        storageCleanupCompleted: row.storageCleanupCompleted === 1,
        serverCleanupCompleted: row.serverCleanupCompleted === 1,
        ...(row.lastError ? { lastError: row.lastError } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.completedAt ? { completedAt: row.completedAt } : {}),
      }));
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
    if (prior) return prior;
    const row = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!row) return undefined;
    const linkedAgents = this.listAgents(row.projectId).filter((agent) => agent.conversationId === id);
    if (linkedAgents.length > 0) throw new Error("delete the Chat's Agents before deleting the Chat");
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      // Communication and Automation cleanup share this SQLite connection, so
      // no new work can target the Chat after its projection disappears.
      beforeProjectionDelete?.(id);
      this.setHistoryConversationVisibility(row.projectId, id, false);
      tx.delete(conversations).where(eq(conversations.id, id)).run();
      tx.insert(conversationDeletionReceipts).values({
        conversationId: id,
        projectId: row.projectId,
        storageCleanupCompleted: 0,
        serverCleanupCompleted: 0,
        createdAt: now,
        updatedAt: now,
      }).run();
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
