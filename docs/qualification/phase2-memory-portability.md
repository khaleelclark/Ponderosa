# Product memory package transport and remaining work

Full Agent and organization exports now include a `memory` section when local
memory is configured. It carries one versioned Chat snapshot and an explicit
source-Agent-ID to package-Agent-ref map. Templates omit it. The source Chat's
team audience and only included Agents' private audiences are selected, including
deprecated lineage and conflict history. Free memory text is user data; the
existing sensitive-data export warning remains required.

Fresh Branch workflow installation uses the same Agent package parser and import
engine. Export retains team memory only in the first Agent package for each Chat;
subsequent packages contain their private audience. Logical Branch refs are
mapped separately from the snapshot's historical source IDs. Re-export uses the
current canonical destination memory; it does not replay an old snapshot.

The shared core DTOs describe `PortableChatMemorySnapshotDto`, source stamps,
rows and bindings. The existing bounded JSON codec and total package byte counter
include the entire section. Snapshots enforce 16 MiB serialized UTF-8 and 10,000
selected rows, supported schema/signature, well-formed Unicode, actual finite
384-vectors, complete acyclic same-audience lineage and conflict references.
Branch envelopes also pass the shared whole-package byte counter. Foreign or
unclassified source rows fail explicitly. Cross-Chat Agent/organization snapshots
are refused rather than merged into one destination Chat and silently broadening
their team audiences; export separate packages to separate Chats instead.

Structured metadata and provenance reuse `portable-secrets.ts`. Export removes
known generic/provider credential fields through nested object/array and JSON
string layers; import rejects such fields before mutation. Free user memory text
is outside that policy and can contain sensitive information. Historical
`SourceStamp.fenceToken` remains allowed. The two separately reviewed secret-policy
commits are prerequisites, not a claim of independent approval.

## Authority and lifetime

`LocalMemoryService` remains the only host entry point. Package calls use the
existing `AuthorityStorage`, not a second memory database. Destination principal,
Chat and private Agent audiences are explicitly rebound. Original source stamps
remain inert `package_source_stamp` metadata and lineage origins remain historical.
No grants, policy databases, installation bindings, provider credentials, profiles,
Run capabilities or scheduler work are imported. Destination memory restrictions
and global-read settings stay authoritative. Chroma stores vectors as float32;
values exported from Chroma survive exactly.

The product path requires the exact canonical `preparing` import operation,
Chat/project ownership and reserved Agent membership. It admits that operation's
pending Agents without changing normal active-Agent predicates. A staged Branch
Chat additionally requires the matching applying installation plan and exact
Agent resource bindings. Cancellation, deletion, shutdown and membership changes
are checked during storage calls.

Before the first memory mutation, SQLite's existing creation-operation `result`
records `phase: prepared_memory` and the exact destination namespace/row IDs.
There is no schema migration or new import journal. Deterministic IDs permit
identical retries and refuse differing existing data. Rows carry an internal
`host_package_operation` marker; normal reads and exports cannot see them until
the SQLite operation completes. Branch rows additionally wait for their owning
installation plan to complete. This is visibility gating, not a new grant.

On failure, the import enters `rolling_back` and cleans only its journaled IDs,
checking the destination principal, Chat and exact operation marker. It then
removes its existing Agent/artifact plan through normal rollback. A cleanup
failure retains the memory plan and quarantine. Startup retries memory cleanup
before ordinary creation recovery can release that quarantine. Missing memory
configuration remains an explicit pending-cleanup error; restore configuration
and restart to retry. Successful completion atomically replaces the temporary
plan with the ordinary import result. Imported history never creates Runs,
activations or provider outbox work.

## Verified scope

After the dependency-order build, run the bounded regression command recorded in
the evidence report. Product tests use the actual Agent export/import and Branch
installation/export HTTP APIs, separate fresh private canonical stores/policies
and Chroma prefixes, an owned Chroma process and pinned existing local models.
They verify semantic text/vector/deprecation equality, remapped lineage/conflicts,
private/team queries, denied scopes and unchanged global grants, replay, reopen,
re-export, encoded-secret export exclusion/import refusal, malformed/oversized
payload refusal and unconfigured-destination refusal. A separate writer process
is SIGKILLed immediately after its first real package memory write; the next
server startup removes the namespace and pending Agent, then the exact import
can retry. An explicit incomplete-cleanup fixture proves the journal remains
pending and hidden until recovery succeeds. Providers are inert and never run.

## Explicit incomplete paths

Memory-bearing updates to an existing Branch workflow are refused before
installation planning. The next slice must journal additive memory changes for
new Agents and preserved active Chats, keep them hidden until the entire update
commits, and compensate exact namespaces on cancellation/review-required paths.
Existing active Agents' current memory must not be overwritten by incoming
history; the preview must state which incoming data is applied or preserved.
The refusal is a temporary data-integrity boundary, not an access policy.

Installation-global memory is explicitly listed in each snapshot's
`excludedScopes: ["global"]`; it is not silently swept or demoted to Chat scope.
No UI or API for selected global transport is implemented in this batch. Required
follow-up: add an explicit human global-memory selection to export, show ancestor
and conflict closure before confirmation, and carry a separately versioned global
section. Import must offer a separate human action to install those selected
facts as global data, use new namespace IDs/principal provenance and the same
durable visibility/rollback plan, and preserve the destination's existing
readGlobal grants. Required but disabled access must appear in installation
results, with no automatic permission change. Tests must cover global selection,
recall only under destination grants, cancellation and crash recovery without
affecting unrelated global rows. Keep global data unimplemented until that
product path exists.

Multi-Chat organization recreation, provider-native transcripts, exact provider
inputs, historical Branch execution Chats and full workflow equality remain open.
No whole-suite, integrated upgrade, 20-run streak or full portability (#8) verdict
is claimed by this batch.

Chunk and conflict vectors that become all zero or nonfinite in float32 are rejected before writes (B1).
