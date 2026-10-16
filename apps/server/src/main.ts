import { AgentStore, admitDataDirectory } from "@ponderosa/agents";
import { DataDirectoryAuthority } from "@ponderosa/native-host";
import type { WindowsDirectoryLeaseTransfer } from "@ponderosa/native-host";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@ponderosa/core/config";
import { defaultEngineRegistrations } from "@ponderosa/engines";
import { processBirthMarker } from "@ponderosa/engines";
import { createServer } from "./app.js";
import { LauncherRecordAuthority, validateLauncherRecord } from "./launcher-record-authority.js";
import { installProcessShutdownHandlers } from "./shutdown.js";
import { assertProductionBuildIdentity } from "./build-identity.js";
import { installLauncherRunningLogs } from "./launcher-running-logs.js";

// Installed launcher output is capped per write throughout the daemon's life.
// Source/systemd launches without a launcher root retain their normal streams.
const config = loadConfig();
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "../../web/dist");
const buildManifest = path.resolve(here, "../../../build-manifest.json");

assertProductionBuildIdentity({
  releaseChannel: process.env.PONDEROSA_RELEASE_CHANNEL,
  buildRevision: process.env.PONDEROSA_BUILD_SHA,
  buildVersion: process.env.PONDEROSA_BUILD_VERSION,
  manifestPath: buildManifest,
});

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

// IPC is the exact parent/child handoff; environment metadata alone is not a
// lease. Native adoption additionally proves the original parent-held flock.
const transferText = process.env.PONDEROSA_STATE_TRANSFER;
delete process.env.PONDEROSA_STATE_TRANSFER;
let launcherRootAuthority: DataDirectoryAuthority | undefined;
let launcherRecords: LauncherRecordAuthority | undefined;
let storeRoot = config.dataDir;
let store: AgentStore;
if (transferText) {
  const transfer = JSON.parse(transferText) as { nonce: string; generationId: string; physicalIdentity: string; dataRoot: string; parentRoot: string; dataLease?: WindowsDirectoryLeaseTransfer; parentLease?: WindowsDirectoryLeaseTransfer };
  if (!process.connected || !process.send || !/^[0-9a-f-]{36}$/u.test(transfer.nonce)) {
    throw new Error("current state transfer requires the exact launcher IPC channel");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("current state transfer authorization timed out")), 45_000);
    const finish = (error?: Error): void => {
      clearTimeout(timer); process.off("message", onMessage); process.off("disconnect", onDisconnect);
      error ? reject(error) : resolve();
    };
    const onDisconnect = (): void => finish(new Error("launcher disappeared before state transfer"));
    const onMessage = (message: unknown): void => {
      const input = message as { type?: string; nonce?: string; generationId?: string; physicalIdentity?: string };
      if (input?.type !== "state-admission-authorize") return;
      if (input.nonce !== transfer.nonce || input.generationId !== transfer.generationId ||
          input.physicalIdentity !== transfer.physicalIdentity) finish(new Error("state transfer identity changed"));
      else finish();
    };
    process.on("message", onMessage); process.once("disconnect", onDisconnect);
    process.send!({ type: "state-admission-request", ...transfer });
  });
  launcherRootAuthority = new DataDirectoryAuthority(process.platform === "linux" ? "/proc/self/fd/5" : transfer.parentRoot, 5, transfer.parentLease);
  validateLauncherRecord(launcherRootAuthority.rootPath, {
    generation: process.env.PONDEROSA_LAUNCHER_GENERATION ?? "", controlToken: launcherControlToken ?? "",
    stateGenerationId: transfer.generationId, physicalDataDirectoryIdentity: transfer.physicalIdentity,
    ...(shutdownRecovery ? { recovery: { pid: shutdownRecoveryPid, birth: shutdownRecoveryBirthMarker, requestedAt: shutdownRecoveryRequestedAt } } : {}),
  });
  const inherited = admitDataDirectory(process.platform === "linux" ? "/proc/self/fd/4" : transfer.dataRoot, "ponderosa.db", 4, transfer);
  try {
    storeRoot = inherited.dataDir;
    process.env.PONDEROSA_LAUNCHER_DATA_DIR = launcherRootAuthority.rootPath;
    launcherRecords = new LauncherRecordAuthority(launcherRootAuthority, inherited,
      process.env.PONDEROSA_LAUNCHER_GENERATION!, launcherControlToken!, shutdownRecovery);
    store = new AgentStore(storeRoot);
    process.send!({ type: "state-admission-adopted", ...transfer });
  } catch (error) { inherited.close(); if (launcherRecords) launcherRecords.close(); else launcherRootAuthority?.close(); throw error; }
  inherited.close();
} else {
  if (process.env.PONDEROSA_LAUNCHER_DATA_DIR) throw new Error("installed startup requires an exact current state transfer");
  store = new AgentStore(storeRoot);
}
if (process.env.PONDEROSA_SHUTDOWN_RECOVERY !== "1") installLauncherRunningLogs(process.env.PONDEROSA_LAUNCHER_DATA_DIR);

let app: ReturnType<typeof createServer>;
try { app = createServer({
  dataDir: storeRoot,
  reportedDataDir: process.env.PONDEROSA_REPORTED_DATA_DIR ?? config.dataDir,
  store,
  browserServiceSocket: process.env.PONDEROSA_BROWSER_SERVICE_SOCKET,
  startDrained: process.env.PONDEROSA_START_DRAINED === "1",
  startupMode: shutdownRecovery ? "shutdown_recovery" : "serve",
  launcherDataDir: process.env.PONDEROSA_LAUNCHER_DATA_DIR,
  launcherGeneration: process.env.PONDEROSA_LAUNCHER_GENERATION,
  launcherRecords,
  engines: defaultEngineRegistrations(),
  webDist,
  authToken: config.authToken,
  networkSecurity: config.networkSecurity,
  operatorOrigins: config.operatorOrigins,
  operatorIdentities: config.operatorIdentities,
  requestLimits: { maxRequestsPerMinute: 600, maxCriticalRequestsPerMinute: 120, maxStreamRequestsPerMinute: 120, maxMonitorRequestsPerMinute: 120, maxInflight: 128 },
  buildRevision: process.env.PONDEROSA_BUILD_SHA,
  buildVersion: process.env.PONDEROSA_BUILD_VERSION,
  releaseChannel: process.env.PONDEROSA_RELEASE_CHANNEL,
  ...(launcherSecurity ? { launcherSecurity } : {}),
  agentBaseUrl: process.env.PONDEROSA_AGENT_BASE_URL ?? internalAgentBaseUrl(config.host, config.port),
  allowedImportRoots: (process.env.PONDEROSA_IMPORT_ROOTS ?? "")
    .split(path.delimiter).map((root) => root.trim()).filter(Boolean),
});
} catch (error) { store.abortStartup(); launcherRecords?.close(); throw error; }
app.addHook("onClose", async () => { launcherRecords?.close(); });
const retryStorageCleanup = app.retryShutdownCleanup;
app.retryShutdownCleanup = async () => {
  await retryStorageCleanup();
  launcherRecords?.close();
};
if (shutdownRecovery) {
  const launcherRoot = process.env.PONDEROSA_LAUNCHER_DATA_DIR;
  const generation = process.env.PONDEROSA_LAUNCHER_GENERATION;
  const validRecovery = launcherRoot && generation && shutdownRecoveryRequestedAt &&
    Number.isSafeInteger(shutdownRecoveryPid) && shutdownRecoveryPid > 0 &&
    Number.isFinite(Date.parse(shutdownRecoveryRequestedAt));
  if (!validRecovery) throw new Error("shutdown recovery verifier is missing exact launcher authority");
  const receiptAuthority = launcherRecords?.retain();
  if (!receiptAuthority) throw new Error("shutdown recovery has no held launcher receipt authority");
  const writeRecoveryReceipt = (state: "clean" | "incomplete", error?: unknown): void => receiptAuthority.writeReceipt(state, error);
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
  } finally { receiptAuthority.close(); }
} else {
  installProcessShutdownHandlers(app);
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
