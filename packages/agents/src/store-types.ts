import type {
  AgentDeletionPreviewDto,
  AgentDto,
  AgentPresetDto,
  ArtifactDto,
  CommunicationAudience,
  ConversationChannel,
  AssetDto,
} from "@ponderosa/core";

export interface ContextReadBoundary {
  createdAt: string;
  id: string;
}

export interface ContextSourcePage<T> {
  items: T[];
  hasMore: boolean;
}

export interface ActivityProjectionReadRow {
  seq: number;
  execution_id: string | null;
  event_json: string;
  created_at: string;
  output_preview_utf8_bytes: number | null;
  output_total_utf8_bytes: number | null;
  output_sha256: string | null;
}

export interface RunOutputSegmentRow {
  first_seq: number;
  last_seq: number;
  event_type: "text" | "reasoning";
  execution_id: string;
  created_at: string;
  text_preview: string;
  preview_utf8_bytes: number;
  raw_utf8_bytes: number;
  canonical_utf8_bytes: number;
}

export interface ArtifactProjectionReadRow {
  id: string;
  agent_id: string;
  execution_id: string | null;
  kind: string;
  path: string;
  summary: string | null;
  created_at: string;
  source_path: string | null;
  media_type: string | null;
  visibility: string | null;
  pinned: number | null;
  size: number | null;
}

export interface ProjectJson {
  id: string;
  label: string;
  hostPath: string;
  createdAt: string;
  lastUsedAt?: string;
  defaultEngine: string;
  defaultModel?: string;
  defaultEffort?: string;
  lastConversationId?: string;
  instructions?: string;
}

export interface ManagedArtifactAccess {
  ownerKind: "project" | "communication" | "request_update";
  ownerId: string;
  audience: CommunicationAudience | { kind: "request_agents"; agentIds: string[]; userId?: string };
  senderAgentId?: string;
}

export type ManagedArtifactEvent =
  | { type: "created"; artifact: ArtifactDto & { projectId: string; originAgentId: string }; access?: ManagedArtifactAccess }
  | { type: "visibility"; artifactId: string; visibility: "project" | "published"; pinned: boolean; at: string }
  | { type: "deleted"; artifactId: string; at: string; reason: string };

export interface AgentJson {
  id: string;
  projectId: string;
  /** Canonical owner Chat. Missing only from immutable deleted-Agent tombstones. */
  conversationId?: string;
  title: string;
  handle: string;
  activeEngine: string;
  model?: string;
  effort?: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  deletedAt?: string;
  managementPermissions?: AgentDto["managementPermissions"];
  spawnedByAgentId?: string;
  spawnedByExecutionId?: string;
  spawnPrompt?: string;
  spawnIdempotencyKey?: string;
  creationIdempotencyKey?: string;
  presetSnapshot?: AgentDto["presetSnapshot"];
  /** Missing only while the launch migration writes the explicit Shared contract. */
  workingCopy?: AgentDto["workingCopy"];
}

export interface AgentSpawnOrigin {
  agentId: string;
  executionId: string;
  idempotencyKey: string;
  prompt?: string;
}

export type PresetEvent = { type: "upsert"; preset: AgentPresetDto } | { type: "delete"; id: string; at: string };

export interface ConversationJson {
  id: string;
  projectId: string;
  title: string;
  defaultEngine?: string;
  defaultModel?: string;
  defaultEffort?: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface ConversationDeliveryIntent {
  targetAgentId: string;
  relayDepth: number;
  mentionTrail: string[];
  kind: "direct" | "tag";
  /** The selector that authorized this recipient when the message was recorded. */
  audience?: "mention" | "everyone";
  /** Explicit behavior when the recipient has an active durable wait. */
  /** Target-owned staged assets delivered with this recipient turn. */
  attachmentIds?: string[];
}

export interface MessageDispatchRecord {
  schemaVersion: 1;
  eventId: string;
  messageId: string;
  conversationId: string;
  channel: ConversationChannel;
  role: "user" | "assistant" | "system";
  renderedText: string;
  createdAt: string;
  authorAgentId?: string;
  deliveryIntents?: ConversationDeliveryIntent[];
  messageReceiptKey?: string;
  orderKey: string;
  attachments?: AssetDto[];
  artifactIds?: string[];
}

export interface AgentDeletionReceipt {
  id: string;
  projectId: string;
  previewHash: string;
  rootAgentIds: string[];
  deletedAgentIds: string[];
  storageCleanupCompleted: boolean;
  serverCleanupCompleted: boolean;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ProjectDeletionReceipt {
  projectId: string;
  tombstoneName: string;
  storageCleanupCompleted: boolean;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentManagementAuthorization {
  planId: string;
  projectId: string;
  conversationId: string;
  ownerAgentId: string;
  runId: string;
  scopeHash: string;
  permission: "deletion" | "reorganization";
  approvalDecisionId?: string;
}

export interface ManagementOperation {
  kind: "create_agent" | "rename_agent" | "stop_agent" | "delete_agent" | "set_manager";
  ref?: string;
  targetAgentId?: string;
  parentRef?: string;
  managerAgentId?: string | null;
  title?: string;
  engine?: string;
  model?: string;
  effort?: string;
  instructions?: string;
  /** Server-captured authority for stop_agent. Provider input cannot set it. */
  targetRunId?: string;
}

export interface ManagementOperationProgress {
  index: number;
  kind: ManagementOperation["kind"];
  receipt: Record<string, unknown>;
}

export interface ManagementPlan {
  id: string;
  agentId: string;
  runId: string;
  conversationId: string;
  projectId: string;
  idempotencyKey: string;
  requestHash: string;
  operations: ManagementOperation[];
  deletionPreview?: AgentDeletionPreviewDto;
  scopeHash: string;
  approvalRequired: boolean;
  approvalDecisionId?: string;
  status: "planned" | "applying" | "completed";
  operationProgress: ManagementOperationProgress[];
  refs: Record<string, string>;
  changedAgentIds: string[];
  createdAt: string;
  appliedAt?: string;
  result?: unknown;
}
