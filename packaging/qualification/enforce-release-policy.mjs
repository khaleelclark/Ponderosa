#!/usr/bin/env node

import { parseArgs } from "node:util";

import { readFileSync } from "node:fs";
import path from "node:path";

const { values } = parseArgs({
  options: {
    "metadata": { type: "string" },
    "qualification": { type: "string" },
    "commit": { type: "string" },
    "version": { type: "string" },
    "platform": { type: "string" },
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

function required(name) {
  const value = option(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const metadataPath = path.resolve(required("metadata"));
const qualificationPath = path.resolve(required("qualification"));
const expectedCommit = required("commit");
const expectedVersion = required("version");
const platform = required("platform");
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
const qualification = JSON.parse(readFileSync(qualificationPath, "utf8"));

const failures = [];
if (metadata.commit !== expectedCommit) failures.push("artifact commit does not match the release commit");
if (qualification.commit !== expectedCommit) failures.push("qualification commit does not match the release commit");
if (metadata.version !== expectedVersion) failures.push("artifact version does not match the stable tag");
if (qualification.releaseQualified !== true) failures.push("installed artifact is not release qualified");
if (!Array.isArray(qualification.releaseBlockers) || qualification.releaseBlockers.length > 0) {
  failures.push("installed qualification has unresolved release blockers");
}
if (platform === "darwin" && (metadata.signed !== true || metadata.notarized !== true)) {
  failures.push("macOS artifact is not both signed and notarized");
}
if (platform === "win32" && metadata.signed !== true) {
  failures.push("Windows artifact is not Authenticode signed");
}
if (platform === "linux" && metadata.signed === true) {
  failures.push("Linux metadata must rely on the workflow's Sigstore provenance, not claim an embedded signature");
}

const providerCheck = (qualification.checks ?? []).find((check) =>
  check?.id === "exact-platform-provider-readiness");
const qualifiedAtMs = Date.parse(qualification.qualifiedAt ?? "");
const providerEvidence = providerCheck?.evidence;
const hasReachableEvidence = Number.isFinite(qualifiedAtMs) &&
  Array.isArray(providerEvidence) && providerEvidence.some((entry) => {
    const observedAtMs = Date.parse(entry?.observedAt ?? "");
    return entry?.qualified === true && entry.reachability === "reachable" &&
      ["operator_probe", "provider_run"].includes(entry.source) &&
      typeof entry.providerKind === "string" &&
      entry.buildRevision === expectedCommit &&
      entry.servingBuildRevision === expectedCommit &&
      typeof entry.instanceId === "string" && entry.instanceId.length > 0 &&
      entry.instanceId === entry.servingInstanceId &&
      Number.isFinite(observedAtMs) &&
      observedAtMs >= qualifiedAtMs - 5 * 60_000 && observedAtMs <= qualifiedAtMs + 30_000;
  });
if (providerCheck?.status !== "pass" || !hasReachableEvidence) {
  failures.push("exact-platform provider qualification did not pass");
}

if (failures.length > 0) {
  throw new Error(`Production release policy rejected the artifact:\n- ${failures.join("\n- ")}`);
}
process.stdout.write(`Production release policy passed for ${platform} ${expectedVersion} ${expectedCommit}.\n`);
