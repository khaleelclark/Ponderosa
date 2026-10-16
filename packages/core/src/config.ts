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
  /** Disabled by default; exposes the bounded explicit memory host layer. */
  memoryEnabled: boolean;
  /** HTTP port for the Fastify daemon. */
  port: number;
  /** Bind host. */
  host: string;
  /** Normalized optional bearer token. Never expose this value through status APIs. */
  authToken?: string;
  /** Validated listener boundary reported by readiness and operator UI. */
  networkSecurity: NetworkSecurityPostureDto;
  /** Exact browser-facing origins admitted through an operator-controlled proxy. */
  operatorOrigins: string[];
  /** Exact identities admitted by the trusted reverse proxy. */
  operatorIdentities: string[];
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

/** Only an exact RFC1918 IPv4 listener may opt into passwordless LAN access. */
function isPrivateLanAddress(host: string): boolean {
  if (isIP(host) !== 4) return false;
  const [first, second] = host.split(".").map(Number);
  return first === 10 || (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168);
}

function strictBoolean(name: string, value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return false;
  if (value.trim().toLowerCase() === "true") return true;
  throw new Error(`${name} must be exactly true when enabled`);
}

function configuredOperatorOrigins(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  if (!value?.trim()) return [];
  const unsafeDevelopmentHttp = strictBoolean(
    "PONDEROSA_ALLOW_UNSAFE_HTTP_ORIGINS",
    env.PONDEROSA_ALLOW_UNSAFE_HTTP_ORIGINS,
  );
  return [...new Set(value.split(",").map((item) => {
    const origin = new URL(item.trim());
    if (!/^https?:$/u.test(origin.protocol) || origin.username || origin.password ||
        origin.pathname !== "/" || origin.search || origin.hash) {
      throw new Error("PONDEROSA_OPERATOR_ORIGINS must contain comma-separated HTTP(S) origins");
    }
    if (origin.protocol === "http:" &&
        (env.NODE_ENV === "production" || !unsafeDevelopmentHttp || !isLoopbackHost(origin.hostname))) {
      throw new Error("HTTP operator origins require an explicit unsafe-development opt-in and a literal loopback host");
    }
    return origin.origin;
  }))];
}

function configuredOperatorIdentities(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const identities = [...new Set(value.split(",")
    .map((item) => item.trim().toLocaleLowerCase())
    .filter(Boolean))];
  if (identities.some((identity) => identity.length > 320 || /[\r\n\0]/u.test(identity))) {
    throw new Error("PONDEROSA_OPERATOR_IDENTITIES contains an invalid identity");
  }
  return identities;
}

export function resolveNetworkSecurity(env: NodeJS.ProcessEnv = process.env): {
  host: string;
  authToken?: string;
  operatorOrigins: string[];
  operatorIdentities: string[];
  posture: NetworkSecurityPostureDto;
} {
  const host = env.PONDEROSA_HOST?.trim() || "127.0.0.1";
  const authToken = env.PONDEROSA_AUTH_TOKEN?.trim() || undefined;
  const trustedTailnet = strictBoolean("PONDEROSA_TRUSTED_TAILNET", env.PONDEROSA_TRUSTED_TAILNET);
  const trustedLan = strictBoolean("PONDEROSA_TRUSTED_LAN", env.PONDEROSA_TRUSTED_LAN);
  const operatorOrigins = configuredOperatorOrigins(env.PONDEROSA_OPERATOR_ORIGINS, env);
  const operatorIdentities = configuredOperatorIdentities(env.PONDEROSA_OPERATOR_IDENTITIES);
  const trustedReverseProxy = strictBoolean(
    "PONDEROSA_TRUSTED_REVERSE_PROXY",
    env.PONDEROSA_TRUSTED_REVERSE_PROXY,
  );
  if (trustedReverseProxy && operatorOrigins.length === 0) {
    throw new Error("PONDEROSA_TRUSTED_REVERSE_PROXY requires PONDEROSA_OPERATOR_ORIGINS");
  }
  if (trustedReverseProxy && operatorIdentities.length === 0) {
    throw new Error("PONDEROSA_TRUSTED_REVERSE_PROXY requires PONDEROSA_OPERATOR_IDENTITIES");
  }
  if (trustedReverseProxy && (!authToken || authToken.length < 32)) {
    throw new Error("PONDEROSA_TRUSTED_REVERSE_PROXY requires a high-entropy PONDEROSA_AUTH_TOKEN of at least 32 characters");
  }
  if (operatorIdentities.length > 0 && !trustedReverseProxy) {
    throw new Error("PONDEROSA_OPERATOR_IDENTITIES requires PONDEROSA_TRUSTED_REVERSE_PROXY=true");
  }
  if (operatorOrigins.length > 0 && !authToken && !trustedReverseProxy) {
    throw new Error("PONDEROSA_OPERATOR_ORIGINS requires PONDEROSA_AUTH_TOKEN or PONDEROSA_TRUSTED_REVERSE_PROXY=true");
  }
  if (trustedTailnet && !isTailscaleAddress(host)) {
    throw new Error("PONDEROSA_TRUSTED_TAILNET requires PONDEROSA_HOST to be a literal Tailscale IPv4 (100.64.0.0/10) or IPv6 (fd7a:115c:a1e0::/48) address");
  }
  if (trustedLan && !isPrivateLanAddress(host)) {
    throw new Error("PONDEROSA_TRUSTED_LAN requires PONDEROSA_HOST to be one literal RFC1918 private IPv4 address");
  }
  if (isLoopbackHost(host)) {
    if (operatorOrigins.length > 0) {
      return {
        host,
        operatorOrigins,
        operatorIdentities,
        ...(authToken ? { authToken } : {}),
        posture: {
          mode: "reverse_proxy",
          bindHost: host,
          authenticationRequired: true,
          detail: `Operator access is published through ${operatorOrigins.length} configured origin(s) and requires both an allowed proxy identity and backend bearer-backed browser session.`,
        },
      };
    }
    return {
      host,
      operatorOrigins: [],
      operatorIdentities: [],
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
      operatorOrigins,
      operatorIdentities,
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
      operatorOrigins,
      operatorIdentities,
      posture: {
        mode: "trusted_tailnet",
        bindHost: host,
        authenticationRequired: false,
        detail: "The listener is restricted to one literal Tailscale address.",
        warning: "Trusted-tailnet peers have full operator access to Ponderosa and its host-authority Agents.",
      },
    };
  }
  if (trustedLan) {
    return {
      host,
      operatorOrigins,
      operatorIdentities,
      posture: {
        mode: "trusted_lan",
        bindHost: host,
        authenticationRequired: false,
        detail: "Passwordless operator access is explicitly enabled on this private LAN address.",
        warning: "Peers allowed to reach this address have full operator access to Ponderosa and its host-authority Agents.",
      },
    };
  }
  throw new Error("Non-loopback PONDEROSA_HOST requires PONDEROSA_AUTH_TOKEN, PONDEROSA_TRUSTED_TAILNET=true with a literal Tailscale address, or PONDEROSA_TRUSTED_LAN=true with a literal private IPv4 address");
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
    memoryEnabled: env.PONDEROSA_MEMORY_ENABLED === "true",
    port,
    host: network.host,
    ...(network.authToken ? { authToken: network.authToken } : {}),
    operatorOrigins: network.operatorOrigins,
    operatorIdentities: network.operatorIdentities,
    networkSecurity: network.posture,
    nodeEnv: env.NODE_ENV ?? "development",
  };
}
