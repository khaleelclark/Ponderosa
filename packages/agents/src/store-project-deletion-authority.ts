import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import type { AgentDto, ProjectDto } from "@ponderosa/core";
import type { Db } from "./db.js";
import { fsyncDirectory, readJson, writeJson } from "./store-filesystem.js";
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

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function validateProjectDeletionTombstone(
  tombstone: string,
  expected: ProjectDeletionIdentity,
): void {
  const expectedRoot = resolve(tombstone);
  const canonicalExpectedRoot = join(realpathSync(dirname(expectedRoot)), basename(expectedRoot));
  const before = lstatSync(expectedRoot);
  if (!before.isDirectory() || before.isSymbolicLink() ||
      relative(realpathSync(expectedRoot), canonicalExpectedRoot) !== "") {
    throw new Error("Project deletion tombstone is not the owned directory");
  }
  const markerPath = join(expectedRoot, PROJECT_DELETION_IDENTITY_FILE);
  let markerStat;
  try { markerStat = lstatSync(markerPath); }
  catch (error) {
    throw new Error("Project deletion tombstone has no readable ownership marker", { cause: error });
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error("Project deletion tombstone has no regular ownership marker");
  }
  let marker: Partial<ProjectDeletionIdentity>;
  try { marker = readJson<Partial<ProjectDeletionIdentity>>(markerPath); }
  catch (error) {
    throw new Error("Project deletion tombstone ownership marker is invalid", { cause: error });
  }
  if (marker.version !== 1 || marker.projectId !== expected.projectId ||
      marker.tombstoneName !== expected.tombstoneName ||
      marker.ownershipToken !== expected.ownershipToken) {
    throw new Error("Project deletion tombstone ownership identity does not match its receipt");
  }
  // Recheck the directory after reading its marker so a replaced path never
  // reaches the recursive remove on the strength of an earlier observation.
  const current = lstatSync(expectedRoot);
  if (!current.isDirectory() || current.isSymbolicLink() ||
      current.dev !== before.dev || current.ino !== before.ino) {
    throw new Error("Project deletion tombstone changed during ownership validation");
  }
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

  markProjectDeletionPending(projectId: string, now = new Date().toISOString()): void {
    if (!this.getProject(projectId)) throw new Error("project not found");
    this.db.insert(projectDeletionPending).values({
      projectId,
      createdAt: now,
      ownershipToken: randomUUID(),
    })
      .onConflictDoNothing({ target: projectDeletionPending.projectId }).run();
  }

  recordProjectDeletionCleanupError(projectId: string, error: string): void {
    this.db.update(projectDeletionPending).set({ lastError: error.slice(0, 4_000) })
      .where(eq(projectDeletionPending.projectId, projectId)).run();
  }

  listPendingProjectDeletions(): Array<{ projectId: string; createdAt: string; lastError?: string }> {
    return this.db.select().from(projectDeletionPending).all().map((row) => ({
      projectId: row.projectId,
      createdAt: row.createdAt,
      ...(row.lastError ? { lastError: row.lastError } : {}),
    }));
  }

  getProjectDeletionReceipt(projectId: string): ProjectDeletionReceipt | undefined {
    const row = this.db.select().from(projectDeletionReceipts)
      .where(eq(projectDeletionReceipts.projectId, projectId)).get();
    return row ? {
      projectId: row.projectId,
      tombstoneName: row.tombstoneName,
      ...(row.ownershipToken ? { ownershipToken: row.ownershipToken } : {}),
      storageCleanupCompleted: row.storageCleanupCompleted === 1,
      ...(row.lastError ? { lastError: row.lastError } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    } : undefined;
  }

  listProjectDeletionReceipts(): ProjectDeletionReceipt[] {
    return this.db.select().from(projectDeletionReceipts).all().map((row) => ({
      projectId: row.projectId,
      tombstoneName: row.tombstoneName,
      ...(row.ownershipToken ? { ownershipToken: row.ownershipToken } : {}),
      storageCleanupCompleted: row.storageCleanupCompleted === 1,
      ...(row.lastError ? { lastError: row.lastError } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    }));
  }

  listPendingProjectDeletionReceipts(): ProjectDeletionReceipt[] {
    return this.db.select().from(projectDeletionReceipts)
      .where(eq(projectDeletionReceipts.storageCleanupCompleted, 0)).all()
      .map((row) => ({
        projectId: row.projectId,
        tombstoneName: row.tombstoneName,
        ...(row.ownershipToken ? { ownershipToken: row.ownershipToken } : {}),
        storageCleanupCompleted: false,
        ...(row.lastError ? { lastError: row.lastError } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.completedAt ? { completedAt: row.completedAt } : {}),
      }));
  }

  recordProjectDeletionReceiptCleanupError(projectId: string, error: string): void {
    this.db.update(projectDeletionReceipts).set({
      lastError: error.slice(0, 4_000),
      updatedAt: new Date().toISOString(),
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
    if (!pathEntryExists(tombstone)) {
      throw new Error("Project deletion tombstone is missing; cleanup was preserved as pending");
    }
    validateProjectDeletionTombstone(tombstone, {
      version: 1,
      projectId: current.projectId,
      tombstoneName: current.tombstoneName,
      ownershipToken: current.ownershipToken,
    });
    rmSync(tombstone, { recursive: true, force: true });
    afterTombstoneRemoval?.(current.projectId);
    fsyncDirectory(root);
    const now = new Date().toISOString();
    this.db.update(projectDeletionReceipts).set({
      storageCleanupCompleted: 1,
      lastError: null,
      updatedAt: now,
      completedAt: now,
    }).where(eq(projectDeletionReceipts.projectId, current.projectId)).run();
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
        this.client.prepare(`DELETE FROM agent_conversation_memberships WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)`)
          .run(id);
        this.client.prepare(`DELETE FROM agent_presets WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM agent_management_approvals WHERE project_id = ?`).run(id);
        this.client.prepare(`DELETE FROM agent_management_plans WHERE project_id = ?`).run(id);
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
          tombstoneName,
          ownershipToken,
          storageCleanupCompleted: 0,
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
