import {
  closeSync,
  constants,
  fstatSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "@ponderosa/native-host/fs";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LauncherShutdownReceiptDto } from "@ponderosa/core";
import { DataDirectoryAuthority, DataDirectoryReadReference, physicalDirectoryIdentity, dataDirectoryAuthoritySupported, hostProcessBirthMarker, hostBootIdentity } from "@ponderosa/native-host";
import type { WindowsDirectoryLeaseTransfer } from "@ponderosa/native-host";
import { discoverProviders } from "./providers.js";
import {
  ensureDataLayout,
  bindLauncherPaths,
  launcherStateLocation,
  readLauncherConfiguration,
  readLauncherState,
  writeJsonAtomic,
} from "./paths.js";
import type {
  BuildManifest,
  LauncherDependencies,
  LauncherPaths,
  LauncherState,
  PlatformAdapter,
  PublicLauncherState,
} from "./types.js";

const localMutationPaths = new WeakMap<object, () => void>();
const localMutationLocks = new Map<string, () => void>();
export function requireLocalLauncherMutation(paths: LauncherPaths): void {
  const guard = localMutationPaths.get(paths);
  if (!guard) throw new Error("launcher mutation requires current local admission");
  guard();
}
interface LauncherAdmission {
  readonly dataDir: string;
  readonly generationId: string;
  readonly physicalIdentity: string;
  revalidateTransferredState(): void;
  prepareTransfer(): { descriptor: number; generationId: string; physicalIdentity: string; dataLease?: WindowsDirectoryLeaseTransfer };
  close(): void;
}
interface LeaseTransfer {
  descriptor: number; parentDescriptor: number; dataRoot: string; parentRoot: string;
  nonce: string; generationId: string; physicalIdentity: string;
  dataLease?: WindowsDirectoryLeaseTransfer; parentLease?: WindowsDirectoryLeaseTransfer;
}
async function admitLauncherData(paths: LauncherPaths, expectedRoot?: { generationId: string; dataIdentity: string }): Promise<LauncherAdmission> {
  const bridge = await import(pathToFileURL(path.join(path.dirname(paths.serverEntry), "state-admission.js")).href) as {
    admitDataDirectory(root: string, primary?: string, descriptor?: number, expected?: { generationId: string; physicalIdentity?: string }): LauncherAdmission;
  };
  const previous = readLauncherState(paths.statePath);
  if (!previous && existsSync(paths.statePath)) throw new Error("launcher control record is malformed or unsupported");
  if (previous && (previous.stateEpoch !== 2 || !previous.stateGenerationId || !previous.physicalDataDirectoryIdentity)) {
    throw new Error("existing launcher authority has no current generation binding");
  }
  if (expectedRoot && previous && (previous.stateGenerationId !== expectedRoot.generationId ||
      previous.physicalDataDirectoryIdentity !== expectedRoot.dataIdentity)) throw new Error("control record has a different generation binding");
  return bridge.admitDataDirectory(paths.applicationDataDir, "ponderosa.db", undefined,
    expectedRoot ? { generationId: expectedRoot.generationId, physicalIdentity: expectedRoot.dataIdentity } :
      previous ? { generationId: previous.stateGenerationId!, physicalIdentity: previous.physicalDataDirectoryIdentity } : undefined);
}
function acquireLauncherParent(paths: LauncherPaths): DataDirectoryAuthority {
  if (!dataDirectoryAuthoritySupported()) throw new Error("installed current startup requires qualified native physical-directory authority");
  const existing = lstatSync(paths.dataDir, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory()) throw new Error("launcher root is not a physical directory");
  if (!existing) mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  const parent = new DataDirectoryAuthority(paths.dataDir);
  try {
    const application = path.join(parent.rootPath, "data");
    const app = lstatSync(application, { throwIfNoEntry: false });
    if ((!app || (app.isDirectory() && readdirSync(application).length === 0)) && readdirSync(parent.rootPath).length !== 0) {
      throw new Error("nonempty launcher root cannot mint an absent or incomplete application generation");
    }
    readLauncherConfiguration(path.join(parent.rootPath, "config", "launcher.json"));
    return parent;
  } catch (error) { parent.close(); throw error; }
}
function prepareLeaseTransfer(admission: LauncherAdmission, parent: DataDirectoryAuthority): LeaseTransfer {
  const dataRoot = admission.dataDir;
  return { ...admission.prepareTransfer(), parentDescriptor: parent.exportDescriptor(), parentLease: parent.exportLeaseTransfer(), dataRoot, parentRoot: parent.rootPath, nonce: randomUUID() };
}
function transferEnvironment(env: NodeJS.ProcessEnv, transfer: LeaseTransfer): NodeJS.ProcessEnv {
  return { ...env, PONDEROSA_DATA_DIR: process.platform === "linux" ? "/proc/self/fd/4" : transfer.dataRoot, PONDEROSA_STATE_TRANSFER: JSON.stringify({
    nonce: transfer.nonce, generationId: transfer.generationId, physicalIdentity: transfer.physicalIdentity, dataRoot: transfer.dataRoot, parentRoot: transfer.parentRoot,
    dataLease: transfer.dataLease, parentLease: transfer.parentLease,
  }) };
}
function waitForLeaseAdoption(child: ReturnType<typeof spawn>, transfer: LeaseTransfer, disconnectAfterAdoption = true): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("exact current state adoption timed out")), 45_000);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); child.off("message", onMessage); child.off("error", onError); child.off("exit", onExit);
      if (error) reject(error);
      else { if (disconnectAfterAdoption && child.connected) child.disconnect(); resolve(child.pid!); }
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (): void => finish(new Error("server exited before exact state lease adoption"));
    const onMessage = (message: unknown): void => {
      const input = message as { type?: string; nonce?: string; generationId?: string; physicalIdentity?: string };
      if (!["state-admission-request", "state-admission-adopted"].includes(input?.type ?? "")) return;
      if (!child.pid || input.nonce !== transfer.nonce || input.generationId !== transfer.generationId ||
          input.physicalIdentity !== transfer.physicalIdentity) { finish(new Error("current state handoff changed identity")); return; }
      if (input.type === "state-admission-request") {
        child.send({ type: "state-admission-authorize", nonce: transfer.nonce,
          generationId: transfer.generationId, physicalIdentity: transfer.physicalIdentity }, error => { if (error) finish(error); });
      } else finish();
    };
    child.on("message", onMessage); child.once("error", onError); child.once("exit", onExit);
  });
}
function validateCurrentLookup(paths: LauncherPaths, status: LauncherState | PublicLauncherState): void {
  const data = lstatSync(paths.applicationDataDir, { bigint: true });
  const parent = lstatSync(paths.dataDir, { bigint: true });
  if (!data.isDirectory() || !parent.isDirectory() || status.stateEpoch !== 2 ||
      physicalDirectoryIdentity(paths.applicationDataDir) !== status.physicalDataDirectoryIdentity ||
      physicalDirectoryIdentity(paths.dataDir) !== status.physicalLauncherDirectoryIdentity ||
      status.dataDir !== paths.applicationDataDir || status.installRoot !== paths.installRoot) {
    throw new Error("configured lookup does not match the exact current instance");
  }
}

const LOOPBACK_HOST = "127.0.0.1" as const;
const START_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 30_000;
const OPERATION_LOCK_INITIALIZATION_GRACE_MS = 5_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const LOG_ARCHIVE_COUNT = 3;

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function launcherProcessBirthMarker(pid: number): string | undefined {
  return hostProcessBirthMarker(pid);
}

function supervisorStatusPath(paths: LauncherPaths, generation: string): string {
  return path.join(paths.runtimeDir, `server-supervisor-${generation}.json`);
}

function supervisorDrained(
  paths: LauncherPaths,
  state: Pick<LauncherState, "supervisorGeneration">,
): boolean {
  if (!state.supervisorGeneration) return true;
  try {
    const status = JSON.parse(readFileSync(
      supervisorStatusPath(paths, state.supervisorGeneration),
      "utf8",
    )) as { generation?: unknown; status?: unknown };
    return status.generation === state.supervisorGeneration && status.status === "drained";
  } catch {
    return false;
  }
}

function supervisorBootRecovery(paths: LauncherPaths, state: LauncherState) {
  if (!state.supervisorGeneration || !state.supervisorPid) return undefined;
  const bootId = hostBootIdentity();
  if (!bootId) return undefined;
  try {
    const pathname = supervisorStatusPath(paths, state.supervisorGeneration);
    const receipt = JSON.parse(readFileSync(pathname, "utf8")) as Record<string, unknown>;
    if (receipt.schemaVersion !== 1 || receipt.generation !== state.supervisorGeneration ||
        receipt.supervisorPid !== state.supervisorPid || typeof receipt.status !== "string" ||
        !["active", "draining", "failed", "drained"].includes(receipt.status)) return undefined;
    for (const field of ["bootId", "recoveryBootId"]) {
      if (receipt[field] !== undefined && (typeof receipt[field] !== "string" ||
          receipt[field] === "00000000-0000-0000-0000-000000000000" ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(receipt[field]))) return undefined;
    }
    const previous = receipt.bootId ?? receipt.recoveryBootId;
    return { pathname, receipt, bootId, rebooted: previous !== undefined && previous !== bootId };
  } catch { return undefined; }
}

function removeSupervisorStatus(
  paths: LauncherPaths,
  state: Pick<LauncherState, "supervisorGeneration">,
): void {
  if (state.supervisorGeneration) {
    rmSync(supervisorStatusPath(paths, state.supervisorGeneration), { force: true });
  }
}

export function shutdownReceiptPath(paths: LauncherPaths, generation: string): string {
  return path.join(paths.stateDir, `shutdown-${generation}.json`);
}

export function readShutdownReceipt(
  paths: LauncherPaths,
  state: LauncherState,
): LauncherShutdownReceiptDto | undefined {
  try {
    const receipt = JSON.parse(readFileSync(
      shutdownReceiptPath(paths, state.generation),
      "utf8",
    )) as LauncherShutdownReceiptDto;
    if (receipt.schemaVersion !== 1 || receipt.generation !== state.generation ||
        receipt.pid !== state.pid || receipt.requestedAt !== state.shutdownRequestedAt ||
        receipt.processBirthMarker !== state.processBirthMarker ||
        !["pending", "clean", "incomplete"].includes(receipt.state) ||
        !Number.isFinite(Date.parse(receipt.updatedAt))) return undefined;
    return receipt;
  } catch {
    return undefined;
  }
}

function requireCleanShutdownReceipt(paths: LauncherPaths, state: LauncherState): void {
  if (!state.shutdownRequestedAt) return;
  const receipt = readShutdownReceipt(paths, state);
  if (receipt?.state !== "clean") {
    const detail = receipt?.state === "incomplete" && receipt.error
      ? ` ${receipt.error}`
      : " The matching durable clean receipt is missing.";
    throw new Error(`Ponderosa shutdown cleanup is incomplete.${detail} Replacement remains blocked.`);
  }
}

function readOperationLock(pathname: string): { pid?: number; token?: string } {
  try {
    return JSON.parse(readFileSync(pathname, "utf8")) as { pid?: number; token?: string };
  } catch {
    return {};
  }
}

export function acquireOperationLock(pathname: string): () => void {
  const guard = localMutationLocks.get(pathname);
  if (!guard) throw new Error("operation lock requires current local admission");
  guard();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(pathname, "wx", 0o600);
      const token = randomUUID();
      try {
        writeFileSync(descriptor, JSON.stringify({
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
        }), "utf8");
      } finally {
        closeSync(descriptor);
      }
      return () => {
        guard();
        const current = readOperationLock(pathname);
        if (current.pid === process.pid && current.token === token) {
          rmSync(pathname, { force: true });
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const owner = readOperationLock(pathname);
      let initializing = false;
      try {
        initializing = !owner.pid &&
          Date.now() - statSync(pathname).mtimeMs < OPERATION_LOCK_INITIALIZATION_GRACE_MS;
      } catch {
        // A concurrent release is handled by the retry.
      }
      if ((owner.pid && processAlive(owner.pid)) || initializing) {
        throw new Error("Another Ponderosa launcher operation is already in progress.");
      }
      if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || typeof owner.token !== "string") throw new Error("unprovable operation lock is preserved");
      rmSync(pathname, { force: true });
    }
  }
  throw new Error("Ponderosa could not acquire its launcher operation lock.");
}

async function acquireOperationLockWithWait(
  pathname: string,
  timeoutMs = START_TIMEOUT_MS,
): Promise<() => void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return acquireOperationLock(pathname);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("already in progress") ||
          Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function baseUrl(state: Pick<LauncherState, "host" | "port">): string {
  return `http://${state.host}:${state.port}`;
}

async function responseDetail(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Fall through to the status label.
  }
  return `${response.status} ${response.statusText}`.trim();
}

export async function launcherStatus(
  state: LauncherState,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<PublicLauncherState | undefined> {
  try {
    const response = await fetchFn(`${baseUrl(state)}/api/launcher/status`, {
      headers: bearer(state.controlToken),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as {
      pid?: number;
      dataDir?: string;
      version?: string;
      commit?: string;
      channel?: string;
      acceptingDurableIntake?: boolean;
      leasingRuns?: boolean;
      activeRunCount?: number;
      stateEpoch?: number; stateGenerationId?: string; physicalDataDirectoryIdentity?: string;
      physicalLauncherDirectoryIdentity?: string; generation?: string; processBirthMarker?: string; shutdownRequestedAt?: string;
    };
    if (state.stateEpoch !== 2 || body.stateEpoch !== 2 ||
        body.stateGenerationId !== state.stateGenerationId ||
        body.physicalDataDirectoryIdentity !== state.physicalDataDirectoryIdentity ||
        !/^[0-9a-f-]{36}$/u.test(body.stateGenerationId ?? "") ||
        body.physicalLauncherDirectoryIdentity !== state.physicalLauncherDirectoryIdentity || body.generation !== state.generation ||
        typeof body.processBirthMarker !== "string" || state.processBirthMarker !== undefined && state.processBirthMarker !== body.processBirthMarker ||
        !Number.isSafeInteger(body.pid) || body.pid! <= 0 ||
        (state.pid > 0 && body.pid !== state.pid) || body.dataDir !== state.dataDir ||
        body.version !== state.version || body.commit !== state.commit ||
        body.channel !== state.channel || typeof body.acceptingDurableIntake !== "boolean" ||
        typeof body.leasingRuns !== "boolean" || !Number.isSafeInteger(body.activeRunCount) ||
        body.activeRunCount! < 0) return undefined;
    const { controlToken: _controlToken, ...safe } = state;
    const detail = body.acceptingDurableIntake
      ? body.leasingRuns
        ? "Ponderosa is reachable; durable intake and provider leasing are active."
        : "Ponderosa is reachable; durable intake is active and provider leasing is paused."
      : "Ponderosa is reachable, but durable intake is blocked.";
    return {
      ...safe,
      pid: body.pid!,
      processBirthMarker: body.processBirthMarker,
      shutdownRequestedAt: body.shutdownRequestedAt,
      healthy: true,
      detail,
      acceptingDurableIntake: body.acceptingDurableIntake,
      leasingRuns: body.leasingRuns,
      activeRunCount: body.activeRunCount!,
    };
  } catch {
    return undefined;
  }
}

function canonicalAuthenticatedRecord(state: LauncherState, status: PublicLauncherState): LauncherState {
  const { healthy: _healthy, detail: _detail, acceptingDurableIntake: _intake,
    leasingRuns: _leasing, activeRunCount: _runs, ...record } = status;
  return { ...record, controlToken: state.controlToken };
}

async function waitForProvisionalStatus(
  state: LauncherState,
  fetchFn: typeof globalThis.fetch,
): Promise<PublicLauncherState | undefined> {
  const recordedStart = Date.parse(state.startedAt);
  const deadline = Number.isFinite(recordedStart)
    ? Math.min(Date.now() + START_TIMEOUT_MS, recordedStart + START_TIMEOUT_MS)
    : Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await launcherStatus(state, fetchFn);
    if (status) return status;
    await delay(200);
  }
  return undefined;
}

async function defaultSpawnServer(
  paths: LauncherPaths,
  state: LauncherState,
  env: NodeJS.ProcessEnv,
  transfer: LeaseTransfer,
): Promise<number> {
  for (const logPath of [paths.stdoutLogPath, paths.stderrLogPath]) {
    try {
      if (statSync(logPath).size < LOG_ROTATE_BYTES) continue;
      rmSync(`${logPath}.${LOG_ARCHIVE_COUNT}`, { force: true });
      for (let index = LOG_ARCHIVE_COUNT - 1; index >= 1; index -= 1) {
        const source = `${logPath}.${index}`;
        if (existsSync(source)) renameSync(source, `${logPath}.${index + 1}`);
      }
      renameSync(logPath, `${logPath}.1`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const stdout = openSync(paths.stdoutLogPath, "a", 0o600);
  const stderr = openSync(paths.stderrLogPath, "a", 0o600);
  try {
    if (process.platform === "win32") {
      const generation = randomUUID();
      const statusPath = supervisorStatusPath(paths, generation);
      rmSync(statusPath, { force: true });
      const supervisor = spawn(paths.nodeExecutable, [
        fileURLToPath(new URL("./windows-server-supervisor.js", import.meta.url)),
        paths.serverEntry,
        paths.installRoot,
        statusPath,
        generation,
      ], {
        cwd: paths.installRoot,
        env: transferEnvironment(env, transfer),
        detached: true,
        windowsHide: true,
        stdio: ["ignore", stdout, stderr, "ipc", transfer.descriptor, transfer.parentDescriptor],
      });
      if (!supervisor.pid) throw new Error("Windows server supervisor started without a process ID.");
      const adoption = waitForLeaseAdoption(supervisor, transfer, false);
      void adoption.catch(() => {});
      const pid = await new Promise<number>((resolve, reject) => {
        let settled = false;
        let authorized = false;
        const startupTimer = setTimeout(() => finish(new Error(
          "Windows server startup acknowledgement timed out; its exact control fence is preserved. Inspect the Engine error log.",
        )), START_TIMEOUT_MS);
        const finish = (error: Error | undefined, value?: number): void => {
          if (settled) return;
          settled = true;
          clearTimeout(startupTimer);
          supervisor.off("error", onError);
          supervisor.off("exit", onExit);
          if (error) {
            if (supervisor.connected) supervisor.disconnect();
            reject(error);
          }
          else resolve(value!);
        };
        const onError = (error: Error): void => finish(error);
        const onExit = (code: number | null): void =>
          finish(new Error(`Windows server supervisor exited before launch (code ${code ?? "unknown"}).`));
        supervisor.once("error", onError);
        supervisor.once("exit", onExit);
        supervisor.on("message", (message: unknown) => {
          if (!message || typeof message !== "object" || Array.isArray(message)) return;
          const input = message as {
            type?: unknown;
            pid?: unknown;
            supervisorPid?: unknown;
            generation?: unknown;
            detail?: unknown;
          };
          if (input.type === "supervisor-ready") {
            if (authorized ||
                input.generation !== generation ||
                input.supervisorPid !== supervisor.pid) {
              finish(new Error("Windows server supervisor reported an invalid authorization identity."));
              supervisor.disconnect();
              return;
            }
            try {
              state.supervisorPid = supervisor.pid;
              state.supervisorGeneration = generation;
              // This atomic write is the fence: only after it succeeds may the
              // supervisor create a server process inside its empty Job.
              writeJsonAtomic(paths.statePath, state);
              authorized = true;
              supervisor.send({ type: "authorize", generation }, (error) => {
                if (error) finish(error);
              });
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
            }
          } else if (input.type === "server-started" &&
              authorized &&
              Number.isSafeInteger(input.pid) &&
              (input.pid as number) > 0) {
            finish(undefined, input.pid as number);
          } else if (input.type === "supervisor-error") {
            finish(new Error(typeof input.detail === "string" ? input.detail : "Windows server supervision failed."));
          }
        });
      });
      await adoption;
      if (supervisor.connected) supervisor.disconnect();
      supervisor.unref();
      return pid;
    }
    const child = spawn(paths.nodeExecutable, [paths.serverEntry], {
      cwd: paths.installRoot,
      env: transferEnvironment(env, transfer),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr, "ipc", transfer.descriptor, transfer.parentDescriptor],
    });
    await waitForLeaseAdoption(child, transfer);
    if (!child.pid) throw new Error("Ponderosa server started without a process ID.");
    child.unref();
    return child.pid;
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

function assertInstall(paths: LauncherPaths, manifest: BuildManifest): void {
  for (const [label, pathname] of [
    ["bundled Node runtime", paths.nodeExecutable],
    ["Ponderosa server", paths.serverEntry],
    ["Ponderosa web application", paths.webDist],
  ] as const) {
    if (!existsSync(pathname)) throw new Error(`${label} is missing from this installation (${pathname}).`);
  }
  if (manifest.target.platform !== process.platform || manifest.target.arch !== process.arch) {
    throw new Error(
      `This package targets ${manifest.target.platform}/${manifest.target.arch}, but this host is ${process.platform}/${process.arch}.`,
    );
  }
}

async function defaultRecoverShutdown(paths: LauncherPaths, state: LauncherState, transfer: LeaseTransfer): Promise<void> {
  if (!state.shutdownRequestedAt) throw new Error("shutdown recovery requires an exact requestedAt fence");
  const child = spawn(paths.nodeExecutable, [paths.serverEntry], {
    cwd: paths.installRoot,
    env: transferEnvironment({
      ...process.env,
      PONDEROSA_REPORTED_DATA_DIR: state.dataDir,
      NODE_ENV: "production",
      PONDEROSA_DATA_DIR: state.dataDir,
      PONDEROSA_BUILD_SHA: state.commit,
      PONDEROSA_BUILD_VERSION: state.version,
      PONDEROSA_RELEASE_CHANNEL: state.channel,
      PONDEROSA_INSTALL_ROOT: state.installRoot,
      PONDEROSA_LAUNCHER_CONTROL_TOKEN: state.controlToken,
      PONDEROSA_LAUNCHER_DATA_DIR: paths.dataDir,
      PONDEROSA_LAUNCHER_GENERATION: state.generation,
      PONDEROSA_SHUTDOWN_RECOVERY: "1",
      PONDEROSA_SHUTDOWN_RECOVERY_PID: String(state.pid),
      PONDEROSA_SHUTDOWN_RECOVERY_REQUESTED_AT: state.shutdownRequestedAt,
      ...(state.processBirthMarker
        ? { PONDEROSA_SHUTDOWN_RECOVERY_BIRTH_MARKER: state.processBirthMarker }
        : {}),
    }, transfer),
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc", transfer.descriptor, transfer.parentDescriptor],
  });
  const completion = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("bounded shutdown recovery verifier exceeded 30000ms"));
    }, STOP_TIMEOUT_MS);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`shutdown recovery verifier exited with code ${code ?? "unknown"}`));
    });
  });
  // Observe exit from spawn onward, including immediate post-adoption exit.
  void completion.catch(() => {});
  await waitForLeaseAdoption(child, transfer);
  await completion;
}

function removeExactStateFiles(paths: LauncherPaths, state: Pick<LauncherState, "pid" | "generation" | "supervisorGeneration">): void {
  removeSupervisorStatus(paths, state);
  rmSync(shutdownReceiptPath(paths, state.generation), { force: true });
  rmSync(paths.statePath, { force: true });
  const daemonLock = path.join(paths.applicationDataDir, ".ponderosa-daemon.lock");
  try {
    const owner = JSON.parse(readFileSync(daemonLock, "utf8")) as { pid?: number };
    if (owner.pid === state.pid) rmSync(daemonLock, { force: true });
  } catch {
    // A missing or unrelated daemon lock is not launcher state.
  }
}

async function removeDeadState(
  paths: LauncherPaths,
  state: LauncherState,
  dependencies?: LauncherDependencies,
): Promise<void> {
  const reboot = supervisorBootRecovery(paths, state);
  if (reboot?.rebooted) {
    requireLocalLauncherMutation(paths);
    writeJsonAtomic(reboot.pathname, { ...reboot.receipt, status: "drained",
      updatedAt: new Date().toISOString(), detail: "A different Windows kernel boot proves the previous Job ended." });
  }
  if (!reboot?.rebooted && state.supervisorPid && processAlive(state.supervisorPid)) {
    throw new Error(
      "Ponderosa's Windows process-tree supervisor is still draining. Retry after it exits; replacement is blocked.",
    );
  }
  if (!reboot?.rebooted && processAlive(state.pid)) {
    const exactRetry = Boolean(
      state.shutdownRequestedAt && state.processBirthMarker &&
      launcherProcessBirthMarker(state.pid) === state.processBirthMarker,
    );
    if (!exactRetry) {
      throw new Error(
        "Ponderosa's recorded process is live without exact post-close birth evidence. Replacement remains blocked.",
      );
    }
    process.kill(state.pid, "SIGTERM");
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline && processAlive(state.pid)) await delay(200);
    if (processAlive(state.pid)) {
      throw new Error("The exact Ponderosa process remains live after bounded strict-cleanup retry. Replacement remains blocked.");
    }
  }
  if (!supervisorDrained(paths, state)) {
    if (reboot && reboot.receipt.bootId === undefined && reboot.receipt.recoveryBootId === undefined) {
      requireLocalLauncherMutation(paths);
      writeJsonAtomic(reboot.pathname, { ...reboot.receipt, recoveryBootId: reboot.bootId });
    }
    throw Object.assign(new Error(
      "Ponderosa's Windows process-tree supervisor did not prove that its Job drained. Replacement remains blocked." +
        (reboot ? " Restart Windows, then retry to verify that the previous Job ended." : ""),
    ), { code: reboot ? "WINDOWS_REBOOT_REQUIRED" : "WINDOWS_JOB_DRAIN_UNPROVED" });
  }
  if (state.shutdownRequestedAt && readShutdownReceipt(paths, state)?.state !== "clean") {
    if (!dependencies?.recoverShutdown) throw new Error("current shutdown recovery requires an admitted lease transfer");
    await dependencies.recoverShutdown(paths, state);
  }
  requireCleanShutdownReceipt(paths, state);
  removeExactStateFiles(paths, state);
}

function selectedPort(configurationPort: number | undefined, requestedPort: number | undefined): number {
  const port = requestedPort ?? configurationPort ?? 8787;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The configured Ponderosa port must be between 1 and 65535.");
  }
  return port;
}

async function waitForStart(
  state: LauncherState,
  fetchFn: typeof globalThis.fetch,
  timeoutMs = START_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(state.pid)) {
      throw new Error("Ponderosa exited before it became ready. Open the server error log or run diagnostics.");
    }
    if (await launcherStatus(state, fetchFn)) return;
    await delay(200);
  }
  throw new Error("Ponderosa did not become ready in time. Check the server and error logs in Ponderosa Engine before retrying.");
}

export async function requestBrowserBootstrap(
  state: LauncherState,
  platform: PlatformAdapter,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const response = await fetchFn(`${baseUrl(state)}/api/launcher/bootstrap`, {
    method: "POST",
    headers: bearer(state.controlToken),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Could not open Ponderosa: ${await responseDetail(response)}`);
  const body = await response.json() as { token?: unknown };
  if (typeof body.token !== "string" || body.token === "") {
    throw new Error("Ponderosa returned an invalid browser bootstrap.");
  }
  await platform.openBrowser(
    `${baseUrl(state)}/__ponderosa_bootstrap#${encodeURIComponent(body.token)}`,
  );
}

export async function startPonderosa(input: {
  paths: LauncherPaths;
  manifest: BuildManifest;
  platform: PlatformAdapter;
  requestedPort?: number;
  openBrowser?: boolean;
  dependencies?: LauncherDependencies;
}): Promise<LauncherState> {
  assertInstall(input.paths, input.manifest);
  if (input.dependencies?.spawnServer || input.dependencies?.recoverShutdown || input.dependencies?.fetch) {
    throw new Error("injected launcher startup cannot attest current physical lease transfer");
  }
  const originalPaths = input.paths;
  const fetchFn = globalThis.fetch;
  const existing = readLauncherState(originalPaths.statePath);
  if (existing) {
    const immediate = await launcherStatus(existing, fetchFn);
    const current = immediate ?? (existing.pid === 0 ? await waitForProvisionalStatus(existing, fetchFn) : undefined);
    if (current) {
      validateCurrentLookup(originalPaths, current);
      const recovered = canonicalAuthenticatedRecord(existing, current);
        if (input.openBrowser !== false) await requestBrowserBootstrap(recovered, input.platform, fetchFn);
      return recovered;
    }
  }
  const local = await acquireCurrentLocal(originalPaths, existing);
  const parent = local.parent;
  let admission = local.admission;
  input = { ...input, paths: local.paths };
  let release: (() => void) | undefined;
  try {
    ensureDataLayout(input.paths);
    release = await acquireOperationLockWithWait(input.paths.operationLockPath);
    if (existing) {
      let recovered = false;
      await removeDeadState(input.paths, existing, { recoverShutdown: async (paths, state) => {
        recovered = true;
        release?.(); release = undefined;
        await defaultRecoverShutdown(paths, state, prepareLeaseTransfer(admission, parent));
        admission.revalidateTransferredState();
      } });
      if (recovered) {
        const expectedRoot = { generationId: existing.stateGenerationId!, dataIdentity: existing.physicalDataDirectoryIdentity! };
        admission.close();
        admission = await admitLauncherData({ ...input.paths, applicationDataDir: path.join(parent.rootPath, "data") }, expectedRoot);
        input = { ...input, paths: { ...input.paths, applicationDataDir: admission.dataDir } };
        release = await acquireOperationLockWithWait(input.paths.operationLockPath);
      }
    }
    const configuration = readLauncherConfiguration(input.paths.configPath);
    const port = selectedPort(configuration.port, input.requestedPort);
    const providers = await discoverProviders(
      input.platform,
      configuration,
      input.dependencies?.env ?? process.env,
    );
    const provisional: LauncherState = {
      schemaVersion: 2,
      generation: randomUUID(),
      controlToken: randomBytes(32).toString("base64url"),
      pid: 0,
      port,
      host: LOOPBACK_HOST,
      startedAt: new Date().toISOString(),
      ...launcherStateLocation(originalPaths),
      stateEpoch: 2, stateGenerationId: admission.generationId,
      physicalDataDirectoryIdentity: admission.physicalIdentity,
      physicalLauncherDirectoryIdentity: physicalDirectoryIdentity(parent.rootPath),
      version: input.manifest.version,
      commit: input.manifest.commit,
      channel: input.manifest.channel,
    };
    const environment: NodeJS.ProcessEnv = {
      ...(input.dependencies?.env ?? process.env),
      NODE_ENV: "production",
      PONDEROSA_DATA_DIR: input.paths.applicationDataDir,
      PONDEROSA_REPORTED_DATA_DIR: originalPaths.applicationDataDir,
      PONDEROSA_HOST: LOOPBACK_HOST,
      PONDEROSA_PORT: String(port),
      PONDEROSA_BUILD_SHA: input.manifest.commit,
      PONDEROSA_BUILD_VERSION: input.manifest.version,
      PONDEROSA_RELEASE_CHANNEL: input.manifest.channel,
      PONDEROSA_LAUNCHER_CONTROL_TOKEN: provisional.controlToken,
      PONDEROSA_LAUNCHER_DATA_DIR: input.paths.dataDir,
      PONDEROSA_LAUNCHER_GENERATION: provisional.generation,
      PONDEROSA_INSTALL_ROOT: input.paths.installRoot,
    };
    for (const provider of providers) {
      if (!provider.executable) continue;
      environment[provider.id === "codex" ? "PONDEROSA_CODEX_BIN" : "PONDEROSA_CLAUDE_BIN"] =
        provider.executable;
    }
    // Persist the control proof before the server can exist. If this launcher
    // dies after spawn but before recording the PID, the next launcher can
    // authenticate the exact server's daemon-canonicalized PID on the recorded port.
    writeJsonAtomic(input.paths.statePath, provisional);
    // Native leases serialize the handoff. No launcher record cleanup may run
    // after the admitted child owns the live parent/application lifecycle.
    release?.(); release = undefined;
    const transfer = prepareLeaseTransfer(admission, parent);
    let pid: number;
    try { pid = await defaultSpawnServer(input.paths, provisional, environment, transfer); }
    catch (error) { throw error; } // Exact provisional proof survives uncertain adoption.
    const processBirthMarker = launcherProcessBirthMarker(pid);
    const state = { ...provisional, pid, ...(processBirthMarker ? { processBirthMarker } : {}) };
    // The admitted child canonicalized the durable provisional record before ACK.
    try {
      await waitForStart(state, fetchFn);
    } catch (error) { throw error; } // Startup failure never erases an uncertain control fence.
    if (input.openBrowser !== false) {
      await requestBrowserBootstrap(
        state,
        input.platform,
        fetchFn,
      );
    }
    return state;
  } finally {
    release?.(); admission.close(); parent.close();
  }
}

function sameControl(expected: LauncherState, actual: LauncherState | undefined): void {
  if (!actual || actual.generation !== expected.generation || actual.controlToken !== expected.controlToken ||
      actual.stateEpoch !== 2 || actual.stateGenerationId !== expected.stateGenerationId ||
      actual.physicalDataDirectoryIdentity !== expected.physicalDataDirectoryIdentity ||
      actual.physicalLauncherDirectoryIdentity !== expected.physicalLauncherDirectoryIdentity ||
      actual.pid !== expected.pid || actual.processBirthMarker !== expected.processBirthMarker ||
      actual.shutdownRequestedAt !== expected.shutdownRequestedAt || actual.supervisorGeneration !== expected.supervisorGeneration ||
      actual.supervisorPid !== expected.supervisorPid || actual.dataDir !== expected.dataDir || actual.installRoot !== expected.installRoot) {
    throw new Error("exact launcher control authority changed; bytes are preserved");
  }
}
async function acquireCurrentLocal(paths: LauncherPaths, expected?: LauncherState, expectedRoot?: { generationId: string; dataIdentity: string; parentIdentity: string }) {
  if (expected) validateCurrentLookup(paths, expected);
  const parent = acquireLauncherParent(paths);
  try {
    if (expected && physicalDirectoryIdentity(parent.rootPath) !== expected.physicalLauncherDirectoryIdentity) throw new Error("launcher parent identity changed");
    if (expectedRoot) {
      if (physicalDirectoryIdentity(parent.rootPath) !== expectedRoot.parentIdentity || physicalDirectoryIdentity(path.join(parent.rootPath, "data")) !== expectedRoot.dataIdentity) throw new Error("held physical roots changed");
    }
    const candidate = { ...paths, applicationDataDir: path.join(parent.rootPath, "data"), statePath: path.join(parent.rootPath, "launcher-state", "instance.json") };
    if (expected) sameControl(expected, readLauncherState(candidate.statePath));
    const admission = await admitLauncherData(candidate, expectedRoot);
    const heldPaths = bindLauncherPaths(paths, parent.rootPath, admission.dataDir);
    const guard = () => { if (DataDirectoryAuthority.ownedRoot(parent) !== heldPaths.dataDir) throw new Error("local launcher lifetime changed"); };
    localMutationPaths.set(heldPaths, guard); localMutationLocks.set(heldPaths.operationLockPath, guard);
    return { parent, admission, paths: heldPaths };
  } catch (error) { parent.close(); throw error; }
}
export async function withLocalLauncherAuthority<T>(paths: LauncherPaths, action: (paths: LauncherPaths, identity: {
  generationId: string; dataIdentity: string; parentIdentity: string;
}) => Promise<T> | T, expected?: { generationId: string; dataIdentity: string; parentIdentity: string }): Promise<T> {
  const local = await acquireCurrentLocal(paths, undefined, expected);
  try {
    const current = { generationId: local.admission.generationId, dataIdentity: local.admission.physicalIdentity,
      parentIdentity: physicalDirectoryIdentity(local.parent.rootPath) };
    if (expected && (current.generationId !== expected.generationId || current.dataIdentity !== expected.dataIdentity ||
        current.parentIdentity !== expected.parentIdentity)) throw new Error("current physical launcher generation changed");
    return await action(local.paths, current);
  } finally { local.admission.close(); local.parent.close(); }
}
/** Read pinning is never mutable admission or a remote flock. */
export async function inspectLauncher(paths: LauncherPaths): Promise<{ paths: LauncherPaths; readOnly: boolean; close(): void }> {
  const recorded = readLauncherState(paths.statePath);
  const status = recorded ? await launcherStatus(recorded) : undefined;
  if (!status) {
    const local = await acquireCurrentLocal(paths, recorded);
    return { paths: local.paths, readOnly: false, close: () => { local.admission.close(); local.parent.close(); } };
  }
  validateCurrentLookup(paths, status);
  const descriptors: number[] = [];
  const references: DataDirectoryReadReference[] = [];
  try {
    const pin = (root: string, expected: string): string => {
      if (process.platform !== "linux") {
        const reference = new DataDirectoryReadReference(root); references.push(reference);
        if (physicalDirectoryIdentity(reference.rootPath) !== expected) throw new Error("read-only lookup changed physical identity");
        return reference.rootPath;
      }
      const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      descriptors.push(fd); const stat = fstatSync(fd, { bigint: true });
      if (`${stat.dev}:${stat.ino}` !== expected) throw new Error("read-only lookup changed physical identity");
      return `/proc/self/fd/${fd}`;
    };
    const parent = pin(paths.dataDir, status.physicalLauncherDirectoryIdentity!);
    const data = pin(paths.applicationDataDir, status.physicalDataDirectoryIdentity!);
    return { paths: bindLauncherPaths(paths, parent, data), readOnly: true, close: () => { descriptors.forEach(closeSync); references.forEach(reference => reference.close()); } };
  } catch (error) { descriptors.forEach(closeSync); references.forEach(reference => reference.close()); throw error; }
}
export async function stopPonderosa(input: {
  paths: LauncherPaths; fetch?: typeof globalThis.fetch;
  dependencies?: Pick<LauncherDependencies, "recoverShutdown">;
}): Promise<"stopped" | "not_running"> {
  if (input.fetch || input.dependencies?.recoverShutdown) throw new Error("injected stop cannot attest current state ownership");
  const original = input.paths;
  const state = readLauncherState(original.statePath);
  if (!state) { if (existsSync(original.statePath)) throw new Error("unsupported launcher control record"); return "not_running"; }
  const current = await launcherStatus(state);
  let expected = state;
  if (current) {
    validateCurrentLookup(original, current);
    const canonical = canonicalAuthenticatedRecord(state, current);
    const requestedAt = canonical.shutdownRequestedAt ?? new Date().toISOString();
    expected = { ...canonical, shutdownRequestedAt: requestedAt };
    const response = await globalThis.fetch(`${baseUrl(canonical)}/api/launcher/shutdown`, {
      method: "POST", headers: { ...bearer(canonical.controlToken), "content-type": "application/json" },
      body: JSON.stringify({ generation: canonical.generation, requestedAt }), signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Ponderosa could not begin shutdown: ${await responseDetail(response)}`);
    const stillOwned = () => processAlive(canonical.pid) || Boolean(canonical.supervisorPid && processAlive(canonical.supervisorPid));
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline && stillOwned()) await delay(200);
    if (stillOwned()) throw new Error("Ponderosa is still finishing cleanup; exact shutdown remains fenced.");
  } else if (!supervisorBootRecovery(original, state)?.rebooted &&
      (processAlive(state.pid) || state.supervisorPid && processAlive(state.supervisorPid))) {
    throw new Error("recorded process is still live without authenticated current authority");
  }
  // A fresh lease is authority for new local cleanup, never retrospective transfer.
  const local = await acquireCurrentLocal(original, expected);
  let release: (() => void) | undefined;
  try {
    release = await acquireOperationLockWithWait(local.paths.operationLockPath);
    sameControl(expected, readLauncherState(local.paths.statePath));
    if (current) {
      if (!supervisorDrained(local.paths, expected)) throw new Error("exact process-tree cleanup remains unproved");
      requireCleanShutdownReceipt(local.paths, expected);
      removeExactStateFiles(local.paths, expected);
      return "stopped";
    }
    await removeDeadState(local.paths, expected, { recoverShutdown: async (paths, record) => {
      release?.(); release = undefined;
      await defaultRecoverShutdown(paths, record, prepareLeaseTransfer(local.admission, local.parent));
      local.admission.revalidateTransferredState();
    } });
    return expected.shutdownRequestedAt ? "stopped" : "not_running";
  } finally { release?.(); local.admission.close(); local.parent.close(); }
}

export async function currentPonderosaStatus(
  paths: LauncherPaths,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<PublicLauncherState | undefined> {
  const state = readLauncherState(paths.statePath);
  if (!state) return undefined;
  const status = await launcherStatus(state, fetchFn);
  if (status) { validateCurrentLookup(paths, status); return status; }
  const { controlToken: _controlToken, ...safe } = state;
  return {
    ...safe,
    healthy: false,
    acceptingDurableIntake: false,
    leasingRuns: false,
    activeRunCount: 0,
    detail: processAlive(state.pid)
      ? "A recorded Ponderosa process exists but did not prove control ownership."
      : "Ponderosa is not running; stale launcher state can be recovered on the next start.",
  };
}
