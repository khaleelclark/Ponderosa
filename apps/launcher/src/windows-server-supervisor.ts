import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WindowsProcessJob } from "@ponderosa/native-host";

const serverEntry = process.argv[2];
const installRoot = process.argv[3];
if (!serverEntry || !installRoot) throw new Error("Windows server supervisor requires server entry and install root");

const job = new WindowsProcessJob();
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
    report({ type: "supervisor-error", detail: error instanceof Error ? error.message : String(error) });
    job.close();
    process.exitCode = 126;
  }
});
gate.once("error", (error) => {
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
    report({ type: "supervisor-error", detail: input.detail });
  }
});

while (gate.exitCode === null && gate.signalCode === null) await delay(100);
const deadline = Date.now() + 30_000;
while (job.activeProcesses() > 0 && Date.now() < deadline) await delay(25);
if (job.activeProcesses() > 0) {
  job.terminate();
  const forcedDeadline = Date.now() + 5_000;
  while (job.activeProcesses() > 0 && Date.now() < forcedDeadline) await delay(25);
}
if (job.activeProcesses() > 0) {
  report({ type: "supervisor-error", detail: "Windows server Job Object did not drain" });
  process.exitCode = 127;
} else {
  job.close();
}
