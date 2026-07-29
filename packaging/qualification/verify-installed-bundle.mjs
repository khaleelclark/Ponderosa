#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
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

function sha256(pathname) {
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

const installRoot = path.resolve(option("install-root", process.env.PONDEROSA_INSTALL_ROOT ?? "."));
const reportPath = path.resolve(option("report", path.join(installRoot, "qualification-report.json")));
const manifestPath = path.join(installRoot, "build-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const checks = [];

function pass(id, detail) {
  checks.push({ id, status: "pass", detail });
}

assert(manifest.schemaVersion === 1 && manifest.product === "Ponderosa", "Invalid build manifest.");
assert(manifest.target?.platform === process.platform, "Manifest platform does not match the native host.");
assert(manifest.target?.arch === process.arch, "Manifest architecture does not match the native host.");
assert(manifest.nodeVersion === process.version, "Manifest Node version does not match the bundled executable.");
assert(/^v22\.\d+\.\d+(?:[-+].*)?$/u.test(process.version), "Bundled runtime is not supported Node 22.");
assert(statSync(process.execPath).size >= 5 * 1024 * 1024, "Bundled Node executable is a thin system launcher.");
assert(manifest.nodeExecutableBytes === statSync(process.execPath).size, "Bundled Node size does not match its manifest.");
assert(manifest.nodeExecutableSha256 === sha256(process.execPath), "Bundled Node hash does not match its manifest.");
assert(typeof manifest.nodeSource?.url === "string", "Bundled Node source URL is missing.");
assert(/^[a-f0-9]{64}$/u.test(manifest.nodeSource?.archiveSha256 ?? ""),
  "Bundled Node archive checksum is missing.");
assert(manifest.nativeAbi?.modules === process.versions.modules, "Manifest Node modules ABI does not match runtime.");
assert(manifest.nativeAbi?.napi === process.versions.napi, "Manifest Node-API ABI does not match runtime.");
pass("identity", `${manifest.version} ${manifest.commit} ${manifest.channel} ${process.platform}/${process.arch}`);
pass("node", `${process.version} modules=${process.versions.modules} napi=${process.versions.napi}`);

const schemaPath = path.join(installRoot, "schema", manifest.databaseSchemaVersion);
assert(existsSync(schemaPath), "Launch-baseline schema is missing.");
assert(sha256(schemaPath) === manifest.databaseSchemaSha256, "Launch-baseline schema hash mismatch.");
pass("schema-identity", `${manifest.databaseSchemaVersion} sha256=${manifest.databaseSchemaSha256}`);

const serverPackage = path.join(installRoot, "app", "server", "package.json");
const require = createRequire(serverPackage);
const Database = require("better-sqlite3");
const sharp = require("sharp");
const nativeHostEntry = require.resolve("@ponderosa/native-host");
const nativeHostAddon = path.resolve(
  path.dirname(nativeHostEntry),
  "..",
  "build",
  "Release",
  "ponderosa_native.node",
);
assert(existsSync(nativeHostAddon), "Native host addon is missing from the deployed server.");
assert(manifest.nativeHost?.bytes === statSync(nativeHostAddon).size,
  "Native host addon size does not match its manifest.");
assert(manifest.nativeHost?.sha256 === sha256(nativeHostAddon),
  "Native host addon hash does not match its manifest.");
const nativeHost = require("@ponderosa/native-host");
if (process.platform === "win32") {
  assert(nativeHost.windowsJobObjectsSupported(), "Deployed Windows Job Object addon did not load.");
}
pass("native-host", `loaded deployed addon sha256=${manifest.nativeHost.sha256}`);
const disposable = path.join(os.tmpdir(), `ponderosa-qualification-${process.pid}-${Date.now()}`);
mkdirSync(disposable, { recursive: false, mode: 0o700 });

try {
  const databasePath = path.join(disposable, "native.sqlite");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE qualification(value TEXT NOT NULL); INSERT INTO qualification VALUES ('ok');");
  assert(database.prepare("SELECT value FROM qualification").get()?.value === "ok", "better-sqlite3 readback failed.");
  database.close();
  pass("better-sqlite3", `loaded and completed write/read/close with modules ABI ${process.versions.modules}`);

  const schemaDatabasePath = path.join(disposable, "schema.sqlite");
  const schemaDatabase = new Database(schemaDatabasePath);
  schemaDatabase.exec(readFileSync(schemaPath, "utf8"));
  const table = schemaDatabase.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='coordination_requests'",
  ).get();
  assert(table?.name === "coordination_requests", "Launch-baseline schema did not create canonical V3 tables.");
  schemaDatabase.close();
  pass("schema-create", "fresh disposable database created from the bundled launch baseline");

  const transformed = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 20, g: 80, b: 40, alpha: 1 },
    },
  }).resize(1, 1).png().toBuffer();
  assert(transformed.length > 8 && transformed.subarray(1, 4).toString("ascii") === "PNG", "sharp transform failed.");
  pass("sharp", `loaded ${sharp.versions?.sharp ?? "unknown"} and completed a disposable PNG transform`);

  const launcher = spawnSync(process.execPath, [
    path.join(installRoot, "app", "launcher", "dist", "cli.js"),
    "version",
    "--install-root", installRoot,
    "--json",
  ], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert(launcher.status === 0, `Bundled launcher failed: ${launcher.stderr || launcher.stdout}`);
  const reported = JSON.parse(launcher.stdout);
  assert(reported.commit === manifest.commit && reported.version === manifest.version,
    "Bundled launcher identity does not match the installed manifest.");
  pass("launcher-identity", "launcher version and commit match the installed manifest");
} finally {
  rmSync(disposable, { recursive: true, force: true });
}

const report = {
  schemaVersion: 1,
  qualifiedAt: new Date().toISOString(),
  qualification: "native-installed-bundle",
  installRoot,
  manifest: {
    version: manifest.version,
    commit: manifest.commit,
    channel: manifest.channel,
    target: manifest.target,
    nodeVersion: manifest.nodeVersion,
    nodeExecutableBytes: manifest.nodeExecutableBytes,
    nodeExecutableSha256: manifest.nodeExecutableSha256,
    nodeSource: manifest.nodeSource,
    nativeAbi: manifest.nativeAbi,
    nativeHost: manifest.nativeHost,
    databaseSchemaVersion: manifest.databaseSchemaVersion,
    databaseSchemaSha256: manifest.databaseSchemaSha256,
  },
  checks,
  status: "pass",
};
mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`Qualification passed; report=${reportPath}\n`);
