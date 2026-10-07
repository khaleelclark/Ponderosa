import type { CommunicationDocumentRecord, CommunicationEvent } from "@ponderosa/core";
import type { AgentStore } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import { requestProduct, resourceInProduct } from "../product-scope.js";
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
    if (event.sender.kind === "agent" &&
        !resourceInProduct(store, "agent", event.sender.agentId, product)) return false;
    if (found.document.authorAgentId &&
        !resourceInProduct(store, "agent", found.document.authorAgentId, product)) return false;
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
