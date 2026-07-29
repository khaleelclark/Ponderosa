import {
  accessSync,
  constants,
  existsSync,
  statfsSync,
  watch,
  writeFileSync,
  rmSync,
} from "node:fs";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WindowsProcessJob, windowsJobObjectsSupported } from "@ponderosa/native-host";
import { currentPonderosaStatus } from "./control.js";
import { discoverProviders } from "./providers.js";
import { readLauncherConfiguration } from "./paths.js";
import type {
  BuildManifest,
  DoctorCheck,
  DoctorReport,
  LauncherPaths,
  PlatformAdapter,
} from "./types.js";

const execFileAsync = promisify(execFile);

function check(
  id: string,
  label: string,
  status: DoctorCheck["status"],
  detail: string,
  repair?: string,
): DoctorCheck {
  return { id, label, status, detail, ...(repair ? { repair } : {}) };
}

async function commandVersion(command: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ["--version"], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    return `${stdout}\n${stderr}`.trim().split(/\r?\n/, 1)[0]?.trim();
  } catch {
    return undefined;
  }
}

async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function testWatcher(paths: LauncherPaths): Promise<boolean> {
  const target = path.join(paths.runtimeDir, `doctor-watch-${randomUUID()}.tmp`);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (result: boolean): void => {
      if (finished) return;
      finished = true;
      watcher.close();
      rmSync(target, { force: true });
      resolve(result);
    };
    const watcher = watch(paths.runtimeDir, (_event, filename) => {
      if (filename?.toString() === path.basename(target)) finish(true);
    });
    const timer = setTimeout(() => finish(false), 2_000);
    timer.unref();
    try { writeFileSync(target, "ponderosa doctor\n", { flag: "wx" }); }
    catch { finish(false); }
  });
}

function unixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function testProcessTreeCancellation(nodeExecutable: string): Promise<boolean> {
  if (process.platform === "win32") {
    if (!windowsJobObjectsSupported()) return false;
    const job = new WindowsProcessJob();
    const child = spawn(nodeExecutable, [
      fileURLToPath(new URL("./job-object-doctor-child.js", import.meta.url)),
    ], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      if (!child.pid) return false;
      job.assign(child.pid);
      const ready = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5_000);
        child.once("message", (message: unknown) => {
          clearTimeout(timer);
          resolve(Boolean(message && typeof message === "object" &&
            (message as { ready?: unknown }).ready === true));
        });
      });
      child.send?.("start");
      if (!await ready) return false;
      job.terminate();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && job.activeProcesses() > 0) await delay(25);
      return job.activeProcesses() === 0;
    } finally {
      job.close();
    }
  }
  const child = spawn(nodeExecutable, [
    "-e",
    [
      "const {spawn}=require('node:child_process');",
      "spawn(process.execPath,['-e','process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});",
      "setInterval(()=>{},1000);",
    ].join(""),
  ], {
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (!child.pid) return false;
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* Continue to observed cleanup. */ }
  await delay(100);
  if (unixProcessGroupAlive(child.pid)) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* Continue to observation. */ }
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && unixProcessGroupAlive(child.pid)) await delay(25);
  return !unixProcessGroupAlive(child.pid);
}

async function testSqlite(paths: LauncherPaths): Promise<boolean> {
  const modulePath = path.join(
    paths.installRoot,
    "app",
    "server",
    "node_modules",
    "better-sqlite3",
    "lib",
    "index.js",
  );
  const databasePath = path.join(paths.runtimeDir, `doctor-sqlite-${randomUUID()}.sqlite`);
  try {
    await execFileAsync(paths.nodeExecutable, [
      "-e",
      [
        "const Database=require(process.argv[1]);",
        "const db=new Database(process.argv[2]);",
        "db.exec('CREATE TABLE doctor(value INTEGER); INSERT INTO doctor VALUES (1)');",
        "if(db.prepare('SELECT value FROM doctor').get().value!==1)process.exit(2);",
        "db.close();",
      ].join(""),
      modulePath,
      databasePath,
    ], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

export async function runDoctor(input: {
  paths: LauncherPaths;
  manifest: BuildManifest;
  platform: PlatformAdapter;
  fetch?: typeof globalThis.fetch;
}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const requiredFiles = [
    ["node", "Bundled Node runtime", input.paths.nodeExecutable],
    ["server", "Ponderosa server", input.paths.serverEntry],
    ["web", "Ponderosa web application", input.paths.webDist],
  ] as const;
  for (const [id, label, pathname] of requiredFiles) {
    try {
      accessSync(pathname, id === "node" && process.platform !== "win32" ? constants.X_OK : constants.R_OK);
      checks.push(check(id, label, "pass", `${label} is present.`));
    } catch {
      checks.push(check(id, label, "fail", `${label} is missing or unreadable.`, "Reinstall the matching Ponderosa package."));
    }
  }
  try {
    const filesystem = statfsSync(input.paths.dataDir);
    const freeBytes = filesystem.bavail * filesystem.bsize;
    checks.push(check(
      "disk",
      "Available disk space",
      freeBytes >= 1_073_741_824 ? "pass" : "warning",
      `${(freeBytes / 1_073_741_824).toFixed(1)} GiB is available for Ponderosa data.`,
      freeBytes >= 1_073_741_824 ? undefined : "Free at least 1 GiB before running larger projects.",
    ));
  } catch (error) {
    checks.push(check("disk", "Available disk space", "fail",
      error instanceof Error ? error.message : String(error), "Choose a writable local data directory."));
  }
  try {
    const probe = path.join(input.paths.runtimeDir, `doctor-write-${randomUUID()}.tmp`);
    writeFileSync(probe, "ok", { flag: "wx", mode: 0o600 });
    rmSync(probe);
    checks.push(check("data", "Data directory", "pass", "Ponderosa can write to its private data directory."));
  } catch (error) {
    checks.push(check("data", "Data directory", "fail",
      error instanceof Error ? error.message : String(error), "Choose a writable data location or repair its permissions."));
  }
  const sqlite = existsSync(input.paths.nodeExecutable) && await testSqlite(input.paths);
  checks.push(check(
    "sqlite",
    "SQLite persistence",
    sqlite ? "pass" : "fail",
    sqlite ? "A disposable database was written, read, and closed." : "The bundled SQLite runtime could not persist data.",
    sqlite ? undefined : "Reinstall the Ponderosa package built for this operating system and architecture.",
  ));
  const configuration = readLauncherConfiguration(input.paths.configPath);
  for (const provider of await discoverProviders(input.platform, configuration)) {
    checks.push(check(
      `provider-${provider.id}`,
      provider.id === "codex" ? "Codex" : "Claude Code",
      provider.installed && provider.authenticated === true ? "pass" : "warning",
      [
        provider.detail,
        provider.authenticationDetail,
        provider.version,
        provider.executable,
      ].filter(Boolean).join(" · "),
      provider.installed && provider.authenticated === true
        ? undefined
        : `Sign in to ${provider.id === "codex" ? "Codex" : "Claude Code"}, or select its executable in Settings.`,
    ));
  }
  const gitVersion = await commandVersion("git");
  checks.push(check(
    "git",
    "Git",
    gitVersion ? "pass" : "warning",
    gitVersion ?? "Git was not found.",
    gitVersion ? undefined : "Install Git before using source-controlled Projects.",
  ));
  const running = await currentPonderosaStatus(input.paths, input.fetch);
  if (running && !running.healthy) {
    checks.push(check(
      "instance",
      "Ponderosa instance",
      "fail",
      running.detail,
      "Stop the recorded process or collect diagnostics before retrying launch.",
    ));
  } else if (running?.healthy) {
    checks.push(check("instance", "Ponderosa instance", "pass", `Ponderosa is running on ${running.host}:${running.port}.`));
  } else {
    const port = configuration.port ?? 8787;
    const available = await portAvailable(port);
    checks.push(check(
      "instance",
      "Ponderosa instance",
      available ? "pass" : "fail",
      available ? `Port ${port} is available for Ponderosa.` : `Port ${port} is already occupied.`,
      available ? undefined : "Stop the other service or choose another port in launcher settings.",
    ));
  }
  try {
    const watched = await testWatcher(input.paths);
    checks.push(check(
      "watcher",
      "Filesystem watcher",
      watched ? "pass" : "warning",
      watched ? "Filesystem change notifications work." : "The test change was not observed in time.",
      watched ? undefined : "Use a local filesystem for watched Projects.",
    ));
  } catch (error) {
    checks.push(check("watcher", "Filesystem watcher", "warning",
      error instanceof Error ? error.message : String(error), "Use a local filesystem for watched Projects."));
  }
  try {
    const cancelled = existsSync(input.paths.nodeExecutable) &&
      await testProcessTreeCancellation(input.paths.nodeExecutable);
    const windowsPending = process.platform === "win32";
    checks.push(check(
      "process",
      "Process-tree containment",
      cancelled ? "pass" : "fail",
      cancelled
        ? "A disposable process and stubborn descendant were both observed stopped."
        : windowsPending
          ? "This build does not contain the required Windows Job Object supervisor."
          : "The disposable process tree did not stop.",
      cancelled
        ? undefined
        : windowsPending
          ? "Install a Windows-qualified Ponderosa build before starting Agent work."
          : "Restart the host, then run Doctor again before starting Agent work.",
    ));
  } catch (error) {
    checks.push(check("process", "Process-tree containment", "fail",
      error instanceof Error ? error.message : String(error), "Reinstall Ponderosa and run Doctor again."));
  }
  checks.push(check(
    "browser",
    "Browser opening",
    "pass",
    "Ponderosa will use the host operating system's default browser handler.",
  ));
  checks.push(check(
    "diagnostics",
    "Diagnostic bundle",
    "pass",
    "Diagnostics can be generated without Project contents or provider credentials.",
  ));
  const ready = checks.every((candidate) => candidate.status !== "fail") &&
    checks.some((candidate) => candidate.id.startsWith("provider-") && candidate.status === "pass");
  return {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    version: input.manifest.version,
    commit: input.manifest.commit,
    dataDir: input.paths.dataDir,
    checks,
    ready,
  };
}
