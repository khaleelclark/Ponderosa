import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@ponderosa/core/config";
import { defaultEngineRegistrations } from "@ponderosa/engines";
import { processBirthMarker } from "@ponderosa/engines";
import { createServer } from "./app.js";
import { writeLauncherShutdownReceipt } from "./launcher-shutdown-receipt.js";
import { installProcessShutdownHandlers } from "./shutdown.js";

const config = loadConfig();
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "../../web/dist");

const launcherControlToken = process.env.PONDEROSA_LAUNCHER_CONTROL_TOKEN?.trim();
delete process.env.PONDEROSA_LAUNCHER_CONTROL_TOKEN;
const launcherSecurity = launcherControlToken ? { controlToken: launcherControlToken } : undefined;
const shutdownRecovery = process.env.PONDEROSA_SHUTDOWN_RECOVERY === "1";
const shutdownRecoveryPid = Number(process.env.PONDEROSA_SHUTDOWN_RECOVERY_PID);
const shutdownRecoveryRequestedAt = process.env.PONDEROSA_SHUTDOWN_RECOVERY_REQUESTED_AT;
const shutdownRecoveryBirthMarker = process.env.PONDEROSA_SHUTDOWN_RECOVERY_BIRTH_MARKER;

function internalAgentBaseUrl(host: string, port: number): string {
  const reachableHost = host === "0.0.0.0"
    ? "127.0.0.1"
    : host === "::"
      ? "::1"
      : host;
  const urlHost = reachableHost.includes(":") && !reachableHost.startsWith("[")
    ? `[${reachableHost}]`
    : reachableHost;
  return `http://${urlHost}:${port}`;
}

const app = createServer({
  dataDir: config.dataDir,
  startDrained: process.env.PONDEROSA_START_DRAINED === "1",
  startupMode: shutdownRecovery ? "shutdown_recovery" : "serve",
  launcherDataDir: process.env.PONDEROSA_LAUNCHER_DATA_DIR,
  launcherGeneration: process.env.PONDEROSA_LAUNCHER_GENERATION,
  engines: defaultEngineRegistrations(),
  webDist,
  authToken: config.authToken,
  networkSecurity: config.networkSecurity,
  buildRevision: process.env.PONDEROSA_BUILD_SHA,
  buildVersion: process.env.PONDEROSA_BUILD_VERSION,
  releaseChannel: process.env.PONDEROSA_RELEASE_CHANNEL,
  ...(launcherSecurity ? { launcherSecurity } : {}),
  agentBaseUrl: process.env.PONDEROSA_AGENT_BASE_URL ?? internalAgentBaseUrl(config.host, config.port),
  allowedImportRoots: (process.env.PONDEROSA_IMPORT_ROOTS ?? "")
    .split(path.delimiter).map((root) => root.trim()).filter(Boolean),
});
if (shutdownRecovery) {
  const launcherRoot = process.env.PONDEROSA_LAUNCHER_DATA_DIR;
  const generation = process.env.PONDEROSA_LAUNCHER_GENERATION;
  const validRecovery = launcherRoot && generation && shutdownRecoveryRequestedAt &&
    Number.isSafeInteger(shutdownRecoveryPid) && shutdownRecoveryPid > 0 &&
    Number.isFinite(Date.parse(shutdownRecoveryRequestedAt));
  if (!validRecovery) throw new Error("shutdown recovery verifier is missing exact launcher authority");
  const writeRecoveryReceipt = (state: "clean" | "incomplete", error?: unknown): void =>
    writeLauncherShutdownReceipt(launcherRoot, {
      schemaVersion: 1,
      generation,
      pid: shutdownRecoveryPid,
      ...(shutdownRecoveryBirthMarker ? { processBirthMarker: shutdownRecoveryBirthMarker } : {}),
      state,
      requestedAt: shutdownRecoveryRequestedAt,
      updatedAt: new Date().toISOString(),
      ...(error ? { error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) } : {}),
    });
  try {
    if (shutdownRecoveryBirthMarker &&
        processBirthMarker(shutdownRecoveryPid) === shutdownRecoveryBirthMarker) {
      throw new Error("exact shutdown process is still live; recovery verifier refused to overlap it");
    }
    await app.ready();
    app.prepareForShutdown();
    await app.close();
    writeRecoveryReceipt("clean");
  } catch (error) {
    try { writeRecoveryReceipt("incomplete", error); }
    catch (receiptError) { app.log.error({ err: receiptError }, "shutdown recovery receipt could not be persisted"); }
    app.log.error({ err: error }, "shutdown recovery verifier did not complete");
    process.exitCode = 1;
  }
} else {
  installProcessShutdownHandlers(app);
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
