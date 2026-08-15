import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { RuntimeAttachmentReservationReceiptV3 } from "@ponderosa/agents";
import {
  ASSET_LIMITS,
  UPLOAD_LEASE_MS,
  RUNTIME_UUID,
  AssetError,
  generatedArtifactIdentity,
  generatedArtifactMetadataIsValid,
  mkdirSyncSafe,
  runtimeArtifactIdentityMatches,
  type GeneratedArtifactImportReceipt,
  type RegisteredGeneratedArtifact,
  type RegisteredRuntimeArtifact,
  type RuntimeAttachmentAssociation,
} from "./asset-contracts.js";

export class AssetAuthority {
  private db: Database.Database;
  constructor(dataDir: string) {
    try {
      mkdirSyncSafe(dataDir); this.db = new Database(path.join(dataDir, "asset-authority.sqlite"));
      this.db.pragma("journal_mode = WAL"); this.db.pragma("synchronous = FULL"); this.db.pragma("busy_timeout = 500");
      const version = this.db.pragma("user_version", { simple: true }) as number;
      if (version !== 0 && version !== 6 && version !== 7) throw new AssetError(409, "asset authority schema is incompatible");
      this.db.exec(`CREATE TABLE IF NOT EXISTS asset_reservations (
        id TEXT PRIMARY KEY, asset_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size > 0), created_at INTEGER NOT NULL
      ); CREATE INDEX IF NOT EXISTS asset_reservation_agent ON asset_reservations(project_id, agent_id);
      CREATE TABLE IF NOT EXISTS asset_committed (
        asset_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, size INTEGER NOT NULL CHECK(size > 0)
      ); CREATE INDEX IF NOT EXISTS asset_committed_agent ON asset_committed(project_id, agent_id);
      CREATE TABLE IF NOT EXISTS asset_settlements (reservation_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS asset_deletions (asset_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS asset_rate_events (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at INTEGER NOT NULL
      ); CREATE INDEX IF NOT EXISTS asset_rate_agent ON asset_rate_events(project_id, agent_id, created_at);
      CREATE TABLE IF NOT EXISTS asset_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json))
      );
      CREATE TABLE IF NOT EXISTS runtime_attachment_associations (
        communication_id TEXT NOT NULL, asset_id TEXT NOT NULL, project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, content_hash TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length > 0),
        reservation_attempt_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (communication_id, asset_id)
      );
      CREATE INDEX IF NOT EXISTS runtime_attachment_associations_owner
        ON runtime_attachment_associations(project_id, agent_id, asset_id);
      CREATE TABLE IF NOT EXISTS runtime_artifact_authority (
        id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL,
        title TEXT NOT NULL, media_type TEXT NOT NULL, blob_path TEXT NOT NULL,
        blob_hash TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length > 0),
        origin_agent_id TEXT, execution_id TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_artifact_authority_owner_role
        ON runtime_artifact_authority(project_id, id, role);
      CREATE TABLE IF NOT EXISTS generated_artifact_authority (
        id TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        origin_agent_id TEXT NOT NULL, execution_id TEXT, kind TEXT NOT NULL CHECK(kind = 'generated_file'),
        artifact_path TEXT NOT NULL, source_path TEXT, summary TEXT NOT NULL, created_at TEXT NOT NULL,
        media_type TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length > 0),
        blob_hash TEXT NOT NULL,
        PRIMARY KEY (project_id, id)
      );
      CREATE INDEX IF NOT EXISTS generated_artifact_authority_owner
        ON generated_artifact_authority(project_id, origin_agent_id, id);
      CREATE TABLE IF NOT EXISTS generated_artifact_import_receipts (
        project_id TEXT NOT NULL, run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
        request_hash TEXT NOT NULL, artifact_id TEXT NOT NULL, projected INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, run_id, tool_call_id),
        UNIQUE (project_id, artifact_id),
        FOREIGN KEY (artifact_id) REFERENCES generated_artifact_authority(id)
      );
      PRAGMA user_version=7;`);
    } catch (error) { throw error instanceof AssetError ? error : new AssetError(409, `asset authority unavailable: ${error instanceof Error ? error.message : String(error)}`); }
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
      this.db.exec("BEGIN IMMEDIATE");
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
      this.db.exec("COMMIT"); return id;
    } catch (error) { if (this.db.inTransaction) this.db.exec("ROLLBACK"); throw this.mapped(error); }
  }
  release(id: string): boolean {
    try { return this.db.prepare("DELETE FROM asset_reservations WHERE id=?").run(id).changes === 1; } catch (error) { throw this.mapped(error); }
  }
  settle(id: string): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const prior = this.db.prepare("SELECT 1 FROM asset_settlements WHERE reservation_id=?").get(id);
      if (prior) { this.db.exec("COMMIT"); return; }
      const now = this.now();
      const row = this.db.prepare("SELECT asset_id assetId,project_id projectId,agent_id agentId,size,created_at createdAt FROM asset_reservations WHERE id=?").get(id) as { assetId: string; projectId: string; agentId: string; size: number; createdAt: number } | undefined;
      if (!row || row.createdAt <= now - UPLOAD_LEASE_MS) { this.db.prepare("DELETE FROM asset_reservations WHERE id=?").run(id); throw new AssetError(409, "upload reservation expired"); }
      const committed = this.db.prepare("SELECT project_id projectId,agent_id agentId,size FROM asset_committed WHERE asset_id=?").get(row.assetId) as { projectId: string; agentId: string; size: number } | undefined;
      if (committed && (committed.projectId !== row.projectId || committed.agentId !== row.agentId || committed.size !== row.size)) throw new AssetError(409, "asset ownership conflicts with committed usage");
      if (!committed) this.db.prepare("INSERT INTO asset_committed VALUES (?,?,?,?)").run(row.assetId, row.projectId, row.agentId, row.size);
      this.db.prepare("INSERT INTO asset_settlements VALUES (?,?,?,?)").run(id, row.assetId, row.projectId, row.agentId);
      this.db.prepare("DELETE FROM asset_reservations WHERE id=?").run(id); this.db.exec("COMMIT");
    } catch (error) { if (this.db.inTransaction) this.db.exec("ROLLBACK"); throw this.mapped(error); }
  }
  syncAgent(projectId: string, agentId: string, assets: Map<string, number>): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const rows = this.db.prepare("SELECT asset_id id,size FROM asset_committed WHERE project_id=? AND agent_id=?").all(projectId, agentId) as Array<{ id: string; size: number }>;
      for (const row of rows) if (assets.get(row.id) !== row.size) throw new AssetError(409, "asset filesystem and quota ledger diverged");
      for (const [id, size] of assets) {
        const deletion = this.db.prepare("SELECT 1 FROM asset_deletions WHERE asset_id=? AND project_id=? AND agent_id=?").get(id, projectId, agentId);
        if (deletion) continue;
        const active = this.db.prepare("SELECT project_id projectId,agent_id agentId,size FROM asset_reservations WHERE asset_id=?").get(id) as { projectId: string; agentId: string; size: number } | undefined;
        if (active) { if (active.projectId !== projectId || active.agentId !== agentId || active.size !== size) throw new AssetError(409, "asset reservation ownership conflicts"); continue; }
        const existing = this.db.prepare("SELECT project_id projectId,agent_id agentId,size FROM asset_committed WHERE asset_id=?").get(id) as { projectId: string; agentId: string; size: number } | undefined;
        if (existing) { if (existing.projectId !== projectId || existing.agentId !== agentId || existing.size !== size) throw new AssetError(409, "duplicate asset ID has conflicting ownership"); continue; }
        if (this.db.prepare("INSERT INTO asset_committed VALUES (?,?,?,?)").run(id, projectId, agentId, size).changes !== 1) throw new AssetError(409, "asset usage import failed");
      }
      this.db.exec("COMMIT");
    } catch (error) { if (this.db.inTransaction) this.db.exec("ROLLBACK"); throw this.mapped(error); }
  }
  beginDelete(assetId: string, projectId: string, agentId: string): void { try { this.db.exec("BEGIN IMMEDIATE"); this.db.prepare("INSERT OR REPLACE INTO asset_deletions VALUES (?,?,?)").run(assetId, projectId, agentId); this.db.exec("COMMIT"); } catch (error) { if (this.db.inTransaction) this.db.exec("ROLLBACK"); throw this.mapped(error); } }
  finishDelete(assetId: string): void { try { this.db.exec("BEGIN IMMEDIATE"); this.db.prepare("DELETE FROM asset_committed WHERE asset_id=?").run(assetId); this.db.exec("COMMIT"); } catch (error) { if (this.db.inTransaction) this.db.exec("ROLLBACK"); throw this.mapped(error); } }
  removeCommitted(assetId: string): void { this.finishDelete(assetId); }
  recordAudit(file: string, projectId: string, agentId: string, record: Record<string, unknown>): void {
    let fd: number | undefined;
    try {
      this.db.exec("BEGIN IMMEDIATE");
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
      const eventId = randomUUID(); const withId = JSON.stringify({ ...record, event_id: eventId });
      this.db.prepare("INSERT INTO asset_audit(event_id,project_id,agent_id,record_json) VALUES (?,?,?,?)").run(eventId, projectId, agentId, withId);
      const rows = this.db.prepare("SELECT event_id eventId,record_json json FROM asset_audit WHERE project_id=? AND agent_id=? ORDER BY seq").all(projectId, agentId) as Array<{ eventId: string; json: string }>;
      if (text && !text.endsWith("\n")) writeSync(fd, "\n");
      for (const row of rows) if (!fileIds.has(row.eventId)) { writeSync(fd, `${row.json}\n`); fileIds.set(row.eventId, row.json); }
      fsyncSync(fd);
      this.db.exec("COMMIT");
    } catch (error) { if (this.db.inTransaction) this.db.exec("ROLLBACK"); throw this.mapped(error); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  assertOwned(id: string): void {
    try { this.db.exec("BEGIN IMMEDIATE"); const now = this.now(); const result = this.db.prepare("DELETE FROM asset_reservations WHERE id=? AND created_at <= ?").run(id, now - UPLOAD_LEASE_MS); if (result.changes || !this.db.prepare("SELECT 1 FROM asset_reservations WHERE id=?").get(id)) throw new AssetError(409, "upload reservation expired"); this.db.exec("COMMIT"); } catch (error) { if (this.db.inTransaction) this.db.exec("ROLLBACK"); throw this.mapped(error); }
  }
  reserveRuntimeCommunication(
    communicationId: string,
    bindings: RuntimeAttachmentAssociation[],
  ): RuntimeAttachmentReservationReceiptV3 {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const now = this.now();
      const attemptId = randomUUID();
      const inserted: RuntimeAttachmentReservationReceiptV3["bindings"][number][] = [];
      const find = this.db.prepare(`
        SELECT project_id projectId, agent_id agentId, content_hash contentHash, byte_length byteLength
        FROM runtime_attachment_associations WHERE communication_id=? AND asset_id=?
      `);
      const insert = this.db.prepare(`
        INSERT INTO runtime_attachment_associations(
          communication_id,asset_id,project_id,agent_id,content_hash,byte_length,reservation_attempt_id,created_at
        ) VALUES (?,?,?,?,?,?,?,?)
      `);
      for (const binding of bindings) {
        const prior = find.get(communicationId, binding.attachmentId) as Omit<RuntimeAttachmentAssociation, "communicationId" | "attachmentId"> | undefined;
        if (prior) {
          if (prior.projectId !== binding.projectId || prior.agentId !== binding.agentId ||
              prior.contentHash !== binding.contentHash || prior.byteLength !== binding.byteLength) {
            throw new AssetError(409, "runtime Communication attachment reservation conflicts");
          }
          continue;
        }
        insert.run(
          communicationId, binding.attachmentId, binding.projectId, binding.agentId,
          binding.contentHash, binding.byteLength, attemptId, now,
        );
        inserted.push(Object.freeze({ ...binding, communicationId, attemptId }));
      }
      this.db.exec("COMMIT");
      return Object.freeze({ communicationId, attemptId, bindings: Object.freeze(inserted) });
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw this.mapped(error);
    }
  }
  compensateRuntimeCommunicationReservation(receipt: RuntimeAttachmentReservationReceiptV3): void {
    try {
      if (!receipt || typeof receipt !== "object" || !RUNTIME_UUID.test(receipt.attemptId) ||
          typeof receipt.communicationId !== "string" || !receipt.communicationId ||
          !Array.isArray(receipt.bindings)) {
        throw new AssetError(409, "runtime Communication attachment compensation receipt is invalid");
      }
      this.db.exec("BEGIN IMMEDIATE");
      const seen = new Set<string>();
      const remove = this.db.prepare(`
        DELETE FROM runtime_attachment_associations
        WHERE communication_id=? AND asset_id=? AND project_id=? AND agent_id=?
          AND content_hash=? AND byte_length=? AND reservation_attempt_id=?
      `);
      for (const binding of receipt.bindings) {
        const key = `${binding.communicationId}\0${binding.attachmentId}`;
        if (binding.communicationId !== receipt.communicationId || binding.attemptId !== receipt.attemptId ||
            typeof binding.projectId !== "string" || !binding.projectId ||
            typeof binding.agentId !== "string" || !binding.agentId ||
            typeof binding.attachmentId !== "string" || !binding.attachmentId ||
            typeof binding.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(binding.contentHash) ||
            !Number.isSafeInteger(binding.byteLength) || binding.byteLength < 1 || seen.has(key)) {
          throw new AssetError(409, "runtime Communication attachment compensation receipt is invalid");
        }
        seen.add(key);
        remove.run(
          binding.communicationId, binding.attachmentId, binding.projectId, binding.agentId,
          binding.contentHash, binding.byteLength, binding.attemptId,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw this.mapped(error);
    }
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
  registerRuntimeArtifact(artifact: RegisteredRuntimeArtifact): RegisteredRuntimeArtifact {
    try {
      this.db.exec("BEGIN IMMEDIATE");
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
      this.db.exec("COMMIT");
      return this.runtimeArtifact(artifact.projectId, artifact.id)!;
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
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
      this.db.exec("BEGIN IMMEDIATE");
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
      this.db.exec("COMMIT");
      return this.generatedArtifact(artifact.projectId, artifact.id)!;
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
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
      this.db.exec("BEGIN IMMEDIATE");
      const prior = this.generatedArtifactImportReceipt(
        artifact.projectId, identity.runId, identity.toolCallId,
      );
      if (prior) {
        if (prior.requestHash !== identity.requestHash) {
          throw new AssetError(409, "tool call was already used for a different file import");
        }
        this.db.exec("COMMIT");
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
      this.db.exec("COMMIT");
      return this.generatedArtifactImportReceipt(
        artifact.projectId, identity.runId, identity.toolCallId,
      )!;
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
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
      this.db.exec("BEGIN IMMEDIATE");
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
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
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
  close(): void { this.db.close(); }
}
