import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from "@ponderosa/native-host/fs";
import { dirname, join } from "node:path";
import { promises as fs } from "@ponderosa/native-host/fs";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type Database from "better-sqlite3";
import { and, eq, isNull, sql } from "drizzle-orm";
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
import { allocateAgentMentionHandle, normalizeAgentRole } from "@ponderosa/core";
import type { Db } from "./db.js";
import { normalizeAgentTitle } from "./agent-identity.js";
import { sharedWorkingCopy } from "./working-copy.js";
import { requireManagementPermissions } from "./store-agent-management.js";
import { appendFsyncedJsonl } from "./append-jsonl.js";
import { pathEntryExists, validateDeletionTombstone } from "./deletion-tombstone-ownership.js";
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
  importedAgentHistoryPath,
} from "./paths.js";

/** Guidance is structured setup, not historical communication. Derive one
 * private-context row without matching or removing any supplied history text. */
function importedHistoryProjectionMessages(
  messages: readonly PortableAgentHistoryMessageDto[],
  initialInstructions: string | undefined,
  importedAt: string,
  initialInstructionsSeparated: boolean,
): PortableAgentHistoryMessageDto[] {
  return [
    ...(initialInstructionsSeparated && initialInstructions ? [{
      role: "system" as const,
      text: `Imported initial instructions:\n${initialInstructions}`.slice(0, 100_000),
      createdAt: importedAt,
    }] : []),
    ...messages,
  ];
}

const MAX_AGENT_TITLE_PROJECTION_IDS = 500;
const AGENT_CREATION_MARKER = ".ponderosa-agent-creation.json";
const agentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface AgentCreationReceipt {
  version: 1;
  projectId: string;
  agentId: string;
  ownershipToken: string;
  phase: "preparing" | "staged" | "canonical_committed";
}

function agentCreationReceiptPath(dataDir: string, projectId: string, agentId: string): string {
  return join(agentsDir(dataDir, projectId), `.agent-creation-${agentId}.json`);
}

function agentCreationStagePath(dataDir: string, receipt: AgentCreationReceipt): string {
  return join(
    agentsDir(dataDir, receipt.projectId),
    `.${receipt.agentId}.${receipt.ownershipToken}.creating`,
  );
}

function agentCreationIdentity(receipt: AgentCreationReceipt): Omit<AgentCreationReceipt, "phase"> {
  const { phase: _phase, ...identity } = receipt;
  return identity;
}

function validateWorkingCopy(
  project: Pick<ProjectDto, "id" | "hostPath">,
  workingCopy: AgentDto["workingCopy"],
): void {
  if (workingCopy.mode === "shared" && (
    workingCopy.id !== `shared:${project.id}` ||
    workingCopy.rootPath !== project.hostPath ||
    workingCopy.state !== "ready" ||
    workingCopy.branch !== undefined ||
    workingCopy.baseHead !== undefined ||
    workingCopy.branchOwned !== undefined ||
    workingCopy.branchCreationIntent !== undefined ||
    workingCopy.branchCreationReceipt !== undefined ||
    workingCopy.cleanupReceipt !== undefined ||
    workingCopy.failure !== undefined
  )) throw new Error("invalid Shared folder identity");
  const cleanupReceipt = workingCopy.cleanupReceipt;
  const validCleanupReceipt = cleanupReceipt !== undefined &&
    ["worktree_removal_authorized", "branch_marker_authorized", "branch_removal_authorized"].includes(cleanupReceipt.phase) &&
    /^[0-9a-f]{40,64}$/u.test(cleanupReceipt.branchHead) &&
    (cleanupReceipt.creationOwnershipRef === undefined ||
      /^refs\/ponderosa\/working-copy-creation\/[0-9a-f]{32}$/u.test(cleanupReceipt.creationOwnershipRef)) &&
    (cleanupReceipt.cleanupOwnershipRef === undefined
      ? cleanupReceipt.phase !== "branch_marker_authorized"
      : /^refs\/ponderosa\/working-copy-cleanup\/[0-9a-f]{32}$/u.test(cleanupReceipt.cleanupOwnershipRef));
  const branchCreationReceipt = workingCopy.branchCreationReceipt;
  const validBranchCreationReceipt = branchCreationReceipt !== undefined &&
    /^refs\/ponderosa\/working-copy-creation\/[0-9a-f]{32}$/u.test(branchCreationReceipt.ownershipRef) &&
    /^[0-9a-f]{40,64}$/u.test(branchCreationReceipt.branchHead) &&
    branchCreationReceipt.branchHead === workingCopy.baseHead;
  if (workingCopy.mode === "separate_git" && (
    !workingCopy.id.startsWith("copy:") ||
    !workingCopy.rootPath ||
    !workingCopy.branch ||
    (workingCopy.state === "ready" && workingCopy.branchOwned !== true) ||
    (workingCopy.state === "ready" && workingCopy.branchCreationIntent !== undefined) ||
    (workingCopy.state === "ready" && workingCopy.branchCreationReceipt !== undefined) ||
    (workingCopy.state === "ready" && workingCopy.cleanupReceipt !== undefined) ||
    (workingCopy.state === "ready" && workingCopy.failure !== undefined) ||
    (workingCopy.state === "unavailable" && !workingCopy.failure) ||
    (workingCopy.branchCreationReceipt !== undefined && (
      workingCopy.state !== "unavailable" || workingCopy.branchOwned !== undefined ||
      workingCopy.branchCreationIntent !== true || !validBranchCreationReceipt
    )) ||
    (workingCopy.cleanupReceipt !== undefined && (
      workingCopy.state !== "unavailable" || workingCopy.branchOwned !== true ||
      workingCopy.branchCreationIntent !== undefined ||
      workingCopy.branchCreationReceipt !== undefined || !validCleanupReceipt
    ))
  )) throw new Error("invalid Separate Git copy identity");
}

export class AgentCatalogAuthority {
  private readonly agentById;
  // ponytail: cache 256 recent metadata roles; use a projected column only if roles need indexed queries.
  private readonly roles = new Map<string, { updatedAt: string; role?: string }>();

  constructor(
    private readonly dataDir: string,
    private readonly db: Db,
    private readonly client: Database.Database,
    private readonly getAgentPreset: (presetId: string) => AgentPresetDto | undefined,
    private readonly getProject: (projectId: string) => ProjectDto | undefined,
  ) {
    this.agentById = db.select().from(agents)
      .where(and(eq(agents.id, sql.placeholder("agentId")), isNull(agents.deletedAt))).prepare();
  }

  clearRoleCache(agentId?: string): void {
    if (agentId) this.roles.delete(agentId); else this.roles.clear();
  }

  private roleFor(row: typeof agents.$inferSelect): string | undefined {
    if (row.deletedAt) return undefined;
    const cached = this.roles.get(row.id);
    if (cached?.updatedAt === row.updatedAt) return cached.role;
    const role = normalizeAgentRole(readJson<AgentJson>(agentJsonPath(this.dataDir, row.projectId, row.id)).role);
    if (this.roles.size >= 256) this.roles.delete(this.roles.keys().next().value!);
    this.roles.set(row.id, { updatedAt: row.updatedAt, role });
    return role;
  }

  private readCreationReceipt(projectId: string, agentId: string): AgentCreationReceipt | undefined {
    const receiptPath = agentCreationReceiptPath(this.dataDir, projectId, agentId);
    if (!pathEntryExists(receiptPath)) return undefined;
    const stat = lstatSync(receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Agent creation receipt is not a regular file");
    const receipt = readJson<AgentCreationReceipt>(receiptPath);
    if (receipt.version !== 1 || receipt.projectId !== projectId || receipt.agentId !== agentId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(receipt.ownershipToken) ||
        !["preparing", "staged", "canonical_committed"].includes(receipt.phase)) {
      throw new Error("Agent creation receipt is invalid");
    }
    return receipt;
  }

  private finishCreationReceipt(receipt: AgentCreationReceipt): void {
    const parent = agentsDir(this.dataDir, receipt.projectId);
    const stage = agentCreationStagePath(this.dataDir, receipt);
    const canonical = agentDir(this.dataDir, receipt.projectId, receipt.agentId);
    const row = this.client.prepare(
      "SELECT deleted_at FROM agents WHERE id = ? AND project_id = ?",
    ).get(receipt.agentId, receipt.projectId) as { deleted_at: string | null } | undefined;
    if (row) {
      if (pathEntryExists(stage) && pathEntryExists(canonical)) {
        throw new Error("Agent creation has ambiguous staged and canonical storage");
      }
      if (pathEntryExists(stage)) {
        const stageStat = lstatSync(stage);
        validateDeletionTombstone(
          stage,
          AGENT_CREATION_MARKER,
          agentCreationIdentity(receipt),
          "Agent creation staging",
          { dev: stageStat.dev, ino: stageStat.ino },
        );
        // ponytail: Node has no portable directory rename-no-replace; retain the
        // canonical preflight until the native host exposes that primitive.
        renameSync(stage, canonical);
        fsyncDirectory(parent);
      }
      if (!pathEntryExists(canonical)) {
        if (row.deleted_at) return;
        throw new Error("Agent creation storage is missing");
      }
      validateDeletionTombstone(
        canonical,
        pathEntryExists(join(canonical, AGENT_CREATION_MARKER)) ? AGENT_CREATION_MARKER : "agent.json",
        pathEntryExists(join(canonical, AGENT_CREATION_MARKER))
          ? agentCreationIdentity(receipt)
          : { id: receipt.agentId, projectId: receipt.projectId },
        "Agent creation canonical storage",
      );
      if (pathEntryExists(join(canonical, AGENT_CREATION_MARKER))) {
        unlinkSync(join(canonical, AGENT_CREATION_MARKER));
        fsyncDirectory(canonical);
      }
    } else {
      if (pathEntryExists(canonical)) {
        throw new Error("Agent creation canonical path exists without its durable row");
      }
      if (pathEntryExists(stage)) {
        const stageStat = lstatSync(stage);
        validateDeletionTombstone(
          stage,
          AGENT_CREATION_MARKER,
          agentCreationIdentity(receipt),
          "Agent creation staging",
          { dev: stageStat.dev, ino: stageStat.ino },
        );
        rmSync(stage, { recursive: true, force: true });
        fsyncDirectory(parent);
      }
    }
    const storedReceipt = this.readCreationReceipt(receipt.projectId, receipt.agentId);
    if (!storedReceipt || JSON.stringify(storedReceipt) !== JSON.stringify(receipt)) {
      throw new Error("Agent creation receipt changed during recovery");
    }
    unlinkSync(agentCreationReceiptPath(this.dataDir, receipt.projectId, receipt.agentId));
    fsyncDirectory(parent);
  }

  createAgent(
    projectId: string,
    input: CreateAgentRequest,
    origin?: AgentSpawnOrigin,
    predeterminedId: string = randomUUID(),
    resolvedPresetSnapshot?: AgentDto["presetSnapshot"] | null,
  ): AgentDto {
    const creationIdempotencyKey = input.idempotencyKey?.trim() || undefined;
    if (creationIdempotencyKey) {
      const existing = this.findAgentCreation(projectId, creationIdempotencyKey);
      if (existing) {
        const receipt = this.readCreationReceipt(projectId, existing.id);
        if (receipt) this.finishCreationReceipt(receipt);
        return this.rowToAgentDto(existing.id)!;
      }
    }
    const id = predeterminedId;
    const previousReceipt = this.readCreationReceipt(projectId, id);
    if (previousReceipt) this.finishCreationReceipt(previousReceipt);
    const receipt: AgentCreationReceipt = {
      version: 1,
      projectId,
      agentId: id,
      ownershipToken: randomUUID(),
      phase: "preparing",
    };
    const stagingRoot = agentCreationStagePath(this.dataDir, receipt);
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
    const preset = resolvedPresetSnapshot === undefined && input.presetId
      ? this.getAgentPreset(input.presetId)
      : undefined;
    if (resolvedPresetSnapshot === undefined && input.presetId &&
        (!preset || preset.projectId !== projectId || !preset.enabled)) {
      throw new Error("invalid preset");
    }
    const presetSnapshot = resolvedPresetSnapshot === undefined
      ? preset ? { id: preset.id, name: preset.name, description: preset.description, guidance: preset.guidance, engine: preset.engine, model: preset.model, effort: preset.effort } : undefined
      : resolvedPresetSnapshot ?? undefined;
    const model = resolvedPresetSnapshot === undefined ? preset?.model ?? input.model : input.model;
    const effort = resolvedPresetSnapshot === undefined ? preset?.effort ?? input.effort : input.effort;
    const speed = input.speed;
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
      role: normalizeAgentRole(input.role),
      handle,
      activeEngine: input.engine,
      model,
      effort,
      speed,
      createdAt: now,
      updatedAt: now,
      managementPermissions,
      spawnedByAgentId: origin?.agentId,
      spawnedByExecutionId: origin?.executionId,
      spawnPrompt: origin?.prompt,
      spawnIdempotencyKey: origin?.idempotencyKey,
      presetSnapshot,
      creationIdempotencyKey,
      workingCopy,
    };
    writeJson(agentCreationReceiptPath(this.dataDir, projectId, id), receipt);
    try {
    this.client.transaction(() => {
      const ownerConversation = this.db.select({ id: conversations.id })
        .from(conversations)
        .where(and(
          eq(conversations.id, input.conversationId),
          eq(conversations.projectId, projectId),
          sql`NOT EXISTS (SELECT 1 FROM conversation_deletion_receipts deleting_chat WHERE deleting_chat.conversation_id = ${conversations.id})`,
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
            deletedAt: agents.deletedAt,
          })
          .from(agents)
          .where(eq(agents.id, input.managerAgentId))
          .get()
        : undefined;
      if (input.managerAgentId && (
        !manager || manager.projectId !== projectId ||
        manager.conversationId !== input.conversationId ||
        manager.deletedAt
      )) {
        throw new Error("Agent manager must be active in the same Project Chat");
      }
      mkdirSync(stagingRoot, { recursive: false });
      writeJson(join(stagingRoot, AGENT_CREATION_MARKER), agentCreationIdentity(receipt));
      mkdirSync(join(stagingRoot, "artifacts"), { recursive: false });
      mkdirSync(join(stagingRoot, "attachments"), { recursive: false });
      writeJson(join(stagingRoot, "agent.json"), record);
      receipt.phase = "staged";
      writeJson(agentCreationReceiptPath(this.dataDir, projectId, id), receipt);
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
        speed: speed ?? null,
        createdAt: now,
        updatedAt: now,
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
      try {
        this.finishCreationReceipt(receipt);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Agent creation and rollback both failed");
      }
      throw error;
    }
    receipt.phase = "canonical_committed";
    writeJson(agentCreationReceiptPath(this.dataDir, projectId, id), receipt);
    this.finishCreationReceipt(receipt);
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
        const match = /^\.agent-creation-([0-9a-f-]+)\.json$/u.exec(name);
        if (!match || !agentIdPattern.test(match[1]!)) continue;
        const receipt = this.readCreationReceipt(project.id, match[1]!);
        if (!receipt) continue;
        this.finishCreationReceipt(receipt);
        changed = true;
      }
      for (const name of readdirSync(directory)) {
        const match = /^\.([0-9a-f-]+)\.creating$/u.exec(name);
        if (!match || !agentIdPattern.test(match[1]!)) continue;
        const id = match[1]!;
        const staging = agentDir(this.dataDir, project.id, name);
        const canonical = agentDir(this.dataDir, project.id, id);
        const row = this.client.prepare(
          "SELECT 1 FROM agents WHERE id = ? AND project_id = ? AND deleted_at IS NULL",
        ).get(id, project.id);
        if (!row || pathEntryExists(canonical)) continue;
        validateDeletionTombstone(
          staging,
          "agent.json",
          { id, projectId: project.id },
          "Legacy Agent creation staging",
        );
        renameSync(staging, canonical);
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
    const row = this.agentById.get({ agentId: id });
    return row ? this.agentRowToDto(row) : undefined;
  }

  /** Existence checks do not need presentation metadata or imported history.
   * Preserve getAgent's live-row and owner-Chat requirements. */
  hasAgent(id: string): boolean {
    const row = this.client.prepare("SELECT conversation_id FROM agents WHERE id = ? AND deleted_at IS NULL")
      .get(id) as { conversation_id: string | null } | undefined;
    if (!row) return false;
    if (row.conversation_id === null) throw new Error(`live Agent ${id} has no owner Chat`);
    return true;
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
    validateWorkingCopy(project, workingCopy);
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
    const project = this.getProject(row.projectId);
    if (!project) throw new Error("Agent Project is unavailable");
    validateWorkingCopy(project, workingCopy);
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

  setImportedHistory(agentId: string, source: string, messages: PortableAgentHistoryMessageDto[], initialInstructions?: string): void {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    const bounded = messages.map((message) => ({
      role: message.role,
      text: message.text.slice(0, 100_000),
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    }));
    const imported = {
      source: source.slice(0, 240), importedAt: new Date().toISOString(), messages: bounded,
      ...(initialInstructions !== undefined ? { initialInstructions: initialInstructions.slice(0, 100_000), initialInstructionsSeparated: true } : {}),
    };
    writeJson(importedAgentHistoryPath(this.dataDir, agent.projectId, agent.id), imported);
    this.projectImportedHistory(agent.id, imported);
  }

  /** Package imports keep their Agents creation-pending until this canonical
   * file and its rebuildable projection are complete. Never await inside a
   * SQLite transaction; bounded batches remain hidden by that existing fence. */
  async setImportedHistoryAsync(agentId: string, source: string, messages: PortableAgentHistoryMessageDto[], initialInstructions?: string): Promise<void> {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    if (!this.client.prepare(`SELECT 1 FROM agent_creation_operation_members AS members
      JOIN agent_creation_operations AS operations ON operations.id = members.operation_id
      WHERE members.agent_id = ? AND operations.status = 'preparing'`).get(agentId)) {
      throw new Error("async history import requires a creation operation");
    }
    const importedAt = new Date().toISOString();
    const pathname = importedAgentHistoryPath(this.dataDir, agent.projectId, agent.id);
    const directory = dirname(pathname);
    await fs.mkdir(directory, { recursive: true });
    const temporary = join(directory, `.${randomUUID()}.json.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      const metadata = { source: source.slice(0, 240), importedAt };
      await handle.writeFile(JSON.stringify(metadata).slice(0, -1) + ',"messages":[');
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!;
        await handle.writeFile((index ? "," : "") + JSON.stringify({ ...message, text: message.text.slice(0, 100_000) }));
      }
      await handle.writeFile("]" + (initialInstructions !== undefined
        ? ',"initialInstructions":' + JSON.stringify(initialInstructions.slice(0, 100_000)) + ',"initialInstructionsSeparated":true' : "") + "}\n");
      await handle.sync();
      await handle.close();
      await fs.rename(temporary, pathname);
      if (process.platform !== "win32") {
        const parent = await fs.open(directory, "r");
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
    const projectedMessages = importedHistoryProjectionMessages(messages, initialInstructions, importedAt, true);
    this.db.delete(importedHistoryMessages).where(eq(importedHistoryMessages.agentId, agentId)).run();
    for (let offset = 0; offset < projectedMessages.length; offset += 8) {
      this.db.transaction(tx => {
        projectedMessages.slice(offset, offset + 8).forEach((message, index) => {
          const sequence = offset + index;
          tx.insert(importedHistoryMessages).values({
            agentId, messageId: `imported:${agentId}:${String(sequence).padStart(12, "0")}`,
            sequence, role: message.role, text: message.text.slice(0, 100_000),
            createdAt: message.createdAt ?? importedAt,
          }).run();
        });
      });
      await yieldToLoop();
    }
  }

  getImportedHistory(agentId: string): { source: string; importedAt: string; messages: PortableAgentHistoryMessageDto[]; initialInstructions?: string } | undefined {
    const agent = this.getAgent(agentId);
    if (!agent) return undefined;
    const file = importedAgentHistoryPath(this.dataDir, agent.projectId, agent.id);
    if (!existsSync(file)) return undefined;
    return readJson(file);
  }

  projectImportedHistory(
    agentId: string,
    imported: { source: string; importedAt: string; messages: PortableAgentHistoryMessageDto[]; initialInstructions?: string; initialInstructionsSeparated?: boolean },
  ): void {
    this.db.transaction((tx) => {
      tx.delete(importedHistoryMessages).where(eq(importedHistoryMessages.agentId, agentId)).run();
      // Existing unmarked history remains exact; never infer provenance from text.
      importedHistoryProjectionMessages(imported.messages, imported.initialInstructions, imported.importedAt, imported.initialInstructionsSeparated === true).forEach((message, sequence) => {
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
    // Pre-Chat-ownership tombstones cannot form a current Agent DTO. History
    // resolves their immutable authored identity without inventing an owner Chat.
    if (row?.deletedAt && !row.conversationId) return undefined;
    return row ? this.agentRowToDto(row) : undefined;
  }

  private agentRowToDto(row: typeof agents.$inferSelect): AgentDto {
    const state: AgentState = {};
    if (row.stateBranch) state.branch = row.stateBranch;
    if (row.stateCommit) state.commit = row.stateCommit;
    let imported: { source: string; count: number } | undefined;
    try {
      const file = importedAgentHistoryPath(this.dataDir, row.projectId, row.id);
      if (existsSync(file)) {
        // Both canonical history writers put bounded source/time metadata before
        // messages. Agent summaries need that header and the existing SQL
        // projection count, never a synchronous read/parse of the full history.
        const descriptor = openSync(file, "r");
        const prefix = Buffer.allocUnsafe(16 * 1024);
        let bytes: number;
        try { bytes = readSync(descriptor, prefix, 0, prefix.length, 0); }
        finally { closeSync(descriptor); }
        const text = prefix.subarray(0, bytes).toString("utf8");
        const separator = /,\s*"messages"\s*:\s*\[/u.exec(text);
        if (!separator) throw new Error("invalid imported history header");
        const header = JSON.parse(text.slice(0, separator.index) + "}") as { source?: unknown };
        if (typeof header.source !== "string") throw new Error("invalid imported history source");
        const count = this.client.prepare("SELECT COUNT(*) AS count FROM imported_history_messages WHERE agent_id = ?").get(row.id) as { count: number };
        imported = { source: header.source, count: count.count };
      }
    } catch { /* malformed optional import history stays out of runtime metadata */ }
    return {
      id: row.id,
      projectId: row.projectId,
      conversationId: row.conversationId ?? (() => { throw new Error(`live Agent ${row.id} has no owner Chat`); })(),
      title: row.title,
      role: this.roleFor(row),
      handle: row.handle,
      activeEngine: row.activeEngine,
      model: row.model ?? undefined,
      effort: row.effort ?? undefined,
      speed: row.speed ?? undefined,
      state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
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
      ...(imported ? { importedHistoryCount: imported.count, importedFrom: imported.source } : {}),
    };
  }
}
