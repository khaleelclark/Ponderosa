import type { FastifyInstance } from "fastify";
import type { HealthDto } from "@ponderosa/core";
import type { ServerContext } from "../server-context.js";

export function registerHealthRoutes(app: FastifyInstance, { opts }: ServerContext): void {
  app.get("/api/health", async (_request, reply): Promise<HealthDto> => {
    reply.header("Cache-Control", "no-store");
    return {
      status: "ok",
      service: "ponderosa",
      version: opts.buildVersion?.trim() || "0.0.0",
      revision: opts.buildRevision?.trim() || "development",
    };
  });
}
