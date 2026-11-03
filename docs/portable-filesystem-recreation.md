# Portable filesystem recreation

This is the current source contract for Bible 8, 12 and 15. Qualification belongs
to the combined candidate's final checks; source presence alone is not a True verdict.

## Selection and evidence

Full working-folder export can explicitly select user extended attributes, Linux
POSIX ACLs, FIFO metadata/recreation, or inert socket/device metadata. Capturing
attribute values requires the corresponding affirmative selection. Known secret
attribute names and recognizable secret values refuse export; arbitrary binary
metadata may still be sensitive and remains covered by the full-package warning.

The original review artifact carries filesystemMetadata: one Linux namespace
qualifier, exact selected regular-file/directory mode and nanosecond mtime,
source owner/group IDs, raw base64 user names/values, explicit access/default ACL
bytes or absence, and separately typed persistent-node evidence. Hidden namespace
absence is never claimed (allNamespacesComplete is false). Source IDs are
historical evidence. They are never destination ownership or an access grant.

The qualifier hashes the observed machine identity and user/mount namespaces.
GET /api/portable-metadata/provenance supplies the current destination qualifier
and effective owner/group IDs. A namespace change requires renewed review.

## Application

reviewedMetadataActivation is a separate current human choice, bound to the
canonical package/destination access-review hash. It names only metadata-bearing
working roots and explicitly maps source owner/group and named ACL principals.
Both complete user attributes and POSIX ACLs must be selected for the combined
native replacement operation. There is no same-number principal shortcut, chown,
privileged helper, or automatic permission grant.

Application is limited to newly created recovery folders or fenced NEW managed
live roots. Regular originals, all selected aliases, and provider/Git children
are populated first. Metadata is finalized afterward, files before parent
directories and the root last. Full POSIX mode bits (07777), including setgid,
sticky and setuid, are restored under the explicit metadata choice; native OS
permission checks and exact readback remain effective. Without that selection,
export refuses special-mode files/directories instead of silently stripping bits.

FIFO creation uses the held parent, exclusive no-replace creation and descriptor
mode/time readback. The mapped effective owner and observed inherited group are
checked before creation, then the returned actual owner/group must match.
Setgid-parent inheritance is observed rather than assumed from the process GID.
A mismatch after creation retains the node and reports a partial result. No
socket service or device authority is inferred from an inode or major/minor.

Each selected destination has applying/completed/incomplete metadata receipts in
its durable creation operation and result. Ordinary and grouped Branch results
retain those receipts. Observations contain bounded identity/status evidence,
with bigint integers normalized to decimal strings, never attribute values.
Native or receipt-persistence failures keep the primary cause and existing bytes.
There is no rollback, automatic retry, or deletion of an uncertain destination.

## Links across selected roots

Canonical absolute links into a selected root are relocated. Canonical absolute
and leading-parent sibling links into another explicitly selected organization
root carry a targetRootRef and relative target, with original sourceTarget
spelling retained as historical evidence. The importer uses the explicit final
root destination map and creates relative links. It never follows an unselected
source target. Noncanonical paths that could normalize through a symbolic
component refuse. A bounded package-wide symbolic resolver checks mapped root
closure, escapes and passive cycles before mutation.

All selected whole roots share one hardlink inventory. Each inode's original is
chosen in its earliest inventoried root; every later alias references that
regular original. Total observed link count must equal the complete selected
alias count. Secret/excluded or outside aliases refuse. Named identity, link
count, size, mode, mtime and ctime are checked before and after capture.

The canonical original choice is stable, but import does not require an
acyclic cross-root alias graph. Generic Agent and full Branch imports stage
regular originals across every selected root before installing any root's links.
Only declared nesting imposes parent-first root creation; cross-inode root
dependency cycles remain supported. Native Git/provider application follows all
aliases, then ordinary/native metadata is finalized. Each hardlink checks
same-device destinations. A cross-device failure preserves partial folders and
originals; deferred live links also preserve displaced fresh-checkout baselines
in the exact import backup folder.

Metadata waits for every alias and uses the exact complete expected link count.
Native helpers still default to one link; a bounded larger count is supplied
only from this complete selected/caller-owned alias graph. Aliases never receive
competing attribute applications. The original root device/inode custody crosses
the deferred phases as described below; a later pathname observation is not a
replacement grant.

## Exact remaining boundaries

- Linux selected user attributes/POSIX ACLs are covered. Other platform ACL
  dialects, ownership changes, and security/trusted/LSM namespace policy are not.
- FIFO evidence covers mode/time/owner/group plus selected Linux access ACLs.
  User attributes are VFS-forbidden and default ACLs are invalid on non-directories. Device-node recreation needs an actual destination device mapping;
  socket recreation needs the real service owner/lifecycle.
- Source root/alias identity and drift checks do not create an atomic snapshot.
  There is no independent-writer snapshot-set or service-quiescence backend.
- Source special-mode restoration can fail if the destination OS, filesystem,
  ownership or group membership cannot preserve the selected bits. Exact readback
  fails loudly; no privilege escalation or masking occurs.
- An independently exported Agent cannot manufacture another root's data or
  grant. Full Branch export establishes selected cross-Chat physical closure
  through one shared capture context while keeping canonical Chat histories
  separate; it does not relax the single-Agent package's ownership boundary.
- Native extended metadata remains Linux-only. Non-Linux ordinary mutable-name
  open/replacement behavior remains unqualified, not an approved Bible exception.

Regression sources cover exact metadata/absence, missing principals, secret
attributes, FIFO choices, real Linux attribute-plus-hardlink/full-mode round trips,
absolute links, mapped symbolic escapes and complete cross-root hardlink aliases.
They are intentionally unexecuted until all implementation lanes are combined.

## FIFO extended metadata completion

FIFO ACL evidence now uses internally held O_PATH nodes plus metadata-only
get/list/set/remove xattr calls through the exact owned procfs fd path. The
fixed procfs path is filesystem-qualified and resolved identity must match the
held inode; no FIFO content endpoint is opened. Held parent/name/node bindings
are checked around inspection/application. Unavailable procfs, unsupported ACL
dialects, unreadable namespaces and failed metadata syscalls remain explicit
errors.

The persistent-node carrier includes extendedMetadata when selected. Its access
ACL has the same source-qualified principal mapping and secret/bounds validation
as regular nodes; missing evidence cannot mean absence. Linux forbids user.*
attributes on FIFOs, so that selected namespace is observed empty rather than
invented or activated. A FIFO cannot have a default ACL.

Creation may accept an inherited access ACL only under the separate explicit
exact-restoration choice. After exclusive creation and actual ownership readback,
the original created inode is bound to mapped ACL restoration and full-mode
readback. ACL application failure keeps the created node and reports a partial
result. No rollback or second creation attempt occurs.

Ordinary metadata can also be staged globally: imports keep file/directory/root
permissions temporary until all selected roots, aliases and provider/Git children
exist. Final ordinary file application rechecks exact bytes, complete link count
and descriptor observation before mode/time mutation; directories and roots
follow their children. This includes imports without native metadata activation.

Source basis: Pine reported kernel 7.0.0-38-generic and its installed headers expose
xattrat syscall identifiers. This is read-only environment evidence, not execution
qualification. Pinned [Linux v7.0 xattr implementation](https://raw.githubusercontent.com/torvalds/linux/v7.0/fs/xattr.c)
establishes inode-only metadata dispatch and the FIFO user-namespace prohibition;
[POSIX ACL implementation](https://raw.githubusercontent.com/torvalds/linux/v7.0/fs/posix_acl.c)
defines non-directory/default and access ACL semantics.
The added FIFO ACL round-trip regression is unexecuted pending combined validation.

## Regular-file replacement boundary

On Linux every portable ordinary source read, ordinary finalization hash read,
and regular-node metadata capture/application now starts with a no-follow O_PATH
pin. The native pin checks regular type and exact observed device/inode before
any data open. Metadata stays on that descriptor. A data reader opens only the
qualified procfs path of that already held regular inode, keeps the pin until
read-handle identity is checked, and then releases it once. A substituted FIFO,
socket, device or symbolic link cannot be opened as a data endpoint merely to
discover its type. Parent/root custody checks remain separate and unchanged.

The shared helper is portable-held-regular.ts; native pin ownership is explicit
and cleanup failure preserves the primary failure while attempting each owned
close once. Exact mode/time operations on O_PATH use descriptor-only Linux
syscalls, including support preflight and exact readback. Exclusive new-file
creation and directory opens keep their existing no-replace/O_DIRECTORY paths.

The bounded regression launches a disposable child with a stale regular inode
observation after the pathname becomes a FIFO. It must refuse within the timeout
and preserve both originals. A second regression keeps read/metadata pins across
pathname replacement and verifies that only the original regular inode is read
or updated. Both regression sources remain unexecuted until combined validation.

Non-Linux ordinary file functionality is retained. Its previous mutable-name
open/replacement boundary is still unqualified: no O_EVTONLY, Windows handle,
or other platform semantics are guessed here. That remaining boundary is neither
a True verdict nor an approved Bible exception. Native extended metadata remains
explicitly Linux-only. This tranche does not claim an independent-writer snapshot.

## Root identity across deferred phases

The byte phase returns its locally issued device/inode strings and verifies them
again at completion. A fresh live root carries its earlier allocation identity
into population before a backup or file is created. Working-copy population
forwards that exact identity.

Deferred links accept that identity as the fifth argument (the fourth remains
the optional baseline-backup folder). It is checked before parent/link mutation
and during the phase; a replacement observation is never promoted to original
custody. Final metadata accepts the same identity after link counts and checks it
before mutation and at completion. Live finalization also forwards its original
working-copy custody proof. Rejection preserves both folders and all baselines.
These are observed identity checks, not an independent-writer snapshot contract.

New regressions replace an issued root between byte and link/metadata phases and
require refusal before parent creation or metadata changes. Another verifies that
a prior fresh allocation identity refuses replacement before backup creation.
Execution remains deferred until all implementation is integrated.

The original issued directory identity now crosses every deferred mutation boundary: link installation, native Git/provider recreation, and final metadata. Phase-entry observations cannot replace that authority. A replaced directory is refused before later-phase writes, retaining both the original and observed paths.

## Generic contained Project binding

Generic Agent-package imports reuse the same internal Project/Chat/Shared-owner
path journal as Branch imports. The journal records exactly one owner authority:
`creationOperationId` for a preparing generic import, or `planId` for a staged
Branch import. The original managed creation identity and previous folder remain
provenance; no source pathname or public host-path override grants this binding.

The store requires the complete canonical preparing import membership, an unused
NEW managed Chat without Runs, and the existing local parent/child inode proof
and created reservation. The service still verifies all owner fences. A durable
`result.importedProjectRootBindings` marker precedes the first Project write.
It survives result updates and unavailable projections. Startup may repair only
the exact recorded path metadata; interrupted generic work then stays preparing
and unavailable, excluded from automatic rollback and physical replay. Admission
checks read the original operation marker independently of Project projections.
Unknown original and replacement folders, partial files, and source receipts stay
retained. The authored regression covers membership, child replacement, restart
repair, isolated holds and original-folder retention; execution is deferred.


## Contained directory custody across native phases

The byte phase also records each explicit directory and implicit parent it creates
or validates. Native module and worktree configuration use those original
directory identities inside the most specific selected root. A directory first
observed during native activation cannot stand in for byte-phase custody.
Replacement or a missing original directory record refuses before the later
mutation; both original and observed folders remain. The identity map travels
unchanged through live staging and Branch recovery roots. This is local observed
custody, not an independent-writer atomic snapshot. Regression execution remains
deferred until all implementation is combined.


Configured external Git originals are also copied under
.ponderosa-portable-review/external-git as numbered, non-executable .review
files with a readable mapping manifest. Git repository capsules retain their
inert Git metadata and original bytes there. The review copy never creates
source links or activates hooks or configuration.

## Native external Git graph application

The native Git writer consumes a finite, closed graph of directory, regular-file
and symbolic/hardlink nodes. Paths are canonical relative names tagged with an
owned Git-directory or working-tree context; link targets name declared nodes.
Working-tree placement requires the original import-root device/inode proof
injected by its caller, including the original byte-phase directory map for every
reused child directory. Historical source paths never become write authority.
Existing destinations are reused only after exact original-byte/target, owner
and inode checks. Differing bytes and aliases outside the declared graph remain
untouched and cause an incomplete receipt. No external original is overwritten.

New aliases are placed after Git shared-permission processing, with complete
existing and final hardlink-count checks. File metadata is restored on held
regular descriptors with the complete known link count. Symbolic-link timestamps
use the exact native held-link helper, retaining parent/name custody; no floating
point timestamp conversion is used. Explicit source directory mode/timestamps
are finalized deepest first after sharing and children, with each held directory
synced before closure. Unsupported native metadata operations refuse explicitly.
The dedicated regression source covers both contexts, same-inode byte retention,
exact nanoseconds, stale/missing root proof, changed bytes and undeclared aliases.
Execution remains deferred to the consolidated validation pass.

Generated active Git support trees remain under `.ponderosa-portable-review`; native `info/exclude` receives that scoped ignore once, while source `infoReview` remains unchanged in the retained canonical package.

Linked storage also supports a selected private-Git context, kept separate from
common storage when only a private slot is being initialized. Recursive repository
capsules reuse the native common/private layout writer. Generated hook views may
reference the constant top-owner graph through a read-only `owner` target context;
the writer carries the exact parent directory proof internally. Owner-node writes and undeclared owner targets are refused. Captured source
hardlinks may cross native scopes only inside the fully predeclared owned graph. Capsule worktree
custody can be issued from the parent's own newly created, retained directory map,
never from a late observation of an unrelated directory. Parent sharing finishes
before child repository creation. One top-level queue waits for every recursive
copy, sharing step and bounded content readback before materializing the complete
alias graph and restoring any restrictive source file/directory mode. Descriptors
remain bounded, and exact readback stamps bind the metadata pass. The shared
runtime-only `directoryProofs` map exposes issued common/private/module/working
parents to the caller without promoting a later observation to authority.

Native callers may share an opaque `nativeMetadataScope` with deferred metadata
across all native tasks. One one-shot `prepareNativeMetadata` materializes the
complete alias graph and verifies readable originals after every copy/sharing
step. The caller stages ordinary/ACL metadata and performs its readable adoption
snapshot, then invokes the same one-shot `finalizeNativeMetadata`. Controlled
metadata callbacks run on the finalizer's exact held descriptor before raw source
modes/timestamps, so restrictive source permissions never require relaxation.
Runtime-only file and directory metadata proofs are issued after exact readback;
they are not a cached-byte authorization for future Runs. A failed/started callback
cannot be replayed. Fully declared existing working aliases are counted only after
original root/parent custody and exact same-inode checks; missing proof refuses.
