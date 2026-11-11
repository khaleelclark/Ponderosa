# Retained evidence discovery

Bible #12/#19: lifecycle recovery inventories never silently omit later evidence.
Checkpoint custody and orphan staging GET routes return the shared
`LifecycleDiscoveryPage` envelope (`items`, immutable inventory `revision`, optional
`nextCursor`). Request `limit=1..100` (default 50) and pass the exact returned cursor
for the next page. Cursor kind and revision bind the inventory; changed membership
or orphan metadata requires an explicit refresh. Discovery grants no reconciliation,
cleanup, eligibility, process-exit or effect proof.

The lifecycle panel shows loaded counts and whether more entries exist, with
separate Load more controls. A failed/stale page hides its prior selectable rows;
Refresh inventories starts a fresh cursor chain and clears selections. It never
replays a reconciliation action. Memory holds retain their existing separate API.

The existing 4096-entry lifecycle inventory ceiling protects synchronous revision
hashing and bounded recovery rendering. Exceeding it returns an explicit error;
no truncated successful response is returned. Original staging/custody bytes stay
untouched. Missing directories produce an empty page without creating a directory.

Deferred regression source: `tests/organizations/retained-evidence-discovery.test.mjs`
checks both inventories beyond the former 1000-entry cutoff, no byte mutation,
stale continuation, missing roots, explicit overflow and cursor scope. It was not
executed during implementation; integrated builds, tests and mounted UI validation
belong to the consolidated final phase.
