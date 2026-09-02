import type { AgentStore } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import { AssetError, type AssetStore, contentDisposition } from "../assets.js";

export interface AttachmentRoutesContext {
  readonly store: Pick<AgentStore, "getAgent">;
  readonly assets: Pick<AssetStore, "content" | "read" | "remove" | "stage">;
  readonly agentDeliveryLeases: ReadonlyMap<string, number>;
  readonly deletingAttachmentKeys: Set<string>;
  readonly reconcilingAssetAgentIds: ReadonlySet<string>;
}

export function attachmentDeletionKey(agentId: string, attachmentId: string): string {
  return `${agentId}\0${attachmentId}`;
}

export function registerAttachmentRoutes(
  app: FastifyInstance,
  { agentDeliveryLeases, assets, deletingAttachmentKeys, reconcilingAssetAgentIds, store }: AttachmentRoutesContext,
): void {
  app.post<{ Params: { id: string }; Body: Buffer }>("/api/agents/:id/attachments", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    try {
      const asset = await assets.stage({
        projectId: agent.projectId,
        agentId: agent.id,
        body: request.body,
        name: request.headers["x-ponderosa-filename"],
        declaredType: String(
          request.headers["x-ponderosa-media-type"] ??
            request.headers["content-type"] ??
            "",
        ),
      });
      return reply.code(201).send(asset);
    } catch (error) {
      if (error instanceof AssetError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string; attachmentId: string } }>(
    "/api/agents/:id/attachments/:attachmentId",
    async (request, reply) => {
      const agent = store.getAgent(request.params.id);
      if (!agent) return reply.code(404).send({ error: "asset not found" });
      const content = await assets.content(
        agent.projectId,
        agent.id,
        request.params.attachmentId,
        true,
      );
      if (!content) return reply.code(404).send({ error: "asset not found" });
      return reply
        .header("content-type", "image/png")
        .header("content-disposition", "inline")
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .send(content.body);
    },
  );

  app.get<{ Params: { id: string; assetId: string } }>(
    "/api/agents/:id/assets/:assetId/preview",
    async (request, reply) => {
      const agent = store.getAgent(request.params.id);
      if (!agent) return reply.code(404).send({ error: "asset not found" });
      const content = await assets.content(
        agent.projectId,
        agent.id,
        request.params.assetId,
        true,
      );
      if (!content) return reply.code(404).send({ error: "asset not found" });
      return reply
        .header("content-type", "image/png")
        .header("content-disposition", "inline")
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .send(content.body);
    },
  );

  app.get<{ Params: { id: string; assetId: string } }>(
    "/api/agents/:id/assets/:assetId/download",
    async (request, reply) => {
      if (request.headers.range) {
        return reply
          .code(416)
          .header("accept-ranges", "none")
          .send({ error: "range requests are not supported" });
      }
      const agent = store.getAgent(request.params.id);
      if (!agent) return reply.code(404).send({ error: "asset not found" });
      const content = await assets.content(
        agent.projectId,
        agent.id,
        request.params.assetId,
        false,
      );
      if (!content) return reply.code(404).send({ error: "asset not found" });
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", contentDisposition(content.asset.name))
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .header("accept-ranges", "none")
        .send(content.body);
    },
  );

  app.delete<{ Params: { id: string; attachmentId: string } }>(
    "/api/agents/:id/attachments/:attachmentId",
    async (request, reply) => {
      const agent = store.getAgent(request.params.id);
      if (!agent) return reply.code(404).send({ error: "asset not found" });
      const deletionKey = attachmentDeletionKey(agent.id, request.params.attachmentId);
      if ((agentDeliveryLeases.get(agent.id) ?? 0) > 0) {
        return reply.code(409).send({ error: "Agent message delivery is in progress" });
      }
      if (reconcilingAssetAgentIds.has(agent.id)) {
        return reply.code(409).send({ error: "Asset cleanup is in progress" });
      }
      if (deletingAttachmentKeys.has(deletionKey)) {
        return reply.code(409).send({ error: "Asset deletion is already in progress" });
      }
      deletingAttachmentKeys.add(deletionKey);
      try {
        const asset = await assets.read(
          agent.projectId,
          agent.id,
          request.params.attachmentId,
        );
        if (!asset) return reply.code(404).send({ error: "asset not found" });
        if (asset.state === "associated") {
          return reply.code(409).send({ error: "sent assets cannot be deleted" });
        }
        if (!(await assets.remove(agent.projectId, agent.id, request.params.attachmentId))) {
          return reply.code(404).send({ error: "asset not found" });
        }
        return reply.code(204).send();
      } finally {
        deletingAttachmentKeys.delete(deletionKey);
      }
    },
  );
}
