import type { EngineId, EffortOption, EngineModelOption, EngineModelValidationError, ModelOption } from "../adapter.js";
import type { TokenUsage } from "../events.js";
import type { ProviderFailureCategory } from "../provider-failure-summary.js";

export interface ProviderInputSourceManifestV1 {
  schemaVersion: 1;
  historyMessageCount: number;
  activationIds: string[];
  communicationEventIds: string[];
  artifactIds: string[];
  conversationId?: string;
  providerSessionDisposition: "fresh_task" | "continued_session" | "reseeded";
  sources: Array<{
    kind: "identity" | "history_message" | "activation" | "communication" | "artifact" | "team_directory";
    ref: string;
    hash?: string;
    createdAt?: string;
  }>;
}

export interface ProviderInputSourceManifestV2 {
  schemaVersion: 2;
  /** History messages represented in the exact text submitted for this Run. */
  historyMessageCount: number;
  /** Sources known to remain only in the continued provider session. */
  retainedSessionSourceCount: number;
  activationIds: string[];
  communicationEventIds: string[];
  artifactIds: string[];
  conversationId?: string;
  providerSessionDisposition: "fresh_task" | "continued_session" | "reseeded";
  sources: Array<{
    kind: "identity" | "history_message" | "activation" | "communication" | "artifact" | "team_directory";
    ref: string;
    /** Submitted sources contribute to exactPrompt; retained sources do not. */
    delivery: "submitted" | "retained_session";
    hash?: string;
    createdAt?: string;
  }>;
}

export interface RuntimeEnvironmentFactsDto {
  cwd: string;
  platform: string;
  executables: Array<{ name: "python" | "python3" | "node" | "git" | "pnpm"; availability: "available" | "not_found" | "unknown" }>;
  reportOutputRoot?: string;
}

export interface ProviderInputSourceManifestV3 {
  /** Frozen authorization and selection evidence for this exact accepted packet. */
  historyContext?: {
    boundary?: { canonicalOrdinal: number; communicationEventId?: string };
    additionalHistory: boolean;
    fullyIncludedCommunicationEventIds: string[];
    clippedCommunicationEventIds: string[];
    retrievalAvailable: boolean;
  };
  schemaVersion: 3;
  environmentFacts?: RuntimeEnvironmentFactsDto;
  /** History messages represented in the exact text submitted for this Run. */
  historyMessageCount: number;
  /** Sources known to remain only in the continued provider session. */
  retainedSessionSourceCount: number;
  activationIds: string[];
  communicationEventIds: string[];
  artifactIds: string[];
  conversationId?: string;
  providerSessionDisposition: "fresh_task" | "continued_session" | "reseeded";
  sources: Array<{
    kind: "policy" | "identity" | "history_message" | "activation" | "communication" | "artifact" | "team_directory" | "context_reference" | "continuation_handoff" | "environment";
    ref: string;
    /** Submitted sources contribute to exactPrompt; retained sources do not. */
    delivery: "submitted" | "retained_session";
    hash?: string;
    createdAt?: string;
    /** Canonical origin retained for cross-chat Agent-private continuity. */
    conversationId?: string;
    conversationTitle?: string;
    author?: string;
    communicationIntent?: string;
  }>;
}

/** Earlier manifests remain readable for historical Runs; new Runs use V3. */
export type ProviderInputSourceManifest = ProviderInputSourceManifestV1 | ProviderInputSourceManifestV2 | ProviderInputSourceManifestV3;

/** Exact scheduler packet, including steering. This does not claim to snapshot
 * opaque retained provider history or create a second execution identity. */
export interface PromptInjectionSourceManifestDto {
  schemaVersion: 1;
  runId: string;
  injectionId: string;
  kind: "turn" | "steer";
  activationIds: string[];
  sources: Array<{ kind: "activation"; ref: string }>;
}

export interface ProviderInputDto {
  executionId: string;
  schedulerRunId: string;
  promptHash: string;
  systemPromptHash?: string;
  sourceManifest: ProviderInputSourceManifest;
  exactPrompt?: string;
  exactSystemPrompt?: string;
  createdAt: string;
  updatedAt: string;
}

export type TokenUsageScope = "overall" | "project" | "agent" | "conversation";

export type TokenUsageMetric = "inputTokens" | "cachedInputTokens" | "cacheWriteInputTokens" | "outputTokens" | "reasoningOutputTokens" | "totalTokens";

export type TokenUsageMetricAvailability = "available" | "unavailable";

export interface TokenUsageRangeDto {
  /** Inclusive ISO timestamp lower bound. */
  from?: string;
  /** Exclusive ISO timestamp upper bound. */
  to?: string;
}

export interface TokenUsageTurnDto {
  projectId: string;
  conversationId?: string;
  agentId: string;
  agentTitle: string;
  executionId: string;
  engine: EngineId;
  model?: string;
  startedAt: string;
  completedAt?: string;
  usage?: TokenUsage;
}

export interface TokenUsageBreakdownDto {
  projectId: string;
  conversationId?: string;
  agentId: string;
  agentTitle: string;
  engine: EngineId;
  model?: string;
  runs: number;
  usage: TokenUsage;
}

/** Rebuildable aggregate over finalized canonical runs. */
export interface TokenUsageSummaryDto extends TokenUsage {
  scope: TokenUsageScope;
  scopeId?: string;
  finalizedRuns: number;
  reportedRuns: number;
  unreportedRuns: number;
  /** Provider requests represented by retained per-request telemetry. */
  providerRequests?: number;
  /** Aggregate wall-clock duration of finalized Runs in this scope. */
  durationMs?: number;
  /** 0..1; null when the scope has no finalized runs. */
  coverage: number | null;
  range?: TokenUsageRangeDto;
  /** Metrics absent from every reported run are explicitly unavailable. */
  metricAvailability: Record<TokenUsageMetric, TokenUsageMetricAvailability>;
  /** Aggregated by project chat, agent, and engine/model. */
  breakdown: TokenUsageBreakdownDto[];
  /** Most recent finalized turns in the selected range. */
  recentTurns: TokenUsageTurnDto[];
  /** Exact structural Activation kinds attached to finalized Runs. One Run may
   * contribute to several causes; activation counts preserve coalesced wakes. */
  wakeCauses: Array<{ cause: string; runs: number; activations: number }>;
}

export interface ProviderUsageFailureDto {
  code: import("../adapter.js").ProviderUsageFailureCode;
  message: string;
  correlationId: string;
  occurredAt: string;
  durationMs?: number;
  exitCode?: number;
  timedOut?: boolean;
  runtimeVersion?: string;
}

interface ProviderUsageStateBaseDto {
  provider: EngineId;
  displayName: string;
  authenticated: boolean;
  refreshing: boolean;
}

/** One provider's current quota-cache projection. Failed refreshes preserve a
 * last-known-good reading without conflating quota health with engine health. */
export type ProviderUsageStateDto = ProviderUsageStateBaseDto & (
  | { status: "loading" }
  | {
      status: "fresh";
      data: import("../adapter.js").ProviderUsage;
      retrievedAt: string;
    }
  | {
      status: "stale";
      data: import("../adapter.js").ProviderUsage;
      retrievedAt: string;
      failure: ProviderUsageFailureDto;
    }
  | {
      status: "unavailable";
      failure: ProviderUsageFailureDto;
    }
);

export interface ProviderUsageCenterDto {
  providers: ProviderUsageStateDto[];
}

// ─── Engines ─────────────────────────────────────────────────────────────────

/** GET /api/engines entry — an engine, its options, and live auth status. */
export interface ResourceAdmissionDto {
  state: "ready" | "held" | "unavailable" | "unsupported" | "disabled";
  protected: boolean;
  reason: "within_budget" | "host_resource_pressure" | "measurement_unavailable" | "measurement_stale" | "operator_disabled";
  observedAt?: string;
  source?: "linux_host" | "linux_host_and_cgroup";
  availableBytes?: number;
  reserveBytes?: number;
  startupBytes?: number;
  memoryFullPercent?: number;
  ioFullPercent?: number;
}
export interface EngineDto {
  id: EngineId;
  displayName: string;
  /** Ponderosa-dispatched command that opens this provider's quota card. */
  providerUsageCommand?: string;
  models: ModelOption[];
  /** Model pins configured by the provider environment, excluding built-in aliases. */
  configuredModels?: ModelOption[];
  efforts: EffortOption[];
  /** Concrete adapter-owned fallback; never the provider's opaque "default" alias. */
  defaultModel?: string;
  defaultEffort?: string;
  /** False when provider model metadata is temporarily unavailable. */
  modelCatalogKnown?: boolean;
  /** Exact inventory process provenance; a catalog is not an inference test. */
  cliVersion?: string;
  modelCatalogFetchedAt?: string;
  modelDiscovery?: boolean;
  modelValidation?: boolean;
  /** The adapter is configured on this Ponderosa host. */
  configured: true;
  /** Host CLI presence, independent of sign-in and the operator switch. */
  installed?: boolean;
  /** Global operator switch. Disabled engines retain queued work but cannot lease it. */
  enabled?: boolean;
  /** Authentication probe truth. `checking` never means signed out, and
   * successful authentication does not prove provider reachability. */
  authentication: "checking" | "authenticated" | "unauthenticated" | "error";
  authDetail?: string;
  authObservedAt?: string;
  authReason?: import("../adapter.js").EngineAuthStatus["reason"];
  authDiagnosticFailure?: import("../adapter.js").EngineAuthStatus["diagnosticFailure"];
  authSource?: import("../adapter.js").EngineAuthStatus["source"];
  resourceAdmission?: ResourceAdmissionDto;
  /** Bounded stale information, never intake authority when authentication is error. */
  authLastKnown?: { authenticated: boolean; observedAt: string };
  /** Scheduler intake may start real provider work. This is admission state,
   * not a claim that a provider request has already succeeded. */
  intakeReady: boolean;
  /** Last real provider observation. Authentication alone remains unverified. */
  reachability: "unverified" | "checking" | "reachable" | "degraded";
  /** Positive/negative provider evidence behind reachability and intake. */
  availabilityDetail?: string;
  /** Timestamp and source of the last actual provider observation. */
  availabilityObservedAt?: string;
  availabilitySource?: "provider_run" | "operator_probe";
  /** Serving artifact and startup generation; historical evidence may lack these. */
  servingBuildRevision: string;
  servingInstanceId: string;
  availabilityBuildRevision?: string;
  availabilityInstanceId?: string;
  /** Canonical static-detail category; absent for positive/unverified status. */
  availabilityCategory?: ProviderFailureCategory;
}

export interface ProjectEngineCapabilitiesDto {
  engineId: EngineId;
  /** False means no provider snapshot has completed for this exact Project,
   * engine, host-path, and model boundary yet. */
  discovered: boolean;
  /** A controlled provider discovery is updating this exact snapshot. */
  refreshing?: boolean;
  steering: boolean;
  persistentSessions: boolean;
  sessionId?: string;
  selectedModel?: string;
  model?: string;
  catalogVersion?: string;
  commands: import("../adapter.js").EngineCommand[];
  mcpServers: import("../adapter.js").EngineMcpServer[];
  composerCapabilities: import("../adapter.js").EngineComposerCapability[];
}

export interface ProjectEngineModelCatalogDto {
  projectId: string;
  engineId: string;
  models: EngineModelOption[];
  cliVersion: string;
  configurationKey: string;
  fetchedAt: string;
  /** True only while a stale cached snapshot is being refreshed in the background. */
  refreshing?: boolean;
  error?: string;
}

export type EngineModelValidationDto =
  | { valid: true; model: EngineModelOption }
  | { valid: false; errorCode: EngineModelValidationError; error: string };
