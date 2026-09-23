import { randomBytes, createHash } from "node:crypto";
import { connect } from "node:net";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

const DESKTOP_PATH = "/api/hosted-browser/desktop";
const MAX_BUFFER = 4 * 1024 * 1024;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Operator-authorized, single-use capabilities. No client-supplied destinations. */
export function createHostedDesktopAccess(server: Server) {
  const grants = new Map<string, { origin: string; expires: number; resolveSocket(): string }>();
  const connections = new Set<() => void>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, handleProtocols: () => "binary" });
  const prune = () => { for (const [key, grant] of grants) if (grant.expires <= Date.now()) grants.delete(key); };
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url?.split("?")[0] !== DESKTOP_PATH) return;
    const reject = () => { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); };
    if (request.url !== DESKTOP_PATH || request.method !== "GET") return reject();
    prune();
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
    const capability = protocols.find(value => /^ponderosa\.[A-Za-z0-9_-]{43}$/.test(value));
    if (!capability || !protocols.includes("binary")) return reject();
    const key = digest(capability), grant = grants.get(key);
    if (!grant || request.headers.origin !== grant.origin) return reject();
    grants.delete(key);
    let socketPath: string;
    try { socketPath = grant.resolveSocket(); } catch { return reject(); }
    wss.handleUpgrade(request, socket, head, client => {
      const desktop = connect(socketPath);
      let ended = false;
      const close = () => {
        if (ended) return;
        ended = true; clearInterval(check); connections.delete(close);
        desktop.destroy(); client.terminate();
      };
      const valid = () => {
        try { if (grant.resolveSocket() === socketPath) return true; } catch { /* revoked */ }
        close(); return false;
      };
      const check = setInterval(valid, 250);
      check.unref(); connections.add(close);
      desktop.on("error", close); desktop.on("close", close);
      client.on("error", close); client.on("close", close);
      desktop.on("data", data => {
        if (!valid()) return;
        if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > MAX_BUFFER) return close();
        client.send(data, { binary: true });
      });
      client.on("message", (data, binary) => {
        if (!binary || !valid() || desktop.writableLength > MAX_BUFFER) return close();
        desktop.write(Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data));
      });
    });
  };
  server.on("upgrade", upgrade);
  return {
    issue(origin: string, resolveSocket: () => string) {
      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) throw new Error("Invalid desktop origin");
      resolveSocket(); prune();
      if (grants.size >= 256) throw new Error("Too many pending desktop connections");
      const protocol = `ponderosa.${randomBytes(32).toString("base64url")}`;
      grants.set(digest(protocol), { origin, expires: Date.now() + 30_000, resolveSocket });
      return { path: DESKTOP_PATH, protocol };
    },
    close() {
      server.off("upgrade", upgrade); grants.clear();
      for (const close of connections) close();
      wss.close();
    },
  };
}
