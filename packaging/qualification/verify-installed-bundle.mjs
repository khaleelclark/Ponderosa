#!/usr/bin/env node

import { parseArgs } from "node:util";

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
import {
  macosDeploymentTargetAtMost,
  macosDeploymentTargets,
} from "./macos-deployment-target.mjs";
import { auditPortableSymlinkTree } from "./symlink-portability.mjs";
import { verifyFirstPartyNotices } from "./first-party-notices.mjs";

const { values } = parseArgs({
  options: {
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
assert(/^v24\.\d+\.\d+(?:[-+].*)?$/u.test(process.version), "Bundled runtime is not supported Node 24.");
assert(statSync(process.execPath).size >= 5 * 1024 * 1024, "Bundled Node executable is a thin system launcher.");
assert(manifest.nodeExecutableBytes === statSync(process.execPath).size, "Bundled Node size does not match its manifest.");
assert(manifest.nodeExecutableSha256 === sha256(process.execPath), "Bundled Node hash does not match its manifest.");
assert(typeof manifest.nodeSource?.url === "string", "Bundled Node source URL is missing.");
assert(/^[a-f0-9]{64}$/u.test(manifest.nodeSource?.archiveSha256 ?? ""),
  "Bundled Node archive checksum is missing.");
assert(manifest.nodeSource?.executableSha256 === manifest.nodeExecutableSha256,
  "Prepared Node executable identity is not bound to the installed runtime.");
assert(manifest.nativeAbi?.modules === process.versions.modules, "Manifest Node modules ABI does not match runtime.");
assert(manifest.nativeAbi?.napi === process.versions.napi, "Manifest Node-API ABI does not match runtime.");
pass("identity", `${manifest.version} ${manifest.commit} ${manifest.channel} ${process.platform}/${process.arch}`);
pass("node", `${process.version} modules=${process.versions.modules} napi=${process.versions.napi}`);
verifyFirstPartyNotices(installRoot);
pass("first-party-notices", "Ponderosa LICENSE and CREDITS.md match the approved release wording exactly");
assert(sha256(path.join(installRoot, "runtime", "LICENSE")) === manifest.nodeSource?.licenseSha256,
  "Official Node license text is missing or differs from its distribution identity.");
for (const filename of [
  "THIRD-PARTY-NOTICES.txt",
  "notices/engine/THIRD-PARTY-NOTICES.txt",
  "notices/engine/dependency-notices.json",
  "notices/native/UPSTREAM-LICENSE-REFERENCES.txt",
  "notices/SOURCE-REFERENCES.md",
  "app/web/dist/notices/THIRD-PARTY-NOTICES.txt",
  "app/web/dist/notices/dependency-notices.json",
]) {
  assert(statSync(path.join(installRoot, filename)).size > 0, `Required notice is empty: ${filename}`);
}
pass("third-party-notices", "Official runtime license and engine/browser/native notice collections are present; source-license review remains separate");
const installedSymlinks = auditPortableSymlinkTree(installRoot, {
  label: "installed application root",
});
pass(
  "symlink-portability",
  `${installedSymlinks.symlinkCount} relative in-root symlinks passed before dependency loading`,
);

const schemaPath = path.join(installRoot, "schema", manifest.databaseSchemaVersion);
assert(existsSync(schemaPath), "Launch-baseline schema is missing.");
assert(sha256(schemaPath) === manifest.databaseSchemaSha256, "Launch-baseline schema hash mismatch.");
pass("schema-identity", `${manifest.databaseSchemaVersion} sha256=${manifest.databaseSchemaSha256}`);

function deployedNativeHost(application) {
  const applicationRequire = createRequire(path.join(installRoot, "app", application, "package.json"));
  const entry = applicationRequire.resolve("@ponderosa/native-host");
  const addon = path.resolve(path.dirname(entry), "..", "build", "Release", "ponderosa_native.node");
  assert(existsSync(addon), `Native host addon is missing from the deployed ${application}.`);
  assert(manifest.nativeHost?.bytes === statSync(addon).size,
    `Deployed ${application} native host addon size does not match its manifest.`);
  assert(manifest.nativeHost?.sha256 === sha256(addon),
    `Deployed ${application} native host addon hash does not match its manifest.`);
  return { applicationRequire, addon };
}

const serverNativeHost = deployedNativeHost("server");
const launcherNativeHost = deployedNativeHost("launcher");
assert(sha256(serverNativeHost.addon) === sha256(launcherNativeHost.addon),
  "Installed server and launcher native host addons differ.");
const require = serverNativeHost.applicationRequire;
const Database = require("better-sqlite3");
const sharp = require("sharp");
const nativeHost = launcherNativeHost.applicationRequire("@ponderosa/native-host");
if (process.platform === "win32") {
  assert(nativeHost.windowsJobObjectsSupported(), "Deployed Windows Job Object addon did not load.");
}
pass("native-host", `loaded matching server/launcher addons sha256=${manifest.nativeHost.sha256}`);

if (process.platform === "darwin") {
  for (const [label, binary] of [
    ["Node", process.execPath],
    ["server native host", serverNativeHost.addon],
    ["launcher native host", launcherNativeHost.addon],
  ]) {
    const inspection = spawnSync("otool", ["-l", binary], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert(inspection.status === 0, `${label} Mach-O deployment target could not be inspected.`);
    const minimums = macosDeploymentTargets(inspection.stdout);
    assert(minimums.length > 0 &&
      minimums.every((minimum) => macosDeploymentTargetAtMost(minimum, "14.0")),
      `${label} is not compatible with macOS 14.`);
    const architectures = spawnSync("lipo", ["-archs", binary], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert(architectures.status === 0, `${label} Mach-O architecture could not be inspected.`);
    assert(architectures.stdout.trim().split(/\s+/u).every((architecture) => architecture === "arm64"),
      `${label} contains a non-arm64 Mach-O slice.`);
  }
  pass("macos-deployment-target", "Every Node/native-addon slice is arm64 and declares macOS 14 compatibility");
}
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
