import type { AssetDto, RuntimeInputMaterial } from "@ponderosa/core";
import type { AssetStore } from "./assets.js";
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync, rmSync } from "@ponderosa/native-host/fs";
import { mkdir, rm, writeFile } from "@ponderosa/native-host/fs/promises";
import path from "node:path";

const safeScopeId = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const runtimeAttachmentsRoot = (dataDir: string): string =>
  path.join(dataDir, "runtime-attachments");

export const runtimeAttachmentDirectoryForSession = (
  dataDir: string,
  agentId: string,
): string =>
  path.join(runtimeAttachmentsRoot(dataDir), "sessions", safeScopeId(agentId));

export const runtimeAttachmentDirectoryForRun = (
  dataDir: string,
  runId: string,
): string =>
  path.join(runtimeAttachmentsRoot(dataDir), "runs", safeScopeId(runId));

/** Resolve the validated copy to a path visible inside the provider sandbox. */
export function runtimeAttachmentProviderPath(localPath: string): string {
  return realpathSync(localPath);
}

export async function cleanupRuntimeAttachments(directory?: string): Promise<void> {
  if (!directory) return;
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

export function cleanupAgentRuntimeAttachments(
  dataDir: string,
  agentId: string,
): void {
  rmSync(runtimeAttachmentDirectoryForSession(dataDir, agentId), {
    recursive: true,
    force: true,
  });
}

export function cleanupAllRuntimeAttachments(dataDir: string): void {
  rmSync(runtimeAttachmentsRoot(dataDir), { recursive: true, force: true });
}

const RUNTIME_ATTACHMENT_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
};

const extensionForMediaType = (mediaType: string): string =>
  RUNTIME_ATTACHMENT_EXTENSIONS[mediaType] ?? "";

const usesRuntimeImagePreview = (item: Pick<AssetDto, "mediaType" | "width" | "height">): boolean =>
  ["image/heic", "image/gif", "image/avif"].includes(item.mediaType)
  || (item.width ?? 0) * (item.height ?? 0) > 64_000_000;

export const runtimeAttachmentName = (item: AssetDto): string => {
  const base = path.basename(item.name)
    .replaceAll(/[\\/\u0000-\u001f\u007f]/gu, "_")
    .trim()
    .slice(0, 180) || "attachment";
  const name = usesRuntimeImagePreview(item)
    ? `${base.replace(/\.(heic|heif|gif|avif|jpg|jpeg)$/iu, "")}.png`
    : path.extname(base) ? base : `${base}${extensionForMediaType(item.mediaType)}`;
  return `${item.id}-${name}`;
};

export interface RuntimeAttachmentCopy {
  localPath: string;
  available: boolean;
  original?: RuntimeInputMaterial;
  image?: RuntimeInputMaterial;
}

async function writeImmutableRuntimeCopy(file: string, body: Buffer): Promise<void> {
  try { await writeFile(file, body, { mode: 0o600, flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size !== body.length ||
          !readFileSync(fd).equals(body)) throw new Error("Runtime attachment copy changed after admission");
    } finally { closeSync(fd); }
  }
}

/** Named copies are shared by normal turns and active steering. Originals are never replaced by previews. */
export async function copyRuntimeAttachment(_dataDir: string, directory: string, projectId: string, item: AssetDto,
  assets: Pick<AssetStore, "content">): Promise<RuntimeAttachmentCopy> {
  // The managed content reader verifies immutable original bytes for both Chat and Agent owners.
  const original = await assets.content(projectId, item.agentId, item.id, false);
  if (!original || original.asset.conversationId !== item.conversationId ||
      original.asset.sha256 !== item.sha256 || original.body.length !== item.size)
    return { localPath: "", available: false };
  const preview = usesRuntimeImagePreview(item) ? await assets.content(projectId, item.agentId, item.id, true) : undefined;
  if (usesRuntimeImagePreview(item) && !preview) return { localPath: "", available: false };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const localPath = path.join(directory, runtimeAttachmentName(item));
  const originalPath = preview ? `${localPath}.original` : localPath;
  await writeImmutableRuntimeCopy(originalPath, original.body);
  if (preview) await writeImmutableRuntimeCopy(localPath, preview.body);
  const material = (file: string, body: Buffer, mediaType: string): RuntimeInputMaterial => ({
    localPath: runtimeAttachmentProviderPath(file), mediaType, byteLength: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
  return { localPath: runtimeAttachmentProviderPath(localPath), available: true,
    original: material(originalPath, original.body, item.mediaType),
    ...(preview ? { image: material(localPath, preview.body, "image/png") } : {}) };
}
