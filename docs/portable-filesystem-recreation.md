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

That canonical choice makes exported hardlink root dependencies acyclic.
Import sorts dependencies independently of destination-map ordering, creates
regular originals before alias roots, and verifies same-device destinations.
A cross-device failure preserves partial folders and originals. Metadata
application waits for every alias and uses the exact complete expected link
count. Native helpers still default to one link; a bounded larger count is
supplied only from this complete selected/caller-owned alias graph. Aliases never
receive competing attribute applications.

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
- Branch single-Agent composition still requires complete root closure. An
  independently exported Agent cannot manufacture another root's data or grant.

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

Generic Agent and Branch imports both stage every regular original before any root's links. Only nesting imposes parent-first root order; cross-inode root dependency cycles remain supported. Deferred live links reuse baseline retention, so displaced fresh-checkout files survive in the exact import backup folder.
