import type { CommunicationDocumentRecord, CommunicationEvent } from "@ponderosa/core";
import type { AgentStore } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import { artifactAgentInProduct, requestProduct, resourceInProduct } from "../product-scope.js";
import { contentDisposition } from "../assets.js";

type AuthoritativeCommunicationDocument = (
  projectId: string,
  documentId: string,
) => {
  event: CommunicationEvent;
  document: CommunicationDocumentRecord & { content: string };
} | undefined;

export function registerCommunicationDocumentRoutes(
  app: FastifyInstance,
  authoritativeCommunicationDocument: AuthoritativeCommunicationDocument,
  store: Pick<AgentStore, "sqlite">,
): void {
  const visible = (
    found: NonNullable<ReturnType<AuthoritativeCommunicationDocument>>,
    product: "dev" | "branches",
  ): boolean => {
    const event = found.event;
    if (!event.conversationId ||
        !resourceInProduct(store, "conversation", event.conversationId, product)) return false;
    if (!store.sqlite.prepare("SELECT 1 FROM conversations WHERE id=? AND project_id=?")
        .get(event.conversationId, event.projectId)) return false;
    // Full messages retain their validated author's original Chat custody after
    // canonical deletion clears the live pointer. Installation fences still apply.
    const authorVisible = (agentId: string): boolean =>
      artifactAgentInProduct(store, agentId, event.projectId, product) &&
      Boolean(store.sqlite.prepare(`SELECT 1 FROM agents author
        LEFT JOIN agent_deletion_tombstones tombstone ON tombstone.agent_id=author.id
          AND tombstone.project_id=author.project_id
        WHERE author.id=? AND author.project_id=?
          AND COALESCE(author.conversation_id,tombstone.conversation_id)=?
          AND NOT EXISTS(SELECT 1 FROM branch_installation_resources inactive
            WHERE inactive.local_id=author.id AND inactive.state!='active')`)
        .get(agentId, event.projectId, event.conversationId));
    if (event.sender.kind === "agent" &&
        !authorVisible(event.sender.agentId)) return false;
    if (found.document.authorAgentId &&
        !authorVisible(found.document.authorAgentId)) return false;
    return true;
  };
  app.get<{ Params: { projectId: string; documentId: string } }>(
    "/api/projects/:projectId/communication-documents/:documentId",
    async (request, reply) => {
      const found = authoritativeCommunicationDocument(request.params.projectId, request.params.documentId);
      if (!found || !visible(found, requestProduct(request))) {
        return reply.code(404).send({ error: "document not found" });
      }
      const { content, ...metadata } = found.document;
      const root = `/api/projects/${encodeURIComponent(request.params.projectId)}/communication-documents/${encodeURIComponent(found.document.id)}`;
      return { ...metadata, previewUrl: root, downloadUrl: `${root}/download`, content };
    },
  );

  app.get<{ Params: { projectId: string; documentId: string } }>(
    "/api/projects/:projectId/communication-documents/:documentId/download",
    async (request, reply) => {
      const found = authoritativeCommunicationDocument(request.params.projectId, request.params.documentId);
      if (!found || !visible(found, requestProduct(request))) {
        return reply.code(404).send({ error: "document not found" });
      }
      return reply.type("text/markdown; charset=utf-8")
        .header("Content-Disposition", contentDisposition(`${found.document.title}.md`))
        .send(found.document.content);
    },
  );
}
