# Native portable metadata mechanisms

This is a native source contract, not a product import grant or a tested platform
claim. Public functions and exact TypeScript types are exported from
`packages/native-host/src/index.ts`. Implementation is in the adjacent
`portable-metadata.inc`, included by `native.cc`. The earlier
`applyExactFileMetadata` API is unchanged. The product caller in portable-filesystem-metadata.ts now uses these APIs under explicit reviewed metadata activation; see portable-filesystem-recreation.md.

## Supported boundary

| Family | Implemented source | Unsupported or still required |
| --- | --- | --- |
| Exact held symlink timestamps | Linux O_PATH/no-follow with empty-path utimensat; macOS O_SYMLINK with descriptor futimens; exact signed-nanosecond readback | Windows unsupported. Filesystem refusal or precision loss remains failure. This does not extend other metadata families to macOS. |
| Extended inspection | Linux held regular-file/directory descriptors and internally held FIFO O_PATH nodes; bounded visible name/value inventory; explicit POSIX ACL probes and v2 parser | Linux may hide privileged names. `allNamespacesComplete` is always false. Other platforms throw a specific unsupported error; they are not empty inventories. |
| Selected extended restore | Linux exact selected `user.*` plus POSIX access/default ACL state, explicit principal remapping and full selected readback | No security/trusted/capability/SELinux/unknown namespace application, chown or alternate ACL dialect. A destination with other visible namespaces refuses before mutation. Hidden namespaces cannot be proved absent. |
| Persistent inspection | Linux O_PATH descriptor and held parent/one leaf binding for FIFO, socket, character/block node | No content open, socket communication or service adoption. Exact device numbers are evidence, never destination mapping authority. |
| Persistent creation | Linux no-replace FIFO creation, descriptor-only mode/time and exact readback | Requires headers/kernel supporting fchmodat2/AT_EMPTY_PATH and utimensat/AT_EMPTY_PATH. No device/socket creation; no ownership recreation or extended-metadata equivalence claim. |
| Independent writer snapshot | Contract assessment below | No backend was found in current native/server/agent source. No acquire API is invented. |

The caller must validate selected nonsecret data, package shape, explicit current
human restore/application choice, destination membership, access and exclusive
ownership. Source-qualified principal provenance is a caller-supplied observation
of the host, user namespace and mount mapping used for capture. Names or equal
numeric IDs never establish the same user on another host. Qualification strings
are not identities verified by the kernel or permission tokens.

## Extended inspection

`inspectExtendedMetadata({fd,expectedDevice,expectedInode,kind,sourceQualifier})`
accepts a caller-held no-follow regular-file/directory descriptor. It checks exact
bigint device/inode and kind; a regular file defaults to one link. A complete selected/caller-owned alias graph may supply expectedLinkCount in 1..10000; exact count is checked before and after. No path is opened.
The qualifier is required and bounded to 256 UTF-8 bytes. Named ACL entries carry
that qualifier and observed numeric source ID; owner/group IDs are also observed.

`identity` contains exact mode/mtimeNs and owner/group IDs. `inventoryState` is
`complete-visible`, `error` or `unsupported`; this is the state of the native
visible-name enumeration, not a cross-namespace absence assertion. Inventory caps
are 64 KiB of names, 256 names, 64 KiB per value and 1 MiB of aggregate values.
An over-cap/failing inventory has an explicit error and must not be accepted as
complete; any partial entries are evidence only. Values have independent `value`,
`absent`, `error` or `unsupported` states. Empty present values remain buffers.
Names are raw non-NUL byte buffers; there is no UTF-8 name round trip.

Access/default ACLs are probed even when not listed. ENODATA is explicit absence;
EOPNOTSUPP is unsupported, never empty. A v2 ACL parser checks the little-endian
version/header/entry lengths, tags, permissions, undefined-ID sentinels, canonical
order, unique named IDs and required mask. Malformed/other dialect bytes remain
inert evidence with unsupported state, never an applied ACL. This parser does not
resolve accounts or invoke an external ACL utility. Reads are bounded, single
attempts; metadata changes observed through fstat reject the inspection. They do
not establish consistency against independent writers or a filesystem snapshot.
No values are logged. The caller controls secret selection, scrubbing and retention.

Linux namespaces are explicit: user, system.posix_acl, security and other are
visible-only; trusted is not-enumerable under ordinary credentials. Kernel
visibility can omit trusted names, so `allNamespacesComplete:false` is mandatory,
including when running as a privileged host user. Full all-namespace metadata
recreation is not established by this implementation.

## Selected extended restore

`applyExtendedMetadata` takes the held target plus:

- `restore:"replace-user-and-posix-acl"`, explicitly authorizing replacement of
  inherited selected user attributes and access/default ACLs, including removal.
- `sourceQualifier`, `destinationQualifier`, sourceOwnerId/sourceGroupId and
  destinationOwnerId/destinationGroupId.
- `principalMappings:[{sourceQualifier,kind:"user"|"group",sourceId,destinationId}]`.
  Every named source ACL ID and both source owner/group IDs require a mapping.
  There is no same-number shortcut. Destination IDs must be valid 32-bit values
  excluding the undefined sentinel. Duplicate or collapsing ACL mappings refuse.
- The entire selected `attributes:[{name:Buffer,value:Buffer}]` user namespace,
  `accessAcl:Buffer|null`, `defaultAcl:Buffer|null`, and `mode` in 0..0o777.
  Null means required absence; omission is invalid. Default ACL values require a
  directory. Mode-equivalent three-entry access ACLs must use null plus mode,
  matching Linux normalization. Access ACL owner/mask/other must agree with mode.

The native helper preflights all input buffers, caps, mappings, ACLs and current
destination metadata before mutation. Destination owner/group must already equal
the explicitly mapped owner/group: no chown or privilege helper exists. Full POSIX mode bits require the separate explicit metadata restore choice; native permission checks and exact readback remain. Only `user.*` names are accepted in the input array; ACLs use the
separate parsed fields. All destination visible names/values must be readable;
security/trusted/other visible namespaces refuse without attempted application.
Kernel/LSM permissions remain effective. Hidden namespace absence and filesystem
support for writes cannot be proved by this preflight; write refusal stays failure.

After preflight, obsolete user attributes are removed, selected user values are
written, mapped access/default ACL state is applied or explicitly removed, and
chmod applies the ACL-compatible mode. It then verifies complete visible names,
exact raw mapped ACL bytes/absence, exact user bytes, owner/group, mode and held
identity. Success returns new inspection evidence qualified by
`destinationQualifier`, not source-qualified destination IDs. mtime is not changed
by this API; apply the separate exact mode/mtime helper afterward with the same
ACL-compatible mode. Finish directory metadata after children. Default ACLs apply
after children here; future children will inherit them through native semantics.

Before mutation, errors use `ERR_PORTABLE_METADATA_PREFLIGHT`; platform refusal
uses `ERR_PORTABLE_METADATA_UNSUPPORTED`. Once mutation is attempted, any syscall,
partial write, normalized/rounded/different readback or failed observation throws
`ERR_PORTABLE_METADATA_PARTIAL`, `partialStatePossible:true`, and
`observed:ExtendedMetadataEvidence|null`. Existing nodes are retained. No rollback,
delete, retry, fsync/durability or atomic-transaction success is promised. Inspection
errors use `ERR_PORTABLE_METADATA_INSPECT` or the unsupported code. Product callers
must retain partial failure visibly and never convert it into an empty inventory.

## Persistent nodes

`inspectPersistentNode({parentFd,expectedParentDevice,expectedParentInode,leaf})`
requires one canonical nonempty leaf (no slash, backslash, NUL, dot or dot-dot).
It validates the held parent directory, opens only `O_PATH|O_NOFOLLOW|O_CLOEXEC`,
and compares fstat/fstatat no-follow parent/leaf/descriptor identities before and
after. Exactly one link is required. The result reports kind, device/inode,
linkCount, mode, exact mtimeNs, owner/group, source device major/minor and parent
identity. It never reads FIFO/device content or connects/binds/listens a socket.
It closes its temporary O_PATH descriptor, never the caller's parent.

`createPersistentNode({...parent,kind:"fifo",mode,mtimeNs})` requires exclusive
caller ownership of the destination directory/name through creation/readback and
separate destination membership/current grant. This prerequisite is stronger than
an in-process advisory lock. It does not authorize replacing existing entries.

It preflights input/time_t representation and uses invalid-descriptor-only probes
to establish descriptor-mode/time syscall support without changing a node. A
parent default ACL may be inherited only when explicit exact FIFO extended-metadata restoration is selected; otherwise present/unreadable inherited ACL refuses.
It then exclusively creates a FIFO with initial 0600 mode, opens O_PATH only,
applies exact timestamp with utimensat AT_EMPTY_PATH and mode with fchmodat2
AT_EMPTY_PATH, and verifies the same single-link FIFO, rdev zero, owner/group,
mode, timestamp and parent/name association. mode is limited to 0..0o7777; native permission checks and exact readback remain. Exact negative nanoseconds use floor seconds. An OS/filesystem
refusal or truncation is failure. Parent directory timestamps naturally change
when its entry is created; restore parent metadata last.

Creation retains current native owner/inherited group. The product separately maps and restores selected Linux FIFO access ACLs on that exact created inode; it never recreates foreign ownership, labels or all namespaces. Inherited/default/security policy
is never changed or bypassed. An independent actor replacing the name before the
first O_PATH observation cannot be distinguished from creation by mknodat alone;
therefore exclusive caller directory/name custody is a necessary contract, not a
claim this helper establishes. No atomic compare-and-create identity API is added.

Precreation errors use `ERR_PERSISTENT_NODE_PREFLIGHT`; platform/header refusal is
`ERR_PERSISTENT_NODE_UNSUPPORTED`. After a creation syscall is attempted, failures (including uncertain syscall
failures) use
`ERR_PORTABLE_METADATA_PARTIAL` with observed persistent-node evidence or null.
The created entry is never removed/rolled back and mutation is never retried.
Inspection errors use `ERR_PERSISTENT_NODE_INSPECT`.

Char/block creation is absent pending a source-qualified device identity to exact
destination device mapping and separately established current human grant; raw
major/minor and CAP_MKNOD availability are not authority. No privileged helper or
capability escalation is allowed. Socket recreation is absent: an inode is not a
service. It requires its actual owner definition and exact current adoption/exit
receipt; no such contract is established here. Offline mknod socket-copy support
is unchanged and is not reused as native service recreation.

## Independent-writer coherent capture assessment

A source search for existing Btrfs snapshot/VSS/APFS/freeze/acquire implementations
found no current authorized backend. Existing Ponderosa writer/capture counts and
memory-source drains cover their own participants, not all independent writers.
An advisory lock, inode identity/drift check, copying/reflinking each file or
in-process fence cannot make an all-selected-root snapshot. No fake snapshot API,
filesystem freeze, mount operation, generic command hook, writer termination or
service startup was added.

Smallest reviewable proposal, requiring a separate backend/grant assignment:

1. Select one actual backend with a held source-root/subvolume identity and a
   read-only snapshot create/read/release contract. For example, an explicitly
   authorized Btrfs subvolume snapshot backend must bind filesystem/subvolume ID,
   held original roots and every selected relative root to a snapshot generation
   and held read-root identity. Nested subvolumes must be individually included or
   explicitly unsupported; sequential snapshots are not one multi-root boundary.
2. Return a backend receipt containing all original-to-read-root bindings, scope,
   consistency boundary/generation, owner/lease, acquire status and exact release
   outcome. Failed/uncertain acquisition cannot authorize live-root fallback.
   Failed release retains the exact backend object/lease, never guesses a target.
3. Cross-filesystem selection requires an actual coordinated snapshot-set backend
   or participating writer/service quiescence across the whole selected set.
   Without that contract, restrict an atomic claim to one supported boundary or
   refuse the all-root atomic claim. A Btrfs per-subvolume ioctl is not a universal
   cross-filesystem transaction. Windows VSS requires real requester/provider and
   participating writer preparation/freeze/thaw/error handling; none exists here.
4. Application-consistent service state additionally requires actual participation
   of every selected writer/service with restart-stable drain/resume receipts.
   A crash-consistent filesystem snapshot alone does not supply application-level
   completion or pending-operation settlement. No grant or service owner is inferred.

No backend/receipt type is exported before that real implementation exists.

## Primary source basis

Pinned Linux v6.12 source, read only; no native operation was run:

- [POSIX ACL wire layout](https://raw.githubusercontent.com/torvalds/linux/v6.12/include/uapi/linux/posix_acl_xattr.h)
  and [tags/permissions](https://raw.githubusercontent.com/torvalds/linux/v6.12/include/uapi/linux/posix_acl.h).
- [ACL validation, conversion, mode normalization and inheritance](https://raw.githubusercontent.com/torvalds/linux/v6.12/fs/posix_acl.c).
- [Xattr namespace permission and visibility semantics](https://raw.githubusercontent.com/torvalds/linux/v6.12/fs/xattr.c).
- [No-replace native creation and device privilege checks](https://raw.githubusercontent.com/torvalds/linux/v6.12/fs/namei.c).
- [O_PATH and fchmodat2 AT_EMPTY_PATH](https://raw.githubusercontent.com/torvalds/linux/v6.12/fs/open.c),
  [utimensat AT_EMPTY_PATH and nanoseconds](https://raw.githubusercontent.com/torvalds/linux/v6.12/fs/utimes.c).
- [Btrfs snapshot ioctl scope](https://raw.githubusercontent.com/torvalds/linux/v6.12/fs/btrfs/ioctl.c)
  and [kernel Btrfs overview](https://docs.kernel.org/6.12/filesystems/btrfs.html).
- [Microsoft VSS processing overview](https://learn.microsoft.com/en-us/windows/win32/vss/overview-of-processing-a-backup-under-vss)
  (unversioned vendor documentation read 2026-11-03).

Source implementation and independent source review are separate from compilation,
installed permissions, kernel/header/platform support, precision, round trips,
service recreation, durability, atomicity and full portability acceptance. No tests,
fixtures/preparation, builds, typechecks or native/parser/product execution were
performed in this implementation tranche.

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

## Held ordinary regular pins

See [the regular-file replacement contract](portable-filesystem-recreation.md#regular-file-replacement-boundary). Linux metadata capture/application uses exact no-follow O_PATH regular pins, while data/hash reads reopen that held inode through its qualified procfs fd path. No FIFO endpoint is opened before a type check. Parent/root identity checks remain required. O_PATH exact mode/time applies through descriptor-only fchmodat2/utimensat with support preflight and readback. Non-Linux ordinary replacement races remain unqualified; their existing functionality is preserved. No tests/build/native execution were run in this successor.


## Held symlink timestamps

`pinPortableSymlink` binds one single-name symlink to a borrowed held parent and
returns a caller-owned descriptor after exact parent/name/device/inode/kind checks.
Linux uses O_PATH|O_NOFOLLOW; macOS uses O_SYMLINK|O_NONBLOCK. Neither follows the
symlink target or reads link bytes. Darwin O_SYMLINK cannot be combined with
O_NOFOLLOW. A replaced non-symlink leaf can be opened before Darwin's type/identity
rejection, so the existing fresh-node and parent/name custody contract remains
required; this is not a claim of Linux O_PATH behavior on macOS.

`applyExactSymlinkMetadata` uses Linux empty-path no-follow utimensat or macOS
futimens on that exact held inode. It preserves atime, owner/group and mode and
requires exact signed-nanosecond timestamp/identity readback. A filesystem refusal,
rounding or changed observation fails; attempted mutation reports partial-state
evidence without rollback or retry. Final exact working-link restoration uses
this native path on Linux and macOS. Windows remains explicitly unsupported.
This narrow support does not extend Linux ACL, xattr, FIFO or regular-file pin
contracts to other platforms, or qualify full package import/export on macOS.
