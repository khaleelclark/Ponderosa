import type { TeamDirectoryDto } from "@ponderosa/core";
import type { AgentStore } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { ActiveRun, AgentMessageCapability } from "../app-contracts.js";
import { decodeTimelineCursor, encodeTimelineCursor } from "../cursors.js";
import { byteBoundScopedContext, mergeScopedContextSources } from "../prompts.js";

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

  app.get<{ Querystring: { scope?: string; cursor?: string; limit?: string } }>("/api/agent-context", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const agent = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !capabilityOwnsAuthoritativeRun(capability, active) || active!.messageCapability !== token || !agent) {
      return reply.code(401).send({ error: "invalid or expired agent context capability" });
    }
    const rawLimit = request.query.limit === undefined ? 20 : Number(request.query.limit);
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) {
      return reply.code(400).send({ error: "limit must be an integer from 1 to 50" });
    }
    const requestedScope = request.query.scope ?? "current_chat";
    if (requestedScope !== "current_chat" && requestedScope !== "agent_private") {
      return reply.code(400).send({ error: "scope must be current_chat or agent_private" });
    }
    if (requestedScope === "current_chat" && !capability.conversationId) {
      return reply.code(409).send({ error: "this Run has no current Project chat" });
    }
    const contextScope = `${agent.id}:${requestedScope}:${requestedScope === "current_chat" ? capability.conversationId : "private"}`;
    let boundary: { createdAt: string; id: string } | undefined;
    try {
      boundary = request.query.cursor
        ? decodeTimelineCursor(request.query.cursor, "agent:context", contextScope)
        : undefined;
    } catch {
      return reply.code(400).send({ error: "invalid context cursor" });
    }

    const sourceLimit = rawLimit + 1;
    const privatePage = store.getAgentPrivateContextSourcePage(agent.id, {
      limit: sourceLimit,
      scope: requestedScope,
      ...(requestedScope === "current_chat" ? { conversationId: capability.conversationId! } : {}),
      ...(boundary ? { before: boundary } : {}),
      includeAuthoredBroadcasts: requestedScope === "current_chat",
    });
    const importedPage = store.getImportedHistoryMessagePage(agent.id, {
      limit: sourceLimit,
      ...(boundary ? { before: boundary } : {}),
    });
    const sharedPage = requestedScope === "current_chat" && capability.conversationId
      ? store.getOrganizationalConversationContextSourcePage(capability.conversationId, {
          limit: sourceLimit,
          ...(boundary ? { before: boundary } : {}),
        })
      : { items: [], hasMore: false };
    const merged = mergeScopedContextSources(
      requestedScope === "agent_private"
        ? [privatePage, importedPage]
        : [privatePage, importedPage, sharedPage],
      sourceLimit,
    );
    const rowBounded = merged.newest.slice(0, rawLimit);
    // Add provenance before enforcing the serialized response budget. Cross-chat
    // metadata is part of the provider-visible page, not free out-of-band data.
    const provenanceBounded = rowBounded.map((message) => {
      if (!message.communicationEventId) return message;
      const communication = store.getCommunicationEvent(agent.projectId, message.communicationEventId);
      if (!communication) return message;
      const originConversation = communication.conversationId
        ? store.getConversation(communication.conversationId)
        : undefined;
      const author = communication.sender.kind === "agent"
        ? {
            kind: "agent" as const,
            id: communication.sender.agentId,
            displayName: communication.identity?.senderLabel
              ?? store.getAgent(communication.sender.agentId)?.title
              ?? "Deleted Agent",
          }
        : {
            kind: communication.sender.kind,
            id: communication.sender.kind === "user" ? communication.sender.userId : undefined,
            ...(communication.sender.kind === "user" && communication.identity?.senderLabel
              ? { displayName: communication.identity.senderLabel }
              : {}),
          };
      return {
        ...message,
        provenance: {
          communicationEventId: communication.eventId,
          ...(communication.conversationId ? {
            originConversationId: communication.conversationId,
            originConversationTitle: communication.identity?.conversationLabel
              ?? originConversation?.title
              ?? "Deleted Chat",
          } : {}),
          timestamp: communication.createdAt,
          author,
          communicationType: communication.intent,
        },
      };
    });
    const byteBounded = byteBoundScopedContext(provenanceBounded);
    const selected = byteBounded.messages;
    const hasMore = selected.length > 0 && (merged.hasMore || merged.newest.length > rawLimit || byteBounded.truncated);
    const messages = [...selected].reverse();
    const oldest = selected.at(-1);
    return {
      scope: requestedScope === "current_chat"
        ? { kind: "project_chat", conversationId: capability.conversationId }
        : { kind: "agent_private", agentId: agent.id },
      messages,
      hasMore,
      ...(hasMore && oldest ? {
        nextCursor: encodeTimelineCursor("agent:context", contextScope, oldest.createdAt, oldest.id),
      } : {}),
    };
  });
}
