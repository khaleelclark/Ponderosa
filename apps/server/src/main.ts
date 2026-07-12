import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@ponderosa/core/config";
import { defaultEngineRegistrations } from "@ponderosa/engines";
import { createServer } from "./app.js";

const config = loadConfig();
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "../../web/dist");

const app = createServer({
  dataDir: config.dataDir,
  engines: defaultEngineRegistrations(),
  webDist,
  authToken: process.env.PONDEROSA_AUTH_TOKEN,
  agentBaseUrl: process.env.PONDEROSA_AGENT_BASE_URL ?? `http://127.0.0.1:${config.port}`,
  communicationMode: config.communicationMode,
  communicationReadMode: config.communicationReadMode,
  legacyRoutingMode: config.legacyRoutingMode,
  curatedContextEnabled: config.curatedContextEnabled,
});

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
