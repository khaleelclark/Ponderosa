// The Adapter (engine) abstraction — SPEC §5. Every engine implements this one
// interface. The thread stores canonical history; the adapter translates it into
// a runtime session. Nothing outside packages/engines may know which engine it is
// (AGENTS.md invariant 2).

import type { AgentEvent } from "./events.js";

/** A stable engine identifier, e.g. "codex" or "claude". */
export type EngineId = string;

/**
 * A single conversation turn in a thread's canonical chat history. This is the
 * human-facing intent layer only (SPEC §2) — execution detail lives in Tasks/
 * Artifacts, never here. Passed to `seed()` to start a fresh runtime session.
 */
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  /** ISO-8601 timestamp; optional so callers can synthesize history cheaply. */
  createdAt?: string;
  attachments?: Array<{
    name: string;
    mediaType: string;
    size: number;
    localPath: string;
    available: boolean;
  }>;
}

/** A selectable model for an engine (e.g. Codex's model set). */
export interface ModelOption {
  id: string;
  label: string;
}

/** A selectable reasoning-effort level (e.g. low|medium|high|xhigh|max). */
export interface EffortOption {
  id: string;
  label: string;
}

/** Options shared by both `seed()` and `continue()`. */
export interface RunOptionsBase {
  threadId: string;
  /** The project's on-disk path; the agent's cwd, where it reads md files/git. */
  cwd: string;
  /** The next user message driving this turn. */
  prompt: string;
  model?: string;
  effort?: string;
  /** Per-run capability variables supplied by the orchestrator. */
  environment?: Record<string, string>;
  /** Abort → the adapter kills the underlying process (SPEC §11 cancel/kill). */
  signal: AbortSignal;
}

/** Options for continuing a thread's already-active runtime session. */
export interface ContinueOptions extends RunOptionsBase {
  /** The engine session id captured from a prior `session` event. */
  resumeSessionId: string;
}

/** Options for starting a fresh runtime session for a thread. */
export interface SeedOptions extends RunOptionsBase {
  /**
   * The thread's conversation so far (often just the first message in v1). The
   * adapter renders this into the initial prompt — there is NO assembled packet
   * (SPEC §4/§5, AGENTS.md invariant 4). The agent reads repo context itself.
   */
  history: ChatMessage[];
}

/**
 * The engine adapter. Adding an engine = implementing this, nothing else.
 * Both methods return a live stream of normalized {@link AgentEvent}s.
 */
export interface Adapter {
  id: EngineId; // "codex" | "claude"
  displayName: string;
  listModels(): ModelOption[];
  listEfforts(): EffortOption[];

  /**
   * Continue the thread's ACTIVE session with the next user message. Resume by
   * session id; let the runtime manage its own context (do not re-send history).
   */
  continue(opts: ContinueOptions): AsyncIterable<AgentEvent>;

  /**
   * Start a FRESH session for the thread (first turn, or a v2 engine switch).
   * Seed with the thread's chat history + the project dir — no packet.
   */
  seed(opts: SeedOptions): AsyncIterable<AgentEvent>;
}

/** Reported by `/api/engines` (SPEC §8): an engine plus its live auth status. */
export interface EngineAuthStatus {
  authenticated: boolean;
  /** Optional human-readable detail (e.g. "logged in as ...", or why not). */
  detail?: string;
}
