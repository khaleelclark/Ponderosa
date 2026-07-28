import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import type {
  DraftAttachmentDto,
  PutConversationDraftRequest,
} from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import {
  ASSET_LIMITS,
  AssetError,
  contentDisposition,
  prepareAssetUpload,
} from "../assets.js";

export class DraftService {
  private readonly root: string;
  private readonly attachmentId = /^[a-f0-9-]{36}$/i;
  private readonly ownerId = /^[A-Za-z0-9_-]{1,128}$/;

  constructor(
    dataDir: string,
    private readonly store: Pick<
      AgentStore,
      "getAgent" | "getConversation"
    >,
    private readonly workspace: Pick<
      WorkspaceStore,
      "getDraft" | "listDraftConflicts" | "putDraft" | "cursor"
    >,
  ) {
    this.root = path.resolve(dataDir, "draft-attachments");
  }

  normalizedOwner(value: unknown): string | undefined {
    return typeof value === "string" && this.ownerId.test(value)
      ? value
      : undefined;
  }

  surfaceDir(draftId: string): string {
    return path.join(
      this.root,
      createHash("sha256").update(draftId).digest("hex"),
    );
  }

  attachmentDir(draftId: string, ownerId: string): string {
    return path.join(
      this.surfaceDir(draftId),
      createHash("sha256").update(ownerId).digest("hex"),
    );
  }

  files(draftId: string, ownerId: string, id: string) {
    const directory = this.attachmentDir(draftId, ownerId);
    return {
      body: path.join(directory, `${id}.bin`),
      metadata: path.join(directory, `${id}.json`),
    };
  }

  async read(
    draftId: string,
    ownerId: string,
    id: string,
  ): Promise<DraftAttachmentDto | undefined> {
    if (!this.attachmentId.test(id)) return undefined;
    const files = this.files(draftId, ownerId, id);
    try {
      const parsed = JSON.parse(
        await fs.readFile(files.metadata, "utf8"),
      ) as Omit<DraftAttachmentDto, "downloadUrl">;
      const stat = await fs.stat(files.body);
      if (
        !stat.isFile() ||
        parsed.id !== id ||
        parsed.conversationId !== draftId ||
        parsed.ownerId !== ownerId ||
        parsed.size !== stat.size
      ) {
        return undefined;
      }
      return {
        ...parsed,
        downloadUrl: `/api/conversations/${encodeURIComponent(draftId)}/draft-attachments/${encodeURIComponent(id)}?ownerId=${encodeURIComponent(ownerId)}`,
      };
    } catch {
      return undefined;
    }
  }

  async hydrate(draftId: string, ownerId: string) {
    const draft = this.workspace.getDraft(draftId, ownerId);
    const attachments = (
      await Promise.all(
        draft.attachmentIds.map(id => this.read(draftId, ownerId, id)),
      )
    ).filter((item): item is DraftAttachmentDto => Boolean(item));
    return { ...draft, attachments };
  }

  validId(draftId: string): boolean {
    if (this.store.getConversation(draftId)) return true;
    const separator = draftId.indexOf(":");
    if (separator < 1) return false;
    const kind = draftId.slice(0, separator);
    const id = draftId.slice(separator + 1);
    if (!id || id.includes(":")) return false;
    if (kind === "collaboration") {
      return Boolean(this.store.getConversation(id));
    }
    if (kind === "agent") return Boolean(this.store.getAgent(id));
    return false;
  }
}

export function registerDraftRoutes(
  app: FastifyInstance,
  service: DraftService,
  workspace: Pick<
    WorkspaceStore,
    "cursor" | "listDraftConflicts" | "putDraft"
  >,
  maxAttachmentsPerMessage: number,
  publishWorkspaceSince: (cursor: number) => unknown,
): void {
  app.get<{
    Params: { id: string };
    Querystring: { ownerId?: string };
  }>("/api/conversations/:id/draft", async (request, reply) => {
    if (!service.validId(request.params.id)) {
      return reply.code(404).send({ error: "draft surface not found" });
    }
    const ownerId = service.normalizedOwner(request.query.ownerId);
    if (!ownerId) {
      return reply.code(400).send({ error: "draft owner is required" });
    }
    return service.hydrate(request.params.id, ownerId);
  });

  app.get<{
    Params: { id: string };
    Querystring: { ownerId?: string };
  }>("/api/conversations/:id/draft-conflicts", async (request, reply) => {
    if (!service.validId(request.params.id)) {
      return reply.code(404).send({ error: "draft surface not found" });
    }
    const ownerId = service.normalizedOwner(request.query.ownerId);
    if (!ownerId) {
      return reply.code(400).send({ error: "draft owner is required" });
    }
    return workspace.listDraftConflicts(request.params.id, ownerId);
  });

  app.put<{
    Params: { id: string };
    Body: PutConversationDraftRequest;
  }>("/api/conversations/:id/draft", async (request, reply) => {
    if (!service.validId(request.params.id)) {
      return reply.code(404).send({ error: "draft surface not found" });
    }
    const ownerId = service.normalizedOwner(request.body?.ownerId);
    if (
      !ownerId ||
      !request.body?.clientId ||
      !Number.isSafeInteger(request.body.expectedRevision) ||
      !Array.isArray(request.body.attachmentIds)
    ) {
      return reply.code(400).send({ error: "invalid draft update" });
    }
    if (
      request.body.attachmentIds.length > maxAttachmentsPerMessage ||
      new Set(request.body.attachmentIds).size !==
        request.body.attachmentIds.length
    ) {
      return reply.code(400).send({
        error: `at most ${maxAttachmentsPerMessage} unique draft attachments are allowed`,
      });
    }
    const referenced = await Promise.all(
      request.body.attachmentIds.map(id =>
        service.read(request.params.id, ownerId, id),
      ),
    );
    if (referenced.some(item => !item)) {
      return reply.code(400).send({
        error:
          "draft attachment is missing or belongs to another conversation",
      });
    }
    const cursor = workspace.cursor();
    try {
      workspace.putDraft(request.params.id, { ...request.body, ownerId });
      publishWorkspaceSince(cursor);
      return service.hydrate(request.params.id, ownerId);
    } catch (error) {
      if ((error as { code?: string }).code === "DRAFT_CONFLICT") {
        return reply.code(409).send({
          current: await service.hydrate(request.params.id, ownerId),
          displaced: (error as { displaced: unknown }).displaced,
        });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string }; Body: Buffer }>(
    "/api/conversations/:id/draft-attachments",
    async (request, reply) => {
      if (!service.validId(request.params.id)) {
        return reply.code(404).send({ error: "draft surface not found" });
      }
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        return reply.code(400).send({ error: "attachment body is required" });
      }
      if (request.body.length > ASSET_LIMITS.maxFileBytes) {
        return reply
          .code(413)
          .send({ error: "draft attachment exceeds 8 MiB" });
      }
      const declaredMediaType = String(
        request.headers["x-ponderosa-media-type"] ?? "",
      ).toLowerCase();
      const ownerId = service.normalizedOwner(
        request.headers["x-ponderosa-draft-owner"],
      );
      if (!ownerId) {
        return reply.code(400).send({ error: "draft owner is required" });
      }
      const suppliedName = String(
        request.headers["x-ponderosa-filename"] ?? "attachment",
      ).replace(/[\u0000-\u001f\u007f]/g, "");
      const requestedName =
        path.basename(suppliedName).slice(0, 240) || "attachment";
      let prepared;
      try {
        prepared = await prepareAssetUpload({
          body: request.body,
          name: requestedName,
          declaredType: declaredMediaType,
        });
      } catch (error) {
        if (error instanceof AssetError) {
          return reply.code(error.statusCode).send({
            error: `${requestedName}: ${error.message}`,
          });
        }
        throw error;
      }
      const { name, mediaType } = prepared;
      const id = randomUUID();
      const directory = service.attachmentDir(request.params.id, ownerId);
      const files = service.files(request.params.id, ownerId, id);
      const createdAt = new Date().toISOString();
      const metadata: Omit<DraftAttachmentDto, "downloadUrl"> = {
        id,
        conversationId: request.params.id,
        ownerId,
        name,
        mediaType,
        size: request.body.length,
        createdAt,
      };
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temp = `${files.body}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, request.body, {
          mode: 0o600,
          flag: "wx",
        });
        await fs.rename(temp, files.body);
        await fs.writeFile(files.metadata, JSON.stringify(metadata), {
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        await Promise.allSettled([
          fs.rm(temp, { force: true }),
          fs.rm(files.body, { force: true }),
          fs.rm(files.metadata, { force: true }),
        ]);
        throw error;
      }
      return reply.code(201).send({
        ...metadata,
        downloadUrl: `/api/conversations/${encodeURIComponent(request.params.id)}/draft-attachments/${encodeURIComponent(id)}?ownerId=${encodeURIComponent(ownerId)}`,
      });
    },
  );

  app.get<{
    Params: { id: string; attachmentId: string };
    Querystring: { ownerId?: string };
  }>(
    "/api/conversations/:id/draft-attachments/:attachmentId",
    async (request, reply) => {
      if (!service.validId(request.params.id)) {
        return reply
          .code(404)
          .send({ error: "draft attachment not found" });
      }
      const ownerId = service.normalizedOwner(request.query.ownerId);
      if (!ownerId) {
        return reply.code(400).send({ error: "draft owner is required" });
      }
      const attachment = await service.read(
        request.params.id,
        ownerId,
        request.params.attachmentId,
      );
      if (!attachment) {
        return reply
          .code(404)
          .send({ error: "draft attachment not found" });
      }
      const body = await fs.readFile(
        service.files(request.params.id, ownerId, attachment.id).body,
      );
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", contentDisposition(attachment.name))
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .send(body);
    },
  );

  app.delete<{
    Params: { id: string; attachmentId: string };
    Querystring: { ownerId?: string };
  }>(
    "/api/conversations/:id/draft-attachments/:attachmentId",
    async (request, reply) => {
      const ownerId = service.normalizedOwner(request.query.ownerId);
      if (!ownerId) {
        return reply.code(400).send({ error: "draft owner is required" });
      }
      if (
        !service.validId(request.params.id) ||
        !(await service.read(
          request.params.id,
          ownerId,
          request.params.attachmentId,
        ))
      ) {
        return reply
          .code(404)
          .send({ error: "draft attachment not found" });
      }
      const files = service.files(
        request.params.id,
        ownerId,
        request.params.attachmentId,
      );
      await Promise.all([
        fs.rm(files.body, { force: true }),
        fs.rm(files.metadata, { force: true }),
      ]);
      return reply.code(204).send();
    },
  );
}
