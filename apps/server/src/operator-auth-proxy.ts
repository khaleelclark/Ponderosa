import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { existsSync, lstatSync, mkdirSync, chmodSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Optional, host-local bridge for identity-aware proxies that cannot inject a
 * backend credential themselves. The public proxy must connect to this private
 * Unix socket, overwrite the configured identity header, and never expose the
 * Ponderosa listener directly. It is not a browser credential issuer.
 */
export interface OperatorAuthProxyOptions {
  socketPath: string;
  backendPort: number;
  backendToken: string;
  identityHeader: string;
  allowedIdentities: readonly string[];
}

const hopByHop = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function forwardedHeaders(headers: IncomingHttpHeaders, backendToken: string): IncomingHttpHeaders {
  const removed = new Set([...hopByHop, "authorization"]);
  const connection = headers.connection;
  if (typeof connection === "string") {
    for (const name of connection.split(",")) removed.add(name.trim().toLowerCase());
  }
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!removed.has(name)) forwarded[name] = value;
  }
  forwarded.authorization = `Bearer ${backendToken}`;
  return forwarded;
}

export function createOperatorAuthProxy(options: OperatorAuthProxyOptions): Server {
  if (!isAbsolute(options.socketPath)) throw new Error("proxy socket path must be absolute");
  if (!Number.isInteger(options.backendPort) || options.backendPort < 1 || options.backendPort > 65_535) {
    throw new Error("proxy backend port is invalid");
  }
  if (options.backendToken.length < 32) throw new Error("proxy backend token must have at least 32 characters");
  const identityHeader = options.identityHeader.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/u.test(identityHeader) || ["authorization", "host", "cookie"].includes(identityHeader)) {
    throw new Error("proxy identity header is invalid");
  }
  const allowed = new Set(options.allowedIdentities.map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0) throw new Error("proxy requires at least one allowed identity");

  return createServer((incoming, response) => {
    const asserted = incoming.headers[identityHeader];
    const identity = typeof asserted === "string" ? asserted.trim().toLowerCase() : "";
    if (!allowed.has(identity)) {
      response.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end('{"error":"operator identity required"}');
      return;
    }
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port: options.backendPort,
      path: incoming.url,
      method: incoming.method,
      headers: forwardedHeaders(incoming.headers, options.backendToken),
    }, (result) => {
      const headers: IncomingHttpHeaders = {};
      for (const [name, value] of Object.entries(result.headers)) {
        if (!hopByHop.has(name)) headers[name] = value;
      }
      response.writeHead(result.statusCode ?? 502, headers);
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

export async function listenOperatorAuthProxy(options: OperatorAuthProxyOptions): Promise<Server> {
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
    identityHeader: process.env.PONDEROSA_PROXY_IDENTITY_HEADER ?? "",
    allowedIdentities: (process.env.PONDEROSA_PROXY_ALLOWED_IDENTITIES ?? process.env.PONDEROSA_OPERATOR_IDENTITIES ?? "").split(","),
  };
  const server = await listenOperatorAuthProxy(options);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => server.close(() => {
      try { unlinkSync(options.socketPath); } catch { /* Node may already have removed it. */ }
      process.exit(0);
    }));
  }
}
