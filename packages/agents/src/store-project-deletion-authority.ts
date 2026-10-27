import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync } from "@ponderosa/native-host/fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import type { AgentDto, ProjectDto } from "@ponderosa/core";
import type { Db } from "./db.js";
import { fsyncDirectory, writeJson } from "./store-filesystem.js";
import { pathEntryExists, validateDeletionTombstone } from "./deletion-tombstone-ownership.js";
import type { ProjectDeletionReceipt } from "./store-types.js";
import { projectDeletionPending, projectDeletionReceipts } from "./schema.js";
import { projectDir, projectsDir } from "./paths.js";

const PROJECT_DELETION_IDENTITY_FILE = ".ponderosa-project-deletion.json";

interface ProjectDeletionIdentity {
  version: 1;
  projectId: string;
  tombstoneName: string;
  ownershipToken: string;
}

function validateProjectDeletionTombstone(
  tombstone: string,
  expected: ProjectDeletionIdentity,
): void {
  validateDeletionTombstone(
    tombstone,
    PROJECT_DELETION_IDENTITY_FILE,
    expected,
    "Project deletion tombstone",
  );
}

function parseDraftSurfaceIds(value: string | null | undefined): string[] {
  const parsed = JSON.parse(value ?? "[]") as unknown;
  if (!Array.isArray(parsed) || parsed.some(id => typeof id !== "string" || !id) ||
      new Set(parsed).size !== parsed.length) {
    throw new Error("invalid Project deletion draft surface inventory");
  }
  return parsed;
}

function projectDeletionReceipt(row: typeof projectDeletionReceipts.$inferSelect): ProjectDeletionReceipt {
  return {
    projectId: row.projectId,
    productScope:row.productScope as ProjectDeletionReceipt['productScope'],
    tombstoneName: row.tombstoneName,
    ...(row.ownershipToken ? { ownershipToken: row.ownershipToken } : {}),
    removalStarted: row.removalStarted === 1,
    storageCleanupCompleted: row.storageCleanupCompleted === 1,
    draftSurfaceIds: parseDraftSurfaceIds(row.draftSurfacesJson),
    draftCleanupCompleted: row.draftCleanupCompleted === 1,
    assetAuthorityCleanupCompleted: row.assetAuthorityCleanupCompleted === 1,
    ...(row.lastError ? { lastError: row.lastError } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
  };
}

export class AgentProjectDeletionAuthority {
  constructor(
    private readonly dataDir: string,
    private readonly db: Db,
    private readonly client: Database.Database,
    private readonly getProject: (projectId: string) => ProjectDto | undefined,
    private readonly listAgents: (projectId: string) => AgentDto[],
    private readonly clearProjectCaches: (projectId: string, agentIds: string[]) => void,
  ) {}

  private draftSurfaceIds(projectId: string): string[] {
    const chats = this.client.prepare("SELECT id FROM conversations WHERE project_id = ? ORDER BY id")
      .all(projectId) as Array<{ id: string }>;
    const agentIds = this.client.prepare("SELECT id FROM agents WHERE project_id = ? ORDER BY id")
      .all(projectId) as Array<{ id: string }>;
    return [
      ...chats.flatMap(({ id }) => [id, `collaboration:${id}`]),
      ...agentIds.map(({ id }) => `agent:${id}`),
    ];
  }

  markProjectDeletionPending(projectId: string, now = new Date().toISOString()): string[] {
    if (!this.getProject(projectId)) throw new Error("project not found");
    const draftSurfaceIds = this.draftSurfaceIds(projectId);
    this.db.insert(projectDeletionPending).values({
      projectId,
      createdAt: now,
      ownershipToken: randomUUID(),
      draftSurfacesJson: JSON.stringify(draftSurfaceIds),
    })
      .onConflictDoNothing({ target: projectDeletionPending.projectId }).run();
    const pending = this.db.select().from(projectDeletionPending)
      .where(eq(projectDeletionPending.projectId, projectId)).get();
    return parseDraftSurfaceIds(pending?.draftSurfacesJson);
  }

  recordProjectDeletionCleanupError(projectId: string, error: string): void {
    this.db.update(projectDeletionPending).set({ lastError: error.slice(0, 4_000) })
      .where(eq(projectDeletionPending.projectId, projectId)).run();
  }

  listPendingProjectDeletions(): Array<{ projectId: string; draftSurfaceIds: string[]; createdAt: string; lastError?: string }> {
    return this.db.select().from(projectDeletionPending).all().map((row) => ({
      projectId: row.projectId,
      draftSurfaceIds: parseDraftSurfaceIds(row.draftSurfacesJson),
      createdAt: row.createdAt,
      ...(row.lastError ? { lastError: row.lastError } : {}),
    }));
  }

  getProjectDeletionReceipt(projectId: string): ProjectDeletionReceipt | undefined {
    const row = this.db.select().from(projectDeletionReceipts)
      .where(eq(projectDeletionReceipts.projectId, projectId)).get();
    return row ? projectDeletionReceipt(row) : undefined;
  }

  listProjectDeletionReceipts(): ProjectDeletionReceipt[] {
    return this.db.select().from(projectDeletionReceipts).all().map(projectDeletionReceipt);
  }

  listPendingProjectDeletionReceipts(): ProjectDeletionReceipt[] {
    return this.db.select().from(projectDeletionReceipts).all()
      .filter(row => row.storageCleanupCompleted === 0 || row.draftCleanupCompleted === 0 ||
        row.assetAuthorityCleanupCompleted === 0)
      .map(projectDeletionReceipt);
  }

  recordProjectDeletionReceiptCleanupError(projectId: string, error: string): void {
    this.db.update(projectDeletionReceipts).set({
      lastError: error.slice(0, 4_000),
      updatedAt: new Date().toISOString(),
    }).where(eq(projectDeletionReceipts.projectId, projectId)).run();
  }

  markProjectDeletionDraftCleanupComplete(projectId: string): void {
    const current = this.getProjectDeletionReceipt(projectId);
    if (!current) throw new Error("Project deletion receipt not found");
    if (current.draftCleanupCompleted) return;
    const now = new Date().toISOString();
    this.db.update(projectDeletionReceipts).set({
      draftCleanupCompleted: 1,
      lastError: null,
      updatedAt: now,
      ...(current.storageCleanupCompleted && current.assetAuthorityCleanupCompleted
        ? { completedAt: now }
        : {}),
    }).where(eq(projectDeletionReceipts.projectId, projectId)).run();
  }

  finishProjectDeletionStorageCleanup(
    receipt: ProjectDeletionReceipt,
    afterTombstoneRemoval?: (projectId: string) => void,
  ): void {
    const current = this.getProjectDeletionReceipt(receipt.projectId);
    if (!current) throw new Error("Project deletion receipt not found");
    if (current.storageCleanupCompleted) return;
    const prefix = `.${current.projectId}.deleting-`;
    if (current.tombstoneName.includes("/") || current.tombstoneName.includes("\\") ||
        !current.tombstoneName.startsWith(prefix)) {
      throw new Error("invalid Project deletion receipt");
    }
    if (!current.ownershipToken) {
      throw new Error("Project deletion receipt has no durable tombstone ownership identity");
    }
    const root = projectsDir(this.dataDir);
    const canonical = projectDir(this.dataDir, current.projectId);
    if (pathEntryExists(canonical)) throw new Error("committed Project deletion storage was resurrected");
    const tombstone = join(root, current.tombstoneName);
    const identity = {
      version: 1,
      projectId: current.projectId,
      tombstoneName: current.tombstoneName,
      ownershipToken: current.ownershipToken,
    } satisfies ProjectDeletionIdentity;
    if (!current.removalStarted) {
      if (!pathEntryExists(tombstone)) {
        throw new Error("Project deletion tombstone is missing before durable removal authority");
      }
      validateProjectDeletionTombstone(tombstone, identity);
      this.db.update(projectDeletionReceipts).set({
        removalStarted: 1,
        updatedAt: new Date().toISOString(),
      }).where(eq(projectDeletionReceipts.projectId, current.projectId)).run();
    }
    if (pathEntryExists(tombstone)) {
      // Revalidate after the removal-started commit. A replacement at the exact
      // path must never inherit the authority granted to the earlier inode.
      validateProjectDeletionTombstone(tombstone, identity);
      rmSync(tombstone, { recursive: true, force: true });
      afterTombstoneRemoval?.(current.projectId);
    }
    // Missing storage is success only after removal_started durably proves that
    // this exact receipt previously crossed the destructive boundary.
    fsyncDirectory(root);
    const now = new Date().toISOString();
    this.db.update(projectDeletionReceipts).set({
      storageCleanupCompleted: 1,
      removalStarted: 1,
      lastError: null,
      updatedAt: now,
      ...(current.draftCleanupCompleted && current.assetAuthorityCleanupCompleted
        ? { completedAt: now }
        : {}),
    }).where(eq(projectDeletionReceipts.projectId, current.projectId)).run();
  }

  markProjectDeletionAssetAuthorityCleanupComplete(projectId: string): void {
    const current = this.getProjectDeletionReceipt(projectId);
    if (!current) throw new Error("Project deletion receipt not found");
    if (current.assetAuthorityCleanupCompleted) return;
    if (!current.storageCleanupCompleted || !current.draftCleanupCompleted) {
      throw new Error("Project storage and draft cleanup must finish before asset authority cleanup");
    }
    const now = new Date().toISOString();
    this.db.update(projectDeletionReceipts).set({
      assetAuthorityCleanupCompleted: 1,
      lastError: null,
      updatedAt: now,
      completedAt: now,
    }).where(eq(projectDeletionReceipts.projectId, projectId)).run();
  }

  /** Commit the irreversible SQLite purge and its durable receipt. Fallible
   * tombstone removal is deliberately a separate retryable operation. */
  commitProjectDeletion(id: string, beforeProjectionDelete?: (projectId: string) => void): ProjectDeletionReceipt | undefined {
    const priorReceipt = this.getProjectDeletionReceipt(id);
    if (priorReceipt) return priorReceipt;
    const current = this.getProject(id);
    if (!current) return undefined;
    const agentIds = this.listAgents(id).map((agent) => agent.id);
    const canonicalDir = projectDir(this.dataDir, id);
    this.markProjectDeletionPending(id);
    const pending = this.db.select().from(projectDeletionPending)
      .where(eq(projectDeletionPending.projectId, id)).get();
    const tombstoneName = pending?.tombstoneName ?? `.${id}.deleting-${randomUUID()}`;
    const ownershipToken = pending?.ownershipToken ?? randomUUID();
    const draftSurfaceIds = parseDraftSurfaceIds(pending?.draftSurfacesJson);
    if (tombstoneName.includes("/") || tombstoneName.includes("\\") ||
        !tombstoneName.startsWith(`.${id}.deleting-`)) {
      throw new Error("invalid Project deletion recovery journal");
    }
    this.db.update(projectDeletionPending).set({ tombstoneName, ownershipToken })
      .where(eq(projectDeletionPending.projectId, id)).run();
    const parentDir = dirname(canonicalDir);
    const deletingDir = join(parentDir, tombstoneName);
    writeJson(join(canonicalDir, PROJECT_DELETION_IDENTITY_FILE), {
      version: 1,
      projectId: id,
      tombstoneName,
      ownershipToken,
    } satisfies ProjectDeletionIdentity);
    renameSync(canonicalDir, deletingDir);
    fsyncDirectory(parentDir);
    const now = new Date().toISOString();
    try {
      this.db.transaction(() => {
        const pendingConversationDeletion = this.client.prepare(`
          SELECT 1 FROM conversation_deletion_receipts
          WHERE project_id = ? AND (
            canonical_deletion_completed != 1 OR
            storage_cleanup_completed != 1 OR
            server_cleanup_completed != 1
          ) LIMIT 1
        `).get(id);
        if (pendingConversationDeletion) {
          throw new Error("Project deletion cannot commit while Chat deletion cleanup is pending");
        }
        const pendingAgentDeletion = this.client.prepare(`
          SELECT 1 FROM agent_deletion_pending WHERE project_id = ?
          UNION ALL
          SELECT 1 FROM agent_deletion_receipts
          WHERE project_id = ? AND (
            storage_cleanup_completed != 1 OR server_cleanup_completed != 1
          )
          LIMIT 1
        `).get(id, id);
        if (pendingAgentDeletion) {
          throw new Error("Project deletion cannot commit while Agent deletion cleanup is pending");
        }
        const products=this.client.prepare(`SELECT DISTINCT CASE WHEN branch_id IS NULL THEN 'dev' ELSE 'branches' END product
          FROM (SELECT branch_id FROM conversations WHERE project_id=? UNION ALL SELECT branch_id FROM conversation_deletion_receipts WHERE project_id=?)`).all(id,id) as Array<{product:'dev'|'branches'}>;
        const productScope:ProjectDeletionReceipt['productScope']=products.length>1?'mixed':products[0]?.product??'dev';
        beforeProjectionDelete?.(id);
        this.client.prepare(`DELETE FROM events WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`)
          .run(id);
        this.client.prepare(`DELETE FROM artifacts WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`)
          .run(id);
        this.client.prepare(`DELETE FROM work_items WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`)
          .run(id);
        this.client.prepare(`DELETE FROM runs WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`)
          .run(id);
        this.client.prepare(`DELETE FROM provider_inputs WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM messages WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`)
          .run(id);
        this.client.prepare(`DELETE FROM imported_history_messages WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`)
          .run(id);
        this.client.prepare(`DELETE FROM imported_history_indexes WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`)
          .run(id);
        this.client.prepare(`DELETE FROM agent_conversation_memberships WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`)
          .run(id);
        this.client.prepare(`DELETE FROM agent_presets WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM agent_management_approvals WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM agent_management_plans WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM agent_deletion_pending WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM project_deletion_pending WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM agent_deletion_tombstones WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM agent_deletion_receipts WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM all_chat_feed_projection WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM chat_search_messages WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM compaction_history_fts WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM compaction_history_agent_participants WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM compaction_history_relation_candidates WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM compaction_history_messages WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM managed_artifact_projection WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM conversations WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM agents WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
        this.db.insert(projectDeletionReceipts).values({
          projectId: id,
          productScope,
          tombstoneName,
          ownershipToken,
          storageCleanupCompleted: 0,
          draftSurfacesJson: JSON.stringify(draftSurfaceIds),
          draftCleanupCompleted: 0,
          assetAuthorityCleanupCompleted: 0,
          createdAt: now,
          updatedAt: now,
        }).run();
      });
    } catch (error) {
      renameSync(deletingDir, canonicalDir);
      fsyncDirectory(parentDir);
      throw error;
    }
    this.clearProjectCaches(id, agentIds);
    return this.getProjectDeletionReceipt(id)!;
  }

  /** Permanently remove the canonical project tree and every rebuildable
   * projection. The callback shares the projection-deletion transaction so
   * authoritative runtime state cannot survive a deleted Project row. */
  deleteProject(id: string, beforeProjectionDelete?: (projectId: string) => void): boolean {
    const receipt = this.commitProjectDeletion(id, beforeProjectionDelete);
    if (!receipt) return false;
    try { this.finishProjectDeletionStorageCleanup(receipt); }
    catch (error) {
      this.recordProjectDeletionReceiptCleanupError(id, error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  recoverProjectDeletionDirectories(): void {
    const root = projectsDir(this.dataDir);
    if (!existsSync(root)) return;
    const pending = this.db.select().from(projectDeletionPending).all();
    for (const row of pending) {
      const prefix = `.${row.projectId}.deleting-`;
      const tombstoneName = row.tombstoneName ?? undefined;
      if (tombstoneName && (tombstoneName.includes("/") || tombstoneName.includes("\\") ||
          !tombstoneName.startsWith(prefix))) {
        throw new Error("invalid Project deletion recovery journal");
      }
      const canonical = projectDir(this.dataDir, row.projectId);
      if (pathEntryExists(canonical)) {
        if (tombstoneName && pathEntryExists(join(root, tombstoneName))) {
          throw new Error(`Project ${row.projectId} has ambiguous deletion storage`);
        }
        continue;
      }
      if (!tombstoneName || !row.ownershipToken || !pathEntryExists(join(root, tombstoneName))) {
        throw new Error(`Project ${row.projectId} deletion quarantine has no recoverable canonical storage`);
      }
      const tombstone = join(root, tombstoneName);
      validateProjectDeletionTombstone(tombstone, {
        version: 1,
        projectId: row.projectId,
        tombstoneName,
        ownershipToken: row.ownershipToken,
      });
      renameSync(tombstone, canonical);
      fsyncDirectory(root);
    }
    for (const receipt of this.db.select().from(projectDeletionReceipts).all()) {
      if (receipt.storageCleanupCompleted === 1) continue;
      try { this.finishProjectDeletionStorageCleanup(this.getProjectDeletionReceipt(receipt.projectId)!); }
      catch (error) {
        this.recordProjectDeletionReceiptCleanupError(
          receipt.projectId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

}
