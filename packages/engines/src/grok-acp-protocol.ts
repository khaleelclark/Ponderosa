import type { JsonRpcNotification, JsonRpcProcess } from "./json-rpc-process.js";

/** Internal candidate protocol only. These are advertisements, not entitlement
 * or Adapter capabilities. No provider registration or model turn exists here. */
export interface GrokAcpAdvertisement {
  protocolVersion: 1;
  advertisedAgentVersion: string;
  advertisedAuthMethodIds: string[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function uniqueIdentifiers(rows: unknown, key: string): string[] {
  if (!Array.isArray(rows) || rows.length > 128) throw new Error("invalid Grok ACP advertisement list");
  const ids = rows.map(row => object(row)?.[key]);
  if (!ids.every(identifier) || new Set(ids).size !== ids.length) {
    throw new Error("invalid or duplicate Grok ACP advertisement identifier");
  }
  return ids;
}

/** Decode only fields witnessed in the pinned 1.0.46 initialization capture.
 * Deliberately discard account, host, model, command and policy metadata. */
export function decodeGrokAcpInitialization(value: unknown): GrokAcpAdvertisement {
  const result = object(value);
  const meta = object(result?._meta);
  if (result?.protocolVersion !== 1 || !object(result.agentCapabilities) ||
      !identifier(meta?.agentVersion)) throw new Error("invalid Grok ACP initialization");
  return {
    protocolVersion: 1,
    advertisedAgentVersion: meta.agentVersion,
    advertisedAuthMethodIds: uniqueIdentifiers(result.authMethods, "id"),
  };
}

/** Use the established transport's request/error/correlation path. Unlike the
 * Codex initializer, the captured ACP exchange sends no initialized notice.
 * The caller owns the bounded transport, abort deadline and cleanup handle. */
export async function initializeGrokAcpProtocol(rpc: JsonRpcProcess): Promise<GrokAcpAdvertisement> {
  return decodeGrokAcpInitialization(await rpc.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "ponderosa-stage0-inert", version: "0" },
  }));
}

/** Configured names only. The captured stub never launched, so this cannot
 * establish initialized/usable tools, an allowlist, or restriction enforcement. */
export function decodeGrokAcpMcpInventory(notification: JsonRpcNotification): string[] | undefined {
  if (notification.method !== "_x.ai/mcp/servers_updated") return undefined;
  return uniqueIdentifiers(object(notification.params)?.mcpServers, "name");
}
