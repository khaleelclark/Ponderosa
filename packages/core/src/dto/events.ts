import type { EngineId } from "../adapter.js";
import type { AgentEvent } from "../events.js";
import type { AgentDto, AgentState } from "./agents.js";
import type { ArtifactDto, ChangedFileDto } from "./artifacts.js";
import type { HistoryPageDto, HistoryWindowDto } from "./common.js";
import type { ConversationDto, MessageDto, ResponseFileActivityDto } from "./conversations.js";
import type { AgentCoordinationV3Dto, AgentRunDto, WorkItemDto } from "./runs.js";
import type {
  WorkspacePreferencesDto,
  WorkspaceResourceKind,
} from "./workspace.js";

export type WorkspaceEvent =
  | { type: "preferences_updated"; preferences: WorkspacePreferencesDto }
  | { type: "resource_used"; kind: WorkspaceResourceKind; resourceId: string }
  | { type: "project_changed"; projectId: string; action: "created" | "updated" | "deleted" | "used" }
  | { type: "conversation_changed"; projectId: string; conversationId: string; action: "created" | "updated" | "deleted" | "used" | "message" }
  | { type: "draft_changed"; conversationId: string; revision: number; cleared: boolean }
  | { type: "draft_conflict"; conversationId: string; revision: number }
  | { type: "notification_changed"; notificationId?: string; /** Present only for Decision mutations. */ decisionId?: string; conversationId?: string; action: "created" | "updated" | "read" | "acknowledged" | "resolved" | "cleared" }
  | { type: "queued_message_changed"; conversationId: string; deliveryId: string; action: "queued" | "edited" | "steered" | "cancelled" | "preparing" | "retrying" | "started" }
  | { type: "message_delivery_changed"; /** Absent on legacy persisted events. */ projectId?: string; agentId: string; conversationIds?: string[] }
  | {
      type: "coordination_changed";
      projectId: string;
      agentId: string;
      /** Exact affected Chats when known; absent on legacy persisted events. */
      conversationIds?: string[];
    }
  | { type: "trigger_changed"; projectId: string; agentId: string; triggerId: string; action: "created" | "updated" | "deleted" | "occurrence" }
  | { type: "usage_changed"; projectId: string; agentId: string; conversationIds: string[]; seq: number; executionId?: string }
  | { type: "agent_event"; projectId: string; agentId: string; conversationIds: string[]; seq: number; eventType: string; category: "lifecycle" | "message" | "task" | "artifact" | "file" | "state" | "usage"; executionId?: string }
  | { type: "runtime_capabilities_changed"; projectId: string; engineId: EngineId }
  | { type: "push_subscription_changed"; deviceId: string; action: "upserted" | "deleted" }
  | { type: "push_delivery_changed"; notificationId: string; deviceId: string; action: "delivered" | "retry_scheduled" | "abandoned" };

export interface WorkspaceEventEnvelope {
  id: number;
  ts: string;
  event: WorkspaceEvent;
  replayed?: boolean;
}

/** Stream identity and high-water mark, sent before replay on every connection. */
export interface WorkspaceStreamStatusDto {
  instanceId: string;
  cursor: number;
  reset: boolean;
}

export interface ContextRolloverTriggeredEvent {
  type: "context_rollover_triggered";
  executionId: string;
  usedTokens: number;
  threshold: number;
}

export type AgentActivityEvent = Extract<AgentEvent, {
  type: "command" | "file_change" | "test_result" | "tool_call" | "tool_result" | "error" |
    "browser_session" | "browser_action" | "browser_console" | "browser_screenshot" |
    "context_rollover_seed_overflow" | "context_rollover_completed";
}> | ContextRolloverTriggeredEvent;

/** Canonical, refresh-safe execution activity projected from the agent event log. */
export interface AgentActivityDto {
  id: string;
  agentId: string;
  executionId?: string;
  seq: number;
  createdAt: string;
  event: AgentActivityEvent;
  /** Structured proof that a tool result is a bounded preview, with an exact
   * authorized retrieval route for the immutable canonical event. */
  outputPreview?: {
    truncated: true;
    previewUtf8Bytes: number;
    totalUtf8Bytes: number;
    sha256: string;
    retrievalUrl: string;
  };
}

export interface AgentActivityOutputDto {
  agentId: string;
  activityId: string;
  seq: number;
  /** One UTF-8-aligned immutable page, never the unbounded canonical payload. */
  output: string;
  pageUtf8Bytes: number;
  startUtf8Byte: number;
  endUtf8Byte: number;
  totalUtf8Bytes: number;
  sha256: string;
  nextCursor?: string;
}

export type AgentTelemetryStream = "runOutput" | "activity" | "changedFiles" | "runs" | "workItems" | "artifacts";

export type AgentTelemetryPageDto =
  | ({ stream: "runOutput" } & HistoryPageDto<RunOutputDto>)
  | ({ stream: "activity" } & HistoryPageDto<AgentActivityDto>)
  | ({ stream: "changedFiles" } & HistoryPageDto<ChangedFileDto>)
  | ({ stream: "runs" } & HistoryPageDto<AgentRunDto>)
  | ({ stream: "workItems" } & HistoryPageDto<WorkItemDto>)
  | ({ stream: "artifacts" } & HistoryPageDto<ArtifactDto>);

export interface AgentOutputEvent {
  type: "agent_output";
  executionId: string;
  text: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
}

export type AgentExecutionDeltaEvent =
  | (Extract<AgentEvent, { type: "text" }> & { executionId?: string })
  | (Extract<AgentEvent, { type: "reasoning" }> & { executionId?: string });

export interface RunOutputDto {
  id: string;
  agentId: string;
  executionId: string;
  kind: "response" | "reasoning";
  text: string;
  completed: boolean;
  seq: number;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: string;
  /** Present only when `text` is a bounded preview of a larger canonical segment. */
  textPreview?: {
    truncated: true;
    previewUtf8Bytes: number;
    totalUtf8Bytes: number;
    retrievalUrl: string;
  };
  /** Canonical file changes attributed to this exact Run, never a working-tree snapshot. */
  fileActivity?: ResponseFileActivityDto[];
}

export interface RunOutputTextDto {
  agentId: string;
  runOutputId: string;
  seq: number;
  text: string;
  totalUtf8Bytes: number;
}

/**
 * GET /api/agents/:id — the full agent view. Chat contains only explicit
 * communications; Work log contains execution-scoped ordinary output.
 */
export interface AgentDetailDto {
  agent: AgentDto;
  /** Canonical owning Chat, absent only after that Chat no longer exists. */
  ownerConversation?: Pick<ConversationDto, "id" | "title">;
  /** Stable current-or-historical evidence that this Agent managed another Agent. */
  hasSubagentHistory?: boolean;
  messages: MessageDto[];
  runOutput: RunOutputDto[];
  activity: AgentActivityDto[];
  changedFiles: ChangedFileDto[];
  runs: AgentRunDto[];
  /** Sum of authoritative finalized Run intervals. Active Runs and idle wall time are excluded. */
  finalizedWorkDurationMs?: number;
  coordinationV3?: AgentCoordinationV3Dto;
  workItems: WorkItemDto[];
  artifacts: ArtifactDto[];
  state: AgentState;
  /** Every execution stream advances independently; loading old activity must
   * not rehydrate or widen unrelated Runs, files, or results. */
  telemetryHistory?: Partial<Record<AgentTelemetryStream, HistoryWindowDto>>;
  history?: HistoryWindowDto;
}
