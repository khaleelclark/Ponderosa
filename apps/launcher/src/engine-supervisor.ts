import {
  closeSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { currentPonderosaStatus, stopPonderosa } from "./control.js";
import type { LauncherPaths } from "./types.js";

interface EngineSupervisorReceipt {
  pid: number;
  token: string;
  startedAt: string;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function acquireSupervisorLease(pathname: string): (() => void) | undefined {
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
      return () => {
        const current = readReceipt(pathname);
        if (current?.pid === receipt.pid && current.token === receipt.token) {
          rmSync(pathname, { force: true });
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
      rmSync(pathname, { force: true });
    }
  }
  return undefined;
}

/**
 * Keeps the installed desktop entry alive while its detached server is alive.
 * Closing the browser control window does not affect this process. An explicit
 * desktop quit signal asks the authoritative launcher to stop the server and
 * its provider processes before the Engine process exits.
 */
export async function supervisePonderosaEngine(paths: LauncherPaths): Promise<"supervised" | "already_supervised"> {
  const release = acquireSupervisorLease(paths.engineSupervisorPath);
  if (!release) return "already_supervised";
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
    release();
  }
}
