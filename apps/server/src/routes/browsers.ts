import type {
  BrowserControlRequest,
  BrowserOperatorInputRequest,
  ProjectBrowserControlRequest,
  ProjectBrowserNavigateRequest,
  ProjectBrowserSessionDto,
  BrowserUploadRequest,
} from "@ponderosa/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  BrowserSessionError,
  type BrowserScope,
  type BrowserSessionManager,
} from "../browser-session-manager.js";

export type ProjectBrowserGrant = { agentId: string; runId: string };

interface ActiveProjectBrowserController {
  grant: ProjectBrowserGrant;
  privateScope(): BrowserScope | undefined;
}

interface BrowserRoutesContext {
  browserSessions: BrowserSessionManager;
  projectBrowserSessions: BrowserSessionManager;
  projectExists(projectId: string): boolean;
  projectDeletionInProgress(projectId: string): boolean;
  operatorBrowserScope(params: BrowserRouteParams): BrowserScope;
  projectBrowserScope(projectId: string, grant?: ProjectBrowserGrant): BrowserScope;
  projectBrowserDto(projectId: string, session: import("@ponderosa/core").BrowserSessionDto): ProjectBrowserSessionDto;
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
  const {
    browserSessions,
    projectBrowserSessions,
    projectExists,
    projectDeletionInProgress,
    operatorBrowserScope,
    projectBrowserScope,
    projectBrowserDto,
    getProjectBrowserGrant,
    setProjectBrowserGrant,
    deleteProjectBrowserGrant,
    activeProjectBrowserController,
  } = context;
  const projectBrowserRoute = "/api/projects/:projectId/browser";

  app.get<{ Params: { projectId: string } }>(projectBrowserRoute, async (request, reply) => {
    if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
    const scope = projectBrowserScope(request.params.projectId);
    const session = projectBrowserSessions.get(scope.agentId);
    if (!session) return reply.code(404).send({ error: "project browser has not been opened" });
    return projectBrowserDto(request.params.projectId, session);
  });

  app.post<{ Params: { projectId: string }; Body: Partial<ProjectBrowserNavigateRequest> }>(
    projectBrowserRoute,
    async (request, reply) => {
      if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
      if (projectDeletionInProgress(request.params.projectId)) {
        return reply.code(409).send({ error: "Project deletion is in progress" });
      }
      try {
        const scope = projectBrowserScope(request.params.projectId);
        const session = await projectBrowserSessions.open(scope, request.body?.url, "operator");
        return projectBrowserDto(request.params.projectId, session);
      } catch (error) {
        return browserRouteError(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string }; Body: ProjectBrowserNavigateRequest }>(
    `${projectBrowserRoute}/navigate`,
    async (request, reply) => {
      if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
      if (projectDeletionInProgress(request.params.projectId)) {
        return reply.code(409).send({ error: "Project deletion is in progress" });
      }
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
      if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
      if (projectDeletionInProgress(request.params.projectId)) {
        return reply.code(409).send({ error: "Project deletion is in progress" });
      }
      try {
        const scope = projectBrowserScope(request.params.projectId);
        const session = await projectBrowserSessions.reconnect(scope);
        return projectBrowserDto(request.params.projectId, session);
      } catch (error) {
        return browserRouteError(reply, error);
      }
    },
  );

  app.delete<{ Params: { projectId: string } }>(projectBrowserRoute, async (request, reply) => {
    if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
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
      if (!projectExists(projectId)) return reply.code(404).send({ error: "project not found" });
      if (projectDeletionInProgress(projectId)) {
        return reply.code(409).send({ error: "Project deletion is in progress" });
      }
      if (
        (request.body?.owner !== "agent" && request.body?.owner !== "operator")
        || !Number.isSafeInteger(request.body?.expectedControlEpoch)
      ) {
        return reply.code(400).send({ error: "owner and expectedControlEpoch are required" });
      }
      try {
        const previousGrant = getProjectBrowserGrant(projectId);
        if (request.body.owner === "operator") {
          const current = projectBrowserSessions.get(projectBrowserScope(projectId).agentId);
          if (current?.status === "ready" && current.controlOwner === "operator" && !previousGrant) {
            return projectBrowserDto(projectId, current);
          }
          const session = await projectBrowserSessions.setControl(
            projectBrowserScope(projectId, previousGrant),
            "operator",
            request.body.expectedControlEpoch,
          );
          deleteProjectBrowserGrant(projectId);
          return projectBrowserDto(projectId, session);
        }
        const controller = activeProjectBrowserController(projectId, request.body.agentId);
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
      if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
      if (projectDeletionInProgress(request.params.projectId)) {
        return reply.code(409).send({ error: "Project deletion is in progress" });
      }
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
    if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
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
    if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
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
    if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
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
    if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
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

  app.get<{ Params: { projectId: string } }>(
    `${projectBrowserRoute}/frame`,
    async (request, reply) => {
      if (!projectExists(request.params.projectId)) return reply.code(404).send({ error: "project not found" });
      try {
        const frame = await projectBrowserSessions.captureFrame(projectBrowserScope(request.params.projectId));
        return reply
          .type("image/png")
          .header("cache-control", "private, no-store")
          .header("x-ponderosa-browser-revision", String(frame.revision))
          .send(frame.body);
      } catch (error) {
        return browserRouteError(reply, error);
      }
    },
  );

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

  app.get<{ Params: BrowserRouteParams }>(`${browserRoute}/frame`, async (request, reply) => {
    try {
      const frame = await browserSessions.captureFrame(operatorBrowserScope(request.params));
      return reply
        .type("image/png")
        .header("cache-control", "private, no-store")
        .header("x-ponderosa-browser-revision", String(frame.revision))
        .send(frame.body);
    } catch (error) {
      return browserRouteError(reply, error);
    }
  });
}
