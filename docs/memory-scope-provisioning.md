# Durable local-memory scope provisioning

The host creates a new durable Chat's memory and log collections only from a
receipt inserted in the same canonical transaction as that Chat. Initial global
and already-existing durable Chat scopes receive matching planned receipts in
the transaction that binds the first policy, before any remote collection is
created. Inactive Chats remain planned until exact active ownership is proven. An
existing same-name collection is refused, not adopted as fresh. Each
receipt binds the scope and Project, data generation, memory principal, storage
binding, and a random operation identity. Each collection advances separately from
planned to submitted before the external create, then to confirmed only after
the create response returns a collection UUID and the name still resolves to
that UUID and creation metadata. Every confirmed lookup checks the recorded
UUID and token. A planned step can be started after restart; a submitted step
without a durable acknowledged UUID stays held and is never repeated or
adopted from copyable metadata, whether a same-name collection is present or
missing. Existing pre-0044 scopes have no retrospective collection UUID
witness: their metadata can still be checked, but equivalent replacement
detection cannot be reconstructed without trusted historical identity evidence.
An independent unknown source-mutation hold fences dependent scope operations
until explicit reconciliation; an observation does not clear that hold or prove
the external writer drained. An unidentified hold fences all scopes. A submitted
intent without a source-hold file remains visible through the operator
provisioning-holds endpoint and stays held without replay.

Each creation or replay checks only its exact Chat. A formerly inactive or
otherwise process-unknown Chat is not evidence of a fresh collection. Failed
setup returns the committed Chat identity and a partial-result message; no Chat,
existing collection, or unknown remote write is deleted. Temporary
execution-owned Chats do not receive durable memory scopes.

The canonical data generation also records whether local memory has never been
configured or is bound to a particular validated policy and storage. Only a
newly minted empty data directory can establish the never-configured witness.
An existing valid external policy can establish its exact binding when upgrading.
A missing policy for a bound installation is not recreated even if the persisted
configuration still permits provisioning. An older installation with neither a
witness nor its policy remains held: those facts cannot distinguish a genuine
first installation from lost policy or memory.

The current product has no independently reviewed operator decision path for
that ambiguous old first-provision case or for replacing an established memory
policy/storage binding. A safe path must let the human review the exact data
generation, existing and intended storage, preservation warning and new
destination, verify a distinct unused namespace, and retain prior binding and
unknown-write evidence. The current startup configuration alone is not renewed
consent. These cases remain explicit blockers rather than silent rebinding.

The host-binding witness also seals the selected policy directory path and its
physical directory/file identities. A copied, moved, replaced or symbolic policy
is refused before use; changing that location requires a reviewed rebind. On
upgrade, a valid unwitnessed policy can be bound at its currently selected
location, but its earlier custody cannot be independently reconstructed. Current
checks require nonzero filesystem device and inode identifiers; platforms or
filesystems that do not expose stable identifiers fail closed and need native
qualification. Checks are repeated around use, but they are not an atomic
snapshot against an independently mutating process running as the same user.

If an established collection is missing, startup records a scoped hold rather
than recreating it or blocking unrelated services. The hold is visible in
lifecycle inventory and blocks that scope and checkpoint capture. Restore the
original backend and restart to recheck the scope. Package
restore and cleanup cannot treat unexplained absence as a successful create or
deletion; a partial cleanup without an exact receipt may therefore need review.

Chat, Project and Agent memory cleanup runs under the same Ponderosa memory
queue as ordinary reads and writes. Separate memory runtimes in one process
share that queue for a Chroma origin; the existing physical data-directory
lease prevents another normal process opening the same data directory. The
configured internal namespace and compatible binding are treated as belonging
to the installation, including pre-0044 scopes that lack a historical UUID.
Every collection is checked and all rows are classified before deletion;
foreign or unclassified records and mismatched bindings are retained. Agent
deletion removes only its private sources and matching conflict records.

For a whole Chat, a collection-deletion acknowledgement is recorded durably
before its in-flight mutation hold is retired. A retry can skip only an exact
previously acknowledged collection; an unexplained absence or lost response
does not become success. Unknown remote outcomes remain held and are never
blindly replayed. If the retained Chat provisioning states, collection IDs or
installation binding cannot be verified, cleanup reports a stable provisioning
hold before looking up either collection. A nonempty but incorrect collection
ID or token is detected by the subsequent checked lookup, before deletion.
Selected Agent conflict records are removed before their source rows, so a
confirmed partial deletion remains re-checkable. A deleted
Chat whose exact installation-bound creation intent remains planned for both
collections can still finish as a no-effect operation without touching Chroma.

This coordination does not provide Chroma-side compare-and-delete or serialize
separately configured Ponderosa data directories using the same backend, URL
aliases, or direct independent clients. Those deployments need separate
qualification. Package rollback and post-write compensation are tracked
separately; this lifecycle change alone does not implement them.

Ordinary memory saves, updates, forgets and conflict operations still use
pre-read followed by non-atomic record upsert or delete. An independent backend
writer can change a same-ID record between those calls, so these operations are
not qualified for concurrent external writers. In particular, blocking a
late write alone can leave a multi-step save partly completed; the current
backend offers no proven atomic compare-and-swap or exclusion across clients.
A safe immutable-version/pointer protocol or real backend authority remains
implementation work, not an established guarantee. No existing memory content
is automatically removed to conceal this limitation.
