import type { AllChatPageDto } from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import type { SearchRoutesContext } from "../server-context.js";

export function registerSearchRoutes(
  app: FastifyInstance,
  { globalChatSearch, store, workspace }: SearchRoutesContext,
): void {
  app.get<{ Querystring: { q?: string; limit?: string } }>("/api/search", async (request, reply) => {
    try {
      return globalChatSearch(request.query);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid search query" });
    }
  });

  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/api/all-chat", async (request, reply) => {
    const requestedLimit = Number(request.query.limit ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.floor(requestedLimit))) : 50;
    if (request.query.cursor !== undefined && (!request.query.cursor || request.query.cursor.length > 4096)) {
      return reply.code(400).send({ error: "cursor must be a non-empty opaque string of at most 4096 characters" });
    }
    try {
      type CombinedCursor = {
        v: 1;
        messages?: string;
        messagesDone?: boolean;
        decisions?: { createdAt: string; id: string };
        decisionsDone?: boolean;
      };
      let combined: CombinedCursor | undefined;
      if (request.query.cursor) {
        try {
          const parsed = JSON.parse(Buffer.from(request.query.cursor, "base64url").toString("utf8")) as Partial<CombinedCursor>;
          if (parsed.v === 1) combined = parsed as CombinedCursor;
        } catch {
          // A pre-composite cursor remains a valid message cursor.
        }
      }
      const messagePage = combined?.messagesDone
        ? { items: [], history: { limit, hasMore: false } }
        : store.getAllChatPage({ limit, cursor: combined ? combined.messages : request.query.cursor });
      const decisionPage = combined?.decisionsDone
        ? { events: [], hasMore: false as const }
        : workspace.listDecisionEventPage({ limit, before: combined?.decisions });
      const decisions = decisionPage.events
        .flatMap((event) => {
          const decision = event.decision;
          const project = store.getProject(decision.projectId);
          const conversation = decision.conversationId ? store.getConversation(decision.conversationId) : undefined;
          if (!project || !conversation) return [];
          return [{
            kind: event.kind,
            id: event.id,
            createdAt: event.createdAt,
            decision,
            project: { id: project.id, label: project.label },
            source: { kind: "project" as const, conversationId: conversation.id, title: conversation.title },
          }];
        });
      const oldestDecisionEvent = decisionPage.events.at(-1);
      const hasMore = messagePage.history.hasMore || decisionPage.hasMore;
      const nextCursor: CombinedCursor = {
        v: 1,
        ...(messagePage.history.hasMore && messagePage.history.cursor
          ? { messages: messagePage.history.cursor }
          : { messagesDone: true }),
        ...(decisionPage.hasMore && oldestDecisionEvent
          ? { decisions: { createdAt: oldestDecisionEvent.createdAt, id: oldestDecisionEvent.id } }
          : { decisionsDone: true }),
      };
      return {
        items: messagePage.items,
        decisions,
        history: {
          limit,
          hasMore,
          ...(hasMore ? { cursor: Buffer.from(JSON.stringify(nextCursor)).toString("base64url") } : {}),
        },
      } satisfies AllChatPageDto;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid All Chat cursor" });
    }
  });

  // Keep the former agent-search URL useful for old clients while returning the
  // same shared DTO and projection semantics as global search.
  app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string } }>("/api/agents/:id/search", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    try {
      const response = globalChatSearch(request.query);
      return {
        ...response,
        results: response.results.filter((result) => result.chat.kind === "agent" && result.chat.id === agent.id),
        recentChats: response.recentChats.filter((recent) => recent.chat.kind === "agent" && recent.chat.id === agent.id),
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid search query" });
    }
  });
}
