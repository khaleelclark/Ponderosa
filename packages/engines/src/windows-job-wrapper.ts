import { spawn } from "node:child_process";

interface StartMessage {
  type: "start";
  bin: string;
  args: string[];
  cwd: string;
}

function validMessage(value: unknown): value is StartMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.type === "start" &&
    typeof raw.bin === "string" && raw.bin.length > 0 &&
    Array.isArray(raw.args) && raw.args.every((value) => typeof value === "string") &&
    typeof raw.cwd === "string" && raw.cwd.length > 0;
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
  const child = spawn(message.bin, message.args, {
    cwd: message.cwd,
    env: environment,
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  process.stdin.pipe(child.stdin!);
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
