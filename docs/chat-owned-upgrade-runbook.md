# Chat-native upgrade runbook — staged design, not executable cutover

This checkpoint adds read-only inventory, not a Chat-native binary/layout.
There is **no supported Project-removal upgrade version yet**. Existing layout1
and verified launch schema remain in force. Do not point current AgentStore at
new folders/columns, bump the layout marker, or run a replacement-schema script.

1. Identify the approved coherent offline snapshot, old binary/revision and
   external source paths. Extend existing snapshot/qualification machinery;
   never construct AgentStore on the input or live state for inspection.
2. Inventory main SQLite, companion asset/browser authorities, every metadata/
   journal/managed-byte/profile/working-copy/draft/receipt resource. Produce a
   total evidence-backed map. Stable Chat IDs do not become old scope IDs.
3. Resolve shared browser/profile resources explicitly. Preserve the existing
   singleton workspace saved browser; migration must not copy sign-ins or
   silently broaden grants. Unknown or colliding custody blocks transformation.
4. Implement and rehearse staged file/database transforms and the durable
   journal. Validate hashes, no-follow paths, ownership and every crash boundary.
   Provider session contracts must invalidate/reseed, not resume stale tools.
5. Rehearse the exact candidate against that snapshot, preserving authority and
   immutable historical evidence. Repeat startup/migration and full-state restore
   under the exact old binary. New release gates must integrate with normal
   verification and reject incomplete or mismatched reports.
6. Only after explicit future cutover authorization: stop new leases/mutations,
   drain exact provider/browser authority, reconcile durable cleanup/receipts,
   capture a fresh coherent complete backup, re-run the exact candidate gate,
   and switch after verified commit. Do not restart the independent shared
   browser service during an ordinary app-only cutover.
7. Retain old state/binary and failed evidence. Before accepting new writes,
   rollback restores the complete original snapshot and old binary. After new
   writes, use forward repair unless the operator explicitly accepts losing
   later writes. Binary-only downgrade and lossless automatic rollback are not
   supported claims.

The target includes bounded legacy read-link resolution, neutral selection for
ambiguous bare scopes, deleted-resource rejection, and stale mutation-client
reload errors before effects. These are not implemented by this checkpoint.
Source folders and retained working copies are never deleted or relocated.
Backup/retention cleanup and live cutover each require explicit authorization.
