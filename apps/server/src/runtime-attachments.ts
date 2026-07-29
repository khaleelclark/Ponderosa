import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";
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
