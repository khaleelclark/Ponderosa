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
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
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

async function fetchEventually(url, init = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
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
  throw lastError;
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

function hostOsIdentity() {
  if (process.platform === "linux") {
    try {
      const fields = Object.fromEntries(readFileSync("/etc/os-release", "utf8")
        .split(/\r?\n/u)
        .flatMap((line) => {
          const separator = line.indexOf("=");
          if (separator < 1) return [];
          const key = line.slice(0, separator);
          const value = line.slice(separator + 1).replace(/^"(.*)"$/u, "$1");
          return [[key, value]];
        }));
      return { platform: process.platform, id: fields.ID, version: fields.VERSION_ID, kernel: os.release() };
    } catch {
      return { platform: process.platform, version: os.version(), kernel: os.release() };
    }
  }
  return { platform: process.platform, version: os.version(), kernel: os.release() };
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
  const restartedHealth = await fetchEventually(`${baseUrl}/api/health`, {
    signal: AbortSignal.timeout(5_000),
  });
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
    nativeHost.writeSecureFileAtomic({
      root: authorityRoot,
      relativeDirectory: "published",
      leaf: "safe.bin",
      temporaryLeaf: `.safe.${randomUUID()}.tmp`,
      body: Buffer.from("published-safe"),
    });
    assert(nativeHost.readSecureFile({
      root: authorityRoot,
      relativePath: "published/safe.bin",
      maxBytes: 32,
    })?.toString() === "published-safe",
    "Retained authority did not preserve atomically published bytes.");
    assert(nativeHost.listSecureDirectory({
      root: authorityRoot,
      relativePath: "published",
    })?.some((entry) => entry.name === "safe.bin" && entry.kind === "file"),
    "Retained authority did not enumerate the published regular file.");
    assert(nativeHost.removeSecureFile({
      root: authorityRoot,
      relativeDirectory: "published",
      leaf: "safe.bin",
    }), "Retained authority did not remove the verified regular file.");

    const projectFileAccess = await import(pathToFileURL(
      path.join(installRoot, "app", "server", "dist", "project-file-access.js"),
    ).href);
    assert(projectFileAccess.readWorkspaceArtifactFile({
      rootPath: authorityRoot,
      requestedPath: "nested/safe.txt",
      purpose: "generated_capture",
      maxBytes: 16,
    })?.body.toString() === "safe", "Installed production Project reader failed a safe retained-root read.");
    assert(projectFileAccess.readWorkspaceArtifactFile({
      rootPath: authorityRoot,
      requestedPath: "directory-link/secret.txt",
      purpose: "generated_capture",
      maxBytes: 16,
    }) === undefined, "Installed production Project reader followed a symlink directory.");

    const agentsEntry = serverRequire.resolve("@ponderosa/agents");
    const agents = await import(pathToFileURL(agentsEntry).href);
    const managedRoot = path.join(dataDir, "secure-managed-authority");
    mkdirSync(managedRoot);
    const managed = agents.publishManagedArtifactContent(
      managedRoot,
      "qualification",
      "artifact",
      Buffer.from("managed-safe"),
    );
    assert(agents.readManagedArtifactContent(
      managedRoot,
      "qualification",
      "artifact",
      managed.size,
      managed.sha256,
    )?.body.toString() === "managed-safe",
    "Installed production managed-artifact publisher/reader did not preserve exact bytes.");
    agents.publishManagedArtifactContent(
      managedRoot,
      "qualification",
      "orphan",
      Buffer.from("repair-safe"),
    );
    assert(agents.repairManagedArtifactContent(
      managedRoot,
      "qualification",
      new Set(["artifact"]),
      Date.now() + 1_000,
    ).includes("orphan"),
    "Installed production managed-artifact repair did not remove an unreferenced verified leaf.");
    assert(agents.readManagedArtifactContent(
      managedRoot,
      "qualification",
      "artifact",
      managed.size,
      managed.sha256,
    )?.body.toString() === "managed-safe",
    "Managed-artifact repair changed a referenced immutable leaf.");
    secureReadPassed = true;
  }
  checks.push({
    id: "secure-file-authority",
    status: secureReadPassed ? "pass" : "fail",
    detail: secureReadPassed
      ? "native helper plus installed Project reader and managed publish/read/repair paths passed retained-authority checks"
      : "platform retained-handle secure file authority is unavailable",
  });

  const releaseBlockers = [];
  if (filesystemCheck?.status !== "pass") releaseBlockers.push(filesystemCheck?.detail ?? "complete filesystem authority failed");
  if (!secureReadPassed) releaseBlockers.push("secure file adversarial qualification failed");
  const hostOs = hostOsIdentity();
  if (process.platform === "linux" && (hostOs.id !== "ubuntu" || hostOs.version !== "24.04")) {
    releaseBlockers.push(`Ubuntu 24.04 is required; host is ${hostOs.id ?? "unknown"} ${hostOs.version ?? hostOs.kernel}`);
  } else if (process.platform === "darwin" && Number.parseInt(os.release(), 10) < 23) {
    releaseBlockers.push(`macOS 14 or newer is required; Darwin kernel is ${os.release()}`);
  } else if (process.platform === "win32") {
    if (/Server/iu.test(os.version())) {
      releaseBlockers.push("host is Windows Server; Windows 11 remains a manual gate");
    }
    const windowsBuild = Number.parseInt(os.release().split(".").at(-1) ?? "", 10);
    if (!Number.isFinite(windowsBuild) || windowsBuild < 22_000) {
      releaseBlockers.push(`Windows 11 build 22000 or newer is required; host kernel is ${os.release()}`);
    }
  }
  const report = {
    schemaVersion: 1,
    qualifiedAt: new Date().toISOString(),
    qualification: "installed-launcher-lifecycle",
    platform: process.platform,
    arch: process.arch,
    hostOs,
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
