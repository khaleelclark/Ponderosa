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
    super("The native harness has no unchanged-contract, no-effects recovery operation. Context and uncertain prior effects were retained; no recovery turn was sent. New work is held until this request is dismissed; the original context guard then remains.");
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
