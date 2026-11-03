# U3 recreation inventory and U5 recovery disposition

Source basis: approved `595681b750776c5f3c765de1f040f0931f6d8750`, full
Behavior Bible #8/#12/#15/#30. This is a field-by-field source disposition, not a
fresh-machine equivalence verdict or approval to omit nonsecret data. Source and
fixture changes only; nothing was executed or prepared for execution.

## U3: package fields

The authoritative formats are `AgentPortablePackageDto` / `PortableAgentNodeDto`
in `packages/core/src/dto/agents.ts`, and `BranchPackageDto` /
`InstalledBranchPackage` in `packages/core/src/branches.ts`. The exact-field parser
refuses unknown fields. All consumers use the shared Agent package engine; these
changes do not add a parallel importer. Full mode requires the sensitive-data
warning; templates intentionally contain setup rather than stored work.

| Field family (all current package fields) | Recreation disposition |
| --- | --- |
| `schema`, `mode`, `kind`, `exportedAt`, `sourceLabel` | Format, content selection and provenance retained; no authority. |
| `rootRef`, optional `rootRefs`, `agents[].ref`, `managerRef` | Complete included reporting graph and independent same-Chat roots; fresh destination IDs and exact returned `agentRefs`. Cross-Chat existing-Agent relocation is not an export/import requirement and is not invented here. |
| `sourceProjectInstructions` | Full-mode Chat instructions, explicit keep/use-source conflict choice against destination hash. |
| `title`, `engine`, `model`, `effort`, `speed` | Declared selections retained; chosen destination engine/model/tier must be available or import refuses. Title normalization and destination ID allocation are existing behavior, not byte-identical identity restoration. |
| `role`, `initialInstructions` | Standing guidance retained separately; managed artifact references rebound to included originals. |
| `presetSnapshot.{id,name,description,guidance,engine,model,effort}` | Nonsecret saved setup retained as provenance/guidance, not a grant or destination preset installation. |
| `managementPermissions.{allowAutomaticDescendantDeletion,allowAutomaticDescendantReorganization}` | Explicit included settings; existing elevated-management acknowledgement still required. |
| `accessSettings.restrictedCapabilityIds` | Effective nonsecret restriction suggestions; explicit hash-bound human keep/apply review on fresh Agents. |
| `accessSettings.{readGlobalMemory,savedBrowserAllowed,browserMode,sourceProfileName}` | Inert suggestions mapped to fresh destination identities. Existing human Settings APIs alone apply destination grants/profile selection. Source profile name is not a destination ownership receipt. |
| `workingCopyMode`, `sourceChat.{ref,title}`, `workingRootRef` | Shared/Separate Git intent and root membership retained; new managed ownership created locally. Absolute source root paths and source branch/worktree ownership receipts are not adopted. |
| `workingFiles[].{path,artifactRef,mode,mtime}` | Explicitly selected originals; canonical artifact bytes and ordinary metadata. `workingFolder` selects the whole nonsecret root, independently for distinct roots. File selection is explicit, not an implicit backup of every user folder. |
| `workingFolder.{mode,mtime,directories[].{path,mode,mtime},excludedPaths}` | Root/empty-directory topology and ordinary metadata; every omitted known credential/native path is listed. New-only recovery destination, or separately confirmed fresh managed live root. Partial destination bytes and displaced baseline/path sidecars survive failure. |
| `workingFolder.links[].{path,kind,target,mtime}` (new) | Relative in-root symbolic targets (including dangling targets) and complete in-root regular hardlink equivalence sets. One regular artifact per inode, aliases recreated with `link`; symbolic spelling restored with `symlink`, timestamp with `lutimes`. No target dereference is used to export a symbolic link. |
| `history[].{role,text,createdAt}` | Stored authored/imported history retained within existing package bounds; explicit refusal rather than clipping. |
| `history[].communication`, `communicationRevisions` | Original immutable actor/scope/audience/identity/timestamps/correlations/citations/document metadata and edits retained. Source IDs remain historical; no new deliveries, Requests or Runs. |
| `history[].attachmentRefs`, `artifactRefs` | Ordered attachment originals and document bindings remapped to new managed artifact IDs; originals retained on re-export. |
| `artifacts[].{ref,kind,path,summary,createdAt,mediaType,visibility,pinned,sourcePath,dataBase64}` | Original bytes and declared artifact metadata retained subject to the existing codec/hash/type/size checks; new managed ownership. Source path is provenance, not an authorized host path. Execution-log artifacts carry normalized events and historical Run status/times, never leases or active effects. |
| `memory[].snapshot.{schema,signature,sourceChatId,agentIds,excludedScopes,chunks,conflicts}`, `agentRefs` | Chat/team and included private audiences, version/conflict lineage, text, structured metadata, embedding vectors and full provenance retained. Compatible model/storage required; destination principal/Chat/private audience remapped and original stamps inert. Global memory is separately selected/reviewed, not implicitly copied. |
| `outputRoles[].{ref,output,speaker}` | Intent retained; existing singleton-speaker collision and activation review remain mandatory. |
| Simple Branch `schema`, `exportedAt`, `definition` | Definition-only package: graph/steps/edges/templates/control/policy/parameters/trigger references. No claim that definition-only export includes installation data. |
| Installed Branch `schema`, `packageId`, `mode`, `exportedAt`, `definition` | Workflow configuration and stable package identity retained for explicit installation review. Definition includes all current graph, state/control, instructions, tools/action config references, failure policies and embedded templates. |
| Installed Branch `chats[].{ref,title,instructions,agents[].{ref,managerRef,definition}}`, `agentBindings` | Logical Chat/Agent/ref maps plus shared engine packages; complete within-Chat included graph recreated under fresh canonical owners. Source external Agent/Branch/directory bindings need explicit destination mappings. |
| Installed Branch `limits`, `parameters`, `triggers`, `engines`, `outputRoles` | Existing limits and trigger configuration/enabled intent/engine mappings/roles. Parameter values require full mode plus explicit `includeValues`; secret values are excluded and re-entered. Trigger occurrence queues, usage consumption and active leases are not replayed. |

Known structured credential fields are scrubbed/rejected by `portable-secrets.ts`;
known credential paths are excluded. Arbitrary prose/binary data may still contain
sensitive material, hence the export warning. This is not a claim that every
secret in opaque user data can be discovered. Read/global grants, installation
policy, provider accounts and browser ownership are reviewed/re-entered rather
than imported as foreign authority; their nonsecret suggestions are distinguished
from missing user-data transport below.

## U3: filesystem and native inventory

| Entry/property | Concrete behavior and exact requirement limit |
| --- | --- |
| Regular content and directories | Existing selected/whole-root transport plus ordinary permission bits and mtime; explicit 10,000-entry / package-byte bounds protect inventory/codec memory, never silently truncate. |
| In-root relative symlinks | Implemented in whole-root transport. Declared link leaves cannot be parents; target graph must stay inside the selected nonsecret root even after intermediate link expansion. Links install after regular files, before final directory timestamps. |
| In-root hardlinks | Implemented with one bounded regular original and exact alias targets. All aliases must be included; original/alias inode identity is checked around export. Import cannot link an arbitrary existing destination file. |
| Absolute/escaping symlinks; hardlinks outside selected root | Refuse explicitly. Target data and complete aliases are outside the selected package, so recreating the existing spelling/alias cannot guarantee a working fresh-machine root. Needed external content must be separately selected and reviewed; cross-root relocation/link rewriting is not implemented or claimed approved. |
| Cyclic symlinks | Passive relative in-root cycles preserve original path/target spelling/optional mtime under explicit `workingFolder.cyclicLinks: passive_in_root`. Shared prefix-substitution validation requires exact bounded repeated resolved/pending states; growing, escaping, excluded and unsupported chains refuse. Missing/old `refuse` policies still refuse cycles; embedded review refusal is also enforced. No dereference, rewriting or file-byte conversion. |
| FIFO/socket/block/character device | Refuse at inventory before opening/reading it. A live endpoint's process/kernel state is not ordinary bytes and is not fabricated. Persistent FIFO/device-node topology is still unsupported; if needed for the selected workflow it remains a concrete recreation gap, not a Bible-approved blanket exclusion. |
| uid/gid, ACLs, xattrs, birth/ctime/atime, sparse extents, special ownership bits | Not represented by the current DTO. Ordinary content/mode/mtime are the only preservation claims. Host principal numbers/native attributes are not destination authority; loss of nonsecret required ACL/xattr/special-file semantics remains an exact format/platform gap. No byte-identical filesystem claim. |
| `.git` working-tree pointer; common-dir/worktrees links, ownership markers, branch creation/cleanup receipts, locks | Not adopted. Destination working-copy service creates its own branch, paths, receipts and cleanup ownership. Adopting source receipts would misidentify a foreign worktree as locally owned. This is separate from user Git data. |
| Git commits/objects, branches/tags/refs, reflogs, index/staged state, config/hook content | Unchecked Agent/organization and full Branch export controls pass explicit `reviewedUserData` choices for selected whole folders. This selection transports supported local Git objects/history, refs/HEAD, normal local reflogs with exact nonsecret user/time/message metadata, saved resolve-undo conflict stages and staged index originals with intent-to-add, assume-unchanged and skip-worktree (including supported local v2/v3/v4 full/split-index and ordinary sparse-directory logical state normalized into a full review index, without adopting source stat/shared storage) through the shared package flow into a separate review repository. Selected linked-worktree loose private refs and matching reflogs use that same inactive transport. Nonsecret configuration is inactive review data; Git hook files are explicitly excluded and destination Git ownership stays local. See [exact contract and refusals](git-provider-user-data-transport.md). Unsupported linked layouts, packed private refs/unknown selected ref storage, unsupported reflog formats or missing/pruned reflog objects, unsupported index flags/extensions, combined split/sparse storage and other unsupported sparse forms, live activation and other listed families remain unsupported; fresh Git initialization alone is not equivalent recreation. |
| Derived local Git commit-graph caches | Common `objects/info/commit-graph` and exact split `commit-graphs/{commit-graph-chain,graph-{format-width lowercase hash}.graph}` names are bounded same-owner canonical single-link regular no-follow observations. Exact raw directory/file identity/hash/absence checks detect observed drift; known-secret inspection remains. Cache bodies/chain are never interpreted or used as graph proof. Native read views skip caches before copying objects; export exclusions document omission and recreation installs no caches. Verified objects and existing graph/ref/log/index/REUC/sparse/shallow semantics remain authority; caches are rebuildable but no rebuild runs. Unknown names/topologies, unsupported multi-pack-index/retention-layout/reftable/promisor/alternates remain refused. No DTO/version change, live source write or native working-root adoption. Source/partial bytes remain; no runtime/capture/round-trip/native/atomicity qualification. |
| Derived local Git multi-pack-index caches | The shared derived-cache path observes exact common `objects/pack/multi-pack-index`, hash-named `.bitmap`/`.rev` companions and `multi-pack-index.d/{multi-pack-index-chain,multi-pack-index-{hash}.{midx,bitmap,rev}}` names from pinned Git v2.54.0. Declared lowercase hash width, canonical same-owner single-link regular no-follow reads, bounds, known-secret inspection and raw before/after identity/hash/absence checks apply. Opaque bodies/chain are never followed or used as proof; native views skip caches before pack pairing/copying. Ordinary pack/idx pairing and verified objects/ref/log/index/REUC/sparse/shallow remain authority. Explicit omission is rebuildable; no rebuild, cache DTO/recreation, native working metadata or external-store traversal. Unknown names/topology/locks, alternates/promisor/unsupported-retention-layout/reftable still refuse. Source/partial bytes remain; cleanup unchanged. Source-only, no runtime/capture/round-trip/native/atomicity qualification. |
| Git pack retention (`.keep`, MTME v1 `.mtimes`) | Required inactive `packRetentionReview` preserves exact source pack/v2-index/companion bytes, checksum identity and independently checked index-order OIDs/epoch-second mtimes. Empty keep differs from null absence. Complete pack/index/MTME header, fanout, counts, offsets, CRCs, checksums, boundaries and canonical captured object identities agree on export/import/recreation/re-export, including unreachable objects. Non-delta and earlier in-pack OFS/REF delta bases supported; forward/external bases, v1/large-offset indexes and unsupported MTME forms refuse. Bounded same-owner no-follow single-link raw identity/hash/absence before-after observations and known-secret checks remain. Limits: 1,000 packs, 10,000 entries/pack, 1 MiB index/companion, 32 MiB combined objects/evidence and separate 32 MiB inflation/base-read/reconstruction budget, 10,000 delta instructions/object. Native view omits retention companions. Original bytes/intent remain only in manifest and CONFIGURATION-REVIEW.json; loose-object review recreation does not activate keep/mtime/GC/layout policy. No source writes, metadata installation, maintenance or network; retention intent is distinct from native GC equivalence. Originals/partial copies remain; cleanup unchanged. Source-only; no parser/native/runtime/capture/round-trip/atomicity qualification. |
| Ordinary shallow Git history | Include Git preserves required `shallowReview` exact common-repository bytes/provenance or explicit absence, distinguishing empty-present. Same-owner regular single-link no-follow capture and canonical association/raw before-after identity/hash/absence checks apply. Shared validation requires bounded canonical base64, LF-terminated ASCII, unique nonzero format-width IDs and captured verified commits; only declared commits may omit parents, with syntax and captured parent types still checked. Other graph/object/index/REUC/sparse checks remain. Recreation writes exact `.git/shallow` only inside the newly owned separate review repository, never native working metadata; original manifest remains re-export authority. No graph rewrite, fetch/deepening, external stores, grafts or promisor/partial-clone support. Source and partial bytes remain. Source-only; no runtime/round-trip/native/atomicity qualification. |
| Repository-local Git `info/attributes` and `info/exclude` | Explicit Include Git transports exactly these two common-repository originals as required, path-ordered `infoReview` byte/absence records with `common_repository` provenance. Empty bytes remain distinct from absence. Same-owner canonical parent, regular single-link no-follow files and raw before/after identity/hash/absence checks preserve scope and refuse observed drift. Shared export/import/recreation/retained-original validation enforces the two-path allowlist, bounds, exact base64/UTF-8 and known-secret refusal. Original BOM/line endings/content remain exact; patterns and commands are never interpreted. Destination evidence stays in inactive `CONFIGURATION-REVIEW.json`, outside active `.git/info`; native read views omit it. No external/global files, other private worktrees, filter/hook activation, ownership adoption or extra checkbox. Original/partial bytes remain. No native/runtime/round-trip/atomicity qualification. |
| Git index optional observation caches (`UNTR`, `FSMN`) | Exact signatures accepted as bounded opaque derived caches in full indexes, split overlays and required shared originals. Existing whole-index header/checksum, 1 MiB physical-file/10,000-entry bounds, extension sizes, duplicate checks and EOIE header hashing remain; lossless Latin-1 known-secret inspection uses the existing separate 4 MiB UTF-8 bound. Cache versions/grammar, paths, environment strings, tokens and bitmaps are never interpreted or used as file lists/proof; no monitor/hook/environment lookup. Exact raw identities/bytes and before-after comparison remain. Explicit export exclusions record rebuildable omission; no cache bytes enter DTO/native view/fresh inactive full index or retained-original manifest re-export authority. Logical entries/flags, REUC, sparse/offset semantics, strict unknown optional/required extension and split/sparse refusals remain. No source writes, cache activation, schema/version or cleanup change; originals/partial copies remain. Source-only; no tests/runtime/capture/recreation/round-trip/native-equivalence/atomicity qualification. |
| Git index derived offsets (`EOIE`, `IEOT`) | Bounded full v2/v3/v4 originals and each required split storage file validate EOIE final position, exact length/end offset/header hash and IEOT v1 complete offset/count partitions against sequentially decoded raw entry boundaries. Native v4 full-path block restarts, empty-index version-only tables and a leading empty block after removed entries are supported. Tables never control parsing or use merged offsets. Existing raw identity/byte checks, logical flags/REUC/sparse/private refs, import validation and exact retained-original re-export remain unchanged. Accelerators are omitted in the new inactive full review index; no source writes, stat/layout adoption, active cache/configuration or DTO/version change. Malformed tables, unknown extensions and existing split/sparse combinations still refuse; original/partial bytes remain. Source-only; no tests/native/runtime/atomicity qualification. |
| Git index resolve-undo (`REUC`) | Required `git.resolveUndo` records preserve exact paths and present stage 1–3 canonical modes/OIDs, with missing stages absent. Ordinary full v2/v3/v4 and selected split-overlay extensions decode directly; a required shared-base REUC refuses rather than supplying inherited data. One semantic validator/encoder checks complete grammar, UTF-8/path and byte/stage ordering, duplicates, bounds, known-secret paths and captured blob identities; all captured objects retain hash/secret/graph checks. Raw index/shared-index originals and logical undo state must match before/after. Existing export/import/Shared/retained-original paths carry the same manifest. Inactive standalone recreation writes canonical REUC and index checksum exclusively, with no source writes, checkout or Git index invocation. No stat/layout/operation authority is adopted. Original/partial bytes remain. Required field omission, unsupported modes/storage and missing non-gitlink objects refuse. Gitlink IDs remain exact; submodule contents remain a gap. No tests/native/runtime/round-trip qualification. |
| Explicitly selected linked-worktree Git association | Include Git authorizes only the bounded reciprocal selected `.git` pointer/private `gitdir` backlink/`commondir` association at canonical same-owner `<common>/worktrees/<id>`. Association records/directory identities are checked before repository content and before/after capture. Selected HEAD/index/exact sharedindex/config.worktree/patterns/HEAD log and loose `refs/{bisect,rewritten,worktree}/**` with matching logs remain provenance-separated from shared config/public refs/objects/public ref logs. Common private namespaces/logs are skipped by name before stat/open/descent; main/other worktree private state is not read or substituted. No common/worktrees enumeration. Unknown selected ref storage, packed private refs, duplicate/shadowing paths and out-of-scope symbolic aliases refuse. Names, object/graph/secret and exact reflog validation apply through export/import/retained-original re-export. Native plumbing sees only an exclusive captured temporary Git view with generated format-only config; isolated stdin config parsing, include/alternate refusal, environment/pager/discovery controls prevent unapproved startup reads. Complete bounded raw/logical inventories and required index storage must match; no independent-writer atomicity guarantee. Existing DTO and inactive standalone recreation normalize storage and adopt no ownership/topology or active bisect/rebase operation. Unsupported associations, unknown/promisor object metadata, incomplete packs and existing sparse/index limitations refuse. Source and partial copies remain; successful temporary views remove only known unchanged files and empty directories. Ordinary crossRootLinks stays refuse; authority is separate from working-file traversal. Source-only implementation, runtime unverified. |
| Git sparse-checkout patterns, cone/noncone configuration and collapsed sparse directory originals | Explicit Git selection preserves exact bounded local pattern bytes/absence plus ordered nonsecret local/worktree-config values and source scope as inactive review data. Supported sparse-directory trees expand only from captured hash/graph-verified objects into a full logical v2/v3 review index; original collapsed path/mode/stage/OID/flags remain in required `sparseReview`. Import checks expansion equality, topology and bounds. No pattern interpretation, external includes, source index commands/writes, destination sparse activation or filesystem-derived content. Captured config parsing uses stdin in a fresh private empty cwd with a parent discovery ceiling, system/global files disabled and explicit --no-pager, preventing selected/ancestor startup or pager-config discovery. Empty-only cleanup retains unexpected bytes. Include declarations, unsupported directory flags/booleans/extensions, ambiguous worktree settings, missing/unstable originals and combined split/sparse storage refuse. Explicit Include Git separately authorizes the reciprocally validated selected private gitdir and exact common repository, including external associated storage; no other worktree private state or arbitrary cross-root working files. Selected private sparse/index/config scope is retained and shared objects are used only after captured hash/graph verification. Unsupported associations/packed private refs/unknown selected storage and submodule repository content remain gaps; runtime unverified. |
| Project-root `.mcp.json`, provider `.codex` / `.claude` profiles, browser sessions, `.ssh` / `.aws` / `.gnupg`, `.env*`, known credentials/private-key paths | Listed exclusions; credentials and live owner/session state must be re-entered/recreated. Ordinary selected-file export/import refuses `.mcp.json` path components and `.claude` paths; whole-folder inventory lists their omissions in `excludedPaths`. Explicit harness selection separately transports project-root `.mcp.json`, recursive regular custom `.claude/rules` files and the supported project-root settings/instructions/commands/agents/skills/rules listed in [the review-copy contract](git-provider-user-data-transport.md), with known secrets removed or refused. Nonsecret MCP server settings remain after recursive JSON credential-field removal; remaining recognizable secrets refuse. Rule contents and accepted literal environment references are not interpreted, expanded or followed. They remain numbered nonexecutable `.review` files with original path mappings, never installed settings or tool grants. Host home profiles, sessions and unsupported configuration families are not read or adopted. No universal claim that those directories contain only secrets. |
| `.ponderosa-import-backups` | Private destination recovery bytes/path sidecars retained locally, excluded from package traversal. The source package originals remain managed artifacts; this exclusion does not permit deleting the recovery folder. |
| Concurrent shell/native writers outside Ponderosa | Local stat/identity checks detect observed changes; the in-process source fence cannot stop independent external writers. No arbitrary-writer atomic snapshot guarantee. Use an independently consistent snapshot/export or stop writers before selecting content. |

The shared route forwards `links` through ordinary recovery destinations and
confirmed `populateImportedRoot` live destinations. The existing import operation
retains the manifest for re-export; Shared composition unions identical links and
refuses conflicting topology. Existing owner deletion, group journal retention,
precleanup, source custody and tree-deletion holds are unchanged.

This closes the demonstrated in-root link transport gap. It does **not** close
whole #8 or silently approve Git/native-directory/user-metadata exclusions. The
remaining U3 implementation targets include unsupported linked-layout/packed-private-ref/unsupported-reflog/unsupported-sparse-form
Git data, broader native configuration and explicit reviewed activation; cross-root/absolute and unsupported cyclic link
semantics; persistent special-node/extended metadata transport where required.
Fresh-machine/native/platform qualification remains unrun.

## U5: exact terminal recovery choices

“Terminal” here means the operator has explicitly decided how to handle the
uncertain work. It does not mean the original external effect is now proved done,
failed or drained. Unknown effect state remains visible and fenced.

| Existing evidence | Supported recovery disposition |
| --- | --- |
| Known memory hold `effect.{scope,log,operation}` and available backend | Existing `GET /api/local-memory/mutation-holds/:id` twice observes the exact collection; existing `POST .../:id/reconcile` binds current review, retains original hold plus exact observed rows/hash and explicit operator drain testimony, then settles only that hold. No backend mutation/replay. The snapshot proves current observed data, not the original operation's completion or independent backend drain. |
| Legacy remote-memory hold lacking effect metadata | New explicit `preserve-unknown` choice records a decision bound to the exact canonical original hold hash. No guessed collection, backend read/write, replay, hold deletion or fence release. List continues returning `state:'unsettled',legacy:true` and the disposition receipt. |
| Known effect but unavailable backend or no independent drain proof | Same new preserve-unknown path works directly from the hold inventory; it does not require a successful backend query or claim the collection is settled. Hold remains unsettled. Restore backend evidence later before using the existing evidence-bearing reconciliation path. |
| Exact package/import/native operation/custody receipt exists | Keep the original command/operation/resource identities and use its existing canonical status/readback/reconciliation/abandonment/retirement path. A receipt for a different command, provider turn/item or owner cannot settle this one. Group-journal retention remains audit-only; no cascade release or cleanup follows from this memory decision. |
| External shell/native writer with no participating host journal or exact backend receipt | Preserve original folders/output/backend records, record what is unknown and inspect the actual backend's original operation identity where available. No Ponderosa command can manufacture a missing result receipt or infer success from process exit. Independently start new work only with explicit user intent and fresh owners, without marking original work complete or erasing its evidence. Existing uncertain source-work fences remain. |
| Erased legacy journal/evidence, changed source identities, conflicting original bytes | Explicit refusal/unknown retention. No key reconstruction, hydration/reimport, replay, history rewrite or disk reclamation. |

The underlying backend mutation wrapper receives an ordinary resolved/rejected
Chroma call, not a durable original-operation-key/result lookup. A crash or rejection
can leave an unknown effect. Two identical reads cannot establish the fate of an
unidentified write. User testimony remains labeled testimony. Implementing a
backend-specific original-result lookup requires an actual supported receipt
contract; this change does not invent one or add direct provider HTTP calls.

### Usable operator contract

1. Read `GET /api/local-memory/mutation-holds`. Each exact original returns
   `id`, original `sha256`, optional `effect`, `legacy`, `state` and
   `preserveUnknownReviewSha256`; existing disposition is included if present.
2. To finish the recovery decision while preserving uncertainty, send
   `POST /api/local-memory/mutation-holds/:id/preserve-unknown`:

   ```json
   {"commandKey":"human-chosen-stable-command","reviewSha256":"COPY preserveUnknownReviewSha256 VERBATIM","reason":"Keep original evidence; completion could not be verified","preserveUnknown":true}
   ```

3. Response `MemoryMutationPreserveUnknownReceipt` contains original `id`,
   `holdSha256`, exact command/review/reason, `operatorId:'local-operator'`,
   `disposition:'preserve_unknown'`, `outcome:'unknown'`, `held:true`,
   `replayed:false`, `backendModified:false`. Repeating exactly the same explicit
   command reads the same decision; changed input refuses. No automatic retry.
4. The receipt is fsynced in the existing private memory hold directory under
   `preserved-unknown/<original-id>.json`. Original hold stays untouched. Reopen
   and inventory validate the receipt against the same canonical original hold content;
   conflict/corruption refuses. Atomic publication uses a new private temporary
   file and exclusive link; abandoned temporary bytes can remain after failure.
5. Existing review/reconciliation APIs and origin/operator boundary remain intact.
   UI adoption needs a separate **Preserve unknown** action using this distinct
   review hash; it must not enable the **Reconcile** action or show success/drain.

The decision can be recorded for an inventory-visible known hold even when its
backend is unavailable. It does not make all memory operations usable without a
configured local-memory service. Legacy unsupported preupgrade policy directories
are not adopted or deleted. No new migration, credential store, backend mutation,
source-byte cleanup, replacement owner, or policy/permission change is added.

Deferred source fixtures cover relative/dangling links, inode sharing, private/native
and escaping target refusal, external aliases, parser transport, unchanged source
bytes, legacy decision/reopen/exact replay/conflicts/stale review, known-backend
unavailability, and capture remaining held. No tests, checks, builds, types, Node,
native/browser operation, runner preparation, install, push or deploy occurred.


Passive-cycle transport uses the existing working-link DTO and adds only the
optional folder `cyclicLinks` policy (`refuse` or `passive_in_root`). New whole-folder
exports set the latter; retained old manifests keep their original policy. The
package parser, composer, recovery destination and fresh live-root import preserve
and enforce it. Reviewed-data `recreationScope.cyclicLinks` supports the same two
values; all other recreation restrictions remain unchanged. Shared-root composition
refuses different policies. Resolution bounds are 10,000 steps/expansions, 10,000
serialized-state characters and 10,000 target characters per link; bound excess
refuses, never truncates. Links cannot be installed parent directories. No tests,
fixtures, builds or runtime qualification were performed for this source-only batch.


Whole-folder retained review-original re-export is implemented through the existing
Agent/org/full-Branch consumer. Explicit family selection plus
`reviewedUserData.source: retained_originals` requires one canonical imported
artifact binding and exact original on-disk manifest bytes. Missing/ambiguous,
changed/corrupt, unselected-family or unknown namespace contents refuse. Current
live capture remains separate (`source: live` or omitted); an existing imported
review namespace refuses live whole-folder capture. Generated Git/provider review
copies are skipped and never become originals. The source-free original manifest
and working-file metadata survive existing artifacts, Shared hash/metadata conflict
checks and import; no activation, source adoption, nested namespaces or lineage
flattening. Agent and full Branch dialogs expose the source choice; API/SDK use the
shared request DTO. Selected-file/package-history behavior and cycle policies stay
unchanged. No runtime or platform qualification is claimed.


Selected Codex TOML now uses one bounded structured parser/scrubber for live capture
and imported-original validation. Basic/literal multiline string assignments
preserve accepted nonsecret source bytes; whole recognized secret-key
assignments are removed with honest `removedSecretFields`. Decoded nonsecret
strings undergo recognizable-secret checks. Missing/invalid delimiters, duplicate
keys/tables, scalar/table collisions and unsupported declaration/value forms
refuse; valid TOML outside this subset remains a recreation limit. See the
[exact structured contract](git-provider-user-data-transport.md#bounded-toml-syntax).
Retained-original matching remains byte-exact and never re-sanitizes or substitutes
live settings. No native/provider/runtime qualification was performed.


Supported TOML arrays and inline tables now compose recursively with supported
scalars in that same reader. Exact nonsecret source spans survive; recognized
secret assignments remove their complete structurally valid value. Nested secret
inline members/subtrees are removed with necessary adjacent separators while
retaining nonsecret sibling source spans; emptied inline tables remain valid.
Arrays support comments/newlines/trailing commas;
inline tables refuse layout comments/newlines and trailing commas. Duplicate
members and later extension of closed inline tables refuse. Value depth is capped
at 32 below the root and total value nodes at 10,000, alongside existing byte,
statement and static-table bounds. Additional scalar/header families are described below. Decoded
string-leaf and raw-text secret checks both remain. Source-only implementation;
no tests, builds, types, native capture or runtime qualification performed.


Quoted basic/literal keys, supported escaped basic keys and dotted paths now use
one structural path reader for assignments, static headers and inline members.
Decoded canonical segments own identity and secret checks; quoted dots, brackets,
hashes and equals signs are contents. Multiline keys, invalid escapes, duplicate
decoded spellings and illegal namespace extensions refuse. Implicit/explicit/dotted
and closed-value namespaces remain distinct, with 64-segment path bounds and
10,000 namespace-node bound in addition to existing value/byte/depth limits.
Recognized secret segments remove complete valid assignments, inline members and
static/array-table credential namespaces without removing unrelated siblings.
Discarded headers/assignments remain registered for original syntax, duplicate and
type checks, including latest-parent array-table elements and later subheaders.
All original values still pass the bounded grammar; only retained leaves receive
secret inspection. Header paths classify credential ancestors from decoded keys;
removed namespaces cannot become nonsecret redefinitions. Live export and import
use the same scrubber, with truthful removal flags; import rejects unsanitized
nested credentials and retained-original re-export cannot restore removed fields.
No settings activation, dependency, schema/version or root-inventory change.
Source-only: no parser execution, tests or round-trip qualification.
Accepted nonsecret source spans and existing raw/decoded string inspection remain.
See the [exact structured contract](git-provider-user-data-transport.md#bounded-toml-syntax).
No general TOML completeness or runtime qualification is claimed.


The same inactive TOML reader now accepts array-table headers with independent
ordered element namespaces, latest-parent static/nested subtables and explicit
static-array/table/closed-value redefinition refusal. An undeclared implicit parent
cannot later be reinterpreted as an array. Every element charges the existing
namespace bound. Base-prefixed unsigned hex/octal/binary integers are grammar- and
signed-64-range checked; decimal bounds remain. Lowercase signed `inf`/`nan` tokens
stay source text. Gregorian date/time/offset validation supports local and offset
forms, lowercase/space delimiters and up to nine fractional digits without Date
conversion, timezone normalization or truncation. Leap seconds, greater fractional
precision and overflowing decimal floats explicitly refuse. All original bytes,
secret-path removal/refusal, raw/decoded checks and source retention remain; no
parser certification or runtime qualification is claimed. See the exact contract.
