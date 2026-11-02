# Bounded source repair for validation base 632f993

Base: `632f993e5564c50ab3168d0cead0030aa0916204`. This successor does not include the separate moving foreign-tree continuation tranche.

The supplied focused run reported 17 tests, 8 passing and 9 failing. This source repair has not been executed.

- Standalone template publication used an undefined `keys` variable instead of its local `targetKeys`; fix the actual publication loop.
- Tree publication/readback succeeded before reopening. Projection rebuild then recreated Chat ownership from pre-publication staging metadata. Resolve active installed Chat ownership from durable SQLite installation resources and imported owner references during rebuild. Reject ambiguous Branch/execution ownership. Publication remains one transaction; no filesystem metadata write is introduced into it. The existing caller fixture now asserts each mapped Chat ownership immediately after reopening, before HTTP readback.
- Repair only the reported in-slice TypeScript inference/non-null/unused-parameter diagnostics. No whole-build success is claimed.
- The four standalone continuation failures remain unresolved: the latest imported frontier is classified evidence-only before review. Eligibility is unchanged. Import receipts now retain the exact failing category (effects/unknown state, secret reentry, definition mismatch, or shared frontier codec), review propagates that reason, and the deferred happy-path fixture asserts recreated-held disposition directly after import. The manager-owned targeted rerun is needed to identify which source condition fails; this patch does not claim those four failures repaired.

No tests, checks, builds, typechecks, Node/native/provider execution, installs, migrations, browser/web writes, push or deployment were performed. Other supplied whole-build diagnostics remain outstanding. Unknown effects/custody still refuse before fresh acceptance.
