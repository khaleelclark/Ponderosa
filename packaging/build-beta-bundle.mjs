#!/usr/bin/env node

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const targetPlatform = option("platform", process.platform);
const targetArch = option("arch", process.arch);
const version = option("version", process.env.PONDEROSA_BUILD_VERSION ?? "0.0.0-beta.local");
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

for (const required of [
  path.join(repositoryRoot, "apps", "launcher", "dist", "cli.js"),
  path.join(repositoryRoot, "apps", "server", "dist", "main.js"),
  path.join(repositoryRoot, "apps", "web", "dist", "index.html"),
  path.join(repositoryRoot, "packaging", "qualification", "verify-installed-bundle.mjs"),
  schemaSource,
  nodeBinary,
  nodeSourcePath,
]) {
  if (!existsSync(required)) throw new Error(`Required build input is missing: ${required}`);
}

assertCleanSource();
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
execFileSync("pnpm", [
  "--filter", "@ponderosa/server",
  "deploy", "--prod", "--legacy", serverTarget,
], {
  cwd: repositoryRoot,
  stdio: "inherit",
  env: { ...process.env, CI: process.env.CI ?? "true" },
});

const launcherTarget = path.join(bundleRoot, "app", "launcher");
execFileSync("pnpm", [
  "--filter", "@ponderosa/launcher",
  "deploy", "--prod", "--legacy", launcherTarget,
], {
  cwd: repositoryRoot,
  stdio: "inherit",
  env: { ...process.env, CI: process.env.CI ?? "true" },
});

function nativeHostIdentity(packageTarget) {
  const require = createRequire(path.join(packageTarget, "package.json"));
  const entry = require.resolve("@ponderosa/native-host");
  const addon = path.resolve(path.dirname(entry), "..", "build", "Release", "ponderosa_native.node");
  if (!existsSync(addon)) {
    throw new Error(`Deployed native host addon is missing: ${addon}`);
  }
  return {
    bytes: statSync(addon).size,
    sha256: sha256(addon),
  };
}

const serverNativeHost = nativeHostIdentity(serverTarget);
const launcherNativeHost = nativeHostIdentity(launcherTarget);
if (serverNativeHost.bytes !== launcherNativeHost.bytes ||
    serverNativeHost.sha256 !== launcherNativeHost.sha256) {
  throw new Error("Server and launcher deployed different native host addon bytes.");
}
cpSync(
  path.join(repositoryRoot, "apps", "web", "dist"),
  path.join(bundleRoot, "app", "web", "dist"),
  { recursive: true },
);
mkdirSync(path.join(bundleRoot, "runtime"), { recursive: true });
cpSync(nodeBinary, path.join(bundleRoot, "runtime", runtimeNodeName));
executable(path.join(bundleRoot, "runtime", runtimeNodeName));
cpSync(
  path.join(repositoryRoot, "packages", "agents", "src", "schema"),
  path.join(bundleRoot, "schema"),
  { recursive: true },
);
cpSync(
  path.join(repositoryRoot, "docs", "wiki"),
  path.join(bundleRoot, "docs", "wiki"),
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

const windowsGuiLauncher = `Option Explicit\r
Dim shell, fso, root, command\r
Set shell = CreateObject("WScript.Shell")\r
Set fso = CreateObject("Scripting.FileSystemObject")\r
root = fso.GetParentFolderName(WScript.ScriptFullName)\r
command = Chr(34) & root & "\\runtime\\node.exe" & Chr(34) & " " & Chr(34) & root & "\\app\\launcher\\dist\\cli.js" & Chr(34) & " open --install-root " & Chr(34) & root & Chr(34)\r
shell.Run command, 0, False\r
`;
writeFileSync(path.join(bundleRoot, "ponderosa.vbs"), windowsGuiLauncher);

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

process.stdout.write(`${bundleRoot}\n`);
