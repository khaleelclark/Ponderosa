import { CapabilityPolicyRevisionConflictError, CapabilityPolicyStore, type AgentStore } from "@ponderosa/agents";
import { BUILT_IN_CAPABILITIES, CAPABILITY_IDS } from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import type { AgentMessageCapability } from "../app-contracts.js";
import { requestProduct } from "../product-scope.js";
import { agentCreationScopeError } from "./agent-coordination.js";

/** Operator configuration; Run capabilities never authorize policy changes. */
export function registerAgentCapabilityRoutes(app: FastifyInstance, context: {
  store: AgentStore; agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  deletingAgentIds: ReadonlySet<string>; deletingProjectIds: ReadonlySet<string>;
  deletingConversationIds: ReadonlySet<string>;
}): void {
  const { store } = context;
  const policies = new CapabilityPolicyStore(store.sqlite);
  const response = (id: string) => ({
    policy: policies.get("agent", id) ?? { scopeKind: "agent", scopeId: id,
      revision: 0, restrictedCapabilityIds: [], updatedAt: "" },
    effective: policies.resolveForAgent(id),
    catalog: BUILT_IN_CAPABILITIES.filter(item => item.id === CAPABILITY_IDS.managedAgentCreate)
      .map(item => ({ ...item, available: true })),
  });
  for (const method of ["GET", "PUT"] as const) app.route<{ Params: { id: string }; Body: unknown }>({
    method, url: "/api/agents/:id/capabilities", handler: (request, reply) => {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (token && context.agentMessageCapabilities.has(token)) {
        return reply.code(403).send({ error: "Agent Run capabilities cannot configure operator policy" });
      }
      const id = request.params.id;
      const unavailable = () => requestProduct(request) !== "dev"
        ? { statusCode: 404, error: "Dev Agent policy not found" }
        : agentCreationScopeError(store, id, store.getAgent(id)?.conversationId, context, "dev");
      const denied = unavailable();
      if (denied) return reply.code(denied.statusCode).send({ error: denied.error });
      if (method === "GET") return response(id);
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).some(key => !["revision", "restrictedCapabilityIds"].includes(key))) {
        return reply.code(400).send({ error: "Invalid capability policy" });
      }
      const { revision, restrictedCapabilityIds } = body as Record<string, unknown>;
      if (!Number.isSafeInteger(revision) || (revision as number) < 0 ||
          !Array.isArray(restrictedCapabilityIds) ||
          !restrictedCapabilityIds.every(id => typeof id === "string") ||
          new Set(restrictedCapabilityIds).size !== restrictedCapabilityIds.length) {
        return reply.code(400).send({ error: "Invalid capability policy" });
      }
      try {
        return store.sqlite.transaction(() => {
          const denied = unavailable();
          if (denied) throw Object.assign(new Error(denied.error), { statusCode: denied.statusCode });
          const current = policies.get("agent", id);
          if ((current?.revision ?? 0) !== revision) throw new CapabilityPolicyRevisionConflictError(current);
          const unrelated = (ids: string[]) => ids.filter(id => id !== CAPABILITY_IDS.managedAgentCreate).sort();
          if (JSON.stringify(unrelated(restrictedCapabilityIds)) !==
              JSON.stringify(unrelated(current?.restrictedCapabilityIds ?? []))) {
            throw new Error("Only managed helper creation can be edited here");
          }
          policies.put({ scopeKind: "agent", scopeId: id, expectedRevision: revision as number,
            restrictedCapabilityIds });
          return response(id);
        })();
      } catch (error) {
        const status = error instanceof CapabilityPolicyRevisionConflictError ? 409 :
          error instanceof Error && "statusCode" in error ? Number(error.statusCode) : 400;
        return reply.code(status).send({ error: error instanceof Error ? error.message : "Policy update failed",
          ...(error instanceof CapabilityPolicyRevisionConflictError ? { current: error.current } : {}) });
      }
    },
  });
}
