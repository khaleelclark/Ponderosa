// SQLite schema (SPEC §7) via Drizzle. Authored-state tables are rebuildable
// indexes over event logs. Communication V3 tables are authoritative runtime
// state; their transaction boundaries define scheduler correctness.

import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  hostPath: text("host_path").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
  defaultEngine: text("default_engine").notNull(),
  lastConversationId: text("last_conversation_id"),
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

/**
 * Rebuildable, human-facing global Chat search projection. This deliberately
 * excludes runtime events and collaboration-only surfaces. Search reads this
 * table newest-first through a bounded index instead of materializing every
 * conversation and agent timeline from the canonical JSONL files.
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
  text: text("text").notNull(),
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

/** Authoritative Communication V3 state. Unlike the tables above, these rows
 * are not projections of JSONL; scheduler correctness depends on their SQLite
 * transaction boundaries. */
export const coordinationRequests = sqliteTable("coordination_requests", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  conversationId: text("conversation_id"),
  requesterAgentId: text("requester_agent_id"),
  recipientAgentId: text("recipient_agent_id").notNull(),
  communicationEventId: text("communication_event_id"),
  payloadJson: text("payload_json").notNull(),
  replyAuthorityJson: text("reply_authority_json"),
  state: text("state").notNull(),
  version: integer("version").notNull().default(0),
  lifetimeKind: text("lifetime_kind").notNull(),
  deadlineAt: text("deadline_at"),
  openQuestionUpdateId: text("open_question_update_id"),
  supersededByRequestId: text("superseded_by_request_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  terminalAt: text("terminal_at"),
});

export const coordinationRequestUpdates = sqliteTable("coordination_request_updates", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  kind: text("kind").notNull(),
  actorKind: text("actor_kind").notNull(),
  actorId: text("actor_id"),
  inReplyToUpdateId: text("in_reply_to_update_id"),
  payloadJson: text("payload_json").notNull(),
  payloadHash: text("payload_hash").notNull(),
  resultingState: text("resulting_state").notNull(),
  resultingVersion: integer("resulting_version").notNull(),
  createdAt: text("created_at").notNull(),
});

export const coordinationJoins = sqliteTable("coordination_joins", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  conversationId: text("conversation_id"),
  ownerAgentId: text("owner_agent_id").notNull(),
  mode: text("mode").notNull(),
  wakePolicy: text("wake_policy").notNull().default("final_only"),
  quorum: integer("quorum").notNull(),
  satisfyingOutcomesJson: text("satisfying_outcomes_json").notNull(),
  state: text("state").notNull(),
  deadlineAt: text("deadline_at"),
  continuationRequestIdsJson: text("continuation_request_ids_json").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  terminalAt: text("terminal_at"),
});

export const coordinationJoinMembers = sqliteTable("coordination_join_members", {
  joinId: text("join_id").notNull(),
  requestId: text("request_id").notNull(),
  position: integer("position").notNull(),
}, (table) => [primaryKey({ columns: [table.joinId, table.requestId] })]);

export const agentActivations = sqliteTable("agent_activations", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  agentId: text("agent_id").notNull(),
  scopeKey: text("scope_key").notNull().default(""),
  kind: text("kind").notNull(),
  priority: integer("priority").notNull(),
  dispatchPolicy: text("dispatch_policy").notNull(),
  promptClass: text("prompt_class").notNull(),
  state: text("state").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  payloadJson: text("payload_json").notNull(),
  availableAt: text("available_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  consumedAt: text("consumed_at"),
  deliveryFailures: integer("delivery_failures").notNull().default(0),
  lastDeliveryError: text("last_delivery_error"),
  terminalOutcome: text("terminal_outcome"),
  terminalAt: text("terminal_at"),
});

export const activationSources = sqliteTable("activation_sources", {
  activationId: text("activation_id").notNull(),
  sourceKind: text("source_kind").notNull(),
  sourceId: text("source_id").notNull(),
}, (table) => [primaryKey({ columns: [table.activationId, table.sourceKind, table.sourceId] })]);

export const schedulerAgentFences = sqliteTable("scheduler_agent_fences", {
  agentId: text("agent_id").primaryKey(),
  nextFencingToken: integer("next_fencing_token").notNull(),
});

export const schedulerRuns = sqliteTable("scheduler_runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  agentId: text("agent_id").notNull(),
  scopeKey: text("scope_key").notNull().default(""),
  contextDisposition: text("context_disposition").notNull().default("fresh_task"),
  status: text("status").notNull(),
  leaseOwner: text("lease_owner").notNull(),
  leaseExpiresAt: text("lease_expires_at").notNull(),
  fencingToken: integer("fencing_token").notNull(),
  promptInjectionState: text("prompt_injection_state").notNull(),
  providerSessionId: text("provider_session_id"),
  heartbeatAt: text("heartbeat_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  startedAt: text("started_at"),
  terminalAt: text("terminal_at"),
});

export const schedulerRunActivations = sqliteTable("scheduler_run_activations", {
  runId: text("run_id").notNull(),
  activationId: text("activation_id").notNull(),
  attachedAt: text("attached_at").notNull(),
  consumedAt: text("consumed_at"),
}, (table) => [primaryKey({ columns: [table.runId, table.activationId] })]);

export const runtimeCommunications = sqliteTable("runtime_communications", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  senderJson: text("sender_json").notNull(),
  intent: text("intent").notNull(),
  audienceJson: text("audience_json").notNull(),
  payloadJson: text("payload_json").notNull(),
  payloadHash: text("payload_hash").notNull(),
  actionable: integer("actionable").notNull(),
  createdAt: text("created_at").notNull(),
});

export const schedulerPromptInjections = sqliteTable("scheduler_prompt_injections", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  kind: text("kind").notNull(),
  sequence: integer("sequence").notNull(),
  state: text("state").notNull(),
  promptHash: text("prompt_hash").notNull(),
  activationIdsJson: text("activation_ids_json").notNull(),
  providerTurnId: text("provider_turn_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  submittedAt: text("submitted_at"),
  acknowledgedAt: text("acknowledged_at"),
  terminalAt: text("terminal_at"),
});

export const schedulerCancellationReceipts = sqliteTable("scheduler_cancellation_receipts", {
  agentId: text("agent_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  runId: text("run_id"),
  accepted: integer("accepted").notNull(),
  fencingToken: integer("fencing_token"),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.agentId, table.idempotencyKey] })]);

export const providerOperationOutbox = sqliteTable("provider_operation_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  operation: text("operation").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadJson: text("payload_json").notNull(),
  state: text("state").notNull(),
  attempts: integer("attempts").notNull().default(0),
  availableAt: text("available_at").notNull(),
  claimedBy: text("claimed_by"),
  claimedAt: text("claimed_at"),
  completedAt: text("completed_at"),
  deadLetteredAt: text("dead_lettered_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const coordinationIdempotency = sqliteTable("coordination_idempotency", {
  projectId: text("project_id").notNull(),
  actorScope: text("actor_scope").notNull(),
  operation: text("operation").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  resultJson: text("result_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.projectId, table.actorScope, table.operation, table.idempotencyKey] })]);

export const activationOutbox = sqliteTable("activation_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  activationId: text("activation_id").notNull(),
  eventKind: text("event_kind").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
  claimedBy: text("claimed_by"),
  claimedAt: text("claimed_at"),
  processedAt: text("processed_at"),
  deadLetteredAt: text("dead_lettered_at"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
});

export const triggerOccurrences = sqliteTable("trigger_occurrences", {
  id: text("id").primaryKey(),
  triggerId: text("trigger_id").notNull(),
  occurrenceKey: text("occurrence_key").notNull(),
  projectId: text("project_id").notNull(),
  agentId: text("agent_id").notNull(),
  scopeKey: text("scope_key").notNull(),
  payloadJson: text("payload_json").notNull(),
  provenanceJson: text("provenance_json").notNull(),
  triggerSnapshotJson: text("trigger_snapshot_json").notNull().default("{}"),
  payloadMediaType: text("payload_media_type").notNull().default("application/json"),
  inputHash: text("input_hash").notNull(),
  activationConfigJson: text("activation_config_json").notNull(),
  state: text("state").notNull(),
  attempts: integer("attempts").notNull().default(0),
  availableAt: text("available_at").notNull(),
  activationId: text("activation_id"),
  lastError: text("last_error"),
  occurredAt: text("occurred_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  cancelledAt: text("cancelled_at"),
  deadLetteredAt: text("dead_lettered_at"),
});

export const triggerDefinitions = sqliteTable("trigger_definitions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  agentId: text("agent_id").notNull(),
  name: text("name").notNull(),
  instructions: text("instructions").notNull(),
  sourceKind: text("source_kind").notNull(),
  sourceConfigJson: text("source_config_json").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  runBudgetLimit: integer("run_budget_limit"),
  runBudgetPeriod: text("run_budget_period"),
  runBudgetUsed: integer("run_budget_used").notNull().default(0),
  runBudgetAllowance: integer("run_budget_allowance").notNull().default(0),
  runBudgetPeriodStartedAt: text("run_budget_period_started_at"),
  nextFireAt: text("next_fire_at"),
  lastFiredAt: text("last_fired_at"),
  secretCiphertext: text("secret_ciphertext"),
  secretFingerprint: text("secret_fingerprint"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
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
export type CoordinationRequestRow = typeof coordinationRequests.$inferSelect;
export type CoordinationJoinRow = typeof coordinationJoins.$inferSelect;
export type AgentActivationRow = typeof agentActivations.$inferSelect;
export type SchedulerRunRow = typeof schedulerRuns.$inferSelect;
export type TriggerDefinitionRow = typeof triggerDefinitions.$inferSelect;
export type TriggerOccurrenceRow = typeof triggerOccurrences.$inferSelect;
export type RuntimeCommunicationRow = typeof runtimeCommunications.$inferSelect;
export type SchedulerPromptInjectionRow = typeof schedulerPromptInjections.$inferSelect;
export type SchedulerCancellationReceiptRow = typeof schedulerCancellationReceipts.$inferSelect;
export type ProviderOperationOutboxRow = typeof providerOperationOutbox.$inferSelect;
