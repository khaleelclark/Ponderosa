import { retainedChatAttachmentContent, type AgentStore, type WorkspaceStore } from "@ponderosa/agents";
import type { FastifyInstance, FastifyReply } from "fastify";
import { retireAttachmentUpload } from "../attachment-upload-lifecycle.js";
import { AssetError, type AssetStore, contentDisposition } from "../assets.js";

/** Serve only bytes already acquired and fully verified by the attachment owner.
 * Single ranges support browser media seeking; unsupported and malformed
 * forms are ignored and receive the complete representation. */
function sendAttachmentBytes(reply: FastifyReply, body: Buffer, name: string, mediaType: string, range: string | string[] | undefined, ifRange: string | string[] | undefined, playback: boolean) {
  const audio = playback && ["audio/webm", "audio/ogg", "audio/mp4"].includes(mediaType);
  if (playback && !audio) return reply.code(404).send({ error: "Audio unavailable" });
  reply.header("content-type", audio ? mediaType : "application/octet-stream")
    .header("content-disposition", audio ? "inline" : contentDisposition(name))
    .header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'; sandbox").header("accept-ranges", "bytes");
  // Without an advertised validator, an If-Range precondition is never proven.
  const match = !ifRange && typeof range === "string" && range.length <= 128 && range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return reply.send(body);
  const size = BigInt(body.length);
  const first = match[1] ? BigInt(match[1]) : undefined;
  const last = match[2] ? BigInt(match[2]) : undefined;
  if (first !== undefined && last !== undefined && last < first) return reply.send(body);
  if (size === 0n || (first !== undefined && first >= size) || (first === undefined && last === 0n)) {
    return reply.code(416).header("content-range", "bytes */" + body.length).send();
  }
  const start = first ?? (last! >= size ? 0n : size - last!);
  const end = first === undefined || last === undefined || last >= size ? size - 1n : last;
  return reply.code(206).header("content-range", "bytes " + start + "-" + end + "/" + size)
    .send(body.subarray(Number(start), Number(end + 1n)));
}

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
  readonly workspace?: Pick<WorkspaceStore, "getDecision">;
}

export function attachmentDeletionKey(agentId: string, attachmentId: string): string {
  return `${agentId}\0${attachmentId}`;
}

export function registerAttachmentRoutes(
  app: FastifyInstance,
  { agentDeliveryLeases, conversationDeliveryLeases, conversationDeletionInProgress, agentDeletionInProgress, assets, deletingAttachmentKeys, reconcilingAssetAgentIds, store, dataDir, workspace }: AttachmentRoutesContext,
): void {
  app.get<{ Params: { id: string; assetId: string; action: string } }>("/api/decisions/:id/attachments/:assetId/:action", async (request, reply) => {
    const decision = workspace?.getDecision(request.params.id);
    const file = decision?.status === "resolved" ? decision.response?.attachments?.find(item => item.id === request.params.assetId) : undefined;
    const preview = request.params.action === "preview";
    if (!decision || !file || file.agentId !== decision.agentId || (!preview && request.params.action !== "download"))
      return reply.code(404).send({ error: "Decision file unavailable" });
    const chat = decision.conversationId ? store.getConversation(decision.conversationId) : undefined;
    if (decision.conversationId && (!chat || chat.projectId !== decision.projectId || conversationDeletionInProgress(chat.id)))
      return reply.code(404).send({ error: "Decision file unavailable" });

    const agent = store.getAgent(decision.agentId);
    const content = agent && agent.projectId === decision.projectId && !agentDeletionInProgress(agent.id)
      ? await assets.content(decision.projectId, agent.id, file.id, preview)
      : dataDir && chat ? retainedChatAttachmentContent(dataDir, decision.projectId, chat.id, decision.agentId, file.id, preview) : undefined;
    if (!content) return reply.code(404).send({ error: "Decision file unavailable" });
    const verified = "asset" in content ? content.asset : content.record.attachment;
    if (verified.sha256 !== file.sha256 || verified.size !== file.size) return reply.code(404).send({ error: "Decision file unavailable" });
    if (!preview) return sendAttachmentBytes(reply, content.body, file.name, verified.mediaType, request.headers.range, request.headers["if-range"], (request.query as {playback?: string}).playback === "audio");
    return reply.header("content-type", "image/png").header("content-disposition", "inline").header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'; sandbox").send(content.body);
  });
  app.get<{ Params: { id: string; ownerId: string; assetId: string; action: string } }>(
    "/api/conversations/:id/retained-attachments/:ownerId/:assetId/:action", async (request, reply) => {
      const conversation = store.getConversation(request.params.id);
      const preview = request.params.action === "preview";
      if (!dataDir || !conversation || conversationDeletionInProgress(conversation.id) ||
          (!preview && request.params.action !== "download")) return reply.code(404).send({ error: "Attachment unavailable" });

      const content = retainedChatAttachmentContent(dataDir, conversation.projectId, conversation.id,
        request.params.ownerId, request.params.assetId, preview);
      if (!content) return reply.code(404).send({ error: "Attachment unavailable" });
      if (!preview) return sendAttachmentBytes(reply, content.body, content.record.attachment.name, content.record.attachment.mediaType, request.headers.range, request.headers["if-range"], (request.query as {playback?: string}).playback === "audio");
      return reply.header("content-type", "image/png").header("content-disposition", "inline")
        .header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox").send(content.body);
    });
  app.post<{ Params: { id: string }; Body: Buffer }>("/api/conversations/:id/attachments", { bodyLimit: 80 * 1024 * 1024 }, async (request, reply) => {
    try {
      const conversation = store.getConversation(request.params.id);
      if (!conversation || conversationDeletionInProgress(conversation.id)) {
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
    } finally {
      retireAttachmentUpload(request);
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

    const conversation = store.getConversation(request.params.id);
    if (!conversation) return reply.code(404).send({ error: "asset not found" });
    const content = await assets.content(conversation.projectId, conversation.id, request.params.assetId, false);
    if (!content || content.asset.conversationId !== conversation.id) return reply.code(404).send({ error: "asset not found" });
    return sendAttachmentBytes(reply, content.body, content.asset.name, content.asset.mediaType, request.headers.range, request.headers["if-range"], (request.query as {playback?: string}).playback === "audio");
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
    try {
      const agent = store.getAgent(request.params.id);
      if (!agent) return reply.code(404).send({ error: "agent not found" });
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
    } finally {
      retireAttachmentUpload(request);
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
      const agent = store.getAgent(request.params.id);
      if (!agent) return reply.code(404).send({ error: "asset not found" });
      const content = await assets.content(
        agent.projectId,
        agent.id,
        request.params.assetId,
        false,
      );
      if (!content) return reply.code(404).send({ error: "asset not found" });
      return sendAttachmentBytes(reply, content.body, content.asset.name, content.asset.mediaType, request.headers.range, request.headers["if-range"], (request.query as {playback?: string}).playback === "audio");
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
