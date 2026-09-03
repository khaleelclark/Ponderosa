import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import type Database from "better-sqlite3";
import { and, eq, isNull } from "drizzle-orm";
import type {
  AgentDto,
  AgentOrganizationEvent,
  AgentPresetDto,
  AgentState,
  CreateAgentRequest,
  MessageDto,
  PortableAgentHistoryMessageDto,
  ProjectDto,
} from "@ponderosa/core";
import { allocateAgentMentionHandle } from "@ponderosa/core";
import type { Db } from "./db.js";
import { normalizeAgentTitle } from "./agent-identity.js";
import { sharedWorkingCopy } from "./working-copy.js";
import { requireManagementPermissions } from "./store-agent-management.js";
import { appendFsyncedJsonl } from "./append-jsonl.js";
import { fsyncDirectory, readJson, writeJson } from "./store-filesystem.js";
import type {
  AgentJson,
  AgentSpawnOrigin,
  ContextReadBoundary,
  ContextSourcePage,
} from "./store-types.js";
import { agentConversationMemberships, agentHandleReservations, agents, conversations, importedHistoryMessages } from "./schema.js";
import {
  agentDir,
  agentsDir,
  agentJsonPath,
  agentOrganizationEventsPath,
  artifactsDir,
  attachmentsDir,
  importedAgentHistoryPath,
} from "./paths.js";

const MAX_AGENT_TITLE_PROJECTION_IDS = 500;

export class AgentCatalogAuthority {
  constructor(
    private readonly dataDir: string,
    private readonly db: Db,
    private readonly client: Database.Database,
    private readonly getAgentPreset: (presetId: string) => AgentPresetDto | undefined,
    private readonly getProject: (projectId: string) => ProjectDto | undefined,
  ) {}

  createAgent(
    projectId: string,
    input: CreateAgentRequest,
    origin?: AgentSpawnOrigin,
    predeterminedId: string = randomUUID(),
  ): AgentDto {
    const creationIdempotencyKey = input.idempotencyKey?.trim() || undefined;
    if (creationIdempotencyKey) {
      const existing = this.findAgentCreation(projectId, creationIdempotencyKey);
      if (existing) return existing;
    }
    const id = predeterminedId;
    const stagingId = `.${id}.creating`;
    const now = new Date().toISOString();
    const title = normalizeAgentTitle(input.title);
    const handle = allocateAgentMentionHandle(
      title,
      this.db.select({ handle: agentHandleReservations.handle })
        .from(agentHandleReservations)
        .where(eq(agentHandleReservations.projectId, projectId))
        .all()
        .map(row => row.handle),
    );
    const preset = input.presetId ? this.getAgentPreset(input.presetId) : undefined;
    if (input.presetId && (!preset || preset.projectId !== projectId || !preset.enabled)) throw new Error("invalid preset");
    const presetSnapshot = preset ? { id: preset.id, name: preset.name, description: preset.description, guidance: preset.guidance, engine: preset.engine, model: preset.model, effort: preset.effort } : undefined;
    const model = preset?.model ?? input.model;
    const effort = preset?.effort ?? input.effort;
    const project = this.getProject(projectId);
    if (!project) throw new Error("unknown project");
    if (!input.conversationId) throw new Error("a Chat is required when creating an Agent");
    const workingCopy = sharedWorkingCopy(project, now);
    const managementPermissions = input.managementPermissions
      ? requireManagementPermissions(input.managementPermissions)
      : { allowAutomaticDescendantDeletion: false, allowAutomaticDescendantReorganization: false };
    const record: AgentJson = {
      id,
      projectId,
      conversationId: input.conversationId,
      title,
      handle,
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
      creationIdempotencyKey,
      workingCopy,
    };
    try {
    this.client.transaction(() => {
      const ownerConversation = this.db.select({ id: conversations.id })
        .from(conversations)
        .where(and(
          eq(conversations.id, input.conversationId),
          eq(conversations.projectId, projectId),
          eq(conversations.archived, 0),
        ))
        .get();
      if (!ownerConversation) {
        throw new Error("Agent owner Chat must be active in this Project");
      }
      const manager = input.managerAgentId
        ? this.db.select({
            id: agents.id,
            projectId: agents.projectId,
            conversationId: agents.conversationId,
            archived: agents.archived,
            deletedAt: agents.deletedAt,
          })
          .from(agents)
          .where(eq(agents.id, input.managerAgentId))
          .get()
        : undefined;
      if (input.managerAgentId && (
        !manager || manager.projectId !== projectId ||
        manager.conversationId !== input.conversationId ||
        manager.archived === 1 || manager.deletedAt
      )) {
        throw new Error("Agent manager must be active in the same Project Chat");
      }
      mkdirSync(agentDir(this.dataDir, projectId, stagingId), { recursive: true });
      mkdirSync(artifactsDir(this.dataDir, projectId, stagingId), { recursive: true });
      mkdirSync(attachmentsDir(this.dataDir, projectId, stagingId), { recursive: true });
      writeJson(agentJsonPath(this.dataDir, projectId, stagingId), record);
      if (manager) {
        const organizationEvent: AgentOrganizationEvent = {
          eventId: randomUUID(),
          type: "manager_changed",
          projectId,
          agentId: id,
          managerAgentId: manager.id,
          createdAt: now,
        };
        appendFsyncedJsonl(
          agentOrganizationEventsPath(this.dataDir, projectId),
          [organizationEvent],
        );
      }
      this.db.insert(agentHandleReservations).values({
        projectId,
        normalizedHandle: handle.toLocaleLowerCase(),
        handle,
        agentId: id,
        reservedAt: now,
      }).run();
      this.db.insert(agents).values({
        id,
        projectId,
        conversationId: input.conversationId,
        title,
        handle,
        activeEngine: input.engine,
        model: model ?? null,
        effort: effort ?? null,
        createdAt: now,
        updatedAt: now,
        archived: 0,
        managerAgentId: manager?.id ?? null,
        allowAutomaticDescendantDeletion: managementPermissions.allowAutomaticDescendantDeletion ? 1 : 0,
        allowAutomaticDescendantReorganization: managementPermissions.allowAutomaticDescendantReorganization ? 1 : 0,
        spawnedByAgentId: origin?.agentId ?? null,
        spawnedByExecutionId: origin?.executionId ?? null,
        spawnPrompt: origin?.prompt ?? null,
        spawnIdempotencyKey: origin?.idempotencyKey ?? null,
        presetSnapshotJson: presetSnapshot ? JSON.stringify(presetSnapshot) : null,
        creationIdempotencyKey: creationIdempotencyKey ?? null,
        workingCopyJson: JSON.stringify(workingCopy),
      })
      .run();
      this.db.insert(agentConversationMemberships).values({
        agentId: id,
        conversationId: input.conversationId,
        position: 0,
      }).run();
    })();
    } catch (error) {
      rmSync(agentDir(this.dataDir, projectId, stagingId), { recursive: true, force: true });
      throw error;
    }
    let published = false;
    try {
      renameSync(
        agentDir(this.dataDir, projectId, stagingId),
        agentDir(this.dataDir, projectId, id),
      );
      published = true;
      fsyncDirectory(agentsDir(this.dataDir, projectId));
    } catch (error) {
      if (!published) {
        this.client.transaction(() => {
          this.db.delete(agentConversationMemberships).where(eq(agentConversationMemberships.agentId, id)).run();
          this.db.delete(agents).where(eq(agents.id, id)).run();
          this.db.delete(agentHandleReservations).where(eq(agentHandleReservations.agentId, id)).run();
        })();
        rmSync(agentDir(this.dataDir, projectId, stagingId), { recursive: true, force: true });
      }
      throw error;
    }
    return this.rowToAgentDto(id)!;
  }

  /** Resolve the filesystem side of Agent creation before projection rebuild.
   * A row means the SQLite transaction committed and its hidden directory must
   * be published; without a row, the staging directory is safe to discard. */
  recoverCreationDirectories(): void {
    for (const project of this.getProjectRows()) {
      const directory = agentsDir(this.dataDir, project.id);
      if (!existsSync(directory)) continue;
      let changed = false;
      for (const name of readdirSync(directory)) {
        const match = /^\.(.+)\.creating$/u.exec(name);
        if (!match) continue;
        const id = match[1]!;
        const staging = agentDir(this.dataDir, project.id, name);
        const canonical = agentDir(this.dataDir, project.id, id);
        const row = this.client.prepare(
          "SELECT 1 FROM agents WHERE id = ? AND project_id = ? AND deleted_at IS NULL",
        ).get(id, project.id);
        if (row && !existsSync(canonical)) renameSync(staging, canonical);
        else rmSync(staging, { recursive: true, force: true });
        changed = true;
      }
      if (changed) fsyncDirectory(directory);
    }
  }

  private getProjectRows(): Array<{ id: string }> {
    return this.client.prepare("SELECT id FROM projects ORDER BY id").all() as Array<{ id: string }>;
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

  findAgentCreation(projectId: string, idempotencyKey: string): AgentDto | undefined {
    const row = this.db.select().from(agents).where(and(
      eq(agents.projectId, projectId),
      eq(agents.creationIdempotencyKey, idempotencyKey),
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

  /** Scheduler admission needs only durable identity and engine assignment.
   * Keep that hot read independent of Agent DTO hydration, which also reads
   * memberships and optional imported-history files for presentation. */
  listAgentEngineAssignments(): Array<{ id: string; activeEngine: string }> {
    return this.client.prepare(`
      SELECT agents.id, agents.active_engine
      FROM agents
      WHERE agents.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM agent_creation_operation_members AS members
          JOIN agent_creation_operations AS operations ON operations.id = members.operation_id
          WHERE members.agent_id = agents.id
            AND operations.status IN ('preparing', 'canonical_committed', 'rolling_back')
        )
      ORDER BY agents.id
    `).all().map((row) => {
      const assignment = row as { id: string; active_engine: string };
      return { id: assignment.id, activeEngine: assignment.active_engine };
    });
  }

  /** Notification and directory summaries need current labels without
   * hydrating Agent memberships, state, or filesystem-backed history. */
  getAgentTitleProjection(agentIds: readonly string[]): ReadonlyMap<string, string> {
    const distinctAgentIds = [...new Set(agentIds)]
      .filter(Boolean)
      .slice(0, MAX_AGENT_TITLE_PROJECTION_IDS);
    if (distinctAgentIds.length === 0) return new Map();
    const placeholders = distinctAgentIds.map(() => "?").join(", ");
    const rows = this.client.prepare(`
      SELECT id, title
      FROM agents
      WHERE deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM agent_creation_operation_members AS members
          JOIN agent_creation_operations AS operations ON operations.id = members.operation_id
          WHERE members.agent_id = agents.id
            AND operations.status IN ('preparing', 'canonical_committed', 'rolling_back')
        )
        AND id IN (${placeholders})
    `).all(...distinctAgentIds) as Array<{ id: string; title: string }>;
    return new Map(rows.map((row) => [row.id, row.title] as const));
  }

  getAgent(id: string): AgentDto | undefined {
    const row = this.db.select().from(agents).where(and(eq(agents.id, id), isNull(agents.deletedAt))).get();
    return row ? this.agentRowToDto(row) : undefined;
  }

  getAgentProjectId(id: string): string | undefined {
    return (this.client.prepare("SELECT project_id FROM agents WHERE id = ?")
      .get(id) as { project_id: string } | undefined)?.project_id;
  }

  listProjectWorkingCopies(projectId: string): Array<{
    agentId: string;
    deleted: boolean;
    workingCopy: AgentDto["workingCopy"];
  }> {
    const rows = this.client.prepare(`
      SELECT id, deleted_at, working_copy_json
      FROM agents
      WHERE project_id = ?
      ORDER BY id
    `).all(projectId) as Array<{
      id: string;
      deleted_at: string | null;
      working_copy_json: string;
    }>;
    return rows.map((row) => ({
      agentId: row.id,
      deleted: row.deleted_at !== null,
      workingCopy: JSON.parse(row.working_copy_json) as AgentDto["workingCopy"],
    }));
  }

  updateAgentWorkingCopy(
    id: string,
    workingCopy: AgentDto["workingCopy"],
  ): AgentDto | undefined {
    const row = this.db.select().from(agents).where(and(
      eq(agents.id, id),
      isNull(agents.deletedAt),
    )).get();
    if (!row) return undefined;
    const project = this.getProject(row.projectId);
    if (!project) throw new Error("Agent Project is unavailable");
    if (workingCopy.mode === "shared" && (
      workingCopy.id !== `shared:${project.id}` ||
      workingCopy.rootPath !== project.hostPath ||
      workingCopy.state !== "ready" ||
      workingCopy.branch !== undefined ||
      workingCopy.baseHead !== undefined ||
      workingCopy.branchOwned !== undefined ||
      workingCopy.branchCreationIntent !== undefined ||
      workingCopy.failure !== undefined
    )) throw new Error("invalid Shared folder identity");
    if (workingCopy.mode === "separate_git" && (
      !workingCopy.id.startsWith("copy:") ||
      !workingCopy.rootPath ||
      !workingCopy.branch ||
      (workingCopy.state === "ready" && workingCopy.branchOwned !== true) ||
      (workingCopy.state === "ready" && workingCopy.branchCreationIntent !== undefined) ||
      (workingCopy.state === "ready" && workingCopy.failure !== undefined) ||
      (workingCopy.state === "unavailable" && !workingCopy.failure)
    )) throw new Error("invalid Separate Git copy identity");
    const json = readJson<AgentJson>(agentJsonPath(this.dataDir, row.projectId, id));
    writeJson(agentJsonPath(this.dataDir, row.projectId, id), {
      ...json,
      workingCopy,
      updatedAt: workingCopy.updatedAt,
    });
    this.db.update(agents).set({
      workingCopyJson: JSON.stringify(workingCopy),
      updatedAt: workingCopy.updatedAt,
    }).where(eq(agents.id, id)).run();
    return this.rowToAgentDto(id);
  }

  updateDeletedAgentWorkingCopy(
    id: string,
    workingCopy: AgentDto["workingCopy"],
  ): boolean {
    const row = this.db.select().from(agents).where(and(
      eq(agents.id, id),
    )).get();
    if (!row || row.deletedAt === null) return false;
    const json = readJson<AgentJson>(agentJsonPath(this.dataDir, row.projectId, id));
    writeJson(agentJsonPath(this.dataDir, row.projectId, id), {
      ...json,
      workingCopy,
      updatedAt: workingCopy.updatedAt,
    });
    this.db.update(agents).set({
      workingCopyJson: JSON.stringify(workingCopy),
      updatedAt: workingCopy.updatedAt,
    }).where(eq(agents.id, id)).run();
    return true;
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

  projectImportedHistory(
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

  projectIdOf(agentId: string): string {
    const row = this.db
      .select({ projectId: agents.projectId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();
    if (!row) throw new Error(`unknown agent: ${agentId}`);
    return row.projectId;
  }

  activeEngineOf(agentId: string): string {
    const row = this.db
      .select({ engine: agents.activeEngine })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();
    return row?.engine ?? "codex";
  }

  rowToAgentDto(id: string): AgentDto | undefined {
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
      conversationId: row.conversationId ?? (() => { throw new Error(`live Agent ${row.id} has no owner Chat`); })(),
      title: row.title,
      handle: row.handle,
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
      workingCopy: JSON.parse(row.workingCopyJson) as AgentDto["workingCopy"],
      ...(imported ? { importedHistoryCount: imported.messages.length, importedFrom: imported.source } : {}),
    };
  }
}
