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
  model?: string;
  effort?: string;
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
}

/** POST /api/threads/:id/messages response — the run id for the started turn. */
export interface SendMessageResponse {
  runId: string;
  /** Which path started: fresh session (`seed`) or resumed (`continue`). */
  mode: "seed" | "continue";
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
