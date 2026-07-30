#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalPath } from "./canonical-path.mjs";
import { MACOS_GUI_PATH } from "./macos-gui-entry.mjs";
import { expectedClaudeGuiExecutable } from "./macos-provider-evidence.mjs";

function option(name, fallback) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    stdio: "pipe",
    ...options,
  });
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function portIsAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function readJsonEventually(pathname, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(pathname, "utf8"));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError ?? new Error(`Timed out reading ${pathname}`);
}

async function fetchEventually(url, init = {}, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, {
        ...init,
        headers: { connection: "close", ...(init.headers ?? {}) },
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError ?? new Error(`Timed out fetching ${url}`);
}

if (process.platform !== "darwin") {
  throw new Error("Normal GUI launch qualification requires macOS.");
}

const applicationOption = option("application", "");
const installRootOption = option("install-root", "");
const dataDirOption = option("data-dir", "");
if (!applicationOption || !installRootOption || !dataDirOption) {
  throw new Error("GUI launch qualification requires application, install-root, and data-dir.");
}
const application = canonicalPath(applicationOption);
const installRoot = canonicalPath(installRootOption);
const dataDir = canonicalPath(dataDirOption);
const reportOption = option(
  "report",
  path.join(dataDir, "macos-gui-launch.json"),
);
if (!reportOption) {
  throw new Error("GUI launch qualification requires a non-empty report path.");
}
const reportPath = canonicalPath(reportOption);

const appExecutable = path.join(application, "Contents", "MacOS", "Ponderosa");
const installedLauncherDist = path.join(installRoot, "app", "launcher", "dist");
const {
  launcherStateLocation,
  resolveLauncherPaths,
} = await import(pathToFileURL(path.join(installedLauncherDist, "paths.js")).href);
const { hostPlatformAdapter } = await import(
  pathToFileURL(path.join(installedLauncherDist, "platform.js")).href
);
const launcherPaths = resolveLauncherPaths({
  platform: hostPlatformAdapter(),
  installRoot,
  dataDir,
});
const expectedLauncherStateLocation = launcherStateLocation(launcherPaths);
const launcherRootDataDir = canonicalPath(launcherPaths.dataDir);
const applicationDataDir = canonicalPath(expectedLauncherStateLocation.dataDir);
assert(launcherRootDataDir === dataDir,
  "Installed launcher resolved an unexpected launcher data root.");
assert(canonicalPath(expectedLauncherStateLocation.installRoot) === installRoot,
  "Installed launcher resolved an unexpected install root.");
const nodeExecutable = canonicalPath(launcherPaths.nodeExecutable);
const launcher = canonicalPath(path.join(installedLauncherDist, "cli.js"));
const statePath = canonicalPath(launcherPaths.statePath);
const guiEnvironment = Object.fromEntries(Object.entries({
  HOME: process.env.HOME,
  USER: process.env.USER,
  LOGNAME: process.env.LOGNAME,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG,
  PATH: MACOS_GUI_PATH,
}).filter((entry) => typeof entry[1] === "string"));
assert(typeof guiEnvironment.HOME === "string", "Normal GUI qualification requires HOME.");
const checks = [];
let started = false;
let launchAttempted = false;
const observedPids = new Set();

function launcherCall(command, args = [], allowFailure = false) {
  try {
    return run(nodeExecutable, [
      launcher,
      command,
      "--install-root", installRoot,
      "--data-dir", dataDir,
      ...args,
    ], {
      env: guiEnvironment,
    });
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function launcherJsonCall(command, args = []) {
  try {
    return JSON.parse(launcherCall(command, [...args, "--json"]));
  } catch (error) {
    const stdout = typeof error?.stdout === "string"
      ? error.stdout
      : Buffer.isBuffer(error?.stdout)
        ? error.stdout.toString("utf8")
        : "";
    if (stdout.trim()) return JSON.parse(stdout);
    throw error;
  }
}

async function launchFromApplication(port) {
  launchAttempted = true;
  run("open", [
    "-n",
    "-W",
    application,
    "--args",
    "--data-dir", dataDir,
    "--port", String(port),
    "--no-browser",
  ], {
    env: guiEnvironment,
  });
  const state = await readJsonEventually(statePath);
  observedPids.add(state.pid);
  const stateInstallRoot = canonicalPath(state.installRoot);
  const stateDataDir = canonicalPath(state.dataDir);
  assert(stateInstallRoot === installRoot, "GUI launch recorded an unexpected install root.");
  assert(stateDataDir === applicationDataDir, "GUI launch recorded an unexpected data directory.");
  assert(!/ponderosa-mac-qualification|\/Users\/patmi/iu.test(stateInstallRoot),
    "GUI launch retained a build-host path.");
  const health = await fetchEventually(
    `http://127.0.0.1:${state.port}/api/health`,
    { signal: AbortSignal.timeout(5_000) },
  );
  assert(health.ok, "GUI-launched daemon did not remain healthy.");
  started = true;
  return state;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function cleanupGuiLaunch(port) {
  const deadline = Date.now() + 15_000;
  let lastStateError;
  let quietSince;
  while (Date.now() < deadline) {
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        if (Number.isSafeInteger(state.pid)) observedPids.add(state.pid);
      } catch (error) {
        lastStateError = error;
      }
    }
    // Attempt the authoritative launcher stop even before state is observed:
    // LaunchServices can return or fail while the packaged wrapper is still
    // completing its state publication.
    launcherCall("stop", [], true);
    const clean = (
      !existsSync(statePath) &&
      [...observedPids].every((pid) => !processIsAlive(pid)) &&
      await portIsAvailable(port)
    );
    if (clean) {
      quietSince ??= Date.now();
    } else {
      quietSince = undefined;
    }
    if (quietSince && Date.now() - quietSince >= 2_000) {
      started = false;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "GUI qualification cleanup did not observe state removal, process exit, and port release" +
    `${lastStateError ? `: ${lastStateError.message}` : ""}`,
  );
}

async function browserSession(state) {
  const baseUrl = `http://127.0.0.1:${state.port}`;
  const bootstrap = await fetch(`${baseUrl}/api/launcher/bootstrap`, {
    method: "POST",
    headers: { authorization: `Bearer ${state.controlToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  assert(bootstrap.ok, "GUI-launched daemon rejected launcher control proof.");
  const token = (await bootstrap.json()).token;
  const exchange = await fetch(`${baseUrl}/api/launcher/session-exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  assert(exchange.ok, "GUI-launched daemon rejected browser session exchange.");
  return exchange.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const wrapper = readFileSync(appExecutable, "utf8");
assert(wrapper.includes(`PATH="${MACOS_GUI_PATH}"`), "Packaged macOS entry point does not sanitize GUI PATH.");
assert(wrapper.includes('"$@"'), "Packaged macOS entry point does not forward qualification arguments.");
checks.push({
  id: "macos-gui-environment",
  status: "pass",
  detail: `packaged entry point enforces Finder-style PATH ${MACOS_GUI_PATH}`,
});

const port = await availablePort();
let primaryError;
try {
  const firstState = await launchFromApplication(port);
  const baseUrl = `http://127.0.0.1:${firstState.port}`;
  const cookie = await browserSession(firstState);
  assert(cookie, "GUI-launched daemon did not issue a browser session.");
  const headers = {
    cookie,
    "content-type": "application/json",
  };

  const enginesResponse = await fetch(`${baseUrl}/api/engines`, {
    headers: { cookie },
    signal: AbortSignal.timeout(15_000),
  });
  assert(enginesResponse.ok, "GUI-launched daemon did not return engine status.");
  const engines = await enginesResponse.json();
  const codex = engines.find((engine) => engine.id === "codex");
  assert(codex, "GUI-launched daemon omitted Codex.");
  assert(!/ENOENT|spawn codex|not found/iu.test(codex.authDetail ?? ""),
    `Codex did not use its discovered macOS executable: ${codex.authDetail ?? "missing detail"}`);
  checks.push({
    id: "macos-gui-codex-discovery",
    status: "pass",
    detail: "sanitized GUI launch resolved Codex without a bare-name spawn failure",
  });
  const doctor = launcherJsonCall("doctor");
  const codexDoctor = doctor.checks?.find((check) => check.id === "provider-codex");
  const claudeDoctor = doctor.checks?.find((check) => check.id === "provider-claude");
  assert(codexDoctor?.status === "pass", "Launcher doctor did not discover an executable Codex CLI.");
  assert(/(?:^| · )\/.+(?:codex)(?: · |$)/u.test(codexDoctor.detail ?? ""),
    "Launcher doctor did not bind Codex to an absolute macOS executable.");
  assert(claudeDoctor, "Launcher doctor omitted Claude provider discovery.");

  const projectRoot = path.join(dataDir, "gui-qualification-project");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(path.join(projectRoot, "README.md"), "# GUI qualification\n");
  const projectResponse = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      label: "GUI qualification",
      hostPath: projectRoot,
      defaultEngine: "codex",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  assert(projectResponse.ok, `GUI qualification Project creation failed: ${await projectResponse.text()}`);
  const project = await projectResponse.json();

  const capabilities = await fetch(
    `${baseUrl}/api/projects/${project.id}/engine-capabilities?engineId=codex&refresh=true`,
    {
      headers: { cookie },
      signal: AbortSignal.timeout(60_000),
    },
  );
  assert(capabilities.ok, `Codex capability discovery failed under GUI launch: ${await capabilities.text()}`);
  const claudeModels = await fetch(
    `${baseUrl}/api/projects/${project.id}/engine-models/claude?refresh=true`,
    {
      headers: { cookie },
      signal: AbortSignal.timeout(60_000),
    },
  );
  const claudeResponseBody = await claudeModels.text();
  const expectedClaude = expectedClaudeGuiExecutable(guiEnvironment.HOME, MACOS_GUI_PATH);
  if (expectedClaude) {
    assert(claudeDoctor.status === "pass",
      "Launcher doctor did not discover the expected Claude executable.");
    assert(claudeDoctor.detail?.includes(expectedClaude.executable),
      "Launcher doctor did not select the expected Claude executable.");
    if (expectedClaude.providerClass === "claude-desktop") {
      assert(claudeModels.ok,
        `Claude Desktop ${expectedClaude.version} model discovery failed: ${claudeResponseBody}`);
    } else {
      assert(
        claudeModels.ok || (claudeModels.status === 503 && Boolean(claudeResponseBody.trim())),
        `Configured or standard Claude returned unexplained HTTP ${claudeModels.status}.`,
      );
    }
  } else {
    assert(
      claudeModels.ok || (
        claudeModels.status === 503 &&
        Boolean(claudeResponseBody.trim()) &&
        ["pass", "warning"].includes(claudeDoctor.status)
      ),
      `Claude model endpoint returned unexplained HTTP ${claudeModels.status}.`,
    );
  }
  const postDiscoveryHealth = await fetch(`${baseUrl}/api/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert(postDiscoveryHealth.ok, "Provider discovery/model probing terminated the GUI-launched daemon.");
  checks.push({
    id: "macos-gui-provider-survival",
    status: "pass",
    detail: expectedClaude?.providerClass === "claude-desktop"
      ? `Codex capabilities and Claude Desktop ${expectedClaude.version} models resolved; daemon remained healthy`
      : claudeModels.ok
        ? "Codex capabilities and a non-Desktop Claude model provider resolved; daemon remained healthy"
        : "Codex capabilities resolved; Claude was proven absent or unusable and returned 503 without terminating the daemon",
  });

  launcherCall("stop");
  started = false;
  assert(!existsSync(statePath), "GUI launcher stop left instance state behind.");
  const secondState = await launchFromApplication(port);
  assert(secondState.pid !== firstState.pid, "GUI reopen reused the stopped daemon pid.");
  launcherCall("stop");
  started = false;
  assert(!existsSync(statePath), "Second GUI launcher stop left instance state behind.");
  checks.push({
    id: "macos-gui-close-reopen",
    status: "pass",
    detail: "normal packaged-app launch, stop, reopen, and observed stop all passed",
  });

  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify({
    schemaVersion: 1,
    qualification: "macos-normal-gui-launch",
    platform: process.platform,
    arch: process.arch,
    checks,
  }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Normal macOS GUI launch qualification passed; report=${reportPath}\n`);
} catch (error) {
  primaryError = error;
}
let cleanupError;
if (launchAttempted || started || existsSync(statePath)) {
  try {
    await cleanupGuiLaunch(port);
  } catch (error) {
    cleanupError = error;
  }
}
if (primaryError && cleanupError) {
  throw new AggregateError(
    [primaryError, cleanupError],
    "Normal macOS GUI launch qualification and cleanup failed",
  );
}
if (primaryError) throw primaryError;
if (cleanupError) throw cleanupError;
