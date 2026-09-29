export const ASSET_MEDIA_TYPES = [
  "image/png", "image/jpeg", "image/webp", "image/heic",
  "application/pdf", "text/plain", "application/json", "application/zip",
] as const;

export type AssetMediaType = typeof ASSET_MEDIA_TYPES[number];

/** A content-validated asset staged for or associated with a message. A
 * Chat-owned Broadcast uses conversationId as its storage owner and has no
 * Agent record; older Agent-owned assets omit conversationId. */
export interface AssetDto {
  id: string;
  agentId: string;
  conversationId?: string;
  name: string;
  mediaType: AssetMediaType;
  size: number;
  width?: number;
  height?: number;
  sha256?: string;
  state?: "staged" | "associated";
  createdAt?: string;
  /** Opaque preview-or-download URL; never a host filesystem path. */
  url?: string;
  downloadUrl?: string;
  previewUrl?: string;
  /** A durable message reference whose managed bytes or read authority are gone. */
  unavailable?: boolean;
}

/** An authorized attachment projected into Communication. Managed artifacts
 * retain their catalog media type without widening human upload admission. */
export type CommunicationAttachmentDto = Omit<AssetDto, "mediaType"> & {
  mediaType: string;
};

export interface AssetLimitsDto {
  maxFileBytes: number;
  maxRequestBytes: number;
  maxAssetsPerMessage: number;
  maxMessageBytes: number;
  maxAgentBytes: number;
  acceptedMediaTypes: AssetMediaType[];
}

/** One shared admission budget for uploads, canonical Communications, and
 * per-recipient runtime dispatch snapshots. */
export const DEFAULT_ASSET_LIMITS: AssetLimitsDto = {
  maxFileBytes: 80 * 1024 * 1024,
  maxRequestBytes: 8 * 1024 * 1024 + 16 * 1024,
  maxAssetsPerMessage: 20,
  maxMessageBytes: 80 * 1024 * 1024,
  maxAgentBytes: 512 * 1024 * 1024,
  acceptedMediaTypes: [...ASSET_MEDIA_TYPES],
};

/** Kind of artifact (SPEC §2/§12): the "what changed". */
export type ArtifactKind = "diff" | "test_report" | "pr_summary" | "log" | "document" | "screenshot" | "generated_file";

/** Latest state of a path touched by this agent, rebuilt from canonical file-change events. */
export interface ChangedFileDto {
  path: string;
  kind: "create" | "edit" | "delete";
  lastSeq: number;
  lastChangedAt: string;
  executionCount: number;
  diffAvailable: boolean;
}

/** On-demand bounded provenance and diff preview for one changed path. */
export interface ChangedFileDetailDto extends ChangedFileDto {
  executionIds: string[];
  provenanceTruncated: boolean;
  diff?: string;
}

/** An Artifacts-pane entry (SPEC §7 `artifacts`). Metadata only; content via :aid. */
export interface ArtifactDto {
  id: string;
  /** Owning Project for stable cross-Agent retrieval. */
  projectId?: string;
  agentId: string;
  /** Agent that created the artifact; retained after that Agent is deleted. */
  originAgentId?: string;
  /** Explicit legacy custody, never a replacement for original creator provenance. */
  legacyRecovery?: { custodianAgentId: string; recoveredAt: string };
  executionId?: string;
  kind: ArtifactKind;
  /** Relative path under the agent's `artifacts/` dir. */
  path: string;
  summary?: string;
  createdAt: string;
  /** Generated files are served through opaque, project-scoped URLs. */
  mediaType?: string;
  previewUrl?: string;
  downloadUrl?: string;
  /** Project-scoped visibility; generated files are private unless explicitly published. */
  visibility?: "project" | "published";
  pinned?: boolean;
  sourcePath?: string;
  size?: number;
  /** Immutable SHA-256 of Project-managed generated-file bytes. */
  sha256?: string;
}

/** GET /api/agents/:id/artifacts/:aid — the artifact plus its rendered content. */
export interface ArtifactContentDto extends ArtifactDto {
  /** UTF-8 preview content, bounded to 2 MiB. */
  content: string;
  /** Hint for the read-only viewer (markdown vs plain vs unified diff). */
  contentType: "markdown" | "diff" | "text";
  truncated?: boolean;
  totalBytes?: number;
}
