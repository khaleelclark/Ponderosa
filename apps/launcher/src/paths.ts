import { requireLocalLauncherMutation } from "./control.js";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "@ponderosa/native-host/fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LauncherConfiguration,
  LauncherPaths,
  LauncherState,
  PlatformAdapter,
} from "./types.js";

export function defaultInstallRoot(importMetaUrl = import.meta.url): string {
  const here = path.dirname(fileURLToPath(importMetaUrl));
  return path.resolve(here, "../../..");
}

export function resolveLauncherPaths(input: {
  platform: PlatformAdapter;
  env?: NodeJS.ProcessEnv;
  installRoot?: string;
  dataDir?: string;
}): LauncherPaths {
  const env = input.env ?? process.env;
  const installRoot = path.resolve(
    input.installRoot ?? env.PONDEROSA_INSTALL_ROOT?.trim() ?? defaultInstallRoot(),
  );
  const dataDir = path.resolve(
    input.dataDir ?? env.PONDEROSA_LAUNCHER_DATA_DIR?.trim() ?? input.platform.defaultDataDir(env),
  );
  const applicationDataDir = path.join(dataDir, "data");
  const runtimeDir = path.join(dataDir, "runtime");
  const logsDir = path.join(dataDir, "logs");
  const diagnosticsDir = path.join(dataDir, "diagnostics");
  const configDir = path.join(dataDir, "config");
  const stateDir = path.join(dataDir, "launcher-state");
  return {
    installRoot,
    dataDir,
    applicationDataDir,
    runtimeDir,
    logsDir,
    diagnosticsDir,
    configDir,
    stateDir,
    nodeExecutable: path.join(installRoot, "runtime", input.platform.nodeExecutableName()),
    serverEntry: path.join(installRoot, "app", "server", "dist", "main.js"),
    webDist: path.join(installRoot, "app", "web", "dist"),
    manifestPath: path.join(installRoot, "build-manifest.json"),
    configPath: path.join(configDir, "launcher.json"),
    statePath: path.join(stateDir, "instance.json"),
    operationLockPath: path.join(stateDir, "operation.lock"),
    engineSupervisorPath: path.join(stateDir, "engine-supervisor.json"),
    stdoutLogPath: path.join(logsDir, "server.log"),
    stderrLogPath: path.join(logsDir, "server-error.log"),
  };
}

export function launcherStateLocation(
  paths: LauncherPaths,
): Pick<LauncherState, "dataDir" | "installRoot"> {
  return {
    dataDir: paths.applicationDataDir,
    installRoot: paths.installRoot,
  };
}

export function ensureDataLayout(paths: LauncherPaths): void {
  requireLocalLauncherMutation(paths);
  for (const directory of [
    paths.dataDir,
    paths.applicationDataDir,
    paths.runtimeDir,
    path.join(paths.dataDir, "checkpoints"),
    paths.logsDir,
    paths.diagnosticsDir,
    path.join(paths.dataDir, "backups"),
    paths.configDir,
    paths.stateDir,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { chmodSync(directory, 0o700); } catch { /* Windows ignores POSIX modes. */ }
  }
}

export function readLauncherConfiguration(pathname: string): LauncherConfiguration {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(pathname, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("launcher configuration is not a supported current object", { cause: error });
  }
  const value = parsed as LauncherConfiguration;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["port", "providers"].includes(key)) ||
      (value.port !== undefined && (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535))) {
    throw new Error("launcher configuration contains unsupported current fields");
  }
  if (value.providers !== undefined) {
    if (!value.providers || typeof value.providers !== "object" || Array.isArray(value.providers) ||
        Object.keys(value.providers).some(key => !["codex", "claude"].includes(key))) throw new Error("unsupported provider configuration");
    for (const provider of Object.values(value.providers)) {
      if (!provider || typeof provider !== "object" || Array.isArray(provider) || Object.keys(provider).some(key => key !== "executable") ||
          (provider.executable !== undefined && (typeof provider.executable !== "string" || !provider.executable || provider.executable.includes("\0")))) {
        throw new Error("unsupported provider executable configuration");
      }
    }
  }
  return value;
}

export function readLauncherState(pathname: string): LauncherState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(pathname, "utf8")) as LauncherState;
    if (parsed.schemaVersion !== 2 ||
        typeof parsed.generation !== "string" || !/^[0-9a-f-]{36}$/iu.test(parsed.generation) ||
        typeof parsed.controlToken !== "string" || parsed.controlToken.length < 32 ||
        (parsed.supervisorPid !== undefined &&
          (!Number.isSafeInteger(parsed.supervisorPid) || parsed.supervisorPid <= 0)) ||
        (parsed.supervisorGeneration !== undefined &&
          (typeof parsed.supervisorGeneration !== "string" ||
            !/^[0-9a-f-]{36}$/iu.test(parsed.supervisorGeneration))) ||
        ((parsed.supervisorPid === undefined) !== (parsed.supervisorGeneration === undefined)) ||
        !Number.isSafeInteger(parsed.pid) || parsed.pid < 0 ||
        (parsed.processBirthMarker !== undefined &&
          (typeof parsed.processBirthMarker !== "string" || parsed.processBirthMarker.length === 0)) ||
        !Number.isSafeInteger(parsed.port) || parsed.port < 1 || parsed.port > 65_535 ||
        parsed.host !== "127.0.0.1" ||
        typeof parsed.startedAt !== "string" || !Number.isFinite(Date.parse(parsed.startedAt)) ||
        typeof parsed.dataDir !== "string" || parsed.dataDir.length === 0 ||
        typeof parsed.installRoot !== "string" || parsed.installRoot.length === 0 ||
        typeof parsed.version !== "string" || parsed.version.length === 0 ||
        typeof parsed.commit !== "string" || parsed.commit.length === 0 ||
        typeof parsed.channel !== "string" || parsed.channel.length === 0 ||
        (parsed.shutdownRequestedAt !== undefined &&
          (typeof parsed.shutdownRequestedAt !== "string" || !Number.isFinite(Date.parse(parsed.shutdownRequestedAt))))) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeJsonAtomic(pathname: string, value: unknown): void {
  const temporary = `${pathname}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ignores POSIX modes. */ }
  // Windows requires a writable handle for FlushFileBuffers (fsync). Opening
  // the completed temporary file read-only works on POSIX but fails with EPERM
  // on Windows before the launcher can publish its state.
  const file = openSync(temporary, "r+");
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, pathname);
  // A durable rename requires the containing directory on POSIX. Windows
  // does not permit opening directories this way, while its rename remains
  // atomic for the same-volume launcher state used here.
  if (process.platform !== "win32") {
    const directory = openSync(path.dirname(pathname), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

/** Bind mutable launcher paths to a retained physical root after admission. */
export function bindLauncherPaths(paths: LauncherPaths, root: string, applicationRoot: string): LauncherPaths {
  const bound = { ...paths };
  for (const key of ["runtimeDir", "logsDir", "diagnosticsDir", "configDir", "stateDir", "configPath", "statePath", "operationLockPath", "engineSupervisorPath", "stdoutLogPath", "stderrLogPath"] as const) {
    const relative = path.relative(paths.dataDir, paths[key]);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("launcher path escapes its physical root");
    bound[key] = path.join(root, relative);
  }
  bound.dataDir = root; bound.applicationDataDir = applicationRoot;
  return bound;
}
