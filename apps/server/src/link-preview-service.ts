import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Readable, Transform } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { AgentStore } from "@ponderosa/agents";
import { secretEqual } from "./security.js";
import type {
  ActiveRun,
  CreateServerOptions,
  LinkPreviewRegistration,
  LinkPreviewSocketPair,
} from "./app-contracts.js";

interface LinkPreviewServiceContext {
  options: CreateServerOptions["linkPreviewScheduling"];
  store: AgentStore;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  ownsActiveRun(agentId: string, run: ActiveRun): boolean;
}

export function createLinkPreviewService(context: LinkPreviewServiceContext) {
  const { options, store, activeRuns, ownsActiveRun } = context;

  const linkPreviews = new Map<string, LinkPreviewRegistration>();
  const linkPreviewTtlMs = options?.registrationTtlMs ?? 4 * 60 * 60 * 1000;
  const linkPreviewHandshakeTimeoutMs = options?.upstreamHandshakeTimeoutMs ?? 10_000;
  const linkPreviewHeartbeatMs = options?.heartbeatMs ?? 5_000;
  const linkPreviewMaxPerRegistration = options?.maxConnectionsPerRegistration ?? 8;
  const linkPreviewMaxTotal = options?.maxTotalConnections ?? 32;
  const linkPreviewMaxPayload = options?.maxPayloadBytes ?? 1024 * 1024;
  const linkPreviewMaxBuffered = options?.maxBufferedBytes ?? 2 * 1024 * 1024;
  const linkPreviewMaxPendingFrames = options?.maxPendingFrames ?? 64;
  const linkPreviewMaxHttpPerRegistration = options?.maxHttpConnectionsPerRegistration ?? 64;
  const linkPreviewCloseGraceMs = options?.closeGraceMs ?? 1_000;
  const linkPreviewMaxPathBytes = 4 * 1024;
  const linkPreviewMaxReconnectsPerWindow = options?.maxReconnectsPerWindow ?? 24;
  const linkPreviewReconnectWindowMs = options?.reconnectWindowMs ?? 10_000;
  const linkPreviewMaxIdleMs = options?.maxIdleMs ?? 2 * 60 * 1000;
  const linkPreviewMaxConnectionLifetimeMs = Math.min(linkPreviewTtlMs, 4 * 60 * 60 * 1000);
  const linkPreviewWss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: linkPreviewMaxPayload,
    handleProtocols: (protocols) => protocols.has("vite-hmr") ? "vite-hmr" : protocols.has("vite-ping") ? "vite-ping" : false,
  });

  function linkPreviewOwned(registration: LinkPreviewRegistration): boolean {
    const project = store.getProject(registration.projectId);
    const agent = store.getAgent(registration.agentId);
    const active = agent ? activeRuns.get(agent.id) : undefined;
    if (!project || !agent || agent.archived || agent.projectId !== project.id || !active ||
      !ownsActiveRun(agent.id, active) || active.runId !== registration.runId || active.executionId !== registration.runId) return false;
    if (!registration.conversationId) return true;
    const conversation = store.getConversation(registration.conversationId);
    return Boolean(conversation && conversation.projectId === project.id && agent.conversationIds.includes(conversation.id));
  }

  function closeLinkPreviewPair(pair: LinkPreviewSocketPair, code = 1001, reason = "preview closed"): void {
    if (pair.closing) return;
    pair.closing = true;
    const sockets = [pair.client, pair.upstream];
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.CLOSED) continue;
      try { socket.close(code, reason.slice(0, 123)); } catch { socket.terminate(); }
    }
    const forceClose = setTimeout(() => {
      for (const socket of sockets) {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      }
    }, linkPreviewCloseGraceMs);
    forceClose.unref();
    for (const socket of sockets) {
      socket.once("close", () => {
        if (sockets.every((candidate) => candidate.readyState === WebSocket.CLOSED)) clearTimeout(forceClose);
      });
    }
  }

  function closeLinkPreviewRegistration(id: string, code = 1001, reason = "preview closed"): void {
    const registration = linkPreviews.get(id);
    if (!registration) return;
    linkPreviews.delete(id);
    for (const pair of registration.connections) closeLinkPreviewPair(pair, code, reason);
    registration.connections.clear();
    for (const controller of registration.httpConnections) controller.abort();
    registration.httpConnections.clear();
  }

  function closeLinkPreviewsForAgent(agentId: string, reason: string): void {
    for (const [id, registration] of linkPreviews) {
      if (registration.agentId === agentId) closeLinkPreviewRegistration(id, 1001, reason);
    }
  }

  const rawDataBytes = (data: RawData): number => Array.isArray(data)
    ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
    : data.byteLength;

  const rejectLinkPreviewUpgrade = (socket: Socket, status: 400 | 401 | 403 | 404 | 409 | 429, message: string): void => {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const label = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found"
      : status === 409 ? "Conflict" : status === 429 ? "Too Many Requests" : "Bad Request";
    socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`, () => socket.destroy());
  };

  const linkPreviewUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    const rawTarget = request.url ?? "";
    if (!rawTarget.startsWith("/")) {
      rejectLinkPreviewUpgrade(socket, 400, "absolute-form preview upgrades are forbidden");
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(rawTarget, "http://ponderosa.invalid");
      decodeURI(parsed.pathname);
      decodeURI(parsed.search);
    } catch {
      rejectLinkPreviewUpgrade(socket, 400, "malformed preview upgrade");
      return;
    }
    if (parsed.username || parsed.password || parsed.hash) {
      rejectLinkPreviewUpgrade(socket, 400, "credentialed preview upgrades are forbidden");
      return;
    }
    const match = /^\/api\/link-previews\/([a-f0-9-]{36})\/__ws(\/.*)?$/i.exec(parsed.pathname);
    if (!match) {
      if (parsed.pathname.startsWith("/api/link-previews/")) {
        rejectLinkPreviewUpgrade(socket, 404, "preview capability was not found");
      }
      return;
    }
    const id = match[1]!;
    const relativePath = match[2] || "/";
    const websocketKey = typeof request.headers["sec-websocket-key"] === "string"
      ? request.headers["sec-websocket-key"].trim()
      : "";
    const decodedKey = Buffer.from(websocketKey, "base64");
    if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket" ||
      !request.headers.connection?.toLowerCase().split(",").map((item) => item.trim()).includes("upgrade") ||
      request.headers["sec-websocket-version"] !== "13" || decodedKey.byteLength !== 16 ||
      decodedKey.toString("base64") !== websocketKey || request.headers["content-length"] !== undefined ||
      request.headers["transfer-encoding"] !== undefined) {
      rejectLinkPreviewUpgrade(socket, 400, "malformed preview upgrade");
      return;
    }
    if (request.headers.origin !== "null") {
      rejectLinkPreviewUpgrade(socket, 403, "preview upgrades require the sandboxed preview origin");
      return;
    }
    const protocolHeader = request.headers["sec-websocket-protocol"];
    if (typeof protocolHeader !== "string") {
      rejectLinkPreviewUpgrade(socket, 400, "a Vite preview subprotocol is required");
      return;
    }
    const protocols = protocolHeader.split(",").map((item) => item.trim()).filter(Boolean);
    if (protocols.length !== 1 || (protocols[0] !== "vite-hmr" && protocols[0] !== "vite-ping")) {
      rejectLinkPreviewUpgrade(socket, 400, "unsupported preview WebSocket subprotocol");
      return;
    }
    const queryEntries = [...parsed.searchParams.entries()];
    if (queryEntries.length > 1 || (queryEntries.length === 1 &&
      (queryEntries[0]![0] !== "token" || !/^[A-Za-z0-9._~-]{1,256}$/.test(queryEntries[0]![1])))) {
      rejectLinkPreviewUpgrade(socket, 400, "unsupported preview WebSocket query");
      return;
    }
    if (Buffer.byteLength(relativePath + parsed.search) > linkPreviewMaxPathBytes || relativePath.includes("\\") || /[\r\n\0]/.test(relativePath + parsed.search)) {
      rejectLinkPreviewUpgrade(socket, 400, "preview WebSocket path is invalid or too large");
      return;
    }
    const registration = linkPreviews.get(id);
    if (!registration) {
      rejectLinkPreviewUpgrade(socket, 404, "preview capability was not found");
      return;
    }
    if (registration.expiresAt <= Date.now() || !linkPreviewOwned(registration)) {
      closeLinkPreviewRegistration(id, 1008, "preview capability expired");
      rejectLinkPreviewUpgrade(socket, 404, "preview capability expired");
      return;
    }
    const totalConnections = [...linkPreviews.values()].reduce((total, candidate) => total + candidate.connections.size, 0);
    if (registration.connections.size >= linkPreviewMaxPerRegistration || totalConnections >= linkPreviewMaxTotal) {
      rejectLinkPreviewUpgrade(socket, 429, "preview connection limit reached");
      return;
    }
    const now = Date.now();
    registration.reconnectAttempts = registration.reconnectAttempts.filter((attempt) => now - attempt < linkPreviewReconnectWindowMs);
    if (registration.reconnectAttempts.length >= linkPreviewMaxReconnectsPerWindow) {
      rejectLinkPreviewUpgrade(socket, 429, "preview reconnect limit reached");
      return;
    }
    registration.reconnectAttempts.push(now);
    const target = new URL(`${relativePath}${parsed.search}`, registration.origin);
    if (target.origin !== registration.origin || target.username || target.password) {
      rejectLinkPreviewUpgrade(socket, 403, "preview target is outside its registered origin");
      return;
    }
    target.protocol = "ws:";

    try {
      linkPreviewWss.handleUpgrade(request, socket, head, (client) => {
        const upstream = new WebSocket(target, protocols, {
          followRedirects: false,
          handshakeTimeout: linkPreviewHandshakeTimeoutMs,
          maxPayload: linkPreviewMaxPayload,
          perMessageDeflate: false,
          headers: {
            origin: registration.origin,
            "user-agent": "Ponderosa localhost preview",
          },
        });
        const pair: LinkPreviewSocketPair = {
          client,
          upstream,
          openedAt: Date.now(),
          lastActivityAt: Date.now(),
          clientAlive: true,
          upstreamAlive: true,
        };
        registration.connections.add(pair);
        const pendingClientFrames: Array<{ data: Buffer; isBinary: boolean }> = [];
        let pendingClientBytes = 0;
        const closeBoth = (code = 1001, reason = "preview connection closed") => {
          registration.connections.delete(pair);
          closeLinkPreviewPair(pair, code, reason);
        };
        const forward = (to: WebSocket, data: RawData, isBinary: boolean) => {
          if (!linkPreviewOwned(registration) || registration.expiresAt <= Date.now()) return closeBoth(1008, "preview ownership expired");
          const size = rawDataBytes(data);
          if (size > linkPreviewMaxPayload) return closeBoth(1009, "preview message too large");
          pair.lastActivityAt = Date.now();
          if (to === upstream && to.readyState === WebSocket.CONNECTING) {
            if (pendingClientFrames.length >= linkPreviewMaxPendingFrames || pendingClientBytes + size > linkPreviewMaxBuffered) {
              return closeBoth(1013, "preview handshake buffer limit reached");
            }
            const copy = Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(new Uint8Array(data));
            pendingClientFrames.push({ data: copy, isBinary });
            pendingClientBytes += copy.byteLength;
            return;
          }
          if (to.readyState !== WebSocket.OPEN || to.bufferedAmount + size > linkPreviewMaxBuffered) {
            return closeBoth(1013, "preview backpressure limit reached");
          }
          to.send(data, { binary: isBinary }, (error) => { if (error) closeBoth(1011, "preview forwarding failed"); });
        };
        client.on("message", (data, isBinary) => forward(upstream, data, isBinary));
        upstream.on("message", (data, isBinary) => forward(client, data, isBinary));
        upstream.on("open", () => {
          for (const frame of pendingClientFrames.splice(0)) {
            pendingClientBytes -= frame.data.byteLength;
            if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount + frame.data.byteLength > linkPreviewMaxBuffered) {
              closeBoth(1013, "preview backpressure limit reached");
              return;
            }
            upstream.send(frame.data, { binary: frame.isBinary }, (error) => { if (error) closeBoth(1011, "preview forwarding failed"); });
          }
        });
        client.on("pong", () => { pair.clientAlive = true; pair.lastActivityAt = Date.now(); });
        upstream.on("pong", () => { pair.upstreamAlive = true; pair.lastActivityAt = Date.now(); });
        client.on("close", (code) => closeBoth(code || 1001, "preview client closed"));
        upstream.on("close", (code) => closeBoth(code || 1001, "localhost preview server closed"));
        client.on("error", () => closeBoth(1011, "preview client failed"));
        upstream.on("error", () => closeBoth(1011, "localhost preview server unavailable"));
      });
    } catch {
      rejectLinkPreviewUpgrade(socket, 400, "malformed preview upgrade");
    }
  };

  return {
    closeLinkPreviewPair,
    closeLinkPreviewRegistration,
    closeLinkPreviewsForAgent,
    linkPreviewCloseGraceMs,
    linkPreviewHeartbeatMs,
    linkPreviewMaxConnectionLifetimeMs,
    linkPreviewMaxHttpPerRegistration,
    linkPreviewMaxIdleMs,
    linkPreviewMaxPathBytes,
    linkPreviewOwned,
    linkPreviews,
    linkPreviewTtlMs,
    linkPreviewUpgrade,
    linkPreviewWss,
  };
}
