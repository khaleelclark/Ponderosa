#!/usr/bin/env node

import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBetaVersion } from "./beta-version.mjs";
import { auditPortableSymlinkTree } from "./qualification/symlink-portability.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function exactCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function assertCleanSource() {
  const status = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  if (status) {
    throw new Error(
      "Native beta bundles require a clean exact-source worktree. Commit or remove source changes before packaging.",
    );
  }
}

function sha256(pathname) {
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

function nodeRuntimeIdentity(binary) {
  const bytes = statSync(binary).size;
  if (bytes < 5 * 1024 * 1024) {
    throw new Error(
      `The proposed bundled Node executable is only ${bytes} bytes and is not self-contained. ` +
      "Run `pnpm beta:node` to prepare the checksummed official Node 22 runtime.",
    );
  }
  let raw;
  try {
    raw = execFileSync(binary, [
      "--input-type=module",
      "--eval",
      "process.stdout.write(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,modules:process.versions.modules,napi:process.versions.napi}))",
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
  } catch (error) {
    throw new Error(
      `The bundled Node executable could not be run on this build host. ` +
      `Native beta bundles must be assembled on their target OS/architecture: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const identity = JSON.parse(raw);
  if (!/^v22\.\d+\.\d+(?:[-+].*)?$/u.test(identity.version)) {
    throw new Error(`Ponderosa private beta requires bundled Node 22; found ${identity.version ?? "unknown"}.`);
  }
  for (const field of ["platform", "arch", "modules", "napi"]) {
    if (typeof identity[field] !== "string" || identity[field] === "") {
      throw new Error(`Bundled Node did not report ${field}.`);
    }
  }
  return { ...identity, bytes, sha256: sha256(binary) };
}

function executable(pathname) {
  try { chmodSync(pathname, 0o755); } catch { /* Windows does not use POSIX modes. */ }
}

function pnpmCli() {
  const candidates = [
    process.env.npm_execpath,
    ...String(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, process.platform === "win32" ? "pnpm.cmd" : "pnpm")),
  ];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const resolved = realpathSync(candidate);
    if (/pnpm(?:\.(?:cmd|c?js|mjs))?$/iu.test(resolved)) return resolved;
  }
  throw new Error("Could not locate the pnpm CLI needed to deploy production dependencies.");
}

const targetPlatform = option("platform", process.platform);
const targetArch = option("arch", process.arch);
const configuredVersion = option("version", process.env.PONDEROSA_BUILD_VERSION);
const version = configuredVersion ?? resolveBetaVersion().version;
const channel = option("channel", process.env.PONDEROSA_RELEASE_CHANNEL ?? "beta");
const preparedNode = path.join(
  repositoryRoot,
  "dist",
  "node-runtime",
  `${targetPlatform}-${targetArch}`,
  targetPlatform === "win32" ? "node.exe" : "node",
);
const configuredNode = option("node", process.env.PONDEROSA_NODE_BINARY);
const nodeBinary = path.resolve(configuredNode ?? preparedNode);
const nodeSourcePath = path.resolve(option(
  "node-source",
  path.join(path.dirname(nodeBinary), "SOURCE.json"),
));
const outputParent = path.resolve(option(
  "output",
  path.join(repositoryRoot, "dist", "beta", `${targetPlatform}-${targetArch}`),
));
const bundleRoot = path.join(outputParent, "Ponderosa");
const runtimeNodeName = targetPlatform === "win32" ? "node.exe" : "node";
const baselineName = "0000_current_schema.sql";
const schemaSource = path.join(repositoryRoot, "packages", "agents", "src", "schema", baselineName);

assertCleanSource();
// This command is also a supported release entry point, so never trust a
// previously generated web/dist tree. A stale PWA shell can otherwise make a
// correct new daemon look like the old installed version.
execFileSync(
  process.execPath,
  [
    path.join(
      repositoryRoot,
      "apps",
      "web",
      "node_modules",
      "@rsbuild",
      "core",
      "bin",
      "rsbuild.js",
    ),
    "build",
  ],
  {
    cwd: path.join(repositoryRoot, "apps", "web"),
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  },
);

for (const required of [
  path.join(repositoryRoot, "apps", "launcher", "dist", "cli.js"),
  path.join(repositoryRoot, "apps", "engine-desktop", "dist", "main.js"),
  path.join(repositoryRoot, "apps", "server", "dist", "main.js"),
  path.join(repositoryRoot, "apps", "web", "dist", "index.html"),
  path.join(repositoryRoot, "packaging", "qualification", "verify-installed-bundle.mjs"),
  path.join(repositoryRoot, "packaging", "qualification", "symlink-portability.mjs"),
  schemaSource,
  nodeBinary,
  nodeSourcePath,
]) {
  if (!existsSync(required)) throw new Error(`Required build input is missing: ${required}`);
}

const nodeIdentity = nodeRuntimeIdentity(nodeBinary);
const nodeSource = JSON.parse(readFileSync(nodeSourcePath, "utf8"));
const nodeDistributionPlatform = targetPlatform === "win32" ? "win" : targetPlatform;
const nodeArchiveExtension = targetPlatform === "win32"
  ? "zip"
  : targetPlatform === "darwin"
    ? "tar.gz"
    : "tar.xz";
const officialNodeUrl = `https://nodejs.org/dist/${nodeIdentity.version}/` +
  `node-${nodeIdentity.version}-${nodeDistributionPlatform}-${targetArch}.${nodeArchiveExtension}`;
if (nodeSource.version !== nodeIdentity.version ||
    nodeSource.target !== `${targetPlatform}-${targetArch}` ||
    nodeSource.url !== officialNodeUrl ||
    !/^[a-f0-9]{64}$/u.test(nodeSource.archiveSha256 ?? "") ||
    nodeSource.executableSha256 !== nodeIdentity.sha256) {
  throw new Error("Bundled Node SOURCE.json does not match the executable and requested native target.");
}
if (nodeIdentity.platform !== targetPlatform || nodeIdentity.arch !== targetArch) {
  throw new Error(
    `Bundled Node is ${nodeIdentity.platform}/${nodeIdentity.arch}, but the requested target is ` +
    `${targetPlatform}/${targetArch}. Cross-assembled bundles are not release artifacts.`,
  );
}

rmSync(outputParent, { recursive: true, force: true });
mkdirSync(bundleRoot, { recursive: true });

const serverTarget = path.join(bundleRoot, "app", "server");
mkdirSync(path.dirname(serverTarget), { recursive: true });
const runtimeBuildEnvironment = {
  ...process.env,
  CI: process.env.CI ?? "true",
  PATH: `${path.dirname(nodeBinary)}${path.delimiter}${process.env.PATH ?? ""}`,
  npm_node_execpath: nodeBinary,
};

function runPnpm(args) {
  const cli = pnpmCli();
  const javascriptCli = /\.(?:c?js|mjs)$/iu.test(cli);
  execFileSync(javascriptCli ? nodeBinary : cli, javascriptCli ? [cli, ...args] : args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: runtimeBuildEnvironment,
    windowsHide: true,
    shell: process.platform === "win32" && !javascriptCli,
  });
}

runPnpm([
  "--config.verify-deps-before-run=false",
  "--config.node-linker=hoisted",
  "--filter", "@ponderosa/server",
  "deploy", "--prod", "--legacy", serverTarget,
]);

const launcherTarget = path.join(bundleRoot, "app", "launcher");
runPnpm([
  "--config.verify-deps-before-run=false",
  "--config.node-linker=hoisted",
  "--filter", "@ponderosa/launcher",
  "deploy", "--prod", "--legacy", launcherTarget,
]);

function removeDeployedWorkspaceSelfLink(packageTarget, packageName) {
  const selfLink = path.join(
    packageTarget,
    "node_modules",
    ".pnpm",
    "node_modules",
    "@ponderosa",
    packageName,
  );
  let stats;
  try {
    stats = lstatSync(selfLink);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stats.isSymbolicLink()) {
    throw new Error(`Deployed workspace self-link is not a symlink: ${selfLink}`);
  }
  rmSync(selfLink);
}

removeDeployedWorkspaceSelfLink(serverTarget, "server");
removeDeployedWorkspaceSelfLink(launcherTarget, "launcher");

function nativeHostAddon(packageTarget) {
  const require = createRequire(path.join(packageTarget, "package.json"));
  const entry = require.resolve("@ponderosa/native-host");
  const addon = path.resolve(path.dirname(entry), "..", "build", "Release", "ponderosa_native.node");
  if (!existsSync(addon)) {
    throw new Error(`Deployed native host addon is missing: ${addon}`);
  }
  return addon;
}

function nativeHostIdentity(addon) {
  return {
    bytes: statSync(addon).size,
    sha256: sha256(addon),
  };
}

const serverNativeHostAddon = nativeHostAddon(serverTarget);
const launcherNativeHostAddon = nativeHostAddon(launcherTarget);
// Native linkers may embed build-specific identities (notably Mach-O
// LC_UUID), so two correct builds from the same source need not be
// byte-for-byte identical. Ship the freshly deployed server build as the one
// canonical native image in both applications; installed qualification still
// loads and hashes each deployed copy through the bundled runtime.
const canonicalTemporaryAddon = `${launcherNativeHostAddon}.canonical-${process.pid}`;
try {
  cpSync(serverNativeHostAddon, canonicalTemporaryAddon);
  rmSync(launcherNativeHostAddon);
  renameSync(canonicalTemporaryAddon, launcherNativeHostAddon);
} finally {
  rmSync(canonicalTemporaryAddon, { force: true });
}
const serverNativeHost = nativeHostIdentity(serverNativeHostAddon);
const launcherNativeHost = nativeHostIdentity(launcherNativeHostAddon);
if (serverNativeHost.bytes !== launcherNativeHost.bytes ||
    serverNativeHost.sha256 !== launcherNativeHost.sha256) {
  throw new Error("Server and launcher could not be normalized to one native host addon identity.");
}
cpSync(
  path.join(repositoryRoot, "apps", "web", "dist"),
  path.join(bundleRoot, "app", "web", "dist"),
  { recursive: true },
);
const engineDesktopTarget = path.join(bundleRoot, "app", "engine-desktop");
cpSync(
  path.join(repositoryRoot, "apps", "engine-desktop", "dist"),
  path.join(engineDesktopTarget, "dist"),
  { recursive: true },
);
writeFileSync(path.join(engineDesktopTarget, "package.json"), `${JSON.stringify({
  name: "ponderosa-engine-desktop",
  version,
  description: "Self-hosted coding-agent workbench",
  author: "Ponderosa",
  private: true,
  type: "module",
  main: "dist/main.js",
}, null, 2)}\n`);
mkdirSync(path.join(bundleRoot, "runtime"), { recursive: true });
cpSync(nodeBinary, path.join(bundleRoot, "runtime", runtimeNodeName));
executable(path.join(bundleRoot, "runtime", runtimeNodeName));
cpSync(
  path.join(repositoryRoot, "packages", "agents", "src", "schema"),
  path.join(bundleRoot, "schema"),
  { recursive: true },
);
cpSync(
  path.join(repositoryRoot, "packaging", "qualification"),
  path.join(bundleRoot, "qualification"),
  { recursive: true },
);

const commit = exactCommit();
const manifest = {
  schemaVersion: 1,
  product: "Ponderosa",
  version,
  commit,
  communicationProtocolVersion: "communication-v3",
  databaseSchemaVersion: baselineName,
  databaseSchemaSha256: sha256(schemaSource),
  target: { platform: targetPlatform, arch: targetArch },
  nodeVersion: nodeIdentity.version,
  nodeExecutableBytes: nodeIdentity.bytes,
  nodeExecutableSha256: nodeIdentity.sha256,
  nodeSource: {
    url: nodeSource.url,
    archiveSha256: nodeSource.archiveSha256,
    executableSha256: nodeSource.executableSha256,
  },
  nativeAbi: {
    modules: nodeIdentity.modules,
    napi: nodeIdentity.napi,
  },
  nativeHost: serverNativeHost,
  buildTime: new Date().toISOString(),
  channel,
};
writeFileSync(path.join(bundleRoot, "package.json"), `${JSON.stringify({
  name: "ponderosa-installed-bundle",
  private: true,
  type: "module",
}, null, 2)}\n`);
writeFileSync(path.join(bundleRoot, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const unixLauncher = `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$ROOT/runtime/node" "$ROOT/app/launcher/dist/cli.js" --install-root "$ROOT" "$@"
`;
writeFileSync(path.join(bundleRoot, "ponderosa"), unixLauncher, { mode: 0o755 });
executable(path.join(bundleRoot, "ponderosa"));

const windowsLauncher = `@echo off\r
set "ROOT=%~dp0"\r
"%ROOT%runtime\\node.exe" "%ROOT%app\\launcher\\dist\\cli.js" --install-root "%ROOT%" %*\r
`;
writeFileSync(path.join(bundleRoot, "ponderosa.cmd"), windowsLauncher);

writeFileSync(path.join(bundleRoot, "INSTALLATION.txt"), [
  "Ponderosa private beta",
  "",
  "This directory is self-contained. It does not require a repository checkout",
  "or a host Node.js installation. Provider CLIs and their existing subscription",
  "login remain owned by the host user.",
  "",
  "Use `ponderosa open` (or ponderosa.cmd on Windows) to launch the application.",
  "Use `ponderosa doctor` to check the host before the first real Project.",
  "",
].join("\n"));

auditPortableSymlinkTree(bundleRoot, { label: "native beta bundle" });
process.stdout.write(`${bundleRoot}\n`);
