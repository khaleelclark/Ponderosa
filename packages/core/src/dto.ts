// REST DTOs for the API surface (SPEC §8). These cross the UI↔server boundary and
// MUST stay JSON-serializable and free of Node-only types — apps/web imports them
// directly so the SSE/REST contract is typechecked end to end (SPEC §6, §1).

import type {
  EngineId,
  EffortOption,
  EngineModelOption,
  EngineModelValidationError,
  ModelOption,
} from "./adapter.js";
import type { AgentEvent, BrowserControlOwner, BrowserSessionStatus, TokenUsage, WorkItemStatus } from "./events.js";
import type { CommunicationDocumentReference, VerifiedCitationRecord } from "./communication.js";
import type {
  AgentLifecycleReason,
  AgentLifecycleStatus,
  AgentRunStatus,
  HistoryPageDto,
  HistoryWindowDto,
} from "./dto/common.js";
import type {
  ArtifactDto,
  ArtifactKind,
  ChangedFileDto,
  ImageAttachmentDto,
} from "./dto/artifacts.js";
import type {
  ProviderInputSourceManifest,
} from "./dto/provider-engine.js";
import type {
  AgentPresetDto,
  ProjectDto,
  ProjectSort,
} from "./dto/projects.js";
import type {
  CreateTriggerRequest,
} from "./dto/triggers.js";
import type {
  AgentDto,
  AgentState,
} from "./dto/agents.js";
import type {
  DecisionDto,
  WorkspacePreferencesDto,
} from "./dto/workspace.js";
import type {
  MessageDto,
  ResponseFileActivityDto,
} from "./dto/conversations.js";

export type WorkspaceEvent =
  | { type: "preferences_updated"; preferences: WorkspacePreferencesDto }
  | { type: "project_changed"; projectId: string; action: "created" | "updated" | "deleted" | "used" }
  | { type: "conversation_changed"; projectId: string; conversationId: string; action: "created" | "updated" | "deleted" | "used" | "message" }
  | { type: "draft_changed"; conversationId: string; revision: number; cleared: boolean }
  | { type: "draft_conflict"; conversationId: string; revision: number }
  | { type: "notification_changed"; notificationId?: string; conversationId?: string; action: "created" | "updated" | "read" | "cleared" }
  | { type: "queued_message_changed"; conversationId: string; deliveryId: string; action: "queued" | "edited" | "steered" | "cancelled" | "started" }
  | { type: "message_delivery_changed"; /** Absent on legacy persisted events. */ projectId?: string; agentId: string; conversationIds?: string[] }
  | { type: "coordination_changed"; projectId: string; agentId: string }
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

export interface CancelAgentRunRequest {
  /** Exact Run observed by the caller. A successor Run is never cancelled. */
  targetRunId: string;
  /** Stable across retries so a repeated stop cannot append another lifecycle event. */
  idempotencyKey: string;
}

export interface CancelAgentRunResponse {
  cancelled: boolean;
  replayed: boolean;
}

/** Structural reason one Run was activated; never inferred from message text. */
export type AgentRunWakeCause =
  | "project_request"
  | "direct_message"
  | "collaboration"
  | "trigger"
  | "decision"
  | "managed_failure";

/** One canonical execution of an Agent. */
export interface AgentRunDto {
  id: string;
  agentId: string;
  title: string;
  status: AgentRunStatus;
  reason: AgentLifecycleReason;
  engine: EngineId;
  model?: string;
  effort?: string;
  communicationEventId?: string;
  wakeCause?: AgentRunWakeCause;
  /** Provider-reported usage. Missing means the run was not metered, never zero. */
  usage?: TokenUsage;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Hash and sources of the exact text Ponderosa submitted to the provider. */
  providerInput?: {
    promptHash: string;
    sourceManifest: ProviderInputSourceManifest;
    exactPromptAvailable: true;
  };
}

/** Optional engine-reported progress inside a Run; never a Run itself. */
export interface WorkItemDto {
  id: string;
  agentId: string;
  executionId?: string;
  title: string;
  status: WorkItemStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ContextRolloverTriggeredEvent {
  type: "context_rollover_triggered";
  executionId: string;
  usedTokens: number;
  threshold: number;
}

export type AgentActivityEvent = Extract<AgentEvent, {
  type: "command" | "file_change" | "test_result" | "tool_call" | "tool_result" | "error" |
    "browser_session" | "browser_action" | "browser_console" | "browser_screenshot";
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
  /** Canonical file changes attributed to this exact Run, never a working-tree snapshot. */
  fileActivity?: ResponseFileActivityDto[];
}

export interface AgentCoordinationV3Dto {
  availability: "running" | "runnable" | "waiting" | "idle";
  requests: Array<{
    id: string;
    direction: "outbound" | "inbound";
    counterpartyAgentId?: string;
    state: string;
    version: number;
    deadlineAt?: string;
    updatedAt: string;
  }>;
  joins: Array<{
    id: string;
    mode: "all" | "any" | "quorum";
    wakePolicy: "each_result" | "final_only";
    quorum: number;
    state: "open" | "satisfied" | "impossible" | "expired" | "cancelled";
    completed: number;
    total: number;
    deadlineAt?: string;
    updatedAt: string;
  }>;
  activations: Array<{
    id: string;
    kind: string;
    priority: number;
    state: string;
    createdAt: string;
  }>;
  activeRun?: {
    id: string;
    status: string;
    fencingToken: number;
    promptInjectionState: "not_injected" | "injecting" | "injected";
    providerContextDisposition: "fresh_task" | "continued_session" | "reseeded";
    leaseExpiresAt: string;
  };
}

/**
 * GET /api/agents/:id — the full agent view. Chat contains only explicit
 * communications; Work log contains execution-scoped ordinary output.
 */
export interface AgentDetailDto {
  agent: AgentDto;
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

export * from "./dto/common.js";

export * from "./dto/artifacts.js";

export * from "./dto/provider-engine.js";

export * from "./dto/projects.js";

export * from "./dto/triggers.js";

export * from "./dto/agents.js";

export * from "./dto/workspace.js";

export * from "./dto/conversations.js";
