// Tables actually accessed through Drizzle. Authoritative Communication V3
// tables live in the launch baseline and the raw-SQL coordination store; duplicating
// those declarations here provided no type checking for their queries.

import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  hostPath: text("host_path").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
  defaultEngine: text("default_engine").notNull(),
  defaultModel: text("default_model"),
  defaultEffort: text("default_effort"),
  lastConversationId: text("last_conversation_id"),
});

/** Durable fail-closed quarantine created before Project runtime cleanup. */
export const projectDeletionPending = sqliteTable("project_deletion_pending", {
  projectId: text("project_id").primaryKey(),
  createdAt: text("created_at").notNull(),
  lastError: text("last_error"),
  /** Exact hidden directory used across the filesystem/SQLite commit boundary. */
  tombstoneName: text("tombstone_name"),
  /** Receipt-bound identity mirrored inside the exact tombstone directory. */
  ownershipToken: text("ownership_token"),
  /** Immutable Chat/Agent draft surface inventory captured at quarantine. */
  draftSurfacesJson: text("draft_surfaces_json"),
});

/** Durable receipt for an irreversible Project purge and its retryable
 * filesystem tombstone cleanup. */
export const projectDeletionReceipts = sqliteTable("project_deletion_receipts", {
  projectId: text("project_id").primaryKey(),
  productScope:text('product_scope').notNull(),
  tombstoneName: text("tombstone_name").notNull(),
  ownershipToken: text("ownership_token"),
  /** Durable boundary proving that exact owned storage was authorized for removal. */
  removalStarted: integer("removal_started").notNull().default(0),
  storageCleanupCompleted: integer("storage_cleanup_completed").notNull().default(0),
  draftSurfacesJson: text("draft_surfaces_json").notNull().default("[]"),
  draftCleanupCompleted: integer("draft_cleanup_completed").notNull().default(1),
  assetAuthorityCleanupCompleted: integer("asset_authority_cleanup_completed").notNull().default(0),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
});
export const agentPresets = sqliteTable("agent_presets", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull(), name: text("name").notNull(),
  description: text("description").notNull(), guidance: text("guidance").notNull(), engine: text("engine").notNull(),
  model: text("model"), effort: text("effort"), enabled: integer("enabled").notNull().default(1),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  conversationId: text("conversation_id"),
  title: text("title").notNull(),
  handle: text("handle").notNull(),
  activeEngine: text("active_engine").notNull(),
  model: text("model"),
  effort: text("effort"),
  speed: text("speed"),
  activeSessionId: text("active_session_id"),
  activeSessionContractHash: text("active_session_contract_hash"),
  activeSessionArtifactIdsJson: text("active_session_artifact_ids_json").notNull().default("[]"),
  stateBranch: text("state_branch"),
  stateCommit: text("state_commit"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  /** Null for live authority; populated for an deleted-Agent cleanup identity. */
  deletedAt: text("deleted_at"),
  managerAgentId: text("manager_agent_id"),
  allowAutomaticDescendantDeletion: integer("allow_automatic_descendant_deletion").notNull().default(0),
  allowAutomaticDescendantReorganization: integer("allow_automatic_descendant_reorganization").notNull().default(0),
  spawnedByAgentId: text("spawned_by_agent_id"),
  spawnedByExecutionId: text("spawned_by_execution_id"),
  spawnPrompt: text("spawn_prompt"),
  spawnIdempotencyKey: text("spawn_idempotency_key"),
  presetSnapshotJson: text("preset_snapshot_json"),
  creationIdempotencyKey: text("creation_idempotency_key"),
  workingCopyJson: text("working_copy_json").notNull(),
});

/** Retains every allocated handle so rename/deletion can never recycle it. */
export const agentHandleReservations = sqliteTable("agent_handle_reservations", {
  projectId: text("project_id").notNull(),
  normalizedHandle: text("normalized_handle").notNull(),
  handle: text("handle").notNull(),
  agentId: text("agent_id").notNull(),
  reservedAt: text("reserved_at").notNull(),
});

/** Rebuildable projection of the one unconsumed provider-session continuation
 * handoff for an Agent. The append-only Agent log remains authoritative. */
export const continuationHandoffs = sqliteTable("continuation_handoffs", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  sourceExecutionId: text("source_execution_id").notNull(),
  consumedByExecutionId: text("consumed_by_execution_id"),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull(),
  consumedAt: text("consumed_at"),
});

/** Authoritative crash-recovery journal for filesystem-backed Agent deletion. */
export const agentDeletionPending = sqliteTable("agent_deletion_pending", {
  agentId: text("agent_id").primaryKey(),
  projectId: text("project_id").notNull(),
  conversationId: text("conversation_id"),
  tombstoneName: text("tombstone_name").notNull(),
  ownershipToken: text("ownership_token").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Durable exact identity for an Agent directory whose deletion committed. */
export const agentDeletionTombstones = sqliteTable("agent_deletion_tombstones", {
  agentId: text("agent_id").primaryKey(),
  projectId: text("project_id").notNull(),
  conversationId: text("conversation_id"),
  tombstoneName: text("tombstone_name").notNull(),
  ownershipToken: text("ownership_token"),
  createdAt: text("created_at").notNull(),
});

/** Durable receipt for an irreversible Agent deletion and its retryable
 * secondary cleanup. */
export const agentDeletionReceipts = sqliteTable("agent_deletion_receipts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  productScope:text('product_scope').notNull(),
  previewHash: text("preview_hash").notNull(),
  rootAgentIdsJson: text("root_agent_ids_json").notNull(),
  deletedAgentIdsJson: text("deleted_agent_ids_json").notNull(),
  storageCleanupCompleted: integer("storage_cleanup_completed").notNull().default(0),
  serverCleanupCompleted: integer("server_cleanup_completed").notNull().default(0),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
});

/** Server-owned, plan-bound destructive approval. A Decision supplies the
 * human response; this row supplies exact scope and single-use enforcement. */
export const agentManagementApprovals = sqliteTable("agent_management_approvals", {
  decisionId: text("decision_id").primaryKey(),
  planId: text("plan_id").notNull(),
  projectId: text("project_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  ownerAgentId: text("owner_agent_id").notNull(),
  runId: text("run_id").notNull(),
  scopeHash: text("scope_hash").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
  consumedAt: text("consumed_at"),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  branchId: text("branch_id"),
  executionId: text("branch_execution_id"),
  title: text("title").notNull(),
  defaultEngine: text("default_engine"),
  defaultModel: text("default_model"),
  defaultEffort: text("default_effort"),
  defaultSpeed: text("default_speed"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Durable intent and phase receipt for canonical Chat deletion and its
 * retryable filesystem, draft, and workspace cleanup. */
export const conversationDeletionReceipts = sqliteTable("conversation_deletion_receipts", {
  conversationId: text("conversation_id").primaryKey(),
  projectId: text("project_id").notNull(),
  branchId: text("branch_id"),
  tombstoneName: text("tombstone_name"),
  ownershipToken: text("ownership_token"),
  removalStarted: integer("removal_started").notNull().default(0),
  canonicalDeletionCompleted: integer("canonical_deletion_completed").notNull().default(0),
  storageCleanupCompleted: integer("storage_cleanup_completed").notNull().default(0),
  serverCleanupCompleted: integer("server_cleanup_completed").notNull().default(0),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
});

/** Rebuildable compatibility index of each live Agent's single owner Chat. */
export const agentConversationMemberships = sqliteTable("agent_conversation_memberships", {
  agentId: text("agent_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  position: integer("position").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  communicationEventId: text("communication_event_id"),
  agentId: text("agent_id").notNull(),
  seq: integer("seq").notNull(),
  role: text("role").notNull(), // "user" | "assistant"
  text: text("text").notNull(),
  createdAt: text("created_at").notNull(),
  attachmentsJson: text("attachments_json"),
});

/**
 * Rebuildable, human-facing global Chat search projection. This deliberately
 * excludes runtime events. Team Chat rows support bounded timeline reads but
 * remain excluded by the global-search query. Search reads this table
 * newest-first instead of materializing every canonical timeline.
 */
export const chatSearchMessages = sqliteTable("chat_search_messages", {
  rowKey: text("row_key").primaryKey(),
  projectId: text("project_id").notNull(),
  chatKind: text("chat_kind").notNull(), // "conversation" | "agent"
  chatId: text("chat_id").notNull(),
  messageId: text("message_id").notNull(),
  communicationEventId: text("communication_event_id").notNull(),
  role: text("role").notNull(),
  authorAgentId: text("author_agent_id"),
  timestamp: text("timestamp").notNull(),
  orderKey: text("order_key").notNull(),
  text: text("text").notNull(),
  conversationId: text("conversation_id"),
  communicationIntent: text("communication_intent"),
  senderKind: text("sender_kind"),
  senderAgentId: text("sender_agent_id"),
  contextPolicy: text("context_policy"),
});

export const importedHistoryMessages = sqliteTable("imported_history_messages", {
  agentId: text("agent_id").notNull(),
  messageId: text("message_id").notNull(),
  sequence: integer("sequence").notNull(),
  role: text("role").notNull(),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.agentId, table.messageId] })]);

export const activityProjection = sqliteTable("activity_projection", {
  agentId: text("agent_id").notNull(),
  seq: integer("seq").notNull(),
  eventType: text("event_type").notNull(),
  executionId: text("execution_id"),
  eventJson: text("event_json").notNull(),
  createdAt: text("created_at").notNull(),
  outputPreviewUtf8Bytes: integer("output_preview_utf8_bytes"),
  outputTotalUtf8Bytes: integer("output_total_utf8_bytes"),
  outputSha256: text("output_sha256"),
}, (table) => [primaryKey({ columns: [table.agentId, table.seq] })]);

export const changedFileProjection = sqliteTable("changed_file_projection", {
  agentId: text("agent_id").notNull(),
  path: text("path").notNull(),
  kind: text("kind").notNull(),
  lastSeq: integer("last_seq").notNull(),
  lastChangedAt: text("last_changed_at").notNull(),
  executionIdsJson: text("execution_ids_json").notNull(),
  executionCount: integer("execution_count").notNull().default(0),
  diff: text("diff"),
}, (table) => [primaryKey({ columns: [table.agentId, table.path] })]);

export const managedArtifactProjection = sqliteTable("managed_artifact_projection", {
  projectId: text("project_id").notNull(),
  artifactId: text("artifact_id").notNull(),
  createdAt: text("created_at").notNull(),
  visibility: text("visibility").notNull(),
  pinned: integer("pinned").notNull(),
  artifactJson: text("artifact_json").notNull(),
  ownerKind: text("owner_kind").notNull(),
  ownerId: text("owner_id").notNull(),
  audienceJson: text("audience_json").notNull(),
  senderAgentId: text("sender_agent_id"),
}, (table) => [primaryKey({ columns: [table.projectId, table.artifactId] })]);

export const runs = sqliteTable("runs", {
  id: text("id").notNull(),
  agentId: text("agent_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  reason: text("reason").notNull(),
  engine: text("engine").notNull(),
  model: text("model"),
  effort: text("effort"),
  communicationEventId: text("communication_event_id"),
  wakeCause: text("wake_cause"),
  inputTokens: integer("input_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  cacheWriteInputTokens: integer("cache_write_input_tokens"),
  outputTokens: integer("output_tokens"),
  reasoningOutputTokens: integer("reasoning_output_tokens"),
  totalTokens: integer("total_tokens"),
  providerRequestUsageJson: text("provider_request_usage_json"),
  startedAt: text("started_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [primaryKey({ columns: [table.agentId, table.id] })]);

export const workItems = sqliteTable("work_items", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  executionId: text("execution_id"),
  title: text("title").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  executionId: text("execution_id"),
  kind: text("kind").notNull(), // ArtifactKind
  path: text("path").notNull(),
  summary: text("summary"),
  createdAt: text("created_at").notNull(),
  sourcePath: text("source_path"),
  mediaType: text("media_type"),
  visibility: text("visibility"),
  pinned: integer("pinned"),
  size: integer("size"),
});

/** Searchable index over the log (SPEC §7). One row per stored event. */
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Rebuildable bounded-read projection of contiguous provider output. */
export const runOutputSegments = sqliteTable("run_output_segments", {
  agentId: text("agent_id").notNull(),
  firstSeq: integer("first_seq").notNull(),
  lastSeq: integer("last_seq").notNull(),
  eventType: text("event_type").notNull(),
  executionId: text("execution_id").notNull(),
  createdAt: text("created_at").notNull(),
  textPreview: text("text_preview").notNull().default(""),
  previewUtf8Bytes: integer("preview_utf8_bytes").notNull().default(0),
  rawUtf8Bytes: integer("raw_utf8_bytes").notNull().default(0),
  canonicalUtf8Bytes: integer("canonical_utf8_bytes").notNull().default(0),
}, (table) => [primaryKey({ columns: [table.agentId, table.firstSeq] })]);

/** Last event that can join or break a provider-output segment. */
export const runOutputHeads = sqliteTable("run_output_heads", {
  agentId: text("agent_id").primaryKey(),
  lastSeq: integer("last_seq").notNull(),
  eventType: text("event_type").notNull(),
  executionId: text("execution_id"),
  segmentFirstSeq: integer("segment_first_seq"),
});

export type ProjectRow = typeof projects.$inferSelect;
export type AgentPresetRow = typeof agentPresets.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type AgentDeletionTombstoneRow = typeof agentDeletionTombstones.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type AgentConversationMembershipRow = typeof agentConversationMemberships.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type WorkItemRow = typeof workItems.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type EventRow = typeof events.$inferSelect;
