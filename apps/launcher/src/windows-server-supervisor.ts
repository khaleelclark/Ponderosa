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

const job = new WindowsProcessJob();
persistStatus("active");
const gate = spawn(process.execPath, [
  fileURLToPath(new URL("./windows-server-gate.js", import.meta.url)),
], {
  cwd: installRoot,
  env: process.env,
  stdio: ["ignore", "inherit", "inherit", "ipc"],
  windowsHide: true,
});

let reported = false;
function report(message: unknown): void {
  if (reported) return;
  reported = true;
  process.send?.(message);
  process.disconnect?.();
}

gate.once("spawn", () => {
  try {
    if (!gate.pid) throw new Error("Windows server gate started without a process id");
    job.assign(gate.pid);
    gate.send?.({ type: "start", serverEntry, installRoot });
  } catch (error) {
    persistStatus("failed", error instanceof Error ? error.message : String(error));
    report({ type: "supervisor-error", detail: error instanceof Error ? error.message : String(error) });
    job.close();
    process.exitCode = 126;
  }
});
gate.once("error", (error) => {
  persistStatus("failed", error.message);
  report({ type: "supervisor-error", detail: error.message });
  job.close();
  process.exitCode = 126;
});
gate.on("message", (message: unknown) => {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const input = message as { type?: unknown; pid?: unknown; detail?: unknown };
  if (input.type === "server-started" && Number.isSafeInteger(input.pid) && (input.pid as number) > 0) {
    report({ type: "server-started", pid: input.pid });
  } else if (input.type === "server-error") {
    persistStatus("failed", typeof input.detail === "string" ? input.detail : "server gate failed");
    report({ type: "supervisor-error", detail: input.detail });
  }
});

while (gate.exitCode === null && gate.signalCode === null) await delay(100);
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
persistStatus("drained");
job.close();
