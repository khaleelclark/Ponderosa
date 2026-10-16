import { pathToFileURL } from "node:url";

// The supervisor assigns this exact process to its Job before authorizing the
// import. No uncontained server or second writable owner is spawned by the gate.
process.once("message", (message: unknown) => {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    process.exitCode = 125; process.disconnect?.(); return;
  }
  const input = message as { type?: string; serverEntry?: string; installRoot?: string };
  if (input.type !== "start" || typeof input.serverEntry !== "string" || typeof input.installRoot !== "string") {
    process.exitCode = 125; process.disconnect?.(); return;
  }
  void import(pathToFileURL(input.serverEntry).href).then(() => {
    process.send?.({ type: "server-started", pid: process.pid });
  }, (error: unknown) => {
    process.send?.({ type: "server-error", detail: error instanceof Error ? error.message : "server startup failed" });
    process.exitCode = 126; process.disconnect?.();
  });
});
