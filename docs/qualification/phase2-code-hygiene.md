# Phase 2 code hygiene

Fresh scheduler Runs and steering use the same provider-facing activation projection in
`packages/agents/src/coordination-v3-provider-failure-projection.ts`. It preserves
identity, dispatch policy, priority, prompt class, payload projection and delivery
failure fields. Provider-error sanitization and malformed-payload disclosure keep
their existing behavior. Required-reply registration continues to use its smaller
identity/kind/payload contract.

The unused `mkdirSyncSafe` export in `asset-contracts.ts` was removed after a full
tracked-source reference search found no caller. Store startup remains owned by
the existing server startup path; this cleanup adds no filesystem action.

`tests/agents/activation-projection.test.mjs` covers the shared projection contract.
This is a bounded cleanup of named findings, not a whole-repository dead-code or
near-duplicate acceptance verdict. Full commandment 9 still requires the scan and
independent review of retained similar code.
