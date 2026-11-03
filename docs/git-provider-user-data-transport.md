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
apparently complete Git export. Supported reciprocally associated linked worktrees use the explicit Git authority described below. External alternates/includes, unsupported shared layouts, combined split/sparse index storage, shallow history and unfinished selected-worktree Git operations refuse.

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
afterward, including association re-reads. The backlink must be
absolute and exact. Normal `.git` directories continue to refuse `gitdir` or
`commondir` indirection. Directory/pointer identity, bytes and change times are
rechecked before repository-content reads and in the before/after capture.
Association records alone may be read while establishing this authority; no
broad filesystem/repository search or other-worktree inventory is performed.
Ambiguous, broken, foreign-owner, changed or unsupported topology refuses.
Ownership supports association validation; explicit human selection supplies
permission. This implementation batch performed no live external-repository reads.

Only selected private `HEAD`, `index`, exact linked `sharedindex.<OID>` originals,
`config.worktree`, `info/sparse-checkout`, `logs/HEAD`, loose
`refs/{bisect,rewritten,worktree}/**` and matching `logs/refs` supply selected state.
Shared `config`, `packed-refs`, public `refs`, `objects` and public `logs/refs`
supply repository state. The common repository's private HEAD/index/config.worktree/patterns/HEAD
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
commondir, hooks, logs, index and sparse settings are never copied into its active
metadata. Native startup therefore cannot discover the selected/common/ancestor
repository, resolve a live include, refresh a shared index or update a linked
backlink. Captured source config is parsed separately with the existing isolated
stdin parser and include declarations still refuse. Ref names/targets and packed
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
alternates), promisor/unknown object metadata, commit-graph/info files, incomplete
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
association records, HEAD, index, config.worktree, info, refs, logs, the excluded
administrative `locked` record and canonical `sharedindex.<OID>` names. Only the
exact index-linked sharedindex original is read. Unknown names, unsupported
pseudorefs and operation metadata refuse; administrative ownership is not copied.

Private refs are review data, not migration of an active bisect/rebase operation.
Main-worktree private logs are excluded, not read. Unsupported selected operation metadata, shallow history, grafts,
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

Only `link`, the empty `sdir` marker and the known derived `TREE` cache extension are accepted; combined split/sparse storage refuses. TREE's
complete count/length grammar is checked and its cache is not adopted. Other
extensions, including resolve-undo, untracked/fsmonitor caches and offset tables,
refuse rather than silently lose semantics. Unknown layouts remain unsupported. Both logical and storage entry inventories are bounded to
10,000. Unsupported originals remain at source.

Recovery writes the existing exclusive **full** v2/v3 review index into a new
inactive standalone review repository. Split/shared storage layout, raw stat
cache values, shared-file timestamps and cache extensions are deliberately not
reproduced. This is logical index recreation, not byte-identical storage
recreation. Original/partial recovery retention, credential refusal and inactive
configuration/ownership behavior are unchanged. No native capture or runtime
qualification was performed for this batch.

Source references: [Git index and split-index format](https://git-scm.com/docs/index-format),
[Git split-index merge](https://github.com/git/git/blob/master/split-index.c),
[EWAH serialization](https://github.com/git/git/blob/master/ewah/ewah_io.c) and
[shared-index read/freshening](https://github.com/git/git/blob/master/read-cache.c).

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

### Selected local reflogs

The explicit Git checkbox/API selection now includes ordinary local `.git/logs/HEAD`
and `.git/logs/refs/*`. No reflog is read when Git is not selected. The required
`git.reflogs` array contains `{path,dataBase64}` entries relative to `logs/`.
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

The shared `scrubReviewToml` reader handles selected `.codex/config.toml` live
export and imported-manifest validation. Accepted nonsecret source spans stay
byte-for-byte unchanged. Recognized secret-key assignments are removed as
whole spans, including multiline payload, trailing comment and terminating newline;
`removedSecretFields` records the removal. Import refuses such retained assignments.
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
Any decoded secret segment removes the whole safely delimited assignment; a secret
static/array-table path or retained inline-member path refuses the complete selection.

A recognized secret assignment may contain any supported value; the complete
assignment is parsed before removal. A recognized secret member nested within an
otherwise nonsecret inline table refuses the entire selection with an explicit
message; no partial member rewrite or unrelated-setting loss is performed. Every
retained string leaf is decoded and inspected, including leaves nested in arrays
or inline tables. The remaining raw-text scan is unchanged.

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
outside that selection. Missing listed files are absent, not invented defaults.
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

Sanitized provider configuration also recreates as nonexecutable `N.review` files
under `.ponderosa-portable-review/provider-files`, with an original-path mapping in
`manifest.json`. Humans can read the actual retained configuration without base64
decoding. Original `.claude`/`.codex` paths are not installed; settings activation
still requires separate human review/action.

| Field | Implemented disposition |
| --- | --- |
| `git.format`, `objects[].{oid,type,dataBase64}` | SHA-1/SHA-256 exact decoded object bytes. Hash includes Git type/length header; commit/tree/tag edges and staged blob originals must exist. Supported normal local `.git` and the explicit reciprocally validated selected-worktree/common-directory association above only. Associated shared objects are explicitly authorized by Include Git; unassociated external/common directories and alternate object stores refuse. All objects, including unreachable objects, receive known-credential inspection; a recognizable credential refuses the selection instead of rewriting Git identity. |
| `git.refs[].{name,oid,symbolic}`, `head` | Original branch/tag/other ref names, object IDs and symbolic/detached HEAD preserved. Fresh loose refs in the review repository. Source worktree pointers, branch ownership, lock and lifecycle receipts never travel. |
| `git.index[].{mode,oid,stage,path,intentToAdd,assumeUnchanged,skipWorktree}` | Fresh v2/v3 review index retains exact original stage 0–3 identities, paths and file/executable/symlink/gitlink modes plus the three explicit flag booleans. Intent-to-add remains intent, not staged content. Original stat caches, uid/gid/inodes and filesystem monitor data are not copied. Ordinary staged/unmerged content is retained. Supported local v2/v3/v4 split storage normalizes to this full index; unknown flags/extensions and unsupported sparse forms refuse; supported sparse-directory trees expand from verified captured objects only. |
| `git.configurationReview[].{key,value,implicitBoolean?,source?}` | Nonsecret local configuration is retained as ordered inert review entries, including repeated keys, valueless booleans and hook/fsmonitor command text. Optional `source:"config.worktree"` distinguishes exact local worktree settings; omitted source means local `config`. Local include/includeIf declarations now refuse before repository-aware plumbing, so external settings are neither resolved nor silently used. All credential-helper/username fields and password/token/authorization/extra-header fields and source core.worktree metadata are excluded. `extensions.worktreeConfig` and sparse booleans survive only as inactive review entries. URL userinfo is refused from the retained configuration. Source configuration is never installed as executable destination config. |
| Git hook files | Excluded explicitly; no hook bytes or executable files are copied. The review repository disables hooks/fsmonitor. A nonsecret local hooksPath value remains inactive configuration review text, not a copied hook or a destination path choice. |
| `providerFiles[].{path,dataBase64,removedSecretFields}` | Supported project-root Claude/Codex/MCP settings, instructions and custom commands/agents/skills/rules remain inactive review data. JSON known secret fields are removed structurally. Codex TOML uses the shared [bounded structured reader](#bounded-toml-syntax): whole recognized credential assignments are removed, including multiline payloads; accepted nonsecret source bytes survive. Import enforces the same grammar and rejects retained credential assignments. Unsupported forms or remaining recognizable credentials refuse. No commands, hooks, permissions or servers are activated. |
| `git.sparseReview.{patternsBase64,directories}` | Required explicit inactive data: exact local `info/sparse-checkout` bytes (or literal null when absent) and original collapsed directory path/mode/stage/OID/flag records. Import re-expands verified trees and requires exact equality with the covered full logical index; no pattern matching, settings installation or sparse activation. |
| `exclusions` | Explicit format/credential/ownership limitations, without secret values. An exclusion is not evidence that the data is unnecessary. |
| `recreationScope.absoluteLinks/crossRootLinks/specialNodes` | Required literal `refuse`; no external authority, dereference or conversion to regular bytes. |
| `recreationScope.cyclicLinks` | New exports declare `passive_in_root`; old `refuse` remains accepted and enforced before destination writes. Working-folder `cyclicLinks` independently declares the same supported policy; missing policy means `refuse`. Both contracts must permit any cycle. |
| `recreationScope.acl/xattrs` | Required literal `not_inspected_preserve_source`. Current host file API does not inventory or reproduce ACL/xattrs. Import refuses a manifest claiming stronger semantics. Ordinary modes/mtime do not establish equivalent access rules or metadata. Source retention remains necessary wherever these attributes matter. |

Project-root `.mcp.json` and recursive regular custom `.claude/rules` files use
only the explicit harness selection and the same bounded, canonical-parent,
no-follow original reader and import whitelist as other provider review files.
MCP JSON uses recursive known-secret field removal; remaining nonsecret server
settings survive, and remaining recognizable credentials refuse. Rule text and
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
formatting and credential fields are not copied. Include/includeIf declarations
refuse before repository-aware plumbing, rather than permitting an external
include to influence sparse meaning. Home profiles are never selected. Linked/common directories require the separate reciprocal Git authority above. Worktree sparse values require an explicit local
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
writers or prove an arbitrary-writer atomic snapshot. The bounded binary v2/v3/v4 index reader refuses unknown layouts and extensions. Known credential paths in Git trees/index refuse the whole selection, preserving Git object identity instead of dropping files. Git control paths must be ordinary local originals, with no external symlinks or hardlinks; Git hook files are never read. Known-secret inspection detects recognized fields/syntax,
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
