import { fsyncDirectory } from "./store-filesystem.js";
import { createHash, randomUUID, type Hash } from "node:crypto";
import {
  closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, readdirSync, readSync, renameSync, rmSync, writeFileSync,
} from "@ponderosa/native-host/fs";
import path from "node:path";
import type Database from "better-sqlite3";

const CHECKPOINT_FILE = ".projection-clean-shutdown.json";
// Bump whenever projection semantics change without a schema marker.
const PROJECTION_CHECKPOINT_VERSION = 4;
const NON_CANONICAL_ROOTS = new Set([
  "workspaces", "working-copies", "browser-profiles", "browser-sessions", "diagnostics", "launcher-state",
  // Separate owners validate/recover these physical bytes and host identity;
  // none are inputs to the authored-history SQLite projectors.
  "host-secrets", "draft-attachments", "runtime-attachments", "retained-browser-sessions",
]);
const NON_CANONICAL_FILES = new Set([
  CHECKPOINT_FILE, ".ponderosa-daemon.lock", "ponderosa.db", "ponderosa.db-shm", "ponderosa.db-wal",
  // These journals are independently replayed by WorkspaceStore/ContextCursorStore;
  // they never feed AgentStore's SQLite projections.
  "workspace-events.jsonl", "context-cursors.jsonl", "engine-availability.jsonl",
]);
// V3 coordination/Run authority is deliberately absent: only rebuildable views
// and canonical visibility changes invalidate unaccounted projection writes.
const PROJECTION_TABLES = [
  "projects", "conversations", "agents", "agent_presets", "agent_handle_reservations",
  "agent_conversation_memberships", "events", "messages", "runs", "work_items", "artifacts",
  "continuation_handoffs", "activity_projection", "changed_file_projection",
  "changed_file_execution_projection", "managed_artifact_projection", "imported_history_messages", "imported_history_indexes",
  "chat_search_messages", "all_chat_feed_projection", "agent_health_projection",
  "agent_event_head_projection", "tool_output_projection", "run_output_heads", "run_output_segments",
  "compaction_history_messages", "compaction_history_agent_participants",
  "compaction_history_relation_candidates", "conversation_deletion_receipts",
];
const TAIL_PATH = /^projects\/[^/.][^/]*\/(?:communication-(?:events|revisions|projections)\.jsonl|agents\/[^/.][^/]*\/events\.jsonl)$/u;
type Signature = [number, number, number, number, number]; // size, mtime, ctime, device, inode
export type ProjectionTail = { path: string; offset: number; sha256: string };
type Checkpoint = {
  schemaVersion: 2;
  projectionVersion: number;
  schemaFingerprint: string;
  canonicalFingerprint: string;
  databaseSignature: Signature;
  tails: ProjectionTail[];
  writtenAt: string;
};
type Receipt = { path: string; signature: string; offset: number; sha256: string | null };
type Prefix = { signature: string; hash: Hash };

function signature(filename: string): Signature | null {
  try {
    const stat = lstatSync(filename);
    if (!stat.isFile()) throw new Error("projection source is not a regular file");
    return [stat.size, stat.mtimeMs, stat.ctimeMs, Number(stat.dev), Number(stat.ino)];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function schemaFingerprint(client: Database.Database): string {
  const names = (client.prepare(`SELECT name FROM _schema_version ORDER BY name`).all() as Array<{ name: string }>).map(row => row.name);
  return createHash("sha256").update(JSON.stringify(names)).digest("hex");
}

function sourceInventory(dataDir: string): Map<string, Signature> {
  const sources = new Map<string, Signature>();
  const visit = (relative: string): void => {
    const filename = path.join(dataDir, relative), stat = lstatSync(filename);
    if (stat.isDirectory()) {
      const parts = relative.split(path.sep);
      if (parts[0] === "projects" && (
        (parts.length === 4 && parts[2] === "artifacts" && parts[3] === "content") ||
        (parts.length === 5 && parts[2] === "agents" && (parts[4] === "artifacts" || parts[4] === "attachments"))
      )) return;
      for (const child of readdirSync(filename).sort()) visit(path.join(relative, child));
    } else if (stat.isSymbolicLink()) {
      throw new Error("projection source inventory contains a symbolic link");
    } else if (stat.isFile() && (relative.endsWith(".json") || relative.endsWith(".jsonl"))) {
      const normalized = relative.split(path.sep).join("/");
      // This failure audit is never consumed by any projector. Its creation
      // must not conceal the separately verified canonical event-log suffix.
      if (/^projects\/[^/]+\/agents\/[^/]+\/event-persistence-failures\.jsonl$/u.test(normalized)) return;
      sources.set(normalized, [stat.size, stat.mtimeMs, stat.ctimeMs, Number(stat.dev), Number(stat.ino)]);
    }
  };
  for (const child of readdirSync(dataDir).sort()) if (!NON_CANONICAL_ROOTS.has(child) && !NON_CANONICAL_FILES.has(child)) visit(child);
  return sources;
}
function fingerprint(sources: Map<string, Signature>): string {
  return createHash("sha256").update(JSON.stringify([...sources].sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}
/** Metadata-only inventory excludes working files and artifact bytes, never authored journals. */
export function projectionSourceFingerprint(dataDir: string): string { return fingerprint(sourceInventory(dataDir)); }

function pendingRecovery(client: Database.Database): boolean {
  for (const table of ["project_deletion_pending", "agent_deletion_pending"]) {
    if (client.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return true;
  }
  if (client.prepare(`SELECT 1 FROM agent_creation_operations WHERE status NOT IN ('completed', 'rolled_back') LIMIT 1`).get()) return true;
  for (const table of ["project_deletion_receipts", "agent_deletion_receipts", "conversation_deletion_receipts"]) {
    if (client.prepare(`SELECT 1 FROM ${table} WHERE completed_at IS NULL LIMIT 1`).get()) return true;
  }
  return false;
}
function stagingPresent(dataDir: string): boolean {
  // Only canonical topology roots; never walk working-folder dependency trees.
  const projects = path.join(dataDir, "projects");
  if (!existsSync(projects)) return false;
  for (const project of readdirSync(projects, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    if (project.name.endsWith(".creating")) return true;
    for (const owner of ["agents", "conversations"]) {
      const directory = path.join(projects, project.name, owner);
      if (existsSync(directory) && readdirSync(directory, { withFileTypes: true }).some(entry => entry.isDirectory() && entry.name.endsWith(".creating"))) return true;
    }
  }
  return false;
}
function extendHash(filename: string, hash: Hash, start: number, end: number): Hash {
  const result = hash.copy(), descriptor = openSync(filename, "r"), buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    if (fstatSync(descriptor).size < end) throw new Error("projection source shrank while hashing");
    for (let position = start; position < end;) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, end - position), position);
      if (!count) throw new Error("projection source ended while hashing");
      result.update(buffer.subarray(0, count)); position += count;
    }
  } finally { closeSync(descriptor); }
  return result;
}
function prefixHash(filename: string, size: number): Hash { return extendHash(filename, createHash("sha256"), 0, size); }
function digest(hash: Hash): string { return hash.copy().digest("hex"); }
function ftsConsistent(client: Database.Database): boolean {
  const expected = `SELECT m.rowid,m.project_id,m.communication_event_id,m.text
    FROM compaction_history_messages m WHERE m.conversation_id IS NULL OR EXISTS (
      SELECT 1 FROM conversations c WHERE c.id=m.conversation_id AND c.project_id=m.project_id
      AND NOT EXISTS (SELECT 1 FROM conversation_deletion_receipts d WHERE d.conversation_id=c.id))`;
  const actual = `SELECT rowid,project_id,communication_event_id,text FROM compaction_history_fts`;
  if (client.prepare(`SELECT 1 FROM (${expected} EXCEPT ${actual}) LIMIT 1`).get() ||
      client.prepare(`SELECT 1 FROM (${actual} EXCEPT ${expected}) LIMIT 1`).get()) return false;
  client.prepare(`INSERT INTO compaction_history_fts(compaction_history_fts) VALUES ('integrity-check')`).run();
  return true;
}
function emptyWal(dataDir: string): boolean {
  const wal = signature(path.join(dataDir, "ponderosa.db-wal"));
  return !wal || wal[0] === 0;
}
function saveCheckpoint(dataDir: string, checkpoint: Checkpoint): void {
  const target = path.join(dataDir, CHECKPOINT_FILE), temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(checkpoint)}\n`, { flag: "wx", mode: 0o600 });
    const descriptor = openSync(temporary, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, target); fsyncDirectory(dataDir);
  } finally { rmSync(temporary, { force: true }); }
}

/** Consume before serving. A crash leaves no certificate, forcing full recovery. */
export function consumeProjectionCheckpoint(dataDir: string, client: Database.Database): false | { tails: ProjectionTail[] } {
  const filename = path.join(dataDir, CHECKPOINT_FILE);
  if (!existsSync(filename)) return false;
  let checkpoint: Checkpoint | undefined;
  try { checkpoint = JSON.parse(readFileSync(filename, "utf8")) as Checkpoint; } catch { /* invalid proof falls back */ }
  rmSync(filename, { force: true }); fsyncDirectory(dataDir);
  try {
    if (!checkpoint || checkpoint.schemaVersion !== 2 || checkpoint.projectionVersion !== PROJECTION_CHECKPOINT_VERSION ||
        checkpoint.schemaFingerprint !== schemaFingerprint(client) || !Array.isArray(checkpoint.tails) ||
        checkpoint.canonicalFingerprint !== projectionSourceFingerprint(dataDir) ||
        !same(checkpoint.databaseSignature, signature(path.join(dataDir, "ponderosa.db"))) || !emptyWal(dataDir) ||
        pendingRecovery(client) || stagingPresent(dataDir)) return false;
    const paths = new Set<string>();
    for (const tail of checkpoint.tails) {
      if (!tail || typeof tail.path !== "string" || !TAIL_PATH.test(tail.path) || paths.has(tail.path) ||
          !Number.isSafeInteger(tail.offset) || tail.offset < 0 || !/^[a-f0-9]{64}$/u.test(tail.sha256)) return false;
      paths.add(tail.path);
      const stat = signature(path.join(dataDir, tail.path));
      if (!stat || stat[0] <= tail.offset || digest(prefixHash(path.join(dataDir, tail.path), tail.offset)) !== tail.sha256) return false;
    }
    return client.pragma("quick_check", { simple: true }) === "ok" ? { tails: checkpoint.tails } : false;
  } catch { return false; }
}

/** Connection-local proof only: no main-schema changes and no V3 authority replay. */
export class ProjectionProgress {
  private initialized = false;
  private invalid = false;
  private dataVersion = 0;
  private readonly hashes = new Map<string, Prefix>();
  private readonly frames: Array<Map<string, Prefix>> = [];
  constructor(private readonly dataDir: string, private readonly client: Database.Database) {
    client.exec(`CREATE TEMP TABLE IF NOT EXISTS projection_progress_sources(path TEXT PRIMARY KEY,signature TEXT NOT NULL,offset INTEGER NOT NULL,sha256 TEXT);
      CREATE TEMP TABLE IF NOT EXISTS projection_progress_generation(generation INTEGER NOT NULL,covered_generation INTEGER NOT NULL);
      INSERT INTO projection_progress_generation SELECT 0,0 WHERE NOT EXISTS(SELECT 1 FROM projection_progress_generation);`);
    const tables = new Set((client.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(row => row.name));
    for (const table of PROJECTION_TABLES) if (tables.has(table)) for (const action of ["INSERT", "UPDATE", "DELETE"]) {
      client.exec(`CREATE TEMP TRIGGER IF NOT EXISTS projection_progress_${table}_${action} AFTER ${action} ON main.${table}
        BEGIN UPDATE projection_progress_generation SET generation=generation+1; END;`);
    }
  }
  private generation(): { generation: number; covered_generation: number } {
    return this.client.prepare(`SELECT generation,covered_generation FROM projection_progress_generation`).get() as { generation: number; covered_generation: number };
  }
  private receipt(relative: string): Receipt | undefined {
    return this.client.prepare(`SELECT path,signature,offset,sha256 FROM projection_progress_sources WHERE path=?`).get(relative) as Receipt | undefined;
  }
  private cache(relative: string, value: Prefix): void {
    for (const frame of this.frames) if (!frame.has(relative)) frame.set(relative, this.hashes.get(relative) ?? value);
    this.hashes.set(relative, value);
  }
  private relative(filename: string): string {
    const relative = path.relative(path.resolve(this.dataDir), path.resolve(this.dataDir, filename)).split(path.sep).join("/");
    if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("projection source is outside admitted storage");
    return relative;
  }
  private prepare(relative: string): void {
    let receipt = this.receipt(relative);
    const current = signature(path.join(this.dataDir, relative)), encoded = JSON.stringify(current);
    if (receipt ? receipt.signature !== encoded : current !== null) this.invalid = true;
    if (!receipt) {
      receipt = { path: relative, signature: "null", offset: 0, sha256: null };
      this.client.prepare(`INSERT INTO projection_progress_sources(path,signature,offset,sha256) VALUES(?,?,?,NULL)`).run(relative, "null", 0);
    }
    if (TAIL_PATH.test(relative) && !this.invalid && this.hashes.get(relative)?.signature !== receipt.signature) {
      const hash = current ? prefixHash(path.join(this.dataDir, relative), receipt.offset) : createHash("sha256");
      this.cache(relative, { signature: receipt.signature, hash });
      this.client.prepare(`UPDATE projection_progress_sources SET sha256=? WHERE path=?`).run(digest(hash), relative);
    }
  }
  /** Call only after verified recovery, including all planned tails and deletion/creation owners. */
  initialize(): void {
    if (pendingRecovery(this.client) || stagingPresent(this.dataDir)) throw new Error("projection progress refused while recovery is pending");
    const inventory = sourceInventory(this.dataDir);
    this.client.transaction(() => {
      this.client.prepare(`DELETE FROM projection_progress_sources`).run();
      const insert = this.client.prepare(`INSERT INTO projection_progress_sources(path,signature,offset,sha256) VALUES(?,?,?,NULL)`);
      for (const [relative, stat] of inventory) insert.run(relative, JSON.stringify(stat), stat[0]);
      this.client.prepare(`UPDATE projection_progress_generation SET covered_generation=generation`).run();
    })();
    this.dataVersion = this.client.pragma("data_version", { simple: true }) as number;
    this.hashes.clear(); this.invalid = false; this.initialized = true;
  }
  /** An accepted owner write failed outside its projection transaction. */
  invalidate(): void { this.invalid = true; }
  run<T>(filenames: string[], work: () => T): T {
    if (!this.initialized) return work();
    const outermost = this.frames.length === 0, generation = this.generation();
    if (outermost && generation.generation !== generation.covered_generation) this.invalid = true;
    const frame = new Map<string, Prefix>(), sources = [...new Set(filenames.map(filename => this.relative(filename)))];
    this.frames.push(frame);
    try {
      // Prefix evidence is captured before the canonical append, and survives
      // a failed projection even when its transactional receipt is rolled back.
      for (const relative of sources) this.prepare(relative);
      return this.client.transaction(() => {
        const result = work();
        if (result && typeof (result as { then?: unknown }).then === "function") {
          this.invalid = true; throw new Error("projection progress requires a synchronous owner");
        }
        if (!this.invalid) for (const relative of sources) {
          const current = signature(path.join(this.dataDir, relative)), receipt = this.receipt(relative)!;
          if (receipt.signature === JSON.stringify(current)) continue;
          let sha256: string | null = null;
          if (TAIL_PATH.test(relative) && current) {
            const prior = JSON.parse(receipt.signature) as Signature | null, cached = this.hashes.get(relative);
            if (!cached || cached.signature !== receipt.signature || (prior && (current[3] !== prior[3] || current[4] !== prior[4] || current[0] < prior[0]))) {
              this.invalid = true; break;
            }
            const hash = extendHash(path.join(this.dataDir, relative), cached.hash, receipt.offset, current[0]);
            sha256 = digest(hash); this.cache(relative, { signature: JSON.stringify(current), hash });
          }
          this.client.prepare(`UPDATE projection_progress_sources SET signature=?,offset=?,sha256=? WHERE path=?`)
            .run(JSON.stringify(current), current?.[0] ?? 0, sha256, relative);
        }
        if (!this.invalid) this.client.prepare(`UPDATE projection_progress_generation SET covered_generation=generation`).run();
        return result;
      })();
    } catch (error) {
      // A parent that catches its child's projection failure cannot certify
      // that child's canonical bytes merely by returning successfully.
      if (!outermost) this.invalid = true;
      for (const [relative, prior] of frame) this.hashes.set(relative, prior);
      throw error;
    } finally { this.frames.pop(); }
  }
  checkpoint(): void {
    if (this.client.inTransaction) throw new Error("projection checkpoint refused before its outer transaction committed");
    if (!this.initialized || this.invalid || this.frames.length || pendingRecovery(this.client) || stagingPresent(this.dataDir)) throw new Error("projection checkpoint refused while progress is uncertain");
    const generation = this.generation();
    if (generation.generation !== generation.covered_generation || this.client.pragma("data_version", { simple: true }) !== this.dataVersion) throw new Error("projection checkpoint refused after an unaccounted SQLite write");
    const inventory = sourceInventory(this.dataDir), receipts = new Map((this.client.prepare(`SELECT path,signature,offset,sha256 FROM projection_progress_sources`).all() as Receipt[]).map(row => [row.path, row]));
    // An outer rollback can remove a newly created source's TEMP receipt; its
    // captured empty prefix remains valid evidence, never a blanket refresh.
    for (const [relative, prefix] of this.hashes) if (!receipts.has(relative) && prefix.signature === "null") receipts.set(relative, { path: relative, signature: "null", offset: 0, sha256: digest(prefix.hash) });
    const tails: ProjectionTail[] = [];
    for (const relative of new Set([...inventory.keys(), ...receipts.keys()])) {
      const receipt = receipts.get(relative), current = inventory.get(relative) ?? null;
      if (receipt && receipt.signature === JSON.stringify(current)) continue;
      const prior = receipt && JSON.parse(receipt.signature) as Signature | null, cached = this.hashes.get(relative);
      const sha256 = receipt?.sha256 ?? (cached && cached.signature === receipt?.signature ? digest(cached.hash) : undefined);
      if (!receipt || !current || !TAIL_PATH.test(relative) || !sha256 || current[0] <= receipt.offset ||
          (prior && (current[3] !== prior[3] || current[4] !== prior[4])) ||
          digest(prefixHash(path.join(this.dataDir, relative), receipt.offset)) !== sha256) throw new Error("projection checkpoint refused after an unaccounted canonical change");
      tails.push({ path: relative, offset: receipt.offset, sha256 });
    }
    if (this.client.pragma("quick_check", { simple: true }) !== "ok" || !ftsConsistent(this.client)) throw new Error("projection checkpoint refused because projection integrity failed");
    const checkpoint = this.client.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>;
    if (checkpoint.some(row => row.busy || row.log !== row.checkpointed) || !emptyWal(this.dataDir) || this.client.pragma("data_version", { simple: true }) !== this.dataVersion) throw new Error("projection checkpoint refused because SQLite did not quiesce");
    const databaseSignature = signature(path.join(this.dataDir, "ponderosa.db"));
    if (!databaseSignature || !same([...inventory], [...sourceInventory(this.dataDir)])) throw new Error("projection checkpoint refused because storage changed while certifying");
    saveCheckpoint(this.dataDir, { schemaVersion: 2, projectionVersion: PROJECTION_CHECKPOINT_VERSION,
      schemaFingerprint: schemaFingerprint(this.client), canonicalFingerprint: fingerprint(inventory), databaseSignature, tails,
      writtenAt: new Date().toISOString() });
  }
}
