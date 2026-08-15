import type { EngineId } from "../adapter.js";
import type { TokenUsage, WorkItemStatus } from "../events.js";
import type { AgentLifecycleReason, AgentRunStatus } from "./common.js";
import type { ProviderInputSourceManifest } from "./provider-engine.js";

export interface CancelAgentRunRequest {
  /** Exact Run observed by the caller. A successor Run is never cancelled. */
  targetRunId: string;
  /** Stable across retries so a repeated stop cannot append another lifecycle event. */
  idempotencyKey: string;
}

export interface CancelAgentRunResponse {
  cancelled: boolean;
  replayed: boolean;
}

/** Structural reason one Run was activated; never inferred from message text. */
export type AgentRunWakeCause =
  | "project_request"
  | "direct_message"
  | "collaboration"
  | "coordination"
  | "trigger"
  | "decision"
  | "managed_failure";

/** One canonical execution of an Agent. */
export interface AgentRunDto {
  id: string;
  agentId: string;
  title: string;
  status: AgentRunStatus;
  reason: AgentLifecycleReason;
  engine: EngineId;
  model?: string;
  effort?: string;
  communicationEventId?: string;
  wakeCause?: AgentRunWakeCause;
  /** Provider-reported usage. Missing means the run was not metered, never zero. */
  usage?: TokenUsage;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Whole-Run activity totals, independent of the loaded telemetry window. */
  activityCounts?: {
    commands: number;
    tools: number;
    files: number;
    errors: number;
  };
  /** Hash and availability of the exact text Ponderosa submitted to the provider.
   * Bounded Agent-detail pages retain only the communication-source count; the
   * dedicated Run history surface includes the complete source manifest. */
  providerInput?: {
    promptHash: string;
    sourceCommunicationCount: number;
    sourceManifest?: ProviderInputSourceManifest;
    exactPromptAvailable: true;
  };
}

/** Optional engine-reported progress inside a Run; never a Run itself. */
export interface WorkItemDto {
  id: string;
  agentId: string;
  executionId?: string;
  title: string;
  status: WorkItemStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCoordinationV3Dto {
  availability: "running" | "runnable" | "waiting" | "idle";
  requests: Array<{
    id: string;
    direction: "outbound" | "inbound";
    counterpartyAgentId?: string;
    state: string;
    version: number;
    deadlineAt?: string;
    updatedAt: string;
  }>;
  joins: Array<{
    id: string;
    mode: "all" | "any" | "quorum";
    wakePolicy: "each_result" | "final_only";
    quorum: number;
    state: "open" | "satisfied" | "impossible" | "expired" | "cancelled";
    completed: number;
    total: number;
    deadlineAt?: string;
    updatedAt: string;
  }>;
  activations: Array<{
    id: string;
    kind: string;
    priority: number;
    state: string;
    createdAt: string;
  }>;
  activeRun?: {
    id: string;
    status: string;
    fencingToken: number;
    promptInjectionState: "not_injected" | "injecting" | "injected";
    providerContextDisposition: "fresh_task" | "continued_session" | "reseeded";
    leaseStartedAt: string;
    leaseExpiresAt: string;
  };
}
