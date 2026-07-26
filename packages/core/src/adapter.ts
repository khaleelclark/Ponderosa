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
    /** Present only for ordinary immutable uploaded attachments delivered by path. */
    localPath?: string;
    available: boolean;
    /** Stable Ponderosa artifact identity for referenced generated output. */
    artifactId?: string;
    /** Run-scoped stable retrieval reference supplied to fresh provider sessions. */
    retrievalUrl?: string;
  }>;
}

export type EngineModelKind = "alias" | "exact";
export type EngineModelSource = "provider-probe" | "operator" | "environment";
export type EngineModelAvailability = "available" | "unavailable";

/** A selectable model for an engine (e.g. Codex's model set). */
export interface ModelOption {
  id: string;
  label: string;
  /** Provider-reported effort levels supported by this exact model. */
  efforts?: EffortOption[];
  /** Provider-reported default effort for this exact model. */
  defaultEffort?: string;
  resolvedModel?: string;
  description?: string;
  kind?: EngineModelKind;
  supportedEffortLevels?: string[];
  source?: EngineModelSource;
  validatedAt?: string;
  availability?: EngineModelAvailability;
  unavailableReason?: string;
}

/**
 * Provider-backed model metadata. `id` is always the exact value supplied to
 * the subscription CLI; `resolvedModel` is provider evidence, never a locally
 * inferred replacement.
 */
export interface EngineModelOption extends ModelOption {
  kind: EngineModelKind;
  source: EngineModelSource;
}

export interface EngineModelCatalog {
  models: EngineModelOption[];
  cliVersion: string;
  /** Adapter-owned fingerprint of configuration that can affect discovery. */
  configurationKey: string;
}

export type EngineModelValidationError =
  | "invalid_model"
  | "model_not_found"
  | "authentication"
  | "organization_policy"
  | "plan_entitlement"
  | "network"
  | "provider_error";

export type EngineModelValidationResult =
  | { valid: true; model: EngineModelOption }
  | { valid: false; errorCode: EngineModelValidationError; error: string };

/** A selectable reasoning-effort level (e.g. low|medium|high|xhigh|max). */
export interface EffortOption {
  id: string;
  label: string;
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
  /** Called synchronously after a one-shot provider process is spawned. The
   * host retains this handle until whole-group termination is observed. */
  onRuntimeSpawned: (handle: RuntimeProcessHandle) => void;
  /** Called when a non-persistent provider root exits, before descendant
   * termination or stdout drain completes. Hosts revoke Run capabilities here. */
  onRuntimeRootExit: () => void;
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

export interface RuntimeCommandResult {
  /** Provider-derived, human-readable result for non-mutating runtime commands. */
  message?: string;
}

/**
 * One durable engine agent. The process/transport may survive many turns.
 * New signals steer an active turn or start a turn while idle; callers retain a
 * durable mailbox only for the short intervals where neither operation is safe.
 */
export interface RuntimeProcessHandle {
  /** True while the provider process group is still owned and running. */
  isAlive(): boolean;
  /** Resolve only after the owned provider process group has exited. A failed
   * termination attempt rejects while retaining enough authority to retry. */
  close(): Promise<void>;
}

export interface RuntimeSession extends RuntimeProcessHandle {
  readonly engineAgentId: string;
  readonly events: AsyncIterable<AgentEvent>;
  /** Best-effort current context occupancy for this provider session.
   * `usedTokens` counts everything occupying the provider's context window.
   * `windowTokens` is present only when the provider reports it. */
  contextUsage?(): { usedTokens: number; windowTokens?: number } | undefined;
  /** Provider rate-limit lines already available through this authenticated
   * runtime transport. Implementations must not add an out-of-band API call. */
  rateLimitStatus?(): Promise<string[]>;
  /** Live effective catalog for this authenticated session, with explicit
   * provenance for provider-advertised and adapter-implemented commands. */
  capabilities?(): Promise<EngineCapabilities>;
  /** Invoke a provider command that is represented by a structured runtime
   * method rather than by ordinary prompt text. */
  invokeCommand?(name: string, argumentsText?: string): Promise<RuntimeCommandResult | void>;
  startTurn(input: RuntimeTurnInput): Promise<{ turnId: string }>;
  steer(input: RuntimeTurnInput): Promise<RuntimeSteerResult>;
  interrupt(): Promise<void>;
}

export interface ProviderRootExitDetail {
  exitCode?: number | null;
  signal?: string | null;
  stderr?: string;
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
  /** Called synchronously after the adapter spawns a provider process and
   * before it awaits initialization/readiness. The host retains this authority
   * handle even when opening later rejects. */
  onRuntimeSpawned: (handle: RuntimeProcessHandle) => void;
  /** Exactly-once notification that the persistent provider root exited or
   * failed to spawn. The host revokes any active Run before draining output. */
  onRuntimeRootExit: (detail?: ProviderRootExitDetail) => void;
  /** Provider-native catalog notifications invalidate the host projection. */
  onCapabilitiesChanged?: () => void;
  signal: AbortSignal;
}

export interface EngineCommand {
  name: string;
  description: string;
  /** Provenance of the effective command implementation. Provider-advertised
   * commands are transported exactly as the provider exposes them; adapter
   * implementations dispatch a Ponderosa-owned action over provider data. */
  source: "provider-advertised" | "adapter-implemented" | "skill" | "plugin";
  acceptsArguments: boolean;
  /** Exact provider syntax inserted when this item is selected from the slash
   * discovery menu. Codex skills, for example, use `$name` even though `/`
   * opens the discovery surface. */
  insertText: string;
  status: "available" | "unavailable";
  unavailableReason?: string;
  /** Prompt commands are sent through the provider's advertised command path;
   * runtime commands are dispatched through a structured adapter method. */
  invocation: "prompt" | "runtime";
  /** Provider plugin identity when the effective catalog attributes it. */
  pluginName?: string;
}

export interface EngineMcpServer {
  name: string;
  configured: boolean;
  initialization: "not_initialized" | "initializing" | "initialized" | "failed";
  /** True only when provider evidence says the initialized server can be used.
   * Optional health metadata is intentionally not used as a failure proxy. */
  usable: boolean;
  toolsDiscovered: boolean;
  toolCount: number;
  health: "healthy" | "unhealthy" | "unknown";
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
  /** Provider session/catalog boundary represented by this snapshot. */
  sessionId?: string;
  /** Operator-selected alias or exact id used to open this session. */
  selectedModel?: string;
  /** Provider-resolved active model when reported. */
  model?: string;
  catalogVersion?: string;
  /** Provider model rows captured from this exact live session initialization. */
  modelCatalog?: EngineModelCatalog;
  commands: EngineCommand[];
  mcpServers: EngineMcpServer[];
  composerCapabilities: EngineComposerCapability[];
}

/** Host authority for a sessionless provider capability-discovery operation. */
export interface EngineCapabilityDiscoveryOptions {
  model?: string;
  signal: AbortSignal;
  /** Called synchronously for every helper process spawned by discovery. */
  onRuntimeSpawned: (handle: RuntimeProcessHandle) => void;
}

export interface EngineModelDiscoveryOptions {
  signal: AbortSignal;
  /** Called synchronously for every provider helper process that is spawned. */
  onRuntimeSpawned: (handle: RuntimeProcessHandle) => void;
}

export interface ProviderUsageWindow {
  id: string;
  label: string;
  usedPercent?: number;
  resetsAt?: string;
}

/** Provider-account quota read through the authenticated subscription CLI.
 * This surface is provider scoped: it never creates an Agent Run or prompt. */
export interface ProviderUsage {
  provider: EngineId;
  windows: ProviderUsageWindow[];
  accountLabel?: string;
  source: "provider-command" | "provider-rpc";
  fetchedAt: string;
  stale?: boolean;
}

export interface ProviderUsageReadOptions {
  /** Neutral host cwd for CLIs that require one; quota reads are not Project scoped. */
  cwd: string;
  signal: AbortSignal;
  /** Registered synchronously for every provider helper process. */
  onRuntimeSpawned: (handle: RuntimeProcessHandle) => void;
  timeoutMs?: number;
}

/**
 * The engine adapter. Adding an engine = implementing this, nothing else.
 * Both methods return a live stream of normalized {@link AgentEvent}s.
 */
export interface Adapter {
  id: EngineId; // "codex" | "claude"
  displayName: string;
  /** Ponderosa-dispatched slash command that opens this adapter's quota reader. */
  readonly providerUsageCommand?: { name: string; description: string };
  /** True when effort compatibility varies by model and missing metadata means unknown. */
  readonly modelSpecificEfforts?: boolean;
  listModels(): ModelOption[];
  /** Host-configured provider model pins, excluding built-in aliases. */
  configuredModelOptions?(): ModelOption[];
  /** Replace operator-managed model options without rebuilding the adapter. */
  setOperatorModelOptions?(models: EngineModelOption[]): void;
  /** Configuration-only fingerprint used to keep Project model caches isolated. */
  modelCatalogConfigurationKey?(): string;
  /** Discover provider-advertised aliases and exact model choices without a turn. */
  discoverModelCatalog?(cwd: string, context: EngineModelDiscoveryOptions): Promise<EngineModelCatalog>;
  /** Merge live provider rows with operator and environment configuration. */
  configuredModelCatalog?(providerModels: EngineModelOption[]): EngineModelOption[];
  /** Validate a typed model through an explicit, user-initiated provider check. */
  validateModel?(cwd: string, modelId: string, context: EngineModelDiscoveryOptions): Promise<EngineModelValidationResult>;
  listEfforts(model?: string): EffortOption[];
  /** Concrete adapter-owned fallback used when no operator or Project override exists. */
  defaultModel?(): string | undefined;
  /** Concrete adapter-owned fallback for the selected model. */
  defaultEffort?(model?: string): string | undefined;

  /** Open the V1 persistent runtime. Required by steer-capable adapters. */
  openSession?(opts: OpenRuntimeSessionOptions): Promise<RuntimeSession>;

  /** Discover engine-native commands, skills/plugins, structured actions, and
   * MCP state for the selected provider/model boundary. */
  capabilities?(cwd: string, context: EngineCapabilityDiscoveryOptions): Promise<EngineCapabilities>;

  /** Read provider-account quota without creating a Run or sending model text. */
  readProviderUsage?(options: ProviderUsageReadOptions): Promise<ProviderUsage>;

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
