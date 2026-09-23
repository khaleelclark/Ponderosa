import { randomUUID } from "node:crypto";
import { promises as fs, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { RuntimeProcessIdentity } from "@ponderosa/core";
import {
  processBirthMarker,
  recoveredRuntimeProcessHandle,
  runtimeProcessIdentity,
} from "@ponderosa/engines";

/** Process-wide recovery authority for disposable browser session storage.
 * Recovery is shared by every session manager using the same data directory;
 * new sessions can start after quarantine while deletion retries in place. */
interface BrowserResidueRecoveryState {
  attempts: number;
  running: boolean;
  lastError?: string;
  timer?: NodeJS.Timeout;
  promise?: Promise<void>;
}

interface BrowserResidueDrainState {
  attempts: number;
  running: boolean;
  lastError?: string;
  timer?: NodeJS.Timeout;
}

const browserResidueRecovery = new Map<string, BrowserResidueRecoveryState>();
const browserResidueDrains = new Map<string, BrowserResidueDrainState>();

const HOSTED_DISPLAY_RESERVATION = /^ponderosa-xvfb-(\d{1,4})\.lock$/u;
const HOSTED_DISPLAY_STALE_MS = 30_000;

interface HostedDisplayReservationRecord {
  schemaVersion: 1;
  displayNumber: number;
  createdAt: string;
  owner: RuntimeProcessIdentity;
  xvfb?: RuntimeProcessIdentity;
}

interface HostedDisplayRecoveryState {
  running: boolean;
  pending: Set<number>;
  failures: Map<number, string>;
  promise?: Promise<void>;
  timer?: NodeJS.Timeout;
}

const hostedDisplayRecovery: HostedDisplayRecoveryState = {
  running: false,
  pending: new Set(),
  failures: new Map(),
};

export interface HostedDisplayResiduePaths {
  reservationDirectory?: string;
  xLockDirectory?: string;
  socketDirectory?: string;
  minimumAgeMs?: number;
  /** Focused-test override; production status tracks only the real host paths. */
  trackStatus?: boolean;
}

function hostedDisplayPaths(displayNumber: number, paths: HostedDisplayResiduePaths = {}) {
  const reservationDirectory = paths.reservationDirectory ?? "/tmp";
  const xLockDirectory = paths.xLockDirectory ?? "/tmp";
  const socketDirectory = paths.socketDirectory ?? "/tmp/.X11-unix";
  return {
    reservation: path.join(reservationDirectory, `ponderosa-xvfb-${displayNumber}.lock`),
    cleanupClaim: path.join(reservationDirectory, `ponderosa-xvfb-${displayNumber}.cleanup`),
    xLock: path.join(xLockDirectory, `.X${displayNumber}-lock`),
    socket: path.join(socketDirectory, `X${displayNumber}`),
  };
}

function processIdentityAlive(identity: RuntimeProcessIdentity): boolean {
  const marker = processBirthMarker(identity.pid);
  return marker !== undefined && marker === identity.birthMarker;
}

function validHostedIdentity(identity: Partial<RuntimeProcessIdentity> | undefined): identity is RuntimeProcessIdentity {
  return Boolean(
    identity && Number.isSafeInteger(identity.pid) && identity.pid! > 1 &&
    Number.isSafeInteger(identity.pgid) && identity.pgid === identity.pid &&
    typeof identity.birthMarker === "string" && identity.birthMarker.length > 0,
  );
}

async function ownedArtifact(
  pathname: string,
  kind: "file" | "socket",
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  const stat = await fs.lstat(pathname).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return undefined;
  const correctKind = kind === "file" ? stat.isFile() : stat.isSocket();
  if (!correctKind || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error(`refusing to remove unowned ${kind} artifact ${pathname}`);
  }
  return stat;
}

async function reservationRecord(pathname: string): Promise<HostedDisplayReservationRecord | undefined> {
  const text = await fs.readFile(pathname, "utf8");
  if (!text.trim()) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<HostedDisplayReservationRecord>;
    if (parsed.schemaVersion !== 1 || !Number.isInteger(parsed.displayNumber) ||
        !validHostedIdentity(parsed.owner) ||
        (parsed.xvfb !== undefined && !validHostedIdentity(parsed.xvfb))) {
      return undefined;
    }
    return parsed as HostedDisplayReservationRecord;
  } catch {
    return undefined;
  }
}

async function deadLegacyXvfb(xLock: string): Promise<boolean> {
  const text = await fs.readFile(xLock, "utf8");
  const pidText = text.trim();
  if (!/^\d+$/u.test(pidText)) return false;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  const birthMarker = processBirthMarker(pid);
  if (birthMarker !== undefined) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function acquireCleanupClaim(pathname: string): Promise<boolean> {
  try {
    const handle = await fs.open(pathname, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, birthMarker: processBirthMarker(process.pid) }));
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = await ownedArtifact(pathname, "file");
    if (!stat || Date.now() - Number(stat.mtimeMs) <= HOSTED_DISPLAY_STALE_MS) return false;
    const claim: { pid?: number; birthMarker?: string } = await fs.readFile(pathname, "utf8")
      .then((text) => JSON.parse(text) as { pid?: number; birthMarker?: string }, () => ({}));
    if (claim.pid && claim.birthMarker && processBirthMarker(claim.pid) === claim.birthMarker) return false;
    await fs.rm(pathname, { force: true });
    return acquireCleanupClaim(pathname);
  }
}

async function cleanupHostedDisplayResidue(
  displayNumber: number,
  paths: HostedDisplayResiduePaths = {},
): Promise<"cleaned" | "active" | "deferred"> {
  const names = hostedDisplayPaths(displayNumber, paths);
  const reservation = await ownedArtifact(names.reservation, "file");
  if (!reservation) return "cleaned";
  if ((Number(reservation.mode) & 0o077) !== 0) {
    throw new Error(`refusing to trust permissive display reservation ${names.reservation}`);
  }
  const record = await reservationRecord(names.reservation);
  if (record?.displayNumber !== undefined && record.displayNumber !== displayNumber) {
    throw new Error(`display reservation identity mismatch for ${names.reservation}`);
  }
  if (record && processIdentityAlive(record.owner)) return "active";
  if (Date.now() - Number(reservation.mtimeMs) <= (paths.minimumAgeMs ?? HOSTED_DISPLAY_STALE_MS)) return "deferred";
  if (!await acquireCleanupClaim(names.cleanupClaim)) return "deferred";
  try {
    const xLock = await ownedArtifact(names.xLock, "file");
    const socket = await ownedArtifact(names.socket, "socket");
    if (record?.xvfb) {
      if (xLock) {
        const lockPid = Number((await fs.readFile(names.xLock, "utf8")).trim());
        if (lockPid !== record.xvfb.pid) throw new Error(`Xvfb lock identity mismatch for display :${displayNumber}`);
      }
      const currentXvfbBirth = processBirthMarker(record.xvfb.pid);
      if (currentXvfbBirth !== undefined && currentXvfbBirth !== record.xvfb.birthMarker) {
        throw new Error(`refusing Xvfb cleanup after PID ${record.xvfb.pid} was reused`);
      }
      if (currentXvfbBirth === record.xvfb.birthMarker) {
        await recoveredRuntimeProcessHandle(record.xvfb, {
          label: `orphaned Ponderosa Xvfb :${displayNumber}`,
          termGraceMs: 2_000,
          killConfirmationMs: 2_000,
        }).close();
      }
      if (processIdentityAlive(record.xvfb)) throw new Error(`orphaned Xvfb :${displayNumber} is still running`);
    } else {
      if (!xLock && !socket) {
        await fs.rm(names.reservation, { force: true });
        return "cleaned";
      }
      // Legacy reservations predate durable process identity. Only remove
      // their X artifacts when Xvfb's own lock identifies a dead process.
      // A live legacy process has no durable daemon identity, so fail closed.
      if (!xLock || !await deadLegacyXvfb(names.xLock)) return "active";
    }

    await fs.rm(names.socket, { force: true });
    await fs.rm(names.xLock, { force: true });
    await fs.rm(names.reservation, { force: true });
    return "cleaned";
  } finally {
    await fs.rm(names.cleanupClaim, { force: true });
  }
}

async function scanHostedDisplayResidue(paths: HostedDisplayResiduePaths = {}, trackStatus = true): Promise<void> {
  const directory = paths.reservationDirectory ?? "/tmp";
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const discovered = new Set<number>();
  for (const entry of entries) {
    const match = HOSTED_DISPLAY_RESERVATION.exec(entry.name);
    if (!match) continue;
    const displayNumber = Number(match[1]);
    discovered.add(displayNumber);
    if (trackStatus) hostedDisplayRecovery.pending.add(displayNumber);
    try {
      const outcome = await cleanupHostedDisplayResidue(displayNumber, paths);
      if (trackStatus && outcome !== "deferred") {
        hostedDisplayRecovery.pending.delete(displayNumber);
        hostedDisplayRecovery.failures.delete(displayNumber);
      }
    } catch (error) {
      if (!trackStatus) throw error;
      hostedDisplayRecovery.pending.delete(displayNumber);
      hostedDisplayRecovery.failures.set(displayNumber, error instanceof Error ? error.message : String(error));
    }
  }
  // Another supervised instance or an operator may safely remove a failed
  // artifact between retries. Absence from a complete scan settles that old
  // failure instead of permanently poisoning the deployment restart gate.
  if (trackStatus) {
    for (const displayNumber of hostedDisplayRecovery.failures.keys()) {
      if (!discovered.has(displayNumber)) hostedDisplayRecovery.failures.delete(displayNumber);
    }
    for (const displayNumber of hostedDisplayRecovery.pending) {
      if (!discovered.has(displayNumber)) hostedDisplayRecovery.pending.delete(displayNumber);
    }
  }
}

/** Recover only Ponderosa-reserved Xvfb displays. Ownership, exact process
 * birth, lock PID, file type, UID, and mode are verified before deletion. */
export function recoverHostedDisplayResidue(paths: HostedDisplayResiduePaths = {}): Promise<void> {
  const track = paths.trackStatus ?? (
    paths.reservationDirectory === undefined && paths.xLockDirectory === undefined && paths.socketDirectory === undefined
  );
  if (!track) return scanHostedDisplayResidue(paths, false);
  if (hostedDisplayRecovery.promise) return hostedDisplayRecovery.promise;
  hostedDisplayRecovery.running = true;
  const recovery = scanHostedDisplayResidue(paths);
  hostedDisplayRecovery.promise = recovery;
  return recovery.finally(() => {
    hostedDisplayRecovery.running = false;
    hostedDisplayRecovery.promise = undefined;
    if (hostedDisplayRecovery.failures.size === 0 && hostedDisplayRecovery.timer) {
      clearTimeout(hostedDisplayRecovery.timer);
      hostedDisplayRecovery.timer = undefined;
    }
    if ((hostedDisplayRecovery.failures.size > 0 || hostedDisplayRecovery.pending.size > 0) &&
        !hostedDisplayRecovery.timer) {
      hostedDisplayRecovery.timer = setTimeout(() => {
        hostedDisplayRecovery.timer = undefined;
        void recoverHostedDisplayResidue(paths).catch(() => undefined);
      }, 1_000);
      hostedDisplayRecovery.timer.unref?.();
    }
  });
}

export async function reserveHostedDisplay(displayNumber: number): Promise<string | undefined> {
  const names = hostedDisplayPaths(displayNumber);
  if (await fs.lstat(names.cleanupClaim).then(() => true, () => false)) return undefined;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(names.reservation, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  const birthMarker = processBirthMarker(process.pid);
  if (!birthMarker) {
    await handle.close();
    await fs.rm(names.reservation, { force: true });
    throw new Error("host process identity is unavailable for Xvfb ownership");
  }
  const record: HostedDisplayReservationRecord = {
    schemaVersion: 1,
    displayNumber,
    createdAt: new Date().toISOString(),
    owner: { pid: process.pid, pgid: process.pid, birthMarker },
  };
  await handle.writeFile(JSON.stringify(record));
  await handle.sync();
  await handle.close();
  return names.reservation;
}

export function recordHostedDisplayProcess(reservationPath: string, child: ChildProcess): void {
  const identity = runtimeProcessIdentity(child);
  if (!identity) throw new Error("Xvfb process identity is unavailable");
  let record: HostedDisplayReservationRecord | undefined;
  try {
    record = JSON.parse(readFileSync(reservationPath, "utf8")) as HostedDisplayReservationRecord;
  } catch {
    record = undefined;
  }
  if (!record || !validHostedIdentity(record.owner) || record.owner.pid !== process.pid ||
      !processIdentityAlive(record.owner)) {
    throw new Error("Xvfb reservation ownership changed before process publication");
  }
  writeFileSync(reservationPath, JSON.stringify({ ...record, xvfb: identity }), { mode: 0o600 });
}

function recoveryDirectoryPattern(root: string): RegExp {
  const base = path.basename(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${base}\\.recovery-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, "i");
}

function scheduleBrowserResidueDrain(quarantine: string): void {
  const existing = browserResidueDrains.get(quarantine);
  if (existing?.running || existing?.timer) return;
  const state = existing ?? { attempts: 0, running: false };
  state.running = true;
  state.attempts += 1;
  browserResidueDrains.set(quarantine, state);
  void fs.rm(quarantine, { recursive: true, force: true }).then(
    () => {
      if (state.timer) clearTimeout(state.timer);
      browserResidueDrains.delete(quarantine);
    },
    (error: unknown) => {
      state.running = false;
      state.lastError = error instanceof Error ? error.message : String(error);
      state.timer = setTimeout(() => {
        state.timer = undefined;
        scheduleBrowserResidueDrain(quarantine);
      }, 1_000);
      state.timer.unref?.();
    },
  );
}

export function browserResidueCleanupStatus(dataDir: string): { pending: number; failed: number } {
  const root = path.join(dataDir, "browser-sessions");
  const prefix = root + ".recovery-";
  const drains = [...browserResidueDrains.entries()].filter(([directory]) => directory.startsWith(prefix));
  const discovery = browserResidueRecovery.get(root);
  return {
    pending: drains.length + (discovery ? 1 : 0) + hostedDisplayRecovery.pending.size + Number(hostedDisplayRecovery.running),
    failed: drains.filter(([, state]) => Boolean(state.lastError)).length + (discovery?.lastError ? 1 : 0) + hostedDisplayRecovery.failures.size,
  };
}

export function browserResidueCleanupBlockers(dataDir: string): string[] {
  const root = path.join(dataDir, "browser-sessions");
  const prefix = root + ".recovery-";
  const blockers = [...browserResidueDrains.entries()]
    .filter(([directory]) => directory.startsWith(prefix))
    .map(([directory, state]) => `${path.basename(directory)}${state.lastError ? `: ${state.lastError}` : ""}`);
  const discovery = browserResidueRecovery.get(root);
  if (discovery) blockers.push(`browser-session discovery${discovery.lastError ? `: ${discovery.lastError}` : ""}`);
  for (const displayNumber of hostedDisplayRecovery.pending) blockers.push(`Xvfb :${displayNumber} cleanup pending`);
  for (const [displayNumber, error] of hostedDisplayRecovery.failures) blockers.push(`Xvfb :${displayNumber}: ${error}`);
  return blockers;
}

export function recoverBrowserResidue(dataDir: string): Promise<void> {
  const root = path.join(dataDir, "browser-sessions");
  const existing = browserResidueRecovery.get(root);
  if (existing?.promise) return existing.promise;
  const state = existing ?? { attempts: 0, running: false };
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
  state.running = true;
  state.attempts += 1;
  browserResidueRecovery.set(root, state);
  const recovery = (async () => {
    await recoverHostedDisplayResidue();
    const parent = path.dirname(root);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const recoveryPattern = recoveryDirectoryPattern(root);
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && recoveryPattern.test(entry.name)) {
        scheduleBrowserResidueDrain(path.join(parent, entry.name));
      }
    }
    const quarantine = root + ".recovery-" + randomUUID();
    let quarantined = false;
    try {
      await fs.rename(root, quarantine);
      quarantined = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if (quarantined) {
      // Draining stale profiles must never reject without an observer or block
      // a new browser authority from becoming available. Failed drains remain
      // visible to this authority and retry without poisoning future opens.
      scheduleBrowserResidueDrain(quarantine);
    }
  })();
  state.promise = recovery;
  return recovery.then(
    () => {
      if (browserResidueRecovery.get(root) !== state) return;
      if (state.timer) clearTimeout(state.timer);
      browserResidueRecovery.delete(root);
    },
    (error: unknown) => {
      if (browserResidueRecovery.get(root) === state) {
        state.running = false;
        state.promise = undefined;
        state.lastError = error instanceof Error ? error.message : String(error);
        state.timer = setTimeout(() => {
          state.timer = undefined;
          void recoverBrowserResidue(dataDir).catch(() => undefined);
        }, 1_000);
        state.timer.unref?.();
      }
      throw error;
    },
  );
}
