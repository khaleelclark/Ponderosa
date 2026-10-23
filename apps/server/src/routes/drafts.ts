import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "@ponderosa/native-host/fs";
import path from "node:path";
import {
  draftRevisionConflicts,
  type AgentStore,
  type WorkspaceStore,
} from "@ponderosa/agents";
import type {
  AssetDto,
  ConversationDraftConflictDto,
  ConversationDraftDto,
  DraftAttachmentDto,
  PutConversationDraftRequest,
  ResolveConversationDraftConflictResponse,
  RestoreConversationDraftConflictRequest,
} from "@ponderosa/core";
import {
  INLINE_TEXT_MAX_CODE_POINTS,
  LONG_TEXT_MAX_UTF8_BYTES,
  draftPendingSubmissionError,
  draftPendingSubmissionRetired,
  unicodeCodePointLength,
} from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import {
  ASSET_LIMITS,
  AssetError,
  contentDisposition,
  prepareAssetUpload,
  writeAtomic,
  type AssetStore,
  type PreparedAssetUpload,
} from "../assets.js";
import { RUNTIME_UUID } from "../asset-contracts.js";
import { retireAttachmentUpload } from "../attachment-upload-lifecycle.js";

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
  "decisionAnswers",
  "attachmentIds",
  "pastedTextAttachmentId",
  "mentionBindings",
  "pendingSubmission",
  "pendingSubmissions",
  "retirePendingSubmissionIds",
  "expectedRevision",
  "clientId",
  "ownerId",
]);
const DRAFT_ORPHAN_GRACE_MS = 5 * 60 * 1000;

export function draftUpdateBodyError(
  value: unknown,
  maxAttachmentsPerMessage: number,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "draft update must be an object";
  }
  const body = value as Record<string, unknown>;
  if (body.decisionAnswers !== undefined && (!Array.isArray(body.decisionAnswers) || body.decisionAnswers.length > 3)) return "Decision drafts accept at most three structured answers";
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
    body.attachmentIds.some(id =>
      typeof id !== "string" || !RUNTIME_UUID.test(id)) ||
    new Set(body.attachmentIds).size !== body.attachmentIds.length
  ) {
    return `at most ${maxAttachmentsPerMessage} unique draft attachment UUIDs are allowed`;
  }
  if (
    body.pastedTextAttachmentId !== undefined &&
    (typeof body.pastedTextAttachmentId !== "string" ||
      !RUNTIME_UUID.test(body.pastedTextAttachmentId))
  ) {
    return "draft pasted-text attachment must be a UUID";
  }
  if (
    body.pastedTextAttachmentId !== undefined &&
    body.attachmentIds.includes(body.pastedTextAttachmentId)
  ) {
    return "draft pasted-text attachment must be distinct from file attachments";
  }
  if (body.pendingSubmission !== undefined) {
    const error = draftPendingSubmissionError(body.pendingSubmission, maxAttachmentsPerMessage, Number(body.expectedRevision));
    if (error) return error;
  }
  if (body.retirePendingSubmissionIds !== undefined &&
    (!Array.isArray(body.retirePendingSubmissionIds) || body.retirePendingSubmissionIds.length > 32 ||
      body.retirePendingSubmissionIds.some(id => typeof id !== "string" || !id.trim() || id.length > 200) ||
      new Set(body.retirePendingSubmissionIds).size !== body.retirePendingSubmissionIds.length)) return "invalid captured retirement IDs";
  if (body.pendingSubmissions !== undefined) {
    if (!Array.isArray(body.pendingSubmissions) || body.pendingSubmissions.length > 32) return "at most 32 captured submissions are allowed";
    const ids = new Set<string>();
    let textBytes = 0;
    for (const value of body.pendingSubmissions) {
      const error = draftPendingSubmissionError(value, maxAttachmentsPerMessage, Number(body.expectedRevision), true);
      if (error) return error;
      const pending = value as Record<string, unknown>;
      if (typeof pending.text !== "string" || pending.captureRevision === undefined) return "captured text and original revision are required";
      const id = pending.idempotencyKey as string;
      if (ids.has(id) || (body.pendingSubmission as { idempotencyKey?: string } | undefined)?.idempotencyKey === id) return "duplicate captured submission IDs";
      ids.add(id);
      for (const text of [pending.text, pending.editorText, pending.pastedText]) if (typeof text === "string") textBytes += Buffer.byteLength(text, "utf8");
    }
    if (textBytes > LONG_TEXT_MAX_UTF8_BYTES) return "captured text aggregate exceeds 8 MiB";
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
  private readonly mutationLeases = new Map<string, number>();
  private readonly mutationDrainWaiters = new Map<string, Set<() => void>>();
  private readonly deletionFences = new Set<string>();
  private readonly deletionFenceGroups = new Map<string, {
    ids: string[];
    ready: Promise<void>;
    release?: () => void;
  }>();

  constructor(
    dataDir: string,
    private readonly store: Pick<
      AgentStore,
      "getAgent" | "getConversation"
    >,
    private readonly workspace: Pick<
      WorkspaceStore,
      "cursor" | "deleteDraft" | "draftRecoveryInventory" | "getDraft" |
      "listDraftConflicts" | "discardDraftConflict" | "putDraft" | "getDecision"
    >,
    private readonly cleanupAuthority: Pick<
      AssetStore,
      "enqueueDraftAttachmentCleanup" | "finishDraftAttachmentCleanup" |
      "pendingDraftAttachmentCleanups" | "releaseDraftAttachment" |
      "reserveDraftAttachment" | "settleDraftAttachment" |
      "syncDraftAttachment" | "finishDraftSurfaceCleanup" | "draftSurfaceIds"
    >,
  ) {
    this.root = path.resolve(dataDir, "draft-attachments");
  }

  normalizedOwner(value: unknown): string | undefined {
    return typeof value === "string" && this.ownerId.test(value)
      ? value
      : undefined;
  }

  canEditOwner(draftId: string, ownerId: string): boolean {
    const decision = this.workspace.getDecision?.(ownerId);
    return !decision || (decision.status === "pending" && draftId === `agent:${decision.agentId}` &&
      this.store.getAgent(decision.agentId)?.projectId === decision.projectId);
  }

  retireDecisionDraft(draftId: string, ownerId: string): void {
    const decision = this.workspace.getDecision?.(ownerId);
    if (!decision || decision.status === "pending" || draftId !== `agent:${decision.agentId}`) return;
    const empty = { attachmentIds: [] };
    for (const conflict of this.workspace.listDraftConflicts(draftId, ownerId).conflicts) {
      this.workspace.discardDraftConflict({ conversationId: draftId, ownerId, conflictId: conflict.id });
      this.enqueueReleasedAttachments(draftId, ownerId, conflict.displaced, empty);
    }
    const current = this.workspace.getDraft(draftId, ownerId);
    if (!current.text && !current.decisionAnswers?.length && !current.attachmentIds.length && !current.pastedTextAttachmentId && !current.pendingSubmission && !current.pendingSubmissions?.length) return;
    const next = this.workspace.putDraft(draftId, { ownerId, text: "", attachmentIds: [], clientId: "decision-response",
      expectedRevision: current.revision });
    this.enqueueReleasedAttachments(draftId, ownerId, current, next);
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

  acquireMutationLease(draftId: string): (() => void) | undefined {
    if (this.deletionFences.has(draftId)) return undefined;
    this.mutationLeases.set(draftId, (this.mutationLeases.get(draftId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.mutationLeases.get(draftId) ?? 1) - 1;
      if (remaining > 0) {
        this.mutationLeases.set(draftId, remaining);
        return;
      }
      this.mutationLeases.delete(draftId);
      const waiters = this.mutationDrainWaiters.get(draftId);
      this.mutationDrainWaiters.delete(draftId);
      for (const resolve of waiters ?? []) resolve();
    };
  }

  /** Prevent new mutations synchronously, then drain every admitted mutation
   * before destructive entity cleanup begins. */
  async fenceMutations(draftIds: Iterable<string>): Promise<() => void> {
    const ids = [...new Set(draftIds)];
    if (ids.some(id => this.deletionFences.has(id))) {
      throw new Error("draft deletion fence is already held");
    }
    for (const id of ids) this.deletionFences.add(id);
    await Promise.all(ids.map(id => (this.mutationLeases.get(id) ?? 0) > 0
      ? new Promise<void>(resolve => {
          const waiters = this.mutationDrainWaiters.get(id) ?? new Set();
          waiters.add(resolve);
          this.mutationDrainWaiters.set(id, waiters);
        })
      : Promise.resolve()));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of ids) this.deletionFences.delete(id);
    };
  }

  async fenceMutationGroup(key: string, draftIds: Iterable<string>): Promise<void> {
    const ids = [...new Set(draftIds)].sort();
    const existing = this.deletionFenceGroups.get(key);
    if (existing) {
      if (JSON.stringify(existing.ids) !== JSON.stringify(ids)) {
        throw new Error("draft deletion fence inventory changed");
      }
      await existing.ready;
      return;
    }
    const group: { ids: string[]; ready: Promise<void>; release?: () => void } = {
      ids,
      ready: Promise.resolve(),
    };
    group.ready = this.fenceMutations(ids).then(release => { group.release = release; });
    this.deletionFenceGroups.set(key, group);
    try { await group.ready; }
    catch (error) {
      if (this.deletionFenceGroups.get(key) === group) this.deletionFenceGroups.delete(key);
      throw error;
    }
  }

  releaseMutationGroup(key: string): void {
    const group = this.deletionFenceGroups.get(key);
    if (!group?.release) return;
    group.release();
    this.deletionFenceGroups.delete(key);
  }

  async deleteSurface(draftId: string): Promise<void> {
    await fs.rm(this.surfaceDir(draftId), { recursive: true, force: true });
    this.cleanupAuthority.finishDraftSurfaceCleanup(draftId);
  }

  attachmentReferenced(draftId: string, ownerId: string, id: string): boolean {
    const item = this.workspace.draftRecoveryInventory().find(item => item.draftId === draftId && item.ownerId === ownerId);
    return Boolean(item?.attachmentIds.includes(id) || item?.pendingAttachmentIds.includes(id));
  }

  enqueueAttachmentCleanup(
    draftId: string,
    ownerId: string,
    assetId: string,
    eligibleAt = Date.now(),
  ): void {
    this.cleanupAuthority.enqueueDraftAttachmentCleanup(
      draftId,
      ownerId,
      assetId,
      eligibleAt,
    );
  }

  reserveAttachment(
    draftId: string,
    ownerId: string,
    assetId: string,
    size: number,
  ): string {
    return this.cleanupAuthority.reserveDraftAttachment(
      draftId,
      ownerId,
      assetId,
      size,
    );
  }

  settleAttachment(reservationId: string): void {
    this.cleanupAuthority.settleDraftAttachment(reservationId);
  }

  releaseAttachment(reservationId: string): boolean {
    return this.cleanupAuthority.releaseDraftAttachment(reservationId);
  }

  enqueueReleasedAttachments(
    draftId: string,
    ownerId: string,
    previous: Pick<ConversationDraftDto, "attachmentIds" | "pastedTextAttachmentId" | "pendingSubmission" | "pendingSubmissions">,
    next: Pick<ConversationDraftDto, "attachmentIds" | "pastedTextAttachmentId" | "pendingSubmission" | "pendingSubmissions">,
  ): void {
    const ids = (value: typeof previous): string[] => [
      ...value.attachmentIds,
      ...(value.pastedTextAttachmentId ? [value.pastedTextAttachmentId] : []),
      ...[...(value.pendingSubmission ? [value.pendingSubmission] : []), ...(value.pendingSubmissions ?? [])].flatMap(pending => [
        ...(pending.draftAttachmentIds ?? []), ...(pending.editableDraftAttachmentIds ?? []),
        ...[pending.pastedTextAttachmentId, pending.editablePastedTextAttachmentId].filter((id): id is string => Boolean(id)),
      ]),
    ];
    const retained = new Set(ids(next));
    for (const id of new Set(ids(previous))) {
      if (!retained.has(id)) this.enqueueAttachmentCleanup(draftId, ownerId, id);
    }
  }

  private async deleteAttachmentFiles(
    draftId: string,
    ownerId: string,
    assetId: string,
  ): Promise<void> {
    const files = this.files(draftId, ownerId, assetId);
    for (const file of [
      files.body,
      files.preview,
      files.metadata,
      files.bodyTemp,
      files.previewTemp,
    ]) {
      try { await fs.unlink(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const directory = this.attachmentDir(draftId, ownerId);
    for (const entry of await fs.readdir(directory).catch(() => [])) {
      if (!entry.startsWith(`${assetId}.`) || !entry.endsWith(".tmp")) continue;
      await fs.unlink(path.join(directory, entry)).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    let handle;
    try { handle = await fs.open(directory, "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try { await handle.sync(); }
    finally { await handle.close(); }
  }

  async reconcileAttachmentCleanup(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const item of this.workspace.draftRecoveryInventory()) this.retireDecisionDraft(item.draftId, item.ownerId);
    for (const receipt of this.cleanupAuthority.pendingDraftAttachmentCleanups(now)) {
      const releaseMutation = this.acquireMutationLease(receipt.draftId);
      if (!releaseMutation) continue;
      try {
        await this.withMutationLock(receipt.draftId, receipt.ownerId, async () => {
          const stored = await this.readStored(
            receipt.draftId,
            receipt.ownerId,
            receipt.assetId,
          );
          if (stored) {
            this.cleanupAuthority.syncDraftAttachment(
              receipt.draftId,
              receipt.ownerId,
              receipt.assetId,
              stored.size,
            );
          }
          if (this.attachmentReferenced(receipt.draftId, receipt.ownerId, receipt.assetId)) return;
          await this.deleteAttachmentFiles(receipt.draftId, receipt.ownerId, receipt.assetId);
          this.cleanupAuthority.finishDraftAttachmentCleanup(
            receipt.draftId,
            receipt.ownerId,
            receipt.assetId,
          );
          removed += 1;
        });
      } finally {
        releaseMutation();
      }
    }
    return removed;
  }

  /** Remove surfaces with no canonical owner, then backfill every referenced
   * pre-v9 file before uploads can be admitted. Future-grace cleanup receipts
   * are included because their bytes remain durable until cleanup completes. */
  async synchronizeAttachmentQuota(): Promise<number> {
    let synchronized = 0;
    const inventory = this.workspace.draftRecoveryInventory();
    const orphaned = new Set([
      ...inventory.map(item => item.draftId),
      ...this.cleanupAuthority.draftSurfaceIds(),
    ].filter(draftId => !this.validId(draftId)));
    const release = await this.fenceMutations(orphaned);
    try {
      for (const draftId of [...orphaned].sort()) {
        // File/ledger cleanup comes first: if the process stops before the
        // workspace event, that durable projection identifies the retry.
        await this.deleteSurface(draftId);
        this.workspace.deleteDraft(draftId);
      }
    } finally {
      release();
    }
    for (const item of inventory) {
      if (orphaned.has(item.draftId)) continue;
      for (const assetId of item.attachmentIds) {
        const stored = await this.readStored(item.draftId, item.ownerId, assetId);
        if (!stored) {
          throw new Error(
            `referenced draft attachment ${assetId} is missing or invalid`,
          );
        }
        this.cleanupAuthority.syncDraftAttachment(
          item.draftId,
          item.ownerId,
          assetId,
          stored.size,
        );
        synchronized += 1;
      }
      for (const assetId of item.pendingAttachmentIds) {
        if (item.attachmentIds.includes(assetId)) continue;
        const stored = await this.readStored(item.draftId, item.ownerId, assetId);
        if (!stored) continue;
        this.cleanupAuthority.syncDraftAttachment(
          item.draftId,
          item.ownerId,
          assetId,
          stored.size,
        );
        synchronized += 1;
      }
    }
    for (const receipt of this.cleanupAuthority.pendingDraftAttachmentCleanups(
      Number.MAX_SAFE_INTEGER,
    )) {
      const stored = await this.readStored(
        receipt.draftId,
        receipt.ownerId,
        receipt.assetId,
      );
      if (!stored) continue;
      this.cleanupAuthority.syncDraftAttachment(
        receipt.draftId,
        receipt.ownerId,
        receipt.assetId,
        stored.size,
      );
      synchronized += 1;
    }
    return synchronized;
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
      bodyTemp: path.join(directory, `${id}.bin.tmp`),
      metadata: path.join(directory, `${id}.json`),
      preview: path.join(directory, `${id}.preview.png`),
      previewTemp: path.join(directory, `${id}.preview.png.tmp`),
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
          || previewStat.size > 8 * 1024 * 1024
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
    return this.hydrateDraft(draft);
  }

  async hydrateDraft(draft: ConversationDraftDto) {
    const draftId = draft.conversationId;
    const ownerId = draft.ownerId;
    const attachments = (
      await Promise.all(
        draft.attachmentIds.map(id => this.read(draftId, ownerId, id)),
      )
    ).filter((item): item is DraftAttachmentDto => Boolean(item));
    const pastedTextAttachment = draft.pastedTextAttachmentId
      ? await this.read(draftId, ownerId, draft.pastedTextAttachmentId)
      : undefined;
    const capturedIds = new Set((draft.pendingSubmissions ?? []).flatMap(pending => [
      ...(pending.draftAttachmentIds ?? []), ...(pending.editableDraftAttachmentIds ?? []),
      ...[pending.pastedTextAttachmentId, pending.editablePastedTextAttachmentId].filter((id): id is string => Boolean(id)),
    ]));
    const pendingSubmissionAttachments = (await Promise.all([...capturedIds].map(id => this.read(draftId, ownerId, id))))
      .filter((item): item is DraftAttachmentDto => Boolean(item));
    return {
      ...draft,
      attachments,
      pendingSubmissionAttachments,
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

  async syncAttachmentDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, "r");
    try { await handle.sync(); }
    finally { await handle.close(); }
  }
}

export function registerDraftRoutes(
  app: FastifyInstance,
  service: DraftService,
  workspace: Pick<
    WorkspaceStore,
    "cursor" | "discardDraftConflict" | "draftConflictResolution" |
    "getDraft" | "listDraftConflicts" | "putDraft" |
    "restoreDraftConflict"
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
  }>("/api/conversations/:id/draft", { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) => {
    const releaseMutation = service.acquireMutationLease(request.params.id);
    if (!releaseMutation) {
      return reply.code(404).send({ error: "draft surface not found" });
    }
    try {
      if (!service.validId(request.params.id)) {
        return reply.code(404).send({ error: "draft surface not found" });
      }
      const body = request.body;
      const bodyError = draftUpdateBodyError(body, maxAttachmentsPerMessage);
      if (bodyError) return reply.code(400).send({ error: bodyError });
      const ownerId = service.normalizedOwner(body?.ownerId);
      if (!ownerId) return reply.code(400).send({ error: "invalid draft owner" });
      return await service.withMutationLock(request.params.id, ownerId, async () => {
        if (!service.canEditOwner(request.params.id, ownerId)) return reply.code(409).send({ error: "The Decision answer draft is no longer editable" });
        const current = workspace.getDraft(request.params.id, ownerId);
        const persist = async () => {
          const cursor = workspace.cursor();
          try {
            workspace.putDraft(request.params.id, { ...body, ownerId });
            publishWorkspaceSince(cursor);
            return service.hydrate(request.params.id, ownerId);
          } catch (error) {
            if ((error as { code?: string }).code === "DRAFT_SUBMISSION_INVALID") return reply.code(400).send({ error: (error as Error).message });
            if ((error as { code?: string }).code === "DRAFT_CONFLICT") {
              const conflictError = error as {
                conflict?: { id?: string };
                supersededConflicts?: ConversationDraftConflictDto[];
              };
              const conflict = conflictError.conflict;
              for (const superseded of conflictError.supersededConflicts ?? []) {
                for (const id of [
                  ...superseded.displaced.attachmentIds,
                  ...(superseded.displaced.pastedTextAttachmentId
                    ? [superseded.displaced.pastedTextAttachmentId]
                    : []),
                ]) {
                  service.enqueueAttachmentCleanup(request.params.id, ownerId, id);
                }
              }
              void service.reconcileAttachmentCleanup().catch(() => undefined);
              return reply.code(409).send({
                ...(conflict?.id ? { id: conflict.id } : {}),
                current: await service.hydrate(request.params.id, ownerId),
                displaced: (error as { displaced: unknown }).displaced,
              });
            }
            throw error;
          }
        };
        if (draftRevisionConflicts(
          current,
          body,
        )) {
          return persist();
        }
        const referencedIds = [
          ...body.attachmentIds,
          ...(body.pastedTextAttachmentId ? [body.pastedTextAttachmentId] : []),
          ...(body.pendingSubmissions ?? []).filter(pending => !draftPendingSubmissionRetired(current, pending)).flatMap(pending => [
            ...(pending.draftAttachmentIds ?? []), ...(pending.editableDraftAttachmentIds ?? []),
            ...[pending.pastedTextAttachmentId, pending.editablePastedTextAttachmentId].filter((id): id is string => Boolean(id)),
          ]),
        ];
        const referenced = await Promise.all(
          referencedIds.map(id =>
            service.read(request.params.id, ownerId, id),
          ),
        );
        const unavailableAttachmentIds = referencedIds.filter((_, index) => !referenced[index]);
        if (unavailableAttachmentIds.length) {
          return reply.code(400).send({
            error: "draft conflict attachment is unavailable",
            unavailableAttachmentIds,
          });
        }
        const saved = await persist();
        if (reply.sent || reply.statusCode >= 400) return saved;
        service.enqueueReleasedAttachments(request.params.id, ownerId, current, workspace.getDraft(request.params.id, ownerId));
        void service.reconcileAttachmentCleanup().catch(() => undefined);
        return saved;
      });
    } finally {
      releaseMutation();
    }
  });

  app.post<{
    Params: { id: string; conflictId: string };
    Body: RestoreConversationDraftConflictRequest;
  }>("/api/conversations/:id/draft-conflicts/:conflictId/restore", async (request, reply) => {
    const releaseMutation = service.acquireMutationLease(request.params.id);
    if (!releaseMutation) return reply.code(404).send({ error: "draft surface not found" });
    try {
      if (!service.validId(request.params.id)) {
        return reply.code(404).send({ error: "draft surface not found" });
      }
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) ||
          Object.keys(request.body).some(key => ![
            "ownerId", "expectedRevision", "clientId", "attachmentReplacements",
            "unavailableAttachmentIds",
          ].includes(key)) ||
          !Number.isSafeInteger(request.body.expectedRevision) || request.body.expectedRevision < 0 ||
          typeof request.body.clientId !== "string" || !request.body.clientId.trim() ||
          request.body.clientId.length > 200 ||
          (request.body.attachmentReplacements !== undefined &&
            (!Array.isArray(request.body.attachmentReplacements) ||
              request.body.attachmentReplacements.length > maxAttachmentsPerMessage + 1 ||
              request.body.attachmentReplacements.some(replacement =>
                !replacement || typeof replacement !== "object" || Array.isArray(replacement) ||
                Object.keys(replacement).some(key => !["fromId", "toId"].includes(key)) ||
                !RUNTIME_UUID.test(replacement.fromId) ||
                !RUNTIME_UUID.test(replacement.toId)) ||
              new Set(request.body.attachmentReplacements.map(item => item.fromId)).size !==
                request.body.attachmentReplacements.length ||
              new Set(request.body.attachmentReplacements.map(item => item.toId)).size !==
                request.body.attachmentReplacements.length)) ||
          (request.body.unavailableAttachmentIds !== undefined &&
            (!Array.isArray(request.body.unavailableAttachmentIds) ||
              request.body.unavailableAttachmentIds.length > maxAttachmentsPerMessage + 1 ||
              request.body.unavailableAttachmentIds.some(id => !RUNTIME_UUID.test(id)) ||
              new Set(request.body.unavailableAttachmentIds).size !==
                request.body.unavailableAttachmentIds.length))) {
        return reply.code(400).send({ error: "invalid draft conflict restore request" });
      }
      const ownerId = service.normalizedOwner(request.body.ownerId);
      if (!ownerId) return reply.code(400).send({ error: "invalid draft owner" });
      return await service.withMutationLock(request.params.id, ownerId, async () => {
        if (!service.canEditOwner(request.params.id, ownerId)) return reply.code(409).send({ error: "The Decision answer draft is no longer editable" });
        const prior = workspace.draftConflictResolution(request.params.conflictId);
        const conflict = workspace.listDraftConflicts(request.params.id, ownerId).conflicts
          .find(candidate => candidate.id === request.params.conflictId);
        const previousDraft = workspace.getDraft(request.params.id, ownerId);
        let restoredAttachmentIds: string[] | undefined;
        let restoredPastedTextAttachmentId: string | null | undefined;
        if (!prior) {
          if (!conflict) return reply.code(404).send({ error: "draft conflict not found" });
          const displacedIds = [
            ...conflict.displaced.attachmentIds,
            ...(conflict.displaced.pastedTextAttachmentId ? [conflict.displaced.pastedTextAttachmentId] : []),
          ];
          const replacements = new Map(
            (request.body.attachmentReplacements ?? []).map(item => [item.fromId, item.toId]),
          );
          const unavailableIds = new Set(request.body.unavailableAttachmentIds ?? []);
          if ([...replacements.keys(), ...unavailableIds].some(id => !displacedIds.includes(id)) ||
              [...unavailableIds].some(id => replacements.has(id))) {
            return reply.code(400).send({ error: "draft conflict replacement source is invalid" });
          }
          const current = workspace.getDraft(request.params.id, ownerId);
          const currentIds = new Set([
            ...current.attachmentIds,
            ...(current.pastedTextAttachmentId ? [current.pastedTextAttachmentId] : []),
          ]);
          if ([...replacements.values()].some(id => currentIds.has(id))) {
            return reply.code(409).send({ error: "draft conflict replacement is not fresh" });
          }
          const replacementSources = [...replacements.keys(), ...unavailableIds];
          const stillAvailableSources = await Promise.all(replacementSources.map(id =>
            service.read(request.params.id, ownerId, id)));
          if (stillAvailableSources.some(Boolean)) {
            return reply.code(409).send({
              error: "draft conflict replacement source is still available",
            });
          }
          restoredAttachmentIds = conflict.displaced.attachmentIds
            .filter(id => !unavailableIds.has(id))
            .map(id => replacements.get(id) ?? id);
          restoredPastedTextAttachmentId = conflict.displaced.pastedTextAttachmentId
            ? unavailableIds.has(conflict.displaced.pastedTextAttachmentId)
              ? null
              : replacements.get(conflict.displaced.pastedTextAttachmentId) ??
                conflict.displaced.pastedTextAttachmentId
            : undefined;
          const referenced = await Promise.all([
            ...conflict.displaced.attachmentIds.flatMap(id =>
              unavailableIds.has(id)
                ? []
                : [{ historicalId: id, resolvedId: replacements.get(id) ?? id }]),
            ...(conflict.displaced.pastedTextAttachmentId && restoredPastedTextAttachmentId
              ? [{
                  historicalId: conflict.displaced.pastedTextAttachmentId,
                  resolvedId: restoredPastedTextAttachmentId,
                }]
              : []),
          ].map(async item => ({
            ...item,
            attachment: await service.read(request.params.id, ownerId, item.resolvedId),
          })));
          const referencedIds = referenced.map(item => item.resolvedId);
          if (new Set(referencedIds).size !== referencedIds.length) {
            return reply.code(400).send({ error: "draft conflict replacements must be distinct" });
          }
          const missingHistoricalIds = referenced
            .filter(item => !item.attachment)
            .map(item => item.historicalId);
          if (missingHistoricalIds.length) {
            return reply.code(409).send({
              error: "draft conflict attachment is unavailable",
              unavailableAttachmentIds: missingHistoricalIds,
            });
          }
        }
        try {
          const cursor = workspace.cursor();
          const restored = workspace.restoreDraftConflict({
            conversationId: request.params.id,
            ownerId,
            conflictId: request.params.conflictId,
            expectedRevision: request.body.expectedRevision,
            clientId: request.body.clientId,
            ...(restoredAttachmentIds ? { attachmentIds: restoredAttachmentIds } : {}),
            ...(restoredPastedTextAttachmentId !== undefined
              ? { pastedTextAttachmentId: restoredPastedTextAttachmentId }
              : {}),
            attachmentReplacements: request.body.attachmentReplacements,
            unavailableAttachmentIds: request.body.unavailableAttachmentIds,
          });
          const currentDraft = restored.replayed
            ? workspace.getDraft(request.params.id, ownerId)
            : restored.draft;
          const response: ResolveConversationDraftConflictResponse = {
            conflictId: request.params.conflictId,
            action: "restored",
            replayed: restored.replayed,
            draft: await service.hydrateDraft(restored.draft),
            ...(currentDraft.revision > restored.draft.revision
              ? { currentDraft: await service.hydrateDraft(currentDraft) }
              : {}),
            attachmentReplacements: restored.attachmentReplacements,
            unavailableAttachmentIds: restored.unavailableAttachmentIds,
          };
          if (!restored.replayed) {
            service.enqueueReleasedAttachments(
              request.params.id,
              ownerId,
              previousDraft,
              restored.draft,
            );
            if (conflict?.displaced) {
              service.enqueueReleasedAttachments(
                request.params.id,
                ownerId,
                conflict.displaced,
                restored.draft,
              );
            }
          }
          publishWorkspaceSince(cursor);
          void service.reconcileAttachmentCleanup().catch(() => undefined);
          return response;
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === "DRAFT_REVISION_CHANGED" ||
              code === "DRAFT_CONFLICT_RESOLUTION_CONFLICT") {
            return reply.code(409).send({ error: (error as Error).message });
          }
          if (code === "DRAFT_CONFLICT_NOT_FOUND") {
            return reply.code(404).send({ error: (error as Error).message });
          }
          throw error;
        }
      });
    } finally {
      releaseMutation();
    }
  });

  app.delete<{
    Params: { id: string; conflictId: string };
    Querystring: { ownerId?: string };
  }>("/api/conversations/:id/draft-conflicts/:conflictId", async (request, reply) => {
    const releaseMutation = service.acquireMutationLease(request.params.id);
    if (!releaseMutation) return reply.code(404).send({ error: "draft surface not found" });
    try {
      if (!service.validId(request.params.id)) {
        return reply.code(404).send({ error: "draft surface not found" });
      }
      const ownerId = service.normalizedOwner(request.query.ownerId);
      if (!ownerId) return reply.code(400).send({ error: "draft owner is required" });
      return await service.withMutationLock(request.params.id, ownerId, async () => {
        try {
          const cursor = workspace.cursor();
          const discarded = workspace.discardDraftConflict({
            conversationId: request.params.id,
            ownerId,
            conflictId: request.params.conflictId,
          });
          const response: ResolveConversationDraftConflictResponse = {
            conflictId: request.params.conflictId,
            action: "discarded",
            replayed: discarded.replayed,
            currentDraft: await service.hydrate(request.params.id, ownerId),
          };
          publishWorkspaceSince(cursor);
          void service.reconcileAttachmentCleanup().catch(() => undefined);
          return response;
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === "DRAFT_CONFLICT_RESOLUTION_CONFLICT") {
            return reply.code(409).send({ error: (error as Error).message });
          }
          if (code === "DRAFT_CONFLICT_NOT_FOUND") {
            return reply.code(404).send({ error: (error as Error).message });
          }
          throw error;
        }
      });
    } finally {
      releaseMutation();
    }
  });

  app.post<{ Params: { id: string }; Body: Buffer }>(
    "/api/conversations/:id/draft-attachments",
    { bodyLimit: ASSET_LIMITS.maxFileBytes },
    async (request, reply) => {
      try {
        const releaseMutation = service.acquireMutationLease(request.params.id);
        if (!releaseMutation) {
          return reply.code(404).send({ error: "draft surface not found" });
        }
        try {
          if (!service.validId(request.params.id)) {
            return reply.code(404).send({ error: "draft surface not found" });
          }
          if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
            return reply.code(400).send({ error: "attachment body is required" });
          }
          if (request.body.length > ASSET_LIMITS.maxFileBytes) {
            return reply
              .code(413)
              .send({ error: "draft attachment exceeds 80 MiB" });
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
          if (!service.canEditOwner(request.params.id, ownerId)) return reply.code(409).send({ error: "The Decision answer draft is no longer editable" });
          const suppliedName = String(
            request.headers["x-ponderosa-filename"] ?? "attachment",
          ).replace(/[\u0000-\u001f\u007f]/g, "");
          const requestedName =
            path.basename(suppliedName).slice(0, 240) || "attachment";
          const id = randomUUID();
          let reservationId: string;
          try {
            reservationId = service.reserveAttachment(
              request.params.id,
              ownerId,
              id,
              request.body.length,
            );
          } catch (error) {
            if (error instanceof AssetError) {
              return reply.code(error.statusCode).send({ error: error.message });
            }
            throw error;
          }
          let prepared;
          try {
            prepared = await prepareAssetUpload({
              body: request.body,
              name: requestedName,
              declaredType: declaredMediaType,
            });
          } catch (error) {
            service.releaseAttachment(reservationId);
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
          try {
            const attachment = await service.withMutationLock(request.params.id, ownerId, async () => {
              if (!service.canEditOwner(request.params.id, ownerId)) throw new AssetError(409, "The Decision answer draft is no longer editable");
              service.enqueueAttachmentCleanup(
                request.params.id,
                ownerId,
                id,
                Date.now() + DRAFT_ORPHAN_GRACE_MS,
              );
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
              try {
                await fs.mkdir(directory, { recursive: true, mode: 0o700 });
                await writeAtomic(files.body, request.body);
                if (preview) {
                  await writeAtomic(files.preview, preview);
                }
                await writeAtomic(files.metadata, JSON.stringify(metadata));
                await service.syncAttachmentDirectory(directory);
                service.settleAttachment(reservationId);
              } catch (error) {
                service.enqueueAttachmentCleanup(request.params.id, ownerId, id);
                throw error;
              }
              return service.publicAttachment(request.params.id, ownerId, metadata);
            });
            return reply.code(201).send(attachment);
          } catch (error) {
            // The lock has retired. Await existing receipt-based cleanup before
            // releasing upload capacity; failed cleanup remains durably pending.
            await service.reconcileAttachmentCleanup().catch(() => undefined);
            if (error instanceof AssetError) {
              return reply.code(error.statusCode).send({ error: error.message });
            }
            throw error;
          } finally {
            service.releaseAttachment(reservationId);
          }
        } finally {
          releaseMutation();
        }
      } finally {
        retireAttachmentUpload(request);
      }
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
      const releaseMutation = service.acquireMutationLease(request.params.id);
      if (!releaseMutation) {
        return reply.code(404).send({ error: "draft attachment not found" });
      }
      try {
        const ownerId = service.normalizedOwner(request.query.ownerId);
        if (!ownerId) {
          return reply.code(400).send({ error: "draft owner is required" });
        }
        const cleanupRequested = await service.withMutationLock(request.params.id, ownerId, async () => {
          if (
            !service.validId(request.params.id) ||
            !(await service.read(
              request.params.id,
              ownerId,
              request.params.attachmentId,
            ))
          ) {
            reply
              .code(404)
              .send({ error: "draft attachment not found" });
            return false;
          }
          if (service.attachmentReferenced(
            request.params.id,
            ownerId,
            request.params.attachmentId,
          )) {
            reply.code(409).send({
              error: "draft attachment is still referenced",
            });
            return false;
          }
          service.enqueueAttachmentCleanup(
            request.params.id,
            ownerId,
            request.params.attachmentId,
          );
          return true;
        });
        if (!cleanupRequested) return reply;
        // Cleanup reacquires the draft lock, so run it after releasing that lock.
        await service.reconcileAttachmentCleanup();
        return reply.code(204).send();
      } finally {
        releaseMutation();
      }
    },
  );
}
