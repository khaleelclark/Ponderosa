import type { FastifyInstance } from "fastify";
import { LocalBrowserHub } from "../local-browser-hub.js";
import { BrowserSessionError, type BrowserSessionManager, type BrowserScope } from "../browser-session-manager.js";

export const localBrowserTransportPath = (path: string): boolean => /^\/api\/local-browser\/(?:claim|connections\/[a-f0-9-]+\/(?:poll|result|detached|state))$/.test(path);
export function registerLocalBrowserRoutes(app: FastifyInstance, context: {
  /** Host-supplied retained transport; never accepted from an HTTP request. */
  localBrowserHub?: LocalBrowserHub;
  projectBrowserSessions: BrowserSessionManager;
  projectBrowserScope(projectId: string): BrowserScope;
  projectExists(projectId: string): boolean;
  projectDeletionInProgress(projectId: string): boolean;
}): void {
  const hub = context.localBrowserHub ?? new LocalBrowserHub();
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.includes("/local-browser")) reply.header("Cache-Control", "private, no-store");
    return payload;
  });
  const check = (projectId: string) => {
    if (!context.projectExists(projectId) || context.projectDeletionInProgress(projectId)) throw new BrowserSessionError("Chat browser is unavailable.", 404);
  };
  const token = (authorization?: string) => authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const safe = async <T>(reply: import("fastify").FastifyReply, work: () => Promise<T> | T) => {
    try { return await work(); }
    catch (error) { if (error instanceof BrowserSessionError) return reply.code(error.statusCode).send({ error: error.message }); throw error; }
  };
  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/local-browser/pair", (request, reply) => safe(reply, () => {
    check(request.params.projectId);
    // Window pairing cannot attest cookie/profile isolation. Keep exact old
    // transport/cleanup capabilities, but do not issue a new cross-Chat path.
    return reply.code(409).send({ code: "browser_profile_isolation_required", error: "Local window pairing cannot verify a separate sign-in profile for this Chat. Use its hosted browser, or the explicitly shared saved browser." });
  }));
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/local-browser", (request, reply) => safe(reply, () => {
    check(request.params.projectId); return hub.list(request.params.projectId);
  }));
  app.post<{ Params: { projectId: string; id: string } }>("/api/projects/:projectId/local-browser/:id/connect", (request, reply) => safe(reply, async () => {
    const { projectId, id } = request.params;
    check(projectId);
    const scope = context.projectBrowserScope(projectId);
    const existing = context.projectBrowserSessions.get(scope.agentId);
    if (existing && existing.status !== "closed" && existing.status !== "failed") throw new BrowserSessionError("End the current browser session before switching to the connected tab.", 409);
    await context.projectBrowserSessions.open(scope, undefined, "operator", hub.factory(projectId, id));
    return { ok: true };
  }));
  app.post<{ Body: { code?: unknown; url?: unknown; title?: unknown; protocolVersion?: unknown; paused?: unknown } }>("/api/local-browser/claim", (request, reply) => safe(reply, () => {
    const body = request.body;
    if (body?.protocolVersion !== 4 || typeof body.paused !== "boolean") throw new BrowserSessionError("Update the Ponderosa extension to version 0.4.0 for managed file uploads.", 409);
    if (typeof body?.code !== "string" || body.code.length !== 32 || typeof body.url !== "string" || body.url.length > 4096 || typeof body.title !== "string" || body.title.length > 512) throw new BrowserSessionError("Invalid pairing request.");
    return hub.claim(body.code, { url: body.url, title: body.title, paused: body.paused });
  }));
  app.post<{ Params: { id: string }; Body: { paused?: unknown; epoch?: unknown } }>("/api/local-browser/connections/:id/state", (request, reply) => safe(reply, () => {
    if (typeof request.body?.paused !== "boolean" || typeof request.body.epoch !== "number") throw new BrowserSessionError("Invalid browser state.");
    hub.state(request.params.id, token(request.headers.authorization), request.body.paused, request.body.epoch);
    return { ok: true };
  }));
  app.post<{ Params: { id: string } }>("/api/local-browser/connections/:id/poll", (request, reply) => safe(reply, () => hub.poll(request.params.id, token(request.headers.authorization))));
  app.post<{ Params: { id: string }; Body: { id?: unknown; value?: unknown; failed?: unknown } }>("/api/local-browser/connections/:id/result", { bodyLimit: 24 * 1024 * 1024 }, (request, reply) => safe(reply, () => {
    if (typeof request.body?.id !== "string" || typeof request.body.failed !== "boolean") throw new BrowserSessionError("Invalid browser result.");
    hub.result(request.params.id, token(request.headers.authorization), request.body.id, request.body.value, request.body.failed);
    return { ok: true };
  }));
  app.post<{ Params: { id: string } }>("/api/local-browser/connections/:id/detached", (request, reply) => safe(reply, () => {
    hub.detached(request.params.id, token(request.headers.authorization)); return { ok: true };
  }));
}
