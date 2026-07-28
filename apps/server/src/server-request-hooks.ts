import type { IncomingMessage } from "node:http";
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

export function registerBodyParsers(
  app: FastifyInstance,
): WeakMap<IncomingMessage, Buffer> {

  const webhookRawBodies = new WeakMap<IncomingMessage, Buffer>();
  app.addHook("preParsing", async (request, reply, payload) => {
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
  return webhookRawBodies;
}

interface RequestSecurityHooksContext {
  opts: CreateServerOptions;
  agentMessageCapabilities: Map<string, AgentMessageCapability>;
  deletingAgentIds: ReadonlySet<string>;
  validLauncherSession(header: string | undefined): boolean;
  artifactFilesystemError(): string | undefined;
  isArtifactDependentWorkIntake(method: string, url: string, body?: unknown): boolean;
}

export function registerRequestSecurityHooks(
  app: FastifyInstance,
  context: RequestSecurityHooksContext,
): void {
  const {
    opts,
    agentMessageCapabilities,
    deletingAgentIds,
    validLauncherSession,
    artifactFilesystemError,
    isArtifactDependentWorkIntake,
  } = context;

  app.addHook("onRequest", async (request, reply) => {
    const provided = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const browserBootstrapPath = request.url === "/__ponderosa_bootstrap" ||
      request.url === "/__ponderosa_bootstrap.js";
    const launcherExchange = request.url === "/api/launcher/session-exchange";
    const launcherControlRequest = request.url.startsWith("/api/launcher/") && !launcherExchange;
    if (launcherControlRequest) {
      if (opts.launcherSecurity && provided &&
          secretEqual(provided, opts.launcherSecurity.controlToken)) return;
      return reply.code(401).send({ error: "launcher authorization required" });
    }
    if (opts.launcherSecurity && (browserBootstrapPath || launcherExchange)) return;
    const agentToolRequest = isAgentToolRoute(request.url);
    const capability = agentToolRequest && provided ? agentMessageCapabilities.get(provided) : undefined;
    if (capability) {
      if (deletingAgentIds.has(capability.agentId)) {
        return reply.code(409).send({ error: "Agent deletion is already in progress" });
      }
      return;
    }
    if (request.url === "/api/health" || request.url === "/api/ready" || request.url.startsWith("/api/trigger-webhooks/")) return;
    if (opts.launcherSecurity && validLauncherSession(request.headers.cookie)) return;
    if (opts.authToken && secretEqual(provided, opts.authToken)) return;
    if (opts.authToken || opts.launcherSecurity) {
      return reply.code(401).send({ error: "unauthorized" });
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
    if (!origin) return; // Non-browser clients and host-local runtime bridges.
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return reply.code(403).send({ error: "cross-origin mutation forbidden" });
    }
    const requestHost = request.headers.host?.toLowerCase();
    if (!requestHost || originHost !== requestHost) {
      return reply.code(403).send({ error: "cross-origin mutation forbidden" });
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if (!reply.hasHeader("X-Frame-Options")) reply.header("X-Frame-Options", "DENY");
    if (!reply.hasHeader("Content-Security-Policy")) {
      reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    }
    if (request.url.startsWith("/api/link-previews/")) {
      // Local dev apps are untrusted content. A unique sandbox origin prevents
      // their scripts from inheriting the operator's authenticated API origin.
      reply.header("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-modals allow-downloads; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
    }
    return payload;
  });
}
