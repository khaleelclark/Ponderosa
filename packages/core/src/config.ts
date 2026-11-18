// Config loader (SPEC §7). Resolves PONDEROSA_DATA_DIR with a per-OS default.
// Node-only — imported by apps/server, NOT re-exported from the package barrel, so
// the browser bundle (apps/web) never pulls in node built-ins.

import os from "node:os";
import path from "node:path";
import type { NetworkSecurityPostureDto } from "./dto.js";

/** Resolved runtime configuration for the server and CLI tools. */
export interface PonderosaConfig {
  /** Root of the on-disk event log + SQLite projections; the backup unit (SPEC §7). */
  dataDir: string;
  /** HTTP port for the Fastify daemon. */
  port: number;
  /** Bind host. */
  host: string;
  /** Validated listener boundary reported by readiness and operator UI. */
  networkSecurity: NetworkSecurityPostureDto;
  /** Exact browser-facing origins admitted through an operator-controlled proxy. */
  operatorOrigins: string[];
  /** NODE_ENV passthrough. */
  nodeEnv: string;
}

/**
 * The auto-detected default data dir when PONDEROSA_DATA_DIR is unset.
 * Decision (CONTRACTS.md): `~/.ponderosa` on every OS — matches the systemd unit
 * in SPEC §10 and keeps the "one greppable, portable dir" property (SPEC §7).
 * Honors XDG_DATA_HOME when set (Linux convention) for a nicer default there.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  if (xdg && xdg.trim() !== "") {
    return path.join(xdg, "ponderosa");
  }
  return path.join(os.homedir(), ".ponderosa");
}

function configuredOperatorOrigins(
  value: string | undefined,
): string[] {
  if (!value?.trim()) return [];
  return [...new Set(value.split(",").map((item) => {
    const origin = new URL(item.trim());
    if (!/^https?:$/u.test(origin.protocol) || origin.username || origin.password ||
        origin.pathname !== "/" || origin.search || origin.hash) {
      throw new Error("PONDEROSA_OPERATOR_ORIGINS must contain comma-separated HTTP(S) origins");
    }
    return origin.origin;
  }))];
}

export function resolveNetworkSecurity(env: NodeJS.ProcessEnv = process.env): {
  host: string;
  operatorOrigins: string[];
  posture: NetworkSecurityPostureDto;
} {
  const host = env.PONDEROSA_HOST?.trim() || "127.0.0.1";
  return {
    host,
    operatorOrigins: configuredOperatorOrigins(env.PONDEROSA_OPERATOR_ORIGINS),
    posture: {
      mode: "trusted_network",
      bindHost: host,
      authenticationRequired: false,
      detail: "Ponderosa trusts the host network. Remote access is managed by the user; browser origin checks remain enabled.",
    },
  };
}

/** Load configuration from the environment, applying defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PonderosaConfig {
  const dataDir =
    env.PONDEROSA_DATA_DIR && env.PONDEROSA_DATA_DIR.trim() !== ""
      ? path.resolve(env.PONDEROSA_DATA_DIR)
      : defaultDataDir(env);

  const port = Number(env.PONDEROSA_PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PONDEROSA_PORT: ${env.PONDEROSA_PORT}`);
  }
  const network = resolveNetworkSecurity(env);
  return {
    dataDir,
    port,
    host: network.host,
    operatorOrigins: network.operatorOrigins,
    networkSecurity: network.posture,
    nodeEnv: env.NODE_ENV ?? "development",
  };
}
