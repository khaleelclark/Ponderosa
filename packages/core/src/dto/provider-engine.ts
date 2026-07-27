import type { EngineId, EffortOption, EngineModelOption, EngineModelValidationError, ModelOption } from "../adapter.js";
import type { TokenUsage } from "../events.js";

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
  triggerOccurrenceIds?: string[];
  communicationEventIds: string[];
  artifactIds: string[];
  conversationId?: string;
  providerSessionDisposition: "fresh_task" | "continued_session" | "reseeded";
  sources: Array<{
    kind: "identity" | "history_message" | "activation" | "trigger_occurrence" | "communication" | "artifact" | "team_directory";
    ref: string;
    /** Submitted sources contribute to exactPrompt; retained sources do not. */
    delivery: "submitted" | "retained_session";
    hash?: string;
    createdAt?: string;
  }>;
}

export interface ProviderInputSourceManifestV3 {
  schemaVersion: 3;
  /** History messages represented in the exact text submitted for this Run. */
  historyMessageCount: number;
  /** Sources known to remain only in the continued provider session. */
  retainedSessionSourceCount: number;
  activationIds: string[];
  triggerOccurrenceIds?: string[];
  communicationEventIds: string[];
  artifactIds: string[];
  conversationId?: string;
  providerSessionDisposition: "fresh_task" | "continued_session" | "reseeded";
  sources: Array<{
    kind: "policy" | "identity" | "history_message" | "activation" | "trigger_occurrence" | "communication" | "artifact" | "team_directory" | "context_reference" | "continuation_handoff";
    ref: string;
    /** Submitted sources contribute to exactPrompt; retained sources do not. */
    delivery: "submitted" | "retained_session";
    hash?: string;
    createdAt?: string;
  }>;
}

/** Earlier manifests remain readable for historical Runs; new Runs use V3. */
export type ProviderInputSourceManifest = ProviderInputSourceManifestV1 | ProviderInputSourceManifestV2 | ProviderInputSourceManifestV3;

export interface ProviderInputDto {
  executionId: string;
  schedulerRunId: string;
  promptHash: string;
  sourceManifest: ProviderInputSourceManifest;
  exactPrompt?: string;
  createdAt: string;
  updatedAt: string;
}

export type TokenUsageScope = "overall" | "project" | "agent";

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

/** One provider's current quota-cache projection. A failed refresh retains the
 * last successful reading and reports the error alongside it. */
export interface ProviderUsageStateDto {
  provider: EngineId;
  displayName: string;
  authenticated: boolean;
  reading?: import("../adapter.js").ProviderUsage;
  refreshing: boolean;
  error?: string;
}

export interface ProviderUsageCenterDto {
  providers: ProviderUsageStateDto[];
}

// ─── Engines ─────────────────────────────────────────────────────────────────

/** GET /api/engines entry — an engine, its options, and live auth status. */
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
  /** The adapter is configured on this Ponderosa host. */
  configured: true;
  /** Global operator switch. Disabled engines retain queued work but cannot lease it. */
  enabled?: boolean;
  /** Subscription credentials are present; this does not prove entitlement. */
  authenticated: boolean;
  authDetail?: string;
  /** Real provider work is allowed to run. */
  available: boolean;
  /** Positive/negative provider evidence behind `available`. */
  availabilityDetail?: string;
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
