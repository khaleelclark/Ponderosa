import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverProviders } from "./providers.js";
import {
  ensureDataLayout,
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

const LOOPBACK_HOST = "127.0.0.1" as const;
const START_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 30_000;
const OPERATION_LOCK_INITIALIZATION_GRACE_MS = 5_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const LOG_ARCHIVE_COUNT = 3;

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function supervisorStatusPath(paths: LauncherPaths, generation: string): string {
  return path.join(paths.runtimeDir, `server-supervisor-${generation}.json`);
}

function supervisorDrained(paths: LauncherPaths, state: LauncherState): boolean {
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

function removeSupervisorStatus(paths: LauncherPaths, state: LauncherState): void {
  if (state.supervisorGeneration) {
    rmSync(supervisorStatusPath(paths, state.supervisorGeneration), { force: true });
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
    };
    if (!Number.isSafeInteger(body.pid) || body.pid! <= 0 ||
        (state.pid > 0 && body.pid !== state.pid) || body.dataDir !== state.dataDir ||
        body.version !== state.version || body.commit !== state.commit ||
        body.channel !== state.channel) return undefined;
    const { controlToken: _controlToken, ...safe } = state;
    return { ...safe, pid: body.pid!, healthy: true, detail: "Ponderosa is running." };
  } catch {
    return undefined;
  }
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
        env,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", stdout, stderr, "ipc"],
      });
      if (!supervisor.pid) throw new Error("Windows server supervisor started without a process ID.");
      const pid = await new Promise<number>((resolve, reject) => {
        let settled = false;
        let authorized = false;
        const finish = (error: Error | undefined, value?: number): void => {
          if (settled) return;
          settled = true;
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
      supervisor.unref();
      return pid;
    }
    const child = spawn(paths.nodeExecutable, [paths.serverEntry], {
      cwd: paths.installRoot,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
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

function removeDeadState(paths: LauncherPaths, state: LauncherState): void {
  if (state.supervisorPid && processAlive(state.supervisorPid)) {
    throw new Error(
      "Ponderosa's Windows process-tree supervisor is still draining. Retry after it exits; replacement is blocked.",
    );
  }
  if (processAlive(state.pid)) {
    throw new Error(
      "Ponderosa's recorded process still exists but did not prove ownership. Run diagnostics before forcing recovery.",
    );
  }
  if (!supervisorDrained(paths, state)) {
    throw new Error(
      "Ponderosa's Windows process-tree supervisor did not prove that its Job drained. Replacement remains blocked.",
    );
  }
  removeSupervisorStatus(paths, state);
  rmSync(paths.statePath, { force: true });
  const daemonLock = path.join(paths.applicationDataDir, ".ponderosa-daemon.lock");
  try {
    const owner = JSON.parse(readFileSync(daemonLock, "utf8")) as { pid?: number };
    if (owner.pid === state.pid) rmSync(daemonLock, { force: true });
  } catch {
    // A missing or unrelated daemon lock is not launcher state.
  }
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
  throw new Error("Ponderosa did not become ready in time. Run `ponderosa doctor` for an actionable diagnosis.");
}

export async function requestBrowserBootstrap(
  state: LauncherState,
  platform: PlatformAdapter,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  destination = "/",
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
  const next = destination === "/settings/engine" ? destination : "/";
  await platform.openBrowser(
    `${baseUrl(state)}/__ponderosa_bootstrap?next=${encodeURIComponent(next)}#${encodeURIComponent(body.token)}`,
  );
}

export async function startPonderosa(input: {
  paths: LauncherPaths;
  manifest: BuildManifest;
  platform: PlatformAdapter;
  requestedPort?: number;
  openBrowser?: boolean;
  browserPath?: string;
  dependencies?: LauncherDependencies;
}): Promise<LauncherState> {
  ensureDataLayout(input.paths);
  assertInstall(input.paths, input.manifest);
  const release = await acquireOperationLockWithWait(input.paths.operationLockPath);
  const fetchFn = input.dependencies?.fetch ?? globalThis.fetch;
  try {
    const existing = readLauncherState(input.paths.statePath);
    if (existing) {
      const immediate = await launcherStatus(existing, fetchFn);
      const current = immediate ?? (existing.pid === 0
        ? await waitForProvisionalStatus(existing, fetchFn) : undefined);
      if (current) {
        const recovered = existing.pid > 0 ? existing : { ...existing, pid: current.pid };
        if (existing.pid <= 0) writeJsonAtomic(input.paths.statePath, recovered);
        if (input.openBrowser !== false) {
          await requestBrowserBootstrap(
            recovered,
            input.platform,
            fetchFn,
            input.browserPath,
          );
        }
        return recovered;
      }
      removeDeadState(input.paths, existing);
    }
    const configuration = readLauncherConfiguration(input.paths.configPath);
    const port = selectedPort(configuration.port, input.requestedPort);
    const providers = await discoverProviders(
      input.platform,
      configuration,
      input.dependencies?.env ?? process.env,
    );
    const provisional: LauncherState = {
      schemaVersion: 1,
      controlToken: randomBytes(32).toString("base64url"),
      pid: 0,
      port,
      host: LOOPBACK_HOST,
      startedAt: (input.dependencies?.now ?? (() => new Date()))().toISOString(),
      ...launcherStateLocation(input.paths),
      version: input.manifest.version,
      commit: input.manifest.commit,
      channel: input.manifest.channel,
    };
    const environment: NodeJS.ProcessEnv = {
      ...(input.dependencies?.env ?? process.env),
      NODE_ENV: "production",
      PONDEROSA_DATA_DIR: input.paths.applicationDataDir,
      PONDEROSA_HOST: LOOPBACK_HOST,
      PONDEROSA_PORT: String(port),
      PONDEROSA_BUILD_SHA: input.manifest.commit,
      PONDEROSA_BUILD_VERSION: input.manifest.version,
      PONDEROSA_RELEASE_CHANNEL: input.manifest.channel,
      PONDEROSA_LAUNCHER_CONTROL_TOKEN: provisional.controlToken,
      PONDEROSA_LAUNCHER_DATA_DIR: input.paths.dataDir,
      PONDEROSA_INSTALL_ROOT: input.paths.installRoot,
    };
    for (const provider of providers) {
      if (!provider.executable) continue;
      environment[provider.id === "codex" ? "PONDEROSA_CODEX_BIN" : "PONDEROSA_CLAUDE_BIN"] =
        provider.executable;
    }
    // Persist the control proof before the server can exist. If this launcher
    // dies after spawn but before recording the PID, the next launcher can
    // authenticate the exact server on the recorded port and repair the PID.
    writeJsonAtomic(input.paths.statePath, provisional);
    const spawnServer = input.dependencies?.spawnServer ?? defaultSpawnServer;
    let pid: number;
    try {
      pid = await spawnServer(input.paths, provisional, environment);
    } catch (error) {
      if (!provisional.supervisorGeneration) {
        rmSync(input.paths.statePath, { force: true });
      } else if ((!provisional.supervisorPid || !processAlive(provisional.supervisorPid)) &&
          supervisorDrained(input.paths, provisional)) {
        removeSupervisorStatus(input.paths, provisional);
        rmSync(input.paths.statePath, { force: true });
      }
      // A live supervisor or missing exact drained record keeps its durable
      // fence after launch failure, so restart cannot race Job teardown.
      throw error;
    }
    const state = { ...provisional, pid };
    writeJsonAtomic(input.paths.statePath, state);
    try {
      await waitForStart(state, fetchFn);
    } catch (error) {
      if (!processAlive(pid)) {
        if (!state.supervisorGeneration) {
          rmSync(input.paths.statePath, { force: true });
        } else if (!state.supervisorPid || !processAlive(state.supervisorPid)) {
          if (supervisorDrained(input.paths, state)) {
            removeSupervisorStatus(input.paths, state);
            rmSync(input.paths.statePath, { force: true });
          }
          // A missing/non-drained completion record deliberately retains state
          // and blocks replacement after a failed Windows launch.
        }
      }
      throw error;
    }
    if (input.openBrowser !== false) {
      await requestBrowserBootstrap(
        state,
        input.platform,
        fetchFn,
        input.browserPath,
      );
    }
    return state;
  } finally {
    release();
  }
}

export async function stopPonderosa(input: {
  paths: LauncherPaths;
  fetch?: typeof globalThis.fetch;
}): Promise<"stopped" | "not_running"> {
  ensureDataLayout(input.paths);
  const release = await acquireOperationLockWithWait(input.paths.operationLockPath);
  const fetchFn = input.fetch ?? globalThis.fetch;
  try {
    const state = readLauncherState(input.paths.statePath);
    if (!state) return "not_running";
    const current = await launcherStatus(state, fetchFn);
    if (!current) {
      removeDeadState(input.paths, state);
      return "not_running";
    }
    const response = await fetchFn(`${baseUrl(state)}/api/launcher/shutdown`, {
      method: "POST",
      headers: bearer(state.controlToken),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Ponderosa could not begin shutdown: ${await responseDetail(response)}`);
    const stillOwned = () =>
      processAlive(state.pid) || Boolean(state.supervisorPid && processAlive(state.supervisorPid));
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline && stillOwned()) await delay(200);
    if (stillOwned()) {
      throw new Error("Ponderosa is still finishing provider or browser cleanup. Check diagnostics before retrying.");
    }
    if (!supervisorDrained(input.paths, state)) {
      throw new Error(
        "Ponderosa's Windows process-tree supervisor exited without proving that its Job drained. Replacement remains blocked.",
      );
    }
    removeSupervisorStatus(input.paths, state);
    rmSync(input.paths.statePath, { force: true });
    return "stopped";
  } finally {
    release();
  }
}

export async function currentPonderosaStatus(
  paths: LauncherPaths,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<PublicLauncherState | undefined> {
  const state = readLauncherState(paths.statePath);
  if (!state) return undefined;
  const status = await launcherStatus(state, fetchFn);
  if (status) {
    if (state.pid <= 0) writeJsonAtomic(paths.statePath, { ...state, pid: status.pid });
    return status;
  }
  const { controlToken: _controlToken, ...safe } = state;
  return {
    ...safe,
    healthy: false,
    detail: processAlive(state.pid)
      ? "A recorded Ponderosa process exists but did not prove control ownership."
      : "Ponderosa is not running; stale launcher state can be recovered on the next start.",
  };
}
