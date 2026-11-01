# Common checkpoint source boundary

Runtime source successor to f446d63e exports `beginSourceCapture(...sqliteConnections)`, `assertSourceCapture(token)`, `commitSourceCapture(token, publish)`, `releaseSourceCapture(token)`, `beginSourceMutation()`, `withSourceMutation(work)`, and `touchSourceMutation()` from `@ponderosa/agents`.

This is an optimistic host cut, independent of native provider snapshots. It does not stop providers or borrow their Run authority. It covers the supplied canonical SQLite connections and participating external writers in the owning daemon process. It does not promise a snapshot of arbitrary shell edits, user working folders, native provider transcripts, or a remote memory writer bypassing the host authority.

## Capture caller contract

1. Validate current source ownership, participants, memory grants, and absence of pending deletion/import/unknown remote-write custody. Supply the actual authoritative SQLite connection(s), including any independently opened source database used by export. Do not open a long-lived SQL read transaction.
2. Call `beginSourceCapture`. It refuses an active participating writer, an unsettled remote outcome, an open transaction, or a closed database. Retain the opaque token only in this process.
3. Export the selected complete source inventory and read every referenced byte through existing validated/hash-checking read APIs. Copy bytes into independent retained storage and fsync the files and directories. The retained storage is not a live source: use dedicated staging, not a live artifact publisher that invalidates its own source cut.
4. After all source reads and retained-byte fsyncs, use `commitSourceCapture(token, () => { /* recheck current grants; insert durable receipt */ })`. It obtains an IMMEDIATE transaction on the first supplied source connection, validates the cut, then runs synchronous publication and commits. This closes the other-connection commit race between validation and receipt insertion. The callback must not return a Promise; it must not await or mutate live source before the receipt. Alternatively `assertSourceCapture` supports read-only validation, but alone does not provide atomic receipt publication against another connection. It compares bigint SQLite `total_changes`, `data_version`, `schema_version`, plus the external-write epoch and active-writer set. Thus same-connection writes (including rolled-back work), other-connection commits, schema changes, and external writes all conservatively reject. A receipt write into source SQLite must occur AFTER this assertion. It will invalidate the token, so do not reuse it to validate the already-published snapshot.
5. On refusal, discard unpublished staging and restart capture from the beginning. Never retry a mutation or treat partial bytes as an accepted snapshot. `commitSourceCapture` consumes/releases the token on success or failure; otherwise always `releaseSourceCapture` in finally. Once a durable receipt references independent immutable retained bytes, later source deletion does not revoke those bytes; retained storage retention/read/release and privacy remain the caller's responsibility.

There is no timer/expiry that silently clears active writers, no persisted token replay after restart, and no claim that a source generation alone restores historical native state. Global invalidation is deliberately conservative: unrelated supported writes can force retry. Busy sources can starve capture; the caller should return a retryable source-changed result after its bounded attempts.

## Writer hooks supplied here

- All SQLite tables reached through the supplied connections: change counters avoid a fragile per-table trigger list. Never read source records from an unlisted connection with an older transaction snapshot.
- `append-jsonl.ts`: journal append, atomic replacement, and repair invalidation. `store-filesystem.ts`: JSON persistence and pruning. Synchronous deletion/projection work cannot interleave with main-isolate capture steps; SQL changes and file invalidations reject crossing cuts.
- `managed-artifact-files.ts`: synchronous publication/removal/repair; asynchronous publication from before worker dispatch until its existing settle/exit handling finishes. Immutable leaf publication is still subject to original no-replace and byte verification rules.
- `store-agent-catalog-authority.ts`: asynchronous imported history installation spans file write, rename/fsync, and index projection. Synchronous imported history uses the existing tracked JSON persistence path.
- `assets.ts`: asynchronous stage, association recovery/association, removal, reconciliation and Chat asset purge, including their file durability/cleanup awaits. Asset authority SQL uses the shared admitted canonical database; separately opened databases must also be supplied by callers.
- Full Agent deletion commit and cleanup, Chat deletion cleanup, and Project deletion HTTP operations are tracked across awaits. Existing deletion receipts/quarantine/drain checks remain authoritative. A quiescent partially failed deletion must still fail source eligibility; this boundary is not a deletion-success proof.

## Reliability integration still required

Memory and import serializer files are Reliability-owned and are deliberately not modified in this runtime successor. They MUST use this same exported registry for every external memory mutation (put/remove/conflict/create/delete/import/rollback/purge and configuration/grant changes not already in listed SQLite), and any import filesystem installation not using the covered store helpers. Begin before the first asynchronous effect and finish only after the backend has settled. Capture/read-only memory calls must not mark themselves as writers. Source provenance/grant checks remain mandatory.

`beginSourceMutation()` returns an idempotent `finish(unknownOutcome?)`. On a timeout/lost remote result, persist the existing domain's unknown-outcome hold and pass a nonempty reason to finish; further captures are refused for this process lifetime. Restart alone is not reconciliation: the caller must also reject durable unknown holds on startup. `withSourceMutation` is only for operations whose returned promise truly settles all underlying effects; a rejected promise is not automatically proof that a remote write never happened. Do not use it around an unobserved timeout race.

The supplied runtime hooks plus a package import queue alone do NOT certify all-domain consistency until those Reliability memory/import hooks and the capture caller are integrated. The API is available for that integration; no complete checkpoint feature or passing qualification claim is made.

## Deferred regression

`tests/checkpoints/source-capture-boundary.test.mjs` covers stable cuts, release, same/other-connection writes, rollback invalidation, schema mutation, active external writers, settled failures, SQL transaction refusal, and unknown remote outcome refusal. All tests/checks/builds/types/Node/native/browser/runner execution are deferred by direction. Memory/deletion/source-retention integration regressions belong with their final combined callers.
