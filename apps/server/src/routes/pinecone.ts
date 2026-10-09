import type { AgentStore } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import { requestProduct } from "../product-scope.js";

export function registerPineconeRoutes(app: FastifyInstance, context: {
  store: AgentStore; deletingAgentIds: ReadonlySet<string>;
  deletingProjectIds: ReadonlySet<string>; deletingConversationIds: ReadonlySet<string>;
}): void {
  app.get<{ Params: { id: string } }>("/api/agents/:id/pinecone", (request, reply) => {
    const profile = context.store.getPineconeProfile(request.params.id);
    if (requestProduct(request) !== "dev" || !profile ||
        context.store.getAgent(profile.agentId)?.archived || context.store.getConversation(profile.conversationId)?.archived ||
        context.deletingAgentIds.has(profile.agentId) || context.deletingProjectIds.has(profile.projectId) ||
        context.deletingConversationIds.has(profile.conversationId)) {
      return reply.code(404).send({ error: "Pinecone profile not found" });
    }
    return profile;
  });
}
