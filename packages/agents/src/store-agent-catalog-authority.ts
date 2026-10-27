import type { ProjectionProgress } from "./projection-checkpoint.js";
import { createHash, randomUUID } from "node:crypto";
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
import { allocateAgentMentionHandle, agentMentionHandleBase, normalizeAgentRole, agentPackageJsonUtf8Bytes, agentPackageTextIsWellFormed, AGENT_PACKAGE_MAX_BYTES } from "@ponderosa/core";
import { CompactionHistoryQueryError } from "./compaction-history-retrieval.js";
import { decodeImportedUtf8Window, normalizeImportedHistorySearchText, readImportedHistory, searchImportedHistory } from "./imported-history-retrieval.js";
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
      text: initialInstructions,
      createdAt: importedAt,
    }] : []),
    ...messages,
  ];
}

const MAX_AGENT_TITLE_PROJECTION_IDS = 500;
const AGENT_CREATION_MARKER = ".ponderosa-agent-creation.json";
const agentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type ImportedArchive = { source: string; importedAt: string; messages: PortableAgentHistoryMessageDto[];
  initialInstructions?: string; initialInstructionsSeparated?: boolean };
type ImportedIndex = { archive_version: string; integrity_key: string; imported_at: string; expected_messages: number;
  status: "preparing" | "ready" | "unavailable" };

function importedArchiveVersion(file: string): string | undefined {
  try {
    const stat = lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return createHash("sha256").update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

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
  private readonly nextHandleSuffix = new Map<string, number>();
  private importedIndexClosed = false;
  private importedIndexEpoch = 0;
  private importedIndexRunning = false;
  private readonly importedIndexActive = new Map<string, string>();
  private readonly importedIndexQueue = new Map<string, { version: string; project: boolean }>();
  private readonly agentById;
  // ponytail: cache 256 recent metadata roles; use a projected column only if roles need indexed queries.
  private readonly roles = new Map<string, { updatedAt: string; role?: string }>();

  constructor(
    private readonly dataDir: string,
    private readonly db: Db,
    private readonly client: Database.Database,
    private readonly getAgentPreset: (presetId: string) => AgentPresetDto | undefined,
    private readonly getProject: (projectId: string) => ProjectDto | undefined,
    private readonly progress: ProjectionProgress,
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
    const handleBase = agentMentionHandleBase(title);
    const handleKey = `${projectId}:${handleBase.toLocaleLowerCase()}`;
    const handle = allocateAgentMentionHandle(title, normalized => Boolean(this.client.prepare(
      "SELECT 1 FROM agent_handle_reservations WHERE project_id = ? AND normalized_handle = ?",
    ).get(projectId, normalized)), this.nextHandleSuffix.get(handleKey));
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
    // Reservations are monotonic. Keep only a bounded allocation hint; SQLite's
    // unique reservation remains authority, including after a failed create.
    if (this.nextHandleSuffix.size >= 256) this.nextHandleSuffix.delete(this.nextHandleSuffix.keys().next().value!);
    const suffix = handle.slice(handleBase.length + 1);
    this.nextHandleSuffix.set(handleKey, /^\d+$/u.test(suffix) ? Number(suffix) + 1 : 2);
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
    const imported: ImportedArchive = {
      source: source.slice(0, 240), importedAt: new Date().toISOString(), messages,
      ...(initialInstructions !== undefined ? { initialInstructions, initialInstructionsSeparated: true } : {}),
    };
    this.validateImportedArchiveSize(imported);
    this.importedIndexQueue.delete(agentId);
    writeJson(importedAgentHistoryPath(this.dataDir, agent.projectId, agent.id), imported, 0);
    this.projectImportedHistory(agent.id, imported);
  }

  /** Creation-pending fencing keeps incomplete imports out of ordinary views. */
  async setImportedHistoryAsync(agentId: string, source: string, messages: PortableAgentHistoryMessageDto[], initialInstructions?: string): Promise<void> {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error("agent not found");
    if (!this.client.prepare(`SELECT 1 FROM agent_creation_operation_members AS members
      JOIN agent_creation_operations AS operations ON operations.id = members.operation_id
      WHERE members.agent_id = ? AND operations.status = 'preparing'`).get(agentId)) {
      throw new Error("async history import requires a creation operation");
    }
    const imported: ImportedArchive = { source: source.slice(0, 240), importedAt: new Date().toISOString(), messages,
      ...(initialInstructions !== undefined ? { initialInstructions, initialInstructionsSeparated: true } : {}) };
    this.validateImportedArchiveSize(imported);
    this.importedIndexQueue.delete(agentId);
    const pathname = importedAgentHistoryPath(this.dataDir, agent.projectId, agent.id);
    const directory = dirname(pathname);
    await fs.mkdir(directory, { recursive: true });
    const temporary = join(directory, `.${randomUUID()}.json.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ source: imported.source, importedAt: imported.importedAt }).slice(0, -1) + ',"messages":[');
      for (let index = 0; index < messages.length; index++) {
        await handle.writeFile((index ? "," : "") + JSON.stringify(messages[index]));
      }
      await handle.writeFile("]" + (initialInstructions !== undefined
        ? ',"initialInstructions":' + JSON.stringify(initialInstructions) + ',"initialInstructionsSeparated":true' : "") + "}\n");
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
    await this.projectImportedHistoryAsync(agentId, imported, importedArchiveVersion(pathname)!);
  }

  private validateImportedArchiveSize(imported: ImportedArchive): void {
    if (imported.initialInstructions !== undefined && !agentPackageTextIsWellFormed(imported.initialInstructions) ||
        imported.messages.some(message => !agentPackageTextIsWellFormed(message.text))) {
      throw new Error("Imported history must contain well-formed Unicode text");
    }
    // Count one row at a time: the retained archive, not a clipped substitute,
    // must fit the existing package ceiling before canonical storage changes.
    agentPackageJsonUtf8Bytes(imported, AGENT_PACKAGE_MAX_BYTES - 1);
  }

  getImportedHistory(agentId: string): ImportedArchive | undefined {
    const agent = this.getAgent(agentId);
    if (!agent) return undefined;
    const file = importedAgentHistoryPath(this.dataDir, agent.projectId, agent.id);
    if (!existsSync(file)) return undefined;
    return readJson(file);
  }

  private beginImportedProjection(agentId: string, imported: ImportedArchive, version: string): {
    messages: PortableAgentHistoryMessageDto[]; separated: boolean; digest: ReturnType<typeof createHash>;
  } {
    this.importedIndexQueue.delete(agentId);
    const separated = imported.initialInstructionsSeparated === true && Boolean(imported.initialInstructions);
    const messages = importedHistoryProjectionMessages(imported.messages, imported.initialInstructions, imported.importedAt, imported.initialInstructionsSeparated === true);
    this.client.transaction(() => {
      this.client.prepare("DELETE FROM imported_history_messages WHERE agent_id = ?").run(agentId);
      this.client.prepare(`INSERT OR REPLACE INTO imported_history_indexes
        (agent_id, archive_version, integrity_key, imported_at, expected_messages, status) VALUES (?, ?, '', ?, ?, 'preparing')`)
        .run(agentId, version, imported.importedAt, messages.length);
    })();
    return { messages, separated, digest: createHash("sha256").update(JSON.stringify([
      imported.source, imported.importedAt, imported.initialInstructionsSeparated === true,
    ])) };
  }

  private projectImportedMessage(agentId: string, imported: ImportedArchive,
    projection: ReturnType<AgentCatalogAuthority["beginImportedProjection"]>, sequence: number): void {
    const message = projection.messages[sequence]!;
    const guidance = projection.separated && sequence === 0;
    const contentSha256 = createHash("sha256").update(message.text).digest("hex");
    let totalCodePoints = 0, totalUtf8Bytes = 0;
    const codePointByteOffsets = [0];
    for (const point of message.text) {
      const code = point.codePointAt(0)!;
      totalUtf8Bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      if (++totalCodePoints % 4096 === 0) codePointByteOffsets.push(totalUtf8Bytes);
    }
    projection.digest.update(JSON.stringify([message.role, contentSha256, message.createdAt ?? null, guidance]));
    this.db.insert(importedHistoryMessages).values({
      agentId, messageId: `imported:${agentId}:${String(sequence).padStart(12, "0")}`,
      sequence, role: message.role, text: message.text, createdAt: message.createdAt ?? imported.importedAt,
      sourceKind: guidance ? "guidance" : "history", sourceSequence: guidance ? 0 : sequence - (projection.separated ? 1 : 0),
      sourceCreatedAt: guidance ? null : message.createdAt ?? null,
      contentSha256, totalCodePoints, totalUtf8Bytes, codePointByteOffsets: JSON.stringify(codePointByteOffsets),
    }).run();
  }

  projectImportedHistory(agentId: string, imported: ImportedArchive, options: { deferIndex?: boolean } = {}): void {
    const agent = this.getAgent(agentId);
    if (!agent) return;
    const file = importedAgentHistoryPath(this.dataDir, agent.projectId, agentId);
    const version = importedArchiveVersion(file);
    if (!version) return;
    this.client.transaction(() => {
      const projection = this.beginImportedProjection(agentId, imported, version);
      for (let sequence = 0; sequence < projection.messages.length; sequence++) this.projectImportedMessage(agentId, imported, projection, sequence);
      this.client.prepare("UPDATE imported_history_indexes SET integrity_key = ? WHERE agent_id = ?")
        .run(projection.digest.digest("hex"), agentId);
      if (!options.deferIndex) {
        for (let sequence = 0; sequence < projection.messages.length; sequence++) {
          const row = this.client.prepare("SELECT rowid FROM imported_history_messages WHERE agent_id = ? AND sequence = ?").get(agentId, sequence) as { rowid: number };
          this.client.prepare("INSERT INTO imported_history_fts(rowid, text) VALUES (?, ?)").run(row.rowid, normalizeImportedHistorySearchText(projection.messages[sequence]!.text));
        }
        this.client.prepare("UPDATE imported_history_indexes SET status = 'ready' WHERE agent_id = ?").run(agentId);
      }
    })();
    if (options.deferIndex) this.queueImportedIndex(agentId, version, false);
  }

  private importedIndexWrite<T>(write: () => T): T {
    // Certify this synchronous derived-index turn through the existing owner;
    // never credit another owner's work between indexing turns.
    return this.progress.run([], write);
  }

  private async projectImportedHistoryAsync(agentId: string, imported: ImportedArchive, version: string, deferred = false): Promise<void> {
    const epoch = this.importedIndexEpoch;
    const write = <T>(operation: () => T): T => deferred ? this.importedIndexWrite(operation) : operation();
    const projection = write(() => this.beginImportedProjection(agentId, imported, version));
    for (let sequence = 0; sequence < projection.messages.length; sequence++) {
      if (!this.importedProjectionCurrent(agentId, version, epoch)) throw new Error("imported history projection was superseded");
      write(() => this.client.transaction(() => {
        this.projectImportedMessage(agentId, imported, projection, sequence);
        const row = this.client.prepare("SELECT rowid FROM imported_history_messages WHERE agent_id = ? AND sequence = ?").get(agentId, sequence) as { rowid: number };
        this.client.prepare("INSERT INTO imported_history_fts(rowid, text) VALUES (?, ?)").run(row.rowid, normalizeImportedHistorySearchText(projection.messages[sequence]!.text));
      })());
      await yieldToLoop();
    }
    if (!this.importedProjectionCurrent(agentId, version, epoch)) throw new Error("imported history projection was superseded");
    write(() => this.client.prepare("UPDATE imported_history_indexes SET integrity_key = ?, status = 'ready' WHERE agent_id = ? AND archive_version = ?")
      .run(projection.digest.digest("hex"), agentId, version));
  }

  private importedProjectionCurrent(agentId: string, version: string, epoch: number): boolean {
    if (this.importedIndexClosed || this.importedIndexEpoch !== epoch) return false;
    const row = this.client.prepare("SELECT project_id FROM agents WHERE id = ? AND deleted_at IS NULL").get(agentId) as { project_id: string } | undefined;
    const index = this.client.prepare("SELECT archive_version FROM imported_history_indexes WHERE agent_id = ?").get(agentId) as { archive_version: string } | undefined;
    return Boolean(row && index?.archive_version === version && importedArchiveVersion(importedAgentHistoryPath(this.dataDir, row.project_id, agentId)) === version);
  }

  /** Reuse this catalog's projection lifecycle; no scheduler or canonical writes. */
  private queueImportedIndex(agentId: string, version: string, project: boolean): void {
    if (this.importedIndexClosed || this.importedIndexActive.get(agentId) === version) return;
    if (project) this.importedIndexWrite(() => this.client.prepare(`INSERT OR REPLACE INTO imported_history_indexes
      (agent_id, archive_version, integrity_key, imported_at, expected_messages, status)
      VALUES (?, ?, '', '', 0, 'preparing')`).run(agentId, version));
    this.importedIndexQueue.set(agentId, { version, project });
    if (this.importedIndexRunning) return;
    this.importedIndexRunning = true;
    void this.drainImportedIndexes().finally(() => { this.importedIndexRunning = false; });
  }

  private async drainImportedIndexes(): Promise<void> {
    await yieldToLoop();
    while (!this.importedIndexClosed && this.importedIndexQueue.size) {
      const [agentId, job] = this.importedIndexQueue.entries().next().value!;
      this.importedIndexQueue.delete(agentId);
      const epoch = this.importedIndexEpoch;
      this.importedIndexActive.set(agentId, job.version);
      try {
        if (job.project) {
          const row = this.client.prepare("SELECT project_id FROM agents WHERE id = ? AND deleted_at IS NULL").get(agentId) as { project_id: string } | undefined;
          if (!row) continue;
          const file = importedAgentHistoryPath(this.dataDir, row.project_id, agentId);
          const raw = await fs.readFile(file, "utf8");
          if (this.importedIndexClosed || epoch !== this.importedIndexEpoch || importedArchiveVersion(file) !== job.version) continue;
          await this.projectImportedHistoryAsync(agentId, JSON.parse(raw) as ImportedArchive, job.version, true);
          continue;
        }
        let lastSequence = -1;
        while (this.importedProjectionCurrent(agentId, job.version, epoch)) {
          const rows = this.client.prepare(`SELECT rowid, sequence FROM imported_history_messages
            WHERE agent_id = ? AND sequence > ? ORDER BY sequence LIMIT 8`).all(agentId, lastSequence) as Array<{ rowid: number; sequence: number }>;
          if (!rows.length) {
            const counts = this.client.prepare(`SELECT expected_messages AS expected,
              (SELECT count(*) FROM imported_history_messages m JOIN imported_history_fts f ON f.rowid = m.rowid WHERE m.agent_id = ?) AS actual
              FROM imported_history_indexes WHERE agent_id = ?`).get(agentId, agentId) as { expected: number; actual: number };
            if (counts.expected !== counts.actual) throw new Error("imported history index is incomplete");
            this.importedIndexWrite(() => this.client.prepare("UPDATE imported_history_indexes SET status = 'ready' WHERE agent_id = ? AND archive_version = ?").run(agentId, job.version));
            break;
          }
          // One admitted row per turn. Ordinary text stays inside SQLite; only
          // embedded NUL needs a JS-normalized FTS copy (never an archive edit).
          for (const row of rows) {
            if (!this.importedProjectionCurrent(agentId, job.version, epoch)) break;
            this.importedIndexWrite(() => {
              const nul = this.client.prepare("SELECT instr(CAST(text AS BLOB), x'00') AS position FROM imported_history_messages WHERE rowid = ?").get(row.rowid) as { position: number };
              if (nul.position) {
                const stored = this.client.prepare("SELECT text FROM imported_history_messages WHERE rowid = ?").get(row.rowid) as { text: string };
                this.client.prepare("INSERT OR REPLACE INTO imported_history_fts(rowid, text) VALUES (?, ?)").run(row.rowid, normalizeImportedHistorySearchText(stored.text));
              } else {
                this.client.prepare("INSERT OR REPLACE INTO imported_history_fts(rowid, text) SELECT rowid, text FROM imported_history_messages WHERE rowid = ?").run(row.rowid);
              }
            });
            lastSequence = row.sequence;
            await yieldToLoop();
          }
        }
      } catch {
        if (!this.importedIndexClosed && epoch === this.importedIndexEpoch) {
          this.importedIndexWrite(() => this.client.prepare("UPDATE imported_history_indexes SET status = 'unavailable' WHERE agent_id = ? AND archive_version = ?").run(agentId, job.version));
        }
      } finally {
        if (this.importedIndexActive.get(agentId) === job.version) this.importedIndexActive.delete(agentId);
      }
    }
  }

  invalidateImportedIndexes(close = false): void {
    this.importedIndexEpoch++;
    this.importedIndexQueue.clear();
    this.importedIndexActive.clear();
    this.nextHandleSuffix.clear();
    if (close) this.importedIndexClosed = true;
  }

  getImportedHistoryAvailability(agentId: string): { status: "ready" | "preparing" | "unavailable"; archiveVersion?: string } {
    if (this.importedIndexClosed) return { status: "unavailable" };
    const agent = this.getAgent(agentId);
    if (!agent) return { status: "unavailable" };
    const version = importedArchiveVersion(importedAgentHistoryPath(this.dataDir, agent.projectId, agentId));
    if (!version) return { status: "unavailable" };
    const index = this.client.prepare("SELECT * FROM imported_history_indexes WHERE agent_id = ?").get(agentId) as ImportedIndex | undefined;
    if (index?.archive_version === version) {
      if (index.status === "preparing") this.queueImportedIndex(agentId, version, !index.integrity_key);
      return { status: index.status, archiveVersion: version };
    }
    this.queueImportedIndex(agentId, version, true);
    return { status: "preparing", archiveVersion: version };
  }

  private importedRetrievalInput(agentId: string, archiveVersion: string) {
    const availability = this.getImportedHistoryAvailability(agentId);
    if (availability.status !== "ready" || availability.archiveVersion !== archiveVersion) {
      throw new CompactionHistoryQueryError(availability.status === "preparing" ? "Imported History Index Preparing" : "imported history archive is unavailable or changed");
    }
    const index = this.client.prepare("SELECT * FROM imported_history_indexes WHERE agent_id = ?").get(agentId) as ImportedIndex;
    return { sqlite: this.client, agentId, archiveVersion, integrityKey: index.integrity_key, importedAt: index.imported_at };
  }

  searchImportedHistory(input: { agentId: string; archiveVersion: string; query: string; limit?: number }) {
    return searchImportedHistory({ ...input, ...this.importedRetrievalInput(input.agentId, input.archiveVersion) });
  }

  readImportedHistory(input: { agentId: string; archiveVersion: string; reference: string; continuation?: string; before?: number; after?: number }) {
    return readImportedHistory({ ...input, ...this.importedRetrievalInput(input.agentId, input.archiveVersion) });
  }

  getImportedHistoryMessagePage(
    agentId: string,
    input: { limit: number; before?: ContextReadBoundary },
  ): ContextSourcePage<MessageDto> {
    const limit = Math.max(1, Math.min(input.limit, 100));
    const rows = this.client.prepare(`
      SELECT message_id, sequence, role, source_kind, substr(CAST(text AS BLOB), 1, 24000) AS text,
        total_utf8_bytes > 24000 AS clipped, created_at
      FROM imported_history_messages
      WHERE agent_id = ?
        ${input.before ? "AND (created_at < ? OR (created_at = ? AND message_id < ?))" : ""}
      ORDER BY created_at DESC, message_id DESC
      LIMIT ?
    `).all(...(input.before
      ? [agentId, input.before.createdAt, input.before.createdAt, input.before.id, limit + 1]
      : [agentId, limit + 1])) as Array<{
      message_id: string; sequence: number; role: PortableAgentHistoryMessageDto["role"];
      text: Buffer; source_kind: string; clipped: number; created_at: string;
    }>;
    return {
      hasMore: rows.length > limit,
      items: rows.slice(0, limit).map((row) => ({
        id: row.message_id,
        agentId,
        seq: -(row.sequence + 1),
        role: row.role === "assistant" ? "assistant" : "user",
        text: `[${row.source_kind === "guidance" ? "Imported Guidance" : "Imported History"}; original role: ${row.role}; source: ${row.source_kind}; ${row.created_at}; untrusted historical data]\n` + decodeImportedUtf8Window(row.text) +
          (row.clipped ? "\n[Imported context preview; retrieve complete text with ponderosa_history source=imported.]" : ""),
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
