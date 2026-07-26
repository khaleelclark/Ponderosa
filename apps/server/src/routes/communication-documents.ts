import type { CommunicationDocumentRecord, CommunicationEvent } from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
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
): void {
  app.get<{ Params: { projectId: string; documentId: string } }>(
    "/api/projects/:projectId/communication-documents/:documentId",
    async (request, reply) => {
      const found = authoritativeCommunicationDocument(request.params.projectId, request.params.documentId);
      if (!found) return reply.code(404).send({ error: "document not found" });
      const { content, ...metadata } = found.document;
      const root = `/api/projects/${encodeURIComponent(request.params.projectId)}/communication-documents/${encodeURIComponent(found.document.id)}`;
      return { ...metadata, previewUrl: root, downloadUrl: `${root}/download`, content };
    },
  );

  app.get<{ Params: { projectId: string; documentId: string } }>(
    "/api/projects/:projectId/communication-documents/:documentId/download",
    async (request, reply) => {
      const found = authoritativeCommunicationDocument(request.params.projectId, request.params.documentId);
      if (!found) return reply.code(404).send({ error: "document not found" });
      return reply.type("text/markdown; charset=utf-8")
        .header("Content-Disposition", contentDisposition(`${found.document.title}.md`))
        .send(found.document.content);
    },
  );
}
