import { spawn } from "node:child_process";
import { containedWindowsInvocation } from "./windows-command.js";

interface StartMessage {
  type: "start";
  bin: string;
  args: string[];
  cwd: string;
  browserPipe?: boolean;
}

function validMessage(value: unknown): value is StartMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.type === "start" &&
    typeof raw.bin === "string" && raw.bin.length > 0 &&
    Array.isArray(raw.args) && raw.args.every((value) => typeof value === "string") &&
    typeof raw.cwd === "string" && raw.cwd.length > 0 &&
    (raw.browserPipe === undefined || typeof raw.browserPipe === "boolean");
}

let started = false;
process.once("message", (message: unknown) => {
  if (started || !validMessage(message)) {
    process.exitCode = 125;
    process.disconnect?.();
    return;
  }
  started = true;
  const environment = { ...process.env };
  delete environment.PONDEROSA_LAUNCHER_CONTROL_TOKEN;
  const invocation = containedWindowsInvocation(message.bin, message.args, environment);
  const child = spawn(invocation.bin, invocation.args, {
    cwd: message.cwd,
    env: invocation.env,
    stdio: message.browserPipe
      ? ["ignore", "ignore", "inherit", "pipe", "pipe"]
      : ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  if (message.browserPipe) {
    // The gate is assigned to the Job before Chrome can spawn. Bridge the
    // CDP byte streams without ever exposing the Chrome process outside it.
    process.stdin.pipe(child.stdio[3] as NodeJS.WritableStream);
    (child.stdio[4] as NodeJS.ReadableStream).pipe(process.stdout);
  } else {
    process.stdin.pipe(child.stdin!);
    child.stdout!.pipe(process.stdout);
    child.stdout!.once("end", () => process.stdout.end());
  }
  child.once("error", (error) => {
    process.stderr.write(`Ponderosa contained runtime spawn failed: ${error.message}\n`);
    process.exitCode = 126;
    process.stdin.destroy();
    process.disconnect?.();
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
    process.stdin.destroy();
    process.disconnect?.();
  });
});

process.once("disconnect", () => {
  if (!started) process.exitCode = 125;
});
