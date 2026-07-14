// SQLite projection schema (SPEC §7) via Drizzle. These six tables are a
// rebuildable index over the on-disk event logs — NEVER a source of truth
// (AGENTS.md invariant: everything derives from the log). If a projection is
// wrong, fix the projector, don't write here as a second source.

import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  hostPath: text("host_path").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
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
  activeEngine: text("active_engine").notNull(),
  model: text("model"),
  effort: text("effort"),
  activeSessionId: text("active_session_id"),
  stateBranch: text("state_branch"),
  stateCommit: text("state_commit"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // SQLite has no boolean: 0/1.
  archived: integer("archived").notNull().default(0),
  managerAgentId: text("manager_agent_id"),
  spawnedByAgentId: text("spawned_by_agent_id"),
  spawnedByExecutionId: text("spawned_by_execution_id"),
  spawnPrompt: text("spawn_prompt"),
  spawnIdempotencyKey: text("spawn_idempotency_key"),
  presetSnapshotJson: text("preset_snapshot_json"),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  defaultEngine: text("default_engine"),
  defaultModel: text("default_model"),
  defaultEffort: text("default_effort"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  archived: integer("archived").notNull().default(0),
});

/** Rebuildable projection of the canonical membership list in agent.json. */
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
  replyToJson: text("reply_to_json"),
  attachmentsJson: text("attachments_json"),
});

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
  inputTokens: integer("input_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  cacheWriteInputTokens: integer("cache_write_input_tokens"),
  outputTokens: integer("output_tokens"),
  reasoningOutputTokens: integer("reasoning_output_tokens"),
  totalTokens: integer("total_tokens"),
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

export type ProjectRow = typeof projects.$inferSelect;
export type AgentPresetRow = typeof agentPresets.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type AgentConversationMembershipRow = typeof agentConversationMemberships.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type WorkItemRow = typeof workItems.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type EventRow = typeof events.$inferSelect;
