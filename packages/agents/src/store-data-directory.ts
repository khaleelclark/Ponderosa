import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const DATA_DIRECTORY_LOCK_FILE = ".ponderosa-daemon.lock";
const DATA_LAYOUT_MARKER_FILE = ".ponderosa-layout-version";

interface DataDirectoryOwnership {
  path: string;
  token: string;
}

function acquireDataDirectoryOwnership(dataDir: string): DataDirectoryOwnership {
  const path = join(dataDir, DATA_DIRECTORY_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), "utf8");
      } finally {
        closeSync(descriptor);
      }
      return { path, token };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      if (code !== "EEXIST") throw error;
      let owner: { pid?: number; token?: string } = {};
      try { owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; token?: string }; } catch { /* stale malformed lock */ }
      let alive = false;
      if (Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
        try { process.kill(owner.pid!, 0); alive = true; } catch { /* stale owner */ }
      }
      if (alive) throw new Error(`data directory is already owned by Ponderosa process ${owner.pid}`);
      // Remove only the stale record we inspected; a changed token means
      // another contender already acquired ownership.
      try {
        const current = JSON.parse(readFileSync(path, "utf8")) as { token?: string };
        if (current.token !== owner.token) continue;
      } catch { /* malformed stale record remains removable */ }
      rmSync(path, { force: true });
    }
  }
  throw new Error("could not acquire exclusive Ponderosa data-directory ownership");
}

function releaseDataDirectoryOwnership(ownership: DataDirectoryOwnership | undefined): void {
  if (!ownership) return;
  try {
    const current = JSON.parse(readFileSync(ownership.path, "utf8")) as { token?: string };
    if (current.token === ownership.token) rmSync(ownership.path, { force: true });
  } catch { /* a missing/replaced lock is no longer ours */ }
}

function ensureCurrentDataLayout(dataDir: string): void {
  const marker = join(dataDir, DATA_LAYOUT_MARKER_FILE);
  if (existsSync(marker)) {
    const version = readFileSync(marker, "utf8").trim();
    if (version === "1") return;
    throw new Error(`unsupported Ponderosa data layout version: ${version || "empty"}`);
  }

  const existingEntries = readdirSync(dataDir).filter(entry => entry !== DATA_DIRECTORY_LOCK_FILE);
  if (existingEntries.length > 0) {
    throw new Error(
      "Ponderosa data directory is nonempty but has no layout marker; refusing to modify existing data",
    );
  }
  writeFileSync(marker, "1\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export { acquireDataDirectoryOwnership, releaseDataDirectoryOwnership, ensureCurrentDataLayout };
export type { DataDirectoryOwnership };
