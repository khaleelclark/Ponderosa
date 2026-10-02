import type { AllChatPageDto } from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import type { SearchRoutesContext } from "../server-context.js";
import { searchWorkspaceFiles } from "../file-search.js";
import { withDecisionRecipient } from "../decision-presentation.js";
import {
  communicationRecipientAgentIds,
  recipientMentionIdentities,
  resolveAgentMentionBindings,
} from "../mention-bindings.js";

export function registerSearchRoutes(
  app: FastifyInstance,
  { globalChatSearch, store, workspace, coordinationV3 }: SearchRoutesContext,
): void {
  let filesInFlight = 0;
  app.get<{ Querystring: { q?: string; limit?: string; projectId?: string; conversationId?: string } }>("/api/search/files", async (request, reply) => {
    const q = request.query.q ?? "";
    const limit = Number(request.query.limit ?? 25);
    if (typeof q !== "string" || q.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 50) return reply.code(400).send({ error: "invalid file search query" });
    let roots = store.listProjects();
    if (request.query.conversationId) {
      const conversation = store.getConversation(request.query.conversationId);
      const project = conversation && store.getProject(conversation.projectId);
      if (!conversation || !project || conversation.projectId !== request.query.projectId || conversation.archived || conversation.deletedAt || !conversation.workingDirectory) return reply.code(404).send({ error: "Chat folder is unavailable" });
      roots = [{ ...project, hostPath: conversation.workingDirectory, label: conversation.title }];
    } else if (request.query.projectId) {
      const project = store.getProject(request.query.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      roots = [project];
    }
    if (filesInFlight >= 2) return reply.header("Retry-After", "2").code(429).send({ error: "File search is busy. Wait a moment, then try again." });
    filesInFlight++;
    try { return await searchWorkspaceFiles(roots, q, limit); }
    finally { filesInFlight--; }
  });
  app.get<{ Querystring: { q?: string; limit?: string; kind?: string; distinct?: string } }>("/api/search", async (request, reply) => {
    try {
      if (request.query.distinct !== undefined && request.query.distinct !== "chats") throw new Error("invalid search grouping");
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
        const parsed = JSON.parse(Buffer.from(request.query.cursor, "base64url").toString("utf8")) as Partial<CombinedCursor>;
        if (parsed.v !== 1) throw new Error("invalid All Chat cursor");
        combined = parsed as CombinedCursor;
      }
      const messagePage = combined?.messagesDone
        ? { items: [], history: { limit, hasMore: false } }
        : store.getAllChatPage({ limit, cursor: combined?.messages });
      const receiptMaps = new Map([...new Set(
        messagePage.items.map(item => item.project.id),
      )].map(projectId => [
        projectId,
        coordinationV3.deliveryReceiptsForCommunications(
          projectId,
          messagePage.items.flatMap(item =>
            item.project.id === projectId ? [item.communicationEventId] : []
          ),
        ),
      ] as const));
      const messageItems = messagePage.items.map(item => {
        const communication = store.getCommunicationEvent(
          item.project.id,
          item.communicationEventId,
        );
        const recipientIds = communicationRecipientAgentIds(communication);
        const deliveryReceipts = receiptMaps.get(item.project.id)
          ?.get(item.communicationEventId) ?? [];
        if (!recipientIds.length) {
          return deliveryReceipts.length ? { ...item, deliveryReceipts } : item;
        }
        const projectAgents = store.listAgents(item.project.id);
        const agentMentions = resolveAgentMentionBindings(
          item.project.id,
          item.text,
          recipientIds,
          [
            ...projectAgents,
            ...recipientMentionIdentities(
              recipientIds,
              projectAgents,
              communication?.identity?.recipientLabels,
              communication?.identity?.recipientHandles,
            ),
          ],
        );
        return agentMentions.length || deliveryReceipts.length
          ? {
              ...item,
              ...(agentMentions.length ? { agentMentions } : {}),
              ...(deliveryReceipts.length ? { deliveryReceipts } : {}),
            }
          : item;
      });
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
            ...withDecisionRecipient(store, event),
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
        items: messageItems,
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
}
