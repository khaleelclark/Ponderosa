import { promises as dns } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { VerifiedCitationDto } from "@ponderosa/core";

const nonPublicFaviconAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) nonPublicFaviconAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64],
  ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) nonPublicFaviconAddresses.addSubnet(network, prefix, "ipv6");

function externalFaviconTarget(raw: string): URL | undefined {
  let target: URL;
  try { target = new URL(raw); } catch { return undefined; }
  const hostname = target.hostname.toLowerCase();
  if (target.protocol !== "https:" || target.username || target.password || (target.port && target.port !== "443")
    || !hostname || hostname === "localhost" || hostname.endsWith(".local") || isIP(hostname)) return undefined;
  return new URL(`https://${hostname}/favicon.ico`);
}

async function loadExternalFavicon(target: URL): Promise<{ body: Buffer; mediaType: string }> {
  const addresses = await dns.lookup(target.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address, family }) => nonPublicFaviconAddresses.check(address, family === 6 ? "ipv6" : "ipv4"))) {
    throw new Error("favicon host does not resolve exclusively to public addresses");
  }
  const selected = addresses[0]!;
  return await new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:", hostname: target.hostname, port: 443, path: "/favicon.ico", method: "GET",
      servername: target.hostname,
      headers: { accept: "image/png,image/x-icon,image/vnd.microsoft.icon,image/gif,image/webp,image/jpeg", "user-agent": "Ponderosa favicon fetch" },
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
    }, (response) => {
      const mediaType = (response.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
      const allowed = new Set(["image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/gif", "image/webp", "image/jpeg"]);
      if (response.statusCode !== 200 || !allowed.has(mediaType)) {
        response.resume();
        reject(new Error("favicon response was unavailable or unsafe"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) request.destroy(new Error("favicon exceeds 64 KiB"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({ body: Buffer.concat(chunks), mediaType }));
      response.on("error", reject);
    });
    request.setTimeout(5_000, () => request.destroy(new Error("favicon request timed out")));
    request.on("error", reject);
    request.end();
  });
}

export function normalizeExternalCitations(value: unknown, verifiedAt = new Date().toISOString()): VerifiedCitationDto[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw new Error("citations must be an array of at most 10 sources");
  const result = new Map<string, VerifiedCitationDto>();
  for (const item of value) {
    const source = item as { url?: unknown; title?: unknown };
    const title = typeof source?.title === "string" ? source.title.trim().replace(/\s+/g, " ") : "";
    if (!title || title.length > 240 || typeof source?.url !== "string" || source.url.length > 2048) {
      throw new Error("each citation requires a URL and a title of at most 240 characters");
    }
    let url: URL;
    try { url = new URL(source.url); } catch { throw new Error("citation URL is invalid"); }
    const hostname = url.hostname.toLowerCase();
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || hostname === "localhost" || hostname.endsWith(".local") || /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fc|fd)/i.test(hostname)) {
      throw new Error("citation URL must be an external HTTP(S) address without credentials");
    }
    url.hash = "";
    result.set(url.toString(), { url: url.toString(), title, verifiedAt });
  }
  return [...result.values()];
}

export {
  externalFaviconTarget,
  loadExternalFavicon,
};
