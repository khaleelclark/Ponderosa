import {
  ASSET_MEDIA_TYPES,
  DEFAULT_ASSET_LIMITS,
  LONG_TEXT_MAX_UTF8_BYTES,
  type AssetDto,
} from "@ponderosa/core";
import type { RuntimeArtifactInputV3 } from "./coordination-v3-types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RUNTIME_ATTACHMENT_MEDIA_TYPES = new Set<string>(ASSET_MEDIA_TYPES);
const RUNTIME_ATTACHMENT_FIELDS = new Set(["id", "name", "mediaType", "size", "sha256", "localPath"]);
const RUNTIME_CANONICAL_ATTACHMENT_FIELDS = new Set([
  "id", "agentId", "name", "mediaType", "size", "width", "height", "sha256",
  "state", "createdAt", "url", "downloadUrl", "previewUrl",
]);
const RUNTIME_ARTIFACT_FIELDS = new Set([
  "id", "role", "title", "mediaType", "blobPath", "blobHash", "byteLength",
  "originAgentId", "executionId",
]);
const RUNTIME_MAX_ATTACHMENTS_PER_MESSAGE = DEFAULT_ASSET_LIMITS.maxAssetsPerMessage;
const RUNTIME_MAX_ATTACHMENT_BYTES = DEFAULT_ASSET_LIMITS.maxFileBytes;
const RUNTIME_MAX_MESSAGE_ATTACHMENT_BYTES = DEFAULT_ASSET_LIMITS.maxMessageBytes;
const RUNTIME_MAX_ARTIFACT_BYTES = LONG_TEXT_MAX_UTF8_BYTES;

interface RuntimeDispatchAttachmentV3 {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  sha256?: string;
  localPath?: string;
}

function runtimeArtifactMetadataIsValid(artifact: unknown): artifact is RuntimeArtifactInputV3 {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return false;
  const candidate = artifact as Record<string, unknown>;
  const hasOrigin = Object.prototype.hasOwnProperty.call(candidate, "originAgentId") && candidate.originAgentId !== undefined;
  const hasExecution = Object.prototype.hasOwnProperty.call(candidate, "executionId") && candidate.executionId !== undefined;
  return !Object.keys(candidate).some((field) => !RUNTIME_ARTIFACT_FIELDS.has(field)) &&
    typeof candidate.id === "string" && /^text-[a-f0-9]{64}$/.test(candidate.id) &&
    (candidate.role === "long_text" || candidate.role === "document") &&
    typeof candidate.blobPath === "string" && candidate.blobPath === candidate.id &&
    typeof candidate.title === "string" && Boolean(candidate.title.trim()) &&
    candidate.mediaType === "text/markdown" &&
    typeof candidate.blobHash === "string" && /^[a-f0-9]{64}$/.test(candidate.blobHash) &&
    Number.isSafeInteger(candidate.byteLength) && (candidate.byteLength as number) > 0 &&
    (candidate.byteLength as number) <= RUNTIME_MAX_ARTIFACT_BYTES &&
    hasOrigin === hasExecution &&
    (!hasOrigin || (typeof candidate.originAgentId === "string" && UUID_PATTERN.test(candidate.originAgentId) &&
      typeof candidate.executionId === "string" && UUID_PATTERN.test(candidate.executionId)));
}

function runtimeDispatchAttachmentsAreValid(value: unknown): value is RuntimeDispatchAttachmentV3[] {
  if (!Array.isArray(value) || value.length > RUNTIME_MAX_ATTACHMENTS_PER_MESSAGE) return false;
  const ids = new Set<string>();
  let bytes = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const attachment = item as Record<string, unknown>;
    if (Object.keys(attachment).some((field) => !RUNTIME_ATTACHMENT_FIELDS.has(field)) ||
        typeof attachment.id !== "string" || !UUID_PATTERN.test(attachment.id) || ids.has(attachment.id) ||
        typeof attachment.name !== "string" || !attachment.name.trim() ||
        typeof attachment.mediaType !== "string" || !RUNTIME_ATTACHMENT_MEDIA_TYPES.has(attachment.mediaType) ||
        !Number.isSafeInteger(attachment.size) || (attachment.size as number) < 1 ||
        (attachment.size as number) > RUNTIME_MAX_ATTACHMENT_BYTES ||
        (attachment.sha256 !== undefined &&
          (typeof attachment.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(attachment.sha256))) ||
        (attachment.localPath !== undefined &&
          (typeof attachment.localPath !== "string" || !attachment.localPath.trim()))) return false;
    ids.add(attachment.id);
    bytes += attachment.size as number;
  }
  return bytes <= RUNTIME_MAX_MESSAGE_ATTACHMENT_BYTES;
}

function runtimeCanonicalAttachmentsAreValid(value: unknown): value is AssetDto[] {
  if (!Array.isArray(value) || value.length > RUNTIME_MAX_ATTACHMENTS_PER_MESSAGE) return false;
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const attachment = item as Record<string, unknown>;
    if (Object.keys(attachment).some((field) => !RUNTIME_CANONICAL_ATTACHMENT_FIELDS.has(field)) ||
        typeof attachment.id !== "string" || !UUID_PATTERN.test(attachment.id) || ids.has(attachment.id) ||
        typeof attachment.agentId !== "string" || !UUID_PATTERN.test(attachment.agentId) ||
        typeof attachment.name !== "string" || !attachment.name.trim() ||
        typeof attachment.mediaType !== "string" || !RUNTIME_ATTACHMENT_MEDIA_TYPES.has(attachment.mediaType) ||
        !Number.isSafeInteger(attachment.size) || (attachment.size as number) < 1 ||
        (attachment.size as number) > RUNTIME_MAX_ATTACHMENT_BYTES ||
        typeof attachment.url !== "string" || !attachment.url.trim() ||
        (attachment.width !== undefined && (!Number.isSafeInteger(attachment.width) || (attachment.width as number) < 1)) ||
        (attachment.height !== undefined && (!Number.isSafeInteger(attachment.height) || (attachment.height as number) < 1)) ||
        (attachment.sha256 !== undefined && (typeof attachment.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(attachment.sha256))) ||
        (attachment.state !== undefined && attachment.state !== "staged" && attachment.state !== "associated") ||
        (attachment.createdAt !== undefined && (typeof attachment.createdAt !== "string" || !isIso(attachment.createdAt))) ||
        (attachment.downloadUrl !== undefined && (typeof attachment.downloadUrl !== "string" || !attachment.downloadUrl)) ||
        (attachment.previewUrl !== undefined && (typeof attachment.previewUrl !== "string" || !attachment.previewUrl))) return false;
    ids.add(attachment.id);
    totalBytes += attachment.size as number;
    if (totalBytes > RUNTIME_MAX_MESSAGE_ATTACHMENT_BYTES) return false;
  }
  return true;
}

function isIso(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

export {
  RUNTIME_MAX_ATTACHMENTS_PER_MESSAGE,
  RUNTIME_MAX_MESSAGE_ATTACHMENT_BYTES,
  UUID_PATTERN,
  isIso,
  runtimeArtifactMetadataIsValid,
  runtimeCanonicalAttachmentsAreValid,
  runtimeDispatchAttachmentsAreValid,
};
export type { RuntimeDispatchAttachmentV3 };
