/** Recovery is not a task turn, a new Agent, or a permission change. No current
 * native adapter implements the required unchanged-contract no-effects phase. */
export interface ProviderContextRecoverySupport {
  status: "unsupported";
  missingOperation: "immutable_normal_contract_no_effects_recovery";
}
export const UNSUPPORTED_PROVIDER_CONTEXT_RECOVERY: Readonly<ProviderContextRecoverySupport> = Object.freeze({
  status: "unsupported",
  missingOperation: "immutable_normal_contract_no_effects_recovery",
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
  code: "provider_context_recovery_unsupported";
  createdAt: string;
  dismissedAt?: string;
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
