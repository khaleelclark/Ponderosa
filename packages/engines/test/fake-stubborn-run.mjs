import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const descendant = fileURLToPath(new URL("./fake-stubborn-descendant.mjs", import.meta.url));
spawn(process.execPath, [descendant], {
  stdio: "ignore",
  env: {
    ...process.env,
    PONDEROSA_TEST_PROVIDER_PID: String(process.pid),
  },
});

process.on("SIGTERM", () => process.exit(143));
const publishReady = () => {
  if (!existsSync(process.env.PONDEROSA_TEST_DESCENDANT_PID_FILE)) {
    setTimeout(publishReady, 5);
    return;
  }
  process.stdout.write(`${JSON.stringify({ type: "ready", pid: process.pid })}\n`);
};
publishReady();
setInterval(() => undefined, 1_000);
