#!/usr/bin/env node

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
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

function databaseSchemaVersion() {
  const migrations = readdirSync(path.join(repositoryRoot, "packages", "agents", "src", "migrations"))
    .map((name) => name.match(/^(\d{4})_/u)?.[1])
    .filter(Boolean)
    .sort();
  const latest = migrations.at(-1);
  if (!latest) throw new Error("No database migrations were found.");
  return latest;
}

function executable(pathname) {
  try { chmodSync(pathname, 0o755); } catch { /* Windows does not use POSIX modes. */ }
}

const targetPlatform = option("platform", process.platform);
const targetArch = option("arch", process.arch);
const version = option("version", process.env.PONDEROSA_BUILD_VERSION ?? "0.0.0-beta.local");
const channel = option("channel", process.env.PONDEROSA_RELEASE_CHANNEL ?? "beta");
const nodeBinary = path.resolve(option("node", process.env.PONDEROSA_NODE_BINARY ?? process.execPath));
const outputParent = path.resolve(option(
  "output",
  path.join(repositoryRoot, "dist", "beta", `${targetPlatform}-${targetArch}`),
));
const bundleRoot = path.join(outputParent, "Ponderosa");
const runtimeNodeName = targetPlatform === "win32" ? "node.exe" : "node";

for (const required of [
  path.join(repositoryRoot, "apps", "launcher", "dist", "cli.js"),
  path.join(repositoryRoot, "apps", "server", "dist", "main.js"),
  path.join(repositoryRoot, "apps", "web", "dist", "index.html"),
  nodeBinary,
]) {
  if (!existsSync(required)) throw new Error(`Required build input is missing: ${required}`);
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
cpSync(
  path.join(repositoryRoot, "apps", "web", "dist"),
  path.join(bundleRoot, "app", "web", "dist"),
  { recursive: true },
);
cpSync(
  path.join(repositoryRoot, "apps", "launcher", "dist"),
  path.join(bundleRoot, "app", "launcher", "dist"),
  { recursive: true },
);
mkdirSync(path.join(bundleRoot, "runtime"), { recursive: true });
cpSync(nodeBinary, path.join(bundleRoot, "runtime", runtimeNodeName));
executable(path.join(bundleRoot, "runtime", runtimeNodeName));
cpSync(
  path.join(repositoryRoot, "packages", "agents", "src", "migrations"),
  path.join(bundleRoot, "migrations"),
  { recursive: true },
);
cpSync(
  path.join(repositoryRoot, "docs", "wiki"),
  path.join(bundleRoot, "docs", "wiki"),
  { recursive: true },
);
cpSync(
  path.join(repositoryRoot, "starter-pack"),
  path.join(bundleRoot, "starter-pack"),
  { recursive: true },
);

const commit = exactCommit();
const manifest = {
  schemaVersion: 1,
  product: "Ponderosa",
  version,
  commit,
  communicationProtocolVersion: "communication-v3",
  databaseSchemaVersion: databaseSchemaVersion(),
  target: { platform: targetPlatform, arch: targetArch },
  nodeVersion: process.version,
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
