import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../server-context.js";
import { parseTokenUsageRange } from "../token-usage.js";

export function registerUsageRoutes(
  app: FastifyInstance,
  { store, tokenUsage }: ServerContext,
): void {
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/usage", async (request, reply) => {
    try { return tokenUsage({ type: "overall" }, parseTokenUsageRange(request.query)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid usage range" }); }
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/api/projects/:id/usage", async (request, reply) => {
    if (!store.getProject(request.params.id)) return reply.code(404).send({ error: "project not found" });
    try { return tokenUsage({ type: "project", id: request.params.id }, parseTokenUsageRange(request.query)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid usage range" }); }
  });
}

export function registerAgentUsageRoute(
  app: FastifyInstance,
  { store, tokenUsage }: ServerContext,
): void {
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/api/agents/:id/usage", async (request, reply) => {
    if (!store.getAgentDetail(request.params.id, 1, false)) return reply.code(404).send({ error: "agent not found" });
    try { return tokenUsage({ type: "agent", id: request.params.id }, parseTokenUsageRange(request.query)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid usage range" }); }
  });
}
