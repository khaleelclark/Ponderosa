import type { TeamDirectoryDto } from "@ponderosa/core";
import type { AgentStore } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { ActiveRun, AgentMessageCapability } from "../app-contracts.js";

interface AgentDirectoryRoutesContext {
  store: AgentStore;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  capabilityOwnsAuthoritativeRun(
    capability: AgentMessageCapability,
    run: ActiveRun | undefined,
  ): boolean;
  teamDirectory(
    projectId: string,
    conversationId?: string,
    fallbackAgentId?: string,
  ): TeamDirectoryDto;
}

export function registerAgentDirectoryRoutes(
  app: FastifyInstance,
  context: AgentDirectoryRoutesContext,
): void {
  const {
    store,
    agentMessageCapabilities,
    activeRuns,
    capabilityOwnsAuthoritativeRun,
    teamDirectory,
  } = context;

  app.get("/api/agent-directory", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const author = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !capabilityOwnsAuthoritativeRun(capability, active) || active!.messageCapability !== token || !author) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    return teamDirectory(author.projectId, capability.conversationId, author.id);
  });

  app.get<{ Params: { agentId: string } }>("/api/agent-directory/:agentId", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const author = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !capabilityOwnsAuthoritativeRun(capability, active) || active!.messageCapability !== token || !author) {
      return reply.code(401).send({ error: "invalid or expired agent messaging capability" });
    }
    const entry = teamDirectory(author.projectId, capability.conversationId, author.id).agents.find((agent) => agent.agentId === request.params.agentId);
    return entry ?? reply.code(404).send({ error: "agent not found in this Team Chat" });
  });

}
