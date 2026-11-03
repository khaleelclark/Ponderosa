# Durable local-memory scope provisioning

The host creates a new durable Chat's memory and log collections only from a
receipt inserted in the same canonical transaction as that Chat. Initial global
and already-existing durable Chat scopes receive matching planned receipts in
the transaction that binds the first policy, before any remote collection is
created. Inactive Chats remain planned until exact active ownership is proven. An
existing same-name collection is refused, not adopted as fresh. Each
receipt binds the scope and Project, data generation, memory principal, storage
binding, and a random operation identity. Each collection advances separately from
planned to submitted before the external create, then to confirmed after the
exact collection and its creation metadata are observed. A planned step can be
started after restart; a submitted step is never repeated if its collection is
missing. A matching collection observation does not clear an independent
unknown source-mutation hold or prove that an external writer drained.

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
