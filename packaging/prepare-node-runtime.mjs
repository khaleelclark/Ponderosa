#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

const version = option("version", process.env.PONDEROSA_NODE_VERSION ?? "22.22.1").replace(/^v/u, "");
if (!/^22\.\d+\.\d+$/u.test(version)) throw new Error(`Ponderosa requires an exact Node 22 version; received ${version}.`);
const platform = option("platform", process.platform);
const arch = option("arch", process.arch);
const supported = new Set(["linux-x64", "darwin-arm64", "win32-x64"]);
const target = `${platform}-${arch}`;
if (!supported.has(target)) throw new Error(`Unsupported private-beta Node target: ${target}`);
if (platform !== process.platform || arch !== process.arch) {
  throw new Error(`Node runtime preparation must run natively on ${target}; this host is ${process.platform}-${process.arch}.`);
}

const distributionPlatform = platform === "win32" ? "win" : platform;
const extension = platform === "win32" ? "zip" : platform === "darwin" ? "tar.gz" : "tar.xz";
const directoryName = `node-v${version}-${distributionPlatform}-${arch}`;
const archiveName = `${directoryName}.${extension}`;
const baseUrl = `https://nodejs.org/dist/v${version}`;
const checksums = (await download(`${baseUrl}/SHASUMS256.txt`)).toString("utf8");
const checksumLine = checksums.split(/\r?\n/u).find((line) => line.endsWith(`  ${archiveName}`));
if (!checksumLine) throw new Error(`Node release checksums do not contain ${archiveName}.`);
const expected = checksumLine.split(/\s+/u, 1)[0];
const archive = await download(`${baseUrl}/${archiveName}`);
const actual = sha256(archive);
if (actual !== expected) throw new Error(`Node archive checksum mismatch: expected ${expected}, received ${actual}.`);

const temporary = path.join(os.tmpdir(), `ponderosa-node-${process.pid}-${Date.now()}`);
const archivePath = path.join(temporary, archiveName);
const output = path.join(repositoryRoot, "dist", "node-runtime", target);
mkdirSync(temporary, { recursive: true, mode: 0o700 });
try {
  writeFileSync(archivePath, archive, { mode: 0o600 });
  execFileSync("tar", ["-xf", archivePath, "-C", temporary], { stdio: "inherit", windowsHide: true });
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const executableName = platform === "win32" ? "node.exe" : "node";
  cpSync(
    path.join(temporary, directoryName, platform === "win32" ? "" : "bin", executableName),
    path.join(output, executableName),
  );
  if (platform !== "win32") {
    execFileSync("chmod", ["0755", path.join(output, executableName)]);
  }
  writeFileSync(path.join(output, "SOURCE.json"), `${JSON.stringify({
    version: `v${version}`,
    target,
    url: `${baseUrl}/${archiveName}`,
    archiveSha256: actual,
  }, null, 2)}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write(`${path.join(output, platform === "win32" ? "node.exe" : "node")}\n`);
