import { spawn } from "node:child_process";

interface StartMessage {
  type: "start";
  serverEntry: string;
  installRoot: string;
}

process.once("message", (message: unknown) => {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    process.exitCode = 125;
    process.disconnect?.();
    return;
  }
  const input = message as Partial<StartMessage>;
  if (input.type !== "start" || typeof input.serverEntry !== "string" ||
      typeof input.installRoot !== "string") {
    process.exitCode = 125;
    process.disconnect?.();
    return;
  }
  const server = spawn(process.execPath, [input.serverEntry], {
    cwd: input.installRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  server.once("spawn", () => process.send?.({ type: "server-started", pid: server.pid }));
  server.once("error", (error) => {
    process.send?.({ type: "server-error", detail: error.message });
    process.exitCode = 126;
  });
  server.once("exit", (code) => {
    process.exitCode = code ?? 1;
    process.disconnect?.();
  });
});
