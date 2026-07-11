import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { appendFile, lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { AssetDto, AssetLimitsDto } from "@ponderosa/core";
import { attachmentsDir } from "@ponderosa/threads";

sharp.cache({ memory: 32, files: 0, items: 20 });

export const ASSET_LIMITS: AssetLimitsDto = {
  maxFileBytes: 8 * 1024 * 1024,
  maxRequestBytes: 8 * 1024 * 1024 + 16 * 1024,
  maxAssetsPerMessage: 4,
  maxMessageBytes: 24 * 1024 * 1024,
  maxThreadBytes: 64 * 1024 * 1024,
  acceptedMediaTypes: [
    "image/png", "image/jpeg", "image/webp", "application/pdf",
    "text/plain", "application/json", "application/zip",
  ],
};

const MAX_PIXELS = 25_000_000;
const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
const ID = /^[a-f0-9-]{36}$/;
const BIDI_AND_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export interface StoredAsset extends AssetDto {
  projectId: string;
  state: "staged" | "associated";
  sha256: string;
  createdAt: string;
  associatedAt?: string;
  originalFile: string;
  previewFile?: string;
}

export class AssetError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

function normalizeName(value: unknown): string {
  const raw = String(value ?? "asset").normalize("NFKC").replace(BIDI_AND_CONTROLS, "");
  const leaf = path.basename(raw).replace(/[\\/]/g, "").trim();
  const bytes = Buffer.from(leaf || "asset");
  return (bytes.length <= 160 ? leaf : bytes.subarray(0, 160).toString("utf8").replace(/\uFFFD+$/g, "")) || "asset";
}

function detectType(body: Buffer): AssetDto["mediaType"] | undefined {
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (body[0] === 0xff && body[1] === 0xd8) return "image/jpeg";
  if (body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (body.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "application/zip";
  if (!body.includes(0)) {
    const text = body.toString("utf8");
    if (!text.includes("\uFFFD")) {
      try { JSON.parse(text); return "application/json"; } catch { return "text/plain"; }
    }
  }
  return undefined;
}

function hasStrictImageContainer(body: Buffer, mediaType: AssetDto["mediaType"]): boolean {
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

function extensionMatches(name: string, mediaType: AssetDto["mediaType"]): boolean {
  const extension = path.extname(name).toLocaleLowerCase();
  if (!extension) return true;
  const allowed: Record<AssetDto["mediaType"], string[]> = {
    "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"],
    "application/pdf": [".pdf"], "text/plain": [".txt", ".md", ".csv", ".log"],
    "application/json": [".json"], "application/zip": [".zip"],
  };
  return allowed[mediaType].includes(extension);
}

function contentTypeMatches(declared: string | undefined, detected: AssetDto["mediaType"]): boolean {
  if (!declared || declared === "application/octet-stream") return true;
  return declared.split(";", 1)[0]?.trim().toLocaleLowerCase() === detected;
}

async function writeAtomic(file: string, body: Buffer | string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, file); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

async function readNoFollow(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("unsafe asset file");
    return await handle.readFile();
  } finally { await handle.close(); }
}

function publicDto(asset: StoredAsset): AssetDto {
  const { id, threadId, name, mediaType, size, width, height, url, downloadUrl, previewUrl, sha256, state, createdAt } = asset;
  return { id, threadId, name, mediaType, size, width, height, url, downloadUrl, previewUrl, sha256, state, createdAt };
}

export class AssetStore {
  private activeUploads = new Map<string, number>();
  private recentUploads = new Map<string, number[]>();

  constructor(private dataDir: string) {}

  private dir(projectId: string, threadId: string): string { return attachmentsDir(this.dataDir, projectId, threadId); }
  private metadataFile(projectId: string, threadId: string, id: string): string { return path.join(this.dir(projectId, threadId), `${id}.json`); }

  async read(projectId: string, threadId: string, id: string): Promise<StoredAsset | undefined> {
    if (!ID.test(id)) return undefined;
    try {
      const asset = JSON.parse((await readNoFollow(this.metadataFile(projectId, threadId, id), 32 * 1024)).toString("utf8")) as StoredAsset;
      if (asset.id !== id || asset.projectId !== projectId || asset.threadId !== threadId) return undefined;
      if (!ASSET_LIMITS.acceptedMediaTypes.includes(asset.mediaType)) return undefined;
      return asset;
    } catch { return undefined; }
  }

  async stage(input: { projectId: string; threadId: string; body: Buffer; name: unknown; declaredType?: string }): Promise<AssetDto> {
    const { projectId, threadId, body } = input;
    if (!body.length) throw new AssetError(400, "asset body is required");
    if (body.length > ASSET_LIMITS.maxFileBytes) throw new AssetError(413, "asset exceeds 8 MiB limit");
    const name = normalizeName(input.name);
    const mediaType = detectType(body);
    if (!mediaType || !extensionMatches(name, mediaType) || !contentTypeMatches(input.declaredType, mediaType)) {
      throw new AssetError(415, "file content, media type, and extension must agree");
    }
    if (mediaType.startsWith("image/") && !hasStrictImageContainer(body, mediaType)) {
      throw new AssetError(415, "image container is truncated or contains trailing data");
    }
    const now = Date.now();
    const recent = (this.recentUploads.get(threadId) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= 20) throw new AssetError(429, "asset upload rate limit exceeded");
    if ((this.activeUploads.get(threadId) ?? 0) >= 2) throw new AssetError(429, "too many concurrent asset uploads");
    this.activeUploads.set(threadId, (this.activeUploads.get(threadId) ?? 0) + 1);
    try {
      const directory = this.dir(projectId, threadId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new AssetError(409, "asset storage is unavailable");
      let total = 0;
      for (const entry of await readdir(directory)) {
        if (!entry.endsWith(".json")) continue;
        try { total += (JSON.parse(await readFile(path.join(directory, entry), "utf8")) as StoredAsset).size ?? 0; } catch { /* reconciler handles invalid entries */ }
      }
      if (total + body.length > ASSET_LIMITS.maxThreadBytes) throw new AssetError(413, "thread asset quota exceeded");

      let width: number | undefined, height: number | undefined, preview: Buffer | undefined;
      if (mediaType.startsWith("image/")) {
        try {
          const image = sharp(body, { animated: false, failOn: "error", limitInputPixels: MAX_PIXELS, sequentialRead: true });
          const metadata = await image.metadata();
          if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1 || metadata.width * metadata.height > MAX_PIXELS) throw new Error("unsafe image dimensions");
          width = metadata.width; height = metadata.height;
          preview = await image.rotate().timeout({ seconds: 5 }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
          if (preview.length > ASSET_LIMITS.maxFileBytes) throw new Error("preview exceeds size limit");
        } catch { throw new AssetError(415, "image could not be safely decoded as one bounded frame"); }
      }

      const id = randomUUID();
      const originalFile = `${id}.bin`;
      const previewFile = preview ? `${id}.preview.png` : undefined;
      const createdAt = new Date().toISOString();
      const asset: StoredAsset = {
        id, projectId, threadId, name, mediaType, size: body.length, width, height,
        sha256: createHash("sha256").update(body).digest("hex"), state: "staged", createdAt,
        originalFile, previewFile,
        url: previewFile ? `/api/threads/${encodeURIComponent(threadId)}/attachments/${id}` : `/api/threads/${encodeURIComponent(threadId)}/assets/${id}/download`,
        downloadUrl: `/api/threads/${encodeURIComponent(threadId)}/assets/${id}/download`,
        previewUrl: previewFile ? `/api/threads/${encodeURIComponent(threadId)}/assets/${id}/preview` : undefined,
      };
      await writeAtomic(path.join(directory, originalFile), body);
      try {
        if (preview && previewFile) await writeAtomic(path.join(directory, previewFile), preview);
        await writeAtomic(this.metadataFile(projectId, threadId, id), JSON.stringify(asset));
      } catch (error) {
        await Promise.allSettled([unlink(path.join(directory, originalFile)), previewFile ? unlink(path.join(directory, previewFile)) : Promise.resolve()]);
        throw error;
      }
      await this.audit(directory, { action: "staged", id, threadId, projectId, size: body.length, mediaType, at: createdAt });
      this.recentUploads.set(threadId, [...recent, now]);
      return publicDto(asset);
    } finally {
      const next = (this.activeUploads.get(threadId) ?? 1) - 1;
      if (next) this.activeUploads.set(threadId, next); else this.activeUploads.delete(threadId);
    }
  }

  async associate(projectId: string, threadId: string, ids: string[]): Promise<AssetDto[]> {
    const assets = await Promise.all(ids.map((id) => this.read(projectId, threadId, id)));
    if (assets.some((asset) => !asset)) throw new AssetError(404, "asset not found");
    const integrity = await Promise.all(ids.map((id) => this.content(projectId, threadId, id, false)));
    if (integrity.some((item) => !item)) throw new AssetError(404, "asset not found");
    const now = new Date().toISOString();
    const associated = assets as StoredAsset[];
    await Promise.all(associated.map(async (asset) => {
      if (asset.state === "associated") return;
      const updated = { ...asset, state: "associated" as const, associatedAt: now };
      await writeAtomic(this.metadataFile(projectId, threadId, asset.id), JSON.stringify(updated));
      Object.assign(asset, updated);
    }));
    return associated.map(publicDto);
  }

  async content(projectId: string, threadId: string, id: string, preview: boolean): Promise<{ asset: StoredAsset; body: Buffer } | undefined> {
    const asset = await this.read(projectId, threadId, id);
    const file = preview ? asset?.previewFile : asset?.originalFile;
    if (!asset || !file) return undefined;
    try {
      const target = path.join(this.dir(projectId, threadId), file);
      const body = await readNoFollow(target, ASSET_LIMITS.maxFileBytes);
      if (!preview && createHash("sha256").update(body).digest("hex") !== asset.sha256) return undefined;
      return { asset, body };
    } catch { return undefined; }
  }

  async remove(projectId: string, threadId: string, id: string): Promise<boolean> {
    const asset = await this.read(projectId, threadId, id);
    if (!asset || asset.state !== "staged") return false;
    await Promise.allSettled([unlink(path.join(this.dir(projectId, threadId), asset.originalFile)), asset.previewFile ? unlink(path.join(this.dir(projectId, threadId), asset.previewFile)) : Promise.resolve(), unlink(this.metadataFile(projectId, threadId, id))]);
    await this.audit(this.dir(projectId, threadId), { action: "deleted", id, threadId, projectId, at: new Date().toISOString() });
    return true;
  }

  async reconcile(projectId: string, threadId: string, associatedIds: Set<string>, now = Date.now()): Promise<number> {
    const directory = this.dir(projectId, threadId);
    let removed = 0;
    for (const entry of await readdir(directory).catch(() => [])) {
      if (!entry.endsWith(".json") || entry === "audit.jsonl") continue;
      const id = entry.slice(0, -5);
      const asset = await this.read(projectId, threadId, id);
      if (!asset) continue;
      if (associatedIds.has(id) && asset.state !== "associated") await this.associate(projectId, threadId, [id]).catch(() => undefined);
      else if (asset.state === "staged" && now - Date.parse(asset.createdAt) > STAGED_TTL_MS && await this.remove(projectId, threadId, id)) removed++;
    }
    return removed;
  }

  private async audit(directory: string, record: Record<string, unknown>): Promise<void> {
    await appendFile(path.join(directory, "audit.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
}

export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "asset";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
