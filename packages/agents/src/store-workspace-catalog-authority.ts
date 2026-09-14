import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
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
import { pathEntryExists, validateDeletionTombstone } from "./deletion-tombstone-ownership.js";
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
  projectDeletionPending,
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

export class ProjectDeletionInProgressError extends Error {
  readonly code = "PROJECT_DELETION_IN_PROGRESS";

  constructor() {
    super("Project deletion is in progress");
    this.name = "ProjectDeletionInProgressError";
  }
}

const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONVERSATION_DELETION_IDENTITY_FILE = ".ponderosa-conversation-deletion.json";

interface ConversationDeletionIdentity {
  version: 1;
  kind: "conversation-deletion";
  projectId: string;
  conversationId: string;
  tombstoneName: string;
  ownershipToken: string;
}

function creationId(kind: "project" | "conversation", scope: string, key: string): string {
  const hash = createHash("sha256").update(`${kind}\0${scope}\0${key}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${
    ((Number.parseInt(hash[16]!, 16) & 3) | 8).toString(16)
  }${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function assertCreationIdentity(
  record: { creationIdempotencyKey?: string; creationPayloadHash?: string },
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

  private assertProjectMetadataMutable(projectId: string): void {
    if (this.db.select({ projectId: projectDeletionPending.projectId })
      .from(projectDeletionPending)
      .where(eq(projectDeletionPending.projectId, projectId)).get()) {
      throw new ProjectDeletionInProgressError();
    }
  }

  /** Commit canonical metadata while holding the same SQLite write boundary
   * that fences Project deletion. SQLite is only a rebuildable projection: a
   * failure after the durable write must not turn a committed mutation into a
   * rejected one. Startup reconciliation repairs any projection left behind. */
  private commitProjectMetadataMutation<T>(
    projectId: string,
    writeCanonical: () => T,
    writeProjection: () => void,
  ): T {
    let canonicalCommitted = false;
    let result: T | undefined;
    try {
      this.db.transaction(() => {
        this.assertProjectMetadataMutable(projectId);
        result = writeCanonical();
        canonicalCommitted = true;
        writeProjection();
      });
    } catch (error) {
      if (!canonicalCommitted) throw error;
      try { writeProjection(); } catch { /* canonical metadata remains authoritative */ }
    }
    return result!;
  }

  recoverCreationDirectories(): void {
    const projectsRoot = projectsDir(this.dataDir);
    if (!existsSync(projectsRoot)) return;
    this.recoverConversationDeletionDirectories();
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

  private conversationDeletionIdentity(
    receipt: ConversationDeletionReceipt,
  ): ConversationDeletionIdentity {
    const prefix = `.${receipt.conversationId}.deleting-`;
    if (!receipt.tombstoneName || !receipt.ownershipToken ||
        receipt.tombstoneName.includes("/") || receipt.tombstoneName.includes("\\") ||
        !receipt.tombstoneName.startsWith(prefix)) {
      throw new Error("invalid Chat deletion receipt");
    }
    return {
      version: 1,
      kind: "conversation-deletion",
      projectId: receipt.projectId,
      conversationId: receipt.conversationId,
      tombstoneName: receipt.tombstoneName,
      ownershipToken: receipt.ownershipToken,
    };
  }

  private ensureConversationDeletionIdentity(
    receipt: ConversationDeletionReceipt,
  ): ConversationDeletionReceipt {
    if (Boolean(receipt.tombstoneName) !== Boolean(receipt.ownershipToken)) {
      throw new Error("Chat deletion receipt has incomplete storage identity");
    }
    if (receipt.tombstoneName && receipt.ownershipToken) {
      this.conversationDeletionIdentity(receipt);
      return receipt;
    }
    const ownershipToken = randomUUID();
    const tombstoneName = `.${receipt.conversationId}.deleting-legacy-${ownershipToken}`;
    this.db.update(conversationDeletionReceipts).set({ tombstoneName, ownershipToken })
      .where(eq(conversationDeletionReceipts.conversationId, receipt.conversationId)).run();
    const upgraded = this.getConversationDeletionReceipt(receipt.conversationId);
    if (!upgraded) throw new Error("Chat deletion receipt not found");
    this.conversationDeletionIdentity(upgraded);
    return upgraded;
  }

  private stageConversationDeletionStorage(
    receipt: ConversationDeletionReceipt,
  ): ConversationDeletionReceipt {
    const current = this.ensureConversationDeletionIdentity(receipt);
    const identity = this.conversationDeletionIdentity(current);
    const parent = conversationsDir(this.dataDir, current.projectId);
    const canonical = conversationDir(this.dataDir, current.projectId, current.conversationId);
    const tombstone = join(parent, identity.tombstoneName);
    const hasCanonical = pathEntryExists(canonical);
    const hasTombstone = pathEntryExists(tombstone);
    if (hasCanonical && hasTombstone) throw new Error("Chat deletion storage is ambiguous");
    if (hasTombstone) {
      validateDeletionTombstone(
        tombstone,
        CONVERSATION_DELETION_IDENTITY_FILE,
        identity,
        "Chat deletion tombstone",
      );
      return current;
    }
    if (!hasCanonical) throw new Error("Chat deletion has no recoverable canonical storage");
    const stat = lstatSync(canonical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Chat deletion canonical storage is not the owned directory");
    }
    const record = readJson<ConversationJson>(
      conversationJsonPath(this.dataDir, current.projectId, current.conversationId),
    );
    if (record.id !== current.conversationId || record.projectId !== current.projectId) {
      throw new Error("Chat deletion canonical storage identity does not match");
    }
    const marker = join(canonical, CONVERSATION_DELETION_IDENTITY_FILE);
    if (!pathEntryExists(marker)) writeJson(marker, identity);
    validateDeletionTombstone(
      canonical,
      CONVERSATION_DELETION_IDENTITY_FILE,
      identity,
      "Chat deletion canonical storage",
      { dev: stat.dev, ino: stat.ino },
    );
    renameSync(canonical, tombstone);
    fsyncDirectory(parent);
    return current;
  }

  private recoverConversationDeletionDirectories(): void {
    for (const receipt of this.listPendingConversationDeletionReceipts()) {
      if (receipt.canonicalDeletionCompleted || !receipt.tombstoneName || !receipt.ownershipToken) {
        continue;
      }
      const identity = this.conversationDeletionIdentity(receipt);
      const parent = conversationsDir(this.dataDir, receipt.projectId);
      const canonical = conversationDir(this.dataDir, receipt.projectId, receipt.conversationId);
      const tombstone = join(parent, identity.tombstoneName);
      const hasCanonical = pathEntryExists(canonical);
      const hasTombstone = pathEntryExists(tombstone);
      if (hasCanonical && hasTombstone) throw new Error("pending Chat deletion storage is ambiguous");
      if (!hasTombstone) continue;
      validateDeletionTombstone(
        tombstone,
        CONVERSATION_DELETION_IDENTITY_FILE,
        identity,
        "pending Chat deletion tombstone",
      );
      renameSync(tombstone, canonical);
      fsyncDirectory(parent);
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
    let publishedIdentity: { dev: number | bigint; ino: number | bigint } | undefined;
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
      const staged = lstatSync(stagingRoot);
      if (!staged.isDirectory() || staged.isSymbolicLink()) {
        throw new Error("Project creation staging is not an owned directory");
      }
      if (pathEntryExists(projectDir(this.dataDir, id))) {
        throw new Error("Project creation canonical path already exists");
      }
      // ponytail: Node has no portable directory rename-no-replace; retain the
      // canonical preflight until the native host exposes that primitive.
      renameSync(stagingRoot, projectDir(this.dataDir, id));
      publishedIdentity = { dev: staged.dev, ino: staged.ino };
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
      if (publishedIdentity) {
        validateDeletionTombstone(
          projectDir(this.dataDir, id),
          "project.json",
          { id, createdAt: now },
          "Project creation rollback",
          publishedIdentity,
        );
        rmSync(projectDir(this.dataDir, id), { recursive: true, force: true });
      }
      fsyncDirectory(projectsDir(this.dataDir));
      throw error;
    }
    return { id, label: input.label, hostPath: input.hostPath, createdAt: now, lastUsedAt: now, defaultEngine, ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}), ...(input.defaultEffort ? { defaultEffort: input.defaultEffort } : {}), lastConversationId: conversationId };
  }

  updateProject(id: string, input: UpdateProjectRequest): ProjectDto | undefined {
    if (!this.getProject(id)) return undefined;
    this.assertProjectMetadataMutable(id);
    const canonicalCurrent = readJson<ProjectJson>(projectJsonPath(this.dataDir, id));
    const current: ProjectDto = {
      ...canonicalCurrent,
      defaultEngine: canonicalCurrent.defaultEngine as ProjectDto["defaultEngine"],
    };
    const label = (input.label ?? current.label).trim();
    if (!label) throw new Error("project label is required");
    const instructions = (input.instructions ?? current.instructions ?? "").slice(0, 100_000);
    const defaultEngine = input.defaultEngine ?? current.defaultEngine;
    const defaultModel = input.defaultModel === null ? undefined : input.defaultModel ?? current.defaultModel;
    const defaultEffort = input.defaultEffort === null ? undefined : input.defaultEffort ?? current.defaultEffort;
    const { instructions: _previousInstructions, ...projectWithoutInstructions } = current;
    const next = { ...projectWithoutInstructions, label, defaultEngine, ...(defaultModel ? { defaultModel } : {}), ...(defaultEffort ? { defaultEffort } : {}), ...(instructions ? { instructions } : {}) };
    const changed = label !== current.label || defaultEngine !== current.defaultEngine ||
      defaultModel !== current.defaultModel || defaultEffort !== current.defaultEffort ||
      instructions !== (current.instructions ?? "");
    return this.commitProjectMetadataMutation(id, () => {
      if (changed) {
        const canonical = readJson<ProjectJson>(projectJsonPath(this.dataDir, id));
        writeJson(projectJsonPath(this.dataDir, id), {
          ...canonical,
          ...projectWithoutInstructions,
          label,
          defaultEngine,
          ...(defaultModel ? { defaultModel } : { defaultModel: undefined }),
          ...(defaultEffort ? { defaultEffort } : { defaultEffort: undefined }),
          ...(instructions ? { instructions } : { instructions: undefined }),
        });
      }
      return next;
    }, () => {
      this.db.update(projects).set({ label, defaultEngine, defaultModel: defaultModel ?? null, defaultEffort: defaultEffort ?? null }).where(eq(projects.id, id)).run();
    });
  }

  listAgentPresets(projectId: string): AgentPresetDto[] {
    return this.db.select().from(agentPresets).where(eq(agentPresets.projectId, projectId)).orderBy(asc(agentPresets.name)).all().map((r) => ({ ...r, model: r.model ?? undefined, effort: r.effort ?? undefined, enabled: r.enabled === 1, engine: r.engine as AgentPresetDto["engine"] }));
  }
  getAgentPreset(id: string): AgentPresetDto | undefined {
    const r = this.db.select().from(agentPresets).where(eq(agentPresets.id, id)).get();
    return r ? { ...r, model: r.model ?? undefined, effort: r.effort ?? undefined, enabled: r.enabled === 1, engine: r.engine as AgentPresetDto["engine"] } : undefined;
  }
  private canonicalAgentPreset(
    id: string,
    projectId?: string,
  ): { projectId: string; preset?: AgentPresetDto } | undefined {
    const projectIds = projectId
      ? [projectId]
      : readdirSync(projectsDir(this.dataDir)).filter((entry) => !entry.startsWith("."));
    for (const candidateProjectId of projectIds) {
      const events = readRepairableJsonl<PresetEvent>(
        agentPresetsPath(this.dataDir, candidateProjectId), "agent preset journal", true,
      );
      let found: AgentPresetDto | undefined;
      let seen = false;
      for (const event of events) {
        if (event.type === "upsert" && event.preset.id === id) {
          found = event.preset;
          seen = true;
        } else if (event.type === "delete" && event.id === id) {
          found = undefined;
          seen = true;
        }
      }
      if (seen) return { projectId: candidateProjectId, ...(found ? { preset: found } : {}) };
    }
    return undefined;
  }
  getAgentPresetCreation(
    projectId: string,
    identity: WorkspaceCreationIdentity,
  ): AgentPresetDto | undefined {
    this.assertProjectMetadataMutable(projectId);
    const id = creationId("project", `${projectId}:preset-create`, identity.idempotencyKey);
    const events = readRepairableJsonl<PresetEvent>(
      agentPresetsPath(this.dataDir, projectId), "agent preset journal", true,
    );
    const creation = events.find((event) => event.type === "upsert" && event.preset.id === id &&
      event.creationIdempotencyKey !== undefined);
    if (!creation || creation.type !== "upsert") return undefined;
    assertCreationIdentity(creation, identity);
    const current = new Map<string, AgentPresetDto>();
    for (const event of events) event.type === "upsert"
      ? current.set(event.preset.id, event.preset)
      : current.delete(event.id);
    const preset = current.get(id);
    if (!preset) throw new Error("This Agent preset creation was already deleted");
    return this.commitProjectMetadataMutation(projectId, () => preset, () => {
      this.db.insert(agentPresets).values({ ...preset, enabled: preset.enabled ? 1 : 0 })
        .onConflictDoUpdate({ target: agentPresets.id, set: { ...preset, enabled: preset.enabled ? 1 : 0 } }).run();
    });
  }
  createAgentPreset(
    projectId: string,
    input: CreateAgentPresetRequest,
    identity?: WorkspaceCreationIdentity,
  ): AgentPresetDto {
    if (!this.getProject(projectId)) throw new Error("unknown project");
    const replay = identity ? this.getAgentPresetCreation(projectId, identity) : undefined;
    if (replay) return replay;
    const now = new Date().toISOString();
    const preset: AgentPresetDto = {
      id: identity
        ? creationId("project", `${projectId}:preset-create`, identity.idempotencyKey)
        : randomUUID(),
      projectId, ...input, enabled: input.enabled ?? true, createdAt: now, updatedAt: now,
    };
    return this.commitProjectMetadataMutation(projectId, () => {
      appendFsyncedJsonl(agentPresetsPath(this.dataDir, projectId), [{
        type: "upsert", preset,
        ...(identity ? {
          creationIdempotencyKey: identity.idempotencyKey,
          creationPayloadHash: identity.payloadHash,
        } : {}),
      } satisfies PresetEvent]);
      return preset;
    }, () => {
      this.db.insert(agentPresets).values({ ...preset, enabled: preset.enabled ? 1 : 0 })
        .onConflictDoUpdate({ target: agentPresets.id, set: { ...preset, enabled: preset.enabled ? 1 : 0 } }).run();
    });
  }
  updateAgentPreset(id: string, patch: UpdateAgentPresetRequest): AgentPresetDto | undefined {
    const projected = this.getAgentPreset(id);
    if (projected) this.assertProjectMetadataMutable(projected.projectId);
    const canonical = this.canonicalAgentPreset(id, projected?.projectId);
    const current = canonical?.preset;
    if (!current) return undefined;
    const candidate = { ...current, ...patch, model: patch.model === null ? undefined : patch.model ?? current.model, effort: patch.effort === null ? undefined : patch.effort ?? current.effort } as AgentPresetDto;
    const changed = candidate.name !== current.name || candidate.description !== current.description ||
      candidate.guidance !== current.guidance || candidate.engine !== current.engine ||
      candidate.model !== current.model || candidate.effort !== current.effort ||
      candidate.enabled !== current.enabled;
    const next = { ...candidate, updatedAt: changed ? new Date().toISOString() : current.updatedAt };
    return this.commitProjectMetadataMutation(canonical.projectId, () => {
      if (changed) appendFsyncedJsonl(agentPresetsPath(this.dataDir, canonical.projectId), [{ type: "upsert", preset: next } satisfies PresetEvent]);
      return next;
    }, () => {
      this.db.update(agentPresets).set({ ...next, model: next.model ?? null, effort: next.effort ?? null, enabled: next.enabled ? 1 : 0 }).where(eq(agentPresets.id, id)).run();
    });
  }
  deleteAgentPreset(id: string): boolean {
    const projected = this.getAgentPreset(id);
    if (projected) this.assertProjectMetadataMutable(projected.projectId);
    const canonical = this.canonicalAgentPreset(id, projected?.projectId);
    if (!canonical) return false;
    return this.commitProjectMetadataMutation(canonical.projectId, () => {
      if (canonical.preset) appendFsyncedJsonl(agentPresetsPath(this.dataDir, canonical.projectId), [{ type: "delete", id, at: new Date().toISOString() } satisfies PresetEvent]);
      return true;
    }, () => {
      this.db.delete(agentPresets).where(eq(agentPresets.id, id)).run();
    });
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
    this.assertProjectMetadataMutable(projectId);
    if (conversationId) {
      const conversation = this.getConversation(conversationId);
      if (!conversation || conversation.projectId !== projectId || conversation.archived) throw new Error("conversation is unavailable");
    }
    const lastUsedAt = new Date().toISOString();
    return this.commitProjectMetadataMutation(projectId, () => {
      const canonical = readJson<ProjectJson>(projectJsonPath(this.dataDir, projectId));
      const next: ProjectDto = {
        ...canonical,
        defaultEngine: canonical.defaultEngine as ProjectDto["defaultEngine"],
        lastUsedAt,
        lastConversationId: conversationId ?? canonical.lastConversationId,
      };
      writeJson(projectJsonPath(this.dataDir, projectId), { ...canonical, ...next });
      return next;
    }, () => {
      this.db.update(projects).set({ lastUsedAt, ...(conversationId ? { lastConversationId: conversationId } : {}) }).where(eq(projects.id, projectId)).run();
    });
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
    let publishedIdentity: { dev: number | bigint; ino: number | bigint } | undefined;
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
      const staged = lstatSync(stagingRoot);
      if (!staged.isDirectory() || staged.isSymbolicLink()) {
        throw new Error("Chat creation staging is not an owned directory");
      }
      if (pathEntryExists(canonicalRoot)) {
        throw new Error("Chat creation canonical path already exists");
      }
      // ponytail: Node has no portable directory rename-no-replace; retain the
      // canonical preflight until the native host exposes that primitive.
      renameSync(stagingRoot, canonicalRoot);
      publishedIdentity = { dev: staged.dev, ino: staged.ino };
      fsyncDirectory(conversationsDir(this.dataDir, projectId));
      writeJson(projectJsonPath(this.dataDir, projectId), {
        ...previousProjectRecord,
        lastUsedAt: now,
        lastConversationId: id,
      });
      this.db.transaction((tx) => {
        if (tx.select({ projectId: projectDeletionPending.projectId })
          .from(projectDeletionPending)
          .where(eq(projectDeletionPending.projectId, projectId)).get()) {
          throw new ProjectDeletionInProgressError();
        }
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
        if (publishedIdentity) {
          validateDeletionTombstone(
            canonicalRoot,
            "conversation.json",
            { id, projectId, createdAt: now },
            "Chat creation rollback",
            publishedIdentity,
          );
          rmSync(canonicalRoot, { recursive: true, force: true });
        }
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
    this.assertProjectMetadataMutable(row.projectId);
    const canonical = readJson<ConversationJson>(
      conversationJsonPath(this.dataDir, row.projectId, id),
    );
    const next = {
      title: patch.title ?? canonical.title,
      defaultEngine: patch.defaultEngine === undefined ? canonical.defaultEngine : patch.defaultEngine,
      defaultModel: patch.defaultModel === undefined ? canonical.defaultModel : patch.defaultModel,
      defaultEffort: patch.defaultEffort === undefined ? canonical.defaultEffort : patch.defaultEffort,
      archived: patch.archived ?? canonical.archived,
    };
    const changed = next.title !== canonical.title || next.defaultEngine !== canonical.defaultEngine ||
      next.defaultModel !== canonical.defaultModel || next.defaultEffort !== canonical.defaultEffort ||
      next.archived !== canonical.archived;
    const updatedAt = changed ? new Date().toISOString() : canonical.updatedAt;
    const result: ConversationDto = {
      id: row.id,
      projectId: row.projectId,
      title: next.title,
      defaultEngine: next.defaultEngine ?? undefined,
      defaultModel: next.defaultModel ?? undefined,
      defaultEffort: next.defaultEffort ?? undefined,
      createdAt: canonical.createdAt,
      updatedAt,
      archived: next.archived,
    };
    const updated = this.commitProjectMetadataMutation(row.projectId, () => {
      if (changed) {
        const json = readJson<ConversationJson>(
          conversationJsonPath(this.dataDir, row.projectId, id),
        );
        writeJson(conversationJsonPath(this.dataDir, row.projectId, id), {
          ...json,
          ...next,
          defaultEngine: next.defaultEngine ?? undefined,
          defaultModel: next.defaultModel ?? undefined,
          defaultEffort: next.defaultEffort ?? undefined,
          updatedAt,
        });
      }
      return result;
    }, () => {
      this.db.update(conversations)
        .set({
          title: next.title,
          defaultEngine: next.defaultEngine,
          defaultModel: next.defaultModel,
          defaultEffort: next.defaultEffort,
          archived: next.archived ? 1 : 0,
          updatedAt,
        })
        .where(eq(conversations.id, id))
        .run();
      if (next.archived !== canonical.archived) {
        this.setHistoryConversationVisibility(row.projectId, id, !next.archived);
      }
    });
    if (next.archived !== canonical.archived) {
      try { this.refreshAllChatFeedProject(row.projectId); }
      catch { /* canonical visibility is repaired by projection rebuild */ }
    }
    return updated;
  }

  getConversationDeletionReceipt(id: string): ConversationDeletionReceipt | undefined {
    const row = this.db.select().from(conversationDeletionReceipts)
      .where(eq(conversationDeletionReceipts.conversationId, id)).get();
    return row ? {
      conversationId: row.conversationId,
      projectId: row.projectId,
      ...(row.tombstoneName ? { tombstoneName: row.tombstoneName } : {}),
      ...(row.ownershipToken ? { ownershipToken: row.ownershipToken } : {}),
      removalStarted: row.removalStarted === 1,
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
        ...(row.tombstoneName ? { tombstoneName: row.tombstoneName } : {}),
        ...(row.ownershipToken ? { ownershipToken: row.ownershipToken } : {}),
        removalStarted: row.removalStarted === 1,
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
    const ownershipToken = randomUUID();
    this.db.insert(conversationDeletionReceipts).values({
      conversationId: id,
      projectId: row.projectId,
      tombstoneName: `.${id}.deleting-${ownershipToken}`,
      ownershipToken,
      removalStarted: 0,
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
    afterTombstoneRemoval?: (conversationId: string) => void,
  ): void {
    const current = this.getConversationDeletionReceipt(receipt.conversationId);
    if (!current) throw new Error("Chat deletion receipt not found");
    if (!current.canonicalDeletionCompleted) {
      throw new Error("Chat canonical deletion must finish before storage cleanup");
    }
    if (current.storageCleanupCompleted) return;
    const legacyReceipt = !current.tombstoneName && !current.ownershipToken;
    const legacyRecovery = legacyReceipt || current.tombstoneName
      ?.startsWith(`.${current.conversationId}.deleting-legacy-`) === true;
    const canonical = conversationDir(this.dataDir, current.projectId, current.conversationId);
    if (legacyReceipt && !pathEntryExists(canonical)) {
      const now = new Date().toISOString();
      this.db.delete(conversations).where(and(
        eq(conversations.id, current.conversationId),
        eq(conversations.projectId, current.projectId),
      )).run();
      this.db.update(conversationDeletionReceipts).set({
        removalStarted: 1,
        storageCleanupCompleted: 1,
        lastError: null,
        updatedAt: now,
      }).where(eq(conversationDeletionReceipts.conversationId, current.conversationId)).run();
      return;
    }
    if (!legacyRecovery && pathEntryExists(canonical)) {
      throw new Error("committed Chat deletion storage was resurrected");
    }
    const currentTombstone = current.tombstoneName
      ? join(conversationsDir(this.dataDir, current.projectId), current.tombstoneName)
      : undefined;
    const removalAlreadyCompleted = current.removalStarted &&
      !pathEntryExists(canonical) &&
      (!currentTombstone || !pathEntryExists(currentTombstone));
    const staged = removalAlreadyCompleted
      ? current
      : this.stageConversationDeletionStorage(current);
    const identity = this.conversationDeletionIdentity(staged);
    const tombstone = join(
      conversationsDir(this.dataDir, staged.projectId),
      identity.tombstoneName,
    );
    if (!staged.removalStarted) {
      if (!pathEntryExists(tombstone)) {
        throw new Error("Chat deletion tombstone is missing before durable removal authority");
      }
      validateDeletionTombstone(
        tombstone,
        CONVERSATION_DELETION_IDENTITY_FILE,
        identity,
        "Chat deletion tombstone",
      );
      this.db.update(conversationDeletionReceipts).set({
        removalStarted: 1,
        updatedAt: new Date().toISOString(),
      }).where(eq(conversationDeletionReceipts.conversationId, staged.conversationId)).run();
    }
    if (pathEntryExists(tombstone)) {
      validateDeletionTombstone(
        tombstone,
        CONVERSATION_DELETION_IDENTITY_FILE,
        identity,
        "Chat deletion tombstone",
      );
      rmSync(tombstone, { recursive: true, force: true });
      afterTombstoneRemoval?.(staged.conversationId);
    }
    const parent = conversationsDir(this.dataDir, staged.projectId);
    if (existsSync(parent)) fsyncDirectory(parent);
    // A restart on the canonical-commit/storage-cleanup boundary must not let a
    // projection rebuilt from the leftover folder survive completed cleanup.
    this.db.delete(conversations).where(and(
      eq(conversations.id, current.conversationId),
      eq(conversations.projectId, current.projectId),
    )).run();
    this.db.update(conversationDeletionReceipts).set({
      removalStarted: 1,
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
    const staged = this.stageConversationDeletionStorage(intent);
    const identity = this.conversationDeletionIdentity(staged);
    const parent = conversationsDir(this.dataDir, row.projectId);
    const tombstone = join(parent, identity.tombstoneName);
    const canonical = conversationDir(this.dataDir, row.projectId, id);
    const now = new Date().toISOString();
    try {
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
    } catch (error) {
      if (pathEntryExists(canonical)) {
        throw new Error("Chat deletion rollback found ambiguous canonical storage", { cause: error });
      }
      if (!pathEntryExists(tombstone)) {
        throw new Error("Chat deletion rollback lost its owned tombstone", { cause: error });
      }
      validateDeletionTombstone(
        tombstone,
        CONVERSATION_DELETION_IDENTITY_FILE,
        identity,
        "Chat deletion tombstone",
      );
      renameSync(tombstone, canonical);
      fsyncDirectory(parent);
      throw error;
    }
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
