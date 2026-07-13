// REST DTOs for the API surface (SPEC §8). These cross the UI↔server boundary and
// MUST stay JSON-serializable and free of Node-only types — apps/web imports them
// directly so the SSE/REST contract is typechecked end to end (SPEC §6, §1).

import type { EngineId, EffortOption, ModelOption } from "./adapter.js";
import type { AgentEvent, TaskStatus } from "./events.js";
import type { CommunicationDocumentReference, CommunicationIntent } from "./communication.js";

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
  /** Existing absolute host folder. Omit to use a new managed empty workspace. */
  hostPath?: string;
  /** Create a named empty folder below Ponderosa's managed workspace root. */
  createFolderName?: string;
}

/** PATCH /api/projects/:id body. Project working folders are immutable after creation. */
export interface UpdateProjectRequest {
  label: string;
}

export interface ProjectFolderOptionDto {
  hostPath: string;
  name: string;
  source: "registered" | "managed";
}

/** GET /api/project-folders response. Never exposes arbitrary host directories. */
export interface ProjectFolderOptionsDto {
  managedRoot: string;
  folders: ProjectFolderOptionDto[];
}

/** Current Git-backed workspace state. Execution events remain the provenance trail. */
export interface WorkspaceChangeDto {
  path: string;
  previousPath?: string;
  kind: "create" | "edit" | "delete" | "rename";
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

/** GET /api/projects/:id/workspace response. */
export interface WorkspaceStatusDto {
  projectId: string;
  isGitRepository: boolean;
  branch?: string;
  head?: string;
  generatedAt: string;
  changes: WorkspaceChangeDto[];
}

/** GET /api/projects/:id/workspace/file response. */
export interface WorkspaceFileReviewDto {
  projectId: string;
  path: string;
  exists: boolean;
  /** Current UTF-8 file body when it is small enough and safe to display. */
  content?: string;
  diff: string;
  stagedDiff: string;
  unstagedDiff: string;
  truncated: boolean;
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
  /** Canonical cross-surface event identity, absent only on pre-migration history. */
  communicationEventId?: string;
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
  document?: CommunicationDocumentReference;
}

/** User-authored emoji state projected onto one canonical agent communication. */
export interface MessageReactionDto {
  emoji: string;
  count: number;
  reactedByCurrentActor: boolean;
  reactors: Array<{ kind: "manager" }>;
}

/** POST /api/user-reactions body. */
export interface CreateUserReactionRequest {
  projectId: string;
  communicationEventId: string;
  emoji: string;
  idempotencyKey: string;
}

export interface CreateUserReactionResponse {
  replayed: boolean;
  queued: boolean;
  targetAuthorThreadId: string;
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

/** POST /api/master-chats/:id/collaboration/messages body. */
export interface CreateCollaborationMessageRequest {
  text: string;
  /** Stable IDs resolved by the client; display handles are never routing input. */
  recipientAgentIds: string[];
  replyToMessageId?: string;
}

/** POST collaboration message response; recipients are the immutable resolved audience. */
export interface CreateCollaborationMessageResponse {
  message: MasterChatMessageDto;
  audience: "mention" | "everyone";
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

export interface CreateMultiAgentDirectMessageRequest {
  text: string;
  recipients: Array<{ agentId: string; attachmentIds?: string[] }>;
  replyToMessageId?: string;
  /** Stable across retries; one user action creates one message and N deliveries. */
  idempotencyKey: string;
}

export interface MultiAgentDirectMessageResponse {
  messageId: string;
  replayed: boolean;
  recipients: Array<{ agentId: string; queued: boolean }>;
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
  /** Direct manager in the mutable agent organization. Undefined means the agent reports to the user. */
  managerAgentId?: string;
  /** Stable creation provenance for an agent spawned by another agent. */
  spawnedByAgentId?: string;
  spawnedByExecutionId?: string;
  /** Exact optional message supplied by the spawning agent. */
  spawnPrompt?: string;
  /** Immutable-at-spawn preset provenance and guidance snapshot. */
  presetSnapshot?: Pick<AgentPresetDto, "id" | "name" | "description" | "guidance" | "engine" | "model" | "effort">;
}

export interface TeamDirectoryAgentDto {
  agentId: string;
  displayName: string;
  role: string;
  description: string;
  status: AgentLifecycleStatus;
  currentActivity?: string;
  managerAgentId?: string;
  childAgentIds: string[];
  engine: EngineId;
  preset?: { id: string; name: string };
}

export interface TeamDirectoryDto {
  projectId: string;
  generatedAt: string;
  agents: TeamDirectoryAgentDto[];
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
  /** Optional existing agent this new agent reports to. User-authorized creation only. */
  managerAgentId?: string;
}

/** Agent-facing creation request. Manager identity is always derived from the bearer capability. */
export interface AgentSpawnRequest {
  displayName: string;
  initialMessage?: string;
  runtime?: string;
  model?: string;
  effort?: string;
  presetId?: string;
  idempotencyKey: string;
}

export interface AgentSpawnResponse {
  agent: ThreadDto;
  accepted: boolean;
  replayed: boolean;
}

/** PATCH /api/threads/:id body (rename / archive). */
export interface UpdateThreadRequest {
  title?: string;
  archived?: boolean;
}

/** PUT /api/threads/:id/manager body. Null promotes to top level. */
export interface UpdateAgentOrganizationRequest {
  managerAgentId: string | null;
}

/** Canonical append-only record for mutable agent organization. */
export interface AgentOrganizationEvent {
  eventId: string;
  type: "manager_changed";
  projectId: string;
  agentId: string;
  managerAgentId: string | null;
  createdAt: string;
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
  /** Canonical cross-surface event identity, absent only on pre-migration history. */
  communicationEventId?: string;
  threadId: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  replyTo?: MessageReferenceDto;
  attachments?: ImageAttachmentDto[];
  reactions?: MessageReactionDto[];
  document?: CommunicationDocumentReference;
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
export type ArtifactKind = "diff" | "test_report" | "pr_summary" | "log" | "document";

export type AgentActivityEvent = Extract<AgentEvent, {
  type: "command" | "file_change" | "test_result" | "tool_call" | "tool_result" | "error";
}>;

/** Canonical, refresh-safe execution activity projected from the agent event log. */
export interface AgentActivityDto {
  id: string;
  threadId: string;
  executionId?: string;
  seq: number;
  createdAt: string;
  event: AgentActivityEvent;
}

/** Latest state of a path touched by this agent, rebuilt from canonical file-change events. */
export interface ChangedFileDto {
  path: string;
  kind: "create" | "edit" | "delete";
  lastSeq: number;
  lastChangedAt: string;
  executionIds: string[];
  /** Most recent engine-provided unified diff, when available. */
  diff?: string;
}

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
  /** Generated files are served through opaque, project-scoped URLs. */
  mediaType?: "application/pdf";
  previewUrl?: string;
  downloadUrl?: string;
}

/** GET /api/threads/:id/artifacts/:aid — the artifact plus its rendered content. */
export interface ArtifactContentDto extends ArtifactDto {
  /** Raw text content (diff text, report body, log text). */
  content: string;
  /** Hint for the read-only viewer (markdown vs plain vs unified diff). */
  contentType: "markdown" | "diff" | "text";
}

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

export interface ThinkingEntryDto {
  id: string;
  threadId: string;
  executionId: string;
  kind: "response" | "reasoning";
  text: string;
  completed: boolean;
  seq: number;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: string;
}

/**
 * GET /api/threads/:id — the full thread view. Chat contains only explicit
 * communications; Thinking contains execution-scoped ordinary output.
 */
export interface ThreadDetailDto {
  thread: ThreadDto;
  messages: MessageDto[];
  thinking: ThinkingEntryDto[];
  activity: AgentActivityDto[];
  changedFiles: ChangedFileDto[];
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
  /** A plain Master Chat request is shared context while still starting this agent. */
  shareWithOrganization?: boolean;
  replyToMessageId?: string;
  /** Membership used for this main-chat turn; omitted by direct/legacy callers. */
  sourceMasterChatId?: string;
  /**
   * How a direct message should be delivered if this agent has an active turn.
   * Steering is the interactive default; queueing is always an explicit user choice.
   */
  activeRunDelivery?: "steer" | "queue";
}

/** POST /api/threads/:id/messages response when a turn starts immediately. */
export interface StartedMessageResponse {
  queued: false;
  runId: string;
  /** Which path started: fresh session (`seed`) or resumed (`continue`). */
  mode: "seed" | "continue" | "steer";
  /** True when the message was accepted by the already-active engine turn. */
  steered?: boolean;
  communicationEventId?: string;
}

/** POST /api/threads/:id/messages response when another turn is still active. */
export interface QueuedMessageResponse {
  queued: true;
  /** One-based position among follow-ups waiting for this agent. */
  position: number;
  communicationEventId?: string;
}

/** A message either starts now or is accepted into the per-agent FIFO queue. */
export type SendMessageResponse = StartedMessageResponse | QueuedMessageResponse;

/** Semantic communication requested by an agent. Routing is server-owned. */
export type AgentCommunicationIntent = CommunicationIntent;
/** Internal source/projection channel after the server has routed an intent. */
export type AgentMessageChannel = "individual" | "main" | "collaboration";

interface AgentMessageRequestBase {
  text: string;
  /** Optional long-form Markdown; `text` remains the concise scoped summary. */
  document?: { title: string; content: string; mediaType?: "text/markdown" };
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

export interface CommunicationDocumentContentDto extends CommunicationDocumentReference {
  content: string;
}

/** POST /api/threads/:id/cancel response. */
export interface CancelResponse {
  cancelled: boolean;
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

export interface ProjectEngineCapabilitiesDto {
  engineId: EngineId;
  steering: boolean;
  persistentSessions: boolean;
  commands: import("./adapter.js").EngineCommand[];
  mcpServers: import("./adapter.js").EngineMcpServer[];
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
  /** Exact deployed source revision captured when this daemon started. */
  revision: string;
}

/** Manager-facing lifecycle vocabulary. Some runtimes cannot yet emit every state. */
export type AgentLifecycleStatus = "idle" | "running" | "stalled" | "interrupted" | "waiting" | "blocked" | "compacting" | "cancelled" | "completed" | "failed";

export type AgentLifecycleReason =
  | "no_active_work" | "active_run" | "task_waiting_approval" | "queued_delivery"
  | "task_completed" | "turn_completed" | "runtime_error"
  | "session_rollover_scheduled" | "thread_cancelled"
  | "execution_lease_expired" | "execution_interrupted" | "runtime_event_consumer_stalled";

export interface AgentHealthDto {
  /** Stable thread identity; titles and mention handles are presentation only. */
  agentId: string;
  managerAgentId?: string;
  childAgentIds: string[];
  status: AgentLifecycleStatus;
  /** Timestamp of the authoritative observation that selected `status`. */
  statusTimestamp: string;
  reason: AgentLifecycleReason;
  /** Runtime generation and bounded liveness window, when work is active. */
  executionId?: string;
  leaseExpiresAt?: string;
  runtimeOwnership?: "running" | "stalled" | "cancelling" | "interrupted";
  /** Present only while the server canonically owns an active execution. */
  runtimeActivity?: {
    state: "responding";
    executionId: string;
    startedAt: string;
  };
}

export interface AgentHealthProjectionDto {
  scope: { type: "project" | "master_chat"; id: string };
  generatedAt: string;
  agents: AgentHealthDto[];
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
    communicationMigration: ReadinessCheckDto;
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
