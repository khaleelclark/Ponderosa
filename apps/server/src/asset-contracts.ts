import { existsSync, mkdirSync } from "@ponderosa/native-host/fs";
import path from "node:path";
import {
  DEFAULT_ASSET_LIMITS,
  type ArtifactDto,
  type AssetDto,
  type AssetLimitsDto,
} from "@ponderosa/core";
import type {
  RuntimeArtifactInputV3,
} from "@ponderosa/agents";

export const ASSET_LIMITS: AssetLimitsDto = DEFAULT_ASSET_LIMITS;
export const UPLOAD_LEASE_MS = 5 * 60 * 1000;
export const DRAFT_ASSET_LIMITS = Object.freeze({
  maxSurfaceBytes: ASSET_LIMITS.maxAgentBytes,
  maxWorkspaceBytes: ASSET_LIMITS.maxAgentBytes * 4,
  maxSurfaceAssets: 256,
  maxWorkspaceAssets: 1_024,
  maxConcurrentUploadsPerSurface: 4,
  maxUploadsPerMinutePerSurface: 100,
  maxUploadsPerMinuteWorkspace: 400,
});
export const ID = /^[a-f0-9-]{36}$/;
export const RUNTIME_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const BIDI_AND_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export interface StoredAsset extends AssetDto {
  projectId: string;
  state: "staged" | "associated";
  sha256: string;
  createdAt: string;
  associatedAt?: string;
  originalFile: string;
  previewFile?: string;
}

export function associatedAssetDto(asset: StoredAsset): AssetDto {
  const { projectId: _projectId, originalFile: _originalFile, previewFile: _previewFile, associatedAt: _associatedAt, ...publicAsset } = asset;
  return { ...publicAsset, state: "associated" };
}

export interface AuthoritativeRuntimeAttachment {
  attachment: AssetDto & { sha256: string };
  localPath: string;
  contentHash: string;
  byteLength: number;
}

export interface AuthoritativeRuntimeArtifact {
  artifact: RuntimeArtifactInputV3;
  body: Buffer;
  localPath: string;
  contentHash: string;
  byteLength: number;
}

export type RegisteredGeneratedArtifact = ArtifactDto & {
  projectId: string;
  originAgentId: string;
  kind: "generated_file";
  mediaType: string;
  summary: string;
  size: number;
  sha256: string;
};
export interface GeneratedArtifactImportReceipt {
  runId: string;
  toolCallId: string;
  requestHash: string;
  projected: boolean;
  artifact: RegisteredGeneratedArtifact;
}


export interface AuthoritativeGeneratedArtifact {
  artifact: RegisteredGeneratedArtifact;
  body: Buffer;
  localPath: string;
  contentHash: string;
  byteLength: number;
}

export interface RuntimeAttachmentAssociation {
  communicationId: string;
  projectId: string;
  agentId: string;
  attachmentId: string;
  contentHash: string;
  byteLength: number;
}

export interface RegisteredRuntimeArtifact extends RuntimeArtifactInputV3 {
  projectId: string;
  createdAt: string;
}

export function runtimeArtifactIdentityMatches(
  registered: Omit<RegisteredRuntimeArtifact, "id" | "createdAt" | "originAgentId" | "executionId"> & {
    originAgentId?: string | null;
    executionId?: string | null;
  },
  expected: Omit<RegisteredRuntimeArtifact, "id" | "createdAt" | "originAgentId" | "executionId"> & {
    originAgentId?: string | null;
    executionId?: string | null;
  },
): boolean {
  return registered.projectId === expected.projectId && registered.role === expected.role &&
    registered.title === expected.title && registered.mediaType === expected.mediaType &&
    registered.blobPath === expected.blobPath && registered.blobHash === expected.blobHash &&
    registered.byteLength === expected.byteLength &&
    (registered.originAgentId ?? null) === (expected.originAgentId ?? null) &&
    (registered.executionId ?? null) === (expected.executionId ?? null);
}

export function generatedArtifactIdentity(artifact: RegisteredGeneratedArtifact): Record<string, unknown> {
  return {
    id: artifact.id,
    projectId: artifact.projectId,
    agentId: artifact.agentId,
    originAgentId: artifact.originAgentId,
    executionId: artifact.executionId ?? null,
    kind: artifact.kind,
    path: artifact.path,
    sourcePath: artifact.sourcePath ?? null,
    summary: artifact.summary,
    createdAt: artifact.createdAt,
    mediaType: artifact.mediaType,
    size: artifact.size,
    sha256: artifact.sha256,
  };
}

export function generatedArtifactMetadataIsValid(artifact: RegisteredGeneratedArtifact): boolean {
  if (!OWNER_ID.test(artifact.id) || !OWNER_ID.test(artifact.projectId) ||
      !OWNER_ID.test(artifact.agentId) || !OWNER_ID.test(artifact.originAgentId) ||
      artifact.kind !== "generated_file" || !artifact.summary.trim() ||
      path.basename(artifact.summary) !== artifact.summary || !artifact.mediaType.trim() ||
      !Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > 64 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) || !artifact.createdAt ||
      path.isAbsolute(artifact.path) || artifact.path.includes("\\") || artifact.path.split("/").includes("..")) return false;
  const normalized = path.posix.normalize(artifact.path);
  if (normalized !== artifact.path || normalized.startsWith("../") || normalized === ".") return false;
  const leaf = path.posix.basename(normalized);
  if (leaf !== artifact.id && !leaf.startsWith(`${artifact.id}.`)) return false;
  const extension = path.posix.extname(leaf).toLowerCase();
  const nameExtension = path.extname(artifact.summary).toLowerCase();
  const expectedMediaTypes = ({
    ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".jar": "application/java-archive",
    ".md": ["text/markdown", "text/plain"], ".txt": ["text/plain"],
    ".csv": ["text/csv", "text/plain"], ".log": ["text/plain"],
    ".json": "application/json", ".html": "text/html", ".zip": "application/zip",
  } as Record<string, string | readonly string[]>)[extension] ?? "application/octet-stream";
  const acceptedMediaTypes = Array.isArray(expectedMediaTypes) ? expectedMediaTypes : [expectedMediaTypes];
  return Boolean(nameExtension === extension && acceptedMediaTypes.includes(artifact.mediaType) &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(artifact.summary));
}

export class AssetError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export function mkdirSyncSafe(dataDir: string): void {
  // The server creates this root before stores open their durable state.
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}
