import { spawn } from "node:child_process";

process.once("message", (message: unknown) => {
  if (message !== "start") {
    process.exitCode = 125;
    process.disconnect?.();
    return;
  }
  const descendant = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
  ], {
    stdio: "ignore",
    windowsHide: true,
  });
  descendant.once("spawn", () => process.send?.({ ready: true, pid: descendant.pid }));
  descendant.once("error", (error) => {
    process.send?.({ ready: false, error: error.message });
    process.exitCode = 126;
  });
  setInterval(() => undefined, 1_000);
});
