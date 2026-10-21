import {
  closeSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "@ponderosa/native-host/fs";
import { randomUUID } from "node:crypto";
import { ensureDataLayout } from "./paths.js";
import { setTimeout as delay } from "node:timers/promises";
import { currentPonderosaStatus, processAlive, stopPonderosa, withLocalLauncherAuthority } from "./control.js";
import type { LauncherPaths } from "./types.js";

interface EngineSupervisorReceipt {
  pid: number;
  token: string;
  startedAt: string;
}

function readReceipt(pathname: string): EngineSupervisorReceipt | undefined {
  try {
    const receipt = JSON.parse(readFileSync(pathname, "utf8")) as Partial<EngineSupervisorReceipt>;
    if (
      !Number.isSafeInteger(receipt.pid) ||
      receipt.pid! <= 0 ||
      typeof receipt.token !== "string" ||
      typeof receipt.startedAt !== "string"
    ) return undefined;
    return receipt as EngineSupervisorReceipt;
  } catch {
    return undefined;
  }
}

function acquireSupervisorLease(pathname: string): ((heldPathname: string) => void) | undefined {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(pathname, "wx", 0o600);
      const receipt: EngineSupervisorReceipt = {
        pid: process.pid,
        token: randomUUID(),
        startedAt: new Date().toISOString(),
      };
      try {
        writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      } finally {
        closeSync(descriptor);
      }
      return (heldPathname) => {
        const current = readReceipt(heldPathname);
        if (current?.pid === receipt.pid && current.token === receipt.token) {
          rmSync(heldPathname, { force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readReceipt(pathname);
      if (current && processAlive(current.pid)) return undefined;
      try {
        // Do not unlink another launcher between its exclusive create and
        // receipt write. A genuinely stale or corrupt receipt is recoverable.
        if (!current && Date.now() - statSync(pathname).mtimeMs < 5_000) {
          return undefined;
        }
      } catch {
        // A concurrent release is handled by the retry.
      }
      if (!current) throw new Error("unprovable supervisor receipt is preserved");
      rmSync(pathname, { force: true });
    }
  }
  return undefined;
}

type PreparedSupervisor = object;
const prepared = new WeakMap<PreparedSupervisor, { release(pathname: string): void; identity: { generationId: string; dataIdentity: string; parentIdentity: string } }>();
/** The file receipt is created in a separate admitted local phase before start.
 * No canonical write occurs in the interval before child admission/spawn. */
export async function prepareEngineSupervision(paths: LauncherPaths): Promise<PreparedSupervisor | undefined> {
  const running = await currentPonderosaStatus(paths);
  if (running?.healthy) {
    const existing = readReceipt(paths.engineSupervisorPath);
    if (existing && processAlive(existing.pid)) return undefined;
    throw new Error("live daemon supervision has no inherited local file authority; use its existing controls");
  }
  return withLocalLauncherAuthority(paths, (held, identity) => {
    ensureDataLayout(held);
    const release = acquireSupervisorLease(held.engineSupervisorPath);
    if (!release) return undefined;
    const handle = {};
    prepared.set(handle, { release, identity });
    return handle;
  });
}
async function releasePrepared(paths: LauncherPaths, handle: PreparedSupervisor): Promise<void> {
  const issued = prepared.get(handle);
  if (!issued) throw new Error("supervisor requires a locally issued lifecycle");
  // A competing live owner refuses. Unknown bytes are retained for inspection.
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await withLocalLauncherAuthority(paths, held => issued.release(held.engineSupervisorPath), issued.identity);
      break;
    } catch (error) {
      // An external launcher may still hold its short post-shutdown cleanup lease.
      if ((error as NodeJS.ErrnoException).code !== "DATA_DIRECTORY_OWNED" || Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
  prepared.delete(handle);
}

/**
 * Keeps the installed desktop entry alive while its detached server is alive.
 * Closing the browser control window does not affect this process. An explicit
 * desktop quit signal asks the authoritative launcher to stop the server and
 * its provider processes before the Engine process exits.
 */
export async function supervisePonderosaEngine(paths: LauncherPaths, handle?: PreparedSupervisor): Promise<"supervised" | "already_supervised"> {
  if (!handle) {
    const current = await currentPonderosaStatus(paths);
    const existing = current?.healthy ? readReceipt(paths.engineSupervisorPath) : undefined;
    if (existing && processAlive(existing.pid)) return "already_supervised";
    throw new Error("supervisor lifecycle was not prepared under local current admission");
  }
  if (!prepared.has(handle)) throw new Error("unissued supervisor lifecycle");
  const parentPid = Number(process.env.PONDEROSA_ENGINE_PARENT_PID);
  const monitoredParentPid =
    Number.isSafeInteger(parentPid) && parentPid > 0
      ? parentPid
      : undefined;

  let quitRequested = false;
  let wake: (() => void) | undefined;
  const requestQuit = (): void => {
    quitRequested = true;
    wake?.();
  };
  process.once("SIGINT", requestQuit);
  process.once("SIGTERM", requestQuit);
  const requestedByDesktop = (message: unknown): void => {
    if (message && typeof message === "object" && "type" in message && message.type === "ponderosa-engine-stop") requestQuit();
  };
  process.on("message", requestedByDesktop);
  if (monitoredParentPid && process.connected) process.send?.({ type: "ponderosa-engine-ready" }, () => {});

  try {
    while (true) {
      if (quitRequested || (monitoredParentPid && !processAlive(monitoredParentPid))) {
        await stopPonderosa({ paths });
        return "supervised";
      }
      const status = await currentPonderosaStatus(paths);
      if (!status?.healthy && (!status?.pid || !processAlive(status.pid))) {
        // The control page may have initiated shutdown directly. Let the
        // daemon finish first, then use the launcher path to clear its state.
        await stopPonderosa({ paths });
        return "supervised";
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        void delay(1_000).then(resolve);
      });
      wake = undefined;
    }
  } finally {
    process.off("SIGINT", requestQuit);
    process.off("SIGTERM", requestQuit);
    process.off("message", requestedByDesktop);
    await releasePrepared(paths, handle);
    if (process.connected) process.disconnect();
  }
}
