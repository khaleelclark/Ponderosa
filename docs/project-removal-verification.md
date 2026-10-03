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

## Combined-review follow-up

The inventory pathname race was independently reproduced at the checkpoint:
replacement with a WAL database after validation could create an input-side
SHM file. Inventory now acquires a descriptor-backed private snapshot and checks
source/ancestor identity, stable file metadata and absent sidecars around copying.
Only the private copy is passed to SQLite. The default runtime audit is unchanged.

Node 24.21.0 on macOS: all 18 ownership-audit tests pass, including pathname and
ancestor replacement at descriptor closure, each SQLite sidecar, same-inode
mutation during copying, and private-staging cleanup after success/query failure.
The original race probe reproduced the defect before the fix. Focused build and
diff checks pass. This remains checkpoint evidence, not physical migration,
live-state snapshot, Linux qualification or release approval.
