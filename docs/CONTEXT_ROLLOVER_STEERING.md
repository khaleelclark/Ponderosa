# Steering across context refresh

A requested refresh does not block steering into its original, still-running
source Run. Ordinary scope checks, provider acknowledgement, exact Run fences,
source validation and explicit Queue choice still apply. The separate handoff
Run remains isolated: it cannot receive task steering into its output contract.

The pressure-time canonical boundary is provisional. Before submitting the
handoff Run, the runtime rebinds the boundary in one SQLite transaction, requiring
the exact leased handoff and fence, a completed matching source Run, and no
unresolved source injection. It captures all acknowledged attached source Activations and
canonical communications, using the existing authority/revision/hash/size binder
and accepted provider-session input set. Inputs queued for later Runs and other
Agents' private input are excluded. A failed binder rolls back the whole update.

The replacement uses this final bounded hash-bound tail and inherits all captured
Activation sources, including Request lineage and required-reply routes. Late
sources invalidate the earlier visible-response shortcut; their outstanding
reply obligations remain authoritative even if an earlier peer Request ended.
The handoff stays non-authoritative context and cannot create a reply route.
Messages arriving after the source boundary wait for their own later Run.

Repeated pressure from the same live source retains one requested refresh rather
than replacing its provisional snapshot or starting another cycle. Cancellation
and uncertain delivery retain existing fail-closed lifecycle behavior. A known
provider refusal restores the acknowledged turn state only when no unsettled
injection remains; that refused input stays queued and is excluded from the
handoff snapshot.

Inspect `context_rollovers`, scheduler Run/Activation and injection records,
canonical delivery receipts, and the exact replacement provider input/source
manifest for evidence. The controlled regression is
`tests/context-recovery/steering-refresh.test.mjs`; existing pressure, workflow and
receipt regressions cover the surrounding lifecycle. This verifies local DEV
behavior, not the exact source or timeline of a previously observed deployment.
