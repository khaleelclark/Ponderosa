# Live native import finalization

Native imports keep canonical Shared and Separate rows unavailable while their
complete physical graph is being established. One shared native metadata scope
covers top-level repositories and modules. The recovery engine writes only when
the service owns this deferred scope; it does not finalize or publish completion.

The service prepares and verifies readable aliases, creates local managed branch
ownership, then takes custody-bound readable snapshots. Ordinary and extended
working metadata stages once through the caller hook. The shared one-shot native
finalizer rechecks bytes and aliases through exact file identities, applies chosen
attributes and native mode/nanosecond timestamps on the same descriptors, and
publishes actual final readbacks. Snapshot normalization accepts only matching
inode/hash/complete-link-count results. Readiness and completed receipts follow
this barrier. Failure retains roots, keeps canonical owners unavailable, and marks
receipts incomplete without replaying branch or filesystem actions.

A mode000 result can use its readable seal plus the immediately controlled native
readback for this initial fenced import. A later snapshot always opens and hashes
current bytes or fails closed on access/identity errors. Parent identity or a
cached checksum never substitutes for inaccessible descendant bytes. Root-level
native metadata is recorded without recursively treating ordinary working files
as Git metadata.

Negative dependency evidence is checked through issued directory ancestry at the
start and end of sealing. A later file, parent symlink or unissued replacement
invalidates that evidence without following it outside the chosen roots.

Generated `active-git-hooks` views have an exact compiled name/target graph and
issued parent custody. The readable seal records the complete local namespace and
link identities. After final metadata readback, the service asks the canonical
store to issue evidence for every current selected Agent sharing that root. The
store independently binds the current import operation, source-original hash and
current root ownership. Portable receipts never supply this authority; unknown
namespace entries are retained and refused. Unowned recovery folders do not gain
an Agent ownership record.

Regression source covers negative evidence changes/parent symlinks, final mode000
normalization with a retained-fd mutation, and exact generated namespace views
with unknown-entry refusal. These changes have not run tests/builds/typechecks;
combined validation remains with the integrated candidate.
