import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const descendant = fileURLToPath(new URL("./fake-stubborn-descendant.mjs", import.meta.url));
spawn(process.execPath, [descendant], {
  // Retaining the provider root's stdout reproduces the authority leak: Node's
  // root `close` event cannot fire until this descendant releases the pipe.
  stdio: ["ignore", "inherit", "ignore"],
  env: {
    ...process.env,
    PONDEROSA_TEST_PROVIDER_PID: String(process.pid),
  },
});

const finish = () => {
  if (!existsSync(process.env.PONDEROSA_TEST_DESCENDANT_PID_FILE)) {
    setTimeout(finish, 5);
    return;
  }
  process.stdout.write(`${JSON.stringify({ type: "ready", pid: process.pid })}\n`, () => {
    process.exit(0);
  });
};
finish();
