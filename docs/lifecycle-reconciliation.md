# Operator lifecycle reconciliation

All endpoints inherit the existing origin and operator request boundary. Agent capability tokens are refused. These operations neither replay unknown effects nor turn retained historical Communication into a fresh result. No execution qualification has run.

## Retained package evidence

`GET /api/lifecycle/checkpoint-custody` lists retained custody identities (bounded to 1000).
`GET /api/lifecycle/checkpoint-custody/:id` returns `CheckpointCustodyLifecycleEntry`: current state, source membership where available, canonical reference surfaces, drain blockers, exact file names/lengths/SHA256 and a review digest. File bodies never enter the response.

`POST /api/lifecycle/checkpoint-custody/:id/reconcile` accepts `{commandKey,reviewSha256,preserveEvidence:true}`. Admission runs in the canonical IMMEDIATE transaction and existing package admission queue. Every current Branch/coordination JSON receipt/reference is conservatively searched; references are never removed to make a review pass. Source executions must be terminal or absent, provider/scheduler authority and unresolved creation custody drained, and the process-wide writer/capture registry idle. Changed proof, bytes, source state or key refuses. The operation records a durable manifest and tombstone, then moves owned regular files to private `checkpoint-package-custody/reconciled/:id`. Every original byte is preserved. Interrupted moves resume with the same exact command, checking the retained manifest and refusing unexpected bytes. A reconciled capture identity cannot be captured, read or admitted again.

This reclaims the active namespace, not disk bytes. It does not unlink user originals or last surviving private package evidence. Symlinks, hardlinks, special files, oversized inventories and unrecognized changed bytes refuse. Referenced historical packages, admitted destinations and unresolved import pins remain retained until their canonical owner performs its own retirement protocol. No row is deleted to bypass a RESTRICT constraint.

## Failed remote memory effects

Future remote writes record exact collection scope, memory/conflict collection and operation in their existing durable unsettled hold. This describes the failed call; it is never replayed. Reads remain read-only.

`GET /api/local-memory/mutation-holds` lists current hold identities/digests and effect metadata.
`GET /api/local-memory/mutation-holds/:id` returns `MemoryMutationReviewDto`: hold digest, bounded backend readback digest/count, required operator drain evidence and a review digest. Two consecutive readbacks must agree while all registered host writers are drained. The existing memory authority exclusively serializes these reads. Backend rows and vectors stay private.

`POST /api/local-memory/mutation-holds/:id/reconcile` accepts `{commandKey,reviewSha256,backendDrainEvidence,preserveCurrentBackend:true}`. The local operator must FIRST stop or independently reconcile remote work and describe the observed backend drain. A text field is operator testimony, not a fabricated server result-query proof. Stable reads alone cannot prove that an unobserved remote worker will never write later. The endpoint re-observes current backend state, requires the exact review and no intervening host writer/capture, then durably retains the complete observed collection bytes, original hold and immutable local-operator decision before retiring that one hold and registry uncertainty reason. It never modifies backend memory, provenance, grants or unrelated holds. Same-command readback resumes interrupted hold retirement; changed input or missing/corrupt retained evidence refuses.

Legacy holds have no exact effect metadata and return `canReconcile:false`; they remain held. No timestamp, process restart, guessed scope or broad clear operation releases them. External backend result-query/reconciliation is still required for cases the operator cannot settle. The operation accepts the preserved current backend state as the new human-reviewed baseline, not a claim about whether the original write succeeded.

## Background package import ownership

`GET /api/lifecycle/agent-imports/:id` reads retained operation evidence even when its original Chat owner is deleted. It returns `AgentImportLifecycleReview`, including the exact canonical creation receipt identity, blockers, mutation-free disposition and review digest. `POST /api/lifecycle/agent-imports/:id/reconcile` accepts `{commandKey,reviewSha256,action,note}`. `preserve_unresolved` durably holds the existing operation without rewriting an unknown effect as a failure or replaying it. `retire_mutation_free` is admitted only with no committed import, no Agent/artifact/result effects, a still-preparing or absent canonical creation operation, and no canonical owner/admission reference. It marks only that proved-empty operation rolled back, durably holds its submission identity and completes the background journal as failed. Actual created/reserved identities and admission pins cannot take this path.

Every background retry checks the durable lifecycle hold before reading/importing payloads; synchronous reuse of the same admitted submission also refuses. Exact-command readback finishes an interrupted mutation-free journal transition. The original payload remains preserved. Startup now moves abandoned regular upload/copy/temp payloads to private `agent-import-operations/retained-orphans` instead of unlinking them; their bytes continue to count against staging admission capacity. `GET /api/lifecycle/agent-imports/orphan-evidence` lists bounded retained names/sizes without exposing source bodies. These bytes cannot be silently deleted to make room. Lifecycle hold receipts and canonical import/owner receipts remain separate evidence.

## Existing Agent regrouping disposition

Same-Chat reporting changes already use `PUT /api/agents/:id/manager` in `routes/agent-maintenance.ts`, delegating to canonical `AgentStore.updateAgentOrganization` / `store-agent-management-authority.ts`. It preserves Agent identity, history, private resources and working roots, validates active same-Project/same-Chat ancestry and refuses cycles. Branch installation likewise calls this canonical writer for explicitly bound existing Agents. No duplicate reparenting backend is needed for that independent capability.

Cross-Chat existing-Agent relocation and rebinding existing Shared working roots remain unsupported. Those operations require coordinated source/destination Chat policy, private-memory ownership/audiences, role bindings, pending Requests/Joins, provider drain and working-copy ownership transactions; changing `conversation_id` or a root path would violate current invariants. New package import continues to create fresh identities and locally owned roots. This disposition does not claim full portability/regrouping parity.

Deferred source regressions: `tests/organizations/custody-lifecycle.test.mjs` and `tests/memory/explicit-reconciliation.test.mjs`. Tests/checks/types/build/Node/native/browser/runner preparation and execution are all deferred.
