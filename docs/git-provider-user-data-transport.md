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
apparently complete Git export. Linked worktrees currently refuse explicitly, as do external/shared object storage, sparse indexes, shallow history and unfinished Git operations.

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
Sparse index storage, linked/common-dir repositories, unsupported binary
layouts and other flags remain separate gaps. Supported ordinary split storage
normalizes to a full review index as described below. No native capture, tests or builds
were run for this source change.

Source references: [Git index format](https://git-scm.com/docs/gitformat-index),
[Git cache flag definitions](https://github.com/git/git/blob/master/read-cache-ll.h)
and the binary storage references below.

### Ordinary local split-index storage

Explicit Git selection accepts bounded version-2/version-3/version-4 full or split index
originals inside the selected normal local `.git`. Capture decodes the index
checksum, entries, supported flags and complete extension boundaries directly;
it never invokes native Git to read an index. Native Git's split-index read path
freshens shared-file mtime, so the former `ls-files` diagnostic path is removed.
The existing DTO and import validator are unchanged.

A `link` extension resolves only its exact `sharedindex.<checksum>` original in
that same canonical `.git`. No shared-file directory scan, external pointer or
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

Only `link` and the known derived `TREE` cache extension are accepted. TREE's
complete count/length grammar is checked and its cache is not adopted. Other
extensions, including resolve-undo, untracked/fsmonitor caches, offset tables and
sparse-directory extensions, refuse rather than silently lose semantics.
Sparse-index/sparse-checkout and unknown layouts
remain unsupported. Both logical and storage entry inventories are bounded to
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
index-reading commands. Sparse storage/checkout and external repository authority
remain unsupported. Destination storage stays the existing inactive standalone
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
bytes remain. General linked-worktree/common-dir logs and historical logs whose
objects are unavailable remain unsupported. No tests or native capture/recreation
were run for this source change.

### Bounded TOML syntax

The same `assertSupportedReviewToml` guard runs before export sanitization and
before import accepts `.codex/config.toml`. Table headers must be consumed in
full: `[bare.path]` or `[[bare.path]]`, with matching single/double brackets,
ASCII bare segments (`A-Z`, `a-z`, digits, `_`, `-`), optional whitespace around
segments/dots/brackets and an optional trailing comment. Every segment is checked
for a known-secret field, including array-table paths. Quoted/escaped headers
refuse before segment extraction. Unmatched, partial or otherwise unsupported
bracket-leading lines refuse instead of falling through to text inspection.
This also excludes bracket-leading array continuation lines that are not headers.

Dotted assignments, inline-table syntax, escaped assignment keys and multiline
strings remain unsupported and refuse. Ordinary single-key assignments retain
the existing simple string credential-removal rule and known-secret text scan.
This is a deliberately limited transport reader, not general TOML validation.
No TOML dependency is added. The conservative quote/backslash check covers the
entire header line, so those characters in a trailing comment also refuse.

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
| `git.format`, `objects[].{oid,type,dataBase64}` | SHA-1/SHA-256 exact decoded object bytes. Hash includes Git type/length header; commit/tree/tag edges and staged blob originals must exist. Normal local `.git` only; no external common-dir or alternate object inventory is inferred. All objects, including unreachable objects, receive known-credential inspection; a recognizable credential refuses the selection instead of rewriting Git identity. |
| `git.refs[].{name,oid,symbolic}`, `head` | Original branch/tag/other ref names, object IDs and symbolic/detached HEAD preserved. Fresh loose refs in the review repository. Source worktree pointers, branch ownership, lock and lifecycle receipts never travel. |
| `git.index[].{mode,oid,stage,path,intentToAdd,assumeUnchanged,skipWorktree}` | Fresh v2/v3 review index retains exact original stage 0–3 identities, paths and file/executable/symlink/gitlink modes plus the three explicit flag booleans. Intent-to-add remains intent, not staged content. Original stat caches, uid/gid/inodes and filesystem monitor data are not copied. Ordinary staged/unmerged content is retained. Supported local v2/v3/v4 split storage normalizes to this full index; unknown flags/extensions and sparse semantics refuse. |
| `git.configurationReview[].{key,value,implicitBoolean?}` | Nonsecret local configuration is retained as ordered inert review entries, including repeated keys, valueless booleans, hook/fsmonitor command text and external include references. Includes are not followed to export their contents. All credential-helper/username fields and password/token/authorization/extra-header fields and source core.worktree metadata are excluded. URL userinfo is refused from the retained configuration. Source configuration is never installed as executable destination config. |
| Git hook files | Excluded explicitly; no hook bytes or executable files are copied. The review repository disables hooks/fsmonitor. A nonsecret local hooksPath value remains inactive configuration review text, not a copied hook or a destination path choice. |
| `providerFiles[].{path,dataBase64,removedSecretFields}` | `.claude/settings.json`, `settings.local.json`, `CLAUDE.md`, `.codex/config.toml`, `instructions.md`, and regular custom files under Claude commands/agents/skills and Codex skills/rules. JSON known secret fields are removed structurally, preserving other settings. Simple single-line TOML credential assignments are excluded; multiline TOML refuses rather than guessing continuation boundaries. Dotted assignment keys (including `api_key.value`), inline-table syntax and escaped keys refuse before export and on import; quoted or escaped table/array-table paths refuse before segment inspection, and known-secret bare table paths also refuse. The conservative table guard rejects any bracket-leading line with quotes or backslashes, including otherwise harmless quoted header comments or array continuation lines. The conservative inline-table guard also refuses braces in noncomment lines, even inside a quoted value. This bounded reader does not claim structural support for those TOML forms. Remaining known-credential syntax refuses. Commands/MCP/permissions/hooks remain human-review data, with no grant or execution. |
| `exclusions` | Explicit format/credential/ownership limitations, without secret values. An exclusion is not evidence that the data is unnecessary. |
| `recreationScope.absoluteLinks/crossRootLinks/cyclicLinks/specialNodes` | Required literal `refuse`. Existing folder inventory refuses these semantics; there is no dereference or silent conversion to regular bytes. A package requiring them needs a new supported recreation contract. |
| `recreationScope.acl/xattrs` | Required literal `not_inspected_preserve_source`. Current host file API does not inventory or reproduce ACL/xattrs. Import refuses a manifest claiming stronger semantics. Ordinary modes/mtime do not establish equivalent access rules or metadata. Source retention remains necessary wherever these attributes matter. |

Export plumbing is source code only: `rev-parse`, `symbolic-ref`, `for-each-ref`,
`config --local --no-includes` and `cat-file --batch-all-objects`.
It drops inherited Git overrides, disables system/global config, fsmonitor,
optional locks, replacement objects, lazy fetching and terminal prompts. No shell
command interpolation or mutating Git command is used. Before/after
refs/HEAD/logical index/config/reflogs plus raw index/shared-index bytes and identity and full object streams must match. Each native
call has a 30-second and 32 MiB output bound. Git objects are bounded
to 32 MiB and 10,000 objects; refs/index entries to 10,000 each; provider files
to 1 MiB each and 1,000 entries. Whole artifact limits still apply. Refusal preserves
the source instead of truncating data.

The existing source fence and before/after checks do not drain independent native
writers or prove an arbitrary-writer atomic snapshot. The bounded binary v2/v3/v4 index reader refuses unknown layouts and extensions. Known credential paths in Git trees/index refuse the whole selection, preserving Git object identity instead of dropping files. Git control paths must be ordinary local originals, with no external symlinks or hardlinks; Git hook files are never read. Known-secret inspection detects recognized fields/syntax,
not arbitrary unidentified credentials disguised as ordinary user bytes. Objects
whose inspection text exceeds 4 MiB refuse; the JSON review manifest is limited
to 48 MiB. Provider settings are never made active by inspection alone.

Exact remaining implementation: scoped linked-worktree/common-dir Git export;
unsupported index flags/extensions and sparse-index
semantics; staged submodule repository originals; custom external Git include/hook
contents; arbitrary other provider configuration formats; general multiline TOML
secret separation; explicit reviewed activation into a native-owned live Git or
provider configuration; recursive re-export of already recreated review data.
Whole-folder re-export of an existing review namespace refuses rather than
silently replacing its original transport; selected review originals remain
exportable. Existing canonical package-history re-export retains the original
manifest/artifact bindings through its normal path; it does not traverse or adopt
the generated repository. Required absolute/cross-root/cyclic links, ACL/xattrs, special nodes,
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
