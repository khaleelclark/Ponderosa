import { retainedChatAttachmentContent, type AgentStore } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import { AssetError, type AssetStore, contentDisposition } from "../assets.js";

export interface AttachmentRoutesContext {
  readonly store: Pick<AgentStore, "getAgent" | "getConversation">;
  readonly assets: Pick<AssetStore, "content" | "read" | "remove" | "stage">;
  readonly agentDeliveryLeases: Map<string, number>;
  readonly conversationDeliveryLeases: Map<string, number>;
  readonly conversationDeletionInProgress: (conversationId: string) => boolean;
  readonly agentDeletionInProgress: (agentId: string) => boolean;
  readonly deletingAttachmentKeys: Set<string>;
  readonly reconcilingAssetAgentIds: ReadonlySet<string>;
  readonly dataDir?: string;
}

export function attachmentDeletionKey(agentId: string, attachmentId: string): string {
  return `${agentId}\0${attachmentId}`;
}

export function registerAttachmentRoutes(
  app: FastifyInstance,
  { agentDeliveryLeases, conversationDeliveryLeases, conversationDeletionInProgress, agentDeletionInProgress, assets, deletingAttachmentKeys, reconcilingAssetAgentIds, store, dataDir }: AttachmentRoutesContext,
): void {
  app.get<{ Params: { id: string; ownerId: string; assetId: string; action: string } }>(
    "/api/conversations/:id/retained-attachments/:ownerId/:assetId/:action", async (request, reply) => {
      const conversation = store.getConversation(request.params.id);
      const preview = request.params.action === "preview";
      if (!dataDir || !conversation || conversationDeletionInProgress(conversation.id) ||
          (!preview && request.params.action !== "download")) return reply.code(404).send({ error: "Attachment unavailable" });
      if (request.headers.range) return reply.code(416).header("accept-ranges", "none").send({ error: "Range requests are not supported" });
      const content = retainedChatAttachmentContent(dataDir, conversation.projectId, conversation.id,
        request.params.ownerId, request.params.assetId, preview);
      if (!content) return reply.code(404).send({ error: "Attachment unavailable" });
      return reply.header("content-type", preview ? "image/png" : "application/octet-stream")
        .header("content-disposition", preview ? "inline" : contentDisposition(content.record.attachment.name))
        .header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox").send(content.body);
    });
  app.post<{ Params: { id: string }; Body: Buffer }>("/api/conversations/:id/attachments", { bodyLimit: 80 * 1024 * 1024 }, async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation || conversation.archived || conversationDeletionInProgress(conversation.id)) {
      return reply.code(404).send({ error: "Chat not found" });
    }
    conversationDeliveryLeases.set(conversation.id, (conversationDeliveryLeases.get(conversation.id) ?? 0) + 1);
    try {
      const asset = await assets.stage({
        projectId: conversation.projectId,
        agentId: conversation.id,
        conversationId: conversation.id,
        body: request.body,
        name: request.headers["x-ponderosa-filename"],
        declaredType: String(request.headers["x-ponderosa-media-type"] ?? ""),
      });
      return reply.code(201).send(asset);
    } catch (error) {
      if (error instanceof AssetError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    } finally {
      const remaining = (conversationDeliveryLeases.get(conversation.id) ?? 1) - 1;
      if (remaining > 0) conversationDeliveryLeases.set(conversation.id, remaining);
      else conversationDeliveryLeases.delete(conversation.id);
    }
  });

  app.get<{ Params: { id: string; assetId: string } }>("/api/conversations/:id/assets/:assetId/preview", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation) return reply.code(404).send({ error: "asset not found" });
    const content = await assets.content(conversation.projectId, conversation.id, request.params.assetId, true);
    if (!content || content.asset.conversationId !== conversation.id) return reply.code(404).send({ error: "asset not found" });
    return reply.header("content-type", "image/png")
      .header("content-disposition", "inline")
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .send(content.body);
  });

  app.get<{ Params: { id: string; assetId: string } }>("/api/conversations/:id/assets/:assetId/download", async (request, reply) => {
    if (request.headers.range) return reply.code(416).header("accept-ranges", "none").send({ error: "range requests are not supported" });
    const conversation = store.getConversation(request.params.id);
    if (!conversation) return reply.code(404).send({ error: "asset not found" });
    const content = await assets.content(conversation.projectId, conversation.id, request.params.assetId, false);
    if (!content || content.asset.conversationId !== conversation.id) return reply.code(404).send({ error: "asset not found" });
    return reply.header("content-type", "application/octet-stream")
      .header("content-disposition", contentDisposition(content.asset.name))
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .header("accept-ranges", "none")
      .send(content.body);
  });

  app.delete<{ Params: { id: string; attachmentId: string } }>("/api/conversations/:id/attachments/:attachmentId", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation || conversationDeletionInProgress(conversation.id)) return reply.code(404).send({ error: "asset not found" });
    if ((conversationDeliveryLeases.get(conversation.id) ?? 0) > 0) return reply.code(409).send({ error: "Chat message delivery is in progress" });
    const key = attachmentDeletionKey(conversation.id, request.params.attachmentId);
    if (deletingAttachmentKeys.has(key)) return reply.code(409).send({ error: "Asset deletion is already in progress" });
    deletingAttachmentKeys.add(key);
    try {
      const asset = await assets.read(conversation.projectId, conversation.id, request.params.attachmentId);
      if (!asset || asset.conversationId !== conversation.id) return reply.code(404).send({ error: "asset not found" });
      if (asset.state === "associated") return reply.code(409).send({ error: "sent assets cannot be deleted" });
      if (!(await assets.remove(conversation.projectId, conversation.id, request.params.attachmentId))) {
        return reply.code(404).send({ error: "asset not found" });
      }
      return reply.code(204).send();
    } finally {
      deletingAttachmentKeys.delete(key);
    }
  });
  app.post<{ Params: { id: string }; Body: Buffer }>("/api/agents/:id/attachments", { bodyLimit: 80 * 1024 * 1024 }, async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent || agent.archived) return reply.code(404).send({ error: "agent not found" });
    if (agentDeletionInProgress(agent.id)) {
      return reply.code(409).send({ error: "Agent deletion is in progress" });
    }
    if (reconcilingAssetAgentIds.has(agent.id)) {
      return reply.code(409).send({ error: "Asset cleanup is in progress" });
    }
    agentDeliveryLeases.set(agent.id, (agentDeliveryLeases.get(agent.id) ?? 0) + 1);
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
    } finally {
      const remaining = (agentDeliveryLeases.get(agent.id) ?? 1) - 1;
      if (remaining > 0) agentDeliveryLeases.set(agent.id, remaining);
      else agentDeliveryLeases.delete(agent.id);
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
      if (agentDeletionInProgress(agent.id)) {
        return reply.code(409).send({ error: "Agent deletion is in progress" });
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
