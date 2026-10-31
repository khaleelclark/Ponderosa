import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
  type MessageBoxOptions,
} from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyEngineReadiness,
  type EngineReadinessSnapshot,
  type EngineState,
  type EngineSnapshot,
  type LogTail,
} from "./engine-state.js";

interface LauncherState {
  schemaVersion: 2;
  generation: string;
  controlToken: string;
  pid: number;
  port: number;
  host: "127.0.0.1";
  startedAt: string;
  dataDir: string;
  installRoot: string;
  version: string;
  commit: string;
  channel: string;
}

interface LauncherStatus {
  service: "ponderosa";
  pid: number;
  dataDir: string;
  version: string;
  commit: string;
  channel: string;
  acceptingDurableIntake: boolean;
  leasingRuns: boolean;
  activeRunCount: number;
}

interface BundleIdentity {
  version: string;
  commit: string;
  channel: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const argumentValue = (name: string): string | undefined => {
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const requestedDataDir = argumentValue("--data-dir");
const requestedPort = argumentValue("--port");
const suppressInitialBrowser = process.argv.includes("--no-browser");
const installRoot = process.env.PONDEROSA_INSTALL_ROOT?.trim() ||
  (app.isPackaged
    ? path.join(process.resourcesPath, "Ponderosa")
    : path.resolve(here, "../../../dist/beta", `${process.platform}-${process.arch}`, "Ponderosa"));
const nodeExecutable = path.join(installRoot, "runtime", process.platform === "win32" ? "node.exe" : "node");
const launcherEntry = path.join(installRoot, "app", "launcher", "dist", "cli.js");
const launcherRoot = requestedDataDir ||
  process.env.PONDEROSA_LAUNCHER_DATA_DIR?.trim() || (() => {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Ponderosa");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA?.trim() ||
      path.join(os.homedir(), "AppData", "Local"), "Ponderosa");
  }
  return path.join(process.env.XDG_DATA_HOME?.trim() ||
    path.join(os.homedir(), ".local", "share"), "ponderosa");
})();
const launcherStatePath = path.join(launcherRoot, "launcher-state", "instance.json");
const bundleManifestPath = path.join(installRoot, "build-manifest.json");
const emptyLog = (stream: "server" | "error"): LogTail => ({
  stream,
  text: "",
  totalBytes: 0,
  returnedBytes: 0,
  truncated: false,
});

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let engineProcess: ChildProcess | undefined;
let engineState: EngineState = "starting";
let engineDetail = "Starting the local Ponderosa service…";
let allowQuit = false;
let quitInProgress = false;
let launchOutput = "";
const readyEngines = new WeakSet<ChildProcess>();

function notifyChanged(): void {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send("engine:changed");
  }
}

async function bundleIdentity(): Promise<BundleIdentity | undefined> {
  try {
    const manifest = JSON.parse(await readFile(bundleManifestPath, "utf8")) as Partial<BundleIdentity>;
    if (
      typeof manifest.version !== "string" ||
      typeof manifest.commit !== "string" ||
      typeof manifest.channel !== "string"
    ) return undefined;
    return manifest as BundleIdentity;
  } catch {
    return undefined;
  }
}

async function readState(): Promise<LauncherState | undefined> {
  try {
    const state = JSON.parse(await readFile(launcherStatePath, "utf8")) as Partial<LauncherState>;
    if (
      typeof state.controlToken !== "string" ||
      state.schemaVersion !== 2 ||
      typeof state.generation !== "string" || !/^[0-9a-f-]{36}$/iu.test(state.generation) ||
      !Number.isSafeInteger(state.pid) ||
      !Number.isSafeInteger(state.port) ||
      state.host !== "127.0.0.1" ||
      typeof state.startedAt !== "string" ||
      typeof state.dataDir !== "string" ||
      typeof state.installRoot !== "string" ||
      typeof state.version !== "string" ||
      typeof state.commit !== "string" ||
      typeof state.channel !== "string"
    ) return undefined;
    return state as LauncherState;
  } catch {
    return undefined;
  }
}

async function launcherRequest<T>(
  state: LauncherState,
  pathname: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`http://${state.host}:${state.port}${pathname}`, {
    ...init,
    headers: {
      ...init?.headers,
      authorization: `Bearer ${state.controlToken}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Ponderosa returned HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}

async function readinessRequest(state: LauncherState): Promise<EngineReadinessSnapshot | undefined> {
  try {
    const response = await fetch(`http://${state.host}:${state.port}/api/ready`, {
      headers: { authorization: `Bearer ${state.controlToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status !== 200 && response.status !== 503) return undefined;
    return await response.json() as EngineReadinessSnapshot;
  } catch {
    return undefined;
  }
}

async function currentStatus(): Promise<{
  state: LauncherState;
  status: LauncherStatus;
  readiness?: EngineReadinessSnapshot;
} | undefined> {
  const state = await readState();
  if (!state) return undefined;
  try {
    const status = await launcherRequest<LauncherStatus>(state, "/api/launcher/status");
    const readiness = await readinessRequest(state);
    return { state, status, ...(readiness ? { readiness } : {}) };
  } catch {
    return undefined;
  }
}

async function waitUntilReachable(timeoutMs = 30_000): Promise<NonNullable<Awaited<ReturnType<typeof currentStatus>>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = await currentStatus();
    if (running) return running;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Ponderosa Engine did not become reachable in time.");
}

function launcher(command: "engine" | "stop"): ChildProcess {
  const child = spawn(nodeExecutable, [
    launcherEntry,
    command,
    "--install-root",
    installRoot,
    "--data-dir",
    launcherRoot,
    ...(command === "engine" ? ["--no-browser"] : []),
    ...(command === "engine" && requestedPort ? ["--port", requestedPort] : []),
  ], {
    cwd: installRoot,
    env: {
      ...process.env,
      PONDEROSA_ENGINE_PARENT_PID: String(process.pid),
    },
    windowsHide: true,
    stdio: command === "engine" ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  child.on("message", (message: unknown) => {
    if (message && typeof message === "object" && "type" in message && message.type === "ponderosa-engine-ready") readyEngines.add(child);
  });
  return child;
}

async function runLauncher(command: "stop"): Promise<void> {
  const owned = engineProcess;
  if (owned?.connected && owned.exitCode === null && owned.signalCode === null) {
    // One owner performs stop and receipt cleanup. Racing a second launcher
    // against that cleanup can refuse the retained directory lease.
    await new Promise<void>((resolve, reject) => {
      let requested = false;
      const timer = setTimeout(() => finish(new Error("Ponderosa Engine supervisor did not confirm shutdown.")), 60_000);
      const exited = (code: number | null) => finish(code === 0 && requested ? undefined : new Error(`Ponderosa Engine supervisor exited before confirming shutdown (code ${code ?? "unknown"}).`));
      const failed = (error: Error) => finish(error);
      function finish(error?: Error): void {
        clearTimeout(timer); owned!.off("exit", exited); owned!.off("error", failed); owned!.off("message", stopWhenReady);
        if (error) reject(error); else resolve();
      }
      function stopWhenReady(): void {
        if (requested || !readyEngines.has(owned!)) return;
        requested = true;
        owned!.send({ type: "ponderosa-engine-stop" }, error => { if (error) finish(error); });
      }
      owned.once("exit", exited); owned.once("error", failed);
      owned.on("message", stopWhenReady);
      stopWhenReady();
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = launcher(command);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_000);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Ponderosa launcher exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function openPonderosa(destination: "/" | "/branches" = "/"): Promise<void> {
  const running = await currentStatus();
  if (!running) throw new Error("Ponderosa is not running.");
  const url = `http://${running.state.host}:${running.state.port}/__ponderosa_bootstrap?next=${encodeURIComponent(destination)}`;
  await shell.openExternal(url);
}

async function startEngine(openBrowser: boolean): Promise<void> {
  engineState = "starting";
  engineDetail = "Starting the local Ponderosa service…";
  launchOutput = "";
  notifyChanged();

  const alreadyRunning = await currentStatus();
  if (!alreadyRunning) {
    const launched = launcher("engine");
    engineProcess = launched;
    launched.stdout?.on("data", (chunk: Buffer | string) => {
      launchOutput = `${launchOutput}${String(chunk)}`.slice(-4_000);
    });
    launched.stderr?.on("data", (chunk: Buffer | string) => {
      launchOutput = `${launchOutput}${String(chunk)}`.slice(-4_000);
    });
    launched.once("exit", () => {
      if (engineProcess === launched) engineProcess = undefined;
      void currentStatus().then((running) => {
        if (!running && engineState !== "starting" && engineState !== "cleanup_incomplete") {
          engineState = "stopped";
          engineDetail = "The local service is stopped. Restart it when you are ready.";
          notifyChanged();
        }
      });
    });
  }

  try {
    const observed = await waitUntilReachable();
    const classification = classifyEngineReadiness(observed.readiness);
    engineState = classification.state;
    engineDetail = classification.detail;
    notifyChanged();
    if (openBrowser) await openPonderosa();
  } catch (error) {
    engineState = "error";
    engineDetail = error instanceof Error ? error.message : "Ponderosa Engine could not start.";
    notifyChanged();
  }
}

async function logs(
  state: LauncherState,
  stream: "server" | "error",
): Promise<LogTail> {
  try {
    return await launcherRequest<LogTail>(
      state,
      `/api/launcher/logs?stream=${encodeURIComponent(stream)}`,
    );
  } catch {
    return emptyLog(stream);
  }
}

async function snapshot(): Promise<EngineSnapshot> {
  const running = await currentStatus();
  if (!running) {
    const identity = await bundleIdentity();
    return {
      state: engineState,
      detail: engineDetail,
      version: identity?.version,
      revision: identity?.commit,
      channel: identity?.channel,
      dataDir: path.join(launcherRoot, "data"),
      activeRunCount: 0,
      logs: {
        server: {
          ...emptyLog("server"),
          text: launchOutput,
          returnedBytes: Buffer.byteLength(launchOutput),
          totalBytes: Buffer.byteLength(launchOutput),
        },
        error: emptyLog("error"),
      },
    };
  }
  if (engineState !== "stopping" && engineState !== "cleanup_incomplete") {
    const classification = classifyEngineReadiness(running.readiness);
    engineState = classification.state;
    engineDetail = classification.detail;
  }
  const [server, error] = await Promise.all([
    logs(running.state, "server"),
    logs(running.state, "error"),
  ]);
  return {
    state: engineState,
    detail: engineDetail,
    pid: running.status.pid,
    version: running.status.version,
    revision: running.status.commit,
    channel: running.status.channel,
    startedAt: running.state.startedAt,
    dataDir: running.status.dataDir,
    acceptingDurableIntake: running.status.acceptingDurableIntake,
    leasingRuns: running.status.leasingRuns,
    activeRunCount: running.status.activeRunCount,
    logs: { server, error },
  };
}

function showWindow(): void {
  if (!window) createWindow();
  window!.show();
  window!.focus();
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 620,
    minHeight: 500,
    title: "Ponderosa Engine",
    backgroundColor: "#101815",
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.removeMenu();
  window.loadFile(path.join(here, "index.html"));
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => { window = undefined; });
  window.on("session-end", () => {
    // Windows owns termination here; retained ownership needs real boot proof on relaunch.
    allowQuit = true;
  });
  window.on("close", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    window?.hide();
  });
}

function createTray(): void {
  const iconPath = path.join(
    installRoot,
    "app",
    "web",
    "dist",
    "icons",
    "app-icon.png",
  );
  const image = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  tray = new Tray(image);
  tray.setToolTip("Ponderosa Engine");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show Ponderosa Engine", click: showWindow },
    { label: "Open Ponderosa", click: () => void openPonderosa() },
    { label: "Open Ponderosa Branches", click: () => void openPonderosa("/branches") },
    { type: "separator" },
    { label: "Quit Ponderosa Engine", click: () => void requestQuit() },
  ]));
  tray.on("click", showWindow);
}

async function requestQuit(): Promise<boolean> {
  if (quitInProgress) return false;
  quitInProgress = true;
  try {
    const running = await currentStatus();
    if (running?.status.activeRunCount) {
      const options: MessageBoxOptions = {
        type: "warning",
        buttons: ["Cancel", "Stop Agents and Quit"],
        defaultId: 0,
        cancelId: 0,
        title: "Quit Ponderosa Engine?",
        message: `${running.status.activeRunCount} Agent Run${running.status.activeRunCount === 1 ? "" : "s"} currently active.`,
        detail: "Quitting stops the local Ponderosa server and asks active provider processes to shut down safely. Your Projects and data are preserved.",
      };
      const choice = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      if (choice.response === 0) return false;
    }
    engineState = "stopping";
    engineDetail = "Stopping the local Ponderosa service…";
    notifyChanged();
    await runLauncher("stop");
    allowQuit = true;
    app.quit();
    return true;
  } catch (error) {
    engineState = "cleanup_incomplete";
    engineDetail = error instanceof Error ? error.message : "Ponderosa Engine could not stop safely.";
    notifyChanged();
    const options: MessageBoxOptions = {
      type: "error",
      title: "Ponderosa Engine is still running",
      message: engineDetail,
      detail: "The application stayed open because shutdown was not confirmed.",
    };
    if (window) await dialog.showMessageBox(window, options);
    else await dialog.showMessageBox(options);
    return false;
  } finally {
    quitInProgress = false;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("before-quit", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    void requestQuit();
  });
  app.on("window-all-closed", () => {
    // Closing the control window is not quitting the Engine.
  });
  app.on("activate", showWindow);
  process.once("SIGINT", () => void requestQuit());
  process.once("SIGTERM", () => void requestQuit());

  ipcMain.handle("engine:snapshot", snapshot);
  ipcMain.handle("engine:open", async () => openPonderosa());
  ipcMain.handle("engine:open-branches", async () => openPonderosa("/branches"));
  ipcMain.handle("engine:restart", async () => {
    engineState = "stopping";
    engineDetail = "Stopping the local Ponderosa service before restart…";
    notifyChanged();
    try {
      await runLauncher("stop");
      await startEngine(true);
    } catch (error) {
      engineState = "cleanup_incomplete";
      engineDetail = error instanceof Error ? error.message : "Ponderosa Engine could not stop safely for restart.";
      notifyChanged();
      throw error;
    }
  });
  ipcMain.handle("engine:quit", () => requestQuit());
  ipcMain.handle("engine:copy-logs", (_event, text: unknown) => {
    if (typeof text === "string") clipboard.writeText(text.slice(0, 128 * 1024));
  });

  void app.whenReady().then(async () => {
    app.setName("Ponderosa Engine");
    createWindow();
    createTray();
    await startEngine(!suppressInitialBrowser);
  });
}
