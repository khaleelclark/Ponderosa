import type { AssetDto } from "@ponderosa/core";
import { attachmentsDir } from "@ponderosa/agents";
import type { AssetStore } from "./assets.js";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, rmSync } from "@ponderosa/native-host/fs";
import { copyFile, mkdir, rm, writeFile } from "@ponderosa/native-host/fs/promises";
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

/** Named copies are shared by normal turns and active steering. */
export async function copyRuntimeAttachment(dataDir: string, directory: string, projectId: string, item: AssetDto,
  assets: Pick<AssetStore, "content">): Promise<{ localPath: string; available: boolean }> {
  const source = path.join(attachmentsDir(dataDir, projectId, item.agentId),
    `${item.id}${usesRuntimeImagePreview(item) ? ".preview.png" : ".bin"}`);
  if (!existsSync(source)) return { localPath: source, available: false };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const localPath = path.join(directory, runtimeAttachmentName(item));
  if (item.conversationId) {
    const verified = await assets.content(projectId, item.agentId, item.id, usesRuntimeImagePreview(item));
    if (!verified || verified.asset.conversationId !== item.conversationId || verified.asset.sha256 !== item.sha256)
      return { localPath: "", available: false };
    await writeFile(localPath, verified.body, { mode: 0o600 });
  } else await copyFile(source, localPath);
  return { localPath: runtimeAttachmentProviderPath(localPath), available: true };
}
