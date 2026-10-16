# Memory storage foundation (separate future feature track)

This is the canonical storage foundation for the separate memory feature track.
The opt-in development host layer is documented in [memory-host-authority.md](memory-host-authority.md).
Memory remains disabled by default; no startup brief, management UI, automatic
extraction or semantic worker exists. FAST0.2 prioritizes Branches; this partial
feature has no integration or release approval. Semantic recall via a future
Local Memory MCP adaptation remains intended; FTS is not a substitute. Installing the additive
schema preserves data independently of any future feature flag.

## Canonical contract

`packages/core/src/dto/memory.ts` contains shared data contracts.
`packages/agents/src/memory-store.ts` owns explicit save/update/forget, scoped
get/list/search/history, candidate hydration and scope generation reads.
`0032_memory_foundation.sql` registers through the existing transactional
extension mechanism. SQLite records/revisions are authoritative. Ownership is
immutable: Project ID or opaque trusted global principal ID; no Chat memory
scope. Corrections append revisions with `priorRevision`; promotion is not
implemented and must create a distinct record after visibility approval.

All mutations use immediate SQLite transactions. A command key is namespaced
by scope, owner and author kind/ID. Normalized payload hashes detect changed
retries. Receipts contain only IDs, operation, revision and generation; retries
return the original receipt, even after later correction/expiry/forget, only
with current write authority and a still-owned record. They do not return old
text or reactivate anything. Changes of Run attribution do not change an
otherwise identical retry; the original revision retains its original author.
Corrections/forget require expected current revision. Forgotten corrections
cannot reactivate a record. An expired record is suppressed; it may still be
forgotten explicitly. Normal get/history/list/search never reveal forgotten
text, and history omits expired revisions.

Text uses canonical newline/NFC normalization, a 10,000-code-point ceiling and
no NUL. Source lists contain at most 20 canonical communication/artifact
references with exact revision/hash; references confer no access. Search quotes
at most 32 lexical terms and caps results at 100. Candidate hydration caps 100
inputs, rejects superseded revision/generation and rechecks current ownership,
expiry and tombstones. Scope generation changes on save/correction/forget/purge;
this is a future cache/session invalidation input, not current provider erasure.

`rebuildMemoryLexicalIndex` is internal maintenance that rebuilds only current,
active, unexpired, non-tombstoned records in live Projects from SQLite. It does
not infer permissions from the index or mutate canonical data.

FTS replacement, canonical changes, receipt and durable index intent commit
atomically. FTS failure rolls back the whole command: no saved-but-pending FTS
success exists. Direct reads require no index/worker after a committed save.
The small `memory_index_intents` table persists desired upsert/removal revision
and generation together with each command. There is no semantic index yet, so
no semantic indexed/pending UI state, leases, dispatcher or acknowledgments.
A future consumer must use immutable memory:revision:generation vector IDs,
reject stale intents against current canonical state/tombstones, hydrate live,
and never let a late remove/upsert overwrite a newer generation. This contract
is independent of the semantic-versus-keyword product decision. Intent retention
and compaction will be defined with an actual consumer.

## Foundation host port

`MemoryStore` takes a synchronous `resolve()` port returning
`TrustedMemoryContext`, refreshed for each operation. Content reads and writes
resolve it inside their SQLite transaction.
It is an internal library interface, never a DTO/tool/request schema. The disabled
host layer now derives Agent/Project/Run identity, operations and grants from live
host state, with same-connection scheduler fences, inherited capability policy,
product/installation lifecycle and conservative source authority. Its dedicated
checks are separate from the foundation fixtures. It must not trust caller-supplied
IDs or derive a principal from displayName, proxy headers or token hashes.
Foundation fixtures demonstrate filtering for supplied trusted principals;
they do not prove real operator authentication, multi-operator tenancy,
permission-revocation wiring, Run fences or provider session invalidation.

The existing daemon has a single local operator profile and no durable
multi-operator identity/membership binding. Global access is installation-scoped,
explicitly operator-controlled and refused
on ambiguous/unprotected configurations. It does not implement private per-person
tenancy. Ordinary Agents cannot mutate global memory. Temporary Branch Projects
reject durable saves and grants until a durable target is bound; no implicit
inheritance or target mapping exists.
Communication authority remains unchanged despite absence of Chat memory scope.

`maySaveSource` must validate the source revision/hash, classification and
whether sharing text expands the source audience. It must deny private
DM/collaboration/artifact/global copying into broader Project memory without
explicit approved declassification. Agents cannot label unsourced text as a
user statement; sourced user statements require host verification. Operators
can explicitly author user statements. `mayReadSource` filters links separately
on every read/history/search; memory access does not expand source permissions.
These callbacks are mandatory, with no permissive defaults. Current host saves
reject structured source-backed capture because no exact audience-expansion
Decision port is bound; see the host contract for link-read validation and limits.
Unsourced Agent
inferences remain possible by explicit save; this is not general prevention of
models paraphrasing private content. Memory text is inert sourced data, never
host authority; no memory content changes permissions or routing.

## Deletion, restore and operations

Pending or receipted Project deletion suppresses reads/writes immediately.
Existing Project deletion invokes `purgeProjectMemories` within its purge
transaction, even with the future feature disabled: Project text, revisions,
receipts and FTS rows are removed; minimal generation/tombstone/removal intents
survive. Other Projects and global records remain intact. Forget keeps revision
text internally for a future explicit retention/erasure policy, but suppresses
it from all normal library reads. Forget is not permanent erasure; raw database,
provider audit inputs and backups may retain text.

A retained tombstone defeats restored active records and stale candidates.
Restoring an old canonical SQLite database also loses newer tombstones: a
complete retained newer deletion ledger is required before enabling retrieval.
There is no restore API or completeness gate implemented here. An index rebuild
alone cannot fix missing deletion history. Source folder deletion is unchanged.

No dependencies or upstream source were added. Offline canonical storage uses
existing better-sqlite3/FTS5. A later semantic worker outage must not lose committed
writes or block ordinary Runs; this foundation has no worker or Run path to test.

## Verification and next gate

Build existing dependency-order core/native-host/agents packages, then run:

```sh
node --test packages/agents/test/memory-store.test.mjs packages/agents/test/project-deletion-storage.test.mjs
```

Use only disposable fixture roots. Checks cover trusted scope isolation,
revocation seam, replay conflicts/reopen, CAS, transaction/process rollback,
expiry/generations/forget/stale hydration, source policy and Project deletion,
and additive migration/reopen. A read-only exact-head reviewer should attack
all ID/receipt/history paths, classification/source expansion, rollback and
Project purge, then qualify host identity/grants/fences in the next layer.
Startup/cross-provider workflow, semantic usefulness/latency, token budget,
indexing delay, UI and old-backup restore remain unimplemented/unmeasured.
