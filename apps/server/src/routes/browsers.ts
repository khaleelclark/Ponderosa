import type {
  CreateBrowserProfileRequest,
  BrowserControlRequest,
  BrowserOperatorInputRequest,
  ProjectBrowserControlRequest,
  ProjectBrowserNavigateRequest,
  ProjectBrowserOpenRequest,
  ProjectBrowserSessionDto,
  BrowserUploadRequest,
  UpdateBrowserAgentPreferenceRequest,
  UpdateBrowserProfileRequest,
} from "@ponderosa/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  BrowserSessionError,
  type BrowserScope,
  type BrowserSessionManager,
} from "../browser-session-manager.js";
import { BrowserProfileError, type BrowserProfileAuthority } from "../browser-profile-authority.js";
import { registerLocalBrowserRoutes } from "./local-browsers.js";
import { createHostedDesktopAccess } from "../hosted-desktop-access.js";
import { validateBrowserUrl } from "../browser-security.js";
import { SAVED_BROWSER_SCOPE_ID } from "@ponderosa/core";

export type ProjectBrowserGrant = { agentId: string; runId: string };

interface ActiveProjectBrowserController {
  grant: ProjectBrowserGrant;
  privateScope(): BrowserScope | undefined;
}

interface BrowserRoutesContext {
  browserProfiles: BrowserProfileAuthority;
  browserSessions: BrowserSessionManager;
  projectBrowserSessions: BrowserSessionManager;
  projectExists(projectId: string): boolean;
  agentExists(projectId: string, agentId: string): boolean;
  projectDeletionInProgress(projectId: string): boolean;
  agentDeletionInProgress(agentId: string): boolean;
  operatorBrowserScope(params: BrowserRouteParams): BrowserScope;
  projectBrowserScope(projectId: string, grant?: ProjectBrowserGrant): BrowserScope;
  projectBrowserDto(projectId: string, session: import("@ponderosa/core").BrowserSessionDto): ProjectBrowserSessionDto;
  liveSseClosures: Set<() => void>;
  getProjectBrowserGrant(projectId: string): ProjectBrowserGrant | undefined;
  setProjectBrowserGrant(projectId: string, grant: ProjectBrowserGrant): void;
  deleteProjectBrowserGrant(projectId: string): void;
  activeProjectBrowserController(
    projectId: string,
    agentId: string | undefined,
  ): ActiveProjectBrowserController | undefined;
}

type BrowserRouteParams = { projectId: string; id: string; runId: string };

function browserRouteError(reply: FastifyReply, error: unknown) {
  if (error instanceof BrowserProfileError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  if (error instanceof BrowserSessionError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
  throw error;
}

export function registerBrowserRoutes(
  app: FastifyInstance,
  context: BrowserRoutesContext,
): void {
  registerLocalBrowserRoutes(app, context);
  const {
    browserSessions,
    browserProfiles,
    projectBrowserSessions,
    liveSseClosures,
    projectExists: chatExists,
    agentExists,
    projectDeletionInProgress,
    agentDeletionInProgress,
    operatorBrowserScope,
    projectBrowserScope,
    projectBrowserDto,
    getProjectBrowserGrant,
    setProjectBrowserGrant,
    deleteProjectBrowserGrant,
    activeProjectBrowserController,
  } = context;
  const previewStreams = new Set<() => void>();
  const registerPreviewStream = (route: string, manager: BrowserSessionManager, scope: (params: BrowserRouteParams) => BrowserScope) => {
    app.get<{ Params: BrowserRouteParams; Querystring: { pageId?: string } }>(route, async (request, reply) => {
      if (previewStreams.size >= 8) return reply.code(429).send({ error: "too many browser previews" });
      if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
      let frame: Awaited<ReturnType<BrowserSessionManager["previewFrame"]>>;
      let browserScope: BrowserScope;
      try {
        browserScope = scope(request.params);
        frame = await manager.previewFrame(browserScope, request.query.pageId);
      }
      catch (error) { return browserRouteError(reply, error); }
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "private, no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let lastKey = "";
      let lastHeartbeat = Date.now();
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        previewStreams.delete(close);
        liveSseClosures.delete(close);
        reply.raw.off("close", close);
        if (!reply.raw.writableEnded) reply.raw.end();
        if (!reply.raw.destroyed) reply.raw.destroy();
      };
      const write = (body: string): Promise<boolean> => new Promise(resolve => {
        if (closed || reply.raw.destroyed) return resolve(false);
        try {
          if (reply.raw.write(body)) return resolve(true);
        } catch { return resolve(false); }
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reply.raw.off("drain", onDrain);
          reply.raw.off("close", onClose);
          resolve(ok);
        };
        const onDrain = () => finish(true);
        const onClose = () => finish(false);
        const timeout = setTimeout(() => finish(false), 2_000);
        reply.raw.once("drain", onDrain);
        reply.raw.once("close", onClose);
      });
      const run = async (next: typeof frame): Promise<void> => {
        if (closed) return;
        // Agent clicks may not repaint the page. Publish their overlay even
        // when Chrome's pixels and sequence are unchanged.
        const key = `${next.mediaType}:${next.sequence}:${JSON.stringify(next.metadata.activity ?? null)}`;
        if (key !== lastKey) {
          const body = `event: frame\ndata: ${JSON.stringify({ data: next.body.toString("base64"), mediaType: next.mediaType, sequence: next.sequence, metadata: next.metadata })}\n\n`;
          if (Buffer.byteLength(body) > 2 * 1024 * 1024 || !await write(body)) return close();
          lastKey = key;
        } else if (Date.now() - lastHeartbeat > 10_000) {
          if (!await write(": heartbeat\n\n")) return close();
          lastHeartbeat = Date.now();
        }
        if (closed) return;
        timer = setTimeout(() => {
          void manager.previewFrame(browserScope, request.query.pageId).then(run, close);
        }, next.mediaType === "image/png" ? 250 : 40);
      };
      reply.raw.on("close", close);
      previewStreams.add(close);
      liveSseClosures.add(close);
      void run(frame);
    });
  };
  const projectExists = (id: string) => id === SAVED_BROWSER_SCOPE_ID ? Boolean(browserProfiles.savedBrowser()) : chatExists(id);

  app.get("/api/saved-browser", async () => ({ browser: browserProfiles.savedBrowser() ?? null }));
  app.get<{ Params: { projectId: string; agentId: string } }>("/api/projects/:projectId/agents/:agentId/browser-location", async (request, reply) => {
    const { projectId, agentId } = request.params;
    if (!chatExists(projectId) || !agentExists(projectId, agentId) || projectDeletionInProgress(projectId) || agentDeletionInProgress(agentId)) {
      return reply.code(404).send({ error: "Agent is unavailable in this chat." });
    }
    const saved = projectBrowserSessions.get(projectBrowserScope(SAVED_BROWSER_SCOPE_ID).agentId);
    const savedGrant = getProjectBrowserGrant(SAVED_BROWSER_SCOPE_ID);
    if (saved && saved.status !== "closed" && savedGrant?.agentId === agentId) {
      return { kind: "saved", status: saved.status };
    }
    const shared = projectBrowserSessions.get(projectBrowserScope(projectId).agentId);
    const sharedGrant = getProjectBrowserGrant(projectId);
    if (shared && shared.status !== "closed" && sharedGrant?.agentId === agentId) {
      return { kind: "chat", status: shared.status };
    }
    const privateSession = browserSessions.get(agentId);
    if (privateSession && privateSession.projectId === projectId && privateSession.status !== "closed" &&
        activeProjectBrowserController(projectId, agentId)?.grant.runId === privateSession.runId) {
      return { kind: "run", runId: privateSession.runId, status: privateSession.status };
    }
    return { kind: "none" };
  });
  const savedAccessRoute = "/api/projects/:projectId/saved-browser-access";
  app.get<{ Params: { projectId: string } }>(savedAccessRoute, async (request, reply) => {
    const projectId = request.params.projectId;
    if (!chatExists(projectId) || projectDeletionInProgress(projectId)) return reply.code(404).send({ error: "Chat is unavailable." });
    return { agentIds: browserProfiles.savedBrowserAccess(projectId) };
  });
  app.put<{ Params: { projectId: string; agentId: string }; Body: { allowed?: boolean } }>(`${savedAccessRoute}/:agentId`, async (request, reply) => {
    const { projectId, agentId } = request.params;
    if (!chatExists(projectId) || projectDeletionInProgress(projectId) || !agentExists(projectId, agentId) || agentDeletionInProgress(agentId)) {
      return reply.code(404).send({ error: "Agent is not available in this chat." });
    }
    if (typeof request.body?.allowed !== "boolean") return reply.code(400).send({ error: "allowed must be a boolean" });
    try {
      browserProfiles.setSavedBrowserAccess(projectId, agentId, request.body.allowed);
      if (!request.body.allowed) {
        const scope = projectBrowserScope(SAVED_BROWSER_SCOPE_ID);
        const grant = getProjectBrowserGrant(SAVED_BROWSER_SCOPE_ID);
        const session = projectBrowserSessions.get(scope.agentId);
        if (session?.status === "ready" && (grant?.agentId === agentId || !grant)) {
          // Keep the exact grant until native/chooser cleanup succeeds. A
          // repeated revocation can then retry an incomplete operator handoff.
          await projectBrowserSessions.revokeAgentControl(scope);
        }
        if (grant?.agentId === agentId && getProjectBrowserGrant(SAVED_BROWSER_SCOPE_ID) === grant) {
          deleteProjectBrowserGrant(SAVED_BROWSER_SCOPE_ID);
        }
        projectBrowserSessions.expireNextRun(scope, agentId);
      }
      return { agentIds: browserProfiles.savedBrowserAccess(projectId) };
    } catch (error) { return browserRouteError(reply, error); }
  });
  app.post<{ Params: { projectId: string }; Body: { sessionId?: string; expectedControlEpoch?: number; confirmInstanceSharing?: boolean } }>("/api/projects/:projectId/browser/promote", async (request, reply) => {
    const id = request.params.projectId;
    if (!chatExists(id) || projectDeletionInProgress(id)) return reply.code(409).send({ error: "The source chat is unavailable." });
    if (request.body?.confirmInstanceSharing !== true || !request.body.sessionId || !Number.isSafeInteger(request.body.expectedControlEpoch)) return reply.code(400).send({ error: "Confirm instance-wide sharing and provide the current browser identity." });
    if (getProjectBrowserGrant(id)) return reply.code(409).send({ error: "Take control before saving this browser." });
    try {
      const session = await projectBrowserSessions.promote(projectBrowserScope(id), projectBrowserScope(SAVED_BROWSER_SCOPE_ID), request.body.sessionId, request.body.expectedControlEpoch!, profileId => browserProfiles.promoteSavedBrowser(id, profileId));
      return projectBrowserDto(SAVED_BROWSER_SCOPE_ID, session);
    } catch (error) { return browserRouteError(reply, error); }
  });

  const projectMutationGuard = (projectId: string, reply: FastifyReply): FastifyReply | undefined => {
    if (!projectExists(projectId)) return reply.code(404).send({ error: "project not found" });
    if (projectDeletionInProgress(projectId)) {
      return reply.code(409).send({ error: "Project deletion is in progress" });
    }
    return undefined;
  };

  const browserProfilesRoute = "/api/projects/:projectId/browser-profiles";
  app.get<{ Params: { projectId: string } }>(browserProfilesRoute, async (request, reply) => {
    if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
    try { return browserProfiles.listProfiles(request.params.projectId); }
    catch (error) { return browserRouteError(reply, error); }
  });
  app.post<{ Params: { projectId: string }; Body: CreateBrowserProfileRequest }>(browserProfilesRoute, async (request, reply) => {
    if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
    if (projectDeletionInProgress(request.params.projectId)) return reply.code(409).send({ error: "Project deletion is in progress" });
    if (typeof request.body?.name !== "string") return reply.code(400).send({ error: "name is required" });
    try { return reply.code(201).send(browserProfiles.createProfile(request.params.projectId, request.body.name)); }
    catch (error) { return browserRouteError(reply, error); }
  });
  app.put<{ Params: { projectId: string; profileId: string }; Body: UpdateBrowserProfileRequest }>(
    browserProfilesRoute + "/:profileId",
    async (request, reply) => {
      if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
      if (projectDeletionInProgress(request.params.projectId)) return reply.code(409).send({ error: "Project deletion is in progress" });
      if (typeof request.body?.name !== "string") return reply.code(400).send({ error: "name is required" });
      try { return browserProfiles.renameProfile(request.params.projectId, request.params.profileId, request.body.name); }
      catch (error) { return browserRouteError(reply, error); }
    },
  );
  app.delete<{ Params: { projectId: string; profileId: string } }>(
    browserProfilesRoute + "/:profileId",
    async (request, reply) => {
      if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
      if (projectDeletionInProgress(request.params.projectId)) return reply.code(409).send({ error: "Project deletion is in progress" });
      try {
        browserProfiles.deleteProfile(request.params.projectId, request.params.profileId);
        return reply.code(204).send();
      } catch (error) { return browserRouteError(reply, error); }
    },
  );
  const agentBrowserPreferenceRoute = "/api/projects/:projectId/agents/:agentId/browser-preference";
  app.get<{ Params: { projectId: string; agentId: string } }>(agentBrowserPreferenceRoute, async (request, reply) => {
    if (!agentExists(request.params.projectId, request.params.agentId)) return reply.code(404).send({ error: "agent not found" });
    try { return browserProfiles.preference(request.params.projectId, request.params.agentId); }
    catch (error) { return browserRouteError(reply, error); }
  });
  app.put<{ Params: { projectId: string; agentId: string }; Body: UpdateBrowserAgentPreferenceRequest }>(
    agentBrowserPreferenceRoute,
    async (request, reply) => {
      if (!agentExists(request.params.projectId, request.params.agentId)) return reply.code(404).send({ error: "agent not found" });
      if (projectDeletionInProgress(request.params.projectId)) return reply.code(409).send({ error: "Project deletion is in progress" });
      if (agentDeletionInProgress(request.params.agentId)) return reply.code(409).send({ error: "Agent deletion is in progress" });
      try {
        return browserProfiles.setPreference(
          request.params.projectId,
          request.params.agentId,
          request.body?.mode,
          request.body?.profileId,
        );
      } catch (error) { return browserRouteError(reply, error); }
    },
  );
  const projectBrowserRoute = "/api/projects/:projectId/browser";
  app.get<{ Params: { projectId: string } }>(`${projectBrowserRoute}/preferences`, async (request, reply) => {
    if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "chat not found" });
    const scope = projectBrowserScope(request.params.projectId);
    return { rememberSignIns: browserProfiles.preference(scope.projectId, scope.agentId).mode === "trusted" };
  });
  const desktop = createHostedDesktopAccess(app.server);
  // Upgraded desktop sockets keep Node's HTTP server open. Fastify waits for
  // server.close() before onClose, so release them during preClose instead.
  app.addHook("preClose", async () => { desktop.close(); });
  app.post<{ Params: { projectId: string }; Body: { action?: string; expectedControlEpoch?: number; sessionId?: string; width?: number; height?: number } }>(`${projectBrowserRoute}/manual`, async (request, reply) => {
    const projectId = request.params.projectId;
    const blocked = projectMutationGuard(projectId, reply);
    if (blocked) return blocked;
    const scope = projectBrowserScope(projectId);
    const body = request.body;
    try {
      if (body?.action === "open") {
        const existing = projectBrowserSessions.get(scope.agentId);
        if (existing && existing.status !== "closed" && existing.status !== "failed") return reply.code(409).send({ error: "End the existing browser session before opening a manual browser." });
        return projectBrowserDto(projectId, await projectBrowserSessions.open(scope, undefined, "operator", undefined, true));
      }
      if (!Number.isSafeInteger(body?.expectedControlEpoch) || !body?.sessionId) return reply.code(400).send({ error: "A current browser session and control epoch are required." });
      const current = projectBrowserSessions.get(scope.agentId);
      if (!current || current.id !== body.sessionId) return reply.code(409).send({ error: "The browser session changed." });
      const epoch = body.expectedControlEpoch!;
      if (body.action === "resize") {
        if (!Number.isInteger(body.width) || !Number.isInteger(body.height) || body.width! < 320 || body.width! > 1280 || body.height! < 200 || body.height! > 1280) return reply.code(400).send({ error: "Invalid browser display size" });
        await projectBrowserSessions.resizeDesktop(scope, body.sessionId!, epoch, { width: body.width!, height: body.height! });
        return { ok: true };
      }
      if (body.action === "pause") {
        const session = await projectBrowserSessions.pauseHostedAutomation(scope, epoch);
        deleteProjectBrowserGrant(projectId);
        return projectBrowserDto(projectId, session);
      }
      if (body.action === "resume" || body.action === "connect") return projectBrowserDto(projectId, await projectBrowserSessions.resumeHostedAutomation(scope, epoch, body.action === "connect"));
      if (body.action === "ticket") {
        const origin = request.headers.origin;
        if (!origin || new URL(origin).host !== request.headers.host) return reply.code(403).send({ error: "A same-origin desktop connection is required." });
        reply.header("Cache-Control", "no-store");
        return desktop.issue(origin, () => {
          if (!projectExists(projectId) || projectDeletionInProgress(projectId)) throw new Error("Browser access revoked");
          return projectBrowserSessions.manualDesktopSocket(scope, body.sessionId!, epoch);
        });
      }
      return reply.code(400).send({ error: "Unknown manual browser action." });
    } catch (error) {
      if (error instanceof BrowserSessionError || error instanceof BrowserProfileError) return browserRouteError(reply, error);
      return reply.code(409).send({ error: "The manual browser connection could not be completed. Your browser has not been restarted. Refresh the view and try again." });
    }
  });

  app.get<{ Params: { projectId: string } }>(projectBrowserRoute, async (request, reply) => {
    if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
    const scope = projectBrowserScope(request.params.projectId);
    const session = projectBrowserSessions.get(scope.agentId);
    if (!session) return reply.code(404).send({ error: "project browser has not been opened" });
    if (session.location === "local" && session.status === "ready") {
      try { return projectBrowserDto(request.params.projectId, await projectBrowserSessions.refreshLocalPages(scope)); }
      catch (error) { return browserRouteError(reply, error); }
    }
    return projectBrowserDto(request.params.projectId, session);
  });

  app.post<{ Params: { projectId: string }; Body: ProjectBrowserOpenRequest }>(
    projectBrowserRoute,
    async (request, reply) => {
      const blocked = projectMutationGuard(request.params.projectId, reply);
      if (blocked) return blocked;
      try {
        const scope = projectBrowserScope(request.params.projectId);
        const existing = projectBrowserSessions.get(scope.agentId);
        if (existing && existing.status !== "closed" && existing.status !== "failed") {
          if (request.body?.url) {
            return projectBrowserDto(request.params.projectId, await projectBrowserSessions.openLink(scope, request.body.url));
          }
          return projectBrowserDto(request.params.projectId, existing);
        }
        const remember = request.body?.rememberSignIns;
        if (remember !== undefined && typeof remember !== "boolean") return reply.code(400).send({ error: "rememberSignIns must be a boolean" });
        if (request.body?.url !== undefined) validateBrowserUrl(request.body.url);
        if (remember !== undefined) {
          browserProfiles.setChatRememberSignIns(scope.projectId, scope.agentId, remember);
        }
        const session = await projectBrowserSessions.open(scope, request.body?.url, "operator", undefined, true, true);
        return projectBrowserDto(request.params.projectId, session);
      } catch (error) {
        return browserRouteError(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string }; Body: ProjectBrowserNavigateRequest }>(
    `${projectBrowserRoute}/navigate`,
    async (request, reply) => {
      const blocked = projectMutationGuard(request.params.projectId, reply);
      if (blocked) return blocked;
      try {
        if (typeof request.body?.url !== "string") return reply.code(400).send({ error: "url is required" });
        const scope = projectBrowserScope(request.params.projectId);
        const session = await projectBrowserSessions.navigate(scope, request.body.url, "operator");
        return projectBrowserDto(request.params.projectId, session);
      } catch (error) {
        return browserRouteError(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    `${projectBrowserRoute}/reconnect`,
    async (request, reply) => {
      const blocked = projectMutationGuard(request.params.projectId, reply);
      if (blocked) return blocked;
      try {
        const scope = projectBrowserScope(
          request.params.projectId,
          getProjectBrowserGrant(request.params.projectId),
        );
        const session = await projectBrowserSessions.reconnect(scope);
        return projectBrowserDto(request.params.projectId, session);
      } catch (error) {
        return browserRouteError(reply, error);
      }
    },
  );

  app.delete<{ Params: { projectId: string } }>(projectBrowserRoute, async (request, reply) => {
    const blocked = projectMutationGuard(request.params.projectId, reply);
    if (blocked) return blocked;
    try {
      deleteProjectBrowserGrant(request.params.projectId);
      const session = await projectBrowserSessions.close(
        projectBrowserScope(request.params.projectId),
        "operator_closed",
      );
      return projectBrowserDto(request.params.projectId, session);
    } catch (error) {
      return browserRouteError(reply, error);
    }
  });

  app.put<{ Params: { projectId: string }; Body: ProjectBrowserControlRequest }>(
    `${projectBrowserRoute}/control`,
    async (request, reply) => {
      const projectId = request.params.projectId;
      const blocked = projectMutationGuard(projectId, reply);
      if (blocked) return blocked;
      if (
        (request.body?.owner !== "agent" && request.body?.owner !== "operator")
        || !Number.isSafeInteger(request.body?.expectedControlEpoch)
      ) {
        return reply.code(400).send({ error: "owner and expectedControlEpoch are required" });
      }
      try {
        const previousGrant = getProjectBrowserGrant(projectId);
        const controllerProjectId = projectId === SAVED_BROWSER_SCOPE_ID ? request.body.controllerProjectId : projectId;
        if (request.body.owner === "agent" && (!controllerProjectId || !chatExists(controllerProjectId) || projectDeletionInProgress(controllerProjectId))) return reply.code(404).send({ error: "Select an agent from an available chat." });
        if (request.body.owner === "agent") {
          const otherOwner = projectId === SAVED_BROWSER_SCOPE_ID ? controllerProjectId! : SAVED_BROWSER_SCOPE_ID;
          const otherGrant = getProjectBrowserGrant(otherOwner);
          const otherSession = projectBrowserSessions.get(projectBrowserScope(otherOwner).agentId);
          if (otherGrant?.agentId === request.body.agentId || (otherSession?.nextRunAgentId && otherSession.nextRunAgentId === request.body.agentId)) return reply.code(409).send({ error: "This agent already has access to another browser. Revoke that access before switching its browser." });
        }
        if (request.body.owner === "agent" && previousGrant && previousGrant.agentId !== request.body.agentId) return reply.code(409).send({ error: "Another agent controls this browser. Take control before handing it to a different agent." });
        const automatic = request.body.currentOrNext === true && request.body.owner === "agent";
        if (automatic && (!request.body.agentId || !agentExists(controllerProjectId!, request.body.agentId) || agentDeletionInProgress(request.body.agentId))) return reply.code(404).send({ error: "Agent is not available in this chat." });
        const automaticController = automatic ? activeProjectBrowserController(controllerProjectId!, request.body.agentId) : undefined;
        if (request.body.nextRun === true || (automatic && !automaticController)) {
          const agentId = request.body.owner === "agent" ? request.body.agentId : undefined;
          if (request.body.owner === "agent" && (!agentId || !agentExists(controllerProjectId!, agentId) || agentDeletionInProgress(agentId))) return reply.code(404).send({ error: "Agent is not available in this chat." });
          return projectBrowserDto(projectId, projectBrowserSessions.authorizeNextRun(projectBrowserScope(projectId), agentId, request.body.expectedControlEpoch));
        }
        if (request.body.owner === "operator") {
          const current = projectBrowserSessions.get(projectBrowserScope(projectId).agentId);
          if (current?.status === "ready" && current.controlOwner === "operator" && !previousGrant) {
            // Ownership can already say operator while native/chooser cleanup
            // is still pending from a failed revocation.
            const reconciled = await projectBrowserSessions.revokeAgentControl(projectBrowserScope(projectId));
            return projectBrowserDto(projectId, reconciled);
          }
          const session = await projectBrowserSessions.setControl(
            projectBrowserScope(projectId, previousGrant),
            "operator",
            request.body.expectedControlEpoch,
          );
          deleteProjectBrowserGrant(projectId);
          return projectBrowserDto(projectId, session);
        }
        const controller = automaticController ?? activeProjectBrowserController(controllerProjectId!, request.body.agentId);
        if (!controller) {
          return reply.code(409).send({ error: "agent control requires an active Run in this Project" });
        }
        setProjectBrowserGrant(projectId, controller.grant);
        try {
          const session = await projectBrowserSessions.setControl(
            projectBrowserScope(projectId, controller.grant),
            "agent",
            request.body.expectedControlEpoch,
          );
          const privateScope = controller.privateScope();
          if (privateScope) {
            await browserSessions.closeRun(privateScope, "project_browser_granted");
          }
          return projectBrowserDto(projectId, session);
        } catch (error) {
          if (previousGrant) setProjectBrowserGrant(projectId, previousGrant);
          else deleteProjectBrowserGrant(projectId);
          throw error;
        }
      } catch (error) {
        return browserRouteError(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string }; Body: BrowserOperatorInputRequest }>(
    `${projectBrowserRoute}/input`,
    async (request, reply) => {
      const blocked = projectMutationGuard(request.params.projectId, reply);
      if (blocked) return blocked;
      try {
        if (
          !request.body
          || !["click", "type", "key", "scroll"].includes(request.body.kind)
          || !Number.isSafeInteger(request.body.expectedControlEpoch)
        ) {
          return reply.code(400).send({ error: "valid input and expectedControlEpoch are required" });
        }
        const session = await projectBrowserSessions.operatorInput(
          projectBrowserScope(request.params.projectId),
          request.body,
        );
        return projectBrowserDto(request.params.projectId, session);
      } catch (error) {
        return browserRouteError(reply, error);
      }
    },
  );

  app.put<{
    Params: { projectId: string; pageId: string };
    Body: { expectedControlEpoch: number };
  }>(projectBrowserRoute + "/pages/:pageId/active", async (request, reply) => {
    const blocked = projectMutationGuard(request.params.projectId, reply);
    if (blocked) return blocked;
    if (!Number.isSafeInteger(request.body?.expectedControlEpoch)) {
      return reply.code(400).send({ error: "expectedControlEpoch is required" });
    }
    try {
      const session = await projectBrowserSessions.activatePage(
        projectBrowserScope(request.params.projectId),
        request.params.pageId,
        "operator",
        request.body.expectedControlEpoch,
      );
      return projectBrowserDto(request.params.projectId, session);
    } catch (error) {
      return browserRouteError(reply, error);
    }
  });

  app.delete<{
    Params: { projectId: string; pageId: string };
    Body: { expectedControlEpoch: number };
  }>(projectBrowserRoute + "/pages/:pageId", async (request, reply) => {
    const blocked = projectMutationGuard(request.params.projectId, reply);
    if (blocked) return blocked;
    if (!Number.isSafeInteger(request.body?.expectedControlEpoch)) {
      return reply.code(400).send({ error: "expectedControlEpoch is required" });
    }
    try {
      const session = await projectBrowserSessions.closePage(
        projectBrowserScope(request.params.projectId),
        request.params.pageId,
        "operator",
        request.body.expectedControlEpoch,
      );
      return projectBrowserDto(request.params.projectId, session);
    } catch (error) {
      return browserRouteError(reply, error);
    }
  });

  app.delete<{
    Params: { projectId: string };
    Body: { expectedControlEpoch: number };
  }>(projectBrowserRoute + "/file-chooser", async (request, reply) => {
    const blocked = projectMutationGuard(request.params.projectId, reply);
    if (blocked) return blocked;
    if (!Number.isSafeInteger(request.body?.expectedControlEpoch)) {
      return reply.code(400).send({ error: "expectedControlEpoch is required" });
    }
    try {
      const session = await projectBrowserSessions.cancelFileChooser(
        projectBrowserScope(request.params.projectId),
        "operator",
        request.body.expectedControlEpoch,
      );
      return projectBrowserDto(request.params.projectId, session);
    } catch (error) {
      return browserRouteError(reply, error);
    }
  });

  app.post<{
    Params: { projectId: string };
    Body: BrowserUploadRequest;
  }>(projectBrowserRoute + "/upload", async (request, reply) => {
    const blocked = projectMutationGuard(request.params.projectId, reply);
    if (blocked) return blocked;
    if (!request.body || typeof request.body.artifactId !== "string" ||
        !Number.isSafeInteger(request.body.expectedControlEpoch) ||
        (request.body.selector !== undefined && typeof request.body.selector !== "string")) {
      return reply.code(400).send({ error: "artifactId and expectedControlEpoch are required" });
    }
    try {
      const response = await projectBrowserSessions.upload(
        projectBrowserScope(request.params.projectId),
        request.body.artifactId,
        request.body.selector,
        "operator",
        request.body.expectedControlEpoch,
      );
      return {
        session: projectBrowserDto(request.params.projectId, response.session),
        upload: response.upload,
      };
    } catch (error) {
      return browserRouteError(reply, error);
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { pageId?: string } }>(
    `${projectBrowserRoute}/frame`,
    async (request, reply) => {
      if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
      try {
        const frame = await projectBrowserSessions.captureFrame(projectBrowserScope(request.params.projectId), request.query.pageId);
        return reply
          .type("image/png")
          .header("cache-control", "private, no-store")
          .header("x-ponderosa-browser-revision", String(frame.revision))
          .header("x-ponderosa-browser-frame", JSON.stringify(frame.metadata))
          .send(frame.body);
      } catch (error) {
        return browserRouteError(reply, error);
      }
    },
  );
  registerPreviewStream(`${projectBrowserRoute}/frame-stream`, projectBrowserSessions, params => projectBrowserScope(params.projectId));

  const browserRoute = "/api/projects/:projectId/agents/:id/runs/:runId/browser";

  app.get<{
    Params: { projectId: string };
    Querystring: { conversationId?: string };
  }>("/api/projects/:projectId/browser-sessions", async (request, reply) => {
    if (!projectExists(request.params.projectId)) {
      return reply.code(404).send({ error: "project not found" });
    }
    return browserSessions.listActive(
      request.params.projectId,
      request.query.conversationId,
    );
  });

  app.get<{ Params: BrowserRouteParams }>(browserRoute, async (request, reply) => {
    try {
      const scope = operatorBrowserScope(request.params);
      const session = browserSessions.get(scope.agentId);
      if (
        !session
        || session.runId !== scope.runId
        || session.projectId !== scope.projectId
        || session.conversationId !== scope.conversationId
      ) {
        return reply.code(404).send({ error: "browser session has not been opened for this run" });
      }
      return session;
    } catch (error) {
      return browserRouteError(reply, error);
    }
  });

  app.post<{ Params: BrowserRouteParams }>(browserRoute, async (request, reply) => {
    try {
      return await browserSessions.open(operatorBrowserScope(request.params));
    } catch (error) {
      return browserRouteError(reply, error);
    }
  });

  app.post<{ Params: BrowserRouteParams }>(`${browserRoute}/reconnect`, async (request, reply) => {
    try {
      return await browserSessions.reconnect(operatorBrowserScope(request.params));
    } catch (error) {
      return browserRouteError(reply, error);
    }
  });

  app.post<{ Params: BrowserRouteParams; Body: { url: string } }>(`${browserRoute}/navigate`, async (request, reply) => {
    if (typeof request.body?.url !== "string") return reply.code(400).send({ error: "url is required" });
    try { return await browserSessions.navigate(operatorBrowserScope(request.params), request.body.url, "operator"); }
    catch (error) { return browserRouteError(reply, error); }
  });

  app.delete<{ Params: BrowserRouteParams }>(browserRoute, async (request, reply) => {
    try {
      return await browserSessions.close(operatorBrowserScope(request.params), "operator_closed");
    } catch (error) {
      return browserRouteError(reply, error);
    }
  });

  app.put<{ Params: BrowserRouteParams; Body: BrowserControlRequest }>(
    `${browserRoute}/control`,
    async (request, reply) => {
      try {
        if (
          (request.body?.owner !== "agent" && request.body?.owner !== "operator")
          || !Number.isSafeInteger(request.body?.expectedControlEpoch)
        ) {
          return reply.code(400).send({ error: "owner and expectedControlEpoch are required" });
        }
        return await browserSessions.setControl(
          operatorBrowserScope(request.params),
          request.body.owner,
          request.body.expectedControlEpoch,
        );
      } catch (error) {
        return browserRouteError(reply, error);
      }
    },
  );

  app.post<{ Params: BrowserRouteParams; Body: BrowserOperatorInputRequest }>(
    `${browserRoute}/input`,
    async (request, reply) => {
      try {
        if (
          !request.body
          || !["click", "type", "key", "scroll"].includes(request.body.kind)
          || !Number.isSafeInteger(request.body.expectedControlEpoch)
        ) {
          return reply.code(400).send({ error: "valid input and expectedControlEpoch are required" });
        }
        return await browserSessions.operatorInput(operatorBrowserScope(request.params), request.body);
      } catch (error) {
        return browserRouteError(reply, error);
      }
    },
  );

  app.put<{
    Params: BrowserRouteParams & { pageId: string };
    Body: { expectedControlEpoch: number };
  }>(browserRoute + "/pages/:pageId/active", async (request, reply) => {
    if (!Number.isSafeInteger(request.body?.expectedControlEpoch)) {
      return reply.code(400).send({ error: "expectedControlEpoch is required" });
    }
    try {
      return await browserSessions.activatePage(
        operatorBrowserScope(request.params),
        request.params.pageId,
        "operator",
        request.body.expectedControlEpoch,
      );
    } catch (error) {
      return browserRouteError(reply, error);
    }
  });

  app.delete<{
    Params: BrowserRouteParams & { pageId: string };
    Body: { expectedControlEpoch: number };
  }>(browserRoute + "/pages/:pageId", async (request, reply) => {
    if (!Number.isSafeInteger(request.body?.expectedControlEpoch)) {
      return reply.code(400).send({ error: "expectedControlEpoch is required" });
    }
    try {
      return await browserSessions.closePage(
        operatorBrowserScope(request.params),
        request.params.pageId,
        "operator",
        request.body.expectedControlEpoch,
      );
    } catch (error) {
      return browserRouteError(reply, error);
    }
  });

  app.delete<{
    Params: BrowserRouteParams;
    Body: { expectedControlEpoch: number };
  }>(browserRoute + "/file-chooser", async (request, reply) => {
    if (!Number.isSafeInteger(request.body?.expectedControlEpoch)) {
      return reply.code(400).send({ error: "expectedControlEpoch is required" });
    }
    try {
      return await browserSessions.cancelFileChooser(
        operatorBrowserScope(request.params),
        "operator",
        request.body.expectedControlEpoch,
      );
    } catch (error) {
      return browserRouteError(reply, error);
    }
  });

  app.post<{
    Params: BrowserRouteParams;
    Body: BrowserUploadRequest;
  }>(browserRoute + "/upload", async (request, reply) => {
    if (!request.body || typeof request.body.artifactId !== "string" ||
        !Number.isSafeInteger(request.body.expectedControlEpoch) ||
        (request.body.selector !== undefined && typeof request.body.selector !== "string")) {
      return reply.code(400).send({ error: "artifactId and expectedControlEpoch are required" });
    }
    try {
      return await browserSessions.upload(
        operatorBrowserScope(request.params),
        request.body.artifactId,
        request.body.selector,
        "operator",
        request.body.expectedControlEpoch,
      );
    } catch (error) {
      return browserRouteError(reply, error);
    }
  });

  app.get<{ Params: BrowserRouteParams; Querystring: { pageId?: string } }>(`${browserRoute}/frame`, async (request, reply) => {
    try {
      const frame = await browserSessions.captureFrame(operatorBrowserScope(request.params), request.query.pageId);
      return reply
        .type("image/png")
        .header("cache-control", "private, no-store")
        .header("x-ponderosa-browser-revision", String(frame.revision))
        .header("x-ponderosa-browser-frame", JSON.stringify(frame.metadata))
        .send(frame.body);
    } catch (error) {
      return browserRouteError(reply, error);
    }
  });
  registerPreviewStream(`${browserRoute}/frame-stream`, browserSessions, operatorBrowserScope);

  for (const projectScoped of [true, false]) {
    const route = projectScoped ? projectBrowserRoute : browserRoute;
    const manager = projectScoped ? projectBrowserSessions : browserSessions;
    const scope = (params: BrowserRouteParams) => projectScoped ? projectBrowserScope(params.projectId) : operatorBrowserScope(params);
    app.post<{ Params: BrowserRouteParams; Body: { expectedControlEpoch: number } }>(`${route}/pages`, async (request, reply) => {
      if (projectScoped) { const blocked = projectMutationGuard(request.params.projectId, reply); if (blocked) return blocked; }
      if (!Number.isSafeInteger(request.body?.expectedControlEpoch)) return reply.code(400).send({ error: "expectedControlEpoch is required" });
      try {
        const session = await manager.newPage(scope(request.params), request.body.expectedControlEpoch);
        return projectScoped ? projectBrowserDto(request.params.projectId, session) : session;
      } catch (error) { return browserRouteError(reply, error); }
    });
    app.put<{ Params: BrowserRouteParams & { pageId: string }; Body: { width: number; height: number; expectedControlEpoch: number } }>(`${route}/pages/:pageId/viewport`, async (request, reply) => {
      if (projectScoped) { const blocked = projectMutationGuard(request.params.projectId, reply); if (blocked) return blocked; }
      if (!Number.isSafeInteger(request.body?.expectedControlEpoch)) return reply.code(400).send({ error: "expectedControlEpoch is required" });
      try {
        await manager.resizeViewport(scope(request.params), request.params.pageId, { width: request.body.width, height: request.body.height }, request.body.expectedControlEpoch);
        return { ok: true };
      } catch (error) { return browserRouteError(reply, error); }
    });
  }
}
