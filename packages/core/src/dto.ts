// REST DTOs for the API surface (SPEC §8). These cross the UI↔server boundary and
// MUST stay JSON-serializable and free of Node-only types — apps/web imports them
// directly so the SSE/REST contract is typechecked end to end (SPEC §6, §1).

import type { EngineId, EffortOption, ModelOption } from "./adapter.js";
import type { AgentEvent, TaskStatus } from "./events.js";

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
  title: string;
  /** The engine currently bound to this thread. */
  activeEngine: EngineId;
  state: ThreadState;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
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
}

/** PATCH /api/threads/:id body (rename / archive). */
export interface UpdateThreadRequest {
  title?: string;
  archived?: boolean;
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
  model?: string;
  effort?: string;
  /** Set by a master-chat client when this turn originated in that room. */
  sourceChannel?: "main";
}

/** POST /api/threads/:id/messages response — the run id for the started turn. */
export interface SendMessageResponse {
  runId: string;
  /** Which path started: fresh session (`seed`) or resumed (`continue`). */
  mode: "seed" | "continue";
}

/** Destinations available to an agent through its short-lived run capability. */
export type AgentMessageChannel = "individual" | "main" | "collaboration";

/** POST /api/agent-messages body. The server derives the author from the capability. */
export interface SendAgentMessageRequest {
  channel: AgentMessageChannel;
  text: string;
}

/** POST /api/threads/:id/cancel response. */
export interface CancelResponse {
  cancelled: boolean;
}

// ─── Subagent delegation ────────────────────────────────────────────────

export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SubagentFailureDto {
  code: string;
  message: string;
  retryable: boolean;
  occurredAt: string;
}

/** Public run shape. The raw delegation prompt is deliberately excluded. */
export interface SubagentRunDto {
  id: string;
  masterChatId: string;
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
}

export interface SpawnSubagentRequest {
  parentRunId: string;
  displayLabel: string;
  delegationPrompt: string;
  runtime: string;
  model?: string;
  idempotencyKey: string;
}

export interface SubagentRegistrationDto {
  id: string;
  credential: string;
  expiresAt: string;
  runtime: string;
}

export interface SpawnSubagentResponse {
  run: SubagentRunDto;
  registration: SubagentRegistrationDto;
  replayed: boolean;
}

export interface ClaimSubagentRegistrationRequest {
  registrationId: string;
  credential: string;
  parentRunId: string;
  masterChatId: string;
  runtime: string;
}

export interface ClaimSubagentRegistrationResponse {
  run: SubagentRunDto;
  claimedAt: string;
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
  | "registration_required"
  | "registration_not_found"
  | "registration_expired"
  | "registration_consumed"
  | "registration_mismatch"
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
    | { type: "subagent_updated"; run: SubagentRunDto }
    | {
        type: "subagent_output";
        runId: string;
        runVersion: number;
        chunkSeq: number;
        cursor: string;
        delta: string;
      };
}

export interface SubagentTranscriptItemDto {
  chunkSeq: number;
  cursor: string;
  ts: string;
  text: string;
}

export interface SubagentTranscriptPageDto {
  runId: string;
  items: SubagentTranscriptItemDto[];
  nextCursor?: string;
  hasMore: boolean;
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
