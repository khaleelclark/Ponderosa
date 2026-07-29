#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

function option(name, fallback) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

const installRoot = path.resolve(option("install-root", ""));
const dataDir = path.resolve(option("data-dir", ""));
const reportPath = path.resolve(option("report", path.join(dataDir, "launcher-lifecycle-report.json")));
if (!installRoot || !dataDir) throw new Error("Launcher qualification requires install-root and data-dir.");
const nodeName = process.platform === "win32" ? "node.exe" : "node";
const nodeExecutable = path.join(installRoot, "runtime", nodeName);
const launcher = path.join(installRoot, "app", "launcher", "dist", "cli.js");
const secret = `qualification-secret-${process.pid}-${Date.now()}`;
const environment = {
  ...process.env,
  PONDEROSA_QUALIFICATION_SECRET: secret,
};
const checks = [];
const disposableProject = mkdtempSync(path.join(os.tmpdir(), "ponderosa-project-content-"));
const projectSecret = `project-content-${process.pid}-${Date.now()}`;
writeFileSync(path.join(disposableProject, "secret.txt"), projectSecret);
writeFileSync(path.join(disposableProject, ".env"), `QUALIFICATION_SECRET=${secret}\n`);

function launcherCall(command, args = [], allowFailure = false) {
  const result = spawnSync(nodeExecutable, [
    launcher,
    command,
    "--install-root", installRoot,
    "--data-dir", dataDir,
    ...args,
  ], {
    encoding: "utf8",
    timeout: 90_000,
    windowsHide: true,
    env: environment,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`Launcher ${command} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const port = await availablePort();
let started = false;
let firstPid;
try {
  launcherCall("start", ["--port", String(port), "--no-browser"]);
  started = true;
  const statePath = path.join(dataDir, "launcher-state", "instance.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  firstPid = state.pid;
  assert(Number.isSafeInteger(firstPid) && firstPid > 0, "Launcher did not record the installed server pid.");
  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
  assert(health.ok, "Installed server health endpoint failed.");
  checks.push({ id: "launcher-health", status: "pass", detail: "installed launcher started the server and health responded" });

  const readiness = await fetch(`${baseUrl}/api/ready`, { signal: AbortSignal.timeout(10_000) });
  const readinessBody = await readiness.json();
  const artifactFilesystemReady = readinessBody?.checks?.artifactFilesystem?.ok === true;
  const runtimesReady = readinessBody?.checks?.runtimes?.ok === true;
  if (readiness.ok) {
    assert(artifactFilesystemReady && runtimesReady,
      "Ready response did not prove both host filesystem safety and provider availability.");
  } else {
    assert(readiness.status === 503, `Unexpected readiness status ${readiness.status}.`);
    assert(!artifactFilesystemReady || !runtimesReady,
      "Unavailable response did not identify either host-safety or provider failure.");
  }
  checks.push({
    id: "readiness-separation",
    status: "pass",
    detail: `hostFilesystem=${artifactFilesystemReady ? "ready" : "blocked"}; ` +
      `subscriptionRuntime=${runtimesReady ? "available" : "unavailable"}; HTTP ${readiness.status}`,
  });

  const bootstrap = await fetch(`${baseUrl}/api/launcher/bootstrap`, {
    method: "POST",
    headers: { authorization: `Bearer ${state.controlToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  assert(bootstrap.ok, "Launcher control proof could not create a browser bootstrap.");
  const bootstrapBody = await bootstrap.json();
  assert(typeof bootstrapBody.token === "string" && bootstrapBody.token.length >= 32, "Invalid browser bootstrap token.");
  const exchange = await fetch(`${baseUrl}/api/launcher/session-exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: bootstrapBody.token }),
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  assert(exchange.ok, "Browser bootstrap exchange failed.");
  const cookie = exchange.headers.get("set-cookie") ?? "";
  assert(/HttpOnly/iu.test(cookie) && /SameSite=Strict/iu.test(cookie), "Browser session cookie lacks HttpOnly SameSite=Strict.");
  const replay = await fetch(`${baseUrl}/api/launcher/session-exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: bootstrapBody.token }),
    signal: AbortSignal.timeout(5_000),
  });
  assert(replay.status === 401, "Browser bootstrap was reusable.");
  const protectedResponse = await fetch(`${baseUrl}/api/projects`, {
    headers: { cookie: cookie.split(";", 1)[0] },
    signal: AbortSignal.timeout(5_000),
  });
  assert(protectedResponse.ok, "HttpOnly browser session did not authorize a protected API request.");
  checks.push({
    id: "browser-bootstrap",
    status: "pass",
    detail: "one-use bootstrap exchanged into an HttpOnly SameSite=Strict session",
  });

  const dataSentinel = path.join(dataDir, "data", "qualification-preserve.txt");
  mkdirSync(path.dirname(dataSentinel), { recursive: true });
  writeFileSync(dataSentinel, "restart must preserve data\n");
  const doctor = launcherCall("doctor", ["--json"], true);
  const doctorReport = JSON.parse(doctor.stdout);
  const processCheck = doctorReport.checks.find((check) => check.id === "process");
  const filesystemCheck = doctorReport.checks.find((check) => check.id === "secure-filesystem");
  assert(processCheck?.status === "pass", `Doctor process containment failed: ${processCheck?.detail ?? "missing"}`);
  checks.push({ id: "process-containment", status: "pass", detail: processCheck.detail });

  launcherCall("diagnostics");
  const diagnosticsDirectory = path.join(dataDir, "diagnostics");
  const archiveName = readdirSync(diagnosticsDirectory).find((name) => name.endsWith(".tgz"));
  assert(archiveName, "Launcher did not create a diagnostic archive.");
  const diagnosticBytes = gunzipSync(readFileSync(path.join(diagnosticsDirectory, archiveName)));
  for (const forbidden of [state.controlToken, bootstrapBody.token, cookie.split("=", 2)[1]?.split(";", 1)[0], secret, projectSecret]) {
    if (forbidden) assert(!diagnosticBytes.includes(Buffer.from(forbidden)), "Diagnostic archive contains forbidden secret material.");
  }
  assert(!diagnosticBytes.includes(Buffer.from("QUALIFICATION_SECRET=")), "Diagnostic archive contains .env contents.");
  checks.push({
    id: "diagnostic-redaction",
    status: "pass",
    detail: "diagnostics excluded launcher, browser, environment, .env, and Project-content sentinels",
  });

  launcherCall("restart", ["--port", String(port), "--no-browser"]);
  assert(existsSync(dataSentinel), "Restart deleted Ponderosa data.");
  const restartedState = JSON.parse(readFileSync(statePath, "utf8"));
  assert(restartedState.pid !== firstPid && processAlive(restartedState.pid), "Restart did not establish a new live server.");
  const restartedHealth = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
  assert(restartedHealth.ok, "Restarted installed server health endpoint failed.");
  checks.push({ id: "restart-preserves-data", status: "pass", detail: "restart established a new server and preserved data" });

  launcherCall("stop");
  started = false;
  assert(!processAlive(restartedState.pid), "Launcher stop returned before the installed server exited.");
  assert(!existsSync(statePath), "Launcher stop left live instance state behind.");
  checks.push({ id: "shutdown-observed", status: "pass", detail: "launcher observed server cleanup before removing instance state" });

  let secureReadPassed = false;
  const serverRequire = createRequire(path.join(installRoot, "app", "server", "package.json"));
  const nativeHost = serverRequire("@ponderosa/native-host");
  if (nativeHost.secureFileAuthoritySupported()) {
    const authorityRoot = path.join(dataDir, "secure-authority");
    const outside = path.join(dataDir, "secure-authority-outside");
    mkdirSync(path.join(authorityRoot, "nested"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(authorityRoot, "nested", "safe.txt"), "safe");
    writeFileSync(path.join(outside, "secret.txt"), "secret");
    symlinkSync(path.join(outside, "secret.txt"), path.join(authorityRoot, "leaf-link"));
    symlinkSync(outside, path.join(authorityRoot, "directory-link"));
    assert(nativeHost.readSecureFile({
      root: authorityRoot,
      relativePath: "nested/safe.txt",
      maxBytes: 16,
    })?.toString() === "safe", "Retained-descriptor normal read failed.");
    assert(nativeHost.readSecureFile({
      root: authorityRoot,
      relativePath: "leaf-link",
      maxBytes: 16,
    }) === undefined, "Retained-descriptor read followed a symlink leaf.");
    assert(nativeHost.readSecureFile({
      root: authorityRoot,
      relativePath: "directory-link/secret.txt",
      maxBytes: 16,
    }) === undefined, "Retained-descriptor read followed a symlink directory.");
    secureReadPassed = true;
  }
  checks.push({
    id: "secure-file-authority",
    status: secureReadPassed ? "pass" : "fail",
    detail: secureReadPassed
      ? "retained-descriptor normal read passed and symlink leaf/directory attacks failed closed"
      : "platform retained-handle secure file authority is unavailable",
  });

  const releaseBlockers = [];
  if (filesystemCheck?.status !== "pass") releaseBlockers.push(filesystemCheck?.detail ?? "complete filesystem authority failed");
  if (!secureReadPassed) releaseBlockers.push("secure file adversarial qualification failed");
  if (process.platform === "win32") {
    if (/Server/iu.test(os.version())) releaseBlockers.push("GitHub runner is Windows Server; Windows 11 remains a manual gate");
  }
  const report = {
    schemaVersion: 1,
    qualifiedAt: new Date().toISOString(),
    qualification: "installed-launcher-lifecycle",
    platform: process.platform,
    arch: process.arch,
    osVersion: os.version(),
    checks,
    releaseQualified: releaseBlockers.length === 0,
    releaseBlockers,
  };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Launcher lifecycle qualification complete; report=${reportPath}\n`);
} finally {
  if (started) launcherCall("stop", [], true);
  if (firstPid && processAlive(firstPid)) {
    throw new Error("Qualification cleanup could not prove the original installed server exited.");
  }
  rmSync(disposableProject, { recursive: true, force: true });
}
