import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { existsSync, lstatSync, mkdirSync, chmodSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Optional, host-local bridge for identity-aware proxies that cannot inject a
 * backend credential themselves. The public proxy must connect to this private
 * Unix socket, overwrite the configured identity header, and never expose the
 * Ponderosa listener directly. It binds Ponderosa's canonical identity header
 * to that verified identity; it is not a browser credential issuer.
 */
export interface OperatorAuthProxyOptions {
  socketPath: string;
  backendPort: number;
  backendToken: string;
  publicOrigin: string;
  identityHeader: string;
  allowedIdentities: readonly string[];
}

export interface OperatorAuthProxyServer extends Server {
  closeUpgrades(): void;
}

const hopByHop = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function forwardedHeaders(headers: IncomingHttpHeaders, backendToken: string, publicHost: string, identityHeader: string, identity: string): IncomingHttpHeaders {
  const removed = new Set([...hopByHop, "authorization", "tailscale-user-login", identityHeader]);
  const connection = headers.connection;
  if (typeof connection === "string") {
    for (const name of connection.split(",")) removed.add(name.trim().toLowerCase());
  }
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!removed.has(name)) forwarded[name] = value;
  }
  forwarded.authorization = `Bearer ${backendToken}`;
  // Never trust a second client-supplied identity. The backend reads this
  // canonical header regardless of which upstream identity header was used.
  forwarded["tailscale-user-login"] = identity;
  // Some front proxies (including Tailscale Serve for Unix targets) rewrite
  // Host to localhost. The configured public origin, not a forwarded claim,
  // is authoritative for Ponderosa's Host/Origin mutation check.
  forwarded.host = publicHost;
  return forwarded;
}

export function createOperatorAuthProxy(options: OperatorAuthProxyOptions): OperatorAuthProxyServer {
  if (!isAbsolute(options.socketPath)) throw new Error("proxy socket path must be absolute");
  if (!Number.isInteger(options.backendPort) || options.backendPort < 1 || options.backendPort > 65_535) {
    throw new Error("proxy backend port is invalid");
  }
  if (options.backendToken.length < 32) throw new Error("proxy backend token must have at least 32 characters");
  let publicOrigin: URL;
  try { publicOrigin = new URL(options.publicOrigin); }
  catch { throw new Error("proxy public origin must be an exact HTTPS origin"); }
  if (publicOrigin.protocol !== "https:" || publicOrigin.origin !== options.publicOrigin ||
      publicOrigin.username || publicOrigin.password) {
    throw new Error("proxy public origin must be an exact HTTPS origin");
  }
  const identityHeader = options.identityHeader.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/u.test(identityHeader) || ["authorization", "host", "cookie"].includes(identityHeader)) {
    throw new Error("proxy identity header is invalid");
  }
  const allowed = new Set(options.allowedIdentities.map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0) throw new Error("proxy requires at least one allowed identity");

  const checkedIdentity = (headers: IncomingHttpHeaders): string | 401 | 421 => {
    const asserted = headers[identityHeader];
    const identity = typeof asserted === "string" ? asserted.trim().toLowerCase() : "";
    if (!allowed.has(identity)) return 401;
    const forwardedHost = headers["x-forwarded-host"];
    if (forwardedHost !== undefined && forwardedHost !== publicOrigin.host) return 421;
    return identity;
  };

  const upgradedSockets = new Set<Duplex>();
  const server = createServer((incoming, response) => {
    const identity = checkedIdentity(incoming.headers);
    if (typeof identity === "number") {
      response.writeHead(identity, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(identity === 401 ? '{"error":"operator identity required"}' : '{"error":"unrecognized proxy host"}');
      return;
    }
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port: options.backendPort,
      path: incoming.url,
      method: incoming.method,
      headers: forwardedHeaders(incoming.headers, options.backendToken, publicOrigin.host, identityHeader, identity),
    }, (result) => {
      const headers: IncomingHttpHeaders = {};
      for (const [name, value] of Object.entries(result.headers)) {
        if (!hopByHop.has(name)) headers[name] = value;
      }
      response.writeHead(result.statusCode ?? 502, headers);
      // A killed/restarted backend can abort an SSE response without sending
      // its final chunk. pipe() only ends the downstream on a clean "end";
      // close the browser side so EventSource can reconnect and replay.
      result.on("error", () => response.destroy());
      result.once("close", () => {
        if (!result.complete && !response.destroyed) response.destroy();
      });
      result.pipe(response);
    });
    upstream.on("error", () => {
      if (response.headersSent) return response.destroy();
      response.writeHead(502, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end('{"error":"Ponderosa backend unavailable"}');
    });
    incoming.on("aborted", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("upgrade", (incoming, socket, head) => {
    const reject = (status: number) => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 421 ? "Misdirected Request" : status === 404 ? "Not Found" : "Bad Gateway"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const identity = checkedIdentity(incoming.headers);
    if (typeof identity === "number") return reject(identity);
    // These are the only browser WebSocket routes. The backend still validates
    // the one-use desktop ticket or the sandboxed preview capability.
    if (incoming.method !== "GET" || incoming.headers.upgrade?.toLowerCase() !== "websocket" ||
        (incoming.url !== "/api/hosted-browser/desktop" && !incoming.url?.startsWith("/api/link-previews/"))) return reject(404);
    const headers = forwardedHeaders(incoming.headers, options.backendToken, publicOrigin.host, identityHeader, identity);
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
    const upstream = httpRequest({
      hostname: "127.0.0.1", port: options.backendPort, path: incoming.url, method: "GET", headers,
    });
    let peer: Duplex | undefined;
    let upgraded = false;
    const destroy = () => { upstream.destroy(); peer?.destroy(); socket.destroy(); };
    socket.once("error", destroy);
    socket.once("close", () => { upstream.destroy(); peer?.destroy(); upgradedSockets.delete(socket); });
    upstream.setTimeout(10_000, () => upstream.destroy());
    upstream.once("error", () => { if (upgraded) destroy(); else reject(502); });
    upstream.once("response", (response) => {
      response.resume();
      response.once("end", () => reject(response.statusCode ?? 502));
    });
    upstream.once("upgrade", (response, backendSocket, backendHead) => {
      upgraded = true;
      upstream.setTimeout(0);
      peer = backendSocket;
      upgradedSockets.add(socket);
      peer.once("error", destroy);
      peer.once("close", () => socket.destroy());
      const lines = ["HTTP/1.1 101 Switching Protocols"];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (backendHead.length) socket.write(backendHead);
      if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket);
    });
    upstream.end();
  });
  const proxy = server as OperatorAuthProxyServer;
  proxy.closeUpgrades = () => { for (const socket of upgradedSockets) socket.destroy(); };
  return proxy;
}

function prepareSocket(path: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = statSync(parent);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 ||
      (process.getuid && directory.uid !== process.getuid())) {
    throw new Error("proxy socket directory must be private and owned by the service user");
  }
  if (existsSync(path)) {
    const current = lstatSync(path);
    if (!current.isSocket() || (process.getuid && current.uid !== process.getuid())) {
      throw new Error("proxy socket path is occupied by a foreign object");
    }
    // A stale socket may remain after a hard kill. Refuse to displace a live
    // listener; the private directory prevents another host user from racing it.
    throw new Error("proxy socket already exists; stop its owner before restarting");
  }
}

export async function listenOperatorAuthProxy(options: OperatorAuthProxyOptions): Promise<OperatorAuthProxyServer> {
  prepareSocket(options.socketPath);
  const server = createOperatorAuthProxy(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(options.socketPath, 0o600);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options: OperatorAuthProxyOptions = {
    socketPath: process.env.PONDEROSA_PROXY_SOCKET_PATH ?? "",
    backendPort: Number(process.env.PONDEROSA_PROXY_BACKEND_PORT),
    backendToken: process.env.PONDEROSA_PROXY_BACKEND_TOKEN ?? process.env.PONDEROSA_AUTH_TOKEN ?? "",
    publicOrigin: process.env.PONDEROSA_PROXY_PUBLIC_ORIGIN ?? "",
    identityHeader: process.env.PONDEROSA_PROXY_IDENTITY_HEADER ?? "",
    allowedIdentities: (process.env.PONDEROSA_PROXY_ALLOWED_IDENTITIES ?? process.env.PONDEROSA_OPERATOR_IDENTITIES ?? "").split(","),
  };
  const server = await listenOperatorAuthProxy(options);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { server.closeUpgrades(); server.close(() => {
      try { unlinkSync(options.socketPath); } catch { /* Node may already have removed it. */ }
      process.exit(0);
    }); });
  }
}
