// The Adapter (engine) abstraction — SPEC §5. Every engine implements this one
// interface. The agent stores canonical history; the adapter translates it into
// a runtime session. Nothing outside packages/engines may know which engine it is
// (AGENTS.md invariant 2).

import type { AgentEvent } from "./events.js";

/** A stable engine identifier, e.g. "codex" or "claude". */
export type EngineId = string;

/**
 * A single conversation turn in an agent's canonical chat history. This is the
 * human-facing intent layer only (SPEC §2) — execution detail lives in Runs,
 * Activity, and Files & results, never here. Passed to `seed()` to start a fresh runtime session.
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
    /** Stable Ponderosa artifact identity for referenced generated output. */
    artifactId?: string;
    /** Project-scoped retrieval location supplied to fresh provider sessions. */
    retrievalUrl?: string;
  }>;
}

/** A selectable model for an engine (e.g. Codex's model set). */
export interface ModelOption {
  id: string;
  label: string;
  /** Provider-reported effort levels supported by this exact model. */
  efforts?: EffortOption[];
  /** Provider-reported default effort for this exact model. */
  defaultEffort?: string;
}

/** A selectable reasoning-effort level (e.g. low|medium|high|xhigh|max). */
export interface EffortOption {
  id: string;
  label: string;
}

/** Public API list-price proxy for one subscription-authenticated runtime model. */
export interface ApiPriceProfile {
  id: string;
  /** Exact API model used for the price, or the explicit proxy model for an alias. */
  pricingModel: string;
  catalogVersion: string;
  effectiveAt: string;
  sourceUrl: string;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  cacheWriteInputUsdPerMillion?: number;
  outputUsdPerMillion: number;
  /** True when the selected runtime alias is priced through a documented proxy model. */
  proxy?: boolean;
  longContext?: {
    inputTokenThreshold: number;
    inputMultiplier: number;
    outputMultiplier: number;
  };
}

/** Options shared by both `seed()` and `continue()`. */
export interface RunOptionsBase {
  agentId: string;
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

/** Options for continuing an agent's already-active runtime session. */
export interface ContinueOptions extends RunOptionsBase {
  /** The engine session id captured from a prior `session` event. */
  resumeSessionId: string;
}

/** Options for starting a fresh runtime session for an agent. */
export interface SeedOptions extends RunOptionsBase {
  /**
   * The agent's conversation so far (often just the first message in v1). The
   * adapter renders this into the initial prompt — there is NO assembled packet
   * (SPEC §4/§5, AGENTS.md invariant 4). The agent reads repo context itself.
   */
  history: ChatMessage[];
}

export type RuntimeDeliveryKind = "user_message" | "collaboration" | "system";

export interface RuntimeTurnInput {
  prompt: string;
  kind: RuntimeDeliveryKind;
  model?: string;
  effort?: string;
  clientMessageId?: string;
}

/** A host-owned tool exposed inside an engine runtime. */
export interface RuntimeDynamicToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RuntimeDynamicToolCall {
  name: string;
  arguments: unknown;
}

export interface RuntimeDynamicToolResult {
  success: boolean;
  /** Plain text returned to the engine after the host finishes the call. */
  text: string;
}

export type RuntimeDynamicToolHandler = (
  call: RuntimeDynamicToolCall,
) => Promise<RuntimeDynamicToolResult>;

export type RuntimeSteerResult =
  | { status: "accepted"; turnId?: string }
  | { status: "not_active" | "not_steerable" | "unsupported"; reason?: string };

/**
 * One durable engine agent. The process/transport may survive many turns.
 * New signals steer an active turn or start a turn while idle; callers retain a
 * durable mailbox only for the short intervals where neither operation is safe.
 */
export interface RuntimeSession {
  readonly engineAgentId: string;
  readonly events: AsyncIterable<AgentEvent>;
  /** True while the persistent engine transport is still owned and running. */
  isAlive(): boolean;
  startTurn(input: RuntimeTurnInput): Promise<{ turnId: string }>;
  steer(input: RuntimeTurnInput): Promise<RuntimeSteerResult>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenRuntimeSessionOptions {
  agentId: string;
  cwd: string;
  resumeSessionId?: string;
  history: ChatMessage[];
  model?: string;
  effort?: string;
  environment?: Record<string, string>;
  /** Host tools are transported by the adapter, never through the agent shell. */
  dynamicTools?: RuntimeDynamicToolSpec[];
  handleDynamicToolCall?: RuntimeDynamicToolHandler;
  signal: AbortSignal;
}

export interface EngineCommand {
  name: string;
  description: string;
  source: "ponderosa" | "engine" | "skill" | "plugin";
  acceptsArguments: boolean;
}

export interface EngineMcpServer {
  name: string;
  status: "connected" | "disconnected" | "unknown";
  detail?: string;
}

/**
 * One composer-facing capability reported by an authenticated runtime.
 * Invocation syntax is normalized by the adapter so the web app never needs
 * to know whether an engine addresses a skill with `/`, `$`, or another form.
 */
export interface EngineComposerCapability {
  id: string;
  kind: "skill" | "plugin" | "connector";
  label: string;
  description: string;
  status: "available" | "unavailable";
  /** Exact text to insert at the caret when this capability is actionable. */
  insertText?: string;
  /** Short human-facing explanation for a disabled capability. */
  unavailableReason?: string;
}

export interface EngineCapabilities {
  steering: boolean;
  persistentSessions: boolean;
  commands: EngineCommand[];
  mcpServers: EngineMcpServer[];
  composerCapabilities: EngineComposerCapability[];
}

/**
 * The engine adapter. Adding an engine = implementing this, nothing else.
 * Both methods return a live stream of normalized {@link AgentEvent}s.
 */
export interface Adapter {
  id: EngineId; // "codex" | "claude"
  displayName: string;
  /** True when effort compatibility varies by model and missing metadata means unknown. */
  readonly modelSpecificEfforts?: boolean;
  listModels(): ModelOption[];
  listEfforts(model?: string): EffortOption[];

  /** API list-price proxy only; Ponderosa never calls a provider billing API. */
  apiPriceProfile?(model?: string): ApiPriceProfile | undefined;

  /** Open the V1 persistent runtime. Required by steer-capable adapters. */
  openSession?(opts: OpenRuntimeSessionOptions): Promise<RuntimeSession>;

  /** Discover engine-native commands, skills/plugins, and inherited host MCPs. */
  capabilities?(cwd: string): Promise<EngineCapabilities>;

  /**
   * Continue the agent's ACTIVE session with the next user message. Resume by
   * session id; let the runtime manage its own context (do not re-send history).
   */
  continue(opts: ContinueOptions): AsyncIterable<AgentEvent>;

  /**
   * Start a FRESH session for the agent (first turn, or a v2 engine switch).
   * Seed with the agent's chat history + the project dir — no packet.
   */
  seed(opts: SeedOptions): AsyncIterable<AgentEvent>;
}

/** Reported by `/api/engines` (SPEC §8): an engine plus its live auth status. */
export interface EngineAuthStatus {
  authenticated: boolean;
  /** Optional human-readable detail (e.g. "logged in as ...", or why not). */
  detail?: string;
}

/** Positive provider evidence gathered only after an explicit operator check. */
export interface EngineAvailabilityStatus {
  available: boolean;
  /** Provider-safe detail explaining the result of the check. */
  detail?: string;
}
