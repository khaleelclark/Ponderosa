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
import { MACOS_GUI_PATH } from "./macos-gui-entry.mjs";

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

const application = path.resolve(option("application", ""));
const installRoot = path.resolve(option("install-root", ""));
const dataDir = path.resolve(option("data-dir", ""));
const reportPath = path.resolve(option("report", path.join(dataDir, "macos-gui-launch.json")));
if (!application || !installRoot || !dataDir) {
  throw new Error("GUI launch qualification requires application, install-root, and data-dir.");
}

const appExecutable = path.join(application, "Contents", "MacOS", "Ponderosa");
const nodeExecutable = path.join(installRoot, "runtime", "node");
const launcher = path.join(installRoot, "app", "launcher", "dist", "cli.js");
const statePath = path.join(dataDir, "launcher-state", "instance.json");
const guiEnvironment = Object.fromEntries(Object.entries({
  HOME: process.env.HOME,
  USER: process.env.USER,
  LOGNAME: process.env.LOGNAME,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG,
  PATH: MACOS_GUI_PATH,
}).filter((entry) => typeof entry[1] === "string"));
const checks = [];
let started = false;

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

async function launchFromApplication(port) {
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
  assert(state.installRoot === installRoot, "GUI launch recorded an unexpected install root.");
  assert(!/ponderosa-mac-qualification|\/Users\/patmi/iu.test(state.installRoot),
    "GUI launch retained a build-host path.");
  const health = await fetchEventually(
    `http://127.0.0.1:${state.port}/api/health`,
    { signal: AbortSignal.timeout(5_000) },
  );
  assert(health.ok, "GUI-launched daemon did not remain healthy.");
  started = true;
  return state;
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
  assert(
    claudeModels.ok || claudeModels.status === 503,
    `Claude model endpoint returned unexpected HTTP ${claudeModels.status}.`,
  );
  const postDiscoveryHealth = await fetch(`${baseUrl}/api/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert(postDiscoveryHealth.ok, "Provider discovery/model probing terminated the GUI-launched daemon.");
  checks.push({
    id: "macos-gui-provider-survival",
    status: "pass",
    detail: claudeModels.ok
      ? "Codex capabilities and Desktop-managed Claude models resolved; daemon remained healthy"
      : "Codex capabilities resolved; unavailable Claude returned 503 without terminating the daemon",
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
} finally {
  if (started) launcherCall("stop", [], true);
}
