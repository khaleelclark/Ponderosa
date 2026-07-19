import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import Database from "better-sqlite3";
import { DEFAULT_ASSET_LIMITS, type AssetDto, type AssetLimitsDto } from "@ponderosa/core";
import { attachmentsDir, managedArtifactContentPath, managedArtifactsDir, type RuntimeArtifactInputV3 } from "@ponderosa/agents";

sharp.cache({ memory: 32, files: 0, items: 20 });

export const ASSET_LIMITS: AssetLimitsDto = DEFAULT_ASSET_LIMITS;

const MAX_PIXELS = 25_000_000;
const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
const UPLOAD_LEASE_MS = 5 * 60 * 1000;
const ID = /^[a-f0-9-]{36}$/;
const OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BIDI_AND_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export interface StoredAsset extends AssetDto {
  projectId: string;
  state: "staged" | "associated";
  sha256: string;
  createdAt: string;
  associatedAt?: string;
  originalFile: string;
  previewFile?: string;
}

export interface AuthoritativeRuntimeAttachment {
  attachment: AssetDto & { sha256: string };
  localPath: string;
  contentHash: string;
  byteLength: number;
}

export interface AuthoritativeRuntimeArtifact {
  artifact: RuntimeArtifactInputV3;
  localPath: string;
  contentHash: string;
  byteLength: number;
}

export interface RuntimeAttachmentAssociation {
  communicationId: string;
  projectId: string;
  agentId: string;
  attachmentId: string;
  contentHash: string;
  byteLength: number;
}

interface RegisteredRuntimeArtifact extends RuntimeArtifactInputV3 {
  projectId: string;
  createdAt: string;
}

function runtimeArtifactIdentityMatches(
  registered: Omit<RegisteredRuntimeArtifact, "id" | "createdAt" | "originAgentId" | "executionId"> & {
    originAgentId?: string | null;
    executionId?: string | null;
  },
  expected: Omit<RegisteredRuntimeArtifact, "id" | "createdAt" | "originAgentId" | "executionId"> & {
    originAgentId?: string | null;
    executionId?: string | null;
  },
): boolean {
  return registered.projectId === expected.projectId && registered.role === expected.role &&
    registered.title === expected.title && registered.mediaType === expected.mediaType &&
    registered.blobPath === expected.blobPath && registered.blobHash === expected.blobHash &&
    registered.byteLength === expected.byteLength &&
    (registered.originAgentId ?? null) === (expected.originAgentId ?? null) &&
    (registered.executionId ?? null) === (expected.executionId ?? null);
}

export class AssetError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export class AssetAuthority {
  private db: Database.Database;
  constructor(dataDir: string, private testHooks?: { afterAuditOpen?(file: string): void }) {
    try {
      mkdirSyncSafe(dataDir); this.db = new Database(path.join(dataDir, "asset-authority.sqlite"));
      this.db.pragma("journal_mode = WAL"); this.db.pragma("synchronous = FULL"); this.db.pragma("busy_timeout = 500");
      const version = this.db.pragma("user_version", { simple: true }) as number;
      if (version !== 0 && version !== 4) throw new AssetError(409, "asset authority schema is incompatible");
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
        created_at INTEGER NOT NULL,
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
      PRAGMA user_version=4;`);
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
      if (active.count >= 2) throw new AssetError(429, "too many concurrent asset uploads");
      if (rate >= 20) throw new AssetError(429, "asset upload rate limit exceeded");
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
      this.testHooks?.afterAuditOpen?.(file);
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
  reserveRuntimeCommunication(communicationId: string, bindings: RuntimeAttachmentAssociation[]): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const now = this.now();
      const find = this.db.prepare(`
        SELECT project_id projectId, agent_id agentId, content_hash contentHash, byte_length byteLength
        FROM runtime_attachment_associations WHERE communication_id=? AND asset_id=?
      `);
      const insert = this.db.prepare(`
        INSERT INTO runtime_attachment_associations(
          communication_id,asset_id,project_id,agent_id,content_hash,byte_length,created_at
        ) VALUES (?,?,?,?,?,?,?)
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
          binding.contentHash, binding.byteLength, now,
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
  close(): void { this.db.close(); }
}

function mkdirSyncSafe(dataDir: string): void {
  // The server creates this root before stores; retained for isolated authority tests.
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

function normalizeName(value: unknown): string {
  const raw = String(value ?? "asset").normalize("NFKC").replace(BIDI_AND_CONTROLS, "");
  const leaf = path.basename(raw).replace(/[\\/]/g, "").trim();
  const bytes = Buffer.from(leaf || "asset");
  return (bytes.length <= 160 ? leaf : bytes.subarray(0, 160).toString("utf8").replace(/\uFFFD+$/g, "")) || "asset";
}

function detectType(body: Buffer): AssetDto["mediaType"] | undefined {
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (body[0] === 0xff && body[1] === 0xd8) return "image/jpeg";
  if (body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (body.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "application/zip";
  if (!body.includes(0)) {
    const text = body.toString("utf8");
    if (!text.includes("\uFFFD")) {
      try { JSON.parse(text); return "application/json"; } catch { return "text/plain"; }
    }
  }
  return undefined;
}

function hasStrictImageContainer(body: Buffer, mediaType: AssetDto["mediaType"]): boolean {
  if (mediaType === "image/png") {
    let offset = 8;
    while (offset + 12 <= body.length) {
      const length = body.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > body.length) return false;
      const type = body.subarray(offset + 4, offset + 8).toString("ascii");
      offset = end;
      if (type === "IEND") return length === 0 && offset === body.length;
    }
    return false;
  }
  if (mediaType === "image/jpeg") return body.length >= 4 && body[body.length - 2] === 0xff && body[body.length - 1] === 0xd9;
  if (mediaType === "image/webp") return body.length >= 12 && body.readUInt32LE(4) + 8 === body.length;
  return true;
}

function extensionMatches(name: string, mediaType: AssetDto["mediaType"]): boolean {
  const extension = path.extname(name).toLocaleLowerCase();
  if (!extension) return true;
  const allowed: Record<AssetDto["mediaType"], string[]> = {
    "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"],
    "application/pdf": [".pdf"], "text/plain": [".txt", ".md", ".csv", ".log"],
    "application/json": [".json"], "application/zip": [".zip"],
  };
  return allowed[mediaType].includes(extension);
}

function contentTypeMatches(declared: string | undefined, detected: AssetDto["mediaType"]): boolean {
  if (!declared || declared === "application/octet-stream") return true;
  return declared.split(";", 1)[0]?.trim().toLocaleLowerCase() === detected;
}

async function writeAtomic(file: string, body: Buffer | string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, file); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

function canonicalFiles(id: string): { originalFile: string; previewFile: string } {
  return { originalFile: `${id}.bin`, previewFile: `${id}.preview.png` };
}

function validateStoredAsset(value: unknown, projectId: string, agentId: string, id: string): StoredAsset | undefined {
  if (!value || typeof value !== "object") return undefined;
  const asset = value as Partial<StoredAsset>;
  const fields = new Set([
    "id", "projectId", "agentId", "name", "mediaType", "size", "width", "height",
    "sha256", "state", "createdAt", "associatedAt", "originalFile", "previewFile",
    "url", "downloadUrl", "previewUrl",
  ]);
  if (Object.keys(value as Record<string, unknown>).some((field) => !fields.has(field))) return undefined;
  const names = canonicalFiles(id);
  if (asset.id !== id || asset.projectId !== projectId || asset.agentId !== agentId) return undefined;
  if (!OWNER_ID.test(projectId) || !OWNER_ID.test(agentId) || !ID.test(id)) return undefined;
  if (asset.originalFile !== names.originalFile || (asset.previewFile !== undefined && asset.previewFile !== names.previewFile)) return undefined;
  if (typeof asset.name !== "string" || normalizeName(asset.name) !== asset.name ||
      typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > ASSET_LIMITS.maxFileBytes) return undefined;
  if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) return undefined;
  if (asset.state !== "staged" && asset.state !== "associated") return undefined;
  if (typeof asset.createdAt !== "string" || !Number.isFinite(Date.parse(asset.createdAt))) return undefined;
  if (asset.associatedAt !== undefined && (typeof asset.associatedAt !== "string" || !Number.isFinite(Date.parse(asset.associatedAt)))) return undefined;
  if ((asset.state === "associated") !== (asset.associatedAt !== undefined)) return undefined;
  if (!ASSET_LIMITS.acceptedMediaTypes.includes(asset.mediaType as AssetDto["mediaType"])) return undefined;
  if (!extensionMatches(asset.name, asset.mediaType as AssetDto["mediaType"])) return undefined;
  const preview = asset.previewFile !== undefined;
  const expectedDownload = `/api/agents/${encodeURIComponent(agentId)}/assets/${id}/download`;
  const expectedPreview = preview ? `/api/agents/${encodeURIComponent(agentId)}/assets/${id}/preview` : undefined;
  const expectedUrl = preview
    ? `/api/agents/${encodeURIComponent(agentId)}/attachments/${id}`
    : expectedDownload;
  if (asset.url !== expectedUrl || asset.downloadUrl !== expectedDownload || asset.previewUrl !== expectedPreview) return undefined;
  if (String(asset.mediaType).startsWith("image/")) {
    if (!preview || !Number.isSafeInteger(asset.width) || (asset.width ?? 0) < 1 ||
        !Number.isSafeInteger(asset.height) || (asset.height ?? 0) < 1) return undefined;
  } else if (preview || asset.width !== undefined || asset.height !== undefined) return undefined;
  return asset as StoredAsset;
}

async function readNoFollow(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("unsafe asset file");
    return await handle.readFile();
  } finally { await handle.close(); }
}

function publicDto(asset: StoredAsset): AssetDto {
  const { id, agentId, name, mediaType, size, width, height, url, downloadUrl, previewUrl, sha256, state, createdAt } = asset;
  return { id, agentId, name, mediaType, size, width, height, url, downloadUrl, previewUrl, sha256, state, createdAt };
}

export class AssetStore {
  private root?: string;
  private authority: AssetAuthority;

  constructor(private dataDir: string) { this.authority = new AssetAuthority(dataDir); }
  close(): void { this.authority.close(); }

  private validateOwner(projectId: string, agentId: string): void {
    if (!OWNER_ID.test(projectId) || !OWNER_ID.test(agentId)) throw new AssetError(404, "asset storage is unavailable");
  }
  private dir(projectId: string, agentId: string): string { this.validateOwner(projectId, agentId); return attachmentsDir(this.dataDir, projectId, agentId); }
  private async safeDirectory(projectId: string, agentId: string, create = false): Promise<{ path: string; handle: FileHandle }> {
    const directory = this.dir(projectId, agentId);
    for (const ancestor of [
      path.join(this.dataDir, "projects"),
      path.join(this.dataDir, "projects", projectId),
      path.join(this.dataDir, "projects", projectId, "agents"),
      path.join(this.dataDir, "projects", projectId, "agents", agentId),
    ]) {
      const info = await lstat(ancestor).catch(() => undefined);
      if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new AssetError(409, "asset storage is unavailable");
    }
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const root = this.root ??= await realpath(this.dataDir);
    const actual = await realpath(directory);
    if (actual !== path.join(root, "projects", projectId, "agents", agentId, "attachments")) throw new AssetError(409, "asset storage is unavailable");
    let cursor = directory;
    while (cursor !== this.dataDir) {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new AssetError(409, "asset storage is unavailable");
      cursor = path.dirname(cursor);
    }
    const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const descriptorPath = `/proc/self/fd/${handle.fd}`;
    const descriptorRealpath = await realpath(descriptorPath);
    if (descriptorRealpath !== actual) { await handle.close(); throw new AssetError(409, "asset storage is unavailable"); }
    return { path: descriptorPath, handle };
  }

  async read(projectId: string, agentId: string, id: string): Promise<StoredAsset | undefined> {
    if (!ID.test(id)) return undefined;
    try {
      const directory = await this.safeDirectory(projectId, agentId);
      try { return validateStoredAsset(JSON.parse((await readNoFollow(path.join(directory.path, `${id}.json`), 32 * 1024)).toString("utf8")), projectId, agentId, id); }
      finally { await directory.handle.close(); }
    } catch { return undefined; }
  }

  /** Resolve immutable attachment metadata and bytes at the synchronous
   * scheduler intake boundary. */
  authoritativeRuntimeAttachment(
    projectId: string,
    agentId: string,
    id: string,
  ): AuthoritativeRuntimeAttachment | undefined {
    if (!ID.test(id)) return undefined;
    let metadataFd: number | undefined;
    let contentFd: number | undefined;
    let previewFd: number | undefined;
    try {
      const directory = this.dir(projectId, agentId);
      const root = this.root ??= realpathSync(this.dataDir);
      const actual = realpathSync(directory);
      if (actual !== path.join(root, "projects", projectId, "agents", agentId, "attachments")) return undefined;
      for (const ancestor of [
        path.join(this.dataDir, "projects"),
        path.join(this.dataDir, "projects", projectId),
        path.join(this.dataDir, "projects", projectId, "agents"),
        path.join(this.dataDir, "projects", projectId, "agents", agentId),
        directory,
      ]) {
        const info = lstatSync(ancestor);
        if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
      }
      metadataFd = openSync(path.join(actual, `${id}.json`), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const metadataInfo = fstatSync(metadataFd);
      if (!metadataInfo.isFile() || metadataInfo.nlink !== 1 || metadataInfo.size > 32 * 1024) return undefined;
      const asset = validateStoredAsset(JSON.parse(readFileSync(metadataFd, "utf8")), projectId, agentId, id);
      if (!asset) return undefined;
      contentFd = openSync(path.join(actual, asset.originalFile), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const contentInfo = fstatSync(contentFd);
      if (!contentInfo.isFile() || contentInfo.nlink !== 1 || contentInfo.size !== asset.size || contentInfo.size > ASSET_LIMITS.maxFileBytes) return undefined;
      const body = readFileSync(contentFd);
      const contentHash = createHash("sha256").update(body).digest("hex");
      if (contentHash !== asset.sha256 || detectType(body) !== asset.mediaType ||
          !extensionMatches(asset.name, asset.mediaType) || !hasStrictImageContainer(body, asset.mediaType)) return undefined;
      if (asset.previewFile) {
        previewFd = openSync(path.join(actual, asset.previewFile), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const previewInfo = fstatSync(previewFd);
        if (!previewInfo.isFile() || previewInfo.nlink !== 1 || previewInfo.size < 1 ||
            previewInfo.size > ASSET_LIMITS.maxFileBytes) return undefined;
        const preview = readFileSync(previewFd);
        if (detectType(preview) !== "image/png" || !hasStrictImageContainer(preview, "image/png")) return undefined;
      }
      return {
        attachment: { ...publicDto(asset), sha256: contentHash, state: "associated" },
        localPath: path.join(actual, asset.originalFile),
        contentHash,
        byteLength: body.length,
      };
    } catch {
      return undefined;
    } finally {
      if (metadataFd !== undefined) closeSync(metadataFd);
      if (contentFd !== undefined) closeSync(contentFd);
      if (previewFd !== undefined) closeSync(previewFd);
    }
  }

  registerRuntimeArtifact(artifact: RegisteredRuntimeArtifact): RegisteredRuntimeArtifact {
    return this.authority.registerRuntimeArtifact(artifact);
  }

  removeRuntimeArtifactReservation(projectId: string, id: string): void {
    this.authority.removeRuntimeArtifact(projectId, id);
  }

  authoritativeRuntimeArtifact(
    projectId: string,
    expected: RuntimeArtifactInputV3,
  ): AuthoritativeRuntimeArtifact | undefined {
    let contentFd: number | undefined;
    try {
      const registered = this.authority.runtimeArtifact(projectId, expected.id);
      if (!registered || registered.projectId !== projectId) return undefined;
      const { createdAt: _createdAt, ...registeredIdentity } = registered;
      const expectedIdentity = { projectId, ...expected };
      if (!runtimeArtifactIdentityMatches(registeredIdentity, expectedIdentity)) return undefined;
      const { projectId: _projectId, ...authoritativeMetadata } = registeredIdentity;
      const root = this.root ??= realpathSync(this.dataDir);
      const contentDirectory = path.join(managedArtifactsDir(this.dataDir, projectId), "content");
      const actualDirectory = realpathSync(contentDirectory);
      const expectedDirectory = path.join(root, "projects", projectId, "artifacts", "content");
      if (actualDirectory !== expectedDirectory) return undefined;
      for (const ancestor of [
        path.join(this.dataDir, "projects"),
        path.join(this.dataDir, "projects", projectId),
        managedArtifactsDir(this.dataDir, projectId),
        contentDirectory,
      ]) {
        const info = lstatSync(ancestor);
        if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
      }
      const canonicalPath = managedArtifactContentPath(this.dataDir, projectId, expected.id);
      if (canonicalPath !== path.join(actualDirectory, expected.id) || expected.blobPath !== expected.id) return undefined;
      contentFd = openSync(canonicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const contentInfo = fstatSync(contentFd);
      if (!contentInfo.isFile() || contentInfo.nlink !== 1 || contentInfo.size !== expected.byteLength ||
          contentInfo.size < 1 || contentInfo.size > ASSET_LIMITS.maxFileBytes) return undefined;
      const body = readFileSync(contentFd);
      const contentHash = createHash("sha256").update(body).digest("hex");
      try { new TextDecoder("utf-8", { fatal: true }).decode(body); }
      catch { return undefined; }
      if (contentHash !== expected.blobHash) return undefined;
      return { artifact: authoritativeMetadata, localPath: canonicalPath, contentHash, byteLength: body.length };
    } catch { return undefined; }
    finally { if (contentFd !== undefined) closeSync(contentFd); }
  }

  reserveRuntimeCommunication(
    communicationId: string,
    bindings: Array<{ projectId: string; agentId: string; attachmentId: string; contentHash: string; byteLength: number }>,
  ): void {
    this.authority.reserveRuntimeCommunication(communicationId, bindings.map((binding) => ({ communicationId, ...binding })));
  }

  async recoverRuntimeCommunicationAssociations(
    communicationExists: (communicationId: string, projectId: string) => boolean,
  ): Promise<{ associated: number; released: number; unavailable: number }> {
    let associated = 0;
    let released = 0;
    let unavailable = 0;
    const rows = this.authority.runtimeCommunicationAssociations();
    for (const row of rows) {
      if (!communicationExists(row.communicationId, row.projectId)) {
        this.authority.removeRuntimeCommunicationAssociations(row.communicationId);
        released += 1;
        continue;
      }
      const resolved = this.authoritativeRuntimeAttachment(row.projectId, row.agentId, row.attachmentId);
      if (!resolved || resolved.contentHash !== row.contentHash || resolved.byteLength !== row.byteLength) {
        unavailable += 1;
        continue;
      }
      try {
        await this.associate(row.projectId, row.agentId, [row.attachmentId]);
        associated += 1;
      } catch { unavailable += 1; }
    }
    return { associated, released, unavailable };
  }

  async stage(input: { projectId: string; agentId: string; body: Buffer; name: unknown; declaredType?: string }): Promise<AssetDto> {
    const { projectId, agentId, body } = input;
    if (!body.length) throw new AssetError(400, "asset body is required");
    if (body.length > ASSET_LIMITS.maxFileBytes) throw new AssetError(413, "asset exceeds 8 MiB limit");
    const name = normalizeName(input.name);
    const mediaType = detectType(body);
    if (!mediaType || !extensionMatches(name, mediaType) || !contentTypeMatches(input.declaredType, mediaType)) {
      throw new AssetError(415, "file content, media type, and extension must agree");
    }
    if (mediaType.startsWith("image/") && !hasStrictImageContainer(body, mediaType)) {
      throw new AssetError(415, "image container is truncated or contains trailing data");
    }
    const now = Date.now();
    const openedDirectory = await this.safeDirectory(projectId, agentId, true);
    const directory = openedDirectory.path;
    const existing = new Map<string, number>();
    for (const entry of await readdir(directory)) {
      const match = entry.match(/^([a-f0-9-]{36})\.bin$/); if (!match) continue;
      const target = path.join(directory, entry); const first = await stat(target); const second = await stat(target);
      if (!first.isFile() || first.dev !== second.dev || first.ino !== second.ino || first.size !== second.size) throw new AssetError(409, "asset filesystem changed during quota reconciliation");
      existing.set(match[1]!, second.size);
    }
    this.authority.syncAgent(projectId, agentId, existing);
    const id = randomUUID();
    const reservationId = (() => { try { return this.authority.reserve(projectId, agentId, id, body.length); } catch (error) { void openedDirectory.handle.close(); throw error; } })();
    try {
      this.authority.recordAudit(path.join(directory, "audit.jsonl"), projectId, agentId, { action: "upload_reserved", agentId, projectId, at: new Date(now).toISOString() });

      let width: number | undefined, height: number | undefined, preview: Buffer | undefined;
      if (mediaType.startsWith("image/")) {
        try {
          const image = sharp(body, { animated: false, failOn: "error", limitInputPixels: MAX_PIXELS, sequentialRead: true });
          const metadata = await image.metadata();
          if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1 || metadata.width * metadata.height > MAX_PIXELS) throw new Error("unsafe image dimensions");
          width = metadata.width; height = metadata.height;
          const renderedPreview = await image.rotate().timeout({ seconds: 5 }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
          if (renderedPreview.length > ASSET_LIMITS.maxFileBytes) throw new Error("preview exceeds size limit");
          preview = renderedPreview;
        } catch { throw new AssetError(415, "image could not be safely decoded as one bounded frame"); }
      }

      const { originalFile, previewFile: canonicalPreview } = canonicalFiles(id);
      const previewFile = preview ? canonicalPreview : undefined;
      const createdAt = new Date().toISOString();
      const asset: StoredAsset = {
        id, projectId, agentId, name, mediaType, size: body.length, width, height,
        sha256: createHash("sha256").update(body).digest("hex"), state: "staged", createdAt,
        originalFile, previewFile,
        url: previewFile ? `/api/agents/${encodeURIComponent(agentId)}/attachments/${id}` : `/api/agents/${encodeURIComponent(agentId)}/assets/${id}/download`,
        downloadUrl: `/api/agents/${encodeURIComponent(agentId)}/assets/${id}/download`,
        previewUrl: previewFile ? `/api/agents/${encodeURIComponent(agentId)}/assets/${id}/preview` : undefined,
      };
      await writeAtomic(path.join(directory, originalFile), body);
      try {
        if (preview && previewFile) await writeAtomic(path.join(directory, previewFile), preview);
        await writeAtomic(path.join(directory, `${id}.json`), JSON.stringify(asset));
        this.authority.settle(reservationId);
      } catch (error) {
        await Promise.allSettled([unlink(path.join(directory, originalFile)), previewFile ? unlink(path.join(directory, previewFile)) : Promise.resolve(), unlink(path.join(directory, `${id}.json`))]);
        throw error;
      }
      this.authority.recordAudit(path.join(directory, "audit.jsonl"), projectId, agentId, { action: "staged", id, agentId, projectId, size: body.length, mediaType, at: createdAt });
      return publicDto(asset);
    } finally {
      this.authority.release(reservationId);
      await openedDirectory.handle.close();
    }
  }

  async associate(projectId: string, agentId: string, ids: string[]): Promise<AssetDto[]> {
    const assets = await Promise.all(ids.map((id) => this.read(projectId, agentId, id)));
    if (assets.some((asset) => !asset)) throw new AssetError(404, "asset not found");
    const integrity = await Promise.all(ids.map((id) => this.content(projectId, agentId, id, false)));
    if (integrity.some((item) => !item)) throw new AssetError(404, "asset not found");
    const now = new Date().toISOString();
    const associated = assets as StoredAsset[];
    await Promise.all(associated.map(async (asset) => {
      if (asset.state === "associated") return;
      const updated = { ...asset, state: "associated" as const, associatedAt: now };
      const directory = await this.safeDirectory(projectId, agentId);
      try { await writeAtomic(path.join(directory.path, `${asset.id}.json`), JSON.stringify(updated)); }
      finally { await directory.handle.close(); }
      Object.assign(asset, updated);
    }));
    return associated.map(publicDto);
  }

  async content(projectId: string, agentId: string, id: string, preview: boolean): Promise<{ asset: StoredAsset; body: Buffer } | undefined> {
    const asset = await this.read(projectId, agentId, id);
    const file = preview ? asset?.previewFile : asset?.originalFile;
    if (!asset || !file) return undefined;
    try {
      const directory = await this.safeDirectory(projectId, agentId);
      const body = await readNoFollow(path.join(directory.path, file), ASSET_LIMITS.maxFileBytes).finally(() => directory.handle.close());
      if (!preview && createHash("sha256").update(body).digest("hex") !== asset.sha256) return undefined;
      return { asset, body };
    } catch { return undefined; }
  }

  async remove(projectId: string, agentId: string, id: string): Promise<boolean> {
    const asset = await this.read(projectId, agentId, id);
    if (!asset || asset.state !== "staged") return false;
    const openedDirectory = await this.safeDirectory(projectId, agentId);
    const directory = openedDirectory.path;
    try {
      this.authority.beginDelete(id, projectId, agentId);
      await Promise.allSettled([unlink(path.join(directory, asset.originalFile)), asset.previewFile ? unlink(path.join(directory, asset.previewFile)) : Promise.resolve(), unlink(path.join(directory, `${id}.json`))]);
      this.authority.recordAudit(path.join(directory, "audit.jsonl"), projectId, agentId, { action: "deleted", id, agentId, projectId, at: new Date().toISOString() });
      this.authority.finishDelete(id);
    } finally { await openedDirectory.handle.close(); }
    return true;
  }

  async reconcile(projectId: string, agentId: string, associatedIds: Set<string>, now = Date.now()): Promise<number> {
    const openedDirectory = await this.safeDirectory(projectId, agentId).catch(() => undefined);
    if (!openedDirectory) return 0;
    const directory = openedDirectory.path;
    let removed = 0;
    const reachableIds = new Set([...associatedIds, ...this.authority.runtimeAssociatedAssetIds(projectId, agentId)]);
    const entries = await readdir(directory).catch(() => []);
    const metadataIds = new Set<string>();
    for (const entry of entries) {
      if (!entry.endsWith(".json") || !ID.test(entry.slice(0, -5))) continue;
      const id = entry.slice(0, -5);
      if (await this.read(projectId, agentId, id)) metadataIds.add(id);
    }
    for (const entry of entries) {
      const raw = entry.match(/^([a-f0-9-]{36})\.(bin|preview\.png)$/);
      const temporary = entry.endsWith(".tmp");
      if ((raw && !metadataIds.has(raw[1]!)) || temporary) {
        const target = path.join(directory, entry);
        const old = now - await lstat(target).then((item) => item.mtimeMs).catch(() => now) > STAGED_TTL_MS;
        if (old) { if (raw?.[1]) this.authority.beginDelete(raw[1], projectId, agentId); await rm(target, { force: true }); if (raw?.[1]) this.authority.finishDelete(raw[1]); removed++; }
        continue;
      }
      if (!entry.endsWith(".json") || entry === "audit.jsonl") continue;
      const id = entry.slice(0, -5);
      const asset = await this.read(projectId, agentId, id);
      if (!asset) continue;
      if (associatedIds.has(id) && asset.state !== "associated") {
        await this.associate(projectId, agentId, [id]).catch(() => undefined);
      } else if (!reachableIds.has(id) && asset.state === "staged" &&
          now - Date.parse(asset.createdAt) > STAGED_TTL_MS && await this.remove(projectId, agentId, id)) removed++;
    }
    await openedDirectory.handle.close();
    return removed;
  }

}

export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "asset";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
