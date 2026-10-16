#!/usr/bin/env node

import { parseArgs } from "node:util";

import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
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
import {
  findChromiumExecutable,
  qualifyPersistentPwaUpgrade,
  seedLegacyPwaProfile,
} from "./persistent-pwa-upgrade.mjs";
import { qualifyProviderReachability } from "./provider-reachability.mjs";
import { qualifyLauncherSafety } from "./launcher-safety.mjs";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    "install-root": { type: "string" },
    "report": { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});
for (const [name, value] of Object.entries(values)) {
  if (typeof value === "string" && !value.trim()) throw new Error(`--${name} requires a nonempty value`);
}

function option(name, fallback) {
  const value = values[name] ?? fallback;
  if (typeof value === "string" && !value.trim()) throw new Error(`--${name} requires a nonempty value`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertRejects(operation, message) {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(message);
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
const buildManifest = JSON.parse(readFileSync(
  path.join(installRoot, "build-manifest.json"),
  "utf8",
));
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
  if (result.error) {
    throw new Error(`Launcher ${command} could not complete: ${result.error.message}`);
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error(`Launcher ${command} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function parseLauncherJson(command, result) {
  const output = result.stdout?.trim();
  const failure = [
    `exit=${result.status ?? "unknown"}`,
    result.signal ? `signal=${result.signal}` : undefined,
    result.stderr?.trim() ? `stderr=${result.stderr.trim()}` : undefined,
  ].filter(Boolean).join("; ");
  assert(output, `Launcher ${command} produced no JSON report (${failure}).`);
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Launcher ${command} produced invalid JSON (${failure}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
// Seed browser state outside the empty launcher root used for first admission.
const persistentPwaProfile = `${dataDir}-persistent-pwa-profile`;
const browserExecutable = findChromiumExecutable();
const requiresInstalledPwaProof = process.platform === "linux" &&
  buildManifest.channel === "production";
if (requiresInstalledPwaProof) {
  assert(browserExecutable, "production Linux qualification requires Chromium for installed PWA proof");
}
if (browserExecutable && (requiresInstalledPwaProof || process.platform === "darwin")) {
  await seedLegacyPwaProfile(port, persistentPwaProfile, browserExecutable);
}
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
  if (browserExecutable && (requiresInstalledPwaProof || process.platform === "darwin")) {
    const pwaBootstrap = await fetch(`${baseUrl}/api/launcher/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.controlToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    assert(pwaBootstrap.ok, "PWA qualification could not create a browser bootstrap");
    const pwaBootstrapBody = await pwaBootstrap.json();
    const pwa = await qualifyPersistentPwaUpgrade({
      port,
      profileDir: persistentPwaProfile,
      webDist: path.join(installRoot, "app", "web", "dist"),
      bootstrapUrl: `${baseUrl}/__ponderosa_bootstrap#${encodeURIComponent(pwaBootstrapBody.token)}`,
      browserExecutable,
    });
    checks.push({
      id: "installed-pwa-controllerchange",
      status: "pass",
      detail: `persistent legacy profile activated and retained the installed build across restart (${pwa.publicAssetCount} assets)`,
    });
  }
  const providerProof = await qualifyProviderReachability({
    baseUrl,
    cookie: cookie.split(";", 1)[0],
    expectedRevision: buildManifest.commit,
  });
  // A degraded provider may recover during the explicit recheck. Readiness
  // measured before the recheck must not veto that new, installed-build proof.
  const readinessAfterProbe = await fetch(`${baseUrl}/api/ready`, {
    signal: AbortSignal.timeout(10_000),
  });
  const readinessAfterProbeBody = await readinessAfterProbe.json();
  const providerProbePassed = providerProof.passed && readinessAfterProbe.ok &&
    readinessAfterProbeBody?.checks?.runtimes?.ok === true;
  checks.push({
    id: "exact-platform-provider-readiness",
    status: providerProbePassed ? "pass" : "fail",
    evidence: providerProof.evidence,
    ...(providerProof.discoveryFailureCategory
      ? { discoveryFailureCategory: providerProof.discoveryFailureCategory } : {}),
    detail: providerProbePassed
      ? "installed application observed a reachable subscription runtime within five minutes"
      : "installed application has no recent, reachable subscription runtime",
  });

  const dataSentinel = path.join(dataDir, "data", "qualification-preserve.txt");
  mkdirSync(path.dirname(dataSentinel), { recursive: true });
  writeFileSync(dataSentinel, "restart must preserve data\n");
  const safety = await qualifyLauncherSafety(installRoot);
  const processCheck = safety.find((check) => check.id === "process");
  const filesystemCheck = safety.find((check) => check.id === "secure-filesystem");
  assert(processCheck?.status === "pass", `Process containment failed: ${processCheck?.detail ?? "missing"}`);
  checks.push({ id: "process-containment", status: "pass", detail: processCheck.detail });

  const diagnosticArchive = path.join(path.dirname(dataDir), `ponderosa-diagnostics-${randomUUID()}.tgz`);
  launcherCall("diagnostics", ["--output", diagnosticArchive]);
  assert(existsSync(diagnosticArchive), "Launcher did not create the external diagnostic archive.");
  const diagnosticBytes = gunzipSync(readFileSync(diagnosticArchive));
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

  const offlineCli = path.join(installRoot, "app", "server", "tools", "data-directory.mjs");
  const offlineBackup = path.join(dataDir, "offline-backup");
  const offlineRestored = path.join(dataDir, "offline-restored");
  for (const arguments_ of [
    ["backup", "--data-dir", path.join(dataDir, "data"), "--output", offlineBackup, "--external-projects", "exclude"],
    ["restore", "--backup", offlineBackup, "--data-dir", offlineRestored],
  ]) {
    const result = spawnSync(path.join(installRoot, "runtime", process.platform === "win32" ? "node.exe" : "node"),
      [offlineCli, ...arguments_], { encoding: "utf8", timeout: 90_000, env: environment });
    assert(result.status === 0, `Installed offline ${arguments_[0]} failed: ${result.stderr || result.stdout}`);
  }
  assert(readFileSync(path.join(offlineRestored, "qualification-preserve.txt"), "utf8") === "restart must preserve data\n",
    "Installed offline restore did not preserve canonical data");
  checks.push({ id: "installed-offline-restore", status: "pass", detail: "installed CLI restored a stopped disposable data directory" });

  const serverRequire = createRequire(path.join(installRoot, "app", "server", "package.json"));
  const { AssetStore } = await import(pathToFileURL(path.join(installRoot, "app", "server", "dist", "assets.js")).href);
  const sharp = serverRequire("sharp");
  const attachmentData = path.join(dataDir, "qualification-assets");
  const attachments = new AssetStore(attachmentData);
  try {
    const projectId = randomUUID();
    const agentId = randomUUID();
    const staged = await attachments.stage({ projectId, agentId, body: Buffer.from("portable attachment"), name: "note.txt" });
    assert((await attachments.content(projectId, agentId, staged.id, false))?.body.toString() === "portable attachment",
      "Installed attachment download did not retain the uploaded bytes");
    await attachments.associate(projectId, agentId, [staged.id]);
    assert((await attachments.read(projectId, agentId, staged.id))?.state === "associated",
      "Installed attachment send association was not durable");
    const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();
    const preview = await attachments.stage({ projectId, agentId, body: image, name: "photo.png" });
    assert((await attachments.content(projectId, agentId, preview.id, true))?.body.length > 0,
      "Installed attachment preview was unavailable");
    assert(await attachments.remove(projectId, agentId, preview.id),
      "Installed staged attachment could not be deleted");
    assert(!(await attachments.read(projectId, agentId, preview.id)),
      "Installed deleted attachment remained readable");
  } finally { attachments.close(); }
  checks.push({ id: "installed-attachment-lifecycle", status: "pass", detail: "installed upload, association, preview, download and deletion passed" });

  let secureReadPassed = false;
  const adversarialChecks = [];
  const recordAdversarialCheck = async (id, detail, operation) => {
    await operation();
    adversarialChecks.push({ id, status: "pass", detail });
  };
  const nativeHost = serverRequire("@ponderosa/native-host");
  if (nativeHost.secureFileAuthoritySupported()) {
    const authorityRoot = path.join(dataDir, "secure-authority");
    const outside = path.join(dataDir, "secure-authority-outside");
    mkdirSync(path.join(authorityRoot, "nested"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(authorityRoot, "nested", "safe.txt"), "safe");
    writeFileSync(path.join(outside, "secret.txt"), "secret");
    writeFileSync(path.join(outside, "public.txt"), "public");
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

    const projectFiles = await import(pathToFileURL(
      path.join(installRoot, "app", "server", "dist", "project-files.js"),
    ).href);
    const scoped = await projectFiles.readScopedPath(
      authorityRoot,
      "nested/safe.txt",
    );
    assert(scoped.kind === "file" && scoped.content === "safe",
      "Installed /api/files reader failed a safe retained-root read.");
    await assertRejects(
      () => projectFiles.readScopedPath(
        authorityRoot,
        "directory-link/secret.txt",
      ),
      "Installed /api/files reader followed a symlink directory.",
    );

    const projectRoutes = await import(pathToFileURL(
      path.join(installRoot, "app", "server", "dist", "routes", "project-files.js"),
    ).href);
    const projectStore = {
      getProject: (id) => id === "qualification"
        ? { id, hostPath: authorityRoot }
        : undefined,
      getConversation: (id) => id === "qualification-chat"
        ? { id, projectId: "qualification", workingDirectory: authorityRoot }
        : undefined,
    };
    const routeAuthority = new projectRoutes.ProjectFileAuthority(projectStore);
    const browserFile = await routeAuthority.fileForBrowser(
      "qualification",
      "nested/safe.txt",
      { maxBytes: 16 },
      undefined,
      "qualification-chat",
    );
    assert(browserFile, "Installed ProjectFileAuthority rejected a safe read.");
    const browserChunks = [];
    for await (const chunk of browserFile.body) browserChunks.push(Buffer.from(chunk));
    assert(Buffer.concat(browserChunks).toString() === "safe",
      "Installed ProjectFileAuthority returned changed bytes.");
    assert(await routeAuthority.fileForBrowser(
      "qualification",
      "directory-link/secret.txt",
      { maxBytes: 16 },
      undefined,
      "qualification-chat",
    ) === undefined,
    "Installed ProjectFileAuthority followed a symlink directory.");

    const gitStatus = await import(pathToFileURL(
      path.join(installRoot, "app", "server", "dist", "git-status.js"),
    ).href);
    const workspaceReview = await gitStatus.workspaceFile(
      "qualification",
      "qualification-agent",
      "qualification-working-copy",
      authorityRoot,
      "nested/safe.txt",
    );
    assert(workspaceReview.content === "safe",
      "Installed workspace review failed a safe retained-root read.");
    const linkedReview = await gitStatus.workspaceFile(
      "qualification",
      "qualification-agent",
      "qualification-working-copy",
      authorityRoot,
      "directory-link/public.txt",
    );
    assert(linkedReview.exists === false && linkedReview.content === undefined,
      "Installed workspace review followed a symlink directory.");

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
    const orphan = agents.publishManagedArtifactContent(
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
    ).includes(agents.managedArtifactStorageFilename("orphan")),
    "Installed production managed-artifact repair did not remove an unreferenced verified leaf.");
    assert(!existsSync(orphan.path) && agents.readManagedArtifactContent(
      managedRoot,
      "qualification",
      "orphan",
      orphan.size,
      orphan.sha256,
    ) === undefined,
    "Managed-artifact repair reported removal but retained the unreferenced verified leaf.");
    assert(agents.readManagedArtifactContent(
      managedRoot,
      "qualification",
      "artifact",
      managed.size,
      managed.sha256,
    )?.body.toString() === "managed-safe",
    "Managed-artifact repair changed a referenced immutable leaf.");

    if (nativeHost.dataDirectoryAuthoritySupported()) {
      await recordAdversarialCheck(
        "root-replacement",
        "pathname replacement was blocked by the live lease or retained authority stayed bound to the original directory",
        async () => {
          const parent = path.join(dataDir, "adversarial-root-replacement");
          const root = path.join(parent, "root");
          const displaced = path.join(parent, "displaced");
          mkdirSync(root, { recursive: true });
          writeFileSync(path.join(root, "identity.txt"), "original");
          const authority = new nativeHost.DataDirectoryAuthority(root);
          let replacementBlocked = false;
          try {
            try { renameSync(root, displaced); }
            catch (error) {
              if (process.platform !== "win32" || !["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
              replacementBlocked = true;
            }
            if (!replacementBlocked) {
              mkdirSync(root);
              writeFileSync(path.join(root, "identity.txt"), "replacement");
            }
            assert(nativeHost.readSecureFile({
              root: authority.rootPath,
              relativePath: "identity.txt",
              maxBytes: 32,
            })?.toString() === "original", "Root replacement redirected retained authority.");
          } finally {
            authority.close();
          }
          // Prove a blocked rename came from the lease, not an unrelated
          // filesystem permission failure, and that close released the pin.
          if (replacementBlocked) renameSync(root, displaced);
        },
      );
      await recordAdversarialCheck(
        "ancestor-replacement",
        "ancestor replacement was blocked by the live lease or retained authority stayed bound to the original directory",
        async () => {
          const parent = path.join(dataDir, "adversarial-ancestor-replacement");
          const ancestor = path.join(parent, "ancestor");
          const root = path.join(ancestor, "root");
          mkdirSync(root, { recursive: true });
          writeFileSync(path.join(root, "identity.txt"), "original-ancestor");
          const authority = new nativeHost.DataDirectoryAuthority(root);
          let replacementBlocked = false;
          try {
            try { renameSync(ancestor, path.join(parent, "displaced")); }
            catch (error) {
              if (process.platform !== "win32" || !["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
              replacementBlocked = true;
            }
            if (!replacementBlocked) {
              mkdirSync(root, { recursive: true });
              writeFileSync(path.join(root, "identity.txt"), "replacement-ancestor");
            }
            assert(nativeHost.readSecureFile({
              root: authority.rootPath,
              relativePath: "identity.txt",
              maxBytes: 32,
            })?.toString() === "original-ancestor", "Ancestor replacement redirected retained authority.");
          } finally {
            authority.close();
          }
          if (replacementBlocked) renameSync(ancestor, path.join(parent, "displaced"));
        },
      );
    }
    await recordAdversarialCheck(
      "cross-device-or-volume",
      "secure reads rejected a link into an external device or volume boundary",
      async () => {
        const root = path.join(dataDir, "adversarial-cross-device");
        const externalParent = process.platform === "linux" && existsSync("/dev/shm")
          ? "/dev/shm"
          : path.join(dataDir, "adversarial-external-volume");
        mkdirSync(root, { recursive: true });
        mkdirSync(externalParent, { recursive: true });
        const external = path.join(externalParent, `ponderosa-${randomUUID()}.txt`);
        try {
          writeFileSync(external, "external-device");
          symlinkSync(external, path.join(root, "external-link"));
          assert(nativeHost.readSecureFile({
            root,
            relativePath: "external-link",
            maxBytes: 32,
          }) === undefined, "Secure read crossed an external device or volume link.");
        } finally {
          rmSync(external, { force: true });
        }
      },
    );
    await recordAdversarialCheck(
      "leaf-link-or-reparse",
      "secure reads rejected symbolic-link and multi-link leaf identities",
      async () => {
        const root = path.join(dataDir, "adversarial-leaf-links");
        const outside = path.join(dataDir, "adversarial-leaf-source.txt");
        mkdirSync(root, { recursive: true });
        writeFileSync(outside, "outside-leaf");
        symlinkSync(outside, path.join(root, "symbolic"));
        linkSync(outside, path.join(root, "hard"));
        for (const relativePath of ["symbolic", "hard"]) {
          assert(nativeHost.readSecureFile({ root, relativePath, maxBytes: 32 }) === undefined,
            `Secure read accepted forbidden leaf ${relativePath}.`);
        }
      },
    );
    await recordAdversarialCheck(
      "collision-and-durability",
      "atomic publication rejected collisions while preserving existing and newly fsynced bytes",
      async () => {
        const root = path.join(dataDir, "adversarial-collision");
        mkdirSync(root, { recursive: true });
        writeFileSync(path.join(root, "existing.bin"), "existing");
        await assertRejects(
          async () => nativeHost.writeSecureFileAtomic({
            root,
            leaf: "existing.bin",
            temporaryLeaf: `.collision.${randomUUID()}.tmp`,
            body: Buffer.from("replacement"),
          }),
          "Atomic publication replaced an existing leaf.",
        );
        assert(readFileSync(path.join(root, "existing.bin"), "utf8") === "existing",
          "Collision changed existing durable bytes.");
        nativeHost.writeSecureFileAtomic({
          root,
          leaf: "new.bin",
          temporaryLeaf: `.new.${randomUUID()}.tmp`,
          body: Buffer.from("durable-new"),
        });
        assert(nativeHost.readSecureFile({ root, relativePath: "new.bin", maxBytes: 32 })?.toString() === "durable-new",
          "Atomic publication did not preserve new durable bytes.");
      },
    );
    await recordAdversarialCheck(
      "batch-rollback",
      "invalid immutable batches failed during admission without publishing partial leaves",
      async () => {
        const root = path.join(dataDir, "adversarial-batch");
        mkdirSync(root, { recursive: true });
        await assertRejects(
          () => agents.publishManagedArtifactContentsAsync(root, "qualification", [
            { artifactId: "duplicate", input: "first" },
            { artifactId: "duplicate", input: "second" },
          ], 1),
          "Invalid immutable batch was accepted.",
        );
        assert(agents.readManagedArtifactContent(
          root,
          "qualification",
          "duplicate",
          5,
          "0".repeat(64),
        ) === undefined, "Rejected immutable batch published a partial leaf.");
      },
    );
    await recordAdversarialCheck(
      "production-routes",
      "installed Project, browser, workspace-review, and managed-artifact paths all used secure authority",
      async () => undefined,
    );
    await recordAdversarialCheck(
      "bounded-cancellation",
      "an already-cancelled secure asynchronous read settled within one second",
      async () => {
        const root = path.join(dataDir, "adversarial-cancellation");
        mkdirSync(root, { recursive: true });
        writeFileSync(path.join(root, "large.bin"), Buffer.alloc(8 * 1024 * 1024, 0x5a));
        const controller = new AbortController();
        controller.abort(new Error("qualification cancellation"));
        const startedAt = Date.now();
        await assertRejects(
          async () => nativeHost.readSecureFileAsync({
            root,
            relativePath: "large.bin",
            maxBytes: 8 * 1024 * 1024,
          }, controller.signal),
          "Cancelled secure read unexpectedly completed.",
        );
        assert(Date.now() - startedAt < 1_000, "Cancelled secure read exceeded its bounded settlement time.");
      },
    );
    secureReadPassed = true;
  }
  checks.push({
    id: "secure-file-authority",
    status: secureReadPassed ? "pass" : "fail",
    detail: secureReadPassed
      ? "native helper plus installed Project reader and managed publish/read/repair paths passed retained-authority checks"
      : "platform retained-handle secure file authority is unavailable",
  });
  const requiredAdversarialChecks = [
    "root-replacement",
    "ancestor-replacement",
    "cross-device-or-volume",
    "leaf-link-or-reparse",
    "collision-and-durability",
    "batch-rollback",
    "production-routes",
    "bounded-cancellation",
  ];
  checks.push(...adversarialChecks);
  const passedAdversarialChecks = new Set(
    adversarialChecks
      .filter((item) => item.status === "pass")
      .map((item) => item.id),
  );
  const adversarialFilesystemEvidence = secureReadPassed &&
    requiredAdversarialChecks.every((id) => passedAdversarialChecks.has(id));
  checks.push({
    id: "adversarial-filesystem-evidence",
    status: adversarialFilesystemEvidence ? "pass" : "fail",
    detail: adversarialFilesystemEvidence
      ? "the installed exact-commit target passed every required adversarial filesystem result"
      : "the installed exact-commit target did not pass every adversarial filesystem result",
  });

  const releaseBlockers = [];
  if (!providerProbePassed) {
    releaseBlockers.push("an authenticated subscription provider must pass on the exact release host");
  }
  if (filesystemCheck?.status !== "pass") releaseBlockers.push(filesystemCheck?.detail ?? "complete filesystem authority failed");
  if (!secureReadPassed) releaseBlockers.push("secure file adversarial qualification failed");
  if (!adversarialFilesystemEvidence) {
    releaseBlockers.push(
      "the installed exact-commit target must pass every adversarial filesystem qualification",
    );
  }
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
    commit: buildManifest.commit,
    version: buildManifest.version,
    channel: buildManifest.channel,
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
} catch (error) {
  // Do not hide the primary failed behavior if fixture teardown also fails.
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]");
  console.error("Launcher qualification failed before cleanup:", message);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    schemaVersion: 1, qualifiedAt: new Date().toISOString(),
    qualification: "installed-launcher-lifecycle", commit: buildManifest.commit,
    version: buildManifest.version, channel: buildManifest.channel,
    platform: process.platform, arch: process.arch, hostOs: hostOsIdentity(),
    checks, releaseQualified: false, releaseBlockers: [message],
    incomplete: true,
  }, null, 2) + "\n", { mode: 0o600 });
  throw error;
} finally {
  if (started) launcherCall("stop", [], true);
  if (firstPid && processAlive(firstPid)) {
    throw new Error("Qualification cleanup could not prove the original installed server exited.");
  }
  rmSync(disposableProject, { recursive: true, force: true });
}
