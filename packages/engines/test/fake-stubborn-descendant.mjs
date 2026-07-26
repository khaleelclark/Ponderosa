import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 1_000);

writeFileSync(process.env.PONDEROSA_TEST_DESCENDANT_PID_FILE, JSON.stringify({
  providerPid: Number(process.env.PONDEROSA_TEST_PROVIDER_PID),
  descendantPid: process.pid,
}));
