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
apparently complete Git export. Linked worktrees currently refuse explicitly, as do external/shared object storage, split/sparse indexes, shallow history and unfinished Git operations.

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
| `git.index[].{mode,oid,stage,path}` | Fresh v2 index retains original stage 0–3 identities, paths and file/executable/symlink/gitlink modes. Original stat caches, uid/gid/inodes and filesystem monitor data are not copied. Ordinary staged/unmerged content is retained. Extended flags, intent-to-add, assume-unchanged and skip-worktree refuse; these are unsupported data semantics, not secret exclusions. |
| `git.configurationReview[].{key,value,implicitBoolean?}` | Nonsecret local configuration is retained as ordered inert review entries, including repeated keys, valueless booleans, hook/fsmonitor command text and external include references. Includes are not followed to export their contents. All credential-helper/username fields and password/token/authorization/extra-header fields and source core.worktree metadata are excluded. URL userinfo is refused from the retained configuration. Source configuration is never installed as executable destination config. |
| Git hook files | Excluded explicitly; no hook bytes or executable files are copied. The review repository disables hooks/fsmonitor. A nonsecret local hooksPath value remains inactive configuration review text, not a copied hook or a destination path choice. |
| `providerFiles[].{path,dataBase64,removedSecretFields}` | `.claude/settings.json`, `settings.local.json`, `CLAUDE.md`, `.codex/config.toml`, `instructions.md`, and regular custom files under Claude commands/agents/skills and Codex skills/rules. JSON known secret fields are removed structurally, preserving other settings. Simple single-line TOML credential assignments are excluded; multiline TOML refuses rather than guessing continuation boundaries. Remaining known-credential syntax refuses. Commands/MCP/permissions/hooks remain human-review data, with no grant or execution. |
| `exclusions` | Explicit format/credential/ownership limitations, without secret values. An exclusion is not evidence that the data is unnecessary. |
| `recreationScope.absoluteLinks/crossRootLinks/cyclicLinks/specialNodes` | Required literal `refuse`. Existing folder inventory refuses these semantics; there is no dereference or silent conversion to regular bytes. A package requiring them needs a new supported recreation contract. |
| `recreationScope.acl/xattrs` | Required literal `not_inspected_preserve_source`. Current host file API does not inventory or reproduce ACL/xattrs. Import refuses a manifest claiming stronger semantics. Ordinary modes/mtime do not establish equivalent access rules or metadata. Source retention remains necessary wherever these attributes matter. |

Export plumbing is source code only: `rev-parse`, `symbolic-ref`, `for-each-ref`,
`ls-files`, `config --local --no-includes` and `cat-file --batch-all-objects`.
It drops inherited Git overrides, disables system/global config, fsmonitor,
optional locks, replacement objects, lazy fetching and terminal prompts. No shell
command interpolation or mutating Git command is used. Before/after
refs/HEAD/index/flags/debug/config and full object streams must match. Each native
call has a 30-second and 32 MiB output bound. Git objects are bounded
to 32 MiB and 10,000 objects; refs/index entries to 10,000 each; provider files
to 1 MiB each and 1,000 entries. Whole artifact limits still apply. Refusal preserves
the source instead of truncating data.

The existing source fence and before/after checks do not drain independent native
writers or prove an arbitrary-writer atomic snapshot. The bounded `ls-files
--debug` flag reader refuses an unfamiliar diagnostic layout; Git documents that
layout as unstable. Known credential paths in Git trees/index refuse the whole selection, preserving Git object identity instead of dropping files. Git control paths must be ordinary local originals, with no external symlinks or hardlinks; Git hook files are never read. Known-secret inspection detects recognized fields/syntax,
not arbitrary unidentified credentials disguised as ordinary user bytes. Objects
whose inspection text exceeds 4 MiB refuse; the JSON review manifest is limited
to 48 MiB. Provider settings are never made active by inspection alone.

Exact remaining implementation: scoped linked-worktree/common-dir Git export;
reflogs and their original user metadata; extended/intent-to-add/sparse-index
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
