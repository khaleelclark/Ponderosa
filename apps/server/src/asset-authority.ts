import { admitDataDirectory, type StateAdmission } from "@ponderosa/agents";
import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from "@ponderosa/native-host/fs";
import type Database from "better-sqlite3";
import { listSecureDirectory, readSecureFile, writeSecureFileAtomic } from "@ponderosa/native-host";
import {
  ASSET_LIMITS,
  DRAFT_ASSET_LIMITS,
  OWNER_ID,
  UPLOAD_LEASE_MS,
  RUNTIME_UUID,
  AssetError,
  generatedArtifactIdentity,
  generatedArtifactMetadataIsValid,
  runtimeArtifactIdentityMatches,
  type GeneratedArtifactImportReceipt,
  type RegisteredGeneratedArtifact,
  type RegisteredRuntimeArtifact,
  type RuntimeAttachmentAssociation,
} from "./asset-contracts.js";

export class AssetAuthority {
  private readonly admission: StateAdmission;
  private get db(): Database.Database { return this.admission.client; }
  constructor(dataDir: string) {
    this.admission = admitDataDirectory(dataDir);
  }
  private now(): number { return (this.db.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) now").get() as { now: number }).now; }
  private mapped(error: unknown): AssetError {
    if (error instanceof AssetError) return error;
    const code = (error as { code?: string })?.code ?? "";
    if (code.includes("BUSY") || code.includes("LOCKED")) return new AssetError(503, "asset authority is busy");
    if (code.includes("CORRUPT") || code.includes("NOTADB")) return new AssetError(409, "asset authority is corrupt");
    return new AssetError(409, `asset authority unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  reserve(projectId: string, agentId: string, assetId: string, size: number): string {
    const id = randomUUID();
    try {
      return this.db.transaction(() => {
        const now = this.now();
        this.db.prepare("DELETE FROM asset_reservations WHERE created_at <= ?").run(now - UPLOAD_LEASE_MS);
        this.db.prepare("DELETE FROM asset_rate_events WHERE created_at <= ?").run(now - 60_000);
        const active = (this.db.prepare("SELECT count(*) count, coalesce(sum(size),0) bytes FROM asset_reservations WHERE project_id=? AND agent_id=?").get(projectId, agentId) as { count: number; bytes: number });
        const committed = (this.db.prepare("SELECT coalesce(sum(size),0) bytes FROM asset_committed WHERE project_id=? AND agent_id=?").get(projectId, agentId) as { bytes: number }).bytes;
        const rate = (this.db.prepare("SELECT count(*) count FROM asset_rate_events WHERE project_id=? AND agent_id=?").get(projectId, agentId) as { count: number }).count;
        if (active.count >= 4) throw new AssetError(429, "too many concurrent asset uploads");
        if (rate >= 100) throw new AssetError(429, "asset upload rate limit exceeded");
        if (committed + active.bytes + size > ASSET_LIMITS.maxAgentBytes) throw new AssetError(413, "agent asset quota exceeded");
        this.db.prepare("INSERT INTO asset_reservations VALUES (?,?,?,?,?,?)").run(id, assetId, projectId, agentId, size, now);
        this.db.prepare("INSERT INTO asset_rate_events VALUES (?,?,?,?)").run(id, projectId, agentId, now);
         return id;
      }).immediate();
    } catch (error) { throw this.mapped(error); }
  }
  release(id: string): boolean {
    try { return this.db.prepare("DELETE FROM asset_reservations WHERE id=?").run(id).changes === 1; } catch (error) { throw this.mapped(error); }
  }

  reserveDraftAttachment(
    draftId: string,
    ownerId: string,
    assetId: string,
    size: number,
  ): string {
    if (!draftId || draftId.length > 256 || !OWNER_ID.test(ownerId) ||
        !RUNTIME_UUID.test(assetId) || !Number.isSafeInteger(size) ||
        size < 1 || size > ASSET_LIMITS.maxFileBytes) {
      throw new AssetError(400, "draft upload reservation is invalid");
    }
    const id = randomUUID();
    try {
      return this.db.transaction(() => {
        const now = this.now();
        this.db.prepare("DELETE FROM draft_asset_reservations WHERE created_at <= ?")
          .run(now - UPLOAD_LEASE_MS);
        this.db.prepare("DELETE FROM draft_asset_rate_events WHERE created_at <= ?")
          .run(now - 60_000);
        const surfaceActive = this.db.prepare(`
          SELECT count(*) count, coalesce(sum(size),0) bytes
          FROM draft_asset_reservations WHERE draft_id=?
        `).get(draftId) as { count: number; bytes: number };
        const workspaceActive = this.db.prepare(`
          SELECT count(*) count, coalesce(sum(size),0) bytes
          FROM draft_asset_reservations
        `).get() as { count: number; bytes: number };
        const surfaceCommitted = this.db.prepare(`
          SELECT count(*) count, coalesce(sum(size),0) bytes
          FROM draft_asset_committed WHERE draft_id=?
        `).get(draftId) as { count: number; bytes: number };
        const workspaceCommitted = this.db.prepare(`
          SELECT count(*) count, coalesce(sum(size),0) bytes
          FROM draft_asset_committed
        `).get() as { count: number; bytes: number };
        const surfaceRate = (this.db.prepare(`
          SELECT count(*) count FROM draft_asset_rate_events WHERE draft_id=?
        `).get(draftId) as { count: number }).count;
        const workspaceRate = (this.db.prepare(`
          SELECT count(*) count FROM draft_asset_rate_events
        `).get() as { count: number }).count;
        if (surfaceActive.count >= DRAFT_ASSET_LIMITS.maxConcurrentUploadsPerSurface) {
          throw new AssetError(429, "too many concurrent draft uploads");
        }
        if (surfaceRate >= DRAFT_ASSET_LIMITS.maxUploadsPerMinutePerSurface ||
            workspaceRate >= DRAFT_ASSET_LIMITS.maxUploadsPerMinuteWorkspace) {
          throw new AssetError(429, "draft upload rate limit exceeded");
        }
        if (surfaceCommitted.count + surfaceActive.count >= DRAFT_ASSET_LIMITS.maxSurfaceAssets ||
            workspaceCommitted.count + workspaceActive.count >= DRAFT_ASSET_LIMITS.maxWorkspaceAssets) {
          throw new AssetError(413, "draft asset count limit exceeded");
        }
        if (surfaceCommitted.bytes + surfaceActive.bytes + size > DRAFT_ASSET_LIMITS.maxSurfaceBytes ||
            workspaceCommitted.bytes + workspaceActive.bytes + size > DRAFT_ASSET_LIMITS.maxWorkspaceBytes) {
          throw new AssetError(413, "draft asset quota exceeded");
        }
        this.db.prepare(`
          INSERT INTO draft_asset_reservations(id,asset_id,draft_id,owner_id,size,created_at)
          VALUES (?,?,?,?,?,?)
        `).run(id, assetId, draftId, ownerId, size, now);
        this.db.prepare("INSERT INTO draft_asset_rate_events VALUES (?,?,?)")
          .run(id, draftId, now);
        return id;
      }).immediate();
    } catch (error) {
      throw this.mapped(error);
    }
  }

  releaseDraftAttachment(id: string): boolean {
    try {
      return this.db.prepare("DELETE FROM draft_asset_reservations WHERE id=?")
        .run(id).changes === 1;
    } catch (error) { throw this.mapped(error); }
  }

  syncDraftAttachment(
    draftId: string,
    ownerId: string,
    assetId: string,
    size: number,
  ): void {
    if (!draftId || draftId.length > 256 || !OWNER_ID.test(ownerId) ||
        !RUNTIME_UUID.test(assetId) || !Number.isSafeInteger(size) ||
        size < 1 || size > ASSET_LIMITS.maxFileBytes) {
      throw new AssetError(409, "stored draft attachment identity is invalid");
    }
    try {
      return this.db.transaction(() => {
        const active = this.db.prepare(`
          SELECT draft_id draftId,owner_id ownerId,size
          FROM draft_asset_reservations WHERE asset_id=?
        `).get(assetId) as { draftId: string; ownerId: string; size: number } | undefined;
        const committed = this.db.prepare(`
          SELECT draft_id draftId,owner_id ownerId,size
          FROM draft_asset_committed WHERE asset_id=?
        `).get(assetId) as { draftId: string; ownerId: string; size: number } | undefined;
        for (const existing of [active, committed]) {
          if (existing && (existing.draftId !== draftId || existing.ownerId !== ownerId ||
              existing.size !== size)) {
            throw new AssetError(409, "stored draft attachment conflicts with quota authority");
          }
        }
        this.db.prepare("DELETE FROM draft_asset_reservations WHERE asset_id=?")
          .run(assetId);
        if (!committed) {
          this.db.prepare("INSERT INTO draft_asset_committed VALUES (?,?,?,?)")
            .run(assetId, draftId, ownerId, size);
        }
      }).immediate();
    } catch (error) {
      throw this.mapped(error);
    }
  }

  settleDraftAttachment(id: string): void {
    try {
      return this.db.transaction(() => {
        if (this.db.prepare("SELECT 1 FROM draft_asset_settlements WHERE reservation_id=?").get(id)) {
          return;
        }
        const now = this.now();
        const row = this.db.prepare(`
          SELECT asset_id assetId,draft_id draftId,owner_id ownerId,size,created_at createdAt
          FROM draft_asset_reservations WHERE id=?
        `).get(id) as {
          assetId: string;
          draftId: string;
          ownerId: string;
          size: number;
          createdAt: number;
        } | undefined;
        if (!row || row.createdAt <= now - UPLOAD_LEASE_MS) {
          this.db.prepare("DELETE FROM draft_asset_reservations WHERE id=?").run(id);
          throw new AssetError(409, "draft upload reservation expired");
        }
        const committed = this.db.prepare(`
          SELECT draft_id draftId,owner_id ownerId,size
          FROM draft_asset_committed WHERE asset_id=?
        `).get(row.assetId) as { draftId: string; ownerId: string; size: number } | undefined;
        if (committed && (committed.draftId !== row.draftId ||
            committed.ownerId !== row.ownerId || committed.size !== row.size)) {
          throw new AssetError(409, "draft asset ownership conflicts with committed usage");
        }
        if (!committed) {
          this.db.prepare("INSERT INTO draft_asset_committed VALUES (?,?,?,?)")
            .run(row.assetId, row.draftId, row.ownerId, row.size);
        }
        this.db.prepare("INSERT INTO draft_asset_settlements VALUES (?,?,?,?)")
          .run(id, row.assetId, row.draftId, row.ownerId);
        this.db.prepare("DELETE FROM draft_asset_reservations WHERE id=?").run(id);
      }).immediate();
    } catch (error) {
      throw this.mapped(error);
    }
  }
  settle(id: string): void {
    try {
      return this.db.transaction(() => {
        const prior = this.db.prepare("SELECT 1 FROM asset_settlements WHERE reservation_id=?").get(id);
        if (prior) {  return; }
        const now = this.now();
        const row = this.db.prepare("SELECT asset_id assetId,project_id projectId,agent_id agentId,size,created_at createdAt FROM asset_reservations WHERE id=?").get(id) as { assetId: string; projectId: string; agentId: string; size: number; createdAt: number } | undefined;
        if (!row || row.createdAt <= now - UPLOAD_LEASE_MS) { this.db.prepare("DELETE FROM asset_reservations WHERE id=?").run(id); throw new AssetError(409, "upload reservation expired"); }
        const committed = this.db.prepare("SELECT project_id projectId,agent_id agentId,size FROM asset_committed WHERE asset_id=?").get(row.assetId) as { projectId: string; agentId: string; size: number } | undefined;
        if (committed && (committed.projectId !== row.projectId || committed.agentId !== row.agentId || committed.size !== row.size)) throw new AssetError(409, "asset ownership conflicts with committed usage");
        if (!committed) this.db.prepare("INSERT INTO asset_committed VALUES (?,?,?,?)").run(row.assetId, row.projectId, row.agentId, row.size);
        this.db.prepare("INSERT INTO asset_settlements VALUES (?,?,?,?)").run(id, row.assetId, row.projectId, row.agentId);
        this.db.prepare("DELETE FROM asset_reservations WHERE id=?").run(id);
      }).immediate();
    } catch (error) { throw this.mapped(error); }
  }
  syncAgent(projectId: string, agentId: string, assets: Map<string, number>): void {
    try {
      return this.db.transaction(() => {
        const rows = this.db.prepare("SELECT asset_id id,size FROM asset_committed WHERE project_id=? AND agent_id=?").all(projectId, agentId) as Array<{ id: string; size: number }>;
        for (const row of rows) {
          const deleting = this.db.prepare(`
            SELECT 1 FROM asset_deletions
            WHERE asset_id=? AND project_id=? AND agent_id=? AND completed_at IS NULL
          `).get(row.id, projectId, agentId);
          if (!deleting && assets.get(row.id) !== row.size) {
            throw new AssetError(409, "asset filesystem and quota ledger diverged");
          }
        }
        for (const [id, size] of assets) {
          const deletion = this.db.prepare("SELECT 1 FROM asset_deletions WHERE asset_id=? AND project_id=? AND agent_id=?").get(id, projectId, agentId);
          if (deletion) continue;
          const active = this.db.prepare("SELECT project_id projectId,agent_id agentId,size FROM asset_reservations WHERE asset_id=?").get(id) as { projectId: string; agentId: string; size: number } | undefined;
          if (active) { if (active.projectId !== projectId || active.agentId !== agentId || active.size !== size) throw new AssetError(409, "asset reservation ownership conflicts"); continue; }
          const existing = this.db.prepare("SELECT project_id projectId,agent_id agentId,size FROM asset_committed WHERE asset_id=?").get(id) as { projectId: string; agentId: string; size: number } | undefined;
          if (existing) { if (existing.projectId !== projectId || existing.agentId !== agentId || existing.size !== size) throw new AssetError(409, "duplicate asset ID has conflicting ownership"); continue; }
          if (this.db.prepare("INSERT INTO asset_committed VALUES (?,?,?,?)").run(id, projectId, agentId, size).changes !== 1) throw new AssetError(409, "asset usage import failed");
        }
      }).immediate();
    } catch (error) { throw this.mapped(error); }
  }
  beginDelete(assetId: string, projectId: string, agentId: string): {
    assetId: string;
    projectId: string;
    agentId: string;
    auditEventId: string;
    requestedAt: number;
    completed: boolean;
  } {
    try {
      return this.db.transaction(() => {
        const runtimeOwner = this.db.prepare(`
          SELECT 1 FROM runtime_attachment_associations
          WHERE asset_id=? AND project_id=? AND agent_id=?
        `).get(assetId, projectId, agentId);
        if (runtimeOwner) throw new AssetError(409, "sent assets cannot be deleted");
        const existing = this.db.prepare(`
          SELECT project_id projectId, agent_id agentId, audit_event_id auditEventId,
            requested_at requestedAt, completed_at completedAt
          FROM asset_deletions WHERE asset_id=?
        `).get(assetId) as {
          projectId: string;
          agentId: string;
          auditEventId: string | null;
          requestedAt: number;
          completedAt: number | null;
        } | undefined;
        if (existing && (existing.projectId !== projectId || existing.agentId !== agentId)) {
          throw new AssetError(409, "asset deletion ownership conflicts");
        }
        const auditEventId = existing?.auditEventId ?? randomUUID();
        const requestedAt = existing?.requestedAt || this.now();
        if (!existing) {
          this.db.prepare(`
            INSERT INTO asset_deletions(
              asset_id,project_id,agent_id,requested_at,audit_event_id,completed_at
            ) VALUES (?,?,?,?,?,NULL)
          `).run(assetId, projectId, agentId, requestedAt, auditEventId);
        } else if (!existing.auditEventId) {
          this.db.prepare("UPDATE asset_deletions SET audit_event_id=? WHERE asset_id=?")
            .run(auditEventId, assetId);
        }
        return {
          assetId,
          projectId,
          agentId,
          auditEventId,
          requestedAt,
          completed: existing?.completedAt !== null && existing?.completedAt !== undefined,
        };
      }).immediate();
    } catch (error) {
      throw this.mapped(error);
    }
  }
  finishDelete(assetId: string): void {
    try {
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM asset_committed WHERE asset_id=?").run(assetId);
        this.db.prepare("UPDATE asset_deletions SET completed_at=? WHERE asset_id=?")
          .run(this.now(), assetId);
      }).immediate();
    } catch (error) { throw this.mapped(error); }
  }
  removeCommitted(assetId: string): void { this.finishDelete(assetId); }
  pendingDeletions(projectId?: string, agentId?: string): Array<{
    assetId: string;
    projectId: string;
    agentId: string;
    auditEventId: string;
    requestedAt: number;
  }> {
    try {
      const rows = this.db.prepare(`
        SELECT asset_id assetId, project_id projectId, agent_id agentId,
          audit_event_id auditEventId, requested_at requestedAt
        FROM asset_deletions
        WHERE completed_at IS NULL
          AND (? IS NULL OR project_id = ?)
          AND (? IS NULL OR agent_id = ?)
        ORDER BY requested_at, asset_id
      `).all(projectId ?? null, projectId ?? null, agentId ?? null, agentId ?? null) as Array<{
        assetId: string;
        projectId: string;
        agentId: string;
        auditEventId: string | null;
        requestedAt: number;
      }>;
      return rows.map((row) => {
        if (!row.auditEventId) throw new AssetError(409, "asset deletion receipt is incomplete");
        return { ...row, auditEventId: row.auditEventId };
      });
    } catch (error) { throw this.mapped(error); }
  }
  deletionRequested(assetId: string): boolean {
    try { return Boolean(this.db.prepare("SELECT 1 FROM asset_deletions WHERE asset_id=?").get(assetId)); }
    catch (error) { throw this.mapped(error); }
  }
  enqueueDraftAttachmentCleanup(
    draftId: string,
    ownerId: string,
    assetId: string,
    eligibleAt: number,
  ): void {
    try {
      this.db.prepare(`
        INSERT INTO draft_attachment_cleanups(draft_id,owner_id,asset_id,eligible_at)
        VALUES (?,?,?,?)
        ON CONFLICT(draft_id,owner_id,asset_id) DO UPDATE SET
          eligible_at = min(eligible_at, excluded.eligible_at)
      `).run(draftId, ownerId, assetId, eligibleAt);
    } catch (error) { throw this.mapped(error); }
  }
  pendingDraftAttachmentCleanups(now = this.now()): Array<{
    draftId: string;
    ownerId: string;
    assetId: string;
  }> {
    try {
      return this.db.prepare(`
        SELECT draft_id draftId, owner_id ownerId, asset_id assetId
        FROM draft_attachment_cleanups WHERE eligible_at <= ?
        ORDER BY eligible_at, draft_id, owner_id, asset_id
      `).all(now) as Array<{ draftId: string; ownerId: string; assetId: string }>;
    } catch (error) { throw this.mapped(error); }
  }
  finishDraftAttachmentCleanup(draftId: string, ownerId: string, assetId: string): void {
    try {
      return this.db.transaction(() => {
        const committed = this.db.prepare(`
          SELECT draft_id draftId,owner_id ownerId
          FROM draft_asset_committed WHERE asset_id=?
        `).get(assetId) as { draftId: string; ownerId: string } | undefined;
        if (committed && (committed.draftId !== draftId || committed.ownerId !== ownerId)) {
          throw new AssetError(409, "draft asset cleanup ownership conflicts");
        }
        this.db.prepare(`
          DELETE FROM draft_asset_committed
          WHERE asset_id=? AND draft_id=? AND owner_id=?
        `).run(assetId, draftId, ownerId);
        this.db.prepare(`
          DELETE FROM draft_asset_reservations
          WHERE asset_id=? AND draft_id=? AND owner_id=?
        `).run(assetId, draftId, ownerId);
        this.db.prepare(`
          DELETE FROM draft_asset_settlements
          WHERE asset_id=? AND draft_id=? AND owner_id=?
        `).run(assetId, draftId, ownerId);
        this.db.prepare(`
          DELETE FROM draft_attachment_cleanups
          WHERE draft_id=? AND owner_id=? AND asset_id=?
        `).run(draftId, ownerId, assetId);
      }).immediate();
    } catch (error) {
      throw this.mapped(error);
    }
  }

  finishDraftSurfaceCleanup(draftId: string): void {
    try {
      return this.db.transaction(() => {
        this.db.prepare("DELETE FROM draft_asset_settlements WHERE draft_id=?").run(draftId);
        this.db.prepare("DELETE FROM draft_asset_reservations WHERE draft_id=?").run(draftId);
        this.db.prepare("DELETE FROM draft_asset_committed WHERE draft_id=?").run(draftId);
        this.db.prepare("DELETE FROM draft_attachment_cleanups WHERE draft_id=?").run(draftId);
        this.db.prepare("DELETE FROM draft_asset_rate_events WHERE draft_id=?").run(draftId);
      }).immediate();
    } catch (error) {
      throw this.mapped(error);
    }
  }

  draftSurfaceIds(): string[] {
    try {
      return (this.db.prepare(`
        SELECT draft_id draftId FROM draft_asset_reservations
        UNION SELECT draft_id FROM draft_asset_committed
        UNION SELECT draft_id FROM draft_asset_settlements
        UNION SELECT draft_id FROM draft_attachment_cleanups
        UNION SELECT draft_id FROM draft_asset_rate_events
        ORDER BY draftId
      `).all() as Array<{ draftId: string }>).map(row => row.draftId);
    } catch (error) { throw this.mapped(error); }
  }

  purgeAgents(agentIds: readonly string[]): void {
    const ids = [...new Set(agentIds)];
    if (ids.some((id) => !RUNTIME_UUID.test(id))) {
      throw new AssetError(409, "Agent asset cleanup identity is invalid");
    }
    if (ids.length === 0) return;
    try {
      return this.db.transaction(() => {
        for (const agentId of ids) {
          this.db.prepare("DELETE FROM runtime_attachment_associations WHERE agent_id=?").run(agentId);
          this.db.prepare("DELETE FROM asset_settlements WHERE agent_id=?").run(agentId);
          this.db.prepare("DELETE FROM asset_deletions WHERE agent_id=?").run(agentId);
          this.db.prepare("DELETE FROM asset_reservations WHERE agent_id=?").run(agentId);
          this.db.prepare("DELETE FROM asset_committed WHERE agent_id=?").run(agentId);
          this.db.prepare("DELETE FROM asset_rate_events WHERE agent_id=?").run(agentId);
          this.db.prepare("DELETE FROM asset_audit WHERE agent_id=?").run(agentId);
          const draftId = `agent:${agentId}`;
          this.db.prepare("DELETE FROM draft_asset_settlements WHERE draft_id=?").run(draftId);
          this.db.prepare("DELETE FROM draft_asset_reservations WHERE draft_id=?").run(draftId);
          this.db.prepare("DELETE FROM draft_asset_committed WHERE draft_id=?").run(draftId);
          this.db.prepare("DELETE FROM draft_attachment_cleanups WHERE draft_id=?").run(draftId);
          this.db.prepare("DELETE FROM draft_asset_rate_events WHERE draft_id=?").run(draftId);
        }
      }).immediate();
    } catch (error) {
      throw this.mapped(error);
    }
  }

  purgeProject(projectId: string, draftSurfaceIds: readonly string[] = []): void {
    if (!OWNER_ID.test(projectId) || draftSurfaceIds.some((id) => !id || id.length > 256)) {
      throw new AssetError(409, "Project asset cleanup identity is invalid");
    }
    try {
      return this.db.transaction(() => {
        this.db.prepare("DELETE FROM generated_artifact_import_receipts WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM generated_artifact_authority WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM runtime_artifact_authority WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM runtime_attachment_associations WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM asset_settlements WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM asset_deletions WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM asset_reservations WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM asset_committed WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM asset_rate_events WHERE project_id=?").run(projectId);
        this.db.prepare("DELETE FROM asset_audit WHERE project_id=?").run(projectId);
        for (const draftId of new Set(draftSurfaceIds)) {
          this.db.prepare("DELETE FROM draft_asset_settlements WHERE draft_id=?").run(draftId);
          this.db.prepare("DELETE FROM draft_asset_reservations WHERE draft_id=?").run(draftId);
          this.db.prepare("DELETE FROM draft_asset_committed WHERE draft_id=?").run(draftId);
          this.db.prepare("DELETE FROM draft_attachment_cleanups WHERE draft_id=?").run(draftId);
          this.db.prepare("DELETE FROM draft_asset_rate_events WHERE draft_id=?").run(draftId);
        }
      }).immediate();
    } catch (error) {
      throw this.mapped(error);
    }
  }
  recordAudit(file: string, projectId: string, agentId: string, record: Record<string, unknown>, eventId: string = randomUUID()): void {
    let fd: number | undefined;
    try {
      return this.db.transaction(() => {
        try { fd = openSync(file, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          try { fd = openSync(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW, 0o600); }
          catch (createError) {
            if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
            fd = openSync(file, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW);
          }
        }
        const info = fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o022) !== 0) throw new AssetError(409, "asset audit leaf is unsafe");
        let text = readFileSync(fd, "utf8");
        const rawLines = text.split("\n"); const fileIds = new Map<string, string>(); let validBytes = 0;
        for (let index = 0; index < rawLines.length; index++) {
          const line = rawLines[index]!; if (!line) { if (index < rawLines.length - 1) validBytes++; continue; }
          let parsed: Record<string, unknown>;
          try { parsed = JSON.parse(line) as Record<string, unknown>; }
          catch { if (index !== rawLines.length - 1) throw new AssetError(409, "asset audit log is corrupt"); text = text.slice(0, validBytes); break; }
          if (typeof parsed.event_id !== "string" || parsed.event_id.length === 0) {
            throw new AssetError(409, "asset audit record is missing an event ID");
          }
          const eventId = parsed.event_id;
          if (fileIds.has(eventId)) throw new AssetError(409, "asset audit contains a duplicate event ID");
          fileIds.set(eventId, line); validBytes += Buffer.byteLength(line) + 1;
          const existing = this.db.prepare("SELECT record_json json FROM asset_audit WHERE event_id=?").get(eventId) as { json: string } | undefined;
          if (existing && existing.json !== line) throw new AssetError(409, "asset audit event ID conflicts");
          if (!existing) this.db.prepare("INSERT INTO asset_audit(event_id,project_id,agent_id,record_json) VALUES (?,?,?,?)").run(eventId, projectId, agentId, line);
        }
        if (info.size !== Buffer.byteLength(text)) { ftruncateSync(fd, Buffer.byteLength(text)); fsyncSync(fd); }
        const withId = JSON.stringify({ ...record, event_id: eventId });
        const existingRecord = this.db.prepare("SELECT record_json json FROM asset_audit WHERE event_id=?").get(eventId) as { json: string } | undefined;
        if (existingRecord && existingRecord.json !== withId) throw new AssetError(409, "asset audit event ID conflicts");
        if (!existingRecord) {
          this.db.prepare("INSERT INTO asset_audit(event_id,project_id,agent_id,record_json) VALUES (?,?,?,?)")
            .run(eventId, projectId, agentId, withId);
        }
        const rows = this.db.prepare("SELECT event_id eventId,record_json json FROM asset_audit WHERE project_id=? AND agent_id=? ORDER BY seq").all(projectId, agentId) as Array<{ eventId: string; json: string }>;
        if (text && !text.endsWith("\n")) writeSync(fd, "\n");
        for (const row of rows) if (!fileIds.has(row.eventId)) { writeSync(fd, `${row.json}\n`); fileIds.set(row.eventId, row.json); }
        fsyncSync(fd);
      }).immediate();
    } catch (error) { throw this.mapped(error); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  /** The portable attachment path keeps each audit event immutable under the
   * native retained-directory authority; SQLite remains its query index. */
  recordSecureAudit(root: string, relativeDirectory: string, projectId: string, agentId: string, record: Record<string, unknown>, eventId: string = randomUUID()): void {
    if (!/^[a-f0-9-]{36}$/u.test(eventId)) throw new AssetError(409, "asset audit event ID is invalid");
    try {
      return this.db.transaction(() => {
        const entries = listSecureDirectory({ root, relativePath: relativeDirectory });
        if (!entries) throw new AssetError(409, "asset audit directory is unavailable");
        const present = new Map<string, string>();
        for (const entry of entries) {
          const match = /^audit-([a-f0-9-]{36})\.json$/u.exec(entry.name);
          if (!match) continue;
          const body = readSecureFile({ root, relativePath: `${relativeDirectory}/${entry.name}`, maxBytes: 32 * 1024 });
          if (!body) throw new AssetError(409, "asset audit record is unavailable");
          const line = body.toString("utf8");
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.event_id !== match[1] || parsed.projectId !== projectId || parsed.agentId !== agentId) {
            throw new AssetError(409, "asset audit record has invalid ownership");
          }
          present.set(match[1]!, line);
          const existing = this.db.prepare("SELECT record_json json FROM asset_audit WHERE event_id=?").get(match[1]) as { json: string } | undefined;
          if (existing && existing.json !== line) throw new AssetError(409, "asset audit event ID conflicts");
          if (!existing) this.db.prepare("INSERT INTO asset_audit(event_id,project_id,agent_id,record_json) VALUES (?,?,?,?)")
            .run(match[1], projectId, agentId, line);
        }
        const withId = JSON.stringify({ ...record, event_id: eventId });
        const existing = this.db.prepare("SELECT record_json json FROM asset_audit WHERE event_id=?").get(eventId) as { json: string } | undefined;
        if (existing && existing.json !== withId) throw new AssetError(409, "asset audit event ID conflicts");
        if (!existing) this.db.prepare("INSERT INTO asset_audit(event_id,project_id,agent_id,record_json) VALUES (?,?,?,?)")
          .run(eventId, projectId, agentId, withId);
        const rows = this.db.prepare("SELECT event_id eventId,record_json json FROM asset_audit WHERE project_id=? AND agent_id=? ORDER BY seq").all(projectId, agentId) as Array<{ eventId: string; json: string }>;
        for (const row of rows) {
          if (present.has(row.eventId)) continue;
          try {
            writeSecureFileAtomic({
              root, relativeDirectory, leaf: `audit-${row.eventId}.json`,
              temporaryLeaf: `.audit-${randomUUID()}.tmp`, body: Buffer.from(row.json),
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const current = readSecureFile({ root, relativePath: `${relativeDirectory}/audit-${row.eventId}.json`, maxBytes: 32 * 1024 });
            if (current?.toString("utf8") !== row.json) throw new AssetError(409, "asset audit event ID conflicts");
          }
        }
      }).immediate();
    } catch (error) { throw this.mapped(error); }
  }
  assertOwned(id: string): void {
    try {
      this.db.transaction(() => {
        const result = this.db.prepare("DELETE FROM asset_reservations WHERE id=? AND created_at <= ?")
          .run(id, this.now() - UPLOAD_LEASE_MS);
        if (result.changes || !this.db.prepare("SELECT 1 FROM asset_reservations WHERE id=?").get(id)) {
          throw new AssetError(409, "upload reservation expired");
        }
      }).immediate();
    } catch (error) { throw this.mapped(error); }
  }
  runtimeCommunicationAssociations(): RuntimeAttachmentAssociation[] {
    try {
      return this.db.prepare(`
        SELECT communication_id communicationId, asset_id attachmentId, project_id projectId,
          agent_id agentId, content_hash contentHash, byte_length byteLength
        FROM runtime_attachment_associations ORDER BY communication_id, asset_id
      `).all() as RuntimeAttachmentAssociation[];
    } catch (error) { throw this.mapped(error); }
  }
  removeRuntimeCommunicationAssociations(communicationId: string): void {
    try { this.db.prepare("DELETE FROM runtime_attachment_associations WHERE communication_id=?").run(communicationId); }
    catch (error) { throw this.mapped(error); }
  }
  runtimeAssociatedAssetIds(projectId: string, agentId: string): Set<string> {
    try {
      const rows = this.db.prepare(`
        SELECT DISTINCT asset_id id FROM runtime_attachment_associations
        WHERE project_id=? AND agent_id=?
      `).all(projectId, agentId) as Array<{ id: string }>;
      return new Set(rows.map((row) => row.id));
    } catch (error) { throw this.mapped(error); }
  }
  registerRuntimeArtifact(artifact: RegisteredRuntimeArtifact): {
    artifact: RegisteredRuntimeArtifact;
    reservationCreated: boolean;
  } {
    try {
      return this.db.transaction(() => {
        const prior = this.db.prepare(`
          SELECT project_id projectId, role, title, media_type mediaType, blob_path blobPath,
            blob_hash blobHash, byte_length byteLength, origin_agent_id originAgentId,
            execution_id executionId, created_at createdAt
          FROM runtime_artifact_authority WHERE project_id=? AND id=?
        `).get(artifact.projectId, artifact.id) as Omit<RegisteredRuntimeArtifact, "id"> | undefined;
        const expected = {
          projectId: artifact.projectId, role: artifact.role, title: artifact.title,
          mediaType: artifact.mediaType, blobPath: artifact.blobPath, blobHash: artifact.blobHash,
          byteLength: artifact.byteLength, originAgentId: artifact.originAgentId ?? null,
          executionId: artifact.executionId ?? null,
        };
        const priorIdentity = prior ? (({ createdAt: _createdAt, ...identity }) => identity)(prior) : undefined;
        if (priorIdentity && !runtimeArtifactIdentityMatches(priorIdentity, expected)) {
          throw new AssetError(409, "runtime artifact identity collision");
        }
        if (!prior) this.db.prepare(`
          INSERT INTO runtime_artifact_authority(
            id,project_id,role,title,media_type,blob_path,blob_hash,byte_length,
            origin_agent_id,execution_id,created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          artifact.id, artifact.projectId, artifact.role, artifact.title, artifact.mediaType,
          artifact.blobPath, artifact.blobHash, artifact.byteLength,
          artifact.originAgentId ?? null, artifact.executionId ?? null, artifact.createdAt,
        );
        return {
          artifact: this.runtimeArtifact(artifact.projectId, artifact.id)!,
          reservationCreated: !prior,
        };
      }).immediate();
    } catch (error) {
      throw this.mapped(error);
    }
  }
  runtimeArtifact(projectId: string, id: string): RegisteredRuntimeArtifact | undefined {
    try {
      const row = this.db.prepare(`
        SELECT id, project_id projectId, role, title, media_type mediaType, blob_path blobPath,
          blob_hash blobHash, byte_length byteLength, origin_agent_id originAgentId,
          execution_id executionId, created_at createdAt
        FROM runtime_artifact_authority WHERE project_id=? AND id=?
      `).get(projectId, id) as (RegisteredRuntimeArtifact & { originAgentId: string | null; executionId: string | null }) | undefined;
      if (!row) return undefined;
      const { originAgentId, executionId, ...rest } = row;
      return {
        ...rest,
        ...(originAgentId ? { originAgentId } : {}),
        ...(executionId ? { executionId } : {}),
      };
    } catch (error) { throw this.mapped(error); }
  }
  removeRuntimeArtifact(projectId: string, id: string): void {
    try { this.db.prepare("DELETE FROM runtime_artifact_authority WHERE project_id=? AND id=?").run(projectId, id); }
    catch (error) { throw this.mapped(error); }
  }
  registerGeneratedArtifact(artifact: RegisteredGeneratedArtifact): RegisteredGeneratedArtifact {
    if (!generatedArtifactMetadataIsValid(artifact)) throw new AssetError(409, "generated artifact metadata is invalid");
    try {
      return this.db.transaction(() => {
        const prior = this.generatedArtifact(artifact.projectId, artifact.id);
        if (prior && JSON.stringify(generatedArtifactIdentity(prior)) !== JSON.stringify(generatedArtifactIdentity(artifact))) {
          throw new AssetError(409, "generated artifact identity collision");
        }
        if (!prior) this.db.prepare(`
          INSERT INTO generated_artifact_authority(
            id,project_id,agent_id,origin_agent_id,execution_id,kind,artifact_path,
            source_path,summary,created_at,media_type,byte_length,blob_hash
          ) VALUES (?,?,?,?,?,'generated_file',?,?,?,?,?,?,?)
        `).run(
          artifact.id, artifact.projectId, artifact.agentId, artifact.originAgentId,
          artifact.executionId ?? null, artifact.path, artifact.sourcePath ?? null,
          artifact.summary, artifact.createdAt, artifact.mediaType, artifact.size, artifact.sha256,
        );
        return this.generatedArtifact(artifact.projectId, artifact.id)!;
      }).immediate();
    } catch (error) {
      throw this.mapped(error);
    }
  }
  removeGeneratedArtifactIfMatches(
    expected: RegisteredGeneratedArtifact,
  ): "absent" | "removed" | "mismatch" {
    if (!generatedArtifactMetadataIsValid(expected)) {
      throw new AssetError(409, "generated artifact rollback identity is invalid");
    }
    try {
      return this.db.transaction(() => {
        const registered = this.generatedArtifact(expected.projectId, expected.id);
        if (!registered) {
          return "absent";
        }
        if (JSON.stringify(generatedArtifactIdentity(registered)) !==
            JSON.stringify(generatedArtifactIdentity(expected))) {
          return "mismatch";
        }
        const imported = this.db.prepare(`
          SELECT 1 FROM generated_artifact_import_receipts
          WHERE project_id = ? AND artifact_id = ?
        `).get(expected.projectId, expected.id);
        if (imported) {
          return "mismatch";
        }
        const removed = this.db.prepare(`
          DELETE FROM generated_artifact_authority WHERE project_id = ? AND id = ?
        `).run(expected.projectId, expected.id).changes === 1;
        return removed ? "removed" : "mismatch";
      }).immediate();
    } catch (error) {
      throw this.mapped(error);
    }
  }
  registerGeneratedArtifactImport(
    artifact: RegisteredGeneratedArtifact,
    identity: { runId: string; toolCallId: string; requestHash: string },
  ): GeneratedArtifactImportReceipt {
    if (!generatedArtifactMetadataIsValid(artifact) ||
        !RUNTIME_UUID.test(identity.runId) ||
        !identity.toolCallId || identity.toolCallId.length > 256 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(identity.toolCallId) ||
        !/^[a-f0-9]{64}$/.test(identity.requestHash)) {
      throw new AssetError(400, "generated artifact import identity is invalid");
    }
    try {
      return this.db.transaction(() => {
        const prior = this.generatedArtifactImportReceipt(
          artifact.projectId, identity.runId, identity.toolCallId,
        );
        if (prior) {
          if (prior.requestHash !== identity.requestHash) {
            throw new AssetError(409, "tool call was already used for a different file import");
          }
          return prior;
        }
        const registered = this.generatedArtifact(artifact.projectId, artifact.id);
        if (registered && JSON.stringify(generatedArtifactIdentity(registered)) !==
            JSON.stringify(generatedArtifactIdentity(artifact))) {
          throw new AssetError(409, "generated artifact identity collision");
        }
        if (!registered) this.db.prepare(`
          INSERT INTO generated_artifact_authority(
            id,project_id,agent_id,origin_agent_id,execution_id,kind,artifact_path,
            source_path,summary,created_at,media_type,byte_length,blob_hash
          ) VALUES (?,?,?,?,?,'generated_file',?,?,?,?,?,?,?)
        `).run(
          artifact.id, artifact.projectId, artifact.agentId, artifact.originAgentId,
          artifact.executionId ?? null, artifact.path, artifact.sourcePath ?? null,
          artifact.summary, artifact.createdAt, artifact.mediaType, artifact.size, artifact.sha256,
        );
        this.db.prepare(`
          INSERT INTO generated_artifact_import_receipts(
            project_id,run_id,tool_call_id,request_hash,artifact_id,projected,created_at
          ) VALUES (?,?,?,?,?,0,?)
        `).run(
          artifact.projectId, identity.runId, identity.toolCallId,
          identity.requestHash, artifact.id, artifact.createdAt,
        );
        return this.generatedArtifactImportReceipt(
          artifact.projectId, identity.runId, identity.toolCallId,
        )!;
      }).immediate();
    } catch (error) {
      throw this.mapped(error);
    }
  }
  generatedArtifactImportReceipt(
    projectId: string,
    runId: string,
    toolCallId: string,
  ): GeneratedArtifactImportReceipt | undefined {
    try {
      const row = this.db.prepare(`
        SELECT request_hash requestHash, projected, artifact_id artifactId
        FROM generated_artifact_import_receipts
        WHERE project_id=? AND run_id=? AND tool_call_id=?
      `).get(projectId, runId, toolCallId) as {
        requestHash: string; projected: number; artifactId: string;
      } | undefined;
      if (!row) return undefined;
      const artifact = this.generatedArtifact(projectId, row.artifactId);
      if (!artifact) throw new AssetError(409, "generated artifact import receipt is incomplete");
      return { runId, toolCallId, requestHash: row.requestHash, projected: row.projected === 1, artifact };
    } catch (error) { throw this.mapped(error); }
  }
  pendingGeneratedArtifactImports(): GeneratedArtifactImportReceipt[] {
    try {
      const rows = this.db.prepare(`
        SELECT project_id projectId,run_id runId,tool_call_id toolCallId
        FROM generated_artifact_import_receipts WHERE projected=0 ORDER BY created_at
      `).all() as Array<{ projectId: string; runId: string; toolCallId: string }>;
      return rows.map((row) => this.generatedArtifactImportReceipt(
        row.projectId, row.runId, row.toolCallId,
      )!);
    } catch (error) { throw this.mapped(error); }
  }
  markGeneratedArtifactImportProjected(projectId: string, runId: string, toolCallId: string): void {
    try {
      const changed = this.db.prepare(`
        UPDATE generated_artifact_import_receipts SET projected=1
        WHERE project_id=? AND run_id=? AND tool_call_id=?
      `).run(projectId, runId, toolCallId).changes;
      if (changed !== 1) throw new AssetError(409, "generated artifact import receipt is unavailable");
    } catch (error) { throw this.mapped(error); }
  }
  quarantineGeneratedArtifactImport(projectId: string, runId: string, toolCallId: string): void {
    try {
      return this.db.transaction(() => {
        const receipt = this.generatedArtifactImportReceipt(projectId, runId, toolCallId);
        if (receipt?.projected) throw new AssetError(409, "projected import cannot be quarantined");
        if (receipt) {
          this.db.prepare(`
            DELETE FROM generated_artifact_import_receipts
            WHERE project_id=? AND run_id=? AND tool_call_id=? AND projected=0
          `).run(projectId, runId, toolCallId);
          this.db.prepare(`
            DELETE FROM generated_artifact_authority WHERE project_id=? AND id=?
          `).run(projectId, receipt.artifact.id);
        }
      }).immediate();
    } catch (error) {
      throw this.mapped(error);
    }
  }
  generatedArtifact(projectId: string, id: string): RegisteredGeneratedArtifact | undefined {
    try {
      const row = this.db.prepare(`
        SELECT id,project_id projectId,agent_id agentId,origin_agent_id originAgentId,
          execution_id executionId,kind,artifact_path path,source_path sourcePath,summary,
          created_at createdAt,media_type mediaType,byte_length size,blob_hash sha256
        FROM generated_artifact_authority WHERE project_id=? AND id=?
      `).get(projectId, id) as (RegisteredGeneratedArtifact & {
        executionId: string | null; sourcePath: string | null;
      }) | undefined;
      if (!row) return undefined;
      const { executionId, sourcePath, ...rest } = row;
      return {
        ...rest,
        ...(executionId ? { executionId } : {}),
        ...(sourcePath ? { sourcePath } : {}),
      };
    } catch (error) { throw this.mapped(error); }
  }
  close(): void { this.admission.close(); }
}
