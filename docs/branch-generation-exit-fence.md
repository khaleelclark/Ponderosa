# Permanent original-generation Runtime fence

Source-only prerequisite for Branch's precleanup generation-exit producer. Historical partition admission remains disabled. No tests or execution checks have run.

The Branch producer owns its `resource-generation-exit:<stepId>:<generation>` journal, generation/frontier/host/custody/exit proof, package capture, drain wiring and cleanup readiness. The Runtime fence is a separate immutable canonical identity record, because Branch owner deletion removes `branch_commands`. It lives in existing `host_lifecycle_commits`, kind `branch-generation-exit-fence`, without source foreign keys or a release operation. It survives all journal phases, journal removal, resource generation replacement, and Branch/Chat/Agent deletion.

Call the exported `@ponderosa/agents` API inside the **same Branch owner transaction** that writes the initial fencing journal:

```ts
const fence = fenceBranchGenerationExit(db, {
  executionId,
  stepExecutionId,
  generation,
  projectId,
  conversationId, // original resource Chat
  agentIds,       // complete original live Chat/resource membership
}); // {identity, sha256}
```

The function refuses outside an owner transaction. First publication validates the actual retry-draining, nonretired resource generation, resource Step/execution/Branch/Project/Chat ownership and complete matching resource/live Chat members. It stores immutable input plus original resource/member rows. Receipt identity hashes execution/Step/generation; SHA-256 binds all retained bytes. Caught owner rollback removes the fence with the journal. Exact replay verifies retained canonical bytes and input before returning the same receipt, including after owner removal. Changed original identities conflict. Replay proves the permanent fence only; it does not authorize capture of a new or changed generation.

Branch must write the fence before committing its first journal, and retain its returned identity/hash in the journal and final capture evidence. `fencing`, `capturing`, `sealed`, errors and retries never release it. A bare journal is not a fence. No phase/flag is interpreted as permission. A lost/unwritten journal does not remove a committed fence.

`generationExitHeld(db, agentId?, conversationId?)` recognizes every original member by retained identity, every original Chat by retained identity, and a member's actual current owning Chat. Moving/deleting Agent rows cannot remove the retained-ID hold. New identities currently attached to the original Chat are also held. `requireGenerationExitOpen` is the shared throwing intake guard.

The exact Runtime hooks are:

- Store support `requireAgent` and `requireConversation` reject new ordinary coordination intake for original identities.
- Runtime communication/scope authorization rejects current dispatch to/from original identities. Historical evidence validation that explicitly disables current authorization remains read-only.
- Activation factory rejects external intake for original Agent/Chat scopes. Trusted internal terminal/cancellation closure may still record canonical continuations; this is necessary to finish draining the original graph. Such activations remain unavailable to the scheduler and are settled/canceled by existing canonical lifecycle logic.
- Scheduler lease candidate SQL independently excludes original Agent IDs, original conversation scopes and current members of the original Chat, before any new Run may be created. Shared recipient authorization also prevents activation consumers from treating those scopes as runnable.

The fence deliberately leaves `destinationAdmissionHeld`, product source ownership, `agentCreationPending` and source package visibility unchanged. Those APIs also authorize actual checkpoint package capture; broadening them to this permanent source fence would block the producer's own required precleanup package read. Existing Branch `retry_draining` owns descendant creation/cleanup readiness; canonical Runtime intake and lease authorization enforce execution refusal. No package capture checks are weakened and no prepared-destination capability is fabricated.

Branch must independently cancel/drain already leased Runs and actual provider/native handles, settle Requests/Joins/effects and hold generation/member/frontier changes while capturing. A fence is not an observed-exit receipt or a completed drain. A process may have been spawned by a previously leased Run before cancellation completes; actual observed-exit evidence and same-owner seal-time revalidation remain required. Store/product visibility is not permission to run a fenced identity.

The deferred fixtures in `tests/branches/generation-exit-fence.test.mjs` cover canonical incoming coordination refusal, actual public scheduler lease refusal, unrelated work, trusted terminal closure, preserving source package access, caught owner rollback, stale identities, immutable replay and simulated owner/journal deletion. They use canonical Runtime state with synthetic Branch resource rows; they are not qualification of the real precleanup producer, package capture, provider/native drain or historical admission.

## Canonical deletion boundary

Deletion independently requires a real sealed generation capture. Missing journals, fencing/capturing phases, mismatched immutable intakeFence receipt (also required in the envelope), changed identity/envelope/source, missing or changed selected snapshot/custody receipt, and invalid retained provider/native/host evidence refuse. A bare sealed flag cannot authorize deletion. The guard reads retained identity rows, including Chat and Project scope, so Agent movement or partial subtree selection does not evade it.

Agent subtree preview checks every affected member before filesystem staging, with repeated checks in the deletion-pending and canonical commit transactions. Chat pending intent and storage staging check before filesystem work and canonical commit checks again. Project pending intent checks all retained Project fences before storage staging and commit checks again before cascade. A valid seal permits ordinary proven deletion; it never releases intake or lease holds. Missing evidence after Branch owner/journal removal conservatively holds later deletion; no cleanup authority is reconstructed from absence.

Source-only deferred refusal fixtures cover missing/pending/forged sealed evidence through public subtree, Chat and Project deletion APIs. They do not qualify successful producer sealing or actual filesystem/provider cleanup; no checks were executed.
