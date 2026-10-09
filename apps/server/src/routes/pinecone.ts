import type { AgentStore } from "@ponderosa/agents";
import type { PineconeProfileDto, UpdatePineconeAdmissionRequest } from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import type { AgentMessageCapability } from "../app-contracts.js";
import { requestProduct } from "../product-scope.js";
import { agentCreationScopeError } from "./agent-coordination.js";

export function registerPineconeRoutes(app: FastifyInstance, context: {
  store: AgentStore; deletingAgentIds: ReadonlySet<string>;
  deletingProjectIds: ReadonlySet<string>; deletingConversationIds: ReadonlySet<string>;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  profileChanged(profile: PineconeProfileDto): void;
  resumeAdmission(): void;
}): void {
  for (const method of ["GET", "PATCH"] as const) app.route<{ Params: { id: string }; Body: unknown }>({
    method, url: "/api/agents/:id/pinecone", handler: (request, reply) => {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (token && context.agentMessageCapabilities.has(token)) {
        return reply.code(403).send({ error: "Agent Run capabilities cannot configure Pinecone" });
      }
      const available = () => {
        const profile = context.store.getPineconeProfile(request.params.id);
        if (requestProduct(request) !== "dev" || !profile) return { statusCode: 404, error: "Pinecone profile not found" };
        return agentCreationScopeError(context.store, profile.agentId, profile.conversationId, context, "dev");
      };
      const denied = available();
      if (denied) return reply.code(denied.statusCode).send({ error: denied.error });
      if (method === "GET") return context.store.getPineconeProfile(request.params.id);
      let result: PineconeProfileDto;
      try {
        result = context.store.sqlite.transaction(() => {
          const denied = available();
          if (denied) throw Object.assign(new Error(denied.error), { statusCode: denied.statusCode });
          return context.store.updatePineconeAdmission(request.params.id, request.body as UpdatePineconeAdmissionRequest);
        })();
      } catch (error) {
        return reply.code(error instanceof Error && "statusCode" in error ? Number(error.statusCode) : 400)
          .send({ error: error instanceof Error ? error.message : "Pinecone update failed" });
      }
      // Accepted writes stay known even if a projection/signal is temporarily unavailable.
      try { context.profileChanged(result); } catch { /* Reload reconciles canonical configuration. */ }
      // Replays return the original receipt; reconcile the current state, never resurrect its old hold.
      if (context.store.getPineconeProfile(result.agentId)?.admissionState === "active") {
        try { context.resumeAdmission(); } catch { /* Normal polling also reconciles due sources. */ }
      }
      return result;
    },
  });
}
