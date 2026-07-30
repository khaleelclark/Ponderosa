import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WindowsProcessJob } from "@ponderosa/native-host";
import { writeJsonAtomic } from "./paths.js";

const serverEntry = process.argv[2];
const installRoot = process.argv[3];
const statusPath = process.argv[4];
const generation = process.argv[5];
if (!serverEntry || !installRoot || !statusPath || !generation) {
  throw new Error("Windows server supervisor requires server entry, install root, status path, and generation");
}
const durableStatusPath: string = statusPath;
const durableGeneration: string = generation;

function persistStatus(status: "active" | "draining" | "failed" | "drained", detail?: string): void {
  writeJsonAtomic(durableStatusPath, {
    schemaVersion: 1,
    generation: durableGeneration,
    supervisorPid: process.pid,
    status,
    updatedAt: new Date().toISOString(),
    ...(detail ? { detail } : {}),
  });
}

function report(message: unknown): void {
  if (!process.connected) return;
  process.send?.(message);
}

/**
 * Phase one owns an empty Job and reports its durable identity. It cannot
 * create the server gate until the launcher has atomically persisted the
 * matching supervisor PID/generation and sends the phase-two authorization.
 */
function waitForAuthorization(): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (authorized: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      resolve(authorized);
    };
    const onMessage = (message: unknown): void => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const input = message as { type?: unknown; generation?: unknown };
      if (input.type === "authorize" && input.generation === durableGeneration) finish(true);
    };
    const onDisconnect = (): void => finish(false);
    const timer = setTimeout(() => finish(false), 30_000);
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
  });
}

const job = new WindowsProcessJob();
persistStatus("active", "awaiting durably persisted launcher authorization");
report({
  type: "supervisor-ready",
  supervisorPid: process.pid,
  generation: durableGeneration,
});

if (!await waitForAuthorization()) {
  persistStatus("drained", "launcher disconnected or did not authorize server creation");
  job.close();
  process.exitCode = 125;
} else {
  const gate = spawn(process.execPath, [
    fileURLToPath(new URL("./windows-server-gate.js", import.meta.url)),
  ], {
    cwd: installRoot,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    windowsHide: true,
  });

  let launchFailed = false;
  let gateTerminated = false;
  gate.once("spawn", () => {
    try {
      if (!gate.pid) throw new Error("Windows server gate started without a process id");
      job.assign(gate.pid);
      gate.send?.({ type: "start", serverEntry, installRoot });
    } catch (error) {
      launchFailed = true;
      const detail = error instanceof Error ? error.message : String(error);
      persistStatus("failed", detail);
      report({ type: "supervisor-error", detail });
      try { gate.kill(); } catch { /* observed below */ }
    }
  });
  gate.once("error", (error) => {
    launchFailed = true;
    gateTerminated = true;
    persistStatus("failed", error.message);
    report({ type: "supervisor-error", detail: error.message });
  });
  gate.once("close", () => {
    gateTerminated = true;
  });
  gate.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const input = message as { type?: unknown; pid?: unknown; detail?: unknown };
    if (input.type === "server-started" && Number.isSafeInteger(input.pid) && (input.pid as number) > 0) {
      report({ type: "server-started", pid: input.pid });
      process.disconnect?.();
    } else if (input.type === "server-error") {
      launchFailed = true;
      const detail = typeof input.detail === "string" ? input.detail : "server gate failed";
      persistStatus("failed", detail);
      report({ type: "supervisor-error", detail });
    }
  });

  while (!gateTerminated) await delay(100);
  const deadline = Date.now() + 30_000;
  while (job.activeProcesses() > 0 && Date.now() < deadline) await delay(25);
  if (job.activeProcesses() > 0) {
    persistStatus("draining", "grace period expired; forcing the complete server Job to terminate");
    job.terminate();
    // Stay alive as the durable Job owner until zero is observed. If the
    // operating system takes longer than expected, replacement remains fenced
    // by the persisted supervisor PID and draining status.
    while (job.activeProcesses() > 0) {
      await delay(250);
      job.terminate();
    }
  }
  persistStatus("drained", launchFailed ? "launch failed and the complete Job drained" : undefined);
  job.close();
  if (launchFailed) process.exitCode = 126;
}
