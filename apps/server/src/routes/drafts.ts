import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import type {
  AssetDto,
  DraftAttachmentDto,
  PutConversationDraftRequest,
} from "@ponderosa/core";
import {
  INLINE_TEXT_MAX_CODE_POINTS,
  unicodeCodePointLength,
} from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import {
  ASSET_LIMITS,
  AssetError,
  contentDisposition,
  prepareAssetUpload,
  type PreparedAssetUpload,
} from "../assets.js";

interface StoredDraftAttachment
  extends Omit<DraftAttachmentDto, "downloadUrl" | "mediaType" | "ownerId"> {
  ownerId: string;
  mediaType: AssetDto["mediaType"];
  /** Missing only on drafts admitted before prepared upload persistence. */
  sha256?: string;
  width?: number;
  height?: number;
  previewSha256?: string;
}

const DRAFT_UPDATE_FIELDS = new Set([
  "text",
  "attachmentIds",
  "pastedTextAttachmentId",
  "mentionBindings",
  "expectedRevision",
  "clientId",
  "ownerId",
]);

export function draftUpdateBodyError(
  value: unknown,
  maxAttachmentsPerMessage: number,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "draft update must be an object";
  }
  const body = value as Record<string, unknown>;
  const unknownKey = Object.keys(body).find(
    key => !DRAFT_UPDATE_FIELDS.has(key),
  );
  if (unknownKey) return `unknown draft field: ${unknownKey}`;
  if (
    typeof body.text !== "string" ||
    unicodeCodePointLength(body.text) > INLINE_TEXT_MAX_CODE_POINTS
  ) {
    return `draft text must be a string of at most ${INLINE_TEXT_MAX_CODE_POINTS} characters`;
  }
  if (
    typeof body.clientId !== "string" ||
    !body.clientId.trim() ||
    body.clientId.length > 200
  ) {
    return "draft clientId must be a non-empty string of at most 200 characters";
  }
  if (
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0
  ) {
    return "draft expectedRevision must be a non-negative safe integer";
  }
  if (
    !Array.isArray(body.attachmentIds) ||
    body.attachmentIds.length > maxAttachmentsPerMessage ||
    body.attachmentIds.some(id => typeof id !== "string") ||
    new Set(body.attachmentIds).size !== body.attachmentIds.length
  ) {
    return `at most ${maxAttachmentsPerMessage} unique string draft attachments are allowed`;
  }
  if (
    body.pastedTextAttachmentId !== undefined &&
    (typeof body.pastedTextAttachmentId !== "string" ||
      !body.pastedTextAttachmentId)
  ) {
    return "draft pasted-text attachment must be a non-empty string";
  }
  if (
    body.pastedTextAttachmentId !== undefined &&
    body.attachmentIds.includes(body.pastedTextAttachmentId)
  ) {
    return "draft pasted-text attachment must be distinct from file attachments";
  }
  if (body.mentionBindings === undefined) return undefined;
  if (!Array.isArray(body.mentionBindings) || body.mentionBindings.length > 100) {
    return "at most 100 draft mention bindings are allowed";
  }
  const bindings = body.mentionBindings as unknown[];
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      return "invalid draft mention binding";
    }
    const fields = binding as Record<string, unknown>;
    if (
      Object.keys(fields).some(
        key => ![
          "agentId",
          "handle",
          "projectId",
          "currentHandle",
          "currentTitle",
        ].includes(key),
      ) ||
      [
        fields.agentId,
        fields.handle,
        fields.projectId,
        fields.currentHandle,
        fields.currentTitle,
      ].some(
        field =>
          typeof field !== "string" ||
          !field.trim() ||
          field.length > 300,
      )
    ) {
      return "invalid draft mention binding";
    }
  }
  const typed = bindings as unknown as NonNullable<
    PutConversationDraftRequest["mentionBindings"]
  >;
  if (
    new Set(typed.map(binding => binding.agentId)).size !== typed.length ||
    new Set(typed.map(binding => binding.handle.toLocaleLowerCase())).size !==
      typed.length
  ) {
    return "draft mention bindings must be unique";
  }
  return undefined;
}

export class DraftService {
  private readonly root: string;
  private readonly attachmentId = /^[a-f0-9-]{36}$/i;
  private readonly ownerId = /^[A-Za-z0-9_-]{1,128}$/;
  private readonly mutationTails = new Map<string, Promise<void>>();

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

  async withMutationLock<T>(
    draftId: string,
    ownerId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = `${draftId}\u0000${ownerId}`;
    const previous = this.mutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.mutationTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.mutationTails.get(key) === tail) this.mutationTails.delete(key);
    }
  }

  attachmentReferenced(draftId: string, ownerId: string, id: string): boolean {
    const draft = this.workspace.getDraft(draftId, ownerId);
    return draft.pastedTextAttachmentId === id || draft.attachmentIds.includes(id);
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
      preview: path.join(directory, `${id}.preview.png`),
    };
  }

  private async readStored(
    draftId: string,
    ownerId: string,
    id: string,
  ): Promise<StoredDraftAttachment | undefined> {
    if (!this.attachmentId.test(id)) return undefined;
    const files = this.files(draftId, ownerId, id);
    try {
      const parsed = JSON.parse(
        await fs.readFile(files.metadata, "utf8"),
      ) as StoredDraftAttachment;
      const stat = await fs.lstat(files.body);
      const image = String(parsed.mediaType).startsWith("image/");
      const hasPreparedManifest = typeof parsed.sha256 === "string";
      const preparedManifestIsValid =
        !hasPreparedManifest
        || (
          /^[a-f0-9]{64}$/u.test(parsed.sha256!)
          && (
            image
              ? Number.isSafeInteger(parsed.width)
                && (parsed.width ?? 0) > 0
                && Number.isSafeInteger(parsed.height)
                && (parsed.height ?? 0) > 0
                && typeof parsed.previewSha256 === "string"
                && /^[a-f0-9]{64}$/u.test(parsed.previewSha256)
              : parsed.width === undefined
                && parsed.height === undefined
                && parsed.previewSha256 === undefined
          )
        );
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        parsed.id !== id ||
        parsed.conversationId !== draftId ||
        parsed.ownerId !== ownerId ||
        parsed.size !== stat.size ||
        parsed.size < 1 ||
        parsed.size > ASSET_LIMITS.maxFileBytes ||
        typeof parsed.name !== "string" ||
        !parsed.name ||
        !ASSET_LIMITS.acceptedMediaTypes.includes(parsed.mediaType) ||
        !Number.isFinite(Date.parse(parsed.createdAt)) ||
        !preparedManifestIsValid
      ) {
        return undefined;
      }
      if (hasPreparedManifest && image) {
        const previewStat = await fs.lstat(files.preview);
        if (
          !previewStat.isFile()
          || previewStat.isSymbolicLink()
          || previewStat.size < 1
          || previewStat.size > ASSET_LIMITS.maxFileBytes
        ) {
          return undefined;
        }
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  publicAttachment(
    draftId: string,
    ownerId: string,
    stored: StoredDraftAttachment,
  ): DraftAttachmentDto {
    const {
      sha256: _sha256,
      width: _width,
      height: _height,
      previewSha256: _previewSha256,
      ...attachment
    } = stored;
    return {
      ...attachment,
      downloadUrl: `/api/conversations/${encodeURIComponent(draftId)}/draft-attachments/${encodeURIComponent(stored.id)}?ownerId=${encodeURIComponent(ownerId)}`,
    };
  }

  async read(
    draftId: string,
    ownerId: string,
    id: string,
  ): Promise<DraftAttachmentDto | undefined> {
    const stored = await this.readStored(draftId, ownerId, id);
    return stored
      ? this.publicAttachment(draftId, ownerId, stored)
      : undefined;
  }

  async prepared(
    draftId: string,
    ownerId: string,
    id: string,
  ): Promise<{
    attachment: DraftAttachmentDto;
    body: Buffer;
    prepared: PreparedAssetUpload;
  } | undefined> {
    const stored = await this.readStored(draftId, ownerId, id);
    if (!stored) return undefined;
    const files = this.files(draftId, ownerId, id);
    const body = await fs.readFile(files.body);
    const prepared = stored.sha256
      ? {
          name: stored.name,
          mediaType: stored.mediaType,
          sha256: stored.sha256,
          ...(stored.width !== undefined ? { width: stored.width } : {}),
          ...(stored.height !== undefined ? { height: stored.height } : {}),
          ...(stored.previewSha256
            ? {
                preview: await fs.readFile(files.preview),
                previewSha256: stored.previewSha256,
              }
            : {}),
        }
      : await prepareAssetUpload({
          body,
          name: stored.name,
          declaredType: stored.mediaType,
        });
    return {
      attachment: this.publicAttachment(draftId, ownerId, stored),
      body,
      prepared,
    };
  }

  async hydrate(draftId: string, ownerId: string) {
    const draft = this.workspace.getDraft(draftId, ownerId);
    const attachments = (
      await Promise.all(
        draft.attachmentIds.map(id => this.read(draftId, ownerId, id)),
      )
    ).filter((item): item is DraftAttachmentDto => Boolean(item));
    const pastedTextAttachment = draft.pastedTextAttachmentId
      ? await this.read(draftId, ownerId, draft.pastedTextAttachmentId)
      : undefined;
    return {
      ...draft,
      attachments,
      ...(pastedTextAttachment ? { pastedTextAttachment } : {}),
    };
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
    const body = request.body;
    const bodyError = draftUpdateBodyError(body, maxAttachmentsPerMessage);
    if (bodyError) return reply.code(400).send({ error: bodyError });
    const ownerId = service.normalizedOwner(body?.ownerId);
    if (!ownerId) return reply.code(400).send({ error: "invalid draft owner" });
    return service.withMutationLock(request.params.id, ownerId, async () => {
      const referencedIds = [
        ...body.attachmentIds,
        ...(body.pastedTextAttachmentId ? [body.pastedTextAttachmentId] : []),
      ];
      const referenced = await Promise.all(
        referencedIds.map(id =>
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
        workspace.putDraft(request.params.id, { ...body, ownerId });
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
      const {
        name,
        mediaType,
        sha256,
        width,
        height,
        preview,
        previewSha256,
      } = prepared;
      const id = randomUUID();
      const directory = service.attachmentDir(request.params.id, ownerId);
      const files = service.files(request.params.id, ownerId, id);
      const createdAt = new Date().toISOString();
      const metadata: StoredDraftAttachment = {
        id,
        conversationId: request.params.id,
        ownerId,
        name,
        mediaType,
        size: request.body.length,
        createdAt,
        sha256,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(previewSha256 ? { previewSha256 } : {}),
      };
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temp = `${files.body}.${randomUUID()}.tmp`;
      const previewTemp = `${files.preview}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, request.body, {
          mode: 0o600,
          flag: "wx",
        });
        if (preview) {
          await fs.writeFile(previewTemp, preview, {
            mode: 0o600,
            flag: "wx",
          });
        }
        await fs.rename(temp, files.body);
        if (preview) await fs.rename(previewTemp, files.preview);
        await fs.writeFile(files.metadata, JSON.stringify(metadata), {
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        await Promise.allSettled([
          fs.rm(temp, { force: true }),
          fs.rm(previewTemp, { force: true }),
          fs.rm(files.body, { force: true }),
          fs.rm(files.preview, { force: true }),
          fs.rm(files.metadata, { force: true }),
        ]);
        throw error;
      }
      return reply
        .code(201)
        .send(service.publicAttachment(request.params.id, ownerId, metadata));
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
      return service.withMutationLock(request.params.id, ownerId, async () => {
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
        if (service.attachmentReferenced(
          request.params.id,
          ownerId,
          request.params.attachmentId,
        )) {
          return reply.code(409).send({
            error: "draft attachment is still referenced",
          });
        }
        const files = service.files(
          request.params.id,
          ownerId,
          request.params.attachmentId,
        );
        await Promise.all([
          fs.rm(files.body, { force: true }),
          fs.rm(files.preview, { force: true }),
          fs.rm(files.metadata, { force: true }),
        ]);
        return reply.code(204).send();
      });
    },
  );
}
