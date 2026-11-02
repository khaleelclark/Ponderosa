# Bounded source repair for validation base 632f993

Base: `632f993e5564c50ab3168d0cead0030aa0916204`. This successor does not include the separate moving foreign-tree continuation tranche.

The supplied focused run reported 17 tests, 8 passing and 9 failing. This source repair has not been executed.

- Standalone template publication used an undefined `keys` variable instead of its local `targetKeys`; fix the actual publication loop.
- Tree publication/readback succeeded before reopening. Projection rebuild then recreated Chat ownership from pre-publication staging metadata. Resolve active installed Chat ownership from durable SQLite installation resources and imported owner references during rebuild. Reject ambiguous Branch/execution ownership. Publication remains one transaction; no filesystem metadata write is introduced into it. The existing caller fixture now asserts each mapped Chat ownership immediately after reopening, before HTTP readback.
- Repair only the reported in-slice TypeScript inference/non-null/unused-parameter diagnostics. No whole-build success is claimed.
- The four standalone continuation failures remain unresolved: the latest imported frontier is classified evidence-only before review. Eligibility is unchanged. Import receipts now retain the exact failing category (effects/unknown state, secret reentry, definition mismatch, or shared frontier codec), review propagates that reason, and the deferred happy-path fixture asserts recreated-held disposition directly after import. The manager-owned targeted rerun is needed to identify which source condition fails; this patch does not claim those four failures repaired.

No tests, checks, builds, typechecks, Node/native/provider execution, installs, migrations, browser/web writes, push or deployment were performed. Other supplied whole-build diagnostics remain outstanding. Unknown effects/custody still refuse before fresh acceptance.

## Fixture lifecycle successor after the manager-owned rerun

The supplied `partial61-focused.log` reports 11 passes and 6 failures: all definition cases pass; tree happy paths reach the helper that uses an already-closed store; four standalone cases report the effects/unknown-state category before review.

Both execution caller fixtures now start servers with existing `startDrained:true`. Server readiness normally starts the canonical scheduler; the standalone source has an accepted unfinished suffix, so a live scheduler can claim it during export. Drained admission preserves manually constructed source evidence and leaves all native Script progression to the explicit inert fixture driver. Export asserts completed prefix and absence of active/unknown attempts, Request bindings, runtime outcomes, resources and actions for the supported family. The unknown-source case retains its intentional lease and refusal.

The standalone fixture exports from a separate source database, closes that source server, and imports into an empty receiving database. Original runnable source work cannot compete with the newly continued suffix during explicit receiver claims; disabling a Branch alone would not cancel already accepted source work. No source cancellation or retirement is introduced. This also exercises the retained foreign-audit seam without original owner anchors.

The tree no-dispatch helper reopens `AgentStore` after server shutdown (shutdown itself closes storage) before constructing its explicit held driver. It still enables destinations, advances/claims, verifies no admission/lease/Request for every imported owner, disables destinations, drains checkpoint writes, and reopens the drained HTTP server.

These are deferred fixture repairs only. Runtime eligibility, fresh acceptance/admission, unknown/custody refusal and publication code are unchanged in this successor. No execution validation performed here; manager-owned focused rerun remains required.
