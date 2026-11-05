# Fresh Git recreation and external configuration

Bible #8, #12 and #15. This replaces the earlier source-only refusal of mapped
native recovery; historical inventory paragraphs describe their own candidate.

Full imports keep their existing explicit working-root destinations. Choosing
`reviewedUserDataActivation.git` additionally creates native Git in those newly
imported recovery folders. This choice does not change an Agent's saved working
folder mode, grant access, or adopt a source branch/worktree cleanup receipt.
The existing hash-bound access review covers activation and every path map.
Git and provider settings can also use the existing unused NEW managed Shared
destination; live managed Separate Git ownership is handled by the working-copy
service, separately from this recovery operation.

Mapped common/private packages require their complete captured association pair,
the exact reviewed-original hash, every final root and a destination layout that
keeps `common/worktrees/private`. All selected common originals must agree.
The writer creates a fresh bare common repository and private worktree slots,
rewrites `.git`, `commondir`, `gitdir` and current `core.worktree`, and makes new
destination ownership evidence. Source pointers and process/cleanup authority
remain historical data. Recreation never invokes hooks, provider commands, fetch or services. A local
Git config read on the newly recreated destination derives shared modes.
Existing metadata is never replaced.

An explicit module binding recreates its Git storage in the chosen fresh storage
root and writes a new worktree pointer. Contained module inventories recurse into
`modules/name`, restore each repository's objects, refs, index, configuration and
originals, and bind `core.worktree` to the chosen current working root. Initialized
modules receive a fresh `.git` pointer; deinitialized modules keep their stored
repository and remain deinitialized. Embedded source `.git` directories normalize
to this same destination path. External module worktrees require an explicit
selected-root mapping. Source Gitlink entries require a new export with inspected
module presence or absence, rather than treating an old omitted field as empty.

If an included Agent and its parent's module inventory name the same repository,
their complete native snapshots and selected storage must agree. One parent
writer creates the repository, the child verifies that exact pointer, and the
native receipts run in dependency order. Typed `workingRootNesting` boundaries
permit the exact selected parent/child destination layout; unrelated overlaps
still refuse. All root identities remain held, including file-only support roots.
Module recursion is bounded to 32 levels and 1,000 repositories per import to
protect parser memory; these limits are explicit failures, never clipping.

Supported logical index entries, including a captured sparse index expanded to
its verified full representation, and its sparse settings/patterns are restored.
Worktree-local configuration remains in its own slot. Default Git hook/support
originals now capture ordinary mode and nanosecond mtime; activating an older
active hook without that evidence requires a fresh export. Hook originals are
installed with the captured mode/time; recreation never invokes them.

`gitPathMappings` is an optional nonempty array of `{source,destination}` absolute
canonical path prefixes. Longest matching prefix wins. Every destination must be
inside an explicitly chosen fresh imported root. No mapping grants access to an
old host path. A missing map or transported dependency gives a specific error
before native metadata creation. Nonsecret native settings and commands retain
their values; known credential fields remain excluded and must be re-entered.

New Git exports record historical common/private configuration directories and
home solely to resolve relative and `~/` configuration paths. Those paths never
authorize reads. External includes, including nested and conditional includes,
compile only from canonical originals selected in the same package. Each gets a
relocated activation copy under `ponderosa-includes` inside the newly created
native Git storage. Source include files remain unchanged and available for
review. Conditional include directory suffixes and unanchored globs retain
their meaning; named-user home expansion requires explicit provenance rather
than guessing another account's home.

The include compiler detects cycles, refuses missing selected dependencies and
uses the native ten-level include ceiling, 1 MiB per source, 1,000 references and
32 MiB total source bytes to protect parser memory. Complete source inputs,
comments and known-field exclusions remain in the original review package; the
activation copies serialize their native configuration semantics. No include
target is read from the historical source machine or an unselected destination.

Per-root `applying`, `completed` or `incomplete` receipts enter the existing import
operation. Failure preserves all destination bytes and authoritative originals.
An incomplete or uncertain operation is never automatically repeated. Root and
directory metadata must finalize after all links, Git and provider children.

The source regression covers staged/working state, relocated nested includes,
unchanged originals, executable hook metadata without hook execution, exact
mapped pointers, unchanged source registration, dependency refusal and duplicate
application refusal. It is added to the maintained server inventory. Tests,
builds and typechecks were deliberately deferred to the integrated final pass.
Source presence is not round-trip or whole-Bible acceptance evidence.

Exact POSIX hook mode/time application uses the native Linux/macOS descriptor
operation. Windows explicitly refuses that POSIX metadata before native Git
creation; inert data recovery remains available. This is a declared platform
compatibility boundary, not a Windows metadata-equivalence claim.

The shared export choice **Include configured Git files and hooks** grants a
bounded capture of the currently configured external dependency graph. It does
not create hidden Agents. Default hooks and dependencies already inside selected
Git/worktree roots are captured without that extra grant. The new
`gitExternalDependencies` family carries original source working/context paths,
sanitized included configs, complete referenced hook directories and their
siblings, referenced attribute/exclude files, exact ordinary mode/time metadata,
links and nested repository capsules. A link to an individual external file
captures that target, never its unrelated parent directory. Bounded captures
refuse drift; they do not claim an atomic snapshot of independent writers.

Omitted paths (no grant or excluded credential stores) remain distinct from an
observed missing optional include. Credential stores and private keys are never
transported; known JSON credential fields are removed, and included configs use
the same native config secret policy. Captured hook/support bytes can contain
user-authored sensitive text, covered by the existing sensitive-data export
review. Source path strings are provenance only; import reads transported bytes
and newly selected destination roots. Activation uses owned destination copies
and rewrites context paths, including separate native worktree/gitdir hook
contexts, without generating hook dispatch programs or executing hooks.

Capture reads through held directory references and nonblocking regular-file
opens, checks device/inode/mode/time before and after fixed-size bounded reads,
and rechecks parent membership and original hashes before returning. The format
bounds are 10,000 nodes, 32 MiB dependency bytes, 1,000 references, native ten-level
include resolution and 128 directory/link levels. Parser graph checks run before
native writes. Passive symlink cycles remain retained evidence; an active config
binding must resolve to usable data or an explicit omitted/absent disposition.

Named-user `~other/` and `%(prefix)` values expand only during source capture,
using Git's own non-executing `config --path` over the captured declaring config
bytes with includes disabled. Repeated values bind by exact native key/ordinal.
The bounded absolute result is retained in the existing dependency binding;
import validates its original raw declaration and closed transported target,
then relocates it without consulting destination users or installation paths.
Unprovable native expansion fails explicitly rather than guessing a path.

Retained current Git review files larger than 64 MiB use the existing working-file
parts format. Capture verifies the full ordered original and applies the existing
whole-file credential and Git provenance checks before retaining it as inert
evidence; re-export and import preserve the one logical file. Available-memory
admission accounts for accumulated evidence and reconstruction. The focused
65 MiB regression covers inert text, re-export, corruption and credential
refusal across a part boundary. This does not expand the existing reviewed-Git
object-graph or selected native-configuration bounds, and unproven opaque binary
Git data remains held with its source preserved.
