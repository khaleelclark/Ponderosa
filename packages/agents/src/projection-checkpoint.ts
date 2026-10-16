import { fsyncDirectory } from "./store-filesystem.js";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "@ponderosa/native-host/fs";
import path from "node:path";
import type Database from "better-sqlite3";

const CHECKPOINT_FILE = ".projection-clean-shutdown.json";
// Bump whenever projection semantics change without a schema marker.
const PROJECTION_CHECKPOINT_VERSION = 2;
const NON_CANONICAL_ROOTS = new Set(["browser-sessions", "diagnostics", "launcher-state"]);
const NON_CANONICAL_FILES = new Set([
  CHECKPOINT_FILE,
  ".ponderosa-daemon.lock",
  "ponderosa.db",
  "ponderosa.db-shm",
  "ponderosa.db-wal",
]);

type ProjectionCheckpoint = {
  schemaVersion: 1;
  projectionVersion: number;
  schemaFingerprint: string;
  canonicalFingerprint: string;
  writtenAt: string;
};

function schemaFingerprint(client: Database.Database): string {
  const names = (client.prepare(`SELECT name FROM _schema_version ORDER BY name`).all() as Array<{ name: string }>)
    .map((row) => row.name);
  return createHash("sha256").update(JSON.stringify(names)).digest("hex");
}

/** Bind the fast path to every JSON/JSONL projection source. Binary artifacts,
 * browser profiles, diagnostics and SQLite are not projection authority. File
 * identity metadata is enough for the graceful-shutdown fast path: canonical
 * writers replace or append these files and therefore change size, mtime,
 * ctime, or inode identity. Avoiding content hashing keeps clean startup and
 * shutdown independent of multi-gigabyte history size. */
export function projectionSourceFingerprint(dataDir: string): string {
  const records: Array<[string, number, number, number, number, number]> = [];
  const visit = (relative: string): void => {
    const pathname = path.join(dataDir, relative);
    const stat = lstatSync(pathname);
    if (stat.isDirectory()) {
      for (const child of readdirSync(pathname).sort()) visit(path.join(relative, child));
      return;
    }
    if (!stat.isFile() || (!relative.endsWith(".json") && !relative.endsWith(".jsonl"))) return;
    records.push([
      relative,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
      Number(stat.dev),
      Number(stat.ino),
    ]);
  };
  for (const child of readdirSync(dataDir).sort()) {
    if (NON_CANONICAL_ROOTS.has(child) || NON_CANONICAL_FILES.has(child)) continue;
    visit(child);
  }
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

function pendingRecovery(client: Database.Database): boolean {
  for (const table of ["project_deletion_pending", "agent_deletion_pending"]) {
    if (client.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return true;
  }
  return false;
}

/** Consume before serving. A crash leaves no reusable marker, forcing replay. */
export function consumeProjectionCheckpoint(
  dataDir: string,
  client: Database.Database,
): boolean {
  const checkpointPath = path.join(dataDir, CHECKPOINT_FILE);
  if (!existsSync(checkpointPath)) return false;
  let checkpoint: ProjectionCheckpoint | undefined;
  try {
    checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as ProjectionCheckpoint;
  } catch {
    checkpoint = undefined;
  }
  rmSync(checkpointPath, { force: true });
  fsyncDirectory(dataDir);
  if (!checkpoint || checkpoint.schemaVersion !== 1 ||
      checkpoint.projectionVersion !== PROJECTION_CHECKPOINT_VERSION ||
      checkpoint.schemaFingerprint !== schemaFingerprint(client) ||
      checkpoint.canonicalFingerprint !== projectionSourceFingerprint(dataDir) ||
      pendingRecovery(client)) return false;
  return client.pragma("quick_check", { simple: true }) === "ok";
}

export function writeProjectionCheckpoint(
  dataDir: string,
  client: Database.Database,
): void {
  if (pendingRecovery(client)) {
    throw new Error("projection checkpoint refused while recovery is pending");
  }
  if (client.pragma("quick_check", { simple: true }) !== "ok") {
    throw new Error("projection checkpoint refused because SQLite integrity check failed");
  }
  client.pragma("wal_checkpoint(TRUNCATE)");
  const checkpoint: ProjectionCheckpoint = {
    schemaVersion: 1,
    projectionVersion: PROJECTION_CHECKPOINT_VERSION,
    schemaFingerprint: schemaFingerprint(client),
    canonicalFingerprint: projectionSourceFingerprint(dataDir),
    writtenAt: new Date().toISOString(),
  };
  const target = path.join(dataDir, CHECKPOINT_FILE);
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(checkpoint)}\n`, { flag: "wx", mode: 0o600 });
  const descriptor = openSync(temporary, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporary, target);
  fsyncDirectory(dataDir);
}
