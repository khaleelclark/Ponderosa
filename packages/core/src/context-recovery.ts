/** Managed compaction restores measurable context; it never resolves unknown prior effects. */
export type ProviderContextRecoverySupport = {
  status: "unsupported";
  missingOperation: "structured_retained_session_compaction";
} | { status: "managed_compaction"; crashReconciliation: "hold_without_native_query" };

export interface ProviderContextRecoveryProgress {
  phase: "reserved" | "drained" | "native_started" | "context_accepted" | "held";
  updatedAt: string;
  usedTokens?: number;
  windowTokens?: number;
  message?: string;
  /** Unknown source work is never automatically replayed by context recovery. */
  sourceWork: "held_unknown";
  nativeInvoked?: boolean;
  /** A completed native operation is distinct from unavailable fresh telemetry. */
  nativeOutcome?: "completed" | "failed" | "outcome_unknown";
  maintenanceAttempts?: number;
  nextMaintenanceAt?: string;
  automaticMaintenance?: true;
  contextUsageEventSequence?: number;
}
export const UNSUPPORTED_PROVIDER_CONTEXT_RECOVERY: Readonly<ProviderContextRecoverySupport> = Object.freeze({
  status: "unsupported",
  missingOperation: "structured_retained_session_compaction",
});
export class ProviderContextRecoveryUnavailableError extends Error {
  readonly code = "provider_context_recovery_unsupported";
  constructor() {
    super("No recovery operation is mapped for this exact uncertain native boundary. Context and uncertain prior effects were retained; no recovery turn was sent. New work is held until this request is dismissed; the original context guard then remains.");
  }
}
export interface ProviderContextRecoveryRequest {
  id: string;
  agentId: string;
  projectId: string;
  sourceRunId: string;
  scopeKey: string;
  providerSessionId: string;
  toolContractHash: string;
  sourceFence: number;
  state: "unsupported_fenced" | "dismissed";
  code: "provider_context_recovery_unsupported" | "provider_context_recovery_source_work_held";
  createdAt: string;
  dismissedAt?: string;
  progress?: ProviderContextRecoveryProgress;
}

/** Durable source custody, not proof of native completion or absence of effects. */
export interface ProviderContextRecoveryEvidence {
  sourceRunId: string;
  sourceRunStatus: string;
  providerSessionId: string;
  currentSessionMatches: boolean;
  providerInput: { available: boolean; promptHash?: string; systemPromptHash?: string };
  lastDurableAgentEvent?: { sequence: number; at: string };
  attachedRequestIds: string[];
  nativeTailCompleteness: "unknown";
  priorEffects: "unknown";
  historyDisposition: "retained";
}

export interface ProviderContextRecoveryStatus {
  support: ProviderContextRecoverySupport;
  boundary: Pick<ProviderContextRecoveryRequest, "providerSessionId" | "sourceRunId" | "toolContractHash" | "sourceFence"> | null;
  request: ProviderContextRecoveryRequest | null;
  sourceEvidence?: ProviderContextRecoveryEvidence;
  /** A durable phase alone does not prove a native operation is still running. */
  operationState?: "running" | "cleanup_pending" | "idle";
  engineId?: string;
  blocker?: {kind:"authentication"|"access_changed"|"context_unavailable";message:string};
}
