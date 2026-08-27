import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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
    pending: drains.length + (discovery ? 1 : 0),
    failed: drains.filter(([, state]) => Boolean(state.lastError)).length + (discovery?.lastError ? 1 : 0),
  };
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
