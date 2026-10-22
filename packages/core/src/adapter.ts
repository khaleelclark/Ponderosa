// The Adapter (engine) abstraction — SPEC §5. Every engine implements this one
// interface. The agent stores canonical history; the adapter translates it into
// a runtime session. Nothing outside packages/engines may know which engine it is
// (AGENTS.md invariant 2).

import type {RuntimeCapabilityRestrictions} from "./capability-policy.js";
import type { AgentEvent } from "./events.js";
import type { ProviderFailureCategory } from "./provider-failure-summary.js";

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
  /** Canonical provenance for bounded provider seed presentation; never authority. */
  provenance?: {
    eventId: string;
    projectId: string;
    conversationId?: string;
    sender: { kind: "user" | "agent" | "system"; id: string; label?: string };
    audience: { kind: string; agentIds?: string[]; recipientCount?: number;
      omittedRecipientCount?: number; recipientIdsSha256?: string };
    intent: string;
    direction: "authored" | "received";
    currentAgentId?: string;
    labelsOmitted?: boolean;
    /** Compact provider presentation; the exact event ID remains in the manifest. */
    sourceRecord?: number;
  };
  attachments?: Array<{
    name: string;
    mediaType: string;
    size: number;
    /** Present only for ordinary immutable uploaded attachments delivered by path. */
    localPath?: string;
    available: boolean;
    /** Stable Ponderosa artifact identity for referenced generated output. */
    artifactId?: string;
  }>;
}

export type EngineModelKind = "alias" | "exact";
export type EngineModelSource = "provider-probe" | "operator" | "environment";
export type EngineModelAvailability = "available" | "unavailable";

/** A selectable model for an engine (e.g. Codex's model set). */
export interface ModelOption {
  id: string;
  label: string;
  /** Explicit provider default; list order alone is not default evidence. */
  isDefault?: boolean;
  /** Provider-reported effort levels supported by this exact model. */
  efforts?: EffortOption[];
  /** Provider-reported default effort for this exact model. */
  defaultEffort?: string;
  /** Provider-reported non-standard service tiers for this exact model. */
  serviceTiers?: ServiceTierOption[];
  /** Provider-reported default service tier. Missing means normal speed. */
  defaultServiceTier?: string;
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
  | "client_upgrade_required"
  | "invalid_request"
  | "invalid_model"
  | "model_not_found"
  | "authentication"
  | "rate_limit"
  | "capacity"
  | "context_length"
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

/** A provider processing tier presented to users as response speed. */
export interface ServiceTierOption {
  id: string;
  label: string;
  description?: string;
}

/** Options shared by both `seed()` and `continue()`. */
export interface RunOptionsBase {
  agentId: string;
  /** The project's on-disk path; the agent's cwd, where it reads md files/git. */
  cwd: string;
  /** The next user message driving this turn. */
  prompt: string;
  /** Host-owned trusted instructions supplied through the provider's system
   * channel. They are never rendered as authored user content. */
  systemPrompt?: string;
  model?: string;
  effort?: string;
  /** "standard" clears any provider tier override; other values are provider IDs. */
  speed?: string;
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
  /** "standard" clears any provider tier override; other values are provider IDs. */
  speed?: string;
  clientMessageId?: string;
}

/** A host-owned tool exposed inside an engine runtime. */
export interface RuntimeDynamicToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RuntimeDynamicToolCall {
  /** Stable provider request identity, scoped to the current Run. */
  id: string;
  /** Normalized provider item identity, when distinct from the RPC request ID. */
  operationId?: string;
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

/**
 * A provider-owned request for information or an external account action.
 * Engine adapters normalize their native protocol before this crosses into
 * server/runtime code.
 */
export type RuntimeElicitationRequest =
  | {
      mode: "url";
      serverName: string;
      message: string;
      elicitationId?: string;
      url: string;
    }
  | {
      mode: "form" | "openai/form";
      serverName: string;
      message: string;
      requestedSchema: Record<string, unknown>;
    };

export interface RuntimeElicitationResponse {
  action: "accept" | "decline" | "cancel";
  content?: unknown;
}

export type RuntimeElicitationHandler = (
  request: RuntimeElicitationRequest,
) => Promise<RuntimeElicitationResponse>;

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
export interface RuntimeProcessIdentity {
  /** Root PID and process-group ID are equal for Ponderosa's detached POSIX CLIs. */
  pid: number;
  pgid: number;
  /** OS-derived process birth marker used to reject PID/PGID reuse after restart. */
  birthMarker: string;
  /** Optional exact Linux scope ownership; historical group-only identities remain valid. */
  scope?: { unit: string; authorityId: string };
}

export interface RuntimeProcessHandle {
  /** Restart-recoverable POSIX authority. Windows relies on kill-on-close Job Objects. */
  readonly processIdentity?: RuntimeProcessIdentity;
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
  contextUsage?(): {
    usedTokens: number;
    windowTokens?: number;
    aggregateTokens?: number;
    providerSessionGeneration?: string;
  } | undefined;
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
  /** Host-owned trusted instructions supplied through the provider's system
   * channel. They are never rendered as authored user content. */
  systemPrompt?: string;
  model?: string;
  effort?: string;
  /** "standard" clears any provider tier override; other values are provider IDs. */
  speed?: string;
  environment?: Record<string, string>;
  /** Host tools are transported by the adapter, never through the agent shell. */
  dynamicTools?: RuntimeDynamicToolSpec[];
  /** Resolved restriction-only controls translated by the provider adapter. */
  capabilityRestrictions?:RuntimeCapabilityRestrictions;
  handleDynamicToolCall?: RuntimeDynamicToolHandler;
  /** User-facing provider requests are handled by the host without exposing
   * engine-specific request methods outside packages/engines. */
  handleElicitation?: RuntimeElicitationHandler;
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

export type ProviderUsageFailureCode =
  | "provider_not_installed"
  | "provider_not_authenticated"
  | "provider_disabled"
  | "usage_not_supported"
  | "command_timeout"
  | "invalid_provider_response"
  | "provider_rate_limited"
  | "provider_temporarily_unavailable"
  | "server_environment_invalid"
  | "unknown_failure";

/** Safe, bounded metadata produced by an adapter when quota retrieval fails. */
export interface ProviderUsageReadFailureMetadata {
  exitCode?: number;
  timedOut?: boolean;
  runtimeVersion?: string;
}

export class ProviderUsageReadError extends Error {
  override readonly name = "ProviderUsageReadError";

  constructor(
    readonly code: ProviderUsageFailureCode,
    readonly metadata: ProviderUsageReadFailureMetadata = {},
  ) {
    super(code);
  }
}

export interface ProviderUsageReadOptions {
  /** Neutral host cwd for CLIs that require one; quota reads are not Project scoped. */
  cwd: string;
  signal: AbortSignal;
  /** Registered synchronously for every provider helper process. */
  onRuntimeSpawned: (handle: RuntimeProcessHandle) => void;
  /** Reports the provider-owned account as soon as it is known, before quota
   * retrieval finishes. `undefined` invalidates the observation when ownership
   * can no longer be verified. */
  onAccountIdentity?: (identity: ProviderUsageAccountIdentity | undefined) => void;
  timeoutMs?: number;
}

/** Opaque provider-derived identity used only to isolate host-side usage caches. */
export interface ProviderUsageAccountIdentity {
  fingerprint: string;
  accountLabel?: string;
}

/** One provider-authoritative quota observation. Identity and usage must be
 * captured by the same helper session so cache ownership cannot race usage. */
export interface ProviderUsageSnapshot {
  identity: ProviderUsageAccountIdentity;
  usage: ProviderUsage;
}

/**
 * The engine adapter. Adding an engine = implementing this, nothing else.
 * Both methods return a live stream of normalized {@link AgentEvent}s.
 */
export interface Adapter {
  /** Item-scoped response candidates; explicit host reply authorization remains required. */
  readonly supportsVoiceReplyStream?: boolean;
  id: EngineId; // "codex" | "claude"
  displayName: string;
  /** Ponderosa-dispatched slash command that opens this adapter's quota reader. */
  readonly providerUsageCommand?: { name: string; description: string };
  /** True when effort compatibility varies by model and missing metadata means unknown. */
  readonly modelSpecificEfforts?: boolean;
  /** Native provider channel used for host-owned trusted runtime instructions. */
  readonly trustedSystemPromptChannel: "developer" | "system";
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
  /** Atomically read provider-account identity and quota through one helper.
   * Cache-aware hosts prefer this method when account identity is provider-only. */
  readProviderUsageSnapshot?(
    options: ProviderUsageReadOptions,
  ): Promise<ProviderUsageSnapshot>;

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
  /** False alone is not logout evidence when the read-only probe is unknown. */
  status?: "unknown";
  reason?: "timeout" | "spawn_failed" | "malformed" | "cleanup_failed" | "probe_failed" | "probe_pending";
  source?: "cli_status" | "subscription_presence";
  /** Optional human-readable detail (e.g. "logged in as ...", or why not). */
  detail?: string;
}

/** Host-owned diagnostic process registration; never credential authority. */
export interface EngineProbeOptions {
  onRuntimeSpawned?: (handle: RuntimeProcessHandle) => void;
  signal?: AbortSignal;
}

/** Positive provider evidence gathered only after an explicit operator check. */
export interface EngineAvailabilityStatus {
  available: boolean;
  /** Optional structured adapter-owned category; preferred over provider prose. */
  failureCategory?: ProviderFailureCategory;
  /** Raw provider detail for restricted evidence/classification, never direct projection. */
  detail?: string;
}

/** One provider registration shared by engine producers and server consumers. */
export interface EngineRegistration {
  adapter: Adapter;
  /** Cheap host executable presence check; never starts a provider process. */
  isInstalled?: () => boolean;
  authStatus?: (options?: EngineProbeOptions) => Promise<EngineAuthStatus>;
  /** Explicit provider entitlement check; never run during polling. */
  availabilityProbe?: (options?: EngineProbeOptions) => Promise<EngineAvailabilityStatus>;
}
