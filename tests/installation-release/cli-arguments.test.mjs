import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertBuildVersion } from "../../packaging/beta-version.mjs";
import { expectedMacosBundleIdentity } from "../../packaging/qualification/macos-bundle-metadata.mjs";
import { qualifyProviderReachability } from "../../packaging/qualification/provider-reachability.mjs";

const packaging = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packaging");

test("installed provider qualification awaits pending authentication and skips absent or disabled CLIs", async () => {
  const now = Date.now();
  const calls = [];
  const result = await qualifyProviderReachability({
    baseUrl: "http://qualification.invalid", cookie: "fixture", expectedRevision: "fixture", now: () => now,
    fetchImpl: async (url, options) => {
      calls.push([url, options.method ?? "GET"]);
      if (url.endsWith("/api/engines")) return Response.json([
        { id: "codex", installed: true, enabled: true, authentication: "error", authReason: "probe_pending" },
        { id: "missing", installed: false, enabled: true, authentication: "authenticated" },
        { id: "disabled", installed: true, enabled: false, authentication: "authenticated" },
      ]);
      assert.equal(url, "http://qualification.invalid/api/engines/codex/recheck");
      return Response.json({
        id: "codex", authentication: "authenticated", enabled: true, intakeReady: true,
        reachability: "reachable", availabilitySource: "operator_probe",
        availabilityObservedAt: new Date(now).toISOString(),
        availabilityBuildRevision: "fixture", servingBuildRevision: "fixture",
        availabilityInstanceId: "current", servingInstanceId: "current",
      });
    },
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.evidence.filter(entry => entry.qualified).map(entry => entry.providerKind), ["codex"]);
  assert.deepEqual(calls.map(([url, method]) => [new URL(url).pathname, method]), [
    ["/api/engines", "GET"], ["/api/engines/codex/recheck", "POST"],
  ]);
});

test("rechecking a pending provider never substitutes login for successful current-build evidence", async () => {
  const result = await qualifyProviderReachability({
    baseUrl: "http://qualification.invalid", cookie: "fixture", expectedRevision: "fixture",
    fetchImpl: async url => Response.json(url.endsWith("/api/engines")
      ? [{ id: "codex", installed: true, authentication: "error", authReason: "probe_pending" }]
      : { id: "codex", authentication: "authenticated", intakeReady: true, reachability: "unverified" }),
  });
  assert.equal(result.passed, false);
  assert.equal(result.evidence[0].qualified, false);
});
const entries = [
  ["build-beta-bundle.mjs", "output"],
  ["verify-beta-bundle.mjs", "bundle"],
  ["prepare-node-runtime.mjs", "version"],
  ["package-beta.mjs", "output"],
  ["qualification/qualify-installer.mjs", "artifact"],
  ["qualification/verify-installed-bundle.mjs", "install-root"],
  ["qualification/enforce-release-policy.mjs", "metadata"],
  ["qualification/qualify-launcher-lifecycle.mjs", "install-root"],
  ["qualification/qualify-macos-gui-launch.mjs", "application"],
];

function run(script, args, cwd) {
  return spawnSync(process.execPath, [path.join(packaging, script), ...args], {
    cwd, encoding: "utf8", timeout: 10_000,
  });
}

for (const [script, option] of entries) {
  test(`${script} rejects malformed arguments before filesystem work`, () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "ponderosa-cli-"));
    try {
      // The old scanner accepted an adjacent flag as a path. Preserve both
      // a realistic output directory and a directory named like that flag.
      for (const name of ["Ponderosa", "--not-a-value"]) {
        mkdirSync(path.join(cwd, name));
        writeFileSync(path.join(cwd, name, "sentinel"), "keep");
      }
      const malformed = [
        [[`--${option}`], /ERR_PARSE_ARGS_INVALID_OPTION_VALUE/],
        [[`--${option}`, "--not-a-value"], /ERR_PARSE_ARGS_INVALID_OPTION_VALUE/],
        [["--unknown-option=value"], /ERR_PARSE_ARGS_UNKNOWN_OPTION/],
        [[`--${option}=   `], /requires a nonempty value/],
        [["unexpected-position"], /ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL/],
      ];
      for (const [args, error] of malformed) {
        const result = run(script, args, cwd);
        assert.equal(result.error, undefined);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, error);
        assert.deepEqual(readdirSync(cwd).sort(), ["--not-a-value", "Ponderosa"]);
        for (const name of ["Ponderosa", "--not-a-value"]) {
          assert.equal(readFileSync(path.join(cwd, name, "sentinel"), "utf8"), "keep");
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("release policy accepts separated and equals string values", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "ponderosa-policy-"));
  try {
    const commit = "fixture-commit";
    const version = "0.2.0";
    const qualifiedAt = new Date().toISOString();
    writeFileSync(path.join(cwd, "metadata.json"), JSON.stringify({ commit, version, signed: false }));
    writeFileSync(path.join(cwd, "qualification.json"), JSON.stringify({
      commit, qualifiedAt, releaseQualified: true, releaseBlockers: [],
      checks: [{ id: "exact-platform-provider-readiness", status: "pass", evidence: [{
        qualified: true, reachability: "reachable", source: "operator_probe",
        providerKind: "fixture", buildRevision: commit, servingBuildRevision: commit,
        instanceId: "fixture-instance", servingInstanceId: "fixture-instance", observedAt: qualifiedAt,
      }] }],
    }));
    const options = { metadata: "metadata.json", qualification: "qualification.json", commit, version, platform: "linux" };
    for (const args of [Object.entries(options).flatMap(([key, value]) => [`--${key}`, value]),
      Object.entries(options).map(([key, value]) => `--${key}=${value}`)]) {
      const result = run("qualification/enforce-release-policy.mjs", args, cwd);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Production release policy passed/);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("installer boolean parses while missing artifact fails before installation", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "ponderosa-installer-cli-"));
  try {
    const result = run("qualification/qualify-installer.mjs", ["--artifact", "absent.deb", "--skip-provider-qualification"], cwd);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Installer artifact is missing/);
    assert.deepEqual(readdirSync(cwd), []);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("beta build identity accepts canonical 0.x versions and beta.N prereleases", () => {
  for (const channel of ["beta", "development", "private"]) {
    for (const version of ["0.1.0", "0.1.1", "0.10.12", "1.0.0-beta.1", "1.0.0-beta.2", "1.2.3-beta.19"]) {
      assert.doesNotThrow(() => assertBuildVersion(version, channel));
      assert.equal(expectedMacosBundleIdentity({ version, commit: "fixture" }).exactVersion, version);
    }
    for (const version of ["0.01.1", "0.1.01", "0.1.1\n", "0.1.1+private", "1.0.0", "0.1.0-private.startup.abc12345", "1.0.0-private.20261015.pr711-c32.1",
      "1.0.0-beta.0", "1.0.0-beta.01", "01.0.0-beta.1", "1.0.0-beta.1+private", "1.0.0-b1",
      "1.0.0-beta.9007199254740992", "1.0.0-beta.1\n", " 1.0.0-beta.1", null, undefined]) {
      assert.throws(() => assertBuildVersion(version, channel), /Build version must be/);
    }
  }
  assert.doesNotThrow(() => assertBuildVersion("1.0.0", "production"));
  assert.throws(() => assertBuildVersion("1.0.0-beta.1", "production"), /Build version must be X.Y.Z/);
});

test("bundle overrides and retained installer manifests reject non-beta identities before output work", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "ponderosa-version-boundary-"));
  try {
    const bundle = path.join(cwd, "bundle");
    const output = path.join(cwd, "output");
    mkdirSync(bundle);
    writeFileSync(path.join(bundle, "sentinel"), "preserve");
    for (const version of ["1.0.0", "1.0.0-private.startup.abc12345", "1.0.0-beta.01"]) {
      const built = run("build-beta-bundle.mjs", ["--version", version, "--channel", "beta", "--output", output], cwd);
      assert.equal(built.error, undefined);
      assert.notEqual(built.status, 0);
      assert.match(built.stderr, /Build version must be X.Y.Z-beta.N/);
      writeFileSync(path.join(bundle, "build-manifest.json"), JSON.stringify({ version, channel: "beta" }));
      const packaged = run("package-beta.mjs", ["--bundle", bundle, "--output", output], cwd);
      assert.equal(packaged.error, undefined);
      assert.notEqual(packaged.status, 0);
      assert.match(packaged.stderr, /Build version must be X.Y.Z-beta.N/);
      assert.deepEqual(readdirSync(cwd), ["bundle"]);
      assert.equal(readFileSync(path.join(bundle, "sentinel"), "utf8"), "preserve");
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("beta version preview preserves annotated prereleases and explicit 0.x release identities", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "ponderosa-beta-preview-"));
  try {
    mkdirSync(path.join(cwd, "packaging"));
    const hooks = path.join(cwd, "empty-hooks");
    mkdirSync(hooks);
    copyFileSync(path.join(packaging, "beta-version.mjs"), path.join(cwd, "packaging", "beta-version.mjs"));
    writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ version: "1.0.0", type: "module" }));
    const git = (...args) => {
      const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
      { cwd, encoding: "utf8", timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const preview = (...args) => spawnSync(process.execPath, ["packaging/beta-version.mjs", ...args],
      { cwd, encoding: "utf8", timeout: 10_000 });
    git("init"); git("add", "."); git("commit", "-m", "Disposable version fixture");
    assert.equal(preview().stdout.trim(), "1.0.0-beta.1");
    assert.equal(git("tag", "--list"), "");
    assert.notEqual(preview("--require-tag").status, 0);
    git("tag", "-a", "v1.0.0-beta.1", "-m", "Disposable beta fixture");
    assert.equal(preview("--require-tag").stdout.trim(), "1.0.0-beta.1");
    git("commit", "--allow-empty", "-m", "Next disposable candidate");
    assert.equal(preview().stdout.trim(), "1.0.0-beta.2");
    assert.equal(git("tag", "--list"), "v1.0.0-beta.1");
    git("tag", "v1.0.0-beta.2");
    assert.match(preview().stderr, /must be an annotated tag/);
    git("tag", "-d", "v1.0.0-beta.2");
    git("tag", "-a", "v1.0.0-beta.02", "-m", "Disposable invalid fixture");
    assert.match(preview().stderr, /Invalid beta tag/);
    git("tag", "-d", "v1.0.0-beta.02");
    writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ version: "0.2.0-beta.1", type: "module" }));
    git("add", "package.json"); git("commit", "-m", "Preserve explicit 0.x prerelease behavior");
    assert.equal(preview().stdout.trim(), "0.2.0-beta.1");
    writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ version: "0.1.1", type: "module" }));
    git("add", "package.json"); git("commit", "-m", "Select explicit 0.x version");
    assert.equal(preview().stdout.trim(), "0.1.1");
    assert.notEqual(preview("--require-tag").status, 0);
    assert.equal(git("tag", "--list", "v0.*"), "");
    git("tag", "v0.1.1");
    assert.match(preview().stderr, /must be an annotated tag/);
    git("tag", "-d", "v0.1.1");
    git("tag", "-a", "v0.1.1", "-m", "Disposable 0.x release fixture");
    assert.equal(preview("--require-tag").stdout.trim(), "0.1.1");
    git("commit", "--allow-empty", "-m", "Do not reuse a released identity");
    assert.match(preview().stderr, /already identifies another commit/);
    writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ version: "0.1.2", type: "module" }));
    git("add", "package.json"); git("commit", "-m", "Advance the 0.x release version");
    assert.equal(preview().stdout.trim(), "0.1.2");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
