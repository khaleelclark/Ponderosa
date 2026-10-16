import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const cli = path.join(repository, "apps/launcher/dist/cli.js");
const launcher = await import(new URL("../../apps/launcher/dist/index.js", import.meta.url));

function invoke(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 15000 });
}
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-retirement-"));
  const install = path.join(root, "install");
  const data = path.join(root, "data");
  for (const directory of ["runtime", "app/server", "app/web/dist"])
    mkdirSync(path.join(install, directory), { recursive: true });
  symlinkSync(process.execPath, path.join(install, "runtime", process.platform === "win32" ? "node.exe" : "node"));
  writeFileSync(path.join(install, "app/server/dist-placeholder"), "not executed");
  mkdirSync(path.join(install, "app/server/dist"));
  // Exercise the actual server admission authority without executing its main.
  symlinkSync(path.join(repository, "apps/server/dist/state-admission.js"),
    path.join(install, "app/server/dist/state-admission.js"));
  writeFileSync(path.join(install, "app/server/dist/main.js"), "throw Error('startup guard unexpectedly spawned the server');");
  const manifest = { schemaVersion: 1, product: "Ponderosa", version: "0.1.0-test",
    commit: "a".repeat(40), communicationProtocolVersion: "communication-v3",
    databaseSchemaVersion: "0000_state_epoch_2.sql", databaseSchemaSha256: "b".repeat(64),
    target: { platform: process.platform, arch: process.arch }, nodeVersion: process.version,
    nodeExecutableBytes: statSync(process.execPath).size, nodeExecutableSha256: "c".repeat(64),
    nodeSource: { url: "https://nodejs.org/test-fixture", archiveSha256: "d".repeat(64), executableSha256: "c".repeat(64) },
    nativeAbi: { modules: process.versions.modules, napi: process.versions.napi },
    nativeHost: { bytes: 1, sha256: "e".repeat(64) }, buildTime: new Date().toISOString(), channel: "development" };
  writeFileSync(path.join(install, "build-manifest.json"), JSON.stringify(manifest));
  return { root, install, data, manifest, close: () => rmSync(root, { recursive: true, force: true }) };
}
function archiveEntries(file) {
  const bytes = gunzipSync(readFileSync(file)), entries = new Map();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().split("\0")[0];
    if (!name) break;
    const size = parseInt(header.subarray(124, 136).toString().replaceAll("\0", "").trim(), 8) || 0;
    entries.set(name, bytes.subarray(offset + 512, offset + 512 + size).toString());
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("help omits retired command, and invoking it is refused before touching data", () => {
  const f = fixture();
  try {
    const help = invoke(["help"]);
    assert.equal(help.status, 0); assert.doesNotMatch(help.stdout, /doctor/i);
    assert.match(help.stdout, /diagnostics/);
    const rejected = invoke(["doctor", "--install-root", f.install, "--data-dir", f.data]);
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /Unknown command: doctor/);
    assert.equal(existsSync(f.data), false);
    assert.equal("runDoctor" in launcher, false);
    assert.equal(existsSync(path.join(repository, "apps/launcher/dist/doctor.js")), false);
    assert.equal(existsSync(path.join(repository, "apps/launcher/dist/job-object-doctor-child.js")), false);
  } finally { f.close(); }
});

test("support archive works without Doctor and excludes private contents", () => {
  const f = fixture();
  try {
    // Admit the fresh root before adding synthetic logs/config/Project content.
    const initialized = invoke(["diagnostics", "--install-root", f.install, "--data-dir", f.data,
      "--output", path.join(f.root, "initial.tgz")]);
    assert.equal(initialized.status, 0, initialized.stderr);
    for (const directory of ["config", "logs", "projects/private", ".codex"])
      mkdirSync(path.join(f.data, directory), { recursive: true });
    writeFileSync(path.join(f.data, "logs/server.log"), "raw-log-sentinel-never-export");
    writeFileSync(path.join(f.data, "projects/private/message.txt"), "private-project-sentinel-never-export");
    writeFileSync(path.join(f.data, "config/launcher.json"), JSON.stringify({ port: 9876,
      providers: { codex: { executable: "/unused/codex" } } }));
    writeFileSync(path.join(f.data, ".codex/auth.json"), JSON.stringify({token:"credential-sentinel-never-export"}));
    const output = path.join(f.root, "support.tgz");
    const result = invoke(["diagnostics", "--install-root", f.install, "--data-dir", f.data, "--output", output]);
    assert.equal(result.status, 0, result.stderr);
    const entries = archiveEntries(output);
    assert.equal(entries.has("doctor.json"), false);
    for (const name of ["summary.json", "build-manifest.json", "launcher-state.json", "launcher-config.json", "log-metadata.json", "README.txt"])
      assert.equal(entries.has(name), true, name);
    assert.equal(JSON.parse(entries.get("build-manifest.json")).commit, f.manifest.commit);
    const content = [...entries.values()].join("\n");
    for (const sentinel of ["raw-log-sentinel-never-export", "private-project-sentinel-never-export", "credential-sentinel-never-export"])
      assert.equal(content.includes(sentinel), false);
    if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);
    const privateOutput = invoke(["diagnostics", "--install-root", f.install, "--data-dir", f.data,
      "--output", path.join(f.data, "forbidden.tgz")]);
    assert.notEqual(privateOutput.status, 0); assert.match(privateOutput.stderr, /outside the retained root/);
  } finally { f.close(); }
});

test("retirement preserves missing-runtime and wrong-platform startup refusal", () => {
  const f = fixture();
  try {
    rmSync(path.join(f.install, "runtime", process.platform === "win32" ? "node.exe" : "node"));
    const missing = invoke(["start", "--install-root", f.install, "--data-dir", f.data, "--no-browser"]);
    assert.notEqual(missing.status, 0); assert.match(missing.stderr, /bundled Node runtime is missing/);
    assert.equal(existsSync(f.data), false);
    symlinkSync(process.execPath, path.join(f.install, "runtime", process.platform === "win32" ? "node.exe" : "node"));
    f.manifest.target.platform = process.platform === "linux" ? "darwin" : "linux";
    writeFileSync(path.join(f.install, "build-manifest.json"), JSON.stringify(f.manifest));
    const mismatch = invoke(["start", "--install-root", f.install, "--data-dir", f.data, "--no-browser"]);
    assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /This package targets/);
    assert.equal(existsSync(f.data), false);
  } finally { f.close(); }
});
