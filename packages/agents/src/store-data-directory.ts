import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const DATA_DIRECTORY_LOCK_FILE = ".ponderosa-daemon.lock";
const DATA_LAYOUT_MARKER_FILE = ".ponderosa-layout-version";
const DATA_DIRECTORY_LOCK_STAGE_PREFIX = `${DATA_DIRECTORY_LOCK_FILE}.`;

interface DataDirectoryOwnership {
  path: string;
  token: string;
}

function readOwnership(path: string): { pid: number; token: string } {
  const bytes = readFileSync(path, "utf8");
  let owner: unknown;
  try { owner = JSON.parse(bytes); }
  catch {
    throw new Error("data directory ownership lock is incomplete or malformed; refusing to replace it");
  }
  if (!owner || typeof owner !== "object" || Array.isArray(owner) ||
      !Number.isSafeInteger((owner as { pid?: unknown }).pid) ||
      (owner as { pid: number }).pid <= 0 ||
      typeof (owner as { token?: unknown }).token !== "string" ||
      !(owner as { token: string }).token) {
    throw new Error("data directory ownership lock is incomplete or malformed; refusing to replace it");
  }
  return owner as { pid: number; token: string };
}

function fsyncDataDirectory(dataDir: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(dataDir, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function acquireDataDirectoryOwnership(dataDir: string): DataDirectoryOwnership {
  const path = join(dataDir, DATA_DIRECTORY_LOCK_FILE);
  const token = randomUUID();
  const stagingPath = join(dataDir, `${DATA_DIRECTORY_LOCK_STAGE_PREFIX}${token}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(stagingPath, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify({
      pid: process.pid,
      token,
      createdAt: new Date().toISOString(),
    }), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // A hard link publishes the already-fsynced bytes as one atomic
        // directory entry on every supported local filesystem. Contenders can
        // therefore never observe and steal an empty or partially written lock.
        linkSync(stagingPath, path);
        fsyncDataDirectory(dataDir);
        return { path, token };
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
        if (code !== "EEXIST") throw error;
      }

      let owner: { pid: number; token: string };
      try { owner = readOwnership(path); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      let stale = false;
      try { process.kill(owner.pid, 0); }
      catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
        if (code === "ESRCH") stale = true;
        else if (code !== "EPERM") {
          throw new Error("could not verify data directory ownership", { cause: error });
        }
      }
      if (!stale) throw new Error(`data directory is already owned by Ponderosa process ${owner.pid}`);

      // Remove only the exact stale record we inspected. A changed token means
      // another contender already recovered ownership and must be preserved.
      let current: { pid: number; token: string };
      try { current = readOwnership(path); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      if (current.token !== owner.token) continue;
      rmSync(path, { force: true });
      fsyncDataDirectory(dataDir);
    }
    throw new Error("could not acquire exclusive Ponderosa data-directory ownership");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(stagingPath, { force: true });
  }
}

function releaseDataDirectoryOwnership(ownership: DataDirectoryOwnership | undefined): void {
  if (!ownership) return;
  try {
    const current = readOwnership(ownership.path);
    if (current.token === ownership.token) {
      rmSync(ownership.path, { force: true });
      fsyncDataDirectory(dirname(ownership.path));
    }
  } catch { /* a missing, malformed, or replaced lock is no longer ours */ }
}

function ensureCurrentDataLayout(dataDir: string): void {
  const marker = join(dataDir, DATA_LAYOUT_MARKER_FILE);
  if (existsSync(marker)) {
    const version = readFileSync(marker, "utf8").trim();
    if (version === "1") return;
    throw new Error(`unsupported Ponderosa data layout version: ${version || "empty"}`);
  }

  const existingEntries = readdirSync(dataDir).filter(entry =>
    entry !== DATA_DIRECTORY_LOCK_FILE &&
    !(entry.startsWith(DATA_DIRECTORY_LOCK_STAGE_PREFIX) && entry.endsWith(".tmp")));
  if (existingEntries.length > 0) {
    throw new Error(
      "Ponderosa data directory is nonempty but has no layout marker; refusing to modify existing data",
    );
  }
  writeFileSync(marker, "1\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export { acquireDataDirectoryOwnership, releaseDataDirectoryOwnership, ensureCurrentDataLayout };
export type { DataDirectoryOwnership };
