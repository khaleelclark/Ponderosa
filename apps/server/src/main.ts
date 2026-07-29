import path from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@ponderosa/core/config";
import { defaultEngineRegistrations } from "@ponderosa/engines";
import { createServer } from "./app.js";
import { installProcessShutdownHandlers } from "./shutdown.js";

const config = loadConfig();
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "../../web/dist");

const launcherControlToken = process.env.PONDEROSA_LAUNCHER_CONTROL_TOKEN?.trim();
const launcherSecurity = launcherControlToken ? { controlToken: launcherControlToken } : undefined;

function internalAgentBaseUrl(host: string, port: number): string {
  const reachableHost = host === "0.0.0.0"
    ? "127.0.0.1"
    : host === "::"
      ? "::1"
      : host;
  const urlHost = isIP(reachableHost) === 6 ? `[${reachableHost}]` : reachableHost;
  return `http://${urlHost}:${port}`;
}

const app = createServer({
  dataDir: config.dataDir,
  engines: defaultEngineRegistrations(),
  webDist,
  authToken: config.authToken,
  networkSecurity: config.networkSecurity,
  buildRevision: process.env.PONDEROSA_BUILD_SHA,
  buildVersion: process.env.PONDEROSA_BUILD_VERSION,
  releaseChannel: process.env.PONDEROSA_RELEASE_CHANNEL,
  ...(launcherSecurity ? { launcherSecurity } : {}),
  agentBaseUrl: process.env.PONDEROSA_AGENT_BASE_URL ?? internalAgentBaseUrl(config.host, config.port),
});
installProcessShutdownHandlers(app);

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
