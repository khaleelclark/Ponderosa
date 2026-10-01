import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { ensureSecureDirectory, listSecureDirectory, readSecureFile, removeSecureFile, secureDirectoryIdentity, writeSecureFileAtomic } from "@ponderosa/native-host";
import { decodeHeic, isHeicContainer } from "./heic.js";
import type { ArtifactDto, AssetDto } from "@ponderosa/core";
import {
  attachmentsDir,
  MANAGED_ARTIFACT_MAX_BYTES,
  managedArtifactContentPath,
  openManagedArtifactContent,
  readManagedArtifactContent,
  type RuntimeArtifactInputV3,
  type RuntimeAttachmentReservationReceiptV3,
  type AgentCreationArtifactIdentity,
} from "@ponderosa/agents";
import { AssetAuthority } from "./asset-authority.js";
import {
  ASSET_LIMITS,
  BIDI_AND_CONTROLS,
  ID,
  OWNER_ID,
  RUNTIME_UUID,
  AssetError,
  generatedArtifactIdentity,
  generatedArtifactMetadataIsValid,
  runtimeArtifactIdentityMatches,
  type AuthoritativeGeneratedArtifact,
  type AuthoritativeRuntimeArtifact,
  type AuthoritativeRuntimeAttachment,
  type GeneratedArtifactImportReceipt,
  type RegisteredGeneratedArtifact,
  type RegisteredRuntimeArtifact,
  type StoredAsset,
} from "./asset-contracts.js";

export { AssetAuthority } from "./asset-authority.js";
export { DRAFT_ASSET_LIMITS } from "./asset-contracts.js";
export { ASSET_LIMITS, AssetError, generatedArtifactMetadataIsValid } from "./asset-contracts.js";
export type {
  AuthoritativeGeneratedArtifact,
  AuthoritativeRuntimeArtifact,
  GeneratedArtifactImportReceipt,
  AuthoritativeRuntimeAttachment,
  RegisteredGeneratedArtifact,
  RuntimeAttachmentAssociation,
  StoredAsset,
} from "./asset-contracts.js";

sharp.cache({ memory: 32, files: 0, items: 20 });

// Preserve high-resolution screenshots and phone photos without lifting the
// bounded preview or unrelated text-artifact limits to the upload ceiling.
const MAX_PIXELS = 64_000_000;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_RUNTIME_TEXT_ARTIFACT_BYTES = 8 * 1024 * 1024;
const STAGED_TTL_MS = 5 * 60 * 1000;

function normalizeName(value: unknown): string {
  const raw = String(value ?? "asset").normalize("NFKC").replace(BIDI_AND_CONTROLS, "");
  const leaf = path.basename(raw).replace(/[\\/]/g, "").trim();
  const bytes = Buffer.from(leaf || "asset");
  return (bytes.length <= 160 ? leaf : bytes.subarray(0, 160).toString("utf8").replace(/\uFFFD+$/g, "")) || "asset";
}

function detectType(body: Buffer, name?: string): AssetDto["mediaType"] | undefined {
  if (isHeicContainer(body)) return "image/heic";
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (body[0] === 0xff && body[1] === 0xd8) return "image/jpeg";
  if (body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (body.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    // DOCX is an opaque ZIP-based document, not executable preview content.
    // Preserve its bytes without decompressing it or following embedded links.
    return name && path.extname(name).toLocaleLowerCase() === ".docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/zip";
  }
  if (!body.includes(0)) {
    const text = body.toString("utf8");
    if (!text.includes("\uFFFD")) {
      try { JSON.parse(text); return "application/json"; } catch { return "text/plain"; }
    }
  }
  return undefined;
}

function hasStrictImageContainer(body: Buffer, mediaType: AssetDto["mediaType"]): boolean {
  if (mediaType === "image/heic") return isHeicContainer(body);
  if (mediaType === "image/png") {
    let offset = 8;
    while (offset + 12 <= body.length) {
      const length = body.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > body.length) return false;
      const type = body.subarray(offset + 4, offset + 8).toString("ascii");
      offset = end;
      if (type === "IEND") return length === 0 && offset === body.length;
    }
    return false;
  }
  if (mediaType === "image/jpeg") return body.length >= 4 && body[body.length - 2] === 0xff && body[body.length - 1] === 0xd9;
  if (mediaType === "image/webp") return body.length >= 12 && body.readUInt32LE(4) + 8 === body.length;
  return true;
}

const ASSET_EXTENSIONS: Readonly<Record<AssetDto["mediaType"], readonly string[]>> = {
  "image/heic": [".heic", ".heif"],
  "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"],
  "application/pdf": [".pdf"], "text/plain": [".txt", ".md", ".csv", ".log"],
  "application/json": [".json"], "application/zip": [".zip"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
};

export function assetExtensionsForMediaType(mediaType: AssetDto["mediaType"]): readonly string[] {
  return ASSET_EXTENSIONS[mediaType];
}

function extensionMatches(name: string, mediaType: AssetDto["mediaType"]): boolean {
  const extension = path.extname(name).toLocaleLowerCase();
  return !extension || assetExtensionsForMediaType(mediaType).includes(extension);
}

function contentTypeMatches(declared: string | undefined, detected: AssetDto["mediaType"]): boolean {
  if (!declared || declared === "application/octet-stream") return true;
  const normalized = declared.split(";", 1)[0]?.trim().toLocaleLowerCase();
  if (detected === "image/heic" && normalized === "image/heif") return true;
  if (detected === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      && normalized === "application/zip") return true;
  if (
    detected === "text/plain"
    && ["text/markdown", "text/x-markdown", "text/csv"].includes(normalized ?? "")
  ) return true;
  return normalized === detected;
}

export interface PreparedAssetUpload {
  name: string;
  mediaType: AssetDto["mediaType"];
  sha256: string;
  width?: number;
  height?: number;
  preview?: Buffer;
  previewSha256?: string;
}

/**
 * One admission path for both durable drafts and Agent-owned assets. A draft is
 * only ready once the exact bytes are known to survive final message staging.
 */
export async function prepareAssetUpload(input: {
  body: Buffer;
  name: unknown;
  declaredType?: string;
}): Promise<PreparedAssetUpload> {
  if (!input.body.length) throw new AssetError(400, "asset body is required");
  if (input.body.length > ASSET_LIMITS.maxFileBytes) {
    throw new AssetError(413, "asset exceeds 80 MiB limit");
  }
  const name = normalizeName(input.name);
  const mediaType = detectType(input.body, name);
  if (
    !mediaType
    || !extensionMatches(name, mediaType)
    || !contentTypeMatches(input.declaredType, mediaType)
  ) {
    throw new AssetError(
      415,
      "file content, media type, and extension must agree",
    );
  }
  if (
    mediaType.startsWith("image/")
    && !hasStrictImageContainer(input.body, mediaType)
  ) {
    throw new AssetError(
      415,
      "image container is truncated or contains trailing data",
    );
  }
  const sha256 = createHash("sha256").update(input.body).digest("hex");
  if (!mediaType.startsWith("image/")) return { name, mediaType, sha256 };

  let width: number;
  let height: number;
  let preview: Buffer;
  try {
    const decoded = mediaType === "image/heic" ? await decodeHeic(input.body, MAX_PIXELS) : undefined;
    const image = sharp(decoded ? decoded.data : input.body, {
      ...(decoded ? { raw: { width: decoded.width, height: decoded.height, channels: 4 as const } } : {}),
      animated: false,
      failOn: "error",
      limitInputPixels: MAX_PIXELS,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    if (
      !metadata.width
      || !metadata.height
      || (metadata.pages ?? 1) !== 1
      || metadata.width * metadata.height > MAX_PIXELS
    ) {
      throw new Error("unsafe image dimensions");
    }
    width = metadata.width;
    height = metadata.height;
    preview = await image
      .rotate()
      .resize({
        width: 2048,
        height: 2048,
        fit: "inside",
        withoutEnlargement: true,
      })
      .timeout({ seconds: 10 })
      .png({ compressionLevel: 6, adaptiveFiltering: true })
      .toBuffer();
    // Default lossless compression avoids spending seconds optimizing a preview.
    // Retain the old maximum-compression path only for quota-borderline images.
    if (preview.length > MAX_PREVIEW_BYTES) {
      preview = await image.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    }
  } catch (error) {
    if (error instanceof AssetError) throw error;
    throw new AssetError(
      415,
      `image could not be safely decoded as one bounded frame of at most ${MAX_PIXELS.toLocaleString("en-US")} pixels`,
    );
  }
  if (preview.length > MAX_PREVIEW_BYTES) {
    throw new AssetError(413, "generated image preview exceeds 8 MiB limit");
  }
  return {
    name,
    mediaType,
    sha256,
    width,
    height,
    preview,
    previewSha256: createHash("sha256").update(preview).digest("hex"),
  };
}

function validatePreparedAssetUpload(
  body: Buffer,
  prepared: PreparedAssetUpload,
): PreparedAssetUpload {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const image = prepared.mediaType.startsWith("image/");
  const validImage =
    image
    && Number.isSafeInteger(prepared.width)
    && (prepared.width ?? 0) > 0
    && Number.isSafeInteger(prepared.height)
    && (prepared.height ?? 0) > 0
    && (prepared.width ?? 0) * (prepared.height ?? 0) <= MAX_PIXELS
    && Buffer.isBuffer(prepared.preview)
    && prepared.preview.length > 0
    && prepared.preview.length <= MAX_PREVIEW_BYTES
    && detectType(prepared.preview) === "image/png"
    && hasStrictImageContainer(prepared.preview, "image/png")
    && createHash("sha256").update(prepared.preview).digest("hex")
      === prepared.previewSha256;
  const validNonImage =
    !image
    && prepared.width === undefined
    && prepared.height === undefined
    && prepared.preview === undefined
    && prepared.previewSha256 === undefined;
  if (
    body.length < 1
    || body.length > ASSET_LIMITS.maxFileBytes
    || prepared.name !== normalizeName(prepared.name)
    || bodyHash !== prepared.sha256
    || detectType(body, prepared.name) !== prepared.mediaType
    || !extensionMatches(prepared.name, prepared.mediaType)
    || !hasStrictImageContainer(body, prepared.mediaType)
    || (!validImage && !validNonImage)
  ) {
    throw new AssetError(
      409,
      "prepared asset no longer matches its validated bytes",
    );
  }
  return prepared;
}

export async function writeAtomic(file: string, body: Buffer | string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, file); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

function canonicalFiles(id: string): { originalFile: string; previewFile: string } {
  return { originalFile: `${id}.bin`, previewFile: `${id}.preview.png` };
}

function assetUrls(ownerId: string, id: string, preview: boolean, conversationId?: string) {
  const base = conversationId
    ? `/api/conversations/${encodeURIComponent(conversationId)}/assets/${id}`
    : `/api/agents/${encodeURIComponent(ownerId)}/assets/${id}`;
  const previewUrl = preview ? `${base}/preview` : undefined;
  const downloadUrl = `${base}/download`;
  return {
    url: preview ? previewUrl! : downloadUrl,
    downloadUrl,
    ...(preview ? { previewUrl } : {}),
  };
}

function validateStoredAsset(value: unknown, projectId: string, agentId: string, id: string): StoredAsset | undefined {
  if (!value || typeof value !== "object") return undefined;
  const asset = value as Partial<StoredAsset>;
  const fields = new Set([
    "id", "projectId", "agentId", "conversationId", "name", "mediaType", "size", "width", "height",
    "sha256", "state", "createdAt", "associatedAt", "originalFile", "previewFile",
    "url", "downloadUrl", "previewUrl",
  ]);
  if (Object.keys(value as Record<string, unknown>).some((field) => !fields.has(field))) return undefined;
  const names = canonicalFiles(id);
  if (asset.id !== id || asset.projectId !== projectId || asset.agentId !== agentId) return undefined;
  if (asset.conversationId !== undefined &&
      (asset.conversationId !== agentId || !RUNTIME_UUID.test(asset.conversationId))) return undefined;
  if (!OWNER_ID.test(projectId) || !OWNER_ID.test(agentId) || !ID.test(id)) return undefined;
  if (asset.originalFile !== names.originalFile || (asset.previewFile !== undefined && asset.previewFile !== names.previewFile)) return undefined;
  if (typeof asset.name !== "string" || normalizeName(asset.name) !== asset.name ||
      typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > ASSET_LIMITS.maxFileBytes) return undefined;
  if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) return undefined;
  if (asset.state !== "staged" && asset.state !== "associated") return undefined;
  if (typeof asset.createdAt !== "string" || !Number.isFinite(Date.parse(asset.createdAt))) return undefined;
  if (asset.associatedAt !== undefined && (typeof asset.associatedAt !== "string" || !Number.isFinite(Date.parse(asset.associatedAt)))) return undefined;
  if ((asset.state === "associated") !== (asset.associatedAt !== undefined)) return undefined;
  if (!ASSET_LIMITS.acceptedMediaTypes.includes(asset.mediaType as AssetDto["mediaType"])) return undefined;
  if (!extensionMatches(asset.name, asset.mediaType as AssetDto["mediaType"])) return undefined;
  const preview = asset.previewFile !== undefined;
  const expected = assetUrls(agentId, id, preview, asset.conversationId);
  const expectedUrl = preview && !asset.conversationId
    ? `/api/agents/${encodeURIComponent(agentId)}/attachments/${id}`
    : expected.url;
  if (asset.url !== expectedUrl || asset.downloadUrl !== expected.downloadUrl || asset.previewUrl !== expected.previewUrl) return undefined;
  if (String(asset.mediaType).startsWith("image/")) {
    if (!preview || !Number.isSafeInteger(asset.width) || (asset.width ?? 0) < 1 ||
        !Number.isSafeInteger(asset.height) || (asset.height ?? 0) < 1) return undefined;
  } else if (preview || asset.width !== undefined || asset.height !== undefined) return undefined;
  return asset as StoredAsset;
}

async function readNoFollow(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("unsafe asset file");
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function unlinkIfPresent(file: string): Promise<void> {
  try { await unlink(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function removeStagedAssetFiles(
  directory: string,
  id: string,
  syncDirectory: () => Promise<void>,
): Promise<void> {
  const { originalFile, previewFile } = canonicalFiles(id);
  await unlinkIfPresent(path.join(directory, originalFile));
  await unlinkIfPresent(path.join(directory, previewFile));
  await unlinkIfPresent(path.join(directory, `${id}.json`));
  await syncDirectory();
}

function publicDto(asset: StoredAsset): AssetDto {
  const { id, agentId, conversationId, name, mediaType, size, width, height, url, downloadUrl, previewUrl, sha256, state, createdAt } = asset;
  return { id, agentId, ...(conversationId ? { conversationId } : {}), name, mediaType, size, width, height, url, downloadUrl, previewUrl, sha256, state, createdAt };
}

export class AssetStore {
  private root?: string;
  private authority: AssetAuthority;
  private readonly portableFiles: boolean;

  constructor(private dataDir: string, options: { portableFiles?: boolean } = {}) {
    this.portableFiles = process.platform !== "linux" || options.portableFiles === true;
    this.authority = new AssetAuthority(dataDir);
  }
  close(): void { this.authority.close(); }

  enqueueDraftAttachmentCleanup(
    draftId: string,
    ownerId: string,
    assetId: string,
    eligibleAt: number,
  ): void {
    this.authority.enqueueDraftAttachmentCleanup(draftId, ownerId, assetId, eligibleAt);
  }

  reserveDraftAttachment(
    draftId: string,
    ownerId: string,
    assetId: string,
    size: number,
  ): string {
    return this.authority.reserveDraftAttachment(draftId, ownerId, assetId, size);
  }

  settleDraftAttachment(reservationId: string): void {
    this.authority.settleDraftAttachment(reservationId);
  }

  releaseDraftAttachment(reservationId: string): boolean {
    return this.authority.releaseDraftAttachment(reservationId);
  }

  syncDraftAttachment(
    draftId: string,
    ownerId: string,
    assetId: string,
    size: number,
  ): void {
    this.authority.syncDraftAttachment(draftId, ownerId, assetId, size);
  }

  draftSurfaceIds(): string[] {
    return this.authority.draftSurfaceIds();
  }

  pendingDraftAttachmentCleanups(now?: number): Array<{
    draftId: string;
    ownerId: string;
    assetId: string;
  }> {
    return this.authority.pendingDraftAttachmentCleanups(now);
  }

  finishDraftAttachmentCleanup(draftId: string, ownerId: string, assetId: string): void {
    this.authority.finishDraftAttachmentCleanup(draftId, ownerId, assetId);
  }

  finishDraftSurfaceCleanup(draftId: string): void {
    this.authority.finishDraftSurfaceCleanup(draftId);
  }

  purgeAgents(agentIds: readonly string[]): void {
    this.authority.purgeAgents(agentIds);
  }

  /** Chat-owned Broadcast media has the Chat UUID as its storage owner, but
   * no Agent record. Remove its bytes before releasing its durable quota. */
  async purgeConversationAssets(projectId: string, conversationId: string): Promise<void> {
    if (!RUNTIME_UUID.test(conversationId)) throw new AssetError(400, "Chat attachment owner is invalid");
    const directory = this.dir(projectId, conversationId);
    const ownedLeaf = (leaf: string) =>
      /^(?:[a-f0-9-]{36}\.(?:bin|json|preview\.png|associated)|audit-[a-f0-9-]{36}\.json|audit\.jsonl)$/u.test(leaf);
    if (existsSync(directory)) {
      if (this.portableFiles) {
        const relative = this.secureDirectory(projectId, conversationId);
        const entries = listSecureDirectory({ root: this.dataDir, relativePath: relative });
        if (!entries) throw new AssetError(409, "Chat attachment storage is unavailable");
        for (const entry of entries) {
          if (!ownedLeaf(entry.name) || entry.kind !== "file") {
            throw new AssetError(409, "Chat attachment storage has an unexpected entry");
          }
          this.secureRemove(relative, entry.name);
        }
      } else {
        const opened = await this.safeDirectory(projectId, conversationId);
        try {
          for (const entry of await readdir(opened.path)) {
            if (!ownedLeaf(entry)) {
              throw new AssetError(409, "Chat attachment storage has an unexpected entry");
            }
            const info = await lstat(path.join(opened.path, entry));
            if (!info.isFile() || info.isSymbolicLink()) throw new AssetError(409, "Chat attachment storage has an unsafe entry");
            await unlink(path.join(opened.path, entry));
          }
          await this.syncDirectory(opened.handle);
        } finally { await opened.handle.close(); }
      }
    }
    this.authority.purgeAgents([conversationId]);
  }

  purgeProject(projectId: string, draftSurfaceIds: readonly string[]): void {
    this.authority.purgeProject(projectId, draftSurfaceIds);
  }

  private validateOwner(projectId: string, agentId: string): void {
    if (!OWNER_ID.test(projectId) || !OWNER_ID.test(agentId)) throw new AssetError(404, "asset storage is unavailable");
  }
  private dir(projectId: string, agentId: string): string { this.validateOwner(projectId, agentId); return attachmentsDir(this.dataDir, projectId, agentId); }
  private secureDirectory(projectId: string, agentId: string, create = false): string {
    this.validateOwner(projectId, agentId);
    const relative = `projects/${projectId}/agents/${agentId}/attachments`;
    if (create) ensureSecureDirectory({ root: this.dataDir, relativePath: relative });
    return relative;
  }

  private secureRead(relativeDirectory: string, leaf: string, maxBytes: number): Buffer | undefined {
    return readSecureFile({ root: this.dataDir, relativePath: `${relativeDirectory}/${leaf}`, maxBytes });
  }

  private secureWrite(relativeDirectory: string, leaf: string, body: Buffer | string): void {
    writeSecureFileAtomic({
      root: this.dataDir, relativeDirectory, leaf,
      temporaryLeaf: `.${randomUUID()}.tmp`,
      body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    });
  }

  private secureRemove(relativeDirectory: string, leaf: string): void {
    removeSecureFile({ root: this.dataDir, relativeDirectory, leaf });
  }

  private readPortable(projectId: string, agentId: string, id: string): StoredAsset | undefined {
    try {
      const relative = this.secureDirectory(projectId, agentId);
      const body = this.secureRead(relative, `${id}.json`, 32 * 1024);
      if (!body) return undefined;
      const asset = validateStoredAsset(JSON.parse(body.toString("utf8")), projectId, agentId, id);
      if (!asset || asset.state === "associated") return asset;
      const marker = this.secureRead(relative, `${id}.associated`, 256);
      if (!marker) return asset;
      const associatedAt = marker.toString("utf8");
      if (!Number.isFinite(Date.parse(associatedAt))) return undefined;
      return { ...asset, state: "associated", associatedAt };
    } catch { return undefined; }
  }
  private async safeDirectory(projectId: string, agentId: string, create = false): Promise<{ path: string; handle: FileHandle }> {
    const directory = this.dir(projectId, agentId);
    for (const ancestor of [
      path.join(this.dataDir, "projects"),
      path.join(this.dataDir, "projects", projectId),
      path.join(this.dataDir, "projects", projectId, "agents"),
      path.join(this.dataDir, "projects", projectId, "agents", agentId),
    ]) {
      const info = await lstat(ancestor).catch(() => undefined);
      if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new AssetError(409, "asset storage is unavailable");
    }
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const root = this.root ??= await realpath(this.dataDir);
    const actual = await realpath(directory);
    if (actual !== path.join(root, "projects", projectId, "agents", agentId, "attachments")) throw new AssetError(409, "asset storage is unavailable");
    let cursor = directory;
    while (cursor !== this.dataDir) {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new AssetError(409, "asset storage is unavailable");
      cursor = path.dirname(cursor);
    }
    const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const descriptorPath = `/proc/self/fd/${handle.fd}`;
    const descriptorRealpath = await realpath(descriptorPath);
    if (descriptorRealpath !== actual) { await handle.close(); throw new AssetError(409, "asset storage is unavailable"); }
    return { path: descriptorPath, handle };
  }

  /**
   * A rename makes a file visible but does not make its directory entry durable.
   * All callers hold the no-follow directory descriptor that was verified by
   * safeDirectory, so sync that descriptor before any dependent authority can
   * advance. Re-syncing an already-associated asset makes a retry after an I/O
   * failure complete the same barrier without changing its immutable metadata.
   */
  private async syncDirectory(handle: FileHandle): Promise<void> {
    await handle.sync();
  }

  async read(projectId: string, agentId: string, id: string): Promise<StoredAsset | undefined> {
    if (!ID.test(id) || this.authority.deletionRequested(id)) return undefined;
    if (this.portableFiles) return this.readPortable(projectId, agentId, id);
    try {
      const directory = await this.safeDirectory(projectId, agentId);
      try { return validateStoredAsset(JSON.parse((await readNoFollow(path.join(directory.path, `${id}.json`), 32 * 1024)).toString("utf8")), projectId, agentId, id); }
      finally { await directory.handle.close(); }
    } catch { return undefined; }
  }

  /** Resolve immutable attachment metadata and bytes at the synchronous
   * scheduler intake boundary. */
  authoritativeRuntimeAttachment(
    projectId: string,
    agentId: string,
    id: string,
  ): AuthoritativeRuntimeAttachment | undefined {
    if (!ID.test(id)) return undefined;
    if (this.portableFiles) {
      const asset = this.readPortable(projectId, agentId, id);
      if (!asset) return undefined;
      const relative = this.secureDirectory(projectId, agentId);
      const body = this.secureRead(relative, asset.originalFile, ASSET_LIMITS.maxFileBytes);
      if (!body || body.length !== asset.size || createHash("sha256").update(body).digest("hex") !== asset.sha256 ||
          detectType(body, asset.name) !== asset.mediaType || !extensionMatches(asset.name, asset.mediaType) ||
          !hasStrictImageContainer(body, asset.mediaType)) return undefined;
      if (asset.previewFile) {
        const preview = this.secureRead(relative, asset.previewFile, MAX_PREVIEW_BYTES);
        if (!preview || detectType(preview) !== "image/png" || !hasStrictImageContainer(preview, "image/png")) return undefined;
      }
      return {
        attachment: { ...publicDto(asset), sha256: asset.sha256, state: "associated" },
        localPath: path.join(this.dir(projectId, agentId), asset.originalFile),
        contentHash: asset.sha256,
        byteLength: body.length,
      };
    }
    let metadataFd: number | undefined;
    let contentFd: number | undefined;
    let previewFd: number | undefined;
    try {
      const directory = this.dir(projectId, agentId);
      const root = this.root ??= realpathSync(this.dataDir);
      const actual = realpathSync(directory);
      if (actual !== path.join(root, "projects", projectId, "agents", agentId, "attachments")) return undefined;
      for (const ancestor of [
        path.join(this.dataDir, "projects"),
        path.join(this.dataDir, "projects", projectId),
        path.join(this.dataDir, "projects", projectId, "agents"),
        path.join(this.dataDir, "projects", projectId, "agents", agentId),
        directory,
      ]) {
        const info = lstatSync(ancestor);
        if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
      }
      metadataFd = openSync(path.join(actual, `${id}.json`), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const metadataInfo = fstatSync(metadataFd);
      if (!metadataInfo.isFile() || metadataInfo.nlink !== 1 || metadataInfo.size > 32 * 1024) return undefined;
      const asset = validateStoredAsset(JSON.parse(readFileSync(metadataFd, "utf8")), projectId, agentId, id);
      if (!asset) return undefined;
      contentFd = openSync(path.join(actual, asset.originalFile), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const contentInfo = fstatSync(contentFd);
      if (!contentInfo.isFile() || contentInfo.nlink !== 1 || contentInfo.size !== asset.size || contentInfo.size > ASSET_LIMITS.maxFileBytes) return undefined;
      const body = readFileSync(contentFd);
      const contentHash = createHash("sha256").update(body).digest("hex");
      if (contentHash !== asset.sha256 || detectType(body, asset.name) !== asset.mediaType ||
          !extensionMatches(asset.name, asset.mediaType) || !hasStrictImageContainer(body, asset.mediaType)) return undefined;
      if (asset.previewFile) {
        previewFd = openSync(path.join(actual, asset.previewFile), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const previewInfo = fstatSync(previewFd);
        if (!previewInfo.isFile() || previewInfo.nlink !== 1 || previewInfo.size < 1 ||
            previewInfo.size > MAX_PREVIEW_BYTES) return undefined;
        const preview = readFileSync(previewFd);
        if (detectType(preview) !== "image/png" || !hasStrictImageContainer(preview, "image/png")) return undefined;
      }
      return {
        attachment: { ...publicDto(asset), sha256: contentHash, state: "associated" },
        localPath: path.join(actual, asset.originalFile),
        contentHash,
        byteLength: body.length,
      };
    } catch {
      return undefined;
    } finally {
      if (metadataFd !== undefined) closeSync(metadataFd);
      if (contentFd !== undefined) closeSync(contentFd);
      if (previewFd !== undefined) closeSync(previewFd);
    }
  }

  registerRuntimeArtifact(artifact: RegisteredRuntimeArtifact): {
    artifact: RegisteredRuntimeArtifact;
    reservationCreated: boolean;
  } {
    return this.authority.registerRuntimeArtifact(artifact);
  }

  removeRuntimeArtifactReservation(projectId: string, id: string): void {
    this.authority.removeRuntimeArtifact(projectId, id);
  }

  authoritativeRuntimeArtifact(
    projectId: string,
    expected: RuntimeArtifactInputV3,
  ): AuthoritativeRuntimeArtifact | undefined {
    const registered = this.authority.runtimeArtifact(projectId, expected.id);
    if (!registered || registered.projectId !== projectId) return undefined;
    const { createdAt: _createdAt, ...registeredIdentity } = registered;
    const expectedIdentity = { projectId, ...expected };
    if (!runtimeArtifactIdentityMatches(registeredIdentity, expectedIdentity)) return undefined;
    return this.readAuthoritativeRuntimeArtifact(registered);
  }

  async authoritativeRuntimeArtifactAsync(
    projectId: string,
    expected: RuntimeArtifactInputV3,
    signal?: AbortSignal,
  ): Promise<AuthoritativeRuntimeArtifact | undefined> {
    const registered = this.authority.runtimeArtifact(projectId, expected.id);
    if (!registered || registered.projectId !== projectId) return undefined;
    const { createdAt: _createdAt, ...registeredIdentity } = registered;
    if (!runtimeArtifactIdentityMatches(registeredIdentity, { projectId, ...expected })) return undefined;
    const artifact = this.validRuntimeArtifactMetadata(registered);
    if (!artifact) return undefined;
    const content = await openManagedArtifactContent(
      this.dataDir,
      projectId,
      artifact.id,
      artifact.byteLength,
      artifact.blobHash,
      { signal },
    );
    if (!content) return undefined;
    try {
      const body = await content.readRange(artifact.byteLength, signal);
      try { new TextDecoder("utf-8", { fatal: true }).decode(body); }
      catch { return undefined; }
      return {
        artifact,
        body,
        localPath: managedArtifactContentPath(this.dataDir, projectId, artifact.id),
        contentHash: artifact.blobHash,
        byteLength: body.length,
      };
    } finally {
      await content.close();
    }
  }

  /** Validate runtime-artifact ledger identity without reading its blob. */
  authoritativeRuntimeArtifactMetadata(
    projectId: string,
    expected: RuntimeArtifactInputV3,
  ): boolean {
    const registered = this.authority.runtimeArtifact(projectId, expected.id);
    if (!registered || registered.projectId !== projectId) return false;
    const { createdAt: _createdAt, ...registeredIdentity } = registered;
    return runtimeArtifactIdentityMatches(
      registeredIdentity,
      { projectId, ...expected },
    );
  }

  /** Read one registered managed artifact through its immutable ledger entry.
   * The returned Buffer is read from the already-opened no-follow descriptor,
   * so callers never reopen a pathname after verification. */
  authoritativeRuntimeArtifactById(
    projectId: string,
    id: string,
  ): AuthoritativeRuntimeArtifact | undefined {
    const registered = this.authority.runtimeArtifact(projectId, id);
    return registered?.projectId === projectId
      ? this.readAuthoritativeRuntimeArtifact(registered)
      : undefined;
  }

  /** Validate the immutable runtime-artifact ledger identity without reading
   * its blob. HTTP transfer paths use this before opening the blob through the
   * async descriptor-retained reader. */
  authoritativeRuntimeArtifactMetadataById(
    projectId: string,
    id: string,
  ): RuntimeArtifactInputV3 | undefined {
    const registered = this.authority.runtimeArtifact(projectId, id);
    return registered?.projectId === projectId ? this.validRuntimeArtifactMetadata(registered) : undefined;
  }

  private validRuntimeArtifactMetadata(registered: RegisteredRuntimeArtifact): RuntimeArtifactInputV3 | undefined {
    const { projectId: _projectId, createdAt: _createdAt, ...authoritativeMetadata } = registered;
    const artifact = authoritativeMetadata as RuntimeArtifactInputV3;
    if (!/^text-[a-f0-9]{64}$/.test(artifact.id) ||
        (artifact.role !== "long_text" && artifact.role !== "document") ||
        !artifact.title.trim() || artifact.mediaType !== "text/markdown" ||
        artifact.blobPath !== artifact.id || !/^[a-f0-9]{64}$/.test(artifact.blobHash) ||
        !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1 ||
        artifact.byteLength > MAX_RUNTIME_TEXT_ARTIFACT_BYTES ||
        ((artifact.originAgentId === undefined) !== (artifact.executionId === undefined)) ||
        (artifact.originAgentId !== undefined &&
          (!RUNTIME_UUID.test(artifact.originAgentId) || !RUNTIME_UUID.test(artifact.executionId!)))) return undefined;
    return artifact;
  }

  private readAuthoritativeRuntimeArtifact(
    registered: RegisteredRuntimeArtifact,
  ): AuthoritativeRuntimeArtifact | undefined {
    try {
      const { projectId } = registered;
      const artifact = this.validRuntimeArtifactMetadata(registered);
      if (!artifact) return undefined;
      const canonicalPath = managedArtifactContentPath(this.dataDir, projectId, artifact.id);
      const content = readManagedArtifactContent(
        this.dataDir, projectId, artifact.id, artifact.byteLength, artifact.blobHash,
      );
      if (!content) return undefined;
      try { new TextDecoder("utf-8", { fatal: true }).decode(content.body); }
      catch { return undefined; }
      return {
        artifact,
        body: content.body,
        localPath: canonicalPath,
        contentHash: content.sha256,
        byteLength: content.size,
      };
    } catch { return undefined; }
  }

  /** Commit one generated-file catalog identity only after its exact managed
   * bytes are present. The immutable authority is separate from mutable
   * visibility and survives origin-Agent deletion. */
  registerGeneratedArtifact(artifact: RegisteredGeneratedArtifact): RegisteredGeneratedArtifact {
    const readable = this.readGeneratedArtifact(artifact);
    if (!readable) throw new AssetError(409, "generated artifact content is unavailable or changed");
    return this.authority.registerGeneratedArtifact(artifact);
  }

  /** Register bytes that were just installed and verified by the managed
   * publication authority without synchronously rereading the bounded blob. */
  registerPublishedGeneratedArtifact(
    artifact: RegisteredGeneratedArtifact,
    publication: { size: number; sha256: string },
  ): RegisteredGeneratedArtifact {
    if (!generatedArtifactMetadataIsValid(artifact) ||
        publication.size !== artifact.size ||
        publication.sha256 !== artifact.sha256) {
      throw new AssetError(
        409,
        "generated artifact publication proof does not match its catalog identity",
      );
    }
    return this.authority.registerGeneratedArtifact(artifact);
  }
  removeCreationGeneratedArtifact(
    projectId: string,
    identity: AgentCreationArtifactIdentity,
  ): boolean {
    if (!identity.generated) {
      return !this.authority.generatedArtifact(projectId, identity.id);
    }
    const generated: RegisteredGeneratedArtifact = {
      id: identity.id,
      projectId,
      agentId: identity.generated.agentId,
      originAgentId: identity.generated.originAgentId,
      ...(identity.generated.executionId
        ? { executionId: identity.generated.executionId }
        : {}),
      kind: "generated_file",
      path: identity.generated.path,
      ...(identity.generated.sourcePath
        ? { sourcePath: identity.generated.sourcePath }
        : {}),
      summary: identity.generated.summary,
      createdAt: identity.generated.createdAt,
      mediaType: identity.generated.mediaType,
      size: identity.byteLength,
      sha256: identity.sha256,
    };
    return this.authority.removeGeneratedArtifactIfMatches(generated) !== "mismatch";
  }
  registerPublishedGeneratedArtifactImport(
    artifact: RegisteredGeneratedArtifact,
    publication: { size: number; sha256: string },
    identity: { runId: string; toolCallId: string; requestHash: string },
  ): GeneratedArtifactImportReceipt {
    if (!generatedArtifactMetadataIsValid(artifact) ||
        publication.size !== artifact.size ||
        publication.sha256 !== artifact.sha256) {
      throw new AssetError(
        409,
        "generated artifact publication proof does not match its import identity",
      );
    }
    return this.authority.registerGeneratedArtifactImport(artifact, identity);
  }

  generatedArtifactImportReceipt(
    projectId: string,
    runId: string,
    toolCallId: string,
  ): GeneratedArtifactImportReceipt | undefined {
    return this.authority.generatedArtifactImportReceipt(projectId, runId, toolCallId);
  }

  pendingGeneratedArtifactImports(): GeneratedArtifactImportReceipt[] {
    return this.authority.pendingGeneratedArtifactImports();
  }

  generatedArtifactImportIsAvailable(receipt: GeneratedArtifactImportReceipt): boolean {
    return this.readGeneratedArtifact(receipt.artifact) !== undefined;
  }

  markGeneratedArtifactImportProjected(receipt: GeneratedArtifactImportReceipt): void {
    this.authority.markGeneratedArtifactImportProjected(
      receipt.artifact.projectId, receipt.runId, receipt.toolCallId,
    );
  }

  quarantineGeneratedArtifactImport(receipt: GeneratedArtifactImportReceipt): void {
    this.authority.quarantineGeneratedArtifactImport(
      receipt.artifact.projectId, receipt.runId, receipt.toolCallId,
    );
  }


  /** Resolve a generated file only when the current catalog and immutable
   * authority agree exactly. Bytes come from the already-opened no-follow
   * descriptor and the verified pathname is never reopened. */
  authoritativeGeneratedArtifact(
    projectId: string,
    expected: ArtifactDto,
  ): AuthoritativeGeneratedArtifact | undefined {
    if (expected.projectId !== projectId || expected.kind !== "generated_file" ||
        !expected.originAgentId || !expected.summary || !expected.mediaType ||
        expected.size === undefined || !expected.sha256) return undefined;
    const candidate: RegisteredGeneratedArtifact = {
      id: expected.id,
      projectId,
      agentId: expected.agentId,
      originAgentId: expected.originAgentId,
      ...(expected.executionId ? { executionId: expected.executionId } : {}),
      kind: "generated_file",
      path: expected.path,
      ...(expected.sourcePath ? { sourcePath: expected.sourcePath } : {}),
      summary: expected.summary,
      createdAt: expected.createdAt,
      mediaType: expected.mediaType,
      size: expected.size,
      sha256: expected.sha256,
    };
    if (!generatedArtifactMetadataIsValid(candidate)) return undefined;
    const registered = this.authority.generatedArtifact(projectId, expected.id);
    if (!registered || JSON.stringify(generatedArtifactIdentity(registered)) !==
        JSON.stringify(generatedArtifactIdentity(candidate))) return undefined;
    return this.readGeneratedArtifact(registered);
  }

  /** Resolve any cataloged managed artifact through immutable content checks.
   * Generated files additionally retain their existing publication-ledger check. */
  authoritativeManagedProjectArtifact(projectId: string, expected: ArtifactDto): {
    body: Buffer;
    localPath: string;
    contentHash: string;
    byteLength: number;
  } | undefined {
    if (expected.projectId !== projectId || expected.size === undefined || !expected.sha256) return undefined;
    if (expected.kind === "generated_file") {
      return this.authoritativeGeneratedArtifact(projectId, expected);
    }
    try {
      const content = readManagedArtifactContent(
        this.dataDir,
        projectId,
        expected.id,
        expected.size,
        expected.sha256,
      );
      return content ? {
        body: content.body,
        localPath: managedArtifactContentPath(this.dataDir, projectId, expected.id),
        contentHash: content.sha256,
        byteLength: content.size,
      } : undefined;
    } catch {
      return undefined;
    }
  }

  managedProjectArtifactIsAvailable(projectId: string, expected: ArtifactDto): boolean {
    return Boolean(this.authoritativeManagedProjectArtifact(projectId, expected));
  }

  /** Validate catalog and publication-ledger identity without reading or
   * hashing managed bytes. Used while the scheduler SQLite writer is fenced. */
  managedProjectArtifactMetadataIsAuthoritative(projectId: string, expected: ArtifactDto): boolean {
    if (expected.projectId !== projectId || !expected.mediaType || expected.size === undefined ||
        !Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > MANAGED_ARTIFACT_MAX_BYTES ||
        !/^[a-f0-9]{64}$/u.test(expected.sha256 ?? "")) return false;
    return expected.kind !== "generated_file" ||
      this.authoritativeGeneratedArtifactMetadata(projectId, expected);
  }

  /** Validate generated-file catalog/ledger agreement without synchronously
   * materializing the managed blob. */
  authoritativeGeneratedArtifactMetadata(
    projectId: string,
    expected: ArtifactDto,
  ): boolean {
    if (expected.projectId !== projectId || expected.kind !== "generated_file" ||
        !expected.originAgentId || !expected.summary || !expected.mediaType ||
        expected.size === undefined || !expected.sha256) return false;
    const candidate: RegisteredGeneratedArtifact = {
      id: expected.id,
      projectId,
      agentId: expected.agentId,
      originAgentId: expected.originAgentId,
      ...(expected.executionId ? { executionId: expected.executionId } : {}),
      kind: "generated_file",
      path: expected.path,
      ...(expected.sourcePath ? { sourcePath: expected.sourcePath } : {}),
      summary: expected.summary,
      createdAt: expected.createdAt,
      mediaType: expected.mediaType,
      size: expected.size,
      sha256: expected.sha256,
    };
    if (!generatedArtifactMetadataIsValid(candidate)) return false;
    const registered = this.authority.generatedArtifact(projectId, expected.id);
    return Boolean(registered && JSON.stringify(generatedArtifactIdentity(registered)) ===
      JSON.stringify(generatedArtifactIdentity(candidate)));
  }

  private readGeneratedArtifact(
    artifact: RegisteredGeneratedArtifact,
  ): AuthoritativeGeneratedArtifact | undefined {
    try {
      if (!generatedArtifactMetadataIsValid(artifact)) return undefined;
      const { projectId, id } = artifact;
      const canonicalPath = managedArtifactContentPath(this.dataDir, projectId, id);
      const content = readManagedArtifactContent(this.dataDir, projectId, id, artifact.size, artifact.sha256);
      return content ? {
        artifact,
        body: content.body,
        localPath: canonicalPath,
        contentHash: content.sha256,
        byteLength: content.size,
      } : undefined;
    } catch { return undefined; }
  }

  reserveRuntimeCommunication(
    communicationId: string,
    bindings: Array<{ projectId: string; agentId: string; attachmentId: string; contentHash: string; byteLength: number }>,
  ): RuntimeAttachmentReservationReceiptV3 {
    return this.authority.reserveRuntimeCommunication(
      communicationId,
      bindings.map((binding) => ({ communicationId, ...binding })),
    );
  }

  compensateRuntimeCommunicationReservation(receipt: RuntimeAttachmentReservationReceiptV3): void {
    this.authority.compensateRuntimeCommunicationReservation(receipt);
  }

  authoritativeRuntimeCommunicationAttachments(
    communicationId: string,
  ): AuthoritativeRuntimeAttachment[] | undefined {
    const rows = this.authority.runtimeCommunicationAssociations()
      .filter((row) => row.communicationId === communicationId);
    const resolved: AuthoritativeRuntimeAttachment[] = [];
    for (const row of rows) {
      const attachment = this.authoritativeRuntimeAttachment(row.projectId, row.agentId, row.attachmentId);
      if (!attachment || attachment.attachment.agentId !== row.agentId ||
          attachment.contentHash !== row.contentHash || attachment.byteLength !== row.byteLength) return undefined;
      resolved.push(attachment);
    }
    return resolved;
  }

  async recoverRuntimeCommunicationAssociations(
    communicationExists: (communicationId: string, projectId: string) => boolean,
  ): Promise<{ associated: number; released: number; unavailable: number }> {
    let associated = 0;
    let released = 0;
    let unavailable = 0;
    const rows = this.authority.runtimeCommunicationAssociations();
    for (const row of rows) {
      if (!communicationExists(row.communicationId, row.projectId)) {
        this.authority.removeRuntimeCommunicationAssociations(row.communicationId);
        released += 1;
        continue;
      }
      const resolved = this.authoritativeRuntimeAttachment(row.projectId, row.agentId, row.attachmentId);
      if (!resolved || resolved.contentHash !== row.contentHash || resolved.byteLength !== row.byteLength) {
        unavailable += 1;
        continue;
      }
      try {
        await this.associate(row.projectId, row.agentId, [row.attachmentId]);
        associated += 1;
      } catch { unavailable += 1; }
    }
    return { associated, released, unavailable };
  }

  async stage(input: {
    projectId: string;
    agentId: string;
    conversationId?: string;
    body: Buffer;
    name?: unknown;
    declaredType?: string;
    prepared?: PreparedAssetUpload;
  }): Promise<AssetDto> {
    const { projectId, agentId, body } = input;
    if (input.conversationId !== undefined &&
        (input.conversationId !== agentId || !RUNTIME_UUID.test(input.conversationId))) {
      throw new AssetError(400, "Chat attachment owner is invalid");
    }
    const prepared = input.prepared
      ? validatePreparedAssetUpload(body, input.prepared)
      : await prepareAssetUpload({
          body,
          name: input.name,
          declaredType: input.declaredType,
        });
    if (this.portableFiles) return this.stagePortable(input, prepared);
    const { name, mediaType, width, height, preview } = prepared;
    const now = Date.now();
    const openedDirectory = await this.safeDirectory(projectId, agentId, true);
    const directory = openedDirectory.path;
    const existing = new Map<string, number>();
    for (const entry of await readdir(directory)) {
      const match = entry.match(/^([a-f0-9-]{36})\.bin$/); if (!match) continue;
      const target = path.join(directory, entry); const first = await stat(target); const second = await stat(target);
      if (!first.isFile() || first.dev !== second.dev || first.ino !== second.ino || first.size !== second.size) throw new AssetError(409, "asset filesystem changed during quota reconciliation");
      existing.set(match[1]!, second.size);
    }
    this.authority.syncAgent(projectId, agentId, existing);
    const id = randomUUID();
    const reservationId = (() => { try { return this.authority.reserve(projectId, agentId, id, body.length); } catch (error) { void openedDirectory.handle.close(); throw error; } })();
    try {
      this.authority.recordAudit(path.join(directory, "audit.jsonl"), projectId, agentId, { action: "upload_reserved", agentId, projectId, at: new Date(now).toISOString() });

      const { originalFile, previewFile: canonicalPreview } = canonicalFiles(id);
      const previewFile = preview ? canonicalPreview : undefined;
      const createdAt = new Date().toISOString();
      const asset: StoredAsset = {
        id, projectId, agentId, ...(input.conversationId ? { conversationId: input.conversationId } : {}), name, mediaType, size: body.length, width, height,
        sha256: createHash("sha256").update(body).digest("hex"), state: "staged", createdAt,
        originalFile, previewFile,
        ...assetUrls(agentId, id, Boolean(previewFile), input.conversationId),
        ...(!input.conversationId && previewFile ? { url: `/api/agents/${encodeURIComponent(agentId)}/attachments/${id}` } : {}),
      };
      await writeAtomic(path.join(directory, originalFile), body);
      try {
        if (preview && previewFile) await writeAtomic(path.join(directory, previewFile), preview);
        await writeAtomic(path.join(directory, `${id}.json`), JSON.stringify(asset));
        // Persist all staged names (content, optional preview, and metadata)
        // before quota state can make this asset authoritative.
        await this.syncDirectory(openedDirectory.handle);
        this.authority.settle(reservationId);
      } catch (error) {
        await Promise.allSettled([unlink(path.join(directory, originalFile)), previewFile ? unlink(path.join(directory, previewFile)) : Promise.resolve(), unlink(path.join(directory, `${id}.json`))]);
        throw error;
      }
      this.authority.recordAudit(path.join(directory, "audit.jsonl"), projectId, agentId, { action: "staged", id, agentId, projectId, size: body.length, mediaType, at: createdAt });
      return publicDto(asset);
    } finally {
      this.authority.release(reservationId);
      await openedDirectory.handle.close();
    }
  }

  private stagePortable(
    input: { projectId: string; agentId: string; conversationId?: string; body: Buffer },
    prepared: PreparedAssetUpload,
  ): AssetDto {
    const { projectId, agentId, body } = input;
    const { name, mediaType, width, height, preview } = prepared;
    const rootIdentity = secureDirectoryIdentity({ root: this.dataDir });
    if (!rootIdentity) throw new AssetError(409, "asset storage is unavailable");
    const relative = this.secureDirectory(projectId, agentId, true);
    const directoryIdentity = secureDirectoryIdentity({ root: this.dataDir, relativePath: relative });
    if (!directoryIdentity) throw new AssetError(409, "asset storage is unavailable");
    const assertCurrent = () => {
      if (secureDirectoryIdentity({ root: this.dataDir }) !== rootIdentity ||
          secureDirectoryIdentity({ root: this.dataDir, relativePath: relative }) !== directoryIdentity) {
        throw new AssetError(409, "asset storage changed during upload");
      }
    };
    const fenced = <T>(operation: () => T): T => {
      assertCurrent();
      const value = operation();
      assertCurrent();
      return value;
    };
    assertCurrent();
    const entries = listSecureDirectory({ root: this.dataDir, relativePath: relative });
    if (!entries) throw new AssetError(409, "asset storage is unavailable");
    assertCurrent();
    const existing = new Map<string, number>();
    for (const entry of entries) {
      const match = /^([a-f0-9-]{36})\.bin$/u.exec(entry.name);
      if (match && entry.kind === "file" && entry.size !== undefined) existing.set(match[1]!, entry.size);
    }
    fenced(() => this.authority.syncAgent(projectId, agentId, existing));
    const id = randomUUID();
    const reservationId = this.authority.reserve(projectId, agentId, id, body.length);
    const createdAt = new Date().toISOString();
    const { originalFile, previewFile: canonicalPreview } = canonicalFiles(id);
    const previewFile = preview ? canonicalPreview : undefined;
    const asset: StoredAsset = {
      id, projectId, agentId, ...(input.conversationId ? { conversationId: input.conversationId } : {}), name, mediaType, size: body.length, width, height,
      sha256: prepared.sha256, state: "staged", createdAt,
      originalFile, previewFile,
      ...assetUrls(agentId, id, Boolean(previewFile), input.conversationId),
      ...(!input.conversationId && previewFile ? { url: `/api/agents/${encodeURIComponent(agentId)}/attachments/${id}` } : {}),
    };
    try {
      fenced(() => this.authority.recordSecureAudit(this.dataDir, relative, projectId, agentId,
        { action: "upload_reserved", agentId, projectId, at: createdAt }));
      fenced(() => this.secureWrite(relative, originalFile, body));
      if (previewFile && preview) fenced(() => this.secureWrite(relative, previewFile, preview));
      fenced(() => this.secureWrite(relative, `${id}.json`, JSON.stringify(asset)));
      fenced(() => this.authority.recordSecureAudit(this.dataDir, relative, projectId, agentId,
        { action: "staged", id, agentId, projectId, size: body.length, mediaType, at: createdAt }));
      const readable = fenced(() => this.secureRead(relative, originalFile, ASSET_LIMITS.maxFileBytes));
      const metadata = fenced(() => this.secureRead(relative, `${id}.json`, 32 * 1024));
      if (!readable?.equals(body) || !metadata ||
          !validateStoredAsset(JSON.parse(metadata.toString("utf8")), projectId, agentId, id)) {
        throw new AssetError(409, "asset upload could not be verified");
      }
      fenced(() => this.authority.settle(reservationId));
      return publicDto(asset);
    } catch (error) {
      // Never delete through a replacement pathname. Orphans in a displaced
      // root remain unacknowledged and carry a durable cleanup obligation.
      try { this.authority.beginDelete(id, projectId, agentId); }
      catch { /* retain the primary upload failure */ }
      try {
        assertCurrent();
        for (const leaf of [originalFile, previewFile, `${id}.json`]) {
          if (leaf) {
            try { this.secureRemove(relative, leaf); }
            catch { /* retain the primary publication failure */ }
          }
        }
      } catch { /* the root changed, so it cannot be safely cleaned by path */ }
      throw error;
    } finally {
      this.authority.release(reservationId);
    }
  }

  async associate(projectId: string, agentId: string, ids: string[]): Promise<AssetDto[]> {
    const assets = await Promise.all(ids.map((id) => this.read(projectId, agentId, id)));
    if (assets.some((asset) => !asset)) throw new AssetError(404, "asset not found");
    const integrity = await Promise.all(ids.map((id) => this.content(projectId, agentId, id, false)));
    if (integrity.some((item) => !item)) throw new AssetError(404, "asset not found");
    const now = new Date().toISOString();
    const associated = assets as StoredAsset[];
    if (this.portableFiles) {
      const relative = this.secureDirectory(projectId, agentId);
      for (const asset of associated) {
        if (asset.state === "associated") continue;
        const marker = `${asset.id}.associated`;
        try { this.secureWrite(relative, marker, now); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const existing = this.secureRead(relative, marker, 256);
          if (!existing || !Number.isFinite(Date.parse(existing.toString("utf8")))) throw new AssetError(409, "asset association marker changed");
        }
        asset.state = "associated";
        asset.associatedAt = now;
      }
      return associated.map(publicDto);
    }
    await Promise.all(associated.map(async (asset) => {
      const directory = await this.safeDirectory(projectId, agentId);
      try {
        if (asset.state === "associated") {
          // This is intentionally not a no-op: a previous metadata rename may
          // have succeeded while its directory sync failed. A retry must finish
          // that durability barrier before reporting success.
          await this.syncDirectory(directory.handle);
          return;
        }
        const updated = { ...asset, state: "associated" as const, associatedAt: now };
        await writeAtomic(path.join(directory.path, `${asset.id}.json`), JSON.stringify(updated));
        // Communication/attachment recovery may rely on this state only after
        // the replacement metadata name is durable.
        await this.syncDirectory(directory.handle);
        Object.assign(asset, updated);
      }
      finally { await directory.handle.close(); }
    }));
    return associated.map(publicDto);
  }

  async content(projectId: string, agentId: string, id: string, preview: boolean): Promise<{ asset: StoredAsset; body: Buffer } | undefined> {
    const asset = await this.read(projectId, agentId, id);
    const file = preview ? asset?.previewFile : asset?.originalFile;
    if (!asset || !file) return undefined;
    if (this.portableFiles) {
      try {
        const relative = this.secureDirectory(projectId, agentId);
        const body = this.secureRead(relative, file, preview ? MAX_PREVIEW_BYTES : ASSET_LIMITS.maxFileBytes);
        if (!body || (!preview && createHash("sha256").update(body).digest("hex") !== asset.sha256)) return undefined;
        return { asset, body };
      } catch { return undefined; }
    }
    try {
      const directory = await this.safeDirectory(projectId, agentId);
      const body = await readNoFollow(path.join(directory.path, file), preview ? MAX_PREVIEW_BYTES : ASSET_LIMITS.maxFileBytes).finally(() => directory.handle.close());
      if (!preview && createHash("sha256").update(body).digest("hex") !== asset.sha256) return undefined;
      return { asset, body };
    } catch { return undefined; }
  }

  async remove(projectId: string, agentId: string, id: string): Promise<boolean> {
    const asset = await this.read(projectId, agentId, id);
    if (!asset || asset.state !== "staged") return false;
    const receipt = this.authority.beginDelete(id, projectId, agentId);
    await this.completeDeletion(receipt);
    return true;
  }

  async enqueueRemoval(projectId: string, agentId: string, id: string): Promise<boolean> {
    if (this.authority.deletionRequested(id)) return true;
    const asset = await this.read(projectId, agentId, id);
    if (!asset || asset.state !== "staged") return false;
    this.authority.beginDelete(id, projectId, agentId);
    return true;
  }

  private async completeDeletion(receipt: {
    assetId: string;
    projectId: string;
    agentId: string;
    auditEventId: string;
    requestedAt: number;
  }): Promise<void> {
    if (this.authority.runtimeAssociatedAssetIds(receipt.projectId, receipt.agentId).has(receipt.assetId)) {
      return;
    }
    if (this.portableFiles) {
      const relative = this.secureDirectory(receipt.projectId, receipt.agentId);
      const { originalFile, previewFile } = canonicalFiles(receipt.assetId);
      this.secureRemove(relative, originalFile);
      this.secureRemove(relative, previewFile);
      this.secureRemove(relative, `${receipt.assetId}.json`);
      this.secureRemove(relative, `${receipt.assetId}.associated`);
      this.authority.recordSecureAudit(this.dataDir, relative, receipt.projectId, receipt.agentId, {
        action: "deleted", id: receipt.assetId, agentId: receipt.agentId,
        projectId: receipt.projectId, at: new Date(receipt.requestedAt).toISOString(),
      }, receipt.auditEventId);
      this.authority.finishDelete(receipt.assetId);
      return;
    }
    const openedDirectory = await this.safeDirectory(receipt.projectId, receipt.agentId);
    const directory = openedDirectory.path;
    try {
      await removeStagedAssetFiles(
        directory,
        receipt.assetId,
        () => this.syncDirectory(openedDirectory.handle),
      );
      this.authority.recordAudit(
        path.join(directory, "audit.jsonl"),
        receipt.projectId,
        receipt.agentId,
        {
          action: "deleted",
          id: receipt.assetId,
          agentId: receipt.agentId,
          projectId: receipt.projectId,
          at: new Date(receipt.requestedAt).toISOString(),
        },
        receipt.auditEventId,
      );
      this.authority.finishDelete(receipt.assetId);
    } finally { await openedDirectory.handle.close(); }
  }

  async reconcile(
    projectId: string,
    agentId: string,
    associatedIds: Set<string>,
    now = Date.now(),
    retainedStagedIds: ReadonlySet<string> = new Set(),
  ): Promise<number> {
    if (this.portableFiles) return this.reconcilePortable(projectId, agentId, associatedIds, now, retainedStagedIds);
    const openedDirectory = await this.safeDirectory(projectId, agentId).catch(() => undefined);
    if (!openedDirectory) return 0;
    const directory = openedDirectory.path;
    let removed = 0;
    const reachableIds = new Set([
      ...associatedIds,
      ...retainedStagedIds,
      ...this.authority.runtimeAssociatedAssetIds(projectId, agentId),
    ]);
    for (const receipt of this.authority.pendingDeletions(projectId, agentId)) {
      if (reachableIds.has(receipt.assetId)) continue;
      await this.completeDeletion(receipt);
      removed += 1;
    }
    const entries = await readdir(directory).catch(() => []);
    const metadataIds = new Set<string>();
    for (const entry of entries) {
      if (!entry.endsWith(".json") || !ID.test(entry.slice(0, -5))) continue;
      const id = entry.slice(0, -5);
      if (await this.read(projectId, agentId, id)) metadataIds.add(id);
    }
    for (const entry of entries) {
      const raw = entry.match(/^([a-f0-9-]{36})\.(bin|preview\.png)$/);
      const temporary = entry.endsWith(".tmp");
      if ((raw && !metadataIds.has(raw[1]!)) || temporary) {
        const target = path.join(directory, entry);
        const old = now - await lstat(target).then((item) => item.mtimeMs).catch(() => now) > STAGED_TTL_MS;
        if (old && raw?.[1] && !reachableIds.has(raw[1])) {
          const receipt = this.authority.beginDelete(raw[1], projectId, agentId);
          await this.completeDeletion(receipt);
          removed++;
        } else if (old && temporary) {
          await rm(target, { force: true });
          removed++;
        }
        continue;
      }
      if (!entry.endsWith(".json") || entry === "audit.jsonl") continue;
      const id = entry.slice(0, -5);
      const asset = await this.read(projectId, agentId, id);
      if (!asset) continue;
      if (associatedIds.has(id) && asset.state !== "associated") {
        await this.associate(projectId, agentId, [id]).catch(() => undefined);
      } else if (!reachableIds.has(id) && asset.state === "staged" &&
          now - Date.parse(asset.createdAt) > STAGED_TTL_MS && await this.remove(projectId, agentId, id)) removed++;
    }
    await openedDirectory.handle.close();
    return removed;
  }

  private async reconcilePortable(
    projectId: string,
    agentId: string,
    associatedIds: Set<string>,
    now: number,
    retainedStagedIds: ReadonlySet<string>,
  ): Promise<number> {
    const relative = this.secureDirectory(projectId, agentId);
    const entries = listSecureDirectory({ root: this.dataDir, relativePath: relative });
    if (!entries) return 0;
    let removed = 0;
    const reachableIds = new Set([
      ...associatedIds, ...retainedStagedIds,
      ...this.authority.runtimeAssociatedAssetIds(projectId, agentId),
    ]);
    for (const receipt of this.authority.pendingDeletions(projectId, agentId)) {
      if (reachableIds.has(receipt.assetId)) continue;
      await this.completeDeletion(receipt);
      removed++;
    }
    const metadataIds = new Set<string>();
    for (const entry of entries) {
      if (!entry.name.endsWith(".json") || !ID.test(entry.name.slice(0, -5))) continue;
      const id = entry.name.slice(0, -5);
      if (this.readPortable(projectId, agentId, id)) metadataIds.add(id);
    }
    for (const entry of entries) {
      if (entry.kind !== "file") continue;
      const raw = /^([a-f0-9-]{36})\.(bin|preview\.png|associated)$/u.exec(entry.name);
      const temporary = entry.name.endsWith(".tmp");
      const old = now - entry.modifiedMs > STAGED_TTL_MS;
      if (old && raw && !metadataIds.has(raw[1]!) && !reachableIds.has(raw[1]!)) {
        const receipt = this.authority.beginDelete(raw[1]!, projectId, agentId);
        await this.completeDeletion(receipt);
        removed++;
      } else if (old && temporary && removeSecureFile({
        root: this.dataDir, relativeDirectory: relative,
        leaf: entry.name, expectedIdentity: entry.identity,
      })) {
        removed++;
      }
      if (!entry.name.endsWith(".json") || !ID.test(entry.name.slice(0, -5))) continue;
      const id = entry.name.slice(0, -5);
      const asset = this.readPortable(projectId, agentId, id);
      if (!asset) continue;
      if (associatedIds.has(id) && asset.state !== "associated") {
        await this.associate(projectId, agentId, [id]).catch(() => undefined);
      } else if (!reachableIds.has(id) && asset.state === "staged" &&
          now - Date.parse(asset.createdAt) > STAGED_TTL_MS && await this.remove(projectId, agentId, id)) removed++;
    }
    return removed;
  }

}

/**
 * A download name can reach here carrying separators — an artifact recorded
 * under a host path, an operator-supplied document title. RFC 5987 encoding
 * hides those from the header parser but not from the browser, which reduces
 * `filename*` to its last segment on save. Reduce to a bare filename here so
 * both parameters describe the same file and the saved name is the one this
 * server chose, not one a path in the value implied.
 */
export function contentDisposition(name: string): string {
  const bare = name.split(/[\\/]/).pop()?.trim() || "asset";
  const fallback = bare.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "asset";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(bare)}`;
}

/**
 * `summary` is a filename for exactly one artifact kind: a generated file
 * records the emitting Agent's own `event.name` there. For every other kind it
 * is prose — a diff's summary is `"<change> <host path>"` — so using it as a
 * download name names the file after the diff's *subject*. That shipped a
 * 115-byte text patch as `Mutant-Knights-Riftfront-1.2.0-READY.jar`, which
 * Forge then rejected with `zip END header not found`. The artifact's own path
 * is authoritative for everything that is not a generated file.
 */
export function managedArtifactDownloadName(
  managed: Pick<ArtifactDto, "kind" | "path" | "summary">,
): string {
  const named = managed.kind === "generated_file" ? managed.summary?.trim() : undefined;
  return named || path.basename(managed.path);
}
