import { createHash, randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import type { AgentDeletionPreviewDto, AgentDto, CommunicationEvent, CommunicationProjection } from "@ponderosa/core";
import { retainAgentChatAttachments } from "./chat-attachment-retention.js";
import type { Db } from "./db.js";
import { AgentDeletionConflictError } from "./store-agent-management.js";
import { pathEntryExists } from "./deletion-tombstone-ownership.js";
import { fsyncDirectory, readJson, writeJson } from "./store-filesystem.js";
import type { AgentDeletionReceipt, AgentJson, AgentManagementAuthorization } from "./store-types.js";
import {
  agentConversationMemberships,
  agentDeletionPending,
  agentDeletionReceipts,
  agentDeletionTombstones,
  agents,
} from "./schema.js";
import { agentDir, agentsDir } from "./paths.js";
import {
  AGENT_DELETION_IDENTITY_FILE,
  agentDeletionIdentity,
  type AgentDeletionDirectoryIdentity,
  validateAgentDeletionDirectory,
  validateAgentDeletionName,
} from "./agent-deletion-identity.js";

type AgentDeletionDirectoryRow = AgentDeletionDirectoryIdentity;

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
      consumeApproval?: boolean,
    ) => void,
    private readonly refreshAllChatFeedProject: (projectId: string) => void,
    private readonly forgetAgentProjection: (agentId: string) => void,
    private readonly attachmentSources: (projectId: string) => { events: CommunicationEvent[]; projections: CommunicationProjection[] },
  ) {}

  getAgentDeletionReceiptByPreviewHash(previewHash: string): AgentDeletionReceipt | undefined {
    const row = this.client.prepare(`SELECT * FROM agent_deletion_receipts WHERE preview_hash = ?`).get(previewHash) as {
      id: string; project_id: string; product_scope: AgentDeletionReceipt["productScope"]; preview_hash: string; root_agent_ids_json: string;
      deleted_agent_ids_json: string; storage_cleanup_completed: number; server_cleanup_completed: number;
      last_error: string | null; created_at: string; updated_at: string; completed_at: string | null;
    } | undefined;
    return row ? {
      id: row.id,
      projectId: row.project_id,
      productScope: row.product_scope,
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
    for (const root of roots) {
      if (!projectAgents.some((agent) => agent.id === root!.id)) projectAgents.push(root!);
    }
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
      const manager = byId.get(agent.managerAgentId);
      if (!manager || manager.conversationId !== agent.conversationId) {
        throw new Error("cross-Chat Agent management must be repaired before deletion");
      }
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
    const initial = this.previewAgentDeletion(rootAgentIds);
    if (initial.previewHash !== expectedPreviewHash) throw new AgentDeletionConflictError(initial);
    if (authorization) {
      // Preflight without consuming a one-shot approval. Consumption remains in
      // the irreversible projection transaction below.
      this.client.transaction(() => this.authorizeAgentManagementPlan(
        authorization,
        initial.affectedAgents.map((agent) => agent.id),
        false,
      ))();
    }
    const createdAt = new Date().toISOString();
    const stagedDirectories = new Map<string, AgentDeletionDirectoryRow & {
      canonical: string;
      tombstone: string;
      renamed: boolean;
    }>();
    for (const affected of initial.affectedAgents) {
      const agent = this.getAgent(affected.id);
      if (!agent || agent.projectId !== initial.projectId) throw new AgentDeletionConflictError(initial);
      const tombstoneName = `.${agent.id}.deleting-${randomUUID()}`;
      const row: AgentDeletionDirectoryRow = {
        agentId: agent.id,
        projectId: agent.projectId,
        conversationId: agent.conversationId ?? null,
        tombstoneName,
        ownershipToken: randomUUID(),
        createdAt,
      };
      const canonical = agentDir(this.dataDir, row.projectId, row.agentId);
      writeJson(join(canonical, AGENT_DELETION_IDENTITY_FILE), agentDeletionIdentity(row));
      stagedDirectories.set(row.agentId, {
        ...row,
        canonical,
        tombstone: join(agentsDir(this.dataDir, row.projectId), row.tombstoneName),
        renamed: false,
      });
    }
    // This journal commits before the first rename. A process crash at any
    // subsequent point therefore restores only exact marker/token matches.
    this.client.transaction(() => {
      for (const row of stagedDirectories.values()) {
        this.db.insert(agentDeletionPending).values({
          agentId: row.agentId,
          projectId: row.projectId,
          conversationId: row.conversationId,
          tombstoneName: row.tombstoneName,
          ownershipToken: row.ownershipToken,
          createdAt: row.createdAt,
        }).run();
      }
    })();
    let committedPreview: AgentDeletionPreviewDto | undefined;
    try {
      for (const row of stagedDirectories.values()) {
        validateAgentDeletionDirectory(row.canonical, row);
        renameSync(row.canonical, row.tombstone);
        row.renamed = true;
      }
      fsyncDirectory(agentsDir(this.dataDir, initial.projectId));
      this.db.transaction((tx) => {
        const current = this.previewAgentDeletion(rootAgentIds);
        if (current.previewHash !== expectedPreviewHash) throw new AgentDeletionConflictError(current);
        if (authorization) {
          this.authorizeAgentManagementPlan(authorization, current.affectedAgents.map((agent) => agent.id));
        }
        committedPreview = current;
        const ownershipScopes = new Set((this.client.prepare(`
          SELECT CASE WHEN chat.branch_id IS NULL THEN 'dev' ELSE 'branches' END productScope
          FROM agents agent JOIN conversations chat ON chat.id=agent.conversation_id
          WHERE agent.id IN (${current.affectedAgents.map(() => "?").join(",")})
        `).all(...current.affectedAgents.map(agent => agent.id)) as Array<{productScope:"dev"|"branches"}>).map(row=>row.productScope));
        const productScope: AgentDeletionReceipt["productScope"] = ownershipScopes.size===1
          ? [...ownershipScopes][0]!
          : "mixed";
        const receiptId = `agent-deletion-${current.previewHash}`;
        tx.insert(agentDeletionReceipts).values({
          id: receiptId,
          projectId: current.projectId,
          productScope,
          previewHash: current.previewHash,
          rootAgentIdsJson: JSON.stringify(current.rootAgentIds),
          deletedAgentIdsJson: JSON.stringify(current.affectedAgents.map((agent) => agent.id)),
          storageCleanupCompleted: 0,
          serverCleanupCompleted: 0,
          createdAt,
          updatedAt: createdAt,
        }).run();
        for (const row of stagedDirectories.values()) {
          const pending = this.client.prepare(`
            SELECT project_id, conversation_id, tombstone_name, ownership_token, created_at
            FROM agent_deletion_pending WHERE agent_id = ?
          `).get(row.agentId) as {
            project_id: string; conversation_id: string | null; tombstone_name: string;
            ownership_token: string; created_at: string;
          } | undefined;
          if (!pending || pending.project_id !== row.projectId ||
              pending.conversation_id !== row.conversationId ||
              pending.tombstone_name !== row.tombstoneName ||
              pending.ownership_token !== row.ownershipToken || pending.created_at !== row.createdAt) {
            throw new Error("Agent deletion pending ownership changed before commit");
          }
          tx.insert(agentDeletionTombstones).values({
            agentId: row.agentId,
            projectId: row.projectId,
            conversationId: row.conversationId,
            tombstoneName: row.tombstoneName,
            ownershipToken: row.ownershipToken,
            createdAt: row.createdAt,
          }).run();
          tx.delete(agentDeletionPending).where(eq(agentDeletionPending.agentId, row.agentId)).run();
        }
        // Coordination V3 shares this SQLite connection. Its nested
        // transactions become savepoints, so all scheduler outcomes and every
        // selected Agent authority fence commit or roll back as one unit.
        for (const agent of current.affectedAgents) beforeProjectionDelete?.(agent.id);
        for (const agent of current.affectedAgents) {
          this.client.prepare("DELETE FROM pinecone_profiles WHERE agent_id = ?").run(agent.id);
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
      for (const row of [...stagedDirectories.values()].reverse()) {
        if (!row.renamed) continue;
        if (pathEntryExists(row.canonical)) {
          throw new Error("Agent deletion rollback found an ambiguous canonical directory", { cause: error });
        }
        if (!pathEntryExists(row.tombstone)) {
          throw new Error("Agent deletion rollback lost its owned tombstone", { cause: error });
        }
        validateAgentDeletionDirectory(row.tombstone, row);
        renameSync(row.tombstone, row.canonical);
      }
      for (const directory of new Set([...stagedDirectories.values()].map(({ canonical }) => dirname(canonical)))) {
        if (existsSync(directory)) fsyncDirectory(directory);
      }
      this.client.transaction(() => {
        for (const row of stagedDirectories.values()) {
          validateAgentDeletionDirectory(row.canonical, row);
          this.db.delete(agentDeletionPending).where(eq(agentDeletionPending.agentId, row.agentId)).run();
        }
      })();
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

  finishAgentDeletionStorageCleanup(
    receipt: AgentDeletionReceipt,
    afterAuditRename?: (agentId: string) => void,
  ): void {
    const currentReceipt = this.getAgentDeletionReceiptByPreviewHash(receipt.previewHash);
    if (!currentReceipt) throw new Error("Agent deletion receipt not found");
    if (currentReceipt.storageCleanupCompleted) return;
    const touchedDirectories = new Set<string>();
    for (const agentId of currentReceipt.deletedAgentIds) {
      const row = this.client.prepare(`
        SELECT agent_id, project_id, conversation_id, tombstone_name, ownership_token, created_at
        FROM agent_deletion_tombstones WHERE agent_id = ?
      `).get(agentId) as {
        agent_id: string; project_id: string; conversation_id: string | null;
        tombstone_name: string; ownership_token: string | null; created_at: string;
      } | undefined;
      if (!row?.ownership_token) throw new Error("Agent deletion receipt lost its owned tombstone phase");
      const owned: AgentDeletionDirectoryRow = {
        agentId: row.agent_id,
        projectId: row.project_id,
        conversationId: row.conversation_id,
        tombstoneName: row.tombstone_name,
        ownershipToken: row.ownership_token,
        createdAt: row.created_at,
      };
      const directory = agentsDir(this.dataDir, owned.projectId);
      const tombstone = join(directory, owned.tombstoneName);
      const canonical = agentDir(this.dataDir, owned.projectId, agentId);
      const hasTombstone = pathEntryExists(tombstone);
      const hasCanonical = pathEntryExists(canonical);
      if (hasTombstone === hasCanonical) {
        throw new Error(hasTombstone
          ? "Agent deletion storage is ambiguous"
          : "committed Agent deletion lost its audit directory");
      }
      const auditDirectory = hasTombstone ? tombstone : canonical;
      validateAgentDeletionDirectory(auditDirectory, owned);
      retainAgentChatAttachments({
        dataDir: this.dataDir, projectId: owned.projectId, agentId,
        sourceDirectory: `projects/${owned.projectId}/agents/${hasTombstone ? owned.tombstoneName : agentId}/attachments`,
        ...this.attachmentSources(owned.projectId),
        chatExists: id => Boolean(this.client.prepare("SELECT 1 FROM conversations WHERE id=? AND project_id=?").get(id, owned.projectId)),
      });
      // Upload staging and attachment capability state are live authority,
      // not deletion-surviving execution audit.
      rmSync(join(auditDirectory, "attachments"), { recursive: true, force: true });
      const metadataPath = join(auditDirectory, "agent.json");
      const metadata = readJson<AgentJson>(metadataPath);
      writeJson(metadataPath, {
        ...metadata,
        conversationId: undefined,
        archived: true,
        deletedAt: owned.createdAt,
        updatedAt: owned.createdAt,
        managementPermissions: {
          allowAutomaticDescendantDeletion: false,
          allowAutomaticDescendantReorganization: false,
        },
      });
      if (hasTombstone) {
        validateAgentDeletionDirectory(tombstone, owned);
        if (pathEntryExists(canonical)) throw new Error("deleted Agent audit destination already exists");
        renameSync(tombstone, canonical);
        afterAuditRename?.(agentId);
      }
      touchedDirectories.add(directory);
      this.forgetAgentProjection(agentId);
    }
    for (const directory of touchedDirectories) if (existsSync(directory)) fsyncDirectory(directory);
    this.db.transaction((tx) => {
      const now = new Date().toISOString();
      tx.update(agentDeletionReceipts).set({
        storageCleanupCompleted: 1,
        lastError: null,
        updatedAt: now,
        completedAt: currentReceipt.serverCleanupCompleted ? now : null,
      }).where(eq(agentDeletionReceipts.id, currentReceipt.id)).run();
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
    const touchedDirectories = new Set<string>();
    const pending = this.db.select().from(agentDeletionPending).all();
    for (const row of pending) {
      const owned: AgentDeletionDirectoryRow = { ...row };
      validateAgentDeletionName(owned);
      const directory = agentsDir(this.dataDir, owned.projectId);
      const tombstone = join(directory, owned.tombstoneName);
      const canonical = agentDir(this.dataDir, owned.projectId, owned.agentId);
      const hasTombstone = pathEntryExists(tombstone);
      const hasCanonical = pathEntryExists(canonical);
      if (hasTombstone === hasCanonical) {
        throw new Error(hasTombstone
          ? "pending Agent deletion storage is ambiguous"
          : "pending Agent deletion has no recoverable canonical storage");
      }
      if (hasTombstone) {
        validateAgentDeletionDirectory(tombstone, owned);
        renameSync(tombstone, canonical);
        fsyncDirectory(directory);
      } else {
        // The journal may have committed immediately before the first rename.
        validateAgentDeletionDirectory(canonical, owned);
      }
      touchedDirectories.add(directory);
    }
    // Unknown deletion-shaped entries are deliberately not enumerated. A name
    // without an exact durable journal and marker never grants mutation authority.
    for (const row of pending) {
      this.db.delete(agentDeletionPending).where(eq(agentDeletionPending.agentId, row.agentId)).run();
    }
    for (const directory of touchedDirectories) fsyncDirectory(directory);
    // Drive each committed receipt through the same exact-member validator as
    // an ordinary retry. A missing per-Agent phase must fail closed rather than
    // being hidden by a blanket "all receipts complete" update.
    for (const receipt of this.listPendingAgentDeletionReceipts()) {
      if (!receipt.storageCleanupCompleted) {
        try { this.finishAgentDeletionStorageCleanup(receipt); }
        catch (error) { this.recordAgentDeletionCleanupError(receipt.id, error instanceof Error ? error.message : "Attachment retention cleanup failed"); }
      }
    }
  }

}
