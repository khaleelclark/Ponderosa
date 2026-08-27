import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import type { AgentDeletionPreviewDto, AgentDto } from "@ponderosa/core";
import type { Db } from "./db.js";
import { AgentDeletionConflictError } from "./store-agent-management.js";
import { fsyncDirectory, readJson, writeJson } from "./store-filesystem.js";
import type { AgentDeletionReceipt, AgentJson, AgentManagementAuthorization } from "./store-types.js";
import {
  agentConversationMemberships,
  agentDeletionReceipts,
  agentDeletionTombstones,
  agents,
} from "./schema.js";
import { agentDir, agentsDir, projectsDir } from "./paths.js";

export class AgentDeletionAuthority {
  constructor(
    private readonly dataDir: string,
    private readonly db: Db,
    private readonly client: Database.Database,
    private readonly getAgent: (agentId: string) => AgentDto | undefined,
    private readonly listAgents: (projectId: string) => AgentDto[],
    private readonly authorizeAgentManagementPlan: (
      authorization: AgentManagementAuthorization,
      targetAgentIds: readonly string[],
    ) => void,
    private readonly refreshAllChatFeedProject: (projectId: string) => void,
    private readonly forgetAgentProjection: (agentId: string) => void,
  ) {}

  getAgentDeletionReceiptByPreviewHash(previewHash: string): AgentDeletionReceipt | undefined {
    const row = this.client.prepare(`SELECT * FROM agent_deletion_receipts WHERE preview_hash = ?`).get(previewHash) as {
      id: string; project_id: string; preview_hash: string; root_agent_ids_json: string;
      deleted_agent_ids_json: string; storage_cleanup_completed: number; server_cleanup_completed: number;
      last_error: string | null; created_at: string; updated_at: string; completed_at: string | null;
    } | undefined;
    return row ? {
      id: row.id,
      projectId: row.project_id,
      previewHash: row.preview_hash,
      rootAgentIds: JSON.parse(row.root_agent_ids_json) as string[],
      deletedAgentIds: JSON.parse(row.deleted_agent_ids_json) as string[],
      storageCleanupCompleted: row.storage_cleanup_completed === 1,
      serverCleanupCompleted: row.server_cleanup_completed === 1,
      ...(row.last_error ? { lastError: row.last_error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    } : undefined;
  }

  listPendingAgentDeletionReceipts(): AgentDeletionReceipt[] {
    const hashes = this.client.prepare(`
      SELECT preview_hash FROM agent_deletion_receipts
      WHERE storage_cleanup_completed = 0 OR server_cleanup_completed = 0
      ORDER BY created_at
    `).all() as Array<{ preview_hash: string }>;
    return hashes.flatMap(({ preview_hash }) => {
      const receipt = this.getAgentDeletionReceiptByPreviewHash(preview_hash);
      return receipt ? [receipt] : [];
    });
  }

  recordAgentDeletionCleanupError(receiptId: string, error: string): void {
    this.client.prepare(`
      UPDATE agent_deletion_receipts SET last_error = ?, updated_at = ? WHERE id = ?
    `).run(error.slice(0, 4_000), new Date().toISOString(), receiptId);
  }

  markAgentDeletionServerCleanupComplete(receiptId: string): void {
    const now = new Date().toISOString();
    this.client.prepare(`
      UPDATE agent_deletion_receipts
      SET server_cleanup_completed = 1, last_error = NULL, updated_at = ?,
          completed_at = CASE WHEN storage_cleanup_completed = 1 THEN ? ELSE completed_at END
      WHERE id = ?
    `).run(now, now, receiptId);
  }

  /** Compute the exact server-authoritative cascade the operator will confirm. */
  previewAgentDeletion(rootAgentIds: string[]): AgentDeletionPreviewDto {
    const requested = [...new Set(rootAgentIds)].sort();
    if (requested.length < 1 || requested.length > 100) throw new Error("deletion requires 1 to 100 root Agent IDs");
    const roots = requested.map((id) => this.getAgent(id));
    if (roots.some((agent) => !agent)) throw new Error("agent not found");
    const projectId = roots[0]!.projectId;
    if (roots.some((agent) => agent!.projectId !== projectId)) throw new Error("deletion roots must belong to one Project");
    const projectAgents = this.listAgents(projectId);
    const byId = new Map(projectAgents.map((agent) => [agent.id, agent]));
    const requestedSet = new Set(requested);
    const normalizedRoots = roots.filter((agent) => {
      let managerId = agent!.managerAgentId;
      const visited = new Set<string>();
      while (managerId && !visited.has(managerId)) {
        if (requestedSet.has(managerId)) return false;
        visited.add(managerId);
        managerId = byId.get(managerId)?.managerAgentId;
      }
      return true;
    }).map((agent) => agent!.id).sort();
    const children = new Map<string, AgentDto[]>();
    for (const agent of projectAgents) if (agent.managerAgentId) {
      children.set(agent.managerAgentId, [...(children.get(agent.managerAgentId) ?? []), agent]);
    }
    const affectedIds = new Set<string>();
    const visit = (id: string): void => {
      if (affectedIds.has(id)) return;
      affectedIds.add(id);
      for (const child of children.get(id) ?? []) visit(child.id);
    };
    normalizedRoots.forEach(visit);
    const affectedAgents = [...affectedIds].sort().map((id) => {
      const agent = byId.get(id)!;
      return { id: agent.id, title: agent.title, ...(agent.managerAgentId ? { managerAgentId: agent.managerAgentId } : {}) };
    });
    const previewHash = createHash("sha256").update(JSON.stringify({
      projectId,
      rootAgentIds: normalizedRoots,
      affectedAgents: affectedAgents.map((agent) => ({
        id: agent.id,
        title: agent.title,
        managerAgentId: agent.managerAgentId ?? null,
      })),
    })).digest("hex");
    return { projectId, rootAgentIds: normalizedRoots, affectedAgents, previewHash };
  }

  /**
   * Validate and permanently delete every confirmed subtree in one SQLite
   * transaction. Canonical directories are first renamed to hidden tombstones;
   * a crash can therefore never resurrect a committed deletion during rebuild.
   */
  deleteAgentSubtrees(
    rootAgentIds: string[],
    expectedPreviewHash: string,
    beforeProjectionDelete?: (agentId: string) => void,
    authorization?: AgentManagementAuthorization,
  ): AgentDeletionPreviewDto {
    let committedPreview: AgentDeletionPreviewDto | undefined;
    const stagedDirectories = new Map<string, { canonical: string; tombstone: string; tombstoneName: string }>();
    try {
      this.db.transaction((tx) => {
        const current = this.previewAgentDeletion(rootAgentIds);
        if (current.previewHash !== expectedPreviewHash) throw new AgentDeletionConflictError(current);
        if (authorization) {
          this.authorizeAgentManagementPlan(authorization, current.affectedAgents.map((agent) => agent.id));
        }
        committedPreview = current;
        for (const agent of current.affectedAgents) {
          const canonical = agentDir(this.dataDir, current.projectId, agent.id);
          const tombstoneName = `.${agent.id}.deleting-${randomUUID()}`;
          const tombstone = join(agentsDir(this.dataDir, current.projectId), tombstoneName);
          renameSync(canonical, tombstone);
          stagedDirectories.set(agent.id, { canonical, tombstone, tombstoneName });
        }
        // Make every rename durable before SQLite is allowed to commit. The
        // journal rows below distinguish a committed deletion from a crash
        // before commit and let startup either finish or restore it.
        fsyncDirectory(agentsDir(this.dataDir, current.projectId));
        const createdAt = new Date().toISOString();
        const receiptId = `agent-deletion-${current.previewHash}`;
        tx.insert(agentDeletionReceipts).values({
          id: receiptId,
          projectId: current.projectId,
          previewHash: current.previewHash,
          rootAgentIdsJson: JSON.stringify(current.rootAgentIds),
          deletedAgentIdsJson: JSON.stringify(current.affectedAgents.map((agent) => agent.id)),
          storageCleanupCompleted: 0,
          serverCleanupCompleted: 0,
          createdAt,
          updatedAt: createdAt,
        }).run();
        for (const [agentId, staged] of stagedDirectories) tx.insert(agentDeletionTombstones).values({
          agentId,
          projectId: current.projectId,
          tombstoneName: staged.tombstoneName,
          createdAt,
        }).run();
        // Coordination V3 shares this SQLite connection. Its nested
        // transactions become savepoints, so all scheduler outcomes and every
        // selected Agent authority fence commit or roll back as one unit.
        for (const agent of current.affectedAgents) beforeProjectionDelete?.(agent.id);
        for (const agent of current.affectedAgents) {
          tx.delete(agentConversationMemberships).where(eq(agentConversationMemberships.agentId, agent.id)).run();
          tx.update(agents).set({
            conversationId: null,
            activeSessionId: null,
            activeSessionContractHash: null,
            activeSessionArtifactIdsJson: "[]",
            archived: 1,
            managerAgentId: null,
            allowAutomaticDescendantDeletion: 0,
            allowAutomaticDescendantReorganization: 0,
            deletedAt: createdAt,
            updatedAt: createdAt,
          }).where(eq(agents.id, agent.id)).run();
        }
      });
    } catch (error) {
      for (const { canonical, tombstone } of [...stagedDirectories.values()].reverse()) {
        if (existsSync(tombstone) && !existsSync(canonical)) renameSync(tombstone, canonical);
      }
      for (const directory of new Set([...stagedDirectories.values()].map(({ canonical }) => dirname(canonical)))) {
        if (existsSync(directory)) fsyncDirectory(directory);
      }
      throw error;
    }
    // The irreversible SQLite commit already succeeded. Storage cleanup is an
    // idempotent receipt-backed follow-up and must never turn success into an
    // HTTP failure.
    const receipt = this.getAgentDeletionReceiptByPreviewHash(expectedPreviewHash)!;
    try { this.finishAgentDeletionStorageCleanup(receipt); }
    catch (error) {
      this.recordAgentDeletionCleanupError(receipt.id, error instanceof Error ? error.message : "Agent storage cleanup failed");
    }
    this.refreshAllChatFeedProject(committedPreview!.projectId);
    return committedPreview!;
  }

  finishAgentDeletionStorageCleanup(receipt: AgentDeletionReceipt): void {
    if (receipt.storageCleanupCompleted) return;
    const touchedDirectories = new Set<string>();
    for (const agentId of receipt.deletedAgentIds) {
      const row = this.client.prepare(`
        SELECT project_id, tombstone_name, created_at FROM agent_deletion_tombstones WHERE agent_id = ?
      `).get(agentId) as { project_id: string; tombstone_name: string; created_at: string } | undefined;
      if (row) {
        const directory = agentsDir(this.dataDir, row.project_id);
        const tombstone = join(directory, row.tombstone_name);
        const canonical = agentDir(this.dataDir, row.project_id, agentId);
        if (existsSync(tombstone)) {
          // Upload staging and attachment capability state are live authority,
          // not deletion-surviving execution audit.
          rmSync(join(tombstone, "attachments"), { recursive: true, force: true });
          const metadataPath = join(tombstone, "agent.json");
          const metadata = readJson<AgentJson>(metadataPath);
          writeJson(metadataPath, {
            ...metadata,
            conversationId: undefined,
            archived: true,
            deletedAt: row.created_at,
            updatedAt: row.created_at,
            managementPermissions: {
              allowAutomaticDescendantDeletion: false,
              allowAutomaticDescendantReorganization: false,
            },
          });
          if (existsSync(canonical)) throw new Error("deleted Agent audit destination already exists");
          renameSync(tombstone, canonical);
        }
        touchedDirectories.add(directory);
      }
      this.forgetAgentProjection(agentId);
    }
    for (const directory of touchedDirectories) if (existsSync(directory)) fsyncDirectory(directory);
    this.db.transaction((tx) => {
      for (const agentId of receipt.deletedAgentIds) {
        tx.delete(agentDeletionTombstones).where(eq(agentDeletionTombstones.agentId, agentId)).run();
      }
      const now = new Date().toISOString();
      tx.update(agentDeletionReceipts).set({
        storageCleanupCompleted: 1,
        lastError: null,
        updatedAt: now,
        completedAt: receipt.serverCleanupCompleted ? now : null,
      }).where(eq(agentDeletionReceipts.id, receipt.id)).run();
    });
  }

  /** Internal exact-current deletion convenience for creation rollback. */
  deleteAgent(id: string, beforeProjectionDelete?: (agentId: string) => void): boolean {
    if (!this.getAgent(id)) return false;
    const preview = this.previewAgentDeletion([id]);
    this.deleteAgentSubtrees(preview.rootAgentIds, preview.previewHash, beforeProjectionDelete);
    return true;
  }

  recoverAgentDeletionDirectories(): void {
    const committed = this.db.select().from(agentDeletionTombstones).all();
    const committedNames = new Set(committed.map((row) => `${row.projectId}\0${row.tombstoneName}`));
    const touchedDirectories = new Set<string>();
    for (const row of committed) {
      if (row.tombstoneName.includes("/") || row.tombstoneName.includes("\\") ||
          !row.tombstoneName.startsWith(`.${row.agentId}.deleting-`)) {
        throw new Error("invalid Agent deletion recovery journal");
      }
      const directory = agentsDir(this.dataDir, row.projectId);
      const tombstone = join(directory, row.tombstoneName);
      const canonical = agentDir(this.dataDir, row.projectId, row.agentId);
      const auditDirectory = existsSync(tombstone) ? tombstone : canonical;
      if (!existsSync(auditDirectory)) throw new Error("committed Agent deletion lost its audit directory");
      rmSync(join(auditDirectory, "attachments"), { recursive: true, force: true });
      const metadataPath = join(auditDirectory, "agent.json");
      const metadata = readJson<AgentJson>(metadataPath);
      writeJson(metadataPath, {
        ...metadata,
        conversationId: undefined,
        archived: true,
        deletedAt: row.createdAt,
        updatedAt: row.createdAt,
        managementPermissions: {
          allowAutomaticDescendantDeletion: false,
          allowAutomaticDescendantReorganization: false,
        },
      });
      if (auditDirectory === tombstone) {
        if (existsSync(canonical)) throw new Error("deleted Agent audit destination already exists");
        renameSync(tombstone, canonical);
      }
      if (existsSync(directory)) touchedDirectories.add(directory);
    }
    const root = projectsDir(this.dataDir);
    if (existsSync(root)) for (const projectId of readdirSync(root)) {
      const directory = agentsDir(this.dataDir, projectId);
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory)) {
        const separator = name.indexOf(".deleting-", 1);
        if (!name.startsWith(".") || separator < 2 || committedNames.has(`${projectId}\0${name}`)) continue;
        const agentId = name.slice(1, separator);
        const tombstone = join(directory, name);
        const canonical = agentDir(this.dataDir, projectId, agentId);
        if (existsSync(canonical)) rmSync(tombstone, { recursive: true, force: true });
        else renameSync(tombstone, canonical);
        touchedDirectories.add(directory);
      }
    }
    for (const directory of touchedDirectories) fsyncDirectory(directory);
    this.db.transaction((tx) => {
      tx.delete(agentDeletionTombstones).run();
      const now = new Date().toISOString();
      this.client.prepare(`
        UPDATE agent_deletion_receipts
        SET storage_cleanup_completed = 1, last_error = NULL, updated_at = ?,
            completed_at = CASE WHEN server_cleanup_completed = 1 THEN ? ELSE completed_at END
        WHERE storage_cleanup_completed = 0
      `).run(now, now);
    });
  }

}
