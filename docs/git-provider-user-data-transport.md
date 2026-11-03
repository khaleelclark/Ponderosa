# U3 Git and provider configuration transport

Source update from `b1fd75be85cd14b0037259b50a207684d5088ff3`, reusing the
separate implementation at `39589d8f932a5180d0d0e4e7fb04e870dc6e8012`.
No tests, test preparation, builds, native commands or providers were run.

When explicitly selected, full working-folder package export includes one ordinary, hashed artifact binding at
`.ponderosa-portable-review/user-data.json`. Selected-file export keeps its explicit
selection. The existing artifact byte limits, package parser, Shared composer,
recovery-folder import and fresh managed live-root import carry this binding.
The manifest records the exact selected families and refuses unknown fields or a family mismatch. Shared composition refuses different captured review manifests at the same path.
There is no parallel package ownership or runtime format.

## Explicit selection and review

Agent/organization caller: GET `/api/agents/:id/export` with `mode=full`,
`wholeWorkingFolder=true` (or `organizationWorkingFolders=true`) and the
URL-encoded JSON query `reviewedUserData={"git":true,"harness":true}`.
Both booleans are required; either may be false, but at least one must be true.
Omitting the query preserves existing working-folder export behavior and exclusions.
Each distinct selected organization root is captured independently. Selecting Git
on a root with no supported local repository refuses, rather than returning an
apparently complete Git export. Supported reciprocally associated linked worktrees use the explicit Git authority described below. External alternate stores, unsupported shared layouts, combined split/sparse index storage, unsupported shallow/partial-clone forms and unfinished selected-worktree Git operations refuse.

Inspect the resulting ordinary artifact `.ponderosa-portable-review/user-data.json`
before importing. Its `selection`, Git refs/index/configuration review, provider
path list, removed-secret flags and exclusions describe exactly what will travel.
Use the existing import preview and explicitly chosen new recovery folder or
confirmed fresh managed root. Import validates the manifest/hash before writing
working-folder bytes and recreates review copies only. It neither changes access
nor runs Git, hooks, provider commands or settings.

The Agent export dialog exposes separate unchecked Git and harness-settings choices
for full exports with whole root or organization working folders. Copy JSON and
Download JSON pass the same explicit choice. Selected-file and setup-only export
do not capture either family.

The full Branch export dialog exposes the same unchecked choices, applied only to
Agents selected for whole working-folder export (including the all-folders option).
The public Branch package API and SDK carry each Agent's choice in
`fileSelections[agentId].reviewedUserData={git:true,harness:false}` alongside
`wholeWorkingFolder:true`. Both booleans are required, and at least one must be
true. The server refuses this option for template exports, selected-files-only
exports, unknown fields or invalid selections. Existing definition-tree export
forwards each Agent's selection to the shared package engine without broadening it.
The folder and settings review/import behavior is unchanged by these controls.

### Explicit linked-worktree Git authority

The human-approved **Include Git** policy authorizes future export reads of the
selected worktree's reciprocally validated private gitdir and its exact common
repository, even outside the selected folder. This does not authorize other
worktrees' private state, external includes/alternates, unrelated repositories or
cross-root working-file traversal. Ordinary `recreationScope.crossRootLinks`
remains `refuse`; no source pointers, ownership metadata or live topology are
adopted at import. These are separate authority rules.

Before external repository contents are read, the reader validates the bounded
single-link no-follow regular selected `.git` pointer, private `gitdir` backlink
identifying that exact selected `.git`, and private `commondir` association. The
supported layout is exactly `<common>/worktrees/<id>`, with canonical same-owner
directories and no symlink components (including raw paths before dot-dot normalization; at most 128 path components). Association records are strict UTF-8,
at most 4 KiB, one line (optional final LF), with no CR/NUL. Same-owner, regular-file,
single-link and size gates run before any association-record content read; the
no-follow open handle must independently satisfy ownership/type/link/size and
identity checks before the first read. Ownership and identity are checked again
afterward, including association re-reads. The backlink may be absolute or relative
to the selected private gitdir, following [Git v2.54.0's linking contract](https://github.com/git/git/blob/v2.54.0/worktree.c#L1026-L1051).
Its raw parent components are checked before normalization, and its final `.git`
name must identify exactly the already observed selected pointer. No guessed
backlink target is opened and no final regular file is treated as a directory.
Raw association spelling and file identity remain before/after evidence. Normal `.git` directories continue to refuse `gitdir` or
`commondir` indirection. Directory/pointer identity, bytes and change times are
rechecked before repository-content reads and in the before/after capture.
Association records alone may be read while establishing this authority; no
broad filesystem/repository search or other-worktree inventory is performed.
Ambiguous, broken, foreign-owner, changed or unsupported topology refuses.
Ownership supports association validation; explicit human selection supplies
permission. This implementation batch performed no live external-repository reads.

`extensions.relativeWorktrees` remains ordered inactive nonsecret configuration;
no source links/config or destination native links are rewritten. A common-config declaration
requires exactly one explicit common `core.repositoryFormatVersion = 1`, matching
Git's [v1-only extension rule](https://github.com/git/git/blob/v2.54.0/setup.c#L822-L856).
The bounded boolean forms are implicit true, true/yes/on/1, false/no/off/0 or an
explicit empty false value (case-insensitive words); other numeric forms refuse.
Malformed booleans and duplicate declarations within either config source refuse;
worktree-local declarations remain inert and do not determine repository format.
An absent or false setting does not invalidate a reciprocal relative association,
and true does not require the selected worktree to use relative links: Git reads
links independently, and the extension may describe another worktree. Unknown
repository extensions still refuse. Live capture and shared import/recreation/
retained-original validation enforce the same declaration rules. Fresh review
repositories remain standalone; generated review files do not become authority.

Only selected private `HEAD`, `index`, exact linked `sharedindex.<OID>` originals,
`config.worktree`, `info/sparse-checkout`, `logs/HEAD`, loose
`refs/{bisect,rewritten,worktree}/**` and matching `logs/refs` supply selected state.
Shared `config`, `packed-refs`, public `refs`, `objects`, public `logs/refs`
and exact `info/attributes` / `info/exclude` originals supply repository state. The common repository's private HEAD/index/config.worktree/patterns/HEAD
log are never used, and `common/worktrees` is never enumerated. Its directory
identity is association evidence only. Selected/shared identities and exact raw
file bytes (compared by SHA-256), provenance-tagged bounded directory inventories, complete logical
index/sparse state and required index storage must match before/after export.
Independent writers are not drained; this is observed-change refusal, not proof
of an arbitrary-writer atomic snapshot.

All native plumbing now reads an exclusive mode-0700 temporary captured view,
including for ordinary repositories. It contains only captured selected HEAD,
selected private loose refs, shared public refs/packed refs and approved bounded object-storage originals, plus a
minimal generated format-only config. Source config, config.worktree, pointers,
commondir, hooks, logs, index, sparse settings and repository-local ignore/attribute
files are never copied into its active metadata. Native startup therefore cannot discover the selected/common/ancestor
repository, resolve a live include, refresh a shared index or update a linked
backlink. Captured source config is parsed separately with the existing isolated
stdin parser with `--no-includes`; nonsecret include declarations remain inactive literals. Ref names/targets and packed
ref structure are checked before plumbing; output must include every effective
captured ref with its exact OID/symbolic target. Broken or omitted refs refuse.
Original hashes/types/graphs are checked as before. Successful temporary views
remove only known unchanged files and empty directories; failures retain private
partial copies. There is no recursive cleanup, source write or activation.

Supported object storage is regular single-link loose objects and canonical
`pack-<OID>.pack/.idx` pairs, with optional same-pack `.rev`/`.bitmap` files;
filenames must match the declared SHA-1/SHA-256 format. Raw object/control/log
originals (excluding separately bounded index/shared-index originals) together
are bounded to 32 MiB and 20,000 inventory nodes, with 1 MiB
per nonobject file and 32 MiB per object-storage file. Alternates (including HTTP
alternates), promisor/unknown object metadata, unsupported info files (ordinary commit-graph caches are observed and omitted as below), incomplete
packs, unknown repository extensions/formats and malformed packed refs refuse.
Repository format declarations must be exactly 0 or 1; objectformat requires 1.
Only objectformat/worktreeConfig repository extensions are accepted (a local
extensions.sparseindex declaration now refuses; native sparse state uses
index.sparse and the index marker);
no ignored native storage file is silently dropped. For linked selections, common
`refs/{bisect,rewritten,worktree}` and their logs are skipped by name before stat,
open or descent, including when those excluded names are links or special nodes.
Only those three namespaces are accepted beneath selected `refs`/`logs/refs`;
unknown selected storage refuses without opening its contents. Namespace roots
must be directories. Selected and shared raw inventories carry distinct source
tags; duplicate effective file paths refuse. Packed private refs, selected
`packed-refs`, ref file/directory conflicts, duplicate refs and missing/cyclic
symbolic targets refuse. Symbolic targets must be exact captured `refs/...`
names, never `main-worktree/...`, `worktrees/...` or pseudoref aliases. Public
packed refs retain normal loose overrides. All raw directories/files must be
canonical and same-owner; regular files retain no-follow, single-link and full
before/after identity checks. The existing shared server validator checks names,
OID/graph closure, symbolic targets, secrets and exact reflog bytes on export,
import and retained-original re-export. The existing DTO and callers need no
format change. Source-only implementation; no runtime equivalence claim.

The selected linked gitdir's bounded top-level name inventory accepts only the
association records, HEAD, historical ORIG_HEAD and FETCH_HEAD, index, config.worktree, info, refs, logs, the excluded
administrative `locked` record and canonical `sharedindex.<OID>` names. Only the
exact index-linked sharedindex original is read. Unknown names, unsupported
pseudorefs and operation metadata refuse; administrative ownership is not copied.

Private refs are review data, not migration of an active bisect/rebase operation.
Main-worktree private logs are excluded, not read. Unsupported selected operation metadata, unsupported shallow/partial-clone forms, grafts,
combined split/sparse storage and the existing index/sparse limits remain.
Supported split/v4/sparse originals use the selected private gitdir and verified
captured shared objects; full inactive standalone recreation is unchanged.
Submodule repository contents, general linked layouts and live activation remain
gaps. No DTO, caller, UI, transport format or destination ownership change is needed.

Native routing references: [Git repository layout](https://git-scm.com/docs/gitrepository-layout),
[Git worktree ref sharing rules](https://git-scm.com/docs/git-worktree#_refs),
[Git private/common path routing](https://github.com/git/git/blob/v2.43.0/path.c),
[Git setup](https://github.com/git/git/blob/v2.43.0/setup.c),
[Git config sequence](https://github.com/git/git/blob/v2.43.0/config.c), and
[Git files ref backend](https://github.com/git/git/blob/v2.43.0/refs/files-backend.c).
Verification for this batch is source/status/whitespace inspection only; no
native capture, tests, preparation, builds or runtime qualification was performed.

### Ordinary index flags

Explicit Git-selected export now preserves `intentToAdd`, `assumeUnchanged` and
`skipWorktree` as required boolean fields on every exact index entry. Omission,
unknown fields or nonbooleans refuse on import; flags are never defaulted away.
The bounded binary v2/v3/v4 reader checks exact original path bytes, mode, stage,
OID, main flags and extended flags. Raw storage identities/bytes and the complete
logical inventory must match before/after capture. Unknown bits, invalid encoding,
padding, checksum or layout refuse. Index names cannot supply another entry's
flags. Only stage, assume-unchanged, the extended marker, intent-to-add and
skip-worktree are interpreted; source stat fields are never destination authority.

Intent-to-add is supported at stage zero for regular/executable/symlink modes with
the original canonical empty-blob ID present in the captured object inventory.
Other intent-to-add combinations refuse rather than being converted to staged
content. Ordinary staged and unmerged entries retain their original identities.
Combinations of the supported flags remain explicit and are serialized together.
The 10,000-entry bound, required object checks, known-credential path/object refusal
and independent-writer snapshot limitations remain unchanged.

Recreation writes only the new separate review repository's exclusive index file:
assume-unchanged uses the main flags word, while intent-to-add/skip-worktree use
the version-3 extended word. If no entry needs extended flags, version 2 is kept.
Path/stage ordering, entry padding and SHA-1/SHA-256 checksum are reconstructed;
source stat/inode caches are not adopted. Nothing runs Git or grants native
worktree/settings authority. Existing files refuse; partial recovery bytes remain.
Unsupported sparse/common-directory layouts, binary layouts and other flags remain separate gaps. Supported ordinary split storage
normalizes to a full review index as described below. No native capture, tests or builds
were run for this source change.

Source references: [Git index format](https://git-scm.com/docs/gitformat-index),
[Git cache flag definitions](https://github.com/git/git/blob/master/read-cache-ll.h)
and the binary storage references below.

### Derived local commit-graph caches

Ordinary common-repository `objects/info/commit-graph` and split
`objects/info/commit-graphs` no longer block Include Git. The split directory
accepts only `commit-graph-chain` and `graph-{hash}.graph`, where the lowercase
hash has the declared SHA-1/SHA-256 width. No other names, nested directories,
lock files, symlinks, special nodes or foreign-owner/multiple-link files are
accepted. This adds no alternate store or other-worktree traversal authority.

These files use the existing canonical same-owner regular no-follow reader.
Each file is bounded to 4 MiB, subject also to the existing 4 MiB UTF-8 size bound
on known-secret inspection of its lossless Latin-1 view. They count toward the
32 MiB raw byte and 20,000-node limits. Exact directory/file identities, hashes,
and explicit absence observations for the optional info/cache/chain paths join
before/after comparison. Appearing, disappearing or observably changing data
refuses. All inspected cache bytes receive known-secret inspection. Original
source files and partial recovery copies remain untouched on failure.

The cache bodies are opaque: chain text is never followed and neither checksums,
chain completeness nor cache graph correctness are asserted. Caches are skipped
before the exclusive native read view copies object files; they never influence
Git parsing. Only independently captured and hash-verified objects, refs, logs,
index, resolve-undo, sparse and shallow data remain semantic authority. Existing
object-name/format, pack-pairing, closure and secret checks still apply. The
export records their deliberate omission in its exclusions. No cache bytes enter
the portable manifest or the separate recreated review repository, and no
native working-root metadata is installed. Original manifests remain re-export
authority; no DTO, selection or version changes are needed.

Git documents commit-graphs as [supplemental acceleration](https://git-scm.com/docs/commit-graph)
that can be rebuilt from the object database, with the above
[file layout](https://git-scm.com/docs/gitformat-commit-graph.html). Rebuilding is
not performed here. Unknown metadata, unsupported multi-pack-index names/topologies, unsupported retention layouts, reftable, promisor
and alternate stores retain their existing refusals. This is source-only
support, with no runtime/capture, round-trip, native-equivalence or arbitrary
writer atomicity acceptance.

### Derived local multi-pack-index caches

The same observation-and-omission path also accepts these exact common
repository names under `objects/pack/`:

- `multi-pack-index`;
- `multi-pack-index-{hash}.bitmap` and `multi-pack-index-{hash}.rev`;
- directory `multi-pack-index.d`, containing only `multi-pack-index-chain` and
  `multi-pack-index-{hash}.{midx,bitmap,rev}` files.

Each hash is lowercase hexadecimal of the declared SHA-1/SHA-256 width. These
names follow pinned Git v2.54.0 [filename helpers](https://github.com/git/git/blob/v2.54.0/midx.c),
[extension definitions](https://github.com/git/git/blob/v2.54.0/midx.h),
[bitmap callers](https://github.com/git/git/blob/v2.54.0/pack-bitmap.c) and
[reverse-index callers](https://github.com/git/git/blob/v2.54.0/pack-revindex.c).
The [MIDX design](https://git-scm.com/docs/multi-pack-index) keeps individual pack
indexes, so this acceleration can be omitted without losing object information.
No rebuild runs during export or import.

The existing derived-cache bounds and known-secret inspection apply unchanged:
4 MiB per raw file, a separate 4 MiB UTF-8 inspection bound for its lossless
Latin-1 view, and the shared 32 MiB/20,000-node raw limits. Canonical same-owner
directories and single-link regular no-follow files participate in exact raw
before/after identity/hash/absence observations, including optional pack,
monolithic cache, incremental directory and chain paths. Source changes refuse;
original source and partial recovery bytes remain. Other worktrees and external
stores are not read; chain text is never followed.

Bodies remain opaque: no cache checksum, chain membership/completeness or graph
validity is asserted. The shared cache-name helper rechecks declared hash width
and skips these files **before** ordinary pack pairing or native copying.
Normal `pack-{hash}.pack`/`.idx` pairing and filename checks remain mandatory;
no missing object is supplied by a MIDX. Independently verified object and
ref/log/index/REUC/sparse/shallow semantics remain authority. Export explicitly
lists the cache omission. Cache bytes enter neither the DTO, separate recreated
review repository nor native working metadata; original manifest re-export
remains unchanged. Unknown names, nested directories, locks, symlinks, special
nodes, foreign-owner/multiple-link files, alternates, promisor, unsupported retention layouts and reftable
storage still refuse. No runtime/capture, round-trip, native-equivalence or
arbitrary-writer atomicity acceptance is claimed.

### Derived dumb-transport server-info advertisements

The existing cache observation and explicit omission path also accepts exactly
common-repository `info/refs` and `objects/info/packs`. Git documents these as
regenerable advertisements for dumb transports in the pinned
[repository layout](https://github.com/git/git/blob/v2.54.0/Documentation/gitrepository-layout.adoc).
The pinned [server-info writer](https://github.com/git/git/blob/v2.54.0/server-info.c)
uses the common `info/refs` path (`update_info_refs`) and object-directory
`info/packs` path (`update_info_packs`). Their presence after ordinary
`update-server-info` or repack no longer makes otherwise supported object
storage fail export.

Both present bytes and explicit absence join raw before/after identity/hash
observations. Existing canonical same-owner directory, single-link regular
no-follow file checks, 4 MiB cache-file and lossless Latin-1 known-secret
inspection bounds, and shared 32 MiB/20,000-node raw limits apply unchanged.
Only the exact common info parent and allowlisted attributes, exclude and refs
files are inspected; its other contents are not enumerated. No selected private,
main-worktree private or other-worktree path is added. Existing private namespace
exclusions still happen before stat/descent. Grafts, alternates/http-alternates,
locks, unknown object-storage names and unsupported topologies still refuse.

Advertisement bodies remain opaque, even if stale or inconsistent. Text is
never interpreted as pack lists, refs, object IDs, paths, URLs or external
locations. The shared cache helper skips both files before native read-view
copying or pack pairing. Canonical verified local objects and refs are captured
independently; complete pack/index/retention and ref/log/index/REUC/sparse/shallow/
ORIG_HEAD/FETCH_HEAD checks remain. Export exclusions explicitly name these
rebuildable omissions. No advertisement bytes enter a DTO, original manifest,
recreated repository or native working metadata. Existing shared live/import/
recreation/re-export callers need no changes: retained-original re-export keeps
the exact original manifest and exclusions, never generated caches.

No update-server-info, repack, rebuild, network lookup, source write or ownership
adoption occurs. No cap, schema, version or dependency change. Source and partial
bytes remain preserved. Source-only: native behavior, capture, recreation,
round trips and atomicity have not been qualified.

### Pack retention originals (`.keep`, `.mtimes`)

Selected normal and linked-worktree common repositories preserve bounded exact
`objects/pack/pack-{hash}.keep` and `.mtimes` companions as **retention review data**,
not disposable caches. Git's [pack options](https://git-scm.com/docs/git-pack-objects)
use `.keep` for pack retention and cruft mtimes for expiration decisions. Empty
present `.keep` bytes remain distinct from absence. Both companions are recorded
as bytes or explicit null absence for each retained pack; a pack with neither has
no retention record. Raw capture also observes missing companions for every pack.

Required `packRetentionReview` records retain the source pack checksum identity,
exact pack and v1/v2 index bytes, exact companion bytes, and index-ordered object IDs
with unsigned epoch-second mtimes or null when the timestamp companion is absent.
The shared validator independently derives and compares that mapping on live
export, import, recreation and retained-original re-export. Exact declared
SHA-1/SHA-256 width, canonical base64, pack/header/count/trailer/self-checksum,
v1/v2 index fanout/sorted IDs/offsets/trailer/self-checksum (plus exact v2 CRCs)
and complete packed entry boundaries must agree. Each packed entry is inflated within a bound and
compared with the captured hash/secret/graph-verified canonical object, including
unreachable objects. No missing or previously pruned object is invented.

One shared decoder reads original v1 interleaved offset/OID entries and v2
separate OID/CRC/offset tables on capture and validation. Both use the declared
SHA-1 or SHA-256 width, as specified by [pack-format](https://git-scm.com/docs/pack-format#_original_version_1_pack_idx_files_have_the_following_format)
and [Git v2.54.0's hash-width-aware `load_idx` reader](https://github.com/git/git/blob/v2.54.0/packfile.c#L178-L251). Exact length, sorted unique
OIDs, cumulative fanout and pack/index checksums are required. V1 has no CRC
table: absence is explicit, never a fabricated zero CRC. Complete entry framing,
zlib consumption, pack checksum and canonical object proof still apply; v2 CRCs
remain mandatory, including a stored zero CRC. A recognized index signature with
an unsupported version refuses without falling back to v1. Malformed/mixed
layouts, duplicate offsets and out-of-pack offsets refuse.

V2 supports mixed direct 31-bit offsets and high-bit references into its trailing
8-byte network-order offset table, including small offsets encoded indirectly.
[Git's index options](https://git-scm.com/docs/git-index-pack#Documentation/git-index-pack.txt---index-versionltversiongtltoffsetgt)
can force that encoding; [the pinned writer](https://github.com/git/git/blob/v2.54.0/pack-write.c#L37-L47)
also preserves such anomalies. Exact table framing permits at most one slot per
object; every slot must be referenced exactly once, with no required reference
order. Missing, repeated, out-of-range or unused slots and partial/extra table
bytes refuse. Each 64-bit value is checked as an exact integer before conversion:
it must be safely representable and remain within the existing offset bounds
(at least 12 and below 32 MiB). Complete packed-entry checks still require an
actual entry at that offset. The table is counted once in retained evidence;
neither pack nor index size limits increase. Object-ID order and MTME mapping
remain unchanged.

Supported [MTME v1](https://git-scm.com/docs/pack-format#_pack_mtimes_files_have_the_format)
requires exact magic/version/declared hash ID, network-order length/count, index
order, corresponding pack trailer and self-checksum. The original bytes and
canonical per-object timestamps must agree. Full non-delta entries, backward OFS
deltas and REF deltas to earlier or later entries in the same complete pack are
supported, including mixed delta chains. An iterative dependency walk checks each
complete indexed base before its dependent entry, without repeated expansion;
self-references, cycles and external or missing bases refuse even when a matching
canonical object exists outside the pack. Actual offsets beyond the existing
bounded pack range and unsupported MTME forms refuse; this is not universal
pack/cruft support. Delta instructions
validate original/target sizes, copy/insert ranges, reserved opcodes and complete
output. No external base lookup or native index command is used for this check.

Limits: at most 1,000 retention packs, 10,000 entries per pack, 1 MiB per
index/companion, and 32 MiB combined canonical object plus retained evidence bytes.
Inflated bodies, decoded delta bases and reconstructed outputs share a separate
32 MiB work-byte budget; delta instructions are limited
to 10,000 per object. Existing raw capture's 32 MiB/20,000-node limits remain.
Known-secret inspection covers exact index/companion bytes through lossless
Latin-1 and the existing separate 4 MiB UTF-8 bound; decoded objects retain their
existing inspection. Canonical same-owner single-link no-follow originals and
raw before/after identity/hash/absence comparisons remain required.

Native read views copy only ordinary pack/idx object storage, omitting retention
companions. Recreation normalizes verified objects to the existing separate
inactive loose-object review repository; all retention records and original bytes
remain in `CONFIGURATION-REVIEW.json` and the canonical manifest. No `.keep`,
`.mtimes`, source pack layout or filesystem mtime is installed as active Git
metadata. No GC, repack, prune, settings, maintenance or network action follows.
This preserves retention intent for human review, not active GC/layout equivalence.
Generated review files are not re-export authority. Existing ownership/topology
refusals, source/partial retention and cleanup remain unchanged. Source-only:
no parser execution, capture, native equivalence, round-trip or atomicity acceptance.

### Ordinary shallow history

Explicit Include Git preserves the exact common-repository `shallow` original,
including its ordering, or explicit absence. Required `git.shallowReview` has
exactly `path:"shallow"`, `source:"common_repository"` and `dataBase64`.
`null` means absent; `""` means a present empty file. No working-copy, private
worktree or global substitute is read. The existing canonical same-owner
association and regular single-link no-follow reader apply. File identity,
content hash and absence join the raw before/after evidence: observed changes,
appearance or disappearance refuse while source and partial originals remain.

The shared export/import/recreation/retained-original validator accepts at most
1 MiB and 10,000 unique nonzero lowercase object IDs, one per LF-terminated
ASCII line, at the declared SHA-1/SHA-256 width. Empty-present is allowed.
Unknown fields/provenance, missing evidence, duplicate IDs, noncanonical base64,
invalid syntax, unsupported line endings/encoding and known secrets refuse.
Original bytes are never sorted, normalized or rewritten. Each declared ID must
name a captured, hash-verified commit. Only those commits may have missing
parents; parent IDs must still be well formed and any captured parent must be
a commit. Undeclared missing parents still refuse. Tree/tag/ref/reflog/index,
resolve-undo and sparse closure, object hashes and secret checks remain required.
No boundary is inferred from missing objects and no commit graph is rewritten.

This follows [Git shallow semantics](https://git-scm.com/docs/shallow): listed
commits become traversal roots while their original parent headers stay intact.
[Git repository layout](https://git-scm.com/docs/gitrepository-layout) places
`shallow` in the common repository for linked worktrees. Native capture plumbing
only enumerates captured objects and refs in its exclusive generated-config
view; it does not install shallow or graft files or consult live repository
state. No fetch, deepening, replacement or user-graft behavior is invoked.

Recreation writes the validated exact boundary exclusively at `.git/shallow`
inside the newly owned **separate review repository**. This supplies history
semantics there, never in the destination working root's native-owned `.git`.
The byte/absence record is also retained in `CONFIGURATION-REVIEW.json`; the
original manifest alone remains re-export authority, not these generated files.
Settings/hooks/filters remain inactive. Existing files refuse and failed
recreation preserves partial bytes. Ordinary bounded shallow history is covered
by source implementation; partial/promisor clones, alternates, grafts,
unsupported shallow encodings and other existing topology/storage refusals
remain unsupported. No runtime, round-trip, native-equivalence or independent
writer atomicity acceptance is claimed.

### Repository-local ignore and attribute originals

Explicit Include Git also captures exactly `info/attributes` and `info/exclude`
from the validated common repository (ordinary `.git` for a normal repository).
It never substitutes selected worktree-private files, working-copy
`.gitattributes`/`.gitignore`, global files or configured external paths. Git's
[repository layout](https://git-scm.com/docs/gitrepository-layout#Documentation/gitrepository-layout.txt-info)
places this `info` state in the common directory for linked worktrees. No other
`info` entries are enumerated or read by this family.

Required `git.infoReview` contains exactly two ordered entries: `info/attributes`,
then `info/exclude`. Each requires `source:"common_repository"` and
`dataBase64`: canonical base64 for original bytes, or literal `null` for absence.
An empty file is `""`, never absence. Unknown/extra fields, missing/duplicate or
reordered paths, wrong provenance, noncanonical base64, NUL-containing data and
unsupported UTF-8 refuse. Each original is bounded to 1 MiB (at most 2 MiB for
the pair, also within live raw-capture and manifest bounds). Valid UTF-8 BOMs,
line endings, comments and pattern/filter text remain byte-exact; no patterns or
commands are interpreted. Recognizable credentials refuse the selected export
or import with the original path identified; these files are never silently
scrubbed or dropped.

The common `info` parent must be a canonical same-owner directory or explicitly
absent. Each present file uses the existing bounded same-owner, single-link,
regular no-follow reader. Parent identity/absence and file identity/absence/hash
join raw before/after capture evidence; appearance, disappearance or observed
changes refuse. Existing association checks remain required. This detects
observed drift, without guaranteeing atomicity against arbitrary writers.

The shared semantic validator covers live export, import, recreation and
retained-original re-export. Destination `CONFIGURATION-REVIEW.json` retains the
ordered byte/absence records as inactive evidence, outside `.git`; neither the
temporary native read view nor the new review repository installs these files
at active Git paths. No filter, hook, ignore or attribute behavior is activated.
The original manifest remains the re-export source; generated review JSON is
never recaptured. Existing Include Git controls carry the added required field
without a new checkbox, storage version or dependency. This batch is source-only;
no native, runtime or round-trip qualification was performed.

### Ordinary local split-index storage

Explicit Git selection accepts bounded version-2/version-3/version-4 full or split index
originals inside the selected normal local `.git` or the reciprocally validated selected-worktree private gitdir. Capture decodes the index
checksum, entries, supported flags and complete extension boundaries directly;
it never invokes native Git to read an index. Native Git's split-index read path
freshens shared-file mtime, so the former `ls-files` diagnostic path is removed.
The existing logical index-entry fields are unchanged; sparse review extends the manifest as described below.

A `link` extension resolves only its exact `sharedindex.<checksum>` original in
that same canonical selected gitdir. No shared-file directory scan, external pointer or
other worktree inventory is performed. The shared checksum must match both its
content and the link. Complete bounded EWAH delete/replace maps are decoded;
replacement entries must have empty names and inherit the exact shared path.
Conflicting/out-of-range maps, missing replacements, duplicate resulting
path/stage entries, invalid ordering or unused extension bytes refuse. Original
mode/stage/OID and all three supported flags survive replacement/addition.

Each required index file must be a no-follow, single-link regular original of at
most 1 MiB, with observed identity/size/mtime/ctime unchanged during reads.
Before/after capture compares exact required raw files and their identities as
well as the complete logical inventory. Unreferenced shared files are neither
read nor transported. A missing required shared file or observed drift refuses.
These checks do not drain independent writers or guarantee an atomic snapshot.

Only `link`, `REUC` resolve-undo, the empty `sdir` marker and the derived `TREE`,
`EOIE`, `IEOT`, `UNTR` and `FSMN` extensions are accepted; combined split/sparse
storage refuses. TREE's complete count/length grammar is checked and its cache is
not adopted. UNTR/FSMN caches are observed and omitted as described below. Every
other extension, whether optional or required, refuses. Unknown layouts remain
unsupported. Both logical and storage entry inventories are bounded to
10,000. Resolve-undo belongs only to the selected index/overlay; any `REUC` in a
required shared base refuses, even an empty one. Base and overlay undo records
are never blended or inherited. Unsupported originals remain at source.

EOIE must be last, with exact format-width length/hash and the end-of-entries
offset found by sequential decoding. Its hash covers every preceding extension
signature/size header in order, excluding payloads and EOIE itself. IEOT version 1
must consume complete offset/count pairs: offsets match actual raw entry starts,
counts partition all entries in order, and block count is bounded by entry count
plus one. Neither extension supplies parsing authority. Each v4 block start must
discard the entire preceding path and carry its full path suffix; sequential
decoding therefore handles native block restarts without seeking or guessing.
The pinned writer can produce a version-only IEOT for an empty index and one
leading zero-count block after removed entries; these are accepted. Other empty
blocks, missing coverage, duplicate extensions, malformed offsets/hashes/grammar
and unsupported versions refuse.

These checks apply independently to each required physical index file, including
selected split overlays and their exact shared base. They never use merged
logical offsets or inherit an accelerator from another file. Git writes these
accelerators even for shared storage; the existing shared-base REUC and
combined split/sparse refusals remain. Raw files and before/after checks remain
unchanged. No DTO or transport version change is needed: only validated logical
user data travels into the manifest; derived layout is omitted on recreation.

Format references: [EOIE and IEOT](https://git-scm.com/docs/gitformat-index#_end_of_index_entry)
and [pinned Git v2.43.0 writer/reader](https://github.com/git/git/blob/v2.43.0/read-cache.c)
(`do_write_index`, `ce_write_entry`, `write_eoie_extension`,
`write_ieot_extension`). This is source-only support, without native or runtime
qualification.

Recovery writes the existing exclusive **full** v2/v3 review index into a new
inactive standalone review repository. Split/shared storage layout, raw stat
cache values, shared-file timestamps and derived cache extensions are deliberately not
reproduced. This is logical index recreation, not byte-identical storage
recreation. Original/partial recovery retention, credential refusal and inactive
configuration/ownership behavior are unchanged. No native capture or runtime
qualification was performed for this batch.

Source references: [Git index and split-index format](https://git-scm.com/docs/index-format),
[Git split-index merge](https://github.com/git/git/blob/master/split-index.c),
[EWAH serialization](https://github.com/git/git/blob/master/ewah/ewah_io.c) and
[shared-index read/freshening](https://github.com/git/git/blob/master/read-cache.c).

### Optional index observation caches (`UNTR`, `FSMN`)

The existing bounded index reader accepts exactly the optional untracked-cache
(`UNTR`) and filesystem-monitor-cache (`FSMN`) signatures. Each body is opaque:
no cache path, environment string, monitor token or bitmap is interpreted,
followed, used as a file list or treated as current filesystem proof. No monitor,
hook or environment lookup runs. This does not validate cache versions or internal
grammar. The [Git index format](https://git-scm.com/docs/gitformat-index#_untracked_cache)
describes these optional observation accelerators; their contents can be discarded
and rebuilt locally without replacing the directly decoded logical index entries.

Whole-index header, checksum, 10,000-entry and 1 MiB physical-file limits remain.
Extension framing, body-size and duplicate-signature checks run before omission;
EOIE still hashes their headers in sequence. Each inspected body receives the
existing known-secret check through lossless Latin-1 bytes, with its separate
4 MiB UTF-8 inspection bound. The same handling applies independently to full
indexes, split overlays and required shared originals. Exact raw index/shared-index
identities and bytes still participate in before/after comparisons.

Export exclusions explicitly report omission. No cache bytes enter the portable
DTO, native read view, recreated inactive full index or retained-original manifest
re-export authority. Real paths, modes, stages, OIDs, supported flags, REUC, sparse
and offset-table checks remain unchanged, as do unknown-extension and split/sparse
topology refusals. No source index is copied or written, and no destination cache
or monitor is activated. Source/partial retention and cleanup are unchanged.
Source-only implementation; no runtime, capture/recreation, round-trip, native
equivalence or atomicity qualification.

### Version-4 full and split index paths

The same direct reader accepts v4 originals in either the main index or its exact
required shared index. Each physical file starts with an empty previous byte path.
For each entry, the bounded Git offset-varint specifies bytes removed from that
previous path; the NUL-terminated suffix supplies the rest. Arithmetic uses the
Git continuation increment, with at most five prefix bytes, complete termination
and removal no greater than the previous byte length. V4 consumes no v2/v3 padding.
Reconstructed byte length must match the stored flags length (or its 0xfff cap),
be at most 1 MiB per path and at most 32 MiB summed across each file's entries.
Existing 1 MiB original-file and 10,000-entry bounds still apply. Reconstruction
uses bytes before strict UTF-8 round-trip validation, so multibyte boundaries are
never interpreted as character counts. Unsupported encodings refuse.

Full entries, empty-name split replacements and shared originals reuse the same
mode/stage/OID/flag checks, exact shared checksum association, ordering, extension
consumption, no-follow identity and before/after storage/logical checks. Malformed
prefixes, overlong removals, missing terminators, invalid decoded paths/lengths,
unknown extensions and observed drift refuse without source writes or native
index-reading commands. Supported sparse checkout/directory forms and reciprocal
linked-worktree authority use this same v4 reader under the separate contracts
above and below; combined split/sparse storage, unsupported sparse forms and
unassociated external repository authority still refuse. Destination storage stays the existing inactive standalone
full v2/v3 index: v4 compression and source stat/cache layout are not reproduced.
No tests, native capture or runtime qualification were performed for this batch.

References: [Git v4 index format](https://git-scm.com/docs/index-format) and
[Git offset-varint implementation](https://github.com/git/git/blob/master/varint.c).

### Resolve-undo conflict recovery data

Include Git now preserves the supported `REUC` extension from ordinary v2/v3/v4
index originals and the selected overlay of supported split storage. This saves
the former conflict stages for later review; it does not replay a merge, change
working files or migrate an in-progress operation.

The existing version-1 reviewed Git manifest requires `resolveUndo`, an array of
`{path,stages}` records. Each stage is `{stage,mode,oid}` with stage 1, 2 or 3.
Missing stages are absent from that list, not represented by invented hashes or
content. `[]` means no saved undo entries; missing fields refuse rather than
defaulting away recovery data. No new selection control, DB schema, transport
version or dependency is introduced. The canonical shared server validator is
used by live export, manifest import and exact retained-original re-export; Shared
composition carries the same manifest bytes and the same import validation.

The direct index reader consumes the complete extension: a strict UTF-8,
round-trip-exact NUL-terminated path, exactly three NUL-terminated canonical octal
modes, then only the fixed-width hashes for present stages in stage order. A
missing mode is exactly `0`; present modes are `100644`, `100755`, `120000` or
`160000`. Unknown modes, leading-zero variants, zero object IDs, missing hashes,
trailing malformed bytes, empty/all-missing records, duplicate extension signatures
or duplicate/unordered paths refuse. Paths follow the existing index path rules,
are at most 1 MiB each, and use unsigned UTF-8 byte ordering. Stage lists must be
strictly increasing and have one to three entries. Resolve-undo is bounded to
10,000 paths and 1 MiB encoded extension data within the existing 1 MiB original
index-file bound. Whole manifest/package limits still apply.

Known credential paths or recognizable secrets in undo paths refuse the whole
selection. Every regular/executable/symlink stage must reference a captured blob;
object hashes, known-secret inspection and complete captured graph closure use
the existing validation. Gitlink stages retain their exact object IDs, but
submodule repository content is not fabricated. Undo paths need not have a current
index entry: conflict resolution may have removed the file. No relationship to
current index stages or resolved content is invented.

Capture compares complete original index/shared-index bytes and identities plus
the decoded logical undo inventory before and after, alongside the existing
index/sparse/ref checks. The isolated Git view still receives no source index;
no native index reader or source write is added. Import writes canonical `REUC`
bytes, extension length and final SHA-1/SHA-256 checksum only in the new inactive
standalone review repository's exclusive full v2/v3 index. An empty semantic array
needs no extension in that reconstructed index. Source stat/cache/layout authority
is not adopted; existing files refuse and source/partial recovery bytes remain.
Retained-original re-export keeps the exact original manifest bytes and never
uses a generated review index as its source. This is source-only implementation;
tests, native capture/recreation and round trips were not run.

References: [Git resolve-undo format](https://git-scm.com/docs/gitformat-index#_resolve_undo),
[pinned Git v2.43.0 resolve-undo reader/writer](https://github.com/git/git/blob/v2.43.0/resolve-undo.c),
and [pinned full/split extension ownership](https://github.com/git/git/blob/v2.43.0/read-cache.c)
(`write_shared_index` uses `WRITE_NO_EXTENSION`; the selected split overlay writes
the extensions). These are format references, not runtime qualification.

### Selected-worktree previous HEAD

Include Git retains exactly the selected gitdir's `ORIG_HEAD` and optional
`logs/ORIG_HEAD` as one required `origHeadReview` record:
`{path:"ORIG_HEAD",source:"selected_worktree",dataBase64,reflogDataBase64}`.
Each byte field is canonical base64 or explicit null absence; an empty-present
log stays distinct from absence. A log can survive without a current pointer.
For linked selections neither the common main worktree's corresponding files nor
other worktrees are inspected. The already validated reciprocal association
continues to define the selected gitdir.

[Git documents ORIG_HEAD](https://github.com/git/git/blob/v2.54.0/Documentation/revisions.adoc)
as the saved previous HEAD from commands such as reset, merge and rebase;
its presence alone does not mean an operation is unfinished. The pinned
[file backend](https://github.com/git/git/blob/v2.54.0/refs/files-backend.c)
reads direct IDs or `ref:` symbolic records, while
[root-ref routing](https://github.com/git/git/blob/v2.54.0/refs.c)
keeps them worktree-local. This transport supports canonical UTF-8 regular-file
records only: one lowercase nonzero full-width SHA-1/SHA-256 ID followed by LF,
or `ref: refs/...` followed by LF, within 4 KiB. Noncanonical whitespace,
extra lines, BOMs, abbreviated IDs and other root aliases refuse rather than
being normalized. A symbolic binding must resolve through the exact captured
ref chains, with matching IDs and no missing or cyclic targets. The resulting
object must be captured and verified even if otherwise unreachable; pruned
objects are never fabricated or fetched.

The optional log shares the ordinary strict reflog entry/object/secret validator
and its aggregate byte, entry and inventory bounds below. A current tip or
continuity is not invented from historical entries. Both files use canonical
same-owner, single-link, no-follow regular reads and raw identity/hash/absence
before-after comparisons, within the existing whole-capture budget. Unknown
records and unfinished-operation holds remain unchanged.

Shared live/import/recreation/retained-original validation preserves this exact
record and provenance. Both files are skipped before native read-view copying.
Recreation retains the record only in inactive `CONFIGURATION-REVIEW.json` and
the original manifest, never active `.git/ORIG_HEAD` or `.git/logs/ORIG_HEAD`.
Generated review files are not re-export authority. No reset, replay, recovery,
source repair or ownership adoption occurs. Source-only: no parser/native/runtime,
capture, recreation, round-trip or atomicity qualification.

### Selected-worktree fetched heads

Include Git also requires `fetchHeadReview`:
`{path:"FETCH_HEAD",source:"selected_worktree",dataBase64}`. It retains exactly
the selected gitdir's `FETCH_HEAD` bytes as canonical base64, or explicit null
absence. Empty-present is distinct from absent. Ordinary and already validated
linked selections use the same selected-gitdir scope; corresponding main/common
or other-worktree files are not inspected. Existing canonical same-owner,
single-link, no-follow reads and raw identity/hash/absence before-after evidence
apply. The existing 1 MiB control-file, 10,000-record and 32 MiB whole raw-capture
bounds are retained, without increasing caps.

[Git fetch documentation](https://github.com/git/git/blob/v2.54.0/Documentation/git-fetch.adoc)
and the pinned [fetch writer](https://github.com/git/git/blob/v2.54.0/builtin/fetch.c)
(`append_fetch_head`, `store_updated_refs`) establish a list, not one ordinary
ref: each supported UTF-8 record is a lowercase full-width nonzero SHA-1/SHA-256
OID, TAB, an empty or `not-for-merge` marker, TAB, opaque note, LF. Zero records
are valid. Record order and repeated entries survive unchanged, including
appended records; no match to current refs or ordering of merge markers is
required. Only the first two tabs frame fields. Notes may contain further tabs
or carriage returns; NUL, malformed UTF-8, BOMs, incomplete lines, unsupported
markers and invalid IDs refuse. The writer escapes URL newlines as literal
backslash-n, which remains exact text. Notes, URL spellings, paths and refnames
are never interpreted, followed or activated. Known-secret checks apply to the
whole original, so recognizable credentials refuse rather than being rewritten.

Every record requires its exact captured, hash/type/graph-verified local object,
including otherwise unreachable objects; missing or pruned objects refuse.
The writer classifies objects that cannot peel to a commit as `not-for-merge`;
the pinned [merge consumer](https://github.com/git/git/blob/v2.54.0/builtin/merge.c)
(`handle_fetch_head`) consumes empty-marker entries as merge parents. Accordingly,
empty-marker objects must resolve through captured noncyclic tag targets to a
commit; `not-for-merge` entries can name any supported verified object type.
No current ref, current tip or operation authority is invented from these records.
`FETCH_HEAD` may survive a completed fetch; existing unfinished-operation holds
remain unchanged.

Shared live export, parsed import, recreation and retained-original re-export
validation requires this exact record and provenance, rejecting missing/unknown
fields. Syntax is checked before native reading, and FETCH_HEAD is skipped before
private native read-view copying. Existing all-local-object enumeration retains
otherwise unreachable objects. Recreation stores this record only in inactive
`CONFIGURATION-REVIEW.json` and the original manifest, never active
`.git/FETCH_HEAD`. Existing shared callers need no change: they already invoke
the same validator. No fetch, pull, merge, reset, replay, source repair, ownership
adoption or schema/version/dependency change. Original and partial bytes remain
preserved. Source-only: native behavior, capture, recreation, round trips and
atomicity have not been qualified.

### Selected local reflogs

The explicit Git checkbox/API selection now includes ordinary local `.git/logs/HEAD`
and `.git/logs/refs/*`. No reflog is read when Git is not selected. The required
`git.reflogs` array (separate from historical `origHeadReview`) contains `{path,dataBase64}` entries relative to `logs/`.
An empty array records absent/empty local inventory; omission refuses rather than
claiming complete capture. The existing package artifact, hash, full-history
warning, byte codec and import preview carry these originals unchanged.

Each file preserves exact UTF-8 bytes, oldest-to-newest physical entry order,
old/new object IDs, user name/email, original timestamp/timezone and message.
No identity, timestamp, message or object relationship is rewritten. Every nonzero
old/new ID must exist in the captured object inventory, which already includes
unreachable/reflog-only objects and validates their graph closure. Zero IDs are
allowed at either endpoint for creation/deletion, but not both. Logs may remain
for deleted refs: a current ref is not required and entry continuity is not
invented. Recognized credentials anywhere in the raw log refuse the whole selection.

Supported entry syntax is two lowercase SHA-1/SHA-256 IDs, a nonempty name and
nonempty whitespace-free email in angle brackets, a 1–16 digit nonnegative Unix
timestamp, signed four-digit timezone (hours 00–23/minutes 00–59), a tab and a
possibly empty single-line message, terminated by LF. Control bytes, invalid UTF-8,
unterminated/unknown forms, unknown log paths, links, hardlinks, special files,
missing objects (including expired/pruned originals), lock files and external
worktree logs refuse. This narrow contract does not normalize older/other formats.

Reflogs have a 1 MiB/file, 32 MiB total, 10,000 total entry and 10,000 inventory-node
bound; path length is at most 1,024 characters. Existing 48 MiB manifest/package
limits can refuse a smaller combined selection. Capture reads canonical private
regular originals with no-follow/exact file identity checks, checks directory
identity/change times while walking, then compares complete sorted inventories
and bytes in the existing before/after snapshot. Independent writers are not
drained; these checks do not prove an arbitrary-writer atomic snapshot.

Import validates logs and object relationships before creating the review repository,
then writes the original bytes exclusively under its new `.git/logs`. It never
writes into the active destination repository, appends current identities, runs
Git or activates source hooks/settings. Existing files refuse and partial recovery
bytes remain. Supported linked selections combine selected private `logs/HEAD`
and `logs/refs/{bisect,rewritten,worktree}/**` with shared public `logs/refs`.
Main-worktree HEAD logs and common private ref logs are excluded before descent
or opening. Historical logs whose objects are unavailable remain unsupported. No tests or native capture/recreation
were run for this source change.

### Bounded TOML syntax

The shared `scrubReviewToml` reader handles selected `.codex/config.toml` and top-level
project `.codex/agents/*.toml` live export and imported-manifest validation. Accepted nonsecret source spans stay
byte-for-byte unchanged. Recognized secret-key assignments are removed as
whole spans, including multiline payload, trailing comment and terminating newline;
`removedSecretFields` records removals, including nested members and credential
namespaces described below. Import refuses any such retained known-secret field.
Decoded nonsecret strings also pass existing recognizable-secret inspection, so
supported escapes cannot bypass it. Arbitrary disguised credentials remain outside
that inspection guarantee.

The supported string subset follows [TOML 1.0 strings](https://toml.io/en/v1.0.0#string):
basic/literal single-line and multiline strings, valid basic escapes and Unicode
scalar escapes, initial newline trimming, multiline basic line continuation and
one/two quotes inside multiline strings. Three-to-five closing quote runs are
handled explicitly. Source CRLF stays unchanged; decoded inspection normalizes
newlines. Comments and delimiter-like text inside strings are not declarations.
Basic/literal quoted keys, supported basic escapes and dotted paths are accepted
in assignments, static table headers and inline members. Multiline keys refuse.
Separators inside quotes are key contents; identity and credential checks use
decoded segments, so equivalent escaped/bare spellings cannot bypass duplicates
or secret filtering. Duplicate keys/tables, value/table collisions,
invalid escapes/controls, unterminated strings and trailing syntax refuse.

Other accepted scalars include booleans, signed 64-bit decimal integers, unsigned
hex/octal/binary integers within the positive signed-64 range, finite decimal/
exponent numbers and lowercase optionally signed `inf`/`nan` tokens. [Arrays](https://toml.io/en/v1.0.0#array) and
[inline tables](https://toml.io/en/v1.0.0#inline-table) may nest supported values.
Arrays accept mixed types, layout comments/newlines and a trailing comma. Inline
tables allow horizontal layout whitespace, no layout comments/newlines and no
trailing comma; multiline strings/arrays inside values retain their own rules.
Duplicate inline member keys refuse, including equivalent bare/quoted spellings.
Assigned inline tables are closed: later static table extension refuses.

Namespace bookkeeping distinguishes implicit static parents, explicit headers,
dotted-key tables and closed assigned values. An implicit parent may later receive
its own header; duplicate explicit/dotted redefinition and scalar/closed-table
extension refuse. Dotted assignments cannot reopen explicitly declared tables,
while new static subtable headers under dotted-key parents are supported. Dotted
inline members share the same collision checks within their closed local namespace.
Array-table declarations append ordered independent elements; static/nested array
headers traverse the latest defined parent element. Namespace checks include every
element. Static-array append, table/array conversion, closed-value extension and
retroactive conversion of an implicit parent into an array refuse. Source order and
bytes carry the elements; parsed namespaces are inspection-only.
Any decoded secret key segment removes its complete assignment or inline member,
including an entire credential subtree. Inline tables retain nonsecret siblings
and their exact key/value source spans; only removed members and the necessary
adjacent separators/layout are cut. Nested inline tables inside arrays use the
same reader. A table emptied by these removals remains a valid empty inline table;
array elements and their order remain intact.

Static and array-table headers containing a secret segment, their assignments and
intervening comments/layout are omitted until the next header. Each new header is
classified by its complete decoded root path, including credential ancestors;
nonsecret headers and siblings remain. Original namespace registration continues
for discarded declarations and every array-table element. Later headers still
traverse the latest parent element, and removed namespaces cannot bypass duplicate
or type-conflict checks. No discarded value is decoded into diagnostics.

Every removed value still passes the complete supported grammar, nesting/count
bounds and original duplicate/namespace validation before any output is assembled.
Retained string leaves receive decoded recognizable-secret inspection, including
leaves nested in arrays or inline tables; discarded credential leaves are parsed
without credential diagnostics. The remaining raw-text scan is unchanged. Live
export and import validation share this scrubber; import rejects known-secret
members/namespaces rather than silently sanitizing the supplied manifest.
Retained-original re-export uses only the validated sanitized original, so removed
fields cannot return. No settings, environment references, hooks or grants activate.
This change is source-only; parser execution and round trips were not performed.

Offset/local date-times, local dates and local times accept valid Gregorian
calendar days (four-digit years), hours 00–23, minutes/seconds 00–59 and numeric
offsets with hour/minute bounds. Date/time separators may be `T`, `t` or one space;
UTC `Z`/`z` and fractional seconds of 1–9 digits are supported. No `Date`, timezone
conversion, floating NaN/Infinity serialization or source normalization occurs.
Leap seconds, fractional precision beyond nine digits, overflowing decimal floats
and malformed grammar still refuse. This bounded reader is not parser-certified
or a claim of universal TOML acceptance. Input
is capped at 1 MiB, 64 static table segments, 10,000 outer statement/line iterations,
10,000 total value nodes (including containers), 10,000 namespace nodes
(including inline roots and every array-table element), 64 decoded segments per key path and 32 nested value levels below
the root. Parsing advances through bounded source spans and visits each value
once; namespace checks use segment maps, with root-relative static/assignment paths
capped at 64 segments. Existing decoded-inspection/package bounds, inactive settings and source
retention remain. No dependency or runtime qualification is introduced.

Harness selection means the listed project-root configuration families below;
it never reads the host home profile. Unsupported global/native settings are
outside that selection. Initially absent fixed files or family roots are absent, not invented defaults; discovered entries disappearing fail.
History can contain sensitive user data: the existing full-export warning still
applies. Recognized credential data refuses or is explicitly removed from settings.

`ReviewedUserDataSelection`, `ReviewedUserData` and `ReviewedGitUserData` in core define the internal transport.
`parseReviewedUserData` validates it before destination creation. The import keeps
the manifest and provider configuration inert. When Git data exists, it recreates
a separate repository at `.ponderosa-portable-review/git-repository`, including
its own new `.git`; it never overwrites the destination working root's native Git
metadata or installs provider settings. No checkout, hooks, filters, provider,
credential helper or Git command runs during recreation. Recovery originals and
partial files remain if creation fails. This is a usable review repository, not
automatic adoption into the destination's active Branch/worktree.

Sanitized settings and exact accepted non-settings provider text also recreate as nonexecutable `N.review` files
under `.ponderosa-portable-review/provider-files`, with an original-path mapping in
`manifest.json`. Humans can read the actual retained configuration without base64
decoding. Original `.claude`/`.codex` paths are not installed; settings activation
still requires separate human review/action.

| Field | Implemented disposition |
| --- | --- |
| `git.format`, `objects[].{oid,type,dataBase64}` | SHA-1/SHA-256 exact decoded object bytes. Hash includes Git type/length header; commit/tree/tag edges and staged blob originals must exist, except missing parents of explicitly validated shallow commits. Supported normal local `.git` and the explicit reciprocally validated selected-worktree/common-directory association above only. Associated shared objects are explicitly authorized by Include Git; unassociated external/common directories and alternate object stores refuse. All objects, including unreachable objects, receive known-credential inspection; a recognizable credential refuses the selection instead of rewriting Git identity. |
| `git.refs[].{name,oid,symbolic}`, `head` | Original branch/tag/other ref names, object IDs and symbolic/detached HEAD preserved. Fresh loose refs in the review repository. Source worktree pointers, branch ownership, lock and lifecycle receipts never travel. |
| `git.origHeadReview.{path,source,dataBase64,reflogDataBase64}` | Required exact selected-worktree `ORIG_HEAD` and optional matching log bytes or explicit absences. Canonical direct/symbolic binding and historical log endpoints require captured verified objects/refs. Remains inactive in `CONFIGURATION-REVIEW.json`; see [previous HEAD contract](#selected-worktree-previous-head). |
| `git.fetchHeadReview.{path,source,dataBase64}` | Required exact selected-worktree FETCH_HEAD bytes or explicit absence. Ordered/repeated LF records retain native markers and opaque notes; every OID requires captured verified objects, and mergeable entries peel to commits. Inactive CONFIGURATION-REVIEW.json only; see [fetched-head contract](#selected-worktree-fetched-heads). |
| `git.index[].{mode,oid,stage,path,intentToAdd,assumeUnchanged,skipWorktree}` | Fresh v2/v3 review index retains exact original stage 0–3 identities, paths and file/executable/symlink/gitlink modes plus the three explicit flag booleans. Intent-to-add remains intent, not staged content. Original stat caches, uid/gid/inodes and filesystem monitor data are not copied. Ordinary staged/unmerged content is retained. Supported local v2/v3/v4 split storage normalizes to this full index; unknown flags/extensions and unsupported sparse forms refuse; supported sparse-directory trees expand from verified captured objects only. |
| `git.shallowReview.{path,source,dataBase64}` | Required exact common-repository `shallow` bytes or explicit null absence (empty-present stays distinct). Bounded canonical ASCII/OID validation requires captured verified commits; only those commit parents may be missing. Recreated exclusively as `.git/shallow` inside the new separate review repository, with original bytes retained for re-export. No native working-root adoption, fetch/deepening, grafts or partial/promisor support; source-only, runtime unverified. |
| `git.infoReview[].{path,source,dataBase64}` | Required path-ordered `info/attributes`, `info/exclude` records from `common_repository`, with exact bounded original bytes or explicit null absence. Shared validation refuses unknown paths/provenance, malformed encoding, known secrets or missing evidence. Recreated only as inactive records in `CONFIGURATION-REVIEW.json`, never active Git info files; generated review copies are not re-export authority. |
| `git.packRetentionReview[]` | Required sorted source-pack retention records: pack identity and exact pack/v1-or-v2-index/keep/MTME originals plus independently checked index-ordered OIDs/mtimes. Empty keep differs from absence. Retained only as inactive evidence; see [supported layouts and limits](#pack-retention-originals-keep-mtimes). No active GC policy or destination pack layout. |
| `git.configurationReview[].{key,value,implicitBoolean?,source?}` | Nonsecret local configuration is retained as ordered inert review entries, including repeated keys, valueless booleans and hook/fsmonitor command text. Optional `source:"config.worktree"` distinguishes exact local worktree settings; omitted source means local `config`. Local include/includeIf declarations survive as ordered inactive literals from exact common config or selected config.worktree, with target resolution disabled; external contents are uncollected and never supply effective settings. All credential-helper/username fields and password/token/authorization/extra-header fields and source core.worktree metadata are excluded. `extensions.worktreeConfig` and sparse booleans survive only as inactive review entries. URL userinfo is refused from the retained configuration. Source configuration is never installed as executable destination config. |
| Git selected merge-message original | Explicit Git selection carries optional exact selected-gitdir `MERGE_MSG` through inactive `.git/MERGE_MSG` only when all existing export holds pass. Presence or absence proves no quiescence; no active recovery. See [contract](#inactive-selected-git-merge-message-original). |
| Git selected tag-message draft | Explicit Git selection carries optional exact selected-gitdir `TAG_EDITMSG` through inactive `.git/TAG_EDITMSG`. No tag/sign/editor continuation or active installation. See [contract](#inactive-selected-git-tag-message-draft). |
| Git selected squash-message draft | Explicit Git selection carries optional exact selected-gitdir `SQUASH_MSG` through inactive `.git/SQUASH_MSG`, alongside `COMMIT_EDITMSG`. No message interpretation, operation continuation or active installation. See [contract](#inactive-selected-git-squash-message-draft). |
| Git common recovery originals | Explicit Git selection carries optional common `lost-found/` UTF-8 files through inactive `.git/lost-found/...` records, including existing `commit/`, `other/` and supported custom descendants. No regeneration or active installation. See [contract](#inactive-common-git-lost-found-originals). |
| Git dormant resolution cache and commit draft originals | Explicit Git selection carries optional common `rr-cache/` UTF-8 originals and only the exact selected-gitdir `COMMIT_EDITMSG` through inactive `.git/rr-cache/...` and `.git/COMMIT_EDITMSG` records. No replay, editor, operation recovery or active installation. See [contract](#inactive-common-rerere-and-selected-commit-draft-originals). |
| Git legacy common remote shorthand originals | Explicit Git selection carries optional common `branches/` and `remotes/` regular UTF-8 originals through inactive `.git/branches/...` and `.git/remotes/...` records. No native remote installation or syntax/version compatibility claim. See [contract](#inactive-common-legacy-git-remote-originals). |
| Git fixed common Gitweb metadata originals | Explicit Git selection carries only optional common `description`, `category`, `cloneurl` and `README.html` as exact inactive `.git/{name}` originals. Empty present files survive; no HTML rendering, URL fetching or native Gitweb recreation. See [contract](#inactive-fixed-common-gitweb-metadata-originals). |
| Git default common hook/support originals | Explicit Git selection carries bounded regular UTF-8 originals from the validated common repository `hooks/` through `providerFiles` as virtual `.git/hooks/...` paths, never active hooks. Configured `core.hooksPath` targets are not followed; their nonsecret setting remains inactive configuration text. See [scope and limits](#inactive-default-common-git-hook-originals). |
| `providerFiles[].{path,dataBase64,removedSecretFields}` | Existing inert-original carrier: `.git/hooks/...`, `.git/branches/...`, `.git/remotes/...`, `.git/rr-cache/...`, `.git/lost-found/...`, exact selected-worktree `.git/COMMIT_EDITMSG`/`.git/SQUASH_MSG`/`.git/TAG_EDITMSG`/`.git/MERGE_MSG` and the four fixed common Gitweb metadata records (`.git/description`, `.git/category`, `.git/cloneurl`, `.git/README.html`) require explicit Git selection and its required Git manifest; other provider records require harness selection. Git hook/support, legacy remote, dormant resolution/draft, lost-found recovery and Gitweb metadata originals preserve exact accepted UTF-8 bytes/BOM with `removedSecretFields: false`. Supported project-root Claude/Codex/MCP settings, instructions (including optional selected-root `.claude/AGENTS.md`) and custom commands/agents/skills/rules remain inactive review data. Only `.mcp.json`, `.claude/settings.json` and `.claude/settings.local.json` receive structural JSON secret removal. All selected non-settings text preserves exact accepted UTF-8 bytes/BOM regardless of extension; recognizable secrets refuse rather than rewriting originals. Codex TOML uses the shared [bounded structured reader](#bounded-toml-syntax): recognized credential assignments, inline members/subtrees and table namespaces are removed after full original validation; accepted nonsecret sibling source spans survive. Import enforces the same grammar and rejects retained known-secret fields. Unsupported forms or remaining recognizable credentials refuse. No commands, hooks, permissions or servers are activated. |
| `git.sparseReview.{patternsBase64,directories}` | Required explicit inactive data: exact local `info/sparse-checkout` bytes (or literal null when absent) and original collapsed directory path/mode/stage/OID/flag records. Import re-expands verified trees and requires exact equality with the covered full logical index; no pattern matching, settings installation or sparse activation. |
| `exclusions` | Explicit format/credential/ownership limitations, without secret values. An exclusion is not evidence that the data is unnecessary. |
| `recreationScope.absoluteLinks/crossRootLinks/specialNodes` | Required literal `refuse`; no external authority, dereference or conversion to regular bytes. |
| `recreationScope.cyclicLinks` | New exports declare `passive_in_root`; old `refuse` remains accepted and enforced before destination writes. Working-folder `cyclicLinks` independently declares the same supported policy; missing policy means `refuse`. Both contracts must permit any cycle. |
| `recreationScope.acl/xattrs` | Required literal `not_inspected_preserve_source`. Current host file API does not inventory or reproduce ACL/xattrs. Import refuses a manifest claiming stronger semantics. Ordinary modes/mtime do not establish equivalent access rules or metadata. Source retention remains necessary wherever these attributes matter. |

Project-root `.mcp.json` and recursive regular custom `.claude/rules` files use
only the explicit harness selection and the same bounded, canonical-parent,
no-follow original reader and import whitelist as other provider review files.
MCP JSON uses recursive known-secret field removal; remaining nonsecret server
settings survive, and remaining recognizable credentials refuse. Rule originals retain exact accepted UTF-8 bytes/BOM regardless of extension; support JSON is not settings. Rule text and
accepted literal environment references remain uninterpreted: no expansion,
rule-import traversal, home-profile reads, server connections or tool grants.
Links and special nodes refuse. Import preserves original path mappings in
nonexecutable numbered `.review` files, never active `.mcp.json` or rules.

Ordinary selected-file export/import refuses any `.mcp.json` path component,
just as it refuses `.claude` native paths. Whole-folder inventory records those
paths in `excludedPaths` and does not read them through the ordinary file lane;
selecting harness review data separately includes only the supported sanitized
project-root original. Nested `.mcp.json` files remain excluded, not captured as
project-root settings. Source and partial recovery bytes remain retained.
See Claude's [project MCP scope](https://code.claude.com/docs/en/mcp) and
[project rules](https://code.claude.com/docs/en/memory) for the native locations;
this transport does not install or execute their contents.

Sparse checkout is captured for normal local `.git` and the supported reciprocal linked-worktree association below. Exact pattern
bytes preserve cone/noncone text, comments, order and final-newline state; they
are bounded UTF-8 review text, with no NULs and no recognized credentials. Missing
patterns remain null, not an invented empty file; enabled sparse checkout without
a pattern original refuses. Shared repository `config` and selected private `config.worktree` are bounded no-follow originals; selected private `info/sparse-checkout` supplies patterns. The main worktree configuration/patterns are never substituted for selected private files. The existing read-only Git config parser
receives their captured bytes on stdin with includes disabled. Parsing runs in a
fresh private empty temporary directory, with both process cwd and `-C` there;
its canonical parent is the Git discovery ceiling, so neither the selected nor
an ancestor repository supplies startup configuration. A ceiling path containing
a platform path-list separator refuses instead of weakening discovery isolation. Explicit `--no-pager`
disables pager-config discovery before command dispatch; a fresh allowlisted
environment clears inherited Git/trace/config/alias/pager overrides, disables
system/global files and reads only stdin for the requested enumeration. Only an
empty parser directory is removed afterward; unexpected bytes are retained and
cleanup refuses. No source configuration bytes are written to the parser directory. Ordered nonsecret
entries, original values, implicit booleans and source scope survive; source
formatting and credential fields are not copied. Nonsecret include/includeIf declarations
survive as inactive ordered literals; `--no-includes` prevents targets or conditions
from supplying sparse meaning. Home profiles are never selected. Linked/common directories require the separate reciprocal Git authority above. Worktree sparse values require an explicit local
`extensions.worktreeConfig` setting; true applies worktree precedence only for
validation, false retains those values as dormant review data.

Supported sparse directories require mode `40000`, stage zero, a trailing slash,
skip-worktree true, intent-to-add and assume-unchanged false, the empty `sdir`
extension, and explicit enabled sparse/cone settings. Their exact original
records remain in `sparseReview.directories`. Every captured object hash, type and
graph is validated before expansion. Only those original tree/blob objects supply
full logical paths, modes and OIDs; no working-file reads, pattern interpretation,
Git index command or invented content fills missing entries. Normal entries
retain their three flag booleans and staged identities; derived tree leaves are
stage zero and skip-worktree, without intent-to-add or assume-unchanged. Directory
flags outside this supported native form refuse. Import revalidates the tree
expansion against every covered full-index entry and refuses overlaps, duplicate
paths/stages, file/directory conflicts or merged/unmerged collisions.

Expansion is bounded to 128 tree levels, 10,000 visited trees and 10,000 logical
entries with 32 MiB cumulative path bytes; pattern and each raw config/index
original are bounded to 1 MiB. Unknown boolean forms (beyond implicit true,
true/yes/on/1 and false/no/off/0/empty), missing or unordered tree originals,
unsupported extension payloads and combined split/sparse storage refuse. Noncone
checkout with an ordinary full index is supported without interpreting patterns;
a noncone sparse-directory index refuses. These are supported-data limits, not
permission to discard required originals. Gitlink identities survive, while
submodule repository content remains a gap.

The fresh review repository always receives the full v2/v3 logical index.
`CONFIGURATION-REVIEW.json` retains `sparseReview` and scoped nonsecret settings;
no active `info/sparse-checkout`, `config.worktree`, sparse config setting or
`sdir` storage is installed. Raw sparse storage, stat caches and tree caches are
normalized, never adopted as destination ownership. Exact before/after raw and
logical snapshots plus identical raw object-storage inventories establish the same derivation
for observed stable input; independent-writer atomicity remains unproved.
Source and partial destination bytes remain retained, and exclusive new writes,
credential refusal and inactivity are unchanged. Runtime qualification has not
been performed. Native references: [sparse directory index format](https://git-scm.com/docs/gitformat-index),
[sparse-index design](https://git-scm.com/docs/sparse-index), and
[Git config scopes](https://git-scm.com/docs/git-config).

Export plumbing is source code only: `config --file - --no-includes` receives
captured configuration bytes in an empty isolated directory. `for-each-ref` and
`cat-file --batch-all-objects` run only in the private captured Git view described
above; no native child discovers or reads a live selected/common repository.
Every Git child starts with its process cwd and `-C` at its isolated root, an
explicit parent discovery ceiling and `--no-pager`. The fresh environment drops
inherited Git/trace/config/alias/pager overrides, disables system/global config,
fsmonitor, optional locks, replacement objects, lazy fetching and terminal prompts.
No shell interpolation or mutating Git command is used. Before/after association,
raw selected/shared control/config/log/object-storage originals, exact required
index/shared-index files and complete logical index/sparse inventories must match,
including absence, identities, sizes and change times. Each native call has a
30-second and 32 MiB output bound. Git objects are bounded
to 32 MiB and 10,000 objects; refs/index entries to 10,000 each; provider files
to 1 MiB each and 1,000 entries. Whole artifact limits still apply. Refusal preserves
the source instead of truncating data.

The existing source fence and before/after checks do not drain independent native
writers or prove an arbitrary-writer atomic snapshot. The bounded binary v2/v3/v4 index reader refuses unknown layouts and extensions. Known credential paths in Git trees/index refuse the whole selection, preserving Git object identity instead of dropping files. Git control paths must be ordinary local originals, with no external symlinks or hardlinks; the allowlisted common hook/support, Gitweb, legacy remote, rr-cache and lost-found originals plus the exact selected-gitdir COMMIT_EDITMSG, SQUASH_MSG, TAG_EDITMSG and MERGE_MSG are read as inactive review data; configured hook targets are not followed. Known-secret inspection detects recognized fields/syntax,
not arbitrary unidentified credentials disguised as ordinary user bytes. Objects
whose inspection text exceeds 4 MiB refuse; the JSON review manifest is limited
to 48 MiB. Provider settings are never made active by inspection alone.

Exact remaining implementation: unsupported linked/common-directory layouts, packed private refs and unsupported selected ref storage;
unsupported index flags/extensions and combined split/sparse or other unsupported sparse forms; staged submodule repository originals; custom external Git include/hook
contents; arbitrary other provider configuration formats and TOML outside the bounded structured subset; explicit reviewed activation into a native-owned live Git or
provider configuration. Whole-folder re-export of imported inactive originals is
implemented through the [explicit retained-original consumer](#re-exporting-imported-inactive-originals).
It requires exact family selection, one canonical artifact binding and matching
original bytes; missing, ambiguous, changed or unknown evidence refuses. Live
capture cannot replace an existing review namespace. Selected-file and canonical
package-history re-export keep their existing paths. Generated review repositories
are never traversed or adopted as originals. Required absolute/cross-root links,
unsupported symbolic chains, ACL/xattrs, special nodes,
and other extended filesystem semantics remain concrete recreation gaps. Native
process/kernel state, authentication, profiles and source ownership are not data
formats that this transport can grant.

No test sources were added or prepared in this batch. Source review covered the
existing package artifact, parser, folder import and live-root forwarding callers.
Actual Git version/platform/index/config behavior and fresh-machine workflow
equivalence have not been exercised in this batch.

Primary design references: [Git cat-file](https://git-scm.com/docs/git-cat-file),
[Git update-index](https://git-scm.com/docs/git-update-index),
[Git config](https://git-scm.com/docs/git-config),
[Git index format](https://git-scm.com/docs/gitformat-index),
[Git ls-files](https://git-scm.com/docs/git-ls-files). The source uses these documented plumbing contracts; no Git capture or recreation command was run in this batch.

### Passive in-root symbolic cycles

Explicit whole-folder inventory and selected-link export preserve supported relative
cycles as original link paths, target spelling and optional link mtime. They never
follow the links or convert them to file bytes. New folder manifests declare
`cyclicLinks: passive_in_root`; missing or `refuse` policies retain cycle refusal.
Package validation, composition, recovery and fresh live-root import carry that
policy through the same topology validator. Composition refuses mixed policies
for a Shared root rather than upgrading an old contract implicitly. An embedded
review manifest declaring cycle refusal independently prevents cycle installation.

Resolution substitutes symbolic prefixes before processing following `..` components.
Only an exact repeated pair of resolved components and pending components proves
a supported passive cycle. Growing/nonrepeating chains refuse. Per-link resolution
is bounded to 10,000 steps/expansions and 10,000 serialized state characters; target
spelling is bounded to 10,000 characters. These conservative bounds can refuse
otherwise valid complex chains. Absolute, root-escaping, native/credential component
and unsupported forms refuse, including credential components later canceled by
`..`. Every declared link is checked independently; links remain leaves and may
never serve as installed parents. No source traversal or new activation authority
is introduced; existing exclusive writes, no-follow checks, complete regular
hardlink inventories and source/partial destination retention remain.

This batch has source review only. Runtime and platform link timestamp behavior
remain unqualified; no tests, builds or native link-tree inspection were performed.

### Re-exporting imported inactive originals

Agent, organization and full Branch whole-folder exports offer **Review data
source**: current Git/settings (`source: live`, also the historical omitted-source
behavior), or imported inactive originals (`source: retained_originals`). This
optional source field extends the existing `ReviewedUserDataSelection` request
DTO carried by Agent API and Branch SDK `fileSelections`; both Git/harness booleans
remain required. The original manifest's family selection remains source-free.
Selected-file and package-history exports retain their existing paths.

Retained selection requires exactly the original manifest's families. Partial
families, mixed retained/live capture and multiple original bindings refuse rather
than merging or dropping data. Shared-root lookup uses retained imported-history
bindings belonging to current Agents of the same Chat and working root, including
a peer not selected for export. Exactly one original binding and authoritative
artifact size/hash are required. Managed artifact reading checks that identity;
the bounded original parser checks secret/family/Git-object contracts again.

Only `.ponderosa-portable-review/user-data.json` is captured. Its original bytes
must equal the bound managed artifact. Canonical directory parents, a bounded
single-link regular file, no-follow open, inode/size/timestamp checks and a final
reread detect observed changes. Namespace entries are limited to the original
manifest and the two generated review-copy names; unknown entries refuse. Generated
`git-repository` and `provider-files` contents are never read, flattened, nested or
substituted for originals. Their manual edits are outside original re-export.
An existing namespace without retained selection refuses whole-folder export,
including a live-source request; it is never silently replaced. Missing retained
originals or bindings refuse even when live Git/settings exist.

Original manifest bytes, Git/ref/reflog/index/sparse/config/provider payloads and
original working-file metadata travel through existing artifacts and composition.
Shared composition already requires equal content hashes and metadata for each
working path; conflicting snapshots refuse. Existing import stores the original
manifest and generates fresh separate inactive copies without activating Git or
provider settings. Repeated re-export keeps one namespace and original manifest,
not generated repositories inside generated repositories. Old cycle refusal and
new passive-cycle contracts remain intact. Sources and partial imports remain.
No tests, builds, typechecks or runtime/platform qualification were performed for
this source-only batch. Independent writers can still race observed checks.

### Inactive project Codex agent originals

Explicit `harness: true` selection includes only regular top-level
`.codex/agents/*.toml` originals. The canonical directory inventory refuses
subdirectories, unknown file formats, links/special nodes and credential names;
it never recurses into this directory or follows a TOML path. Existing 1,000-entry
inventory, 1 MiB per-original/TOML and 32 MiB aggregate bounds remain, with the
same canonical parent, single-link no-follow original reads and inventory/read
drift checks. Invalid or unsupported TOML refuses with source bytes preserved.
UTF-8 and BOM handling match `.codex/config.toml`.

One shared classification applies the existing bounded TOML scrubber to both
config and agent originals at live export and parsed-manifest validation. Full
original syntax/namespace validation precedes secret-span removal; accepted
nonsecret sibling spans and `removedSecretFields` are retained. Import rejects
retained known-secret fields regardless of that flag. This covers shared
import/recreation and retained-original re-export validation without another
parser, DTO, schema, storage version or caller change.

The [pinned Codex config-layer declaration](https://raw.githubusercontent.com/openai/codex/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/config/src/config_toml.rs)
(`AgentsToml.roles` and `AgentRoleToml.config_file`) resolves role config paths
relative to the declaring config. Separately, the
[official custom-agent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents)
describes standalone project `.codex/agents/` files and personal home files.
These native formats differ; transport accepts supported opaque TOML, without
validating a native agent schema, resolving `config_file`/includes, reading home
files, or qualifying native discovery. Prompts, commands and paths stay text.

The existing shared importer writes numbered nonexecutable `.review` copies with
original path metadata; it never installs settings, reloads configuration, grants
tools or spawns agents. Re-export uses only the original validated manifest, never
generated review copies. Other provider families are unchanged. This is a
source-only change; no tests, native configuration, runtime, round-trip or
atomicity qualification was performed.

### Inactive project Claude output styles

Explicit `harness: true` selection captures regular top-level
`.claude/output-styles/*.md` from the selected root only. A shared path
classification permits exactly these originals at capture and parsed-manifest
validation. The directory and files must share the selected root owner; canonical
parents, single-link no-follow reads and existing inventory/read drift checks
apply. Inventoried styles disappearing before reading refuse. Nested directories,
unknown formats, links/special nodes, known credential names, invalid UTF-8 and
exceeded bounds refuse with originals preserved. Existing 1,000-entry inventory,
1 MiB original and 32 MiB aggregate limits remain unchanged. Accepted UTF-8
bytes, including any BOM, are retained exactly. Existing known-secret inspection
refuses recognizable credentials; it cannot identify every secret in arbitrary
prose. No structured style fields are removed, so `removedSecretFields` is false
for live style capture.

The [official custom-output-style documentation](https://code.claude.com/docs/en/output-styles#create-a-custom-output-style)
describes Markdown frontmatter and instructions at project, user and managed
levels, including ancestor-project discovery. This transport selects only the
exact local directory: no home, managed, ancestor or nested-project discovery.
Frontmatter and instruction bodies remain opaque text, with no YAML parsing,
metadata interpretation, command/path/include/reference expansion or native
loader/system-prompt compatibility claim. No source write, installation, tool
grant, native spawn, configuration reload or activation occurs.

The generic provider-file DTO and existing shared callers need no changes.
Working-file export validates the manifest; import parses it before creating
numbered mode0600 nonexecutable `.review` copies and exact original path/removal
metadata. Retained-original re-export validates and returns original manifest
bytes, never generated review copies. Other provider families and existing
Codex/TOML/Git/settings behavior remain unchanged. Source review only: no tests,
builds, native configuration, runtime, round-trip or atomicity qualification.

### Inactive project Claude subagent memory

Explicit `harness: true` selection includes selected-root
`.claude/agent-memory/<agent>/...` and
`.claude/agent-memory-local/<agent>/...` regular UTF-8 originals. One shared
classification requires a nonempty, non-dot Agent directory and contained file
path; files directly in either family root refuse. Supporting text files may
occupy bounded recursive subdirectories. Empty directories have no file entry in
the existing DTO and are not recreated. Imported file/ancestor collisions refuse.
No Agent identity is guessed or bound, and no Agent definition is dereferenced.

Every traversed memory directory and regular original must share the selected
root owner. Existing canonical-parent, single-link no-follow original reads,
inventory/read drift checks and shared 1,000-entry / 1 MiB original / 32 MiB
aggregate limits remain. Discovered directories or files disappearing refuse.
Dot/empty/traversal/null/backslash path components, known credential names,
links/special nodes, invalid UTF-8, changed inventory and exceeded bounds refuse
with originals preserved. Accepted bytes, including BOM, stay exact. All memory
files are opaque text regardless of extension: JSON-shaped text still receives
existing recognizable-secret inspection but is neither rewritten nor treated as
provider settings. Live `removedSecretFields` remains false; recognizable secrets
refuse instead. Arbitrary concealed secrets remain outside this guarantee.

The [official persistent-memory documentation](https://code.claude.com/docs/en/sub-agents#enable-persistent-memory)
distinguishes project/local directories from user-home memory and describes
`MEMORY.md` plus persistent supporting files. This transport reads only the two
exact selected-root families. No home/managed/ancestor/nested-project discovery,
native session/context/history reads, YAML/frontmatter/Markdown interpretation,
include/path/reference expansion, startup-context qualification or tool grants
occur. Files are never installed, activated or reloaded; no native spawn, provider
invocation or source write occurs. Ponderosa local/global memory databases and
permissions are unchanged.

The generic DTO and shared consumers need no changes: working export validates
the manifest; import parses before numbered mode0600 nonexecutable `.review`
copies with exact original path/removal metadata; retained-original re-export
validates and returns the original manifest bytes, never generated copies.
Other provider families and existing output-style/Codex/TOML/Git/settings behavior
remain unchanged. Existing sensitive-prose warning and independent-writer race
limits remain. Source-only review: no tests, native memory/configuration/runtime,
round-trip, atomicity or whole-portability acceptance.

### Inactive project Claude hook-support originals

Explicit `harness: true` selection includes contained regular UTF-8 originals in
selected-root `.claude/hooks/`, including top-level scripts and bounded recursive
supporting files. One shared live/import classification handles hook and memory
originals; hooks require at least one nonempty non-dot component beneath their
root, while memory still requires a named Agent directory. Dot/empty/escaping/
null/backslash components, known credential names and imported file/ancestor
collisions refuse. Only an absent family root is optional; discovered files or
directories disappearing fail with source originals preserved.

Every traversed hook directory and file must share the selected-root owner.
Existing canonical-parent, single-link no-follow reads, inventory/read drift
checks and shared 1,000-entry / 1 MiB original / 32 MiB aggregate limits remain.
Links, special nodes, foreign owners, invalid UTF-8 and exceeded bounds refuse.
Accepted bytes including BOM stay exact. Contents are opaque text regardless of
extension: `.json` support files bypass settings parsing and rewriting, while
existing recognizable/embedded known-secret inspection still applies. Live
`removedSecretFields` remains false; recognized credentials refuse instead.
Arbitrary concealed secrets and sensitive prose remain outside this guarantee.

The [official hooks reference](https://code.claude.com/docs/en/hooks#reference-scripts-by-path)
documents project scripts under `.claude/hooks/` referenced with
`CLAUDE_PROJECT_DIR`, including Bash and PowerShell examples. This transport
captures only that selected-root directory. It does not parse settings commands
to chase files, interpret shell/YAML/Markdown, expand imports/paths/environment
variables, bind native hooks, discover home/ancestor/managed/nested-project or
session/history/credential data, install, activate, reload, grant tools, spawn,
execute hooks/providers or write source files.

The existing generic file DTO carries neither empty directories nor original
executable mode or mtime; these are not recreated. Import validates the original
manifest before writing numbered mode0600 nonexecutable `.review` copies and
exact original path/removal metadata, never active `.claude/hooks` files.
Retained-original re-export validates and returns exact original manifest bytes,
never generated review copies. Shared callers, DTO/schema/version/dependencies
and caps need no change. Other provider families remain unchanged, including
memory/output-style/Codex/TOML/Git/settings behavior. Existing sensitive-data
warning and independent-writer limits remain. Source-only review; no native
execution/equivalence, round-trip, atomicity or whole-portability acceptance.

### Inactive project Claude skill-support originals

Explicit `harness: true` selection carries selected-root
`.claude/skills/<skill>/...` regular UTF-8 originals, including `SKILL.md` and
bounded recursive supporting text. The shared live/import opaque classification
requires a nonempty non-dot skill directory followed by a contained file; files
directly in `.claude/skills` refuse. No `SKILL.md` presence, frontmatter or manifest
parser is required for this inactive data transport.

Skill text now retains exact accepted bytes, including BOM, regardless of
extension. JSON support files are no longer parsed, scrubbed or reformatted as
provider settings. Existing known-secret inspection still checks recognizable
and embedded credentials and refuses them instead of rewriting skill originals;
live `removedSecretFields` remains false. Actual settings JSON retains its
existing structural secret removal. Arbitrary concealed secrets and sensitive
prose remain outside the inspection guarantee.

The existing owner checks now cover every traversed skill directory and original
against the selected-root owner. Canonical parents, single-link no-follow bounded
reads, inventory/read drift checks and shared 1,000-entry / 1 MiB original /
32 MiB aggregate limits remain. Dot/empty/escaping/null/backslash/credential paths,
links/special nodes, foreign owners, invalid UTF-8, exceeded bounds and imported
file/ancestor collisions refuse. Only absent family roots are optional;
discovered directories/files disappearing fail with source bytes preserved.
Binary resources remain unsupported; this is not full native skill preservation.
Empty directories and original executable mode/mtime remain unrepresented by the
existing file DTO and are not recreated.

The [official skills documentation](https://code.claude.com/docs/en/skills#add-supporting-files)
describes named project skill directories with `SKILL.md`, reference files and
support scripts. This transport captures only selected-root contained text.
It does not interpret SKILL/frontmatter/Markdown/JSON/script instructions or
expand references, imports, paths or environment variables. No home, ancestor,
managed, nested-project, session/history/credential discovery, native binding,
installation, activation, executable chmod, reload, grants, spawning, script/
skill/provider execution or source write occurs.

Shared callers and the generic DTO/schema/version/dependencies/caps are unchanged.
Working export validates the manifest; import parses it before numbered mode0600
nonexecutable `.review` copies with exact original path/removal metadata.
Retained-original re-export validates and returns original manifest bytes, never
generated copies. Other provider families, including Claude memory/hooks/output
styles and Codex/TOML/Git/settings, retain their behavior. Existing sensitive-data
warning and independent-writer limits remain. Source review only: no tests,
native equivalence, round-trip, atomicity or whole-portability acceptance.

### Exact already-selected non-settings provider text

The existing explicit harness selection now preserves exact accepted regular
UTF-8 bytes, including BOM, for `.claude/CLAUDE.md`, `.codex/instructions.md` and
recursive contained originals in `.claude/commands`, `.claude/agents`,
`.claude/rules`, `.codex/skills` and `.codex/rules`. This fixes fidelity of existing
selection; no additional native directories or discovery rules are introduced.
Existing contained layouts remain accepted, including top-level files and
noncredential dot-prefixed components in these recursive families. No named
Agent/skill, `SKILL.md`, frontmatter or extension requirement is added to them.
Previously completed Claude memory/skills/hooks retain their own path rules.

One shared opaque classification now supplies live selection, parsed import,
UTF-8/BOM preservation, known-secret refusal and file/ancestor collision checks.
A support-file `.json` suffix never triggers settings parsing or rewriting.
Only exact `.mcp.json`, `.claude/settings.json` and `.claude/settings.local.json`
use structural secret removal; `.codex/config.toml` and `.codex/agents/*.toml`
retain the existing bounded span-removal grammar. Other selected text is opaque:
recognizable/embedded known secrets refuse instead of rewriting accepted bytes.
Arbitrary concealed secrets and sensitive prose remain outside this guarantee.

The existing canonical-parent, single-link no-follow bounded reader now applies
selected-root ownership to these text originals and every traversed directory,
including fixed instruction files when no opaque directory exists. This is the
same contained-original protection as memory/hooks/skills, not native ownership
adoption. Initial absence of a fixed file or family root is optional. Once an
entry is observed, disappearance fails, including between a fixed-file absence
probe and its read. Malformed/empty/dot-dot/null/backslash/escaping/credential
paths, links/special nodes, foreign owners, invalid UTF-8, imported file/ancestor
collisions, observed drift and exceeded bounds refuse with source bytes retained.
Shared 1,000-entry / 1 MiB original / 32 MiB aggregate limits are unchanged.

Shared working export validates the manifest; import parses it before numbered
mode0600 nonexecutable `.review` copies with exact path/removal metadata.
Retained-original re-export uses validated original manifest bytes, never generated
copies. No caller, DTO/schema/version/dependency/cap change is needed. Binary
resources, empty directories and original executable mode/mtime remain unsupported
by this text/file DTO. There is no instruction/frontmatter/Markdown/JSON/script
interpretation beyond known-secret inspection, reference chasing, environment/
path/import expansion, native binding/install/activation/chmod/reload/grants/spawn,
provider/script execution, source write or outside-root discovery. Existing
sensitive-data warning and independent-writer limits remain. Source-only review:
no tests, native equivalence, round-trip, atomicity or whole-portability acceptance.

### Inactive project Claude fallback instruction original

Explicit `harness: true` selection includes optional selected-root
`.claude/AGENTS.md` as an opaque regular UTF-8 original. The existing fixed-file
selection and shared classifier preserve exact accepted bytes, including BOM,
with `removedSecretFields: false`; no settings parsing or rewriting applies.
Initial absence is optional, but disappearance after the presence probe fails.
The existing selected-root owner, canonical-parent, single-link no-follow bounded
reader, read-drift, recognizable-secret refusal and imported file/ancestor
collision checks apply. The shared 1,000-entry / 1 MiB original / 32 MiB aggregate
limits are unchanged. Source originals remain untouched on refusal.

The [official AGENTS.md documentation](https://code.claude.com/docs/en/memory#when-claude-code-reads-agentsmd)
identifies `.claude/AGENTS.md` as a project fallback instruction file. This
reference identifies the data family only. Export does not resolve native
fallback conditions or priority: it captures this optional original even when
other instruction files exist. Root `AGENTS.md` remains in the ordinary working
file lane and is not duplicated here. No ancestor, home, managed, nested-project
or session discovery, native-version/runtime parity or context behavior is claimed.

The exported file is untrusted user data, never instruction authority for
Ponderosa. There is no parsing or following of instructions, `@imports`, references
or frontmatter, environment/path expansion, binding, installation, activation,
reload, tool grant, spawning, provider execution or source write. Shared export
validates the manifest; import parses before numbered mode0600 nonexecutable
`.review` copies with exact original path/removal metadata. Retained re-export
uses only validated original manifest bytes. No shared caller, format, DTO,
schema, dependency or cap change is needed; settings JSON removal, Codex TOML
span removal and other selected text families are unchanged.

Binary resources, empty directories, original executable mode/mtime, arbitrary
sensitive prose and concealed secrets remain outside the text-file guarantee.
Existing sensitive-data warnings and independent-writer limits remain. Source
review only: no tests, round-trip, native equivalence, atomicity or whole-portability
acceptance is claimed.

### Inactive default common Git hook originals

Explicit `git: true` selection includes optional `<validated commonDir>/hooks/`
regular UTF-8 originals and bounded contained support subdirectories. This applies
to a normal repository and the already authorized, reciprocally validated selected
linked worktree/common repository. Every original maps to a virtual
`.git/hooks/...` path in existing `providerFiles` slots, with exact base64 bytes
and `removedSecretFields: false`. The path denotes common-repository provenance,
even when the selected private gitdir is elsewhere; no absolute physical path or
source ownership authority is transported. Main/other/private worktree hook
locations are not read. The ordinary working-file lane still refuses `.git`.

The [Git hooks manual](https://git-scm.com/docs/githooks) identifies the default
hook directory and the separate `core.hooksPath` override. The
[repository-layout manual](https://git-scm.com/docs/gitrepository-layout)
identifies common-repository hook storage. These references identify the data
family, not native activation or runtime equivalence. Configured hook paths are
never expanded or followed, even if relative or contained; their nonsecret config
text remains inactive. External/configured hook targets remain a preservation gap.

The existing raw snapshot walker captures this exact common root with same-owner
canonical directories, regular single-link no-follow bounded reads, exact identity/
hash/absence evidence and whole-capture before/after association checks. Only
initial root absence is optional; discovered directory/file disappearance fails.
Malformed/empty/dot/dot-dot/null/backslash/escaping/credential paths, links,
special nodes, foreign owners, invalid UTF-8, NUL binary text, observed drift or
exceeded bounds refuse while preserving source bytes. Existing contained names,
noncredential dot-prefixed components, `.sample` files and support text remain
accepted without hook-name or extension requirements. UTF-8/BOM bytes remain exact
regardless of extension; known secrets refuse instead of rewriting JSON or scripts.

The hook inventory is bounded to 1,000 descendant entries. Hook and harness
originals share the existing 1,000-file / 32 MiB aggregate review-original limits,
with 1 MiB per original; hooks also count within existing 20,000-node / 32 MiB Git
raw limits. Nothing is silently truncated. Parser family binding permits Git-only
and mixed selections but rejects Git hook records without Git selection and a
valid required Git manifest, or provider records without harness selection.
Imported file/ancestor collisions refuse through the shared opaque classifier.

Hook originals are skipped before native read-view copying, native parsing or
pack pairing. They never enter the recreated Git repository. Both isolated Git
plumbing and the recreated review repository keep hooks disabled with
`core.hooksPath=/dev/null` and fsmonitor disabled. Shared working export validates
the complete manifest; import parses before numbered mode0600 nonexecutable
`.review` copies and exact original path/removal mappings. Retained re-export
validates authoritative original manifest bytes, never generated repositories or
review copies. The local Git capture return carries the Git manifest and Git
originals together to its sole shared export caller; no DTO/format/schema/version,
dependency, cap, checkbox or additional codec changes are needed.

No shell, shebang, JSON, instruction or reference interpretation, path/environment/
import expansion, global/ancestor/home/managed/session discovery, binding,
installation, executable chmod, activation, reload, grant, network, hook/provider
execution or source write is added. Other Git and provider families are unchanged.
Empty directories, binary resources, original executable mode/mtime, arbitrary
sensitive prose/concealed secrets and independent-writer atomicity remain outside
the guarantee. Existing sensitive-data warnings remain. Source review only: no
capture execution, tests, native equivalence, round-trip or whole-Bible acceptance.

### Inactive fixed common Gitweb metadata originals

Explicit `git: true` also includes exactly four optional files in the validated
common repository: `description`, `category`, `cloneurl` and `README.html`.
Normal repositories and already authorized reciprocally validated selected linked
worktrees use the same capture. Virtual `.git/{exactname}` paths in `providerFiles`
always mean common-repository provenance, never selected-private/main/other
worktree copies or absolute physical storage. No repository-root enumeration or
additional slot discovery is added.

The [Gitweb manual](https://git-scm.com/docs/gitweb#_per_repository_gitweb_configuration)
identifies these four per-repository files; description/category/cloneurl files
can override corresponding configuration. The [Git manual](https://git-scm.com/docs/git#Documentation/git.txt-GITCOMMONDIR)
describes common storage for non-worktree files. These references identify the
selected data family, not native Gitweb lookup, rendering or precedence parity.

All four bodies are opaque UTF-8 originals regardless of HTML, JSON or URL
appearance. Exact accepted bytes/BOM survive with `removedSecretFields: false`;
an empty present file is retained as a zero-byte record, distinctly from absence.
No JSON/settings rewriting, HTML rendering/evaluation, clone-URL interpretation or
fetching, template resolution, config-path expansion or reference chasing occurs.
Recognizable secrets refuse rather than redact originals. Source configuration
and inactive nonsecret `gitweb.*` values are unchanged.

The existing raw walker reads only these exact common slots through canonical
same-owner parents and regular single-link no-follow bounded reads. Optional
absence and present identity/hash evidence join whole-capture before/after raw
snapshot and reciprocal association checks, detecting observed appearance,
disappearance or drift. Directories, links, special nodes, foreign owners,
invalid UTF-8/NUL binary data and malformed/credential paths refuse. The shared
Git-original classifier binds records to explicit Git selection and a required
valid Git manifest; other provider families still require harness selection.
Git-only/mixed flows share imported file/ancestor collision checks, complete
manifest validation, numbered mode0600 nonexecutable `.review` copies with exact
path/removal mappings, and authoritative-original-manifest re-export.

These files are skipped before native read-view copying, parsing or pack pairing
and never installed in recreated Git or native Gitweb. Existing hooks/fsmonitor
disabling remains. Existing 1 MiB per original, 1,000 combined hook/metadata/harness
review files, 32 MiB combined review bytes and 20,000-node/32 MiB raw Git bounds
remain; no truncation, DTO/format/schema/version/dependency/checkbox change or
parallel codec is introduced. Ordinary working-file `.git` refusal is unchanged.
No global/home/ancestor/managed/nested/session discovery, native web server,
network, installation, activation, executable chmod, grants, hook/provider
execution or source writes are added. Original executable mode/mtime, empty
directories, binary resources, arbitrary sensitive prose/concealed secrets and
independent-writer atomicity remain outside the guarantee. Source-only review
makes no capture-execution, round-trip, native-equivalence or whole-Bible claim.


### Inactive common legacy Git remote originals

Explicit `git: true` includes optional validated common-repository `branches/`
and `remotes/` regular UTF-8 originals and contained supporting directories,
for normal repositories and already authorized reciprocal selected linked
associations. Existing `providerFiles` use virtual `.git/branches/...` and
`.git/remotes/...` paths with explicit common provenance and
`removedSecretFields: false`. No selected-private/main/other-worktree alternate
copies or broad repository-root enumeration are read.

The [repository-layout manual](https://git-scm.com/docs/gitrepository-layout)
identifies these as legacy URL/default-refname shorthand storage, using common
versions when `GIT_COMMON_DIR` is set, and states Git 3.0 will stop reading them.
Preservation here concerns source bytes only: no native-version discovery,
compatibility expansion, remote-syntax validation or active obsolete syntax.
Modern `remote.*` configuration and captured refs/objects do not replace these
originals.

The shared Git-original classifier requires a valid nonempty contained component
below either directory. Empty/dot/dot-dot/null/backslash/escaping/credential names
refuse; family roots cannot masquerade as original files. Valid contained names,
noncredential dot-prefixed names and nested layouts need no extension or native
URL/ref grammar. Bodies remain opaque even when URL/JSON/config-looking. Exact
accepted UTF-8/BOM bytes survive without rewriting; empty present files survive.
Known secrets, including recognizable URL userinfo, refuse rather than redact
originals. No remote-definition, refspec or URL parsing, configured-path expansion,
reference chasing, fetching or modernization occurs.

The existing raw snapshot walker supplies canonical same-owner parents,
regular single-link no-follow bounded reads and exact directory/file identity,
hash and absence evidence within complete before/after association/snapshot
checks. Initial family-root absence is optional; discovered entry disappearance
fails. Observed appearance/disappearance/drift, links/special nodes, foreign
owners, invalid UTF-8/NUL binary text and imported file/ancestor collisions refuse.
Source and partial bytes remain preserved. Existing Git selection plus a required
valid Git manifest binds all Git originals; other provider families require
harness. Git-only/mixed selection uses unchanged full-manifest working export,
parse-before-write numbered mode0600 nonexecutable `.review` copies with exact
path/removal mappings and authoritative-original-manifest retained re-export.

The new originals skip first before native Git read-view copying/parsing/pack
pairing and never enter recreated Git or active native configuration. Existing
hooks/fsmonitor disabling remains. The 1 MiB/original, 1,000 combined Git/harness
review files, 32 MiB combined review bytes and 20,000-node/32 MiB raw bounds remain;
existing 1,000-entry hook inventory bound is unchanged. No cap, DTO/format/schema/
version/dependency/checkbox or parallel-codec change. Ordinary `.git` working-file
refusal remains. Other Git, Gitweb, hook and provider behavior is unchanged.
No source writes, network, installation, binding, activation, reload, executable
chmod, grants, provider execution or home/global/ancestor/managed/nested/session
discovery is added. Empty directories, binary resources, original mode/mtime,
arbitrary sensitive prose/concealed secrets and independent-writer limits remain.
Source review does not establish capture execution, native equivalence, round
trips, atomicity or whole-Bible acceptance.


### Inactive common rerere and selected commit draft originals

Explicit `git: true` includes optional validated common-repository `rr-cache/`
regular UTF-8 originals and contained supporting directories, plus only the exact
selected-gitdir `COMMIT_EDITMSG` regular UTF-8 original. Normal repositories and
already reciprocally validated selected linked associations share the existing
classifier, raw walker and `providerFiles` carrier. Virtual `.git/rr-cache/...`
always means COMMON provenance; `.git/COMMIT_EDITMSG` always means SELECTED-worktree
provenance, even when normal `gitDir === commonDir`. No private cache, common/main
commit draft, other-worktree substitute or broad root enumeration is read.

The [rerere manual](https://git-scm.com/docs/git-rerere) describes recording conflict
resolutions for later reuse. Pinned Git v2.54.0 [rerere.c](https://github.com/git/git/blob/v2.54.0/rerere.c#L88-L138)
identifies rr-cache preimage/postimage variants, while [path.c](https://github.com/git/git/blob/v2.54.0/path.c#L90-L115)
maps rr-cache to common storage. The [commit FILES contract](https://git-scm.com/docs/git-commit#_files)
identifies COMMIT_EDITMSG as the user message retained after a failed commit until
a later commit overwrites it. These references identify source data only; current
objects/refs/index and ordinary working-file transport (which refuses `.git`)
do not replace those bytes. No native-version discovery or reuse equivalence is claimed.

The rr-cache classifier requires at least one valid nonempty nondot contained
component below the family, refusing a family-root file. Valid names/layouts,
including noncredential dot-prefixed names and preimage/postimage/thisimage numbered
variants, need no conflict-ID, pair, extension or resolution grammar. Bodies remain
opaque regardless of JSON/script/ref-looking content. The exact draft likewise
preserves comments/templates without interpreting them. Accepted raw UTF-8/BOM bytes
and empty-present files survive unchanged; absent optional roots/draft produce no
original record. No pair/variant or absent file is fabricated. Both families use
shared live/import NUL/binary, fatal UTF-8 and known-secret refusal, never redaction
followed by an exact-byte claim. Arbitrary sensitive prose/concealed secrets remain
a limit of recognized-secret inspection.

Canonical same-owner parents/directories and bounded single-link regular no-follow
reads feed complete before/after raw directory/file identity/hash/explicit-absence
and reciprocal-association checks. Initial optional absence differs from discovered
descendant disappearance, which refuses. Appearance/disappearance/drift, malformed
empty/dot/dot-dot/backslash/NUL/escaping/credential paths, links/special/foreign-owner
nodes and imported file/ancestor collisions refuse, preserving source/partial bytes.
The export filter admits only the exact selected draft alongside supported common
originals; the linked private allowlist adds only COMMIT_EDITMSG. Existing merge,
rebase, cherry-pick, revert, bisect and index-lock holds remain. MERGE_RR is not
transported or interpreted; this is not general operation-metadata recovery.

Git-only/mixed records require explicit Git selection, a required valid Git manifest
and `removedSecretFields: false`; other provider records require harness selection.
Unchanged shared working export validates the full manifest. Import parses before
numbered mode0600 nonexecutable `.review` copies and exact original-path/removal
maps. Retained re-export reads only the authoritative original manifest. All new
originals skip first before native-view copying/parsing/pack pairing, and never
install in recreated Git, active caches, COMMIT_EDITMSG or native configuration.
Hooks/fsmonitor remain disabled. Existing 1 MiB/original, 1,000 combined Git/harness
review files, 32 MiB review bytes, 20,000-node/32 MiB raw and 1,000-entry hook-inventory
bounds remain; no truncation, DTO/schema/storage-version/format/dependency/checkbox,
cap change or parallel codec.

No rerere/merge/apply/commit/editor/script/provider execution, resolution replay,
fetch/network, path/environment/import/reference/config expansion, source writes or
home/ancestor/managed/nested/session/credential/other-worktree discovery is added.
Other Git/provider families remain unchanged. Original executable mode/mtime,
empty directories, binary data, learned GC/retention age/reuse and independent-writer
atomicity remain outside this guarantee. Source-only: no capture execution, native
equivalence, round-trip, atomicity or whole-Bible acceptance claim.


### Inactive local include declarations

Explicit Git selection preserves nonsecret `include.path` and
`includeIf.<condition>.path` declarations in existing ordered `configurationReview`
records. Exact common `config` is read before exact selected `config.worktree`;
repeated entries retain their order within each source. Omitted `source` means
common config; `source: "config.worktree"` means selected-worktree config.
Keys/values and implicit-boolean metadata use the existing captured config parser,
not a new byte-original codec: source comments/quoting/case normalization are not
claimed exact. Parsed literal relative, absolute, tilde and conditional strings
are retained without path or environment expansion, condition evaluation, target
stat/read, recursion, URL lookup or reference chasing. No target must exist.

The official [Git config Includes and Conditional includes](https://git-scm.com/docs/git-config#_includes)
reference describes repeated paths and native conditional/relative/tilde semantics;
its [`--no-includes` option](https://git-scm.com/docs/git-config#Documentation/git-config.txt---no-includes)
disables inclusion. Those native semantics are not activated here. Existing
`config --file - --null --list --no-includes` receives only captured stdin in a
private empty cwd with system/global/inherited config disabled, an explicit
parent discovery ceiling and no pager. Conditions such as gitdir, worktree,
onbranch and hasconfig, including embedded URLs, remain text; no selected,
ancestor, home/global or included repository configuration is discovered.

Existing known-secret/URL-userinfo and credential-key/source-ownership filtering
still applies on export; import rejects retained unsafe records. Supported
nonsecret declarations do not remove any format, extension, sparse, index,
object/graph/ref/log/shallow or relative-worktree evidence requirement. For example,
a required explicit local repository-format declaration, sparse cone settings for
collapsed directories or worktree sparse extension authority cannot be supplied
by an uncollected include. Existing corresponding refusals remain; preservation
of a declaration does not establish effective native configuration equivalence.
External include contents and configured hook targets remain uncollected.

Canonical association/owner/single-link/no-follow/bounded raw/config snapshots and
before/after identity/absence/byte/hash checks remain unchanged. Live export uses
the shared validator; working export validates the complete manifest and import
parses before writes. Recreation places configuration records only in inactive
`CONFIGURATION-REVIEW.json`; active read-view and recreated Git configs remain
generated format-only configs with hooks/fsmonitor disabled. Retained re-export
uses only the authoritative original manifest, never generated review copies.
No new traversal, selection, DTO/schema/storage-version/format/cap/dependency or
parallel codec. Ordinary working-file `.git` refusal remains. Source-only changes:
no parser/native/runtime execution, round-trip, atomicity or whole-Bible acceptance.


### Inactive common Git lost-found originals

Explicit `git: true` includes optional validated COMMON `lost-found/` regular
UTF-8 recovery originals and contained support directories, using the existing
shared directory-original classifier, raw snapshot and `providerFiles` carrier.
Virtual `.git/lost-found/...` paths always mean the exact associated common
repository, including already reciprocally validated linked associations; no
selected-private/main/other-worktree substitution or additional traversal authority.
Selected-private lost-found storage remains unsupported under the existing guard.

The official [fsck --lost-found contract](https://git-scm.com/docs/git-fsck#Documentation/git-fsck.txt---lost-found)
describes `commit/` and `other/`, with blob contents written directly. Pinned Git
[path.c common_list](https://github.com/git/git/blob/v2.56.0/path.c#L90-L109)
marks lost-found common, and [fsck.c](https://github.com/git/git/blob/v2.56.0/builtin/fsck.c#L288-L308)
shows those recovery writes. These references identify existing data, not native
recovery equivalence. Edited recovery files or mappings remaining after object
pruning are independent originals; all-object capture cannot replace them, and
the ordinary working-file lane refuses `.git` components.

Existing contained nonempty nondot path grammar accepts `commit/`, `other/` and
custom text descendants without requiring OID names, object existence, hash equality
or content interpretation. A family-root file refuses. Exact accepted UTF-8 bytes,
BOM and empty-present files survive; initial optional absence yields no original.
Recognized-secret, NUL/binary/invalid-UTF-8, malformed/escaping/credential
paths, symlinks/hardlinks/special nodes, foreign ownership and topology/collisions
refuse without rewriting or silently dropping files. Sensitive prose and concealed
secrets remain limits of recognized-secret inspection.

Canonical same-owner directories, single-link regular no-follow bounded reads and
complete before/after directory/file identity, byte hash, explicit absence and
reciprocal-association checks cover the entire family. Discovered descendants may
not disappear; observed appearance/disappearance/drift refuses, preserving source
and partial bytes. Existing 1 MiB/original, 1,000 combined review files/32 MiB,
20,000 raw nodes/32 MiB and 1,000 hook-entry bounds stay unchanged.

Shared parsing requires explicit Git selection, its required valid Git manifest
and `removedSecretFields: false`; other provider records still require harness
selection. Working export validates the full manifest; import parses before
numbered mode0600 nonexecutable `.review` originals and exact path/removal maps.
Retained re-export uses only the authoritative original manifest. The shared first
native-view skip excludes these files before copying/parsing/pack pairing. They
never install into recreated `.git/lost-found` or active configuration. No fsck,
GC, regeneration, recovery/revival, ref creation, checkout, hook/editor activation,
OID/link chasing, source cleanup/writes or outside-scope discovery is added.
Existing graph/config/format/sparse/index/log/shallow and operation checks remain.
No DTO/schema/storage-version/format/cap/dependency or codec changes. Original
mode/mtime, empty directories, binary data and independent-writer atomicity remain
unrepresented. Source-only: no capture execution, native equivalence, round-trip,
atomicity or whole-Bible acceptance claim.


### Inactive selected Git squash-message draft

Explicit `git: true` includes optional exact SELECTED-gitdir `SQUASH_MSG` as inactive
`.git/SQUASH_MSG`, alongside COMMIT_EDITMSG through the same shared selected-original
name list and `providerFiles` carrier with `removedSecretFields: false`. This slot
remains selected when gitDir equals commonDir. Already reciprocal linked associations
never substitute or read common/main/other-worktree drafts. Common lost-found and
unsupported private-storage guards remain unchanged.

The official [merge --squash contract](https://git-scm.com/docs/git-merge#Documentation/git-merge.txt---squash)
describes prepared working/index state without a commit, HEAD move or MERGE_HEAD.
Pinned Git v2.56.0 [merge.c420–452](https://github.com/git/git/blob/v2.56.0/builtin/merge.c#L420-L452)
writes the message; [commit.c797–821](https://github.com/git/git/blob/v2.56.0/builtin/commit.c#L797-L821)
reads it as a message input. [path.c1563](https://github.com/git/git/blob/v2.56.0/path.c#L1563)
names SQUASH_MSG; the same file's common-list/path resolver leaves it selected-private.
These references identify data/provenance for that release, not all-version native
compatibility. Exact edited drafts cannot be replaced by objects/index or ordinary
working-file transport, which refuses `.git` components.

Message/OID/template contents stay opaque, without interpretation/reconstruction,
reference chasing, merge/squash/commit/editor/hook continuation or active installation.
Exact accepted UTF-8/BOM/empty-present bytes survive; optional absence creates no
original. Recognized secrets refuse without redaction; sensitive prose/concealed
secrets remain limits, with no general draft-body URL-userinfo refusal claim.
NUL/binary/invalid UTF-8, unsafe paths/topology, symlinks/hardlinks/special nodes and
foreign ownership refuse. Existing canonical same-owner regular single-link no-follow
bounded reads and complete before/after identity/hash/absence/raw-inventory/reciprocal
association checks cover this slot; observed appearance/disappearance/drift refuses.
The narrow linked allowlist adds only this exact draft; all operation holds remain.

Shared classification, selected capture/provenance/export predicate and first native
skip cover the slot before copy/parse/pack pairing. Working export validates the full
manifest; shared import binds Git selection/required valid manifest/false removal and
parses before numbered mode0600 nonexecutable `.review` originals and exact maps.
Retained re-export uses only the authoritative original manifest. No active SQUASH_MSG
or config installation/source writes. Existing 1 MiB/original, 1,000 combined review
files/32 MiB, 20,000 raw nodes/32 MiB and hook bounds, graph/config/format/sparse/index/
log/shallow checks and harness selection remain. No DTO/schema/storage-version/format/
cap/dependency or codec changes. Mode/mtime/empty directories/binary and independent-
writer atomicity remain limits. Source-only: no capture execution, native equivalence,
round-trip, atomicity or whole-Bible acceptance claim.


### Inactive selected Git tag-message draft

Explicit `git: true` includes optional exact SELECTED-gitdir `TAG_EDITMSG` as inactive
`.git/TAG_EDITMSG` through the shared selected-original list and existing `providerFiles`
carrier with `removedSecretFields: false`. The slot remains selected when gitDir equals
commonDir; linked capture never stats, reads or substitutes common/main/other-worktree
tag drafts. Common lost-found and unknown private-storage guards remain unchanged.

Pinned Git v2.56.0 [tag.c278–359](https://github.com/git/git/blob/v2.56.0/builtin/tag.c#L278-L359)
creates a mode0600 draft for editing/trailers, consumes the resulting message and can
leave the draft after failure. [tag.c647–668](https://github.com/git/git/blob/v2.56.0/builtin/tag.c#L647-L668)
uses repo_git_path(TAG_EDITMSG), retains the message on failed ref transaction and
removes it after success. [path.c90–115](https://github.com/git/git/blob/v2.56.0/path.c#L90-L115)
and [331–405](https://github.com/git/git/blob/v2.56.0/path.c#L331-L405) leave this exact
name selected-private. These references establish that release's provenance, not an
all-version guarantee. A surviving edited draft need not equal a stored tag object;
ordinary working-file transport excludes `.git` and cannot substitute its bytes.

The message stays opaque: no message/OID/template interpretation, reconstruction,
tag/sign/editor/trailer or operation continuation, reference chasing or active
installation. Accepted exact UTF-8/BOM/empty-present bytes survive; optional absence
creates no original. Recognized secrets refuse without rewriting; sensitive prose and
concealed secrets remain limits, with no general draft-body URL-userinfo guarantee.
NUL/binary/invalid UTF-8 and unsafe topology/foreign ownership refuse. Existing canonical
same-owner regular single-link no-follow bounded reads and complete raw before/after
identity/hash/absence/reciprocal-association checks cover the slot; observed drift refuses.
All operation holds remain; only this exact name joins the linked storage allowlist.

Shared classification/provenance/selected capture/export and the first native-view skip
cover the draft before copy/parse/pack pairing. Working export validates the manifest;
shared import requires Git selection, a valid Git manifest and false removal before
numbered mode0600 nonexecutable `.review` originals/maps are written. Retained re-export
reads only the authoritative original manifest. No active TAG_EDITMSG/config installation
or source writes. Existing 1 MiB/original, 1,000 combined review files/32 MiB, 20,000 raw
nodes/32 MiB and hook bounds remain, as do graph/config/format/sparse/index/log/shallow
checks and harness selection. No DTO/schema/storage-version/format/cap/dependency changes.
Mode/mtime/empty directories/binary and independent-writer atomicity remain limits.
Source-only: no capture execution, native equivalence, round-trip or whole-Bible acceptance.


### Inactive selected Git merge-message original

Explicit `git: true` includes optional exact SELECTED-gitdir `MERGE_MSG` as inactive
`.git/MERGE_MSG` through the shared selected-original list and existing `providerFiles`
carrier with `removedSecretFields: false`, only when every existing export check passes.
The slot remains selected when gitDir equals commonDir; linked capture never stats,
reads or substitutes common/main/other-worktree MERGE_MSG. No other metadata allowance
or traversal changes. Common lost-found and unknown private-storage guards stay.

Pinned Git v2.56.0 [merge.c845–936](https://github.com/git/git/blob/v2.56.0/builtin/merge.c#L845-L936)
writes/edits/reads this message with ordinary merge state, which remains refused when
MERGE_HEAD is present. A [squash conflict path](https://github.com/git/git/blob/v2.56.0/builtin/merge.c#L1756-L1767)
skips write_merge_state and [appends conflict hints](https://github.com/git/git/blob/v2.56.0/builtin/merge.c#L988-L1007)
to MERGE_MSG. This does not guarantee capture of every conflicted repository: all
object/ref/index/storage/topology checks still apply independently.
[commit.c184–191](https://github.com/git/git/blob/v2.56.0/builtin/commit.c#L184-L191)
determines merge whence from MERGE_HEAD, while [797–850](https://github.com/git/git/blob/v2.56.0/builtin/commit.c#L797-L850)
separately reads existing MERGE_MSG as message input before writing COMMIT_EDITMSG;
explicit message options have precedence. Objects or COMMIT_EDITMSG cannot substitute
exact original bytes. [branch.c804–818](https://github.com/git/git/blob/v2.56.0/branch.c#L804-L818)
removes the message during normal cleanup: no universal leftover-retention guarantee.
[path.c1564](https://github.com/git/git/blob/v2.56.0/path.c#L1564) names the slot; its
[common list](https://github.com/git/git/blob/v2.56.0/path.c#L90-L115) and
[resolver](https://github.com/git/git/blob/v2.56.0/path.c#L331-L405) leave it selected-private.
These references establish that release's provenance, not all-version compatibility.

Presence or absence of MERGE_MSG proves no quiescence or resumable operation. Every
existing MERGE_HEAD/REBASE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD/BISECT_LOG/rebase-directory/
index.lock hold remains unchanged. No message/OID/template interpretation, synthesis,
reference chasing, active installation or merge/commit/rebase/cherry-pick/editor/hook
continuation. Accepted opaque UTF-8/BOM/empty-present bytes survive; optional absence
creates no original. Recognized secrets refuse without rewriting; sensitive prose and
concealed secrets remain limits, without a general draft-body URL-userinfo guarantee.
NUL/binary/invalid UTF-8, unsafe topology and foreign ownership refuse. Shared canonical
same-owner regular single-link no-follow bounded reads and complete raw before/after
identity/hash/absence/reciprocal-association checks refuse observed drift.

Shared classification/provenance/selected capture/export and first native-view skip
exclude the message before copy/parse/pack pairing. Working export validates the full
manifest; import requires Git selection, a valid Git manifest and false removal before
numbered mode0600 nonexecutable `.review` originals/maps are written. Retained re-export
reads only the authoritative original manifest. No source writes or active MERGE_MSG.
Existing 1 MiB/original, 1,000 combined review files/32 MiB, 20,000 raw nodes/32 MiB and
hook bounds, graph/config/format/sparse/index/log/shallow checks and harness selection
remain. No DTO/schema/storage-version/format/cap/dependency changes. Mode/mtime/empty
directories/binary and independent-writer atomicity remain limits. Source-only: no
capture execution, native equivalence, round-trip, atomicity or whole-Bible acceptance.
