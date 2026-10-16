import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Readable, Transform } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { CreateLinkPreviewRequest, LinkPreviewDto } from "@ponderosa/core";
import type { AgentStore } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import { externalFaviconTarget, loadExternalFavicon } from "./external-content.js";
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
    if (!project || !agent || agent.projectId !== project.id || !active ||
      !ownsActiveRun(agent.id, active) || active.runId !== registration.runId || active.executionId !== registration.runId) return false;
    if (!registration.conversationId) return true;
    const conversation = store.getConversation(registration.conversationId);
    return Boolean(conversation && conversation.projectId === project.id && agent.conversationId === conversation.id);
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

  const registerRoutes = (app: FastifyInstance): void => {
  app.get<{ Querystring: { url?: string } }>("/api/link-favicon", async (request, reply) => {
    const target = externalFaviconTarget(request.query.url ?? "");
    if (!target) return reply.code(400).send({ error: "favicon URL must be a public HTTPS hostname" });
    try {
      const favicon = await loadExternalFavicon(target);
      reply.type(favicon.mediaType);
      reply.header("cache-control", "public, max-age=3600");
      return reply.send(favicon.body);
    } catch {
      // Failures are safe to cache briefly, which bounds repeated DNS/TLS work
      // without turning a transient outage into a long-lived missing icon.
      reply.header("cache-control", "public, max-age=60");
      return reply.code(404).send({ error: "favicon unavailable" });
    }
  });

  const loopbackPreviewTarget = (raw: string): URL | undefined => {
    let target: URL;
    try { target = new URL(raw); } catch { return undefined; }
    const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (target.protocol !== "http:" || target.username || target.password || !target.port) return undefined;
    if (!(hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1")) return undefined;
    const port = Number(target.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    target.hostname = "127.0.0.1";
    target.hash = "";
    return target;
  };

  app.post<{ Body: CreateLinkPreviewRequest }>("/api/link-previews", async (request, reply) => {
    const target = loopbackPreviewTarget(request.body?.url);
    if (!target) return reply.code(400).send({ error: "preview URL must be HTTP on an explicit localhost port" });
    const { projectId, agentId, runId, conversationId } = request.body ?? {};
    const project = typeof projectId === "string" ? store.getProject(projectId) : undefined;
    const agent = typeof agentId === "string" ? store.getAgent(agentId) : undefined;
    const active = agent ? activeRuns.get(agent.id) : undefined;
    if (!project || !agent || agent.projectId !== project.id || !active || !ownsActiveRun(agent.id, active) ||
      active.runId !== runId || active.executionId !== runId) {
      return reply.code(409).send({ error: "preview scope does not match an active agent run" });
    }
    if (conversationId !== undefined) {
      const conversation = store.getConversation(conversationId);
      if (!conversation || conversation.projectId !== project.id || agent.conversationId !== conversation.id) {
        return reply.code(409).send({ error: "preview conversation is not owned by this agent and project" });
      }
    }
    for (const [key, registration] of linkPreviews) if (registration.expiresAt <= Date.now()) closeLinkPreviewRegistration(key, 1008, "preview expired");
    const id = randomUUID();
    const expiresAt = Date.now() + linkPreviewTtlMs;
    linkPreviews.set(id, {
      origin: target.origin,
      expiresAt,
      projectId,
      agentId,
      runId,
      ...(conversationId ? { conversationId } : {}),
      connections: new Set(),
      httpConnections: new Set(),
      reconnectAttempts: [],
    });
    const suffix = `${target.pathname}${target.search}`.replace(/^\//, "");
    return {
      id,
      openUrl: `/api/link-previews/${id}/${suffix}`,
      targetOrigin: target.origin,
      expiresAt: new Date(expiresAt).toISOString(),
    } satisfies LinkPreviewDto;
  });

  app.get<{ Params: { id: string; "*": string }; Querystring: Record<string, string> }>("/api/link-previews/:id/*", async (request, reply) => {
    const registration = linkPreviews.get(request.params.id);
    if (!registration || registration.expiresAt <= Date.now()) {
      closeLinkPreviewRegistration(request.params.id, 1008, "preview expired");
      return reply.code(404).send({ error: "preview expired or was not found" });
    }
    if (!linkPreviewOwned(registration)) {
      closeLinkPreviewRegistration(request.params.id, 1008, "preview run is no longer active");
      return reply.code(404).send({ error: "preview run is no longer active" });
    }
    const previewPath = request.params["*"] ?? "";
    if (previewPath === "__ws" || previewPath.startsWith("__ws/")) {
      return reply.code(426).header("upgrade", "websocket").send({ error: "this preview path requires a WebSocket upgrade" });
    }
    const relativePath = `/${previewPath}`;
    const target = new URL(relativePath, registration.origin);
    target.search = new URL(request.raw.url ?? "", "http://ponderosa.invalid").search;
    if (target.origin !== registration.origin) return reply.code(403).send({ error: "preview target is outside its registered origin" });
    if (registration.httpConnections.size >= linkPreviewMaxHttpPerRegistration) {
      return reply.code(429).send({ error: "preview HTTP connection limit reached" });
    }
    let upstream: Response;
    const upstreamController = new AbortController();
    registration.httpConnections.add(upstreamController);
    let httpReleased = false;
    const releaseHttp = (abort = false) => {
      if (httpReleased) return;
      httpReleased = true;
      registration.httpConnections.delete(upstreamController);
      if (abort) upstreamController.abort();
      reply.raw.off("close", onClientClose);
    };
    const onClientClose = () => releaseHttp(true);
    reply.raw.once("close", onClientClose);
    const handshakeTimer = setTimeout(() => upstreamController.abort(), 15_000);
    handshakeTimer.unref?.();
    try {
      upstream = await fetch(target, {
        redirect: "manual",
        headers: { accept: request.headers.accept ?? "*/*", "user-agent": "Ponderosa localhost preview" },
        signal: upstreamController.signal,
      });
    } catch {
      clearTimeout(handshakeTimer);
      releaseHttp();
      return reply.code(502).send({ error: "localhost app is unavailable" });
    }
    clearTimeout(handshakeTimer);
    const location = upstream.headers.get("location");
    if (location) {
      const redirected = new URL(location, target);
      if (redirected.origin !== registration.origin) {
        await upstream.body?.cancel().catch(() => undefined);
        releaseHttp();
        return reply.code(502).send({ error: "localhost app redirected outside its registered origin" });
      }
      reply.header("location", `/api/link-previews/${request.params.id}${redirected.pathname}${redirected.search}`);
    }
    reply.code(upstream.status);
    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    reply.type(contentType);
    reply.header("cache-control", "no-store");
    if (!upstream.body) {
      releaseHttp();
      return reply.send();
    }
    if (contentType.includes("text/html")) {
      const contentLength = Number(upstream.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > 5_000_000) {
        await upstream.body.cancel().catch(() => undefined);
        releaseHttp();
        return reply.code(413).send({ error: "preview document is too large" });
      }
      const reader = upstream.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > 5_000_000) {
            await reader.cancel().catch(() => undefined);
            releaseHttp();
            return reply.code(413).send({ error: "preview document is too large" });
          }
          chunks.push(value);
        }
      } catch {
        releaseHttp();
        return reply.code(502).send({ error: "localhost app closed the preview response" });
      }
      releaseHttp();
      const html = Buffer.concat(chunks).toString("utf8");
      const prefix = `/api/link-previews/${request.params.id}`;
      const base = `<base href="${prefix}${new URL(".", target).pathname}">`;
      const registrationOrigin = new URL(registration.origin);
      const bootstrap = `<script>(()=>{const N=window.WebSocket,A=new Set(["vite-hmr","vite-ping"]),H=${JSON.stringify(registrationOrigin.hostname)},P=${JSON.stringify(registrationOrigin.port)},X=${JSON.stringify(`${prefix}/__ws`)},Z=h=>h.replace(/^\\[|\\]$/g,""),C=Z(location.hostname),L=location.port||(location.protocol==="https:"?"443":"80");let W;W=new Proxy(N,{construct(T,a,n){try{const ps=typeof a[1]==="string"?[a[1]]:Array.isArray(a[1])?a[1]:[],u=new URL(String(a[0]),document.baseURI),h=Z(u.hostname),p=u.port||(u.protocol==="wss:"?"443":"80"),v=ps.length===1&&A.has(ps[0]),o=(h===H&&p===P)||(h===C&&p===L),x=u.pathname===X||u.pathname.startsWith(X+"/");if(v&&o&&!x&&!u.username&&!u.password&&!u.hash&&(u.protocol==="ws:"||u.protocol==="wss:"))a[0]=(location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+X+u.pathname+u.search}catch{}return Reflect.construct(T,a,n===W?T:n)}});window.WebSocket=W})();</script>`;
      // Root-relative asset references otherwise escape the opaque proxy scope.
      const scopedHtml = html.replace(/\b(src|href|action)=(['"])\/(?!\/)/gi, `$1=$2${prefix}/`);
      return reply.send(/<head(?:\s[^>]*)?>/i.test(scopedHtml) ? scopedHtml.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${base}${bootstrap}`) : `${base}${bootstrap}${scopedHtml}`);
    }
    const source = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream, { highWaterMark: 64 * 1024 });
    source.once("end", () => releaseHttp());
    source.once("close", () => releaseHttp());
    source.once("error", () => releaseHttp());
    if (contentType.includes("text/event-stream")) return reply.send(source);
    let streamedBytes = 0;
    const bounded = new Transform({
      highWaterMark: 64 * 1024,
      transform(chunk: Buffer, _encoding, callback) {
        streamedBytes += chunk.byteLength;
        if (streamedBytes > 50 * 1024 * 1024) {
          upstreamController.abort();
          callback(new Error("preview response exceeded 50 MiB"));
          return;
        }
        callback(null, chunk);
      },
    });
    return reply.send(source.pipe(bounded));
  });

  app.delete<{ Params: { id: string } }>("/api/link-previews/:id", async (request, reply) => {
    const registration = linkPreviews.get(request.params.id);
    if (!registration) return reply.code(404).send({ error: "preview was not found" });
    closeLinkPreviewRegistration(request.params.id, 1001, "preview explicitly closed");
    return { closed: true };
  });
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
    registerRoutes,
  };
}
