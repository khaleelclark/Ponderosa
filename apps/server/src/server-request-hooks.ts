import type { IncomingMessage } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { ASSET_LIMITS } from "./assets.js";
import {
  type AgentMessageCapability,
  type CreateServerOptions,
} from "./app-contracts.js";
import {
  MAX_OPERATOR_AVATAR_BYTES,
  OPERATOR_AVATAR_MEDIA_TYPES,
} from "./operator-profile-images.js";
import { secretEqual } from "./security.js";
import { isAgentToolRoute } from "./agent-tool-route-classification.js";
import { localBrowserTransportPath } from "./routes/local-browsers.js";
import { browserSessionCookie } from "./launcher-security.js";

/** Purpose, not method, determines whether a user-authored action gets its
 * reserved admission budget. Read-like POSTs remain standard traffic. */
export function classifyOperatorRequest(method: string, url: string): "critical" | "stream" | "monitor" | "standard" {
  const path = url.split("?", 1)[0] ?? "";
  if (method === "GET" && (path === "/api/health" || path === "/api/ready")) return "monitor";
  if (method === "GET" && (
    path === "/api/workspace/stream"
    || /^\/api\/agents\/[^/]+\/stream$/u.test(path)
    || path === "/api/streams/probe"
  )) return "stream";
  if (method === "PUT" && /^\/api\/conversations\/[^/]+\/draft$/u.test(path)) return "critical";
  if (method === "POST" && (
    /^\/api\/conversations\/[^/]+\/(?:messages|direct-messages|collaboration\/messages)$/u.test(path)
    || /^\/api\/agents\/[^/]+\/messages$/u.test(path)
    || /^\/api\/agents\/[^/]+\/queued-messages\/[^/]+\/steer$/u.test(path)
    || /^\/api\/projects\/[^/]+\/(?:agents|conversations)$/u.test(path)
    || /^\/api\/conversations\/[^/]+\/draft-attachments$/u.test(path)
    || /^\/api\/conversations\/[^/]+\/attachments$/u.test(path)
    || /^\/api\/agents\/[^/]+\/attachments$/u.test(path)
    || path === "/api/chats"
    || path === "/api/projects"
  )) return "critical";
  return "standard";
}

export function registerBodyParsers(
  app: FastifyInstance,
): WeakMap<IncomingMessage, Buffer> {

  const webhookRawBodies = new WeakMap<IncomingMessage, Buffer>();
  const activeUploads = new WeakSet<IncomingMessage>();
  let activeUploadCount = 0;
  const releaseUpload = (raw: IncomingMessage) => {
    if (!activeUploads.delete(raw)) return;
    activeUploadCount -= 1;
  };
  app.addHook("preParsing", async (request, reply, payload) => {
    const path = request.url.split("?", 1)[0] ?? "";
    const uploadRoute = request.method === "POST" && (
      /^\/api\/agents\/[^/]+\/attachments$/u.test(path)
      || /^\/api\/conversations\/[^/]+\/attachments$/u.test(path)
      || /^\/api\/conversations\/[^/]+\/draft-attachments$/u.test(path)
    );
    const largeAttachmentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() === "application/x-ponderosa-attachment";
    if (largeAttachmentType && !uploadRoute) {
      void reply.code(415).send({ error: "This content type is only for attachment uploads" });
      return Readable.from(Buffer.alloc(0));
    }
    if (uploadRoute && largeAttachmentType) {
      if (activeUploadCount >= 2) {
        void reply.code(503).header("retry-after", "1").send({
          code: "attachment_upload_busy",
          error: "Two attachments are uploading. Try again in a moment.",
        });
        return Readable.from(Buffer.alloc(0));
      }
      activeUploadCount += 1;
      activeUploads.add(request.raw);
    }
    if (!request.url.startsWith("/api/trigger-webhooks/")) return payload;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 256 * 1_024) {
        void reply.code(413).send({ error: "webhook payload exceeds 256 KiB" });
        return Readable.from(Buffer.alloc(0));
      }
      chunks.push(bytes);
    }
    const raw = Buffer.concat(chunks);
    webhookRawBodies.set(request.raw, raw);
    return Readable.from(raw);
  });
  for (const mediaType of OPERATOR_AVATAR_MEDIA_TYPES) {
    app.addContentTypeParser(mediaType, { parseAs: "buffer", bodyLimit: MAX_OPERATOR_AVATAR_BYTES }, (_request, body, done) => done(null, body));
  }
  for (const mediaType of ["application/pdf", "application/zip", "application/octet-stream"]) {
    app.addContentTypeParser(mediaType, { parseAs: "buffer", bodyLimit: ASSET_LIMITS.maxRequestBytes }, (_request, body, done) => done(null, body));
  }
  // Only authenticated attachment routes opt into this media type and
  // their own larger route body limit. JSON/text and legacy binary parsers keep
  // the ordinary 8 MiB request ceiling.
  app.addContentTypeParser("application/x-ponderosa-attachment", {
    parseAs: "buffer",
    bodyLimit: ASSET_LIMITS.maxFileBytes,
  }, (_request, body, done) => done(null, body));
  app.addHook("onResponse", async (request) => releaseUpload(request.raw));
  app.addHook("onError", async (request) => releaseUpload(request.raw));
  return webhookRawBodies;
}

interface RequestSecurityHooksContext {
  opts: CreateServerOptions;
  v3DispatchKey: string;
  agentMessageCapabilities: Map<string, AgentMessageCapability>;
  deletingAgentIds: ReadonlySet<string>;
  validLauncherSession(
    header: string | undefined,
    onRenew?: (token: string, maxAgeSeconds: number) => void,
  ): boolean;
  artifactFilesystemError(): string | undefined;
  isArtifactDependentWorkIntake(method: string, url: string, body?: unknown): boolean;
  isPublicWebAssetRequest(method: string, url: string): boolean;
}

export function registerRequestSecurityHooks(
  app: FastifyInstance,
  context: RequestSecurityHooksContext,
): void {
  const {
    opts,
    v3DispatchKey,
    agentMessageCapabilities,
    deletingAgentIds,
    validLauncherSession,
    artifactFilesystemError,
    isArtifactDependentWorkIntake,
    isPublicWebAssetRequest,
  } = context;

  const normalizedHostname = (value: string): string =>
    value.toLowerCase().replace(/^\[|\]$/gu, "");
  const allowedHostnames = new Set(["localhost", "127.0.0.1", "::1"]);
  if (opts.networkSecurity?.bindHost) allowedHostnames.add(normalizedHostname(opts.networkSecurity.bindHost));
  const allowedOrigins = new Set<string>();
  const allowedProxyIdentities = new Set(
    (opts.operatorIdentities ?? []).map((identity) => identity.toLocaleLowerCase()),
  );
  for (const rawOrigin of opts.operatorOrigins ?? []) {
    const origin = new URL(rawOrigin);
    allowedOrigins.add(origin.origin.toLowerCase());
    allowedHostnames.add(normalizedHostname(origin.hostname));
  }
  const requestBuckets = new Map<string, { startedAt: number; count: number; rejected: number }>();
  const operatorLogKey = randomBytes(32);
  let inflight = 0;
  const admitted = new WeakSet<IncomingMessage>();
  const activeHandlers = new WeakSet<IncomingMessage>();
  const deadlineResponses = new WeakSet<IncomingMessage>();
  const handlerDeadlines = new WeakMap<IncomingMessage, ReturnType<typeof setTimeout>>();

  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host;
    let hostname: string;
    try {
      hostname = normalizedHostname(new URL(`http://${host ?? ""}`).hostname);
    } catch {
      return reply.code(400).send({ error: "invalid Host header" });
    }
    if (!allowedHostnames.has(hostname)) {
      return reply.code(421).send({ error: "unrecognized Ponderosa host" });
    }
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite === "cross-site" && request.url.startsWith("/api/")) {
      return reply.code(403).send({ error: "cross-site API request forbidden" });
    }
  });
  const releaseAdmission = (request: { raw: IncomingMessage }): void => {
    const deadline = handlerDeadlines.get(request.raw);
    if (deadline) {
      clearTimeout(deadline);
      handlerDeadlines.delete(request.raw);
    }
    if (!admitted.delete(request.raw)) return;
    inflight = Math.max(0, inflight - 1);
  };
  // A 504 closes the client response, not the underlying handler. Hold its
  // admission slot until the handler actually settles so timed-out work cannot
  // accumulate outside the concurrency limit. Fastify awaits streamed replies.
  app.addHook("onRoute", (route) => {
    const handler = route.handler;
    route.handler = async function(request, reply) {
      activeHandlers.add(request.raw);
      try {
        const result = await handler.call(this, request, reply);
        // Fastify must not implicitly send a late return after the deadline.
        return deadlineResponses.has(request.raw) ? reply : result;
      } catch (error) {
        if (!deadlineResponses.has(request.raw)) throw error;
        // The handler has genuinely settled. Retain diagnostic evidence without
        // asking Fastify to send a second error response to the closed client.
        request.log.error({ err: error }, "request handler failed after deadline response");
        return reply;
      }
      finally {
        activeHandlers.delete(request.raw);
        releaseAdmission(request);
      }
    };
  });
  app.addHook("onResponse", async (request) => {
    if (!activeHandlers.has(request.raw)) releaseAdmission(request);
  });
  app.addHook("onError", async (request) => {
    if (!activeHandlers.has(request.raw)) releaseAdmission(request);
  });

  app.addHook("onRequest", async (request, reply) => {
    const provided = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    // Only the narrow extension transport uses its own unguessable, tab-scoped
    // pairing capability. It never grants access to operator or Agent APIs.
    if (request.method === "POST" && localBrowserTransportPath(request.url)) return;
    const browserBootstrapPath =
      /^\/__ponderosa_bootstrap(?:\?|$)/u.test(request.url) ||
      request.url === "/__ponderosa_bootstrap.js";
    const launcherExchange = request.url === "/api/launcher/session-exchange";
    const launcherControlRequest = request.url.startsWith("/api/launcher/") && !launcherExchange;
    if (launcherControlRequest) {
      if (opts.launcherSecurity && provided &&
          secretEqual(provided, opts.launcherSecurity.controlToken)) return;
      return reply.code(401).send({ error: "launcher authorization required" });
    }
    const internalV3Dispatch = request.method === "POST" &&
      /^\/api\/agents\/[^/?]+\/messages(?:\?|$)/u.test(request.url) &&
      typeof request.headers["x-ponderosa-v3-dispatch"] === "string" &&
      secretEqual(request.headers["x-ponderosa-v3-dispatch"], v3DispatchKey);
    if (internalV3Dispatch) return;
    if (opts.launcherSecurity && opts.networkSecurity?.mode !== "reverse_proxy" &&
        (browserBootstrapPath || launcherExchange)) return;
    if (isPublicWebAssetRequest(request.method, request.url)) return;
    const agentToolRequest = isAgentToolRoute(request.url);
    const capability = agentToolRequest && provided ? agentMessageCapabilities.get(provided) : undefined;
    if (capability) {
      if (deletingAgentIds.has(capability.agentId)) {
        return reply.code(409).send({ error: "Agent deletion is already in progress" });
      }
      return;
    }
    if (request.url === "/api/health" || request.url === "/api/ready" || request.url.startsWith("/api/trigger-webhooks/")) return;
    const validBrowserSession = (): boolean => validLauncherSession(
      request.headers.cookie,
      (token, maxAgeSeconds) => {
        const trustedHttpsProxy = opts.networkSecurity?.mode === "reverse_proxy" &&
          Boolean(opts.operatorOrigins?.some((origin) => origin.startsWith("https://")));
        reply.header("Set-Cookie", browserSessionCookie(
          token,
          maxAgeSeconds,
          request.protocol === "https" || trustedHttpsProxy,
        ));
      },
    );
    if (opts.networkSecurity?.mode === "reverse_proxy") {
      if (allowedProxyIdentities.size > 0) {
        const asserted = request.headers["tailscale-user-login"];
        const identity = typeof asserted === "string" ? asserted.trim().toLocaleLowerCase() : "";
        if (!identity || !allowedProxyIdentities.has(identity)) {
          return reply.code(401).send({ error: "trusted proxy operator identity required" });
        }
      }
      if ((opts.launcherSecurity || opts.authToken) &&
          (browserBootstrapPath || launcherExchange)) return;
      if (opts.authToken && !validBrowserSession() && !secretEqual(provided, opts.authToken)) {
        return reply.code(401).send({ error: "reverse proxy backend authentication required" });
      }
      return;
    }
    if (opts.launcherSecurity && validBrowserSession()) return;
    if (opts.authToken && secretEqual(provided, opts.authToken)) return;
    if (opts.authToken || opts.launcherSecurity) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  // Admission follows authentication so an untrusted peer cannot consume the
  // authenticated operator's rate or concurrency budget. Long-lived SSE
  // streams have their own subscriber, replay, byte, and backpressure bounds.
  app.addHook("onRequest", async (request, reply) => {
    if (!opts.requestLimits) return;
    const now = Date.now();
    const provided = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = provided ? agentMessageCapabilities.get(provided) : undefined;
    const asserted = request.headers["tailscale-user-login"];
    const proxyIdentity = typeof asserted === "string"
      ? asserted.trim().toLocaleLowerCase()
      : "";
    const source = capability
      ? `agent:${capability.agentId}`
      : opts.networkSecurity?.mode === "reverse_proxy"
        ? `operator:${proxyIdentity}`
        : opts.authToken || opts.launcherSecurity
          ? "operator"
          : request.ip;
    const requestClass = !capability && request.method === "GET" && /^\/api\/(?:health|ready)(?:\?|$)/u.test(request.url)
      ? "monitor"
      : !capability && (opts.authToken || opts.launcherSecurity)
        ? classifyOperatorRequest(request.method, request.url)
        : "standard";
    const bucketKey = `${source}\0${requestClass}`;
    const current = requestBuckets.get(bucketKey);
    const operatorId = source.startsWith("operator")
      ? createHmac("sha256", operatorLogKey).update(source).digest("hex").slice(0, 24)
      : undefined;
    if (current && now - current.startedAt >= 60_000 && operatorId) {
      app.log.info({ event: "operator_request_window", operatorId, requestClass,
        requestCount: current.count, rateLimitedCount: current.rejected },
      "operator request admission window completed");
    }
    const bucket = !current || now - current.startedAt >= 60_000
      ? { startedAt: now, count: 0, rejected: 0 }
      : current;
    bucket.count += 1;
    requestBuckets.set(bucketKey, bucket);
    if (requestBuckets.size > 10_000) {
      for (const [key, value] of requestBuckets) {
        if (now - value.startedAt >= 60_000) requestBuckets.delete(key);
      }
    }
    const limit = requestClass === "critical"
      ? opts.requestLimits.maxCriticalRequestsPerMinute ?? opts.requestLimits.maxRequestsPerMinute
      : requestClass === "stream"
        ? opts.requestLimits.maxStreamRequestsPerMinute ?? 120
        : requestClass === "monitor"
          ? opts.requestLimits.maxMonitorRequestsPerMinute ?? 120
        : opts.requestLimits.maxRequestsPerMinute;
    if (bucket.count > limit) {
      bucket.rejected += 1;
      if (operatorId && (bucket.rejected === 1 || bucket.rejected % 100 === 0)) {
        app.log.warn({ event: "operator_request_rate_limited", operatorId, requestClass,
          requestCount: bucket.count, rateLimitedCount: bucket.rejected },
        "operator request admission limit reached");
      }
      reply.header("Retry-After", Math.max(1, Math.ceil((bucket.startedAt + 60_000 - now) / 1_000)));
      return reply.code(429).send({ error: "request rate limit exceeded" });
    }
    const reservedCriticalSlots = opts.requestLimits.maxCriticalRequestsPerMinute && opts.requestLimits.maxInflight > 1
      ? Math.min(16, Math.max(1, Math.floor(opts.requestLimits.maxInflight / 8)))
      : 0;
    const reservedStreamSlots = opts.requestLimits.maxStreamRequestsPerMinute && opts.requestLimits.maxInflight > 2
      ? Math.min(8, Math.max(1, Math.floor(opts.requestLimits.maxInflight / 16)))
      : 0;
    const classInflightLimit = requestClass === "critical"
      ? opts.requestLimits.maxInflight
      : requestClass === "stream"
        ? opts.requestLimits.maxInflight - reservedCriticalSlots
        : opts.requestLimits.maxInflight - reservedCriticalSlots - reservedStreamSlots;
    if (inflight >= classInflightLimit) {
      reply.header("Retry-After", "1");
      return reply.code(503).send({ error: "server request concurrency limit reached" });
    }
    inflight += 1;
    admitted.add(request.raw);
    if (!/^\/api\/(?:workspace\/stream|agents\/[^/?]+\/stream)(?:\?|$)/u.test(request.url)) {
      handlerDeadlines.set(request.raw, setTimeout(() => {
        if (!reply.sent) {
          deadlineResponses.add(request.raw);
          const send = reply.send;
          void send.call(reply.code(504), { error: "request handler deadline exceeded" });
          // Explicit late sends receive the settled reply, not another send.
          // Apply only to deadline responses; ordinary double-send bugs remain
          // observable, and streams are not subject to this deadline.
          reply.send = () => reply;
        }
      }, opts.requestLimits.handlerDeadlineMs ?? 60_000).unref());
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    const error = artifactFilesystemError();
    if (error && isArtifactDependentWorkIntake(request.method, request.url)) {
      return reply.code(503).send({ error });
    }
  });

  app.addHook("preValidation", async (request, reply) => {
    const error = artifactFilesystemError();
    if (error && isArtifactDependentWorkIntake(request.method, request.url, request.body)) {
      return reply.code(503).send({ error });
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/") || !["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
    const origin = request.headers.origin;
    if (localBrowserTransportPath(request.url) && origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return;
    if (!origin) return; // Non-browser clients and host-local runtime bridges.
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      return reply.code(403).send({ error: "cross-origin mutation forbidden" });
    }
    const requestHost = request.headers.host?.toLowerCase();
    const exactOriginAllowed = allowedOrigins.has(parsedOrigin.origin.toLowerCase());
    const originHostname = normalizedHostname(parsedOrigin.hostname);
    const loopbackOriginAllowed = allowedHostnames.has(originHostname) &&
      ["localhost", "127.0.0.1", "::1"].includes(originHostname);
    if ((!exactOriginAllowed && !loopbackOriginAllowed) || !requestHost ||
        parsedOrigin.host.toLowerCase() !== requestHost) {
      return reply.code(403).send({ error: "cross-origin mutation forbidden" });
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/") && !reply.hasHeader("Cache-Control")) {
      reply.header("Cache-Control", "private, no-store");
    }
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if (opts.operatorOrigins?.some((origin) => origin.startsWith("https://"))) {
      reply.header("Strict-Transport-Security", "max-age=31536000");
    }
    if (!reply.hasHeader("X-Frame-Options")) reply.header("X-Frame-Options", "DENY");
    if (!reply.hasHeader("Content-Security-Policy")) {
      reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    }
    if (request.url.startsWith("/api/link-previews/")) {
      // Local dev apps are untrusted content. A unique sandbox origin prevents
      // their scripts from inheriting the operator's authenticated API origin.
      reply.header("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-modals allow-downloads; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
    }
    return payload;
  });
}
