// REST DTOs for the API surface (SPEC §8). These cross the UI↔server boundary and
// MUST stay JSON-serializable and free of Node-only types — apps/web imports them
// directly so the SSE/REST contract is typechecked end to end (SPEC §6, §1).

import type { EngineId, EffortOption, ModelOption } from "./adapter.js";
import type { AgentEvent, TaskStatus } from "./events.js";
import type { CommunicationIntent } from "./communication.js";

// ─── Projects ────────────────────────────────────────────────────────────────

/** A codebase/repo on the host; a UI tab (SPEC §2). Mirrors the `projects` table. */
export interface ProjectDto {
  id: string;
  label: string;
  /** Absolute host path = the cwd root for agents working in this project. */
  hostPath: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface AgentPresetDto {
  id: string;
  projectId: string;
  name: string;
  description: string;
  guidance: string;
  engine: EngineId;
  model?: string;
  effort?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CreateAgentPresetRequest = Pick<AgentPresetDto, "name" | "description" | "guidance" | "engine"> &
  Partial<Pick<AgentPresetDto, "model" | "effort" | "enabled">>;
export type UpdateAgentPresetRequest = Partial<Omit<CreateAgentPresetRequest, "engine">> & { engine?: EngineId };

/** POST /api/projects body. */
export interface CreateProjectRequest {
  label: string;
  hostPath: string;
}

// ─── Master chats ────────────────────────────────────────────────────────────

/** A model-agnostic project control room that can spawn many agent threads. */
export interface MasterChatDto {
  id: string;
  projectId: string;
  title: string;
  defaultEngine?: EngineId;
  defaultModel?: string;
  defaultEffort?: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

/** POST /api/projects/:id/master-chats body. */
export interface CreateMasterChatRequest {
  title: string;
  defaultEngine?: EngineId;
  defaultModel?: string;
  defaultEffort?: string;
}

/** PATCH /api/master-chats/:id body. */
export interface UpdateMasterChatRequest {
  title?: string;
  defaultEngine?: EngineId | null;
  defaultModel?: string | null;
  defaultEffort?: string | null;
  archived?: boolean;
}

/** A message in the project-level master chat (a team group chat). */
export interface MasterChatMessageDto {
  id: string;
  masterChatId: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  /**
   * The agent (thread) that authored this message, when it came from an agent
   * reporting back into the group chat (finished/stuck). Absent for the manager's
   * own messages.
   */
  authorThreadId?: string;
  /** Immutable quoted context captured when this reply was sent. */
  replyTo?: MessageReferenceDto;
  attachments?: ImageAttachmentDto[];
  reactions?: MessageReactionDto[];
}

export type ReactionEmoji = "👍" | "👎" | "❤️" | "🎉" | "👀" | "🚀";
export type ReactionActor = { kind: "manager" } | { kind: "agent"; threadId: string };

export interface MessageReactionDto {
  emoji: ReactionEmoji;
  count: number;
  reactedByCurrentActor: boolean;
}

export interface SetMessageReactionRequest {
  emoji: ReactionEmoji;
  active: boolean;
  idempotencyKey: string;
}

export interface SetMessageReactionResponse {
  occurrenceId: string;
  replayed: boolean;
  persistence: "recorded";
  notification: "queued" | "delivered" | "suppressed" | "not_applicable";
  reactions: MessageReactionDto[];
}

export interface MessageReferenceDto {
  messageId: string;
  text: string;
  role: "user" | "assistant" | "system";
  authorThreadId?: string;
}

/** The two deliberately separate conversations owned by a master chat. */
export type MasterChatChannel = "main" | "collaboration";

/** A message in the private, opt-in agent collaboration chat. */
export interface CollaborationChatDetailDto {
  messages: MasterChatMessageDto[];
  threads: ThreadDto[];
}

/** GET /api/master-chats/:id response. */
export interface MasterChatDetailDto {
  masterChat: MasterChatDto;
  messages: MasterChatMessageDto[];
  threads: ThreadDto[];
}

/** POST /api/master-chats/:id/messages body. */
export interface CreateMasterChatMessageRequest {
  role?: "user" | "assistant" | "system";
  text: string;
  replyToMessageId?: string;
  attachments?: ImageAttachmentDto[];
}

/** POST collaboration message response; recipients are the immutable resolved audience. */
export interface CreateCollaborationMessageResponse {
  message: MasterChatMessageDto;
  audience: "mention" | "everyone" | "none";
  notifiedAgentIds: string[];
}

/** POST /api/master-chats/:id/direct-replies body. */
export interface CreateDirectReplyRequest {
  text: string;
  replyToMessageId: string;
  targetAuthorThreadId: string;
  attachmentIds?: string[];
  /** Stable across retries; the server applies both durable effects once. */
  idempotencyKey: string;
}

export interface DirectReplyResponse {
  messageId: string;
  targetAuthorThreadId: string;
  replayed: boolean;
  queued: boolean;
}

// ─── Threads ─────────────────────────────────────────────────────────────────

/** Derived thread state (current branch/commit), from `state` events (SPEC §2). */
export interface ThreadState {
  branch?: string;
  commit?: string;
}

/** A feature-scoped unit of work (SPEC §2). Mirrors the `threads` projection. */
export interface ThreadDto {
  id: string;
  projectId: string;
  /** Optional control-room/master chat that spawned or groups this agent. */
  masterChatId?: string;
  /** All control rooms this agent belongs to. `masterChatId` is the primary/home member. */
  masterChatIds: string[];
  title: string;
  /** The engine currently bound to this thread. */
  activeEngine: EngineId;
  state: ThreadState;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** Immutable-at-spawn preset provenance and guidance snapshot. */
  presetSnapshot?: Pick<AgentPresetDto, "id" | "name" | "description" | "guidance" | "engine" | "model" | "effort">;
}

/** POST /api/projects/:id/threads body. */
export interface CreateThreadRequest {
  title: string;
  engine: EngineId;
  masterChatId?: string;
  model?: string;
  effort?: string;
  /** Optional first turn, dispatched atomically with thread creation. */
  initialMessage?: string;
  /** Master-chat message referenced by the optional first turn. */
  replyToMessageId?: string;
  presetId?: string;
}

/** PATCH /api/threads/:id body (rename / archive). */
export interface UpdateThreadRequest {
  title?: string;
  archived?: boolean;
}

/** PUT /api/threads/:id/master-chat-memberships body. Replaces membership atomically. */
export interface UpdateThreadMasterChatMembershipsRequest {
  masterChatIds: string[];
  /** Must be one of `masterChatIds`; omit only when the resulting set is empty. */
  primaryMasterChatId?: string;
}

// ─── Messages / Tasks / Artifacts ────────────────────────────────────────────

/** A Chat-pane message (SPEC §7 `messages`). Intent/conversation only. */
export interface MessageDto {
  id: string;
  threadId: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  replyTo?: MessageReferenceDto;
  attachments?: ImageAttachmentDto[];
}

export type AssetMediaType =
  | "image/png" | "image/jpeg" | "image/webp"
  | "application/pdf" | "text/plain" | "application/json" | "application/zip";

/** A content-validated, thread-owned asset staged for or associated with a message. */
export interface AssetDto {
  id: string;
  threadId: string;
  name: string;
  mediaType: AssetMediaType;
  size: number;
  width?: number;
  height?: number;
  sha256?: string;
  state?: "staged" | "associated";
  createdAt?: string;
  /** Opaque preview-or-download URL; never a host filesystem path. */
  url: string;
  downloadUrl?: string;
  previewUrl?: string;
}

/** Backward-compatible name retained while clients migrate to AssetDto. */
export type ImageAttachmentDto = AssetDto;

export interface AssetLimitsDto {
  maxFileBytes: number;
  maxRequestBytes: number;
  maxAssetsPerMessage: number;
  maxMessageBytes: number;
  maxThreadBytes: number;
  acceptedMediaTypes: AssetMediaType[];
}

export interface ImageAttachmentLimitsDto {
  maxFileBytes: number;
  maxRequestBytes: number;
  maxAttachmentsPerMessage: number;
  acceptedMediaTypes: AssetMediaType[];
}

/** A Tasks-pane execution unit (SPEC §7 `tasks`). */
export interface TaskDto {
  id: string;
  threadId: string;
  title: string;
  status: TaskStatus;
  engine: EngineId;
  createdAt: string;
  updatedAt: string;
}

/** Kind of artifact (SPEC §2/§12): the "what changed". */
export type ArtifactKind = "diff" | "test_report" | "pr_summary" | "log";

/** An Artifacts-pane entry (SPEC §7 `artifacts`). Metadata only; content via :aid. */
export interface ArtifactDto {
  id: string;
  threadId: string;
  taskId?: string;
  kind: ArtifactKind;
  /** Relative path under the thread's `artifacts/` dir. */
  path: string;
  summary?: string;
  createdAt: string;
}

/** GET /api/threads/:id/artifacts/:aid — the artifact plus its rendered content. */
export interface ArtifactContentDto extends ArtifactDto {
  /** Raw text content (diff text, report body, log text). */
  content: string;
  /** Hint for the read-only viewer (markdown vs plain vs unified diff). */
  contentType: "markdown" | "diff" | "text";
}

/**
 * GET /api/threads/:id — the full thread view: thread + messages + tasks +
 * artifacts + state (SPEC §8). The UI hydrates all four panes from this.
 */
export interface ThreadDetailDto {
  thread: ThreadDto;
  messages: MessageDto[];
  tasks: TaskDto[];
  artifacts: ArtifactDto[];
  state: ThreadState;
}

// ─── Messaging / runs ────────────────────────────────────────────────────────

/** POST /api/threads/:id/messages body — send a user turn. */
export interface SendMessageRequest {
  text: string;
  attachmentIds?: string[];
  model?: string;
  effort?: string;
  /** Set by a master-chat client when this turn originated in that room. */
  sourceChannel?: "main";
  replyToMessageId?: string;
  /** Membership used for this main-chat turn; omitted by direct/legacy callers. */
  sourceMasterChatId?: string;
}

/** POST /api/threads/:id/messages response when a turn starts immediately. */
export interface StartedMessageResponse {
  queued: false;
  runId: string;
  /** Which path started: fresh session (`seed`) or resumed (`continue`). */
  mode: "seed" | "continue";
}

/** POST /api/threads/:id/messages response when another turn is still active. */
export interface QueuedMessageResponse {
  queued: true;
  /** One-based position among follow-ups waiting for this agent. */
  position: number;
}

/** A message either starts now or is accepted into the per-agent FIFO queue. */
export type SendMessageResponse = StartedMessageResponse | QueuedMessageResponse;

/** Semantic communication requested by an agent. Routing is server-owned. */
export type AgentCommunicationIntent = CommunicationIntent;
/** Internal source/projection channel after the server has routed an intent. */
export type AgentMessageChannel = "individual" | "main" | "collaboration";

interface AgentMessageRequestBase {
  text: string;
  /** Stable across a transport retry so every durable effect occurs once. */
  idempotencyKey?: string;
}

/** POST /api/agent-messages body. The server derives the author from the capability. */
export type SendAgentMessageRequest = AgentMessageRequestBase & (
  | { intent: "broadcast"; recipientAgentIds?: never }
  | { intent: "direct_to_user"; recipientAgentIds?: never }
  | {
      intent: "collaboration";
      /** Stable agent IDs; display handles are presentation only. Must be non-empty. */
      recipientAgentIds: string[];
    }
);

/** POST /api/threads/:id/cancel response. */
export interface CancelResponse {
  cancelled: boolean;
}

// ─── Subagent delegation ────────────────────────────────────────────────

export type SubagentStatus = "queued" | "running" | "awaiting_disposition" | "completed" | "blocked" | "failed" | "cancelled";

export interface SubagentFailureDto {
  code: string;
  message: string;
  retryable: boolean;
  occurredAt: string;
}

/** Server-recorded delivery state for the automatic parent completion notice. */
export interface SubagentCompletionDeliveryDto {
  status: "queued" | "delivered" | "acknowledged" | "failed";
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  failure?: string;
}

/** Public run shape. The raw delegation prompt is deliberately excluded. */
export interface SubagentRunDto {
  id: string;
  masterChatId: string;
  /** Server-derived owning agent thread. Never accepted from an agent delegation request. */
  parentThreadId?: string;
  /** First-class Ponderosa agent/thread created for this delegated child. */
  childThreadId?: string;
  parentRunId: string;
  rootRunId: string;
  contextSnapshotId: string;
  depth: number;
  version: number;
  displayLabel: string;
  delegationSummary: string;
  runtime: string;
  status: SubagentStatus;
  canCancel: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  failure?: SubagentFailureDto;
  /** Authenticated child declaration of the delegated objective's outcome. */
  disposition?: {
    outcome: "completed" | "blocked";
    message?: string;
    declaredAt: string;
  };
  /** Present after a terminal child run when its parent can receive a notice. */
  completionDelivery?: SubagentCompletionDeliveryDto;
}

/** Agent-facing delegation input. Ownership is always resolved from its bearer capability. */
export interface AgentDelegationRequest {
  displayLabel: string;
  delegationPrompt: string;
  runtime?: string;
  model?: string;
  effort?: string;
  /** Safe project-scoped identifier; the server resolves all preset fields. */
  presetId?: string;
  idempotencyKey: string;
}

export interface AgentDelegationResponse {
  run: SubagentRunDto;
  accepted: boolean;
  replayed: boolean;
}

/** Authenticated, run-bound child declaration; engine turn completion is not an objective outcome. */
export interface AgentDelegationDispositionRequest {
  outcome: "completed" | "blocked";
  message?: string;
  idempotencyKey: string;
}

export interface CancelSubagentRequest {
  scope: "branch";
  idempotencyKey: string;
}

export interface CancelSubagentResponse {
  requestedRunId: string;
  scope: "branch";
  affected: Array<{
    runId: string;
    status: SubagentStatus;
    version: number;
    updatedAt: string;
  }>;
  completed: boolean;
}

export type DelegationErrorCode =
  | "unauthorized_parent"
  | "lifecycle_conflict"
  | "lifecycle_integrity"
  | "parent_not_running"
  | "depth_limit_exceeded"
  | "descendant_limit_exceeded"
  | "concurrency_limit_exceeded"
  | "idempotency_conflict"
  | "subagent_not_found"
  | "forbidden";

export interface DelegationErrorDto {
  error: { code: DelegationErrorCode; message: string; retryable: boolean };
}

export interface SubagentEventEnvelope {
  masterChatId: string;
  seq: number;
  ts: string;
  event:
    | { type: "subagent_spawned"; run: SubagentRunDto }
    | { type: "subagent_updated"; run: SubagentRunDto };
}

// ─── Engines ─────────────────────────────────────────────────────────────────

/** GET /api/engines entry — an engine, its options, and live auth status. */
export interface EngineDto {
  id: EngineId;
  displayName: string;
  models: ModelOption[];
  efforts: EffortOption[];
  authenticated: boolean;
  authDetail?: string;
}

// ─── Files (scoped file browser, SPEC §8/§11) ────────────────────────────────

/** One entry in a directory listing. */
export interface FileEntryDto {
  name: string;
  /** Path relative to the project's host path root. */
  path: string;
  kind: "file" | "dir";
  size?: number;
}

/**
 * GET /api/files response. Either a directory listing or a single file's content.
 * The endpoint is scoped strictly to registered project paths (AGENTS.md inv. 6).
 */
export type FilesResponse =
  | { kind: "dir"; path: string; entries: FileEntryDto[] }
  | { kind: "file"; path: string; content: string; encoding: "utf-8" | "base64" };

// ─── Health ──────────────────────────────────────────────────────────────────

/** GET /api/health response. */
export interface HealthDto {
  status: "ok";
  service: "ponderosa";
  version: string;
}

export interface ReadinessCheckDto {
  ok: boolean;
  detail: string;
}

/** GET /api/ready response. Readiness is allowed to be unavailable (HTTP 503). */
export interface ReadinessDto {
  status: "ready" | "not_ready";
  service: "ponderosa";
  version: string;
  canAcceptWork: boolean;
  checks: {
    daemon: ReadinessCheckDto;
    dataDirectory: ReadinessCheckDto;
    projections: ReadinessCheckDto;
    runtimes: ReadinessCheckDto;
  };
  runtimes: Array<{ id: string; authenticated: boolean; detail?: string }>;
}

// ─── v2 (stubbed 501 in v1 — SPEC §8) ────────────────────────────────────────

/** POST /api/threads/:id/switch-engine body (v2). */
export interface SwitchEngineRequest {
  engine: EngineId;
  model?: string;
  effort?: string;
}

/** GET /api/threads/:id/search?q= result (v2). */
export interface SearchResultDto {
  seq: number;
  ts: string;
  event: AgentEvent;
  /** Optional match highlight/snippet. */
  snippet?: string;
}

/** GET /api/threads/:id/search?q= response (v2). */
export interface SearchResponse {
  query: string;
  results: SearchResultDto[];
}
