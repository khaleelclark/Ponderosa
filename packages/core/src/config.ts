// Config loader (SPEC §7). Resolves PONDEROSA_DATA_DIR with a per-OS default.
// Node-only — imported by apps/server, NOT re-exported from the package barrel, so
// the browser bundle (apps/web) never pulls in node built-ins.

import os from "node:os";
import path from "node:path";
import { isIP } from "node:net";
import type { NetworkSecurityPostureDto } from "./dto.js";

/** Resolved runtime configuration for the server and CLI tools. */
export interface PonderosaConfig {
  /** Root of the on-disk event log + SQLite projections; the backup unit (SPEC §7). */
  dataDir: string;
  /** HTTP port for the Fastify daemon. */
  port: number;
  /** Bind host. */
  host: string;
  /** Normalized optional bearer token. Never expose this value through status APIs. */
  authToken?: string;
  /** Validated listener boundary reported by readiness and operator UI. */
  networkSecurity: NetworkSecurityPostureDto;
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

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost") return true;
  if (isIP(normalized) === 4) return Number(normalized.split(".")[0]) === 127;
  return normalizeIpv6(normalized) === "::1";
}

function normalizeIpv6(host: string): string | undefined {
  if (isIP(host) !== 6 || host.includes("%")) return undefined;
  try {
    return new URL(`http://[${host}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
}

/** True only for literal addresses in Tailscale's assigned IPv4/IPv6 ranges. */
export function isTailscaleAddress(host: string): boolean {
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
  }
  const ipv6 = normalizeIpv6(host);
  if (!ipv6) return false;
  const prefix = ipv6.split(":", 3);
  return prefix.length === 3 && prefix[0] === "fd7a" && prefix[1] === "115c" && prefix[2] === "a1e0";
}

function trustedTailnetEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return false;
  if (value.trim().toLowerCase() === "true") return true;
  throw new Error("PONDEROSA_TRUSTED_TAILNET must be exactly true when enabled");
}

export function resolveNetworkSecurity(env: NodeJS.ProcessEnv = process.env): {
  host: string;
  authToken?: string;
  posture: NetworkSecurityPostureDto;
} {
  const host = env.PONDEROSA_HOST?.trim() || "127.0.0.1";
  const authToken = env.PONDEROSA_AUTH_TOKEN?.trim() || undefined;
  const trustedTailnet = trustedTailnetEnabled(env.PONDEROSA_TRUSTED_TAILNET);
  if (trustedTailnet && !isTailscaleAddress(host)) {
    throw new Error("PONDEROSA_TRUSTED_TAILNET requires PONDEROSA_HOST to be a literal Tailscale IPv4 (100.64.0.0/10) or IPv6 (fd7a:115c:a1e0::/48) address");
  }
  if (isLoopbackHost(host)) {
    return {
      host,
      ...(authToken ? { authToken } : {}),
      posture: {
        mode: authToken ? "authenticated" : "loopback",
        bindHost: host,
        authenticationRequired: Boolean(authToken),
        detail: authToken
          ? "Operator API access requires bearer authentication on this loopback listener."
          : "Operator access is limited to clients on this host.",
      },
    };
  }
  if (authToken) {
    return {
      host,
      authToken,
      posture: {
        mode: "authenticated",
        bindHost: host,
        authenticationRequired: true,
        detail: "Operator API access requires bearer authentication on this network listener.",
      },
    };
  }
  if (trustedTailnet && isTailscaleAddress(host)) {
    return {
      host,
      posture: {
        mode: "trusted_tailnet",
        bindHost: host,
        authenticationRequired: false,
        detail: "The listener is restricted to one literal Tailscale address.",
        warning: "Trusted-tailnet peers have full operator access to Ponderosa and its host-authority Agents.",
      },
    };
  }
  throw new Error("Non-loopback PONDEROSA_HOST requires PONDEROSA_AUTH_TOKEN or PONDEROSA_TRUSTED_TAILNET=true with a literal Tailscale address");
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
    ...(network.authToken ? { authToken: network.authToken } : {}),
    networkSecurity: network.posture,
    nodeEnv: env.NODE_ENV ?? "development",
  };
}
