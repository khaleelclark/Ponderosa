// SQLite projection schema (SPEC §7) via Drizzle. These six tables are a
// rebuildable index over the on-disk event logs — NEVER a source of truth
// (AGENTS.md invariant: everything derives from the log). If a projection is
// wrong, fix the projector, don't write here as a second source.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  hostPath: text("host_path").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
});

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  masterChatId: text("master_chat_id"),
  title: text("title").notNull(),
  activeEngine: text("active_engine").notNull(),
  activeSessionId: text("active_session_id"),
  stateBranch: text("state_branch"),
  stateCommit: text("state_commit"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // SQLite has no boolean: 0/1.
  archived: integer("archived").notNull().default(0),
});

export const masterChats = sqliteTable("master_chats", {
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

export const masterChatMessages = sqliteTable("master_chat_messages", {
  id: text("id").primaryKey(),
  masterChatId: text("master_chat_id").notNull(),
  role: text("role").notNull(), // "user" | "assistant" | "system"
  text: text("text").notNull(),
  createdAt: text("created_at").notNull(),
  // Set when an agent (thread) posts back into the group chat; null for the manager.
  authorThreadId: text("author_thread_id"),
  // Main chat is manager-facing. Collaboration is opt-in and only sent to tagged agents.
  channel: text("channel").notNull().default("main"),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  seq: integer("seq").notNull(),
  role: text("role").notNull(), // "user" | "assistant"
  text: text("text").notNull(),
  createdAt: text("created_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(), // TaskStatus
  engine: text("engine").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  taskId: text("task_id"),
  kind: text("kind").notNull(), // ArtifactKind
  path: text("path").notNull(),
  summary: text("summary"),
  createdAt: text("created_at").notNull(),
});

/** Searchable index over the log (SPEC §7). One row per stored event. */
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export type ProjectRow = typeof projects.$inferSelect;
export type ThreadRow = typeof threads.$inferSelect;
export type MasterChatRow = typeof masterChats.$inferSelect;
export type MasterChatMessageRow = typeof masterChatMessages.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type EventRow = typeof events.$inferSelect;
