import type { FastifyInstance } from "fastify";
import { ASSET_LIMITS } from "../assets.js";
import type { ServerContext } from "../server-context.js";

export function registerLimitsRoutes(app: FastifyInstance, { limits }: ServerContext): void {
  app.get("/api/attachment-limits", async () => limits);
  app.get("/api/asset-limits", async () => ASSET_LIMITS);
}
