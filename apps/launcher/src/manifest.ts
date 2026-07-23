import { readFileSync } from "node:fs";
import type { BuildManifest } from "./types.js";

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`build manifest ${field} must be a non-empty string`);
  }
  return value;
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
  const target = raw.target as Record<string, unknown>;
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
    target: {
      platform: requiredString(target.platform, "target.platform"),
      arch: requiredString(target.arch, "target.arch"),
    },
    nodeVersion: requiredString(raw.nodeVersion, "nodeVersion"),
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
