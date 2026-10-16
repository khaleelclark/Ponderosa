import { readFileSync } from "@ponderosa/native-host/fs";
import type { BuildManifest } from "./types.js";

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`build manifest ${field} must be a non-empty string`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`build manifest ${field} must be a positive integer`);
  }
  return value as number;
}

export function parseBuildManifest(value: unknown): BuildManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("build manifest must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw new Error("unsupported build manifest schema");
  if (raw.product !== "Ponderosa") throw new Error("build manifest product must be Ponderosa");
  if (!raw.target || typeof raw.target !== "object" || Array.isArray(raw.target)) {
    throw new Error("build manifest target must be an object");
  }
  if (!raw.nativeAbi || typeof raw.nativeAbi !== "object" || Array.isArray(raw.nativeAbi)) {
    throw new Error("build manifest nativeAbi must be an object");
  }
  if (!raw.nodeSource || typeof raw.nodeSource !== "object" || Array.isArray(raw.nodeSource)) {
    throw new Error("build manifest nodeSource must be an object");
  }
  if (!raw.nativeHost || typeof raw.nativeHost !== "object" || Array.isArray(raw.nativeHost)) {
    throw new Error("build manifest nativeHost must be an object");
  }
  const target = raw.target as Record<string, unknown>;
  const nativeAbi = raw.nativeAbi as Record<string, unknown>;
  const nodeSource = raw.nodeSource as Record<string, unknown>;
  const nativeHost = raw.nativeHost as Record<string, unknown>;
  const buildTime = requiredString(raw.buildTime, "buildTime");
  if (Number.isNaN(Date.parse(buildTime))) throw new Error("build manifest buildTime must be an ISO timestamp");
  return {
    schemaVersion: 1,
    product: "Ponderosa",
    version: requiredString(raw.version, "version"),
    commit: requiredString(raw.commit, "commit"),
    communicationProtocolVersion: requiredString(
      raw.communicationProtocolVersion,
      "communicationProtocolVersion",
    ),
    databaseSchemaVersion: requiredString(raw.databaseSchemaVersion, "databaseSchemaVersion"),
    databaseSchemaSha256: requiredString(raw.databaseSchemaSha256, "databaseSchemaSha256"),
    target: {
      platform: requiredString(target.platform, "target.platform"),
      arch: requiredString(target.arch, "target.arch"),
    },
    nodeVersion: requiredString(raw.nodeVersion, "nodeVersion"),
    nodeExecutableBytes: requiredPositiveInteger(raw.nodeExecutableBytes, "nodeExecutableBytes"),
    nodeExecutableSha256: requiredString(raw.nodeExecutableSha256, "nodeExecutableSha256"),
    nodeSource: {
      url: requiredString(nodeSource.url, "nodeSource.url"),
      archiveSha256: requiredString(nodeSource.archiveSha256, "nodeSource.archiveSha256"),
      executableSha256: requiredString(nodeSource.executableSha256, "nodeSource.executableSha256"),
    },
    nativeAbi: {
      modules: requiredString(nativeAbi.modules, "nativeAbi.modules"),
      napi: requiredString(nativeAbi.napi, "nativeAbi.napi"),
    },
    nativeHost: {
      bytes: requiredPositiveInteger(nativeHost.bytes, "nativeHost.bytes"),
      sha256: requiredString(nativeHost.sha256, "nativeHost.sha256"),
    },
    buildTime,
    channel: requiredString(raw.channel, "channel"),
  };
}

export function readBuildManifest(path: string): BuildManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`could not read build manifest at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseBuildManifest(parsed);
}
