import type { FastifyInstance } from "fastify";
import { workspaceFile, workspaceStatus } from "../git-status.js";
import { readScopedPath } from "../project-files.js";
import type { ServerContext } from "../server-context.js";
import type { AgentWorkingCopyService } from "../agent-working-copy-service.js";

export function registerFilesRoute(
  app: FastifyInstance,
  { store }: ServerContext,
): void {
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/conversations/:id/files", async (request, reply) => {
    const context = store.getConversation(request.params.id);
    if (!context?.workingDirectory) return reply.code(404).send({ error: "chat folder unavailable" });
    try {
      return reply.header("Cache-Control", "private, no-store").send(await readScopedPath(context.workingDirectory, request.query.path));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "file unavailable" });
    }
  });
  app.get<{ Querystring: { projectId?: string; path?: string } }>("/api/files", async (request, reply) => {
    const projectId = request.query.projectId;
    if (!projectId) return reply.code(400).send({ error: "projectId is required" });
    const project = store.getProject(projectId);
    if (!project) return reply.code(404).send({ error: "project not found" });
    try {
      return await readScopedPath(project.hostPath, request.query.path);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "invalid path" });
    }
  });
}

export function registerAgentWorkspaceRoutes(
  app: FastifyInstance,
  { store }: ServerContext,
  workingCopies: AgentWorkingCopyService,
): void {
  app.get<{ Params: { id: string } }>("/api/agents/:id/workspace", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    const project = agent ? store.getProject(agent.projectId) : undefined;
    if (!agent || !project) return reply.code(404).send({ error: "agent not found" });
    try {
      const root = await workingCopies.resolve(agent, project);
      return workspaceStatus(project.id, agent.id, agent.workingCopy, root.rootPath);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "working folder unavailable" });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/agents/:id/workspace/file", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    const project = agent ? store.getProject(agent.projectId) : undefined;
    if (!agent || !project) return reply.code(404).send({ error: "agent not found" });
    try {
      const root = await workingCopies.resolve(agent, project);
      return await workspaceFile(project.id, agent.id, root.id, root.rootPath, request.query.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid workspace path" });
    }
  });
}
