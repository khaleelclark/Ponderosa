import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../server-context.js";

export function registerWikiRoutes(
  app: FastifyInstance,
  { documentationReferences }: ServerContext,
): void {
  app.get("/api/wiki", async () => documentationReferences.index());

  app.get<{ Querystring: { q?: string; limit?: string } }>("/api/wiki/search", async (request, reply) => {
    const query = request.query.q?.trim() ?? "";
    const limit = request.query.limit === undefined ? 20 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return reply.code(400).send({ error: "limit must be an integer from 1 to 50" });
    return documentationReferences.search(query, limit);
  });

  app.get<{ Params: { id: string } }>("/api/wiki/articles/:id", async (request, reply) => {
    const article = documentationReferences.article(request.params.id);
    return article ?? reply.code(404).send({ error: "wiki article not found" });
  });

  app.get<{ Params: { name: string } }>("/api/wiki/assets/:name", async (request, reply) => {
    const asset = documentationReferences.asset(request.params.name);
    if (!asset) return reply.code(404).send({ error: "wiki asset not found" });
    return reply.type(asset.mediaType).header("cache-control", "public, max-age=3600").send(asset.body);
  });
}
