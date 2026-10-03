# Project removal verification

Status: **inventory/design checkpoint; full migration not qualified**.

The optional main-SQLite inventory and repository scanner have focused
regressions for read-only behavior, complete sibling IDs, table discovery,
stable schema fingerprints, single-vs-multiple cardinality, tracked-vs-untracked
source, and not misclassifying `projection`. Existing ownership findings and
default report behavior remain unchanged. Results and exact candidate are
recorded in the PR, not fabricated into a future migration report.

No active domain removal, staged schema/layout transform, real-data migration,
crash-boundary rehearsal, full-state rollback under a new layout, new Chat API,
old-client rejection or packaged qualification is claimed. The existing launch
baseline, layout marker, APIs, runtime and history are unchanged. The handoff
JSON files are explicitly unqualified format examples, not total verified maps.

Final acceptance still requires every gate in the supplied specification:
fresh first Send/retry; supported one/multi-Chat upgrades and ambiguity/collision
rejection; canonical bytes/order/hash/authority preservation; cross-Chat isolation;
runtime and browser fences/retention; restart/crash idempotency; scoped deletion;
client continuity; exact snapshot/old-binary restore; and zero active domain
references with a finite reviewed exception list. None can be waived by a text
scan, a typecheck, or the existing metadata-only audit.
