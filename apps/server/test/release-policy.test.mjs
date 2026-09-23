import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const policy = path.join(repositoryRoot, "packaging", "qualification", "enforce-release-policy.mjs");

function runPolicy(metadata, qualification, platform = "darwin") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ponderosa-release-policy-"));
  const metadataPath = path.join(directory, "artifact.metadata.json");
  const qualificationPath = path.join(directory, "qualification.json");
  writeFileSync(metadataPath, JSON.stringify(metadata));
  writeFileSync(qualificationPath, JSON.stringify(qualification));
  try {
    return execFileSync(process.execPath, [
      policy,
      "--metadata", metadataPath,
      "--qualification", qualificationPath,
      "--commit", "abc123",
      "--version", "1.2.3",
      "--platform", platform,
    ], { encoding: "utf8", stdio: "pipe" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const qualified = {
  commit: "abc123",
  qualifiedAt: "2026-09-22T12:00:00.000Z",
  releaseQualified: true,
  releaseBlockers: [],
  checks: [{ id: "exact-platform-provider-readiness", status: "pass", evidence: [{
    providerKind: "claude",
    qualified: true,
    reachability: "reachable",
    source: "operator_probe",
    observedAt: "2026-09-22T11:59:00.000Z",
    buildRevision: "abc123",
    servingBuildRevision: "abc123",
    instanceId: "current-startup",
    servingInstanceId: "current-startup",
    failureCategory: null,
  }] }],
};

test("production release policy accepts exact signed and qualified artifacts", () => {
  const output = runPolicy({
    commit: "abc123",
    version: "1.2.3",
    signed: true,
    notarized: true,
  }, qualified);
  assert.match(output, /passed/u);
});

test("production release policy rejects login-only and stale provider evidence", () => {
  const metadata = { commit: "abc123", version: "1.2.3", signed: true, notarized: true };
  assert.throws(() => runPolicy(metadata, {
    ...qualified,
    checks: [{ id: "exact-platform-provider-readiness", status: "pass", evidence: [{
      ...qualified.checks[0].evidence[0], reachability: "unverified",
    }] }],
  }), /provider qualification/u);
  assert.throws(() => runPolicy(metadata, {
    ...qualified,
    checks: [{ id: "exact-platform-provider-readiness", status: "pass", evidence: [{
      ...qualified.checks[0].evidence[0], observedAt: "2026-09-22T11:00:00.000Z",
    }] }],
  }), /provider qualification/u);
});

test("production release policy rejects cross-build and cross-startup proof", () => {
  const metadata = { commit: "abc123", version: "1.2.3", signed: true, notarized: true };
  const evidence = qualified.checks[0].evidence[0];
  for (const replacement of [
    { buildRevision: "older" },
    { servingBuildRevision: "older" },
    { instanceId: "older-startup" },
    { instanceId: undefined },
  ]) {
    assert.throws(() => runPolicy(metadata, {
      ...qualified,
      checks: [{ id: "exact-platform-provider-readiness", status: "pass", evidence: [{ ...evidence, ...replacement }] }],
    }), /provider qualification/u);
  }
  assert.throws(() => runPolicy(metadata, { ...qualified, commit: "older" }), /qualification commit/u);
});

test("production release policy rejects unresolved, unsigned, or mismatched artifacts", () => {
  assert.throws(() => runPolicy({
    commit: "wrong",
    version: "1.2.3",
    signed: false,
    notarized: false,
  }, {
    releaseQualified: false,
    releaseBlockers: ["provider unavailable"],
    checks: [{ id: "exact-platform-provider-readiness", status: "fail" }],
  }), /commit|qualified|blockers|signed|provider/iu);
});
