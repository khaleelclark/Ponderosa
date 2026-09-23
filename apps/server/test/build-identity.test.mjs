import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertProductionBuildIdentity } from "../dist/build-identity.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

test("production startup is bound to the installed manifest identity", t => {
  const root = mkdtempSync(path.join(tmpdir(), "ponderosa-build-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "build-manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    product: "Ponderosa",
    version: "1.2.3",
    commit: revision,
    channel: "production",
    target: { platform: "linux", arch: "x64" },
  }));
  assert.doesNotThrow(() => assertProductionBuildIdentity({
    releaseChannel: "production",
    buildRevision: revision,
    buildVersion: "1.2.3",
    manifestPath,
    platform: "linux",
    arch: "x64",
  }));
  assert.throws(() => assertProductionBuildIdentity({
    releaseChannel: "production",
    buildRevision: "f".repeat(40),
    buildVersion: "1.2.3",
    manifestPath,
    platform: "linux",
    arch: "x64",
  }), /does not match/u);
  assert.throws(() => assertProductionBuildIdentity({
    releaseChannel: "production",
    buildRevision: revision,
    manifestPath,
  }), /requires exact/u);
});

test("non-production development startup does not require an installed manifest", () => {
  assert.doesNotThrow(() => assertProductionBuildIdentity({
    releaseChannel: "sandbox",
    manifestPath: "/missing/build-manifest.json",
  }));
});
