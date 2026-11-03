# U3 recreation inventory and U5 recovery disposition

Current Git follow-on: [fresh mapped recreation and external configuration](portable-git-recreation.md) connects native recovery, sparse/worktree settings, exact hook metadata and transported recursive includes. Earlier candidate rows below remain historical source dispositions, not the current Git implementation inventory.

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
| Git commits/objects, branches/tags/refs, reflogs, index/staged state, config/hook/Gitweb/legacy remote/dormant resolution/draft/recovery content | Unchecked Agent/organization and full Branch export controls pass explicit `reviewedUserData` choices for selected whole folders. This selection transports supported local Git objects/history, refs/HEAD, normal local reflogs with exact nonsecret user/time/message metadata, saved resolve-undo conflict stages and staged index originals with intent-to-add, assume-unchanged and skip-worktree (including supported local v2/v3/v4 full/split-index and ordinary sparse-directory logical state normalized into a full review index, without adopting source stat/shared storage) through the shared package flow into a separate review repository. Selected linked-worktree loose private refs and matching reflogs use that same inactive transport. Selected reciprocal backlinks may be absolute or relative to the private gitdir; checked raw parent components must resolve to the exact already observed selected `.git` file, without opening another target. Raw link spelling/identity remain before-after evidence. Ordered inactive `extensions.relativeWorktrees` common declarations require explicit format 1; declarations in either source require bounded valid booleans and no duplicates per source across capture/import/recreation/re-export. Worktree-local records do not determine repository format. Absent/false does not forbid relative links and true does not require them for this selection. No link/config rewrite or active adoption. Nonsecret configuration is inactive review data, including ordered literal local include/includeIf declarations without target/condition resolution or external contents; bounded default common Git hook/support UTF-8 originals are inactive `providerFiles` records under virtual `.git/hooks/...` paths, and four exact common Gitweb files (`description`, `category`, `cloneurl`, `README.html`) use inactive `.git/{exactname}` originals, and optional common `branches/`/`remotes/` originals use inactive `.git/branches/...`/`.git/remotes/...` records, and common `rr-cache/` resolution text plus exact selected-gitdir `COMMIT_EDITMSG` draft originals use inactive `.git/rr-cache/...`/`.git/COMMIT_EDITMSG` records with common/selected provenance respectively, and exact selected `SQUASH_MSG`/`TAG_EDITMSG`/`MERGE_MSG`/`EDIT_DESCRIPTION` use inactive `.git/SQUASH_MSG`/`.git/TAG_EDITMSG`/`.git/MERGE_MSG`/`.git/EDIT_DESCRIPTION` with selected provenance, and optional common `lost-found/` UTF-8 recovery originals use inactive `.git/lost-found/...` records, while configured hook targets remain uncollected and destination Git ownership stays local. See [exact contract and refusals](git-provider-user-data-transport.md). Unsupported linked layouts, packed private refs/unknown selected ref storage, unsupported reflog framing, reserved index flags/unknown mandatory extensions, combined split/sparse storage and other unsupported sparse forms, live activation and other listed families remain unsupported; fresh Git initialization alone is not equivalent recreation. |
| Selected-worktree previous HEAD (`ORIG_HEAD`) | Required inactive `origHeadReview` preserves exact selected-gitdir pointer and optional `logs/ORIG_HEAD` bytes or explicit absences with `selected_worktree` provenance. Canonical LF-terminated direct full-width nonzero OID or symbolic `ref: refs/...` binding requires exact captured ref chains and verified local object closure; absent current pointer may retain a valid historical log. Shared ordinary reflog grammar, object/absence/secret proof and aggregate bounds apply to that log. Pointer bounded to 4 KiB; canonical same-owner single-link no-follow raw identity/hash/absence and whole-capture bounds remain. No common main-worktree or other-worktree ORIG_HEAD/log inspection. Native read view skips both; recreation retains only inactive review/manifest records, never active ORIG_HEAD or its log. Shared live/import/recreation/retained-original checks refuse malformed encoding, unknown fields/provenance, missing/pruned current pointer objects and cyclic/uncaptured symbolic targets; historical log-only absences are explicit evidence. Existing operation holds and source/partial preservation remain; no reset/replay/repair, cap/version/schema/dependency change or native ownership adoption. Source-only; no parser/native/runtime/capture/recreation/round-trip/atomicity qualification. |
| Selected-worktree fetched heads (`FETCH_HEAD`) | Required inactive `fetchHeadReview` retains exact selected-gitdir bytes or explicit null absence with `selected_worktree` provenance, distinguishing empty-present. Canonical UTF-8/base64 LF records require full-width lowercase nonzero IDs, TAB, empty or `not-for-merge` marker, TAB and opaque NUL-free note. Entry order/repeats and note bytes remain exact; further tabs/carriage returns are note text, never URL/path/ref authority. Known-secret refusal applies. Every OID requires captured hash/type/graph-verified local objects even if unreachable; empty markers must peel through noncyclic captured tags to commits, while not-for-merge permits noncommit objects. Missing/pruned proof refuses, with no current-ref match requirement. Canonical same-owner single-link no-follow reads and raw identity/hash/absence before-after checks retain existing 1 MiB file, 10,000-record and whole-capture caps. No main/common or other-worktree FETCH_HEAD inspection. Syntax checked before native reading; read view skips FETCH_HEAD. Shared live/import/recreation/retained-original validation rejects missing/unknown fields/provenance. Only inactive CONFIGURATION-REVIEW.json and original manifest retain it, never active .git/FETCH_HEAD. No fetch/pull/merge/reset/replay/repair/ownership adoption, cap/schema/version/dependency change; existing ORIG_HEAD behavior and operation holds remain. Original/partial bytes preserved. Source-only; no native/runtime/capture/recreation/round-trip/atomicity qualification. |
| Derived local Git commit-graph caches | Common `objects/info/commit-graph` and exact split `commit-graphs/{commit-graph-chain,graph-{format-width lowercase hash}.graph}` names are bounded same-owner canonical single-link regular no-follow observations. Exact raw directory/file identity/hash/absence checks detect observed drift; known-secret inspection remains. Cache bodies/chain are never interpreted or used as graph proof. Native read views skip caches before copying objects; export exclusions document omission and recreation installs no caches. Verified objects and existing graph/ref/log/index/REUC/sparse/shallow semantics remain authority; caches are rebuildable but no rebuild runs. Unknown names/topologies, unsupported multi-pack-index/retention-layout/reftable/promisor/alternates remain refused. No DTO/version change, live source write or native working-root adoption. Source/partial bytes remain; no runtime/capture/round-trip/native/atomicity qualification. |
| Derived local Git multi-pack-index caches | The shared derived-cache path observes exact common `objects/pack/multi-pack-index`, hash-named `.bitmap`/`.rev` companions and `multi-pack-index.d/{multi-pack-index-chain,multi-pack-index-{hash}.{midx,bitmap,rev}}` names from pinned Git v2.54.0. Declared lowercase hash width, canonical same-owner single-link regular no-follow reads, bounds, known-secret inspection and raw before/after identity/hash/absence checks apply. Opaque bodies/chain are never followed or used as proof; native views skip caches before pack pairing/copying. Ordinary pack/idx pairing and verified objects/ref/log/index/REUC/sparse/shallow remain authority. Explicit omission is rebuildable; no rebuild, cache DTO/recreation, native working metadata or external-store traversal. Unknown names/topology/locks, alternates/promisor/unsupported-retention-layout/reftable still refuse. Source/partial bytes remain; cleanup unchanged. Source-only, no runtime/capture/round-trip/native/atomicity qualification. |
| Derived Git dumb-transport server-info advertisements | Existing shared cache observation/omission accepts exactly common `info/refs` and `objects/info/packs`, including explicit absence. Canonical same-owner parents, single-link regular no-follow files, raw before-after identity/hash/absence and known-secret inspection retain existing 4 MiB file/inspection and 32 MiB/20,000-node aggregate limits. Common info contents are not enumerated; only the exact refs advertisement joins attributes/exclude. No private/other-worktree scope or source discovery widening. Bodies stay opaque even if stale: no pack/ref/OID/path/URL interpretation, lookup or external authority. Native view skips both before copying/pack pairing; independently verified complete objects/refs and existing retention/log/index/REUC/sparse/shallow/ORIG_HEAD/FETCH_HEAD proof remain. Exclusions name rebuildable omission; no DTO/manifest body transport, recreation, cache rebuild or generated-copy re-export authority. Exact retained manifest/exclusions remain re-export authority. No update-server-info/repack/network/source write, ownership adoption, cap/schema/version/dependency change. Existing private exclusions before stat, unknown storage/topology/lock, graft and alternate/promisor refusals remain. Source/partial bytes preserved. Source-only; no native/runtime/capture/recreation/round-trip/atomicity qualification. |
| Git pack retention (`.keep`, MTME v1 `.mtimes`) | Required inactive `packRetentionReview` preserves exact source pack/v1-or-v2-index/companion bytes, checksum identity and independently checked index-order OIDs/epoch-second mtimes. Empty keep differs from null absence. Shared capture/validation decoding supports v1 interleaved offsets/OIDs and v2 separate tables at declared SHA-1/SHA-256 width. V1 CRC absence is explicit; v2 CRCs remain mandatory. Recognized unknown versions never fall back to v1; malformed/mixed layouts refuse. Complete pack/index/MTME header, fanout, counts, offsets, v2 CRCs, checksums, boundaries and canonical captured object identities agree on export/import/recreation/re-export, including unreachable objects. Non-delta, backward OFS and earlier/later same-pack REF bases supported, including mixed chains. Iterative dependency ordering checks each complete indexed base once before dependents; self/cyclic/missing/external bases refuse even if canonical bytes exist elsewhere. V2 mixed direct/64-bit-table offsets are supported within existing bounds, including small indirect values: exact framing, one reference per slot without imposed reference order, no unused slots, and exact integer bounds before number conversion. Malformed/truncated/extra tables, repeated/out-of-range references, unsafe integers, actual offsets outside the bounded pack and unsupported MTME forms refuse. Table bytes count once; caps and OID/MTME ordering do not change. Bounded same-owner no-follow single-link raw identity/hash/absence before-after observations and known-secret checks remain. Limits: 1,000 packs, 10,000 entries/pack, 1 MiB index/companion, 32 MiB combined objects/evidence and separate 32 MiB inflation/base-read/reconstruction budget, 10,000 delta instructions/object. Native view omits retention companions. Original bytes/intent remain only in manifest and CONFIGURATION-REVIEW.json; loose-object review recreation does not activate keep/mtime/GC/layout policy. No source writes, metadata installation, maintenance or network; retention intent is distinct from native GC equivalence. Originals/partial copies remain; cleanup unchanged. Source-only; no parser/native/runtime/capture/round-trip/atomicity qualification. |
| Ordinary shallow Git history | Include Git preserves required `shallowReview` exact common-repository bytes/provenance or explicit absence, distinguishing empty-present. Same-owner regular single-link no-follow capture and canonical association/raw before-after identity/hash/absence checks apply. Shared validation requires bounded canonical base64, LF-terminated ASCII, unique nonzero format-width IDs and captured verified commits; only declared commits may omit parents, with syntax and captured parent types still checked. Other graph/object/index/REUC/sparse checks remain. Recreation writes exact `.git/shallow` only inside the newly owned separate review repository, never native working metadata; original manifest remains re-export authority. No graph rewrite, fetch/deepening, external stores, grafts or promisor/partial-clone support. Source and partial bytes remain. Source-only; no runtime/round-trip/native/atomicity qualification. |
| Repository-local Git `info/attributes` and `info/exclude` | Explicit Include Git transports exactly these two common-repository originals as required, path-ordered `infoReview` byte/absence records with `common_repository` provenance. Empty bytes remain distinct from absence. Same-owner canonical parent, regular single-link no-follow files and raw before/after identity/hash/absence checks preserve scope and refuse observed drift. Shared export/import/recreation/retained-original validation enforces the two-path allowlist, bounds, exact base64/UTF-8 and known-secret refusal. Original BOM/line endings/content remain exact; patterns and commands are never interpreted. Destination evidence stays in inactive `CONFIGURATION-REVIEW.json`, outside active `.git/info`; native read views omit it. No external/global files, other private worktrees, filter/hook activation, ownership adoption or extra checkbox. Original/partial bytes remain. No native/runtime/round-trip/atomicity qualification. |
| Git index optional observation caches (`UNTR`, `FSMN`) | Exact signatures accepted as bounded opaque derived caches in full indexes, split overlays and required shared originals. Existing whole-index header/checksum, 1 MiB physical-file/10,000-entry bounds, extension sizes, duplicate checks and EOIE header hashing remain; lossless Latin-1 known-secret inspection uses the existing separate 4 MiB UTF-8 bound. Cache versions/grammar, paths, environment strings, tokens and bitmaps are never interpreted or used as file lists/proof; no monitor/hook/environment lookup. Exact raw identities/bytes and before-after comparison remain. Explicit export exclusions record rebuildable omission; no cache bytes enter DTO/native view/fresh inactive full index or retained-original manifest re-export authority. Logical entries/flags, REUC, sparse/offset semantics, strict unknown mandatory extension and split/sparse refusals remain. No source writes, cache activation, schema/version or cleanup change; originals/partial copies remain. Source-only; no tests/runtime/capture/recreation/round-trip/native-equivalence/atomicity qualification. |
| Git index derived offsets (`EOIE`, `IEOT`) | Bounded full v2/v3/v4 originals and each required split storage file validate EOIE final position, exact length/end offset/header hash and IEOT v1 complete offset/count partitions against sequentially decoded raw entry boundaries. Native v4 full-path block restarts, empty-index version-only tables and a leading empty block after removed entries are supported. Tables never control parsing or use merged offsets. Existing raw identity/byte checks, logical flags/REUC/sparse/private refs, import validation and exact retained-original re-export remain unchanged. Accelerators are omitted in the new inactive full review index; no source writes, stat/layout adoption, active cache/configuration or DTO/version change. Malformed tables, unknown extensions and existing split/sparse combinations still refuse; original/partial bytes remain. Source-only; no tests/native/runtime/atomicity qualification. |
| Git index resolve-undo (`REUC`) | Required `git.resolveUndo` records preserve exact paths and present stage 1–3 canonical modes/OIDs, with missing stages absent. Ordinary full v2/v3/v4 and selected split-overlay extensions decode directly; a required shared-base REUC refuses rather than supplying inherited data. One semantic validator/encoder checks complete grammar, UTF-8/path and byte/stage ordering, duplicates, bounds, known-secret paths and captured blob identities; all captured objects retain hash/secret/graph checks. Raw index/shared-index originals and logical undo state must match before/after. Existing export/import/Shared/retained-original paths carry the same manifest. Inactive standalone recreation writes canonical REUC and index checksum exclusively, with no source writes, checkout or Git index invocation. No stat/layout/operation authority is adopted. Original/partial bytes remain. Required field omission, unsupported modes/storage and missing non-gitlink objects refuse. Gitlink IDs remain exact; submodule contents remain a gap. No tests/native/runtime/round-trip qualification. |
| Explicitly selected linked-worktree Git association | Include Git authorizes only the bounded reciprocal selected `.git` pointer/private `gitdir` backlink/`commondir` association at canonical same-owner `<common>/worktrees/<id>`. Association records/directory identities are checked before repository content and before/after capture. Selected HEAD/index/exact sharedindex/config.worktree/patterns/HEAD log and loose `refs/{bisect,rewritten,worktree}/**` with matching logs remain provenance-separated from shared config/public refs/objects/public ref logs. Common private namespaces/logs are skipped by name before stat/open/descent; main/other worktree private state is not read or substituted. No common/worktrees enumeration. Unknown selected ref storage, packed private refs, duplicate/shadowing paths and out-of-scope symbolic aliases refuse. Names, object/graph/secret and exact reflog validation apply through export/import/retained-original re-export. Native plumbing sees only an exclusive captured temporary Git view with generated format-only config; isolated stdin config parsing with include resolution disabled, alternate refusal, environment/pager/discovery controls prevent unapproved startup reads. Complete bounded raw/logical inventories and required index storage must match; no independent-writer atomicity guarantee. Existing DTO and inactive standalone recreation normalize storage and adopt no ownership/topology or active bisect/rebase operation. Unsupported associations, unknown/promisor object metadata, incomplete packs and existing sparse/index limitations refuse. Source and partial copies remain; successful temporary views remove only known unchanged files and empty directories. Ordinary crossRootLinks stays refuse; authority is separate from working-file traversal. Source-only implementation, runtime unverified. |
| Git sparse-checkout patterns, cone/noncone configuration and collapsed sparse directory originals | Explicit Git selection preserves exact bounded local pattern bytes/absence plus ordered nonsecret local/worktree-config values and source scope as inactive review data. Supported sparse-directory trees expand only from captured hash/graph-verified objects into a full logical v2/v3 review index; original collapsed path/mode/stage/OID/flags remain in required `sparseReview`. Import checks expansion equality, topology and bounds. No pattern interpretation, external includes, source index commands/writes, destination sparse activation or filesystem-derived content. Captured config parsing uses stdin in a fresh private empty cwd with a parent discovery ceiling, system/global files disabled and explicit --no-pager, preventing selected/ancestor startup or pager-config discovery. Empty-only cleanup retains unexpected bytes. Nonsecret include declarations remain ordered inactive literals with target resolution disabled; external contents supply no sparse/format authority. Unsupported directory flags/booleans/extensions, ambiguous worktree settings, missing/unstable originals and combined split/sparse storage refuse. Explicit Include Git separately authorizes the reciprocally validated selected private gitdir and exact common repository, including external associated storage; no other worktree private state or arbitrary cross-root working files. Selected private sparse/index/config scope is retained and shared objects are used only after captured hash/graph verification. Unsupported associations/packed private refs/unknown selected storage and submodule repository content remain gaps; runtime unverified. |
| Project-root `.mcp.json`, provider `.codex` / `.claude` profiles, browser sessions, `.ssh` / `.aws` / `.gnupg`, `.env*`, known credentials/private-key paths | Listed exclusions; credentials and live owner/session state must be re-entered/recreated. Ordinary selected-file export/import refuses `.mcp.json` path components and `.claude` paths; whole-folder inventory lists their omissions in `excludedPaths`. Explicit harness selection separately transports project-root `.mcp.json`, recursive regular custom `.claude/rules` files, optional selected-root `.claude/AGENTS.md` and the supported project-root settings/instructions/commands/agents/skills/rules listed in [the review-copy contract](git-provider-user-data-transport.md), with structural removal only for explicit JSON settings or supported TOML and known-secret refusal for opaque originals. All selected non-settings UTF-8 originals retain exact accepted bytes/BOM regardless of extension; support JSON is never rewritten as settings. Nonsecret MCP server settings remain after recursive JSON credential-field removal; remaining recognizable secrets refuse. Rule contents and accepted literal environment references are not interpreted, expanded or followed. They remain numbered nonexecutable `.review` files with original path mappings, never installed settings or tool grants. Host home profiles, sessions and unsupported configuration families are not read or adopted. No universal claim that those directories contain only secrets. |
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

### Project Codex agent review files

Explicit harness selection now includes regular top-level project
`.codex/agents/*.toml` originals through the existing inactive provider-file flow.
The shared config/agent TOML classification scrubs live originals and rejects
unsanitized imported originals, preserving accepted nonsecret spans and removal
metadata. Existing canonical no-follow reads, inventory drift checks and
1,000-entry / 1 MiB TOML / 32 MiB aggregate bounds apply. Nested directories,
unknown formats, links/special nodes, credential names and unsupported syntax
refuse; originals remain untouched. No arbitrary config reference, home/profile,
session or auth path is followed. Standalone agents and referenced config layers
are different native formats; neither is interpreted or activated. Existing
numbered nonexecutable review copies retain original path mappings; only the
validated original manifest controls re-export. See the
[scope, primary references and limits](git-provider-user-data-transport.md#inactive-project-codex-agent-originals).
No schema/DTO/dependency change or native configuration, runtime, round-trip or
atomicity acceptance is claimed.

### Project Claude output-style review files

Explicit harness selection includes top-level regular
`.claude/output-styles/*.md` from the selected root as inactive originals. Shared
capture/import path classification, canonical same-owner single-link no-follow
reads, inventory/read drift checks and existing 1,000-entry / 1 MiB original /
32 MiB aggregate bounds apply. Disappearing originals, nested directories,
unknown formats, links/special nodes, credential names and invalid UTF-8 refuse.
Accepted bytes, including BOM, remain exact; known-secret inspection still
refuses recognizable credentials without claiming universal prose-secret
detection. Frontmatter/instructions remain opaque, with no YAML parsing, path or
reference expansion, home/managed/ancestor discovery or activation. Existing
numbered mode0600 review copies retain exact original path/removal metadata; only
the validated original manifest supplies re-export. See the
[contract and primary reference](git-provider-user-data-transport.md#inactive-project-claude-output-styles).
No DTO/schema/dependency/cap change or native configuration, runtime, round-trip
or atomicity acceptance is claimed.

### Project Claude persistent-memory review files

Explicit harness selection includes regular UTF-8 originals beneath named Agent
directories in selected-root `.claude/agent-memory` and
`.claude/agent-memory-local`, including `MEMORY.md` and supporting text in bounded
recursive subdirectories. Shared live/import classification refuses root-level
files, dot/empty/escaping/null/backslash paths, credential names and file/ancestor
collisions. Traversed directories/files require selected-root ownership; existing
canonical single-link no-follow reads, inventory/read drift checks and
1,000-entry / 1 MiB original / 32 MiB aggregate bounds remain. Links/special nodes,
disappearing originals and invalid UTF-8 refuse. Accepted bytes including BOM
stay exact; extension does not trigger settings interpretation or rewriting.
Known-secret inspection still refuses recognizable credentials; arbitrary prose
may contain sensitive data. Empty directories are not represented by file entries.

No native Agent binding, definition/reference expansion, home/ancestor/session
discovery, activation, provider execution or Ponderosa memory database/permission
change occurs. Existing numbered mode0600 review files retain exact path/removal
metadata; only validated original manifest bytes supply re-export. See the
[contract and primary reference](git-provider-user-data-transport.md#inactive-project-claude-subagent-memory).
No DTO/schema/dependency/cap change, native memory/runtime, round-trip, independent
writer atomicity or whole-portability acceptance is claimed.

### Project Claude hook-support review files

Explicit harness selection includes selected-root `.claude/hooks/` regular UTF-8
originals: top-level scripts plus bounded recursive supporting text. Shared
live/import classification requires a contained nonempty non-dot path and
refuses malformed/escaping/null/backslash/credential paths and file/ancestor
collisions. Traversed directories/files require selected-root ownership;
canonical single-link no-follow reads, inventory/read drift checks and existing
1,000-entry / 1 MiB original / 32 MiB aggregate limits remain. Links/special nodes,
foreign owners, disappearing discovered originals, invalid encoding and exceeded
bounds fail. Accepted bytes including BOM stay exact regardless of extension;
JSON support text is not settings and is never rewritten. Existing known-secret
inspection refuses recognizable credentials; arbitrary sensitive prose may remain.

No settings-command chasing, script/reference/environment interpretation, native
binding, home/ancestor/managed/nested-project/session/history discovery,
installation, activation, executable chmod, provider/hook execution or source
writes occur. Existing numbered mode0600 nonexecutable review files retain exact
path/removal metadata; only validated original manifest bytes supply re-export.
Empty directories and original executable mode/mtime have no representation in
the existing DTO and are not recreated. See the
[contract and primary reference](git-provider-user-data-transport.md#inactive-project-claude-hook-support-originals).
No caller/DTO/schema/version/dependency/cap change or native equivalence,
round-trip, independent-writer atomicity or whole-portability acceptance is claimed.

### Project Claude skill-support text originals

Explicit harness selection carries selected-root `.claude/skills/<skill>/...`
regular UTF-8 originals and bounded supporting subdirectories through shared
opaque live/import classification. A named non-dot skill directory and contained
file are required; root-level files refuse. No mandatory `SKILL.md` or frontmatter
parser is introduced. Exact accepted bytes including BOM survive regardless of
extension; JSON support text is no longer rewritten as settings. Known-secret
inspection refuses recognizable/embedded credentials instead, while actual
settings JSON keeps structural secret removal. Sensitive prose may still remain.

Traversed directories/files require selected-root ownership, canonical parents,
single-link no-follow bounded reads and existing inventory/read drift checks.
Malformed/dot/escaping/null/backslash/credential paths, links/special nodes,
foreign owners, invalid UTF-8, imported file/ancestor collisions and exceeded
1,000-entry / 1 MiB original / 32 MiB aggregate limits refuse. Only absent family
roots are optional; discovered disappearance fails. Binary resources remain an
unsupported gap. Empty directories and original executable mode/mtime remain
outside the existing DTO.

No reference chasing, SKILL/frontmatter/JSON/script interpretation, native
binding, installation, activation, executable chmod, reload, grants, spawning,
skill/provider execution, source writes or discovery outside the selected root
occurs. Existing numbered mode0600 nonexecutable review copies retain exact
path/removal metadata; only validated original manifest bytes supply re-export.
See the [contract and primary reference](git-provider-user-data-transport.md#inactive-project-claude-skill-support-originals).
No caller/DTO/schema/version/dependency/cap changes or native equivalence,
round-trip, independent-writer atomicity or whole-portability acceptance is claimed.

### Exact remaining selected provider-text originals

Existing harness-selected `.claude/CLAUDE.md`, `.codex/instructions.md` and
recursive `.claude/{commands,agents,rules}` / `.codex/{skills,rules}` now preserve
exact accepted regular UTF-8 bytes/BOM regardless of extension. Support JSON is
opaque text; only exact MCP/Claude JSON settings retain structural secret removal,
and supported Codex config/agent TOML retains span removal. Recognizable known
secrets in opaque originals refuse rather than rewriting them. Existing contained
layouts, including top-level files and noncredential dot-prefixed components,
remain accepted; no new native directories, named-skill/Agent or manifest rules.

Shared live/import classification supplies path and file/ancestor checks, the
same selected-root owner protection for directories/files as memory/hooks/skills,
canonical parents, single-link no-follow bounded reads, inventory/read drift and
existing 1,000-entry / 1 MiB original / 32 MiB aggregate limits. Only initial fixed
file/family-root absence is optional; discovered disappearance fails. Malformed,
escaping, credential, link/special, foreign-owner, invalid UTF-8 or oversized
originals refuse and source bytes remain. Binary resources, empty directories
and executable-mode/mtime preservation remain unsupported; arbitrary sensitive
prose may remain despite recognizable-secret inspection.

Numbered mode0600 nonexecutable review copies and exact path/removal metadata
remain unchanged; re-export uses only validated original manifest bytes. No
caller/DTO/schema/version/dependency/cap change, reference interpretation,
outside-root discovery, activation or execution occurs. See the
[shared contract](git-provider-user-data-transport.md#exact-already-selected-non-settings-provider-text).
Source review only; no tests, native equivalence, round-trip, independent-writer
atomicity or whole-portability acceptance.

### Project Claude fallback instruction review original

Explicit `harness: true` selection includes optional selected-root
`.claude/AGENTS.md` as untrusted inactive review data. Existing fixed selection
and shared opaque classification preserve exact accepted regular UTF-8 bytes/BOM
with no settings rewrite and `removedSecretFields: false`. Initial absence is
optional; an observed file disappearing fails. Existing selected-root ownership,
canonical-parent, single-link no-follow bounded reads, read-drift, known-secret
refusal and imported file/ancestor topology checks apply, with unchanged
1,000-entry / 1 MiB original / 32 MiB aggregate limits and source preservation.

The [contract and official primary reference](git-provider-user-data-transport.md#inactive-project-claude-fallback-instruction-original)
identify the fallback data family without implementing native fallback conditions,
priority, context behavior or version/runtime parity. Root `AGENTS.md` stays in
the ordinary working-file lane; no duplicate capture or outside-root discovery
occurs. Contents never become Ponderosa instruction authority; instructions,
`@imports`, references and frontmatter are not followed or expanded. No native
binding, installation, activation, reload, grant, spawning, provider execution or
source write occurs.

Import still validates before numbered mode0600 nonexecutable `.review` copies
with exact path/removal metadata; re-export uses validated original manifest
bytes only. No caller/format/DTO/schema/dependency/cap changes are needed; other
provider families remain unchanged. Binary resources, empty directories, original
executable mode/mtime, arbitrary sensitive prose and concealed secrets remain
outside the guarantee. Existing sensitive-data warning and independent-writer
limits remain; source review only, with no tests, round-trip, native equivalence,
atomicity or whole-portability acceptance.

### Default common Git hook/support review originals

Explicit `git: true` includes optional validated common-repository `hooks/`
regular UTF-8 originals and bounded support subdirectories for normal repositories
and already authorized selected linked worktrees. Existing `providerFiles` slots
carry exact accepted bytes/BOM and `removedSecretFields: false` at virtual
`.git/hooks/...` paths. These paths always mean common-repository origin, not the
selected private gitdir or absolute physical storage. Root absence is optional;
discovered disappearance fails. No main/other/private worktree hooks are read.

The existing raw snapshot walker supplies canonical same-owner directories,
single-link no-follow bounded reads, identity/hash/absence evidence and whole-
capture association/drift checks. Shared live/import classification rejects
malformed/escaping/credential paths, links/special nodes, foreign owners, invalid
UTF-8/NUL binary data, known secrets and file/ancestor collisions. Exact `.sample`,
support text and valid noncredential dot-prefixed names remain accepted regardless
of extension, without JSON/script rewriting. Hook descendants are limited to
1,000 entries; hook and harness originals share 1,000 files / 32 MiB aggregate /
1 MiB each, and existing Git raw 20,000-node / 32 MiB bounds also apply.

Git hook records require Git selection and a valid required Git manifest;
provider records still require harness selection. Git-only and mixed selections
use the same transport. No DTO/format/schema/version/dependency/cap/checkbox change
is needed. Hooks are skipped before native read-view copying/parsing/pack pairing
and never installed in recreated Git. Hooks/fsmonitor remain disabled. Import
validates before numbered mode0600 nonexecutable `.review` copies with exact
path/removal mappings; re-export uses validated original manifest bytes only.

See the [contract and official primary references](git-provider-user-data-transport.md#inactive-default-common-git-hook-originals).
Configured `core.hooksPath` targets are not followed or expanded; nonsecret config
remains inactive and configured/external hook bytes remain a gap. Ordinary `.git`
working-file refusal is unchanged. No source writes, outside-scope discovery,
reference/shebang/JSON interpretation, installation, activation, executable chmod,
network or hook/provider execution occurs. Empty directories, binary resources,
original mode/mtime, sensitive prose/concealed secrets and independent-writer
limits remain honest; source-only, no tests/capture execution/native equivalence,
round-trip/atomicity/whole-Bible acceptance.

### Fixed common Gitweb metadata review originals

Explicit `git: true` includes only optional validated common-repository
`description`, `category`, `cloneurl` and `README.html`, for normal repositories
and already authorized reciprocal selected linked associations. Existing
`providerFiles` carry exact accepted UTF-8/BOM bytes at virtual `.git/{exactname}`
paths with explicit common provenance and `removedSecretFields: false`. Empty
present files survive as zero-byte originals, distinctly from absent slots.
No selected-private/main/other-worktree alternate copies or broad root enumeration
are read. Bodies remain opaque regardless of HTML/JSON/URL appearance; known
secrets refuse, with no settings rewrite, HTML rendering, URL fetch or reference
interpretation. Nonsecret `gitweb.*` configuration remains inactive and unchanged.

The same canonical same-owner regular single-link no-follow bounded reader and
whole-capture identity/hash/absence/association checks detect observed appearance,
disappearance and drift. Unsafe topology, invalid UTF-8/NUL binary data, foreign
ownership and malformed/credential paths refuse. Shared Git-original parsing
requires Git selection plus a valid required Git manifest; other provider families
require harness. Git-only/mixed imports validate before numbered mode0600
nonexecutable `.review` copies with exact original mappings. Re-export uses only
the authoritative original manifest. All four slots skip native copying/parsing/
pack pairing and never enter recreated Git or native Gitweb.

Existing 1 MiB/original, combined hook/metadata/harness 1,000-file/32 MiB and raw
Git 20,000-node/32 MiB bounds remain. No DTO/schema/version/format/dependency/cap/
checkbox change. Ordinary working `.git` refusal and hook/fsmonitor disabling
remain. No template resolution, special ownership adoption, outside-scope
discovery, native web server/network/install/activation/execution/source writes.
Mode/mtime, empty directories, binary resources, sensitive prose/concealed secrets
and independent-writer limits remain. See the [exact contract and official primary
references](git-provider-user-data-transport.md#inactive-fixed-common-gitweb-metadata-originals).
Those references identify file data, not native lookup/rendering/precedence parity;
source-only review does not establish capture execution, round trips, native
equivalence, atomicity or whole-Bible acceptance.


### Common legacy Git remote shorthand review originals

Explicit `git: true` includes optional validated common-repository `branches/`
and `remotes/` regular UTF-8 originals with contained supporting directories.
Normal repositories and already authorized reciprocal selected linked
associations use existing `providerFiles` at virtual `.git/branches/...` and
`.git/remotes/...` paths: explicit common provenance, exact accepted bytes/BOM,
`removedSecretFields: false`. No private/main/other-worktree alternate copies or
broad repository-root enumeration. At least one valid contained component is
required; root-file masquerades and malformed/empty/dot/dot-dot/null/backslash/
escaping/credential paths refuse. Valid contained noncredential names/layouts,
including dot-prefixed names, need no extension or native remote grammar.

Bodies are opaque regardless of URL/JSON/config appearance. Known secrets and
recognizable URL userinfo refuse, without rewriting originals. Canonical
same-owner parent/directory and regular single-link no-follow bounded reads join
whole-capture identity/hash/absence/association checks. Initial root absence is
optional; discovered disappearance fails. Appearance/drift, invalid UTF-8/NUL
binary data, links/special/foreign-owner nodes and imported ancestor collisions
refuse while preserving source/partial bytes. Empty present files survive.

Shared Git-original parsing requires explicit Git selection plus a valid Git
manifest, supporting Git-only/mixed selection; other provider families require
harness. Shared import validates before numbered mode0600 nonexecutable `.review`
copies and exact path/removal maps; retained re-export uses original manifest
bytes only. New files skip before native copying/parsing/pack pairing and never
install in recreated Git or active config. Existing hooks/fsmonitor disabling,
ordinary `.git` refusal, 1 MiB/original, 1,000 combined Git/harness files/32 MiB,
20,000-node/32 MiB raw and 1,000-entry hook inventory bounds remain unchanged.
No DTO/format/schema/version/dependency/cap/checkbox change.

See the [contract and primary repository-layout reference](git-provider-user-data-transport.md#inactive-common-legacy-git-remote-originals).
These are legacy shorthand files; Git documents stopping native reads in 3.0.
No native-version discovery/compatibility claim, remote/URL/refspec parsing,
config modernization, path/reference chasing, fetch/network, install/bind/activate/
execute/source writes or outside-scope discovery occurs. Empty-directory/binary/
original-mode/mtime, sensitive-prose/concealed-secret and independent-writer limits
remain. Source-only: no capture-execution, native-equivalence, round-trip,
atomicity or whole-Bible acceptance claim.


### Common rerere resolution and selected commit draft review originals

Explicit `git: true` adds only optional validated COMMON `rr-cache/` regular UTF-8
originals/contained support directories and exact SELECTED-gitdir `COMMIT_EDITMSG`.
Existing `providerFiles` virtual `.git/rr-cache/...` and `.git/COMMIT_EDITMSG` paths
encode those fixed provenances with `removedSecretFields: false`, including normal
repositories where gitDir and commonDir coincide. Already reciprocal selected linked
associations use the same route. No private/main/other-worktree alternate data or
broad root enumeration. The export filter adds only that exact selected draft;
the linked private allowlist adds only COMMIT_EDITMSG, retaining all actual operation
holds. MERGE_RR is neither transported nor interpreted.

Shared classification requires valid nonempty nondot rr-cache descendants and
refuses family-root files; names/layouts, preimage/postimage/thisimage numbered
variants and bodies stay opaque without conflict-ID/pair/extension grammar.
Draft comments/templates also remain opaque. Exact accepted UTF-8/BOM/empty-present
bytes survive; initial absence produces no original and no fabricated pair/variant.
Known-secret/NUL/invalid-UTF-8, malformed/escaping/credential paths, links/special/
foreign-owner nodes and imported ancestor collisions refuse without rewriting.
Canonical same-owner parents, bounded single-link regular no-follow reads and
complete before/after raw identity/hash/explicit-absence/reciprocal-association
checks cover both families. Initial optional absence is allowed; discovered
entry disappearance and all observed appearance/disappearance/drift refuse,
preserving source and partial bytes.

Shared Git-only/mixed parsing requires explicit Git selection and its required
valid Git manifest; other provider records require harness. Working export validates
the full manifest; import parses before numbered mode0600 nonexecutable `.review`
copies with exact path/removal maps. Retained re-export uses the original manifest
only. New originals skip first before native-view copy/parse/pack pairing and never
install in recreated Git, native cache/draft/config. Hooks/fsmonitor disabling and
1 MiB/original, 1,000 combined review files/32 MiB, 20,000 raw nodes/32 MiB and
1,000 hook-entry bounds remain. No DTO/schema/storage-version/format/dependency/
checkbox/cap change or second codec.

See the [exact contract and primary rerere, pinned Git storage source and commit
FILES references](git-provider-user-data-transport.md#inactive-common-rerere-and-selected-commit-draft-originals).
Objects/refs/index and the ordinary working-file lane's `.git` refusal cannot
replace these source bytes. The references identify data, not native reuse/GC,
retention age/editor/commit/operation recovery or activation equivalence. No rerere,
merge/apply/commit/editor/script/provider execution, replay, fetch/network,
path/environment/import/reference/config expansion, source writes or outside-scope
discovery. Original mode/mtime, empty directories, binary data, sensitive prose/
concealed secrets and independent-writer atomicity remain limits. Source-only:
no capture-execution, native-equivalence, round-trip, atomicity or whole-Bible claim.


### Inactive local Git include declarations

Explicit Git selection now retains nonsecret include/includeIf declarations from
exact common `config` and selected `config.worktree` as ordered existing
`configurationReview` records. Repeated keys and literal parsed values/conditions,
including relative/absolute/tilde strings, retain source/order/implicit-boolean
metadata. This is parsed configuration transport, not exact source formatting.
The isolated private-empty-cwd stdin parser retains `--no-includes`, system/global/
inherited-config exclusion, discovery ceiling, no pager and disabled hooks/fsmonitor.
No path/environment expansion, gitdir/worktree/onbranch/hasconfig condition or URL
evaluation, target stat/read, recursion or include discovery is performed.

Known-secret/URL-userinfo/credential-key/source-ownership filtering remains, with
unsafe retained records rejected at import. Local format/extensions/sparse and
index/object/graph/ref/log/shallow/relative-worktree validation remain independent:
uncollected targets cannot supply missing evidence. Explicit local format and
required cone/worktree sparse declarations still need their existing proof.
External include contents/configured hook targets remain uncollected, so effective
native settings equivalence is not claimed. Ordinary `.git` transport cannot
substitute. Association/canonical-owner/single-link/no-follow/bounds and complete
before/after raw/config identity/absence/bytes/hash checks stay connected.

Shared full-manifest export/import validation and original-manifest-only retained
re-export carry these records unchanged; recreation writes them only to inactive
`CONFIGURATION-REVIEW.json`, never active generated format-only Git configuration.
No traversal/checkbox/DTO/schema/storage-version/format/cap/dependency/second codec.
See [exact contract and primary Git Includes/Conditional includes/no-includes
references](git-provider-user-data-transport.md#inactive-local-include-declarations).
Source-only; no parser/native/runtime execution, round-trip, atomicity or whole-Bible
acceptance claim.


### Common Git lost-found recovery review originals

Explicit `git: true` preserves optional exact associated COMMON `lost-found/`
regular UTF-8 originals and contained directories through existing inactive
`providerFiles` at `.git/lost-found/...`, with `removedSecretFields: false`.
Normal and already reciprocal linked associations share that provenance; no
selected-private/main/other-worktree substitution or new external traversal.
Selected-private lost-found remains held by the existing unsupported-storage guard.
Supported `commit/`, `other/` and custom contained text descendants stay opaque:
no OID naming, object-existence/hash-equality requirement or content interpretation.
Accepted exact bytes/BOM/empty-present files survive; optional absence yields no
record. The root must be a directory. Malformed/escaping/credential paths,
links/hardlinks/special/foreign-owner nodes, NUL/binary/invalid UTF-8, recognized
secrets and import ancestor collisions refuse without rewriting.

The same canonical-parent, bounded single-link no-follow reads and complete
before/after raw directory/file identity/hash/explicit-absence/association checks
cover the family. Discovered disappearance and observed appearance/drift refuse.
Existing 1 MiB/original, combined 1,000 review files/32 MiB, 20,000 raw nodes/32 MiB
and 1,000 hook-entry bounds remain. Shared Git-selection/required-manifest binding,
working export validation, import parse-before-write, numbered mode0600 nonexecutable
`.review` originals/maps and authoritative original-manifest re-export are reused.
The first native-view skip excludes the family before copy/parse/pack pairing;
no recreated active `.git/lost-found` installation or active config change.

See [exact contract and primary fsck/storage source references](git-provider-user-data-transport.md#inactive-common-git-lost-found-originals).
Existing edited/pruned recovery files/mappings cannot be replaced by object capture;
ordinary transport excludes `.git`. No fsck/GC/regeneration/revival/ref creation,
checkout/editor/hook activation, OID/link chasing, cleanup/source writes or outside
selection discovery. Existing graph/config/format/sparse/index/log/shallow/operation
checks and DTO/schema/storage-version/format/caps/dependencies stay unchanged.
Original mode/mtime/empty directories/binary data, sensitive prose/concealed secrets
and independent-writer atomicity remain limits. Source-only: no capture execution,
native equivalence, round-trip, atomicity or whole-Bible acceptance claim.


### Selected Git squash-message draft review original

Explicit `git: true` preserves optional exact SELECTED-gitdir `SQUASH_MSG` through
inactive `.git/SQUASH_MSG` in existing `providerFiles`, alongside COMMIT_EDITMSG.
The shared selected-original name list covers classification, capture, provenance,
narrow linked allowlist and export predicate. Coincident gitDir/commonDir still means
selected; reciprocal linked associations never substitute/read common/main/other
worktree drafts. Common lost-found/private-storage guards and all operation holds stay.

See [exact contract and pinned primary merge/commit/path references](git-provider-user-data-transport.md#inactive-selected-git-squash-message-draft).
Native squash prepares a message without MERGE_HEAD; exact edited drafts cannot be
replaced by objects/index or ordinary `.git`-excluded files. Opaque accepted UTF-8/BOM/
empty-present bytes survive; absence yields no original. No message/OID/template
interpretation/reconstruction, reference chasing, merge/squash/commit/editor/hook
continuation or active draft/config installation. Recognized secrets refuse without
rewriting; sensitive prose/concealed secrets remain limits, without general draft-body
URL-userinfo refusal. NUL/binary/invalid UTF-8, unsafe paths/topology, symlinks/hardlinks/
special nodes and foreign ownership refuse.

Canonical same-owner regular single-link no-follow bounded reads and complete before/
after identity/hash/absence/raw-inventory/association checks cover the slot; observed
appearance/disappearance/drift refuses. First native-view skip excludes it before
copy/parse/pack pairing. Shared Git-selection/required-valid-manifest/false-removal
binding, working export validation, import-before-write, numbered mode0600 nonexecutable
`.review` maps and original-manifest-only re-export are reused. Existing 1 MiB/original,
1,000 combined review files/32 MiB, 20,000 raw nodes/32 MiB and hook bounds remain.
No source writes, DTO/schema/storage-version/format/cap/dependency or codec changes;
graph/config/format/sparse/index/log/shallow checks unchanged. Mode/mtime/emptydirs/
binary and independent-writer atomicity remain limits. Source-only: no capture execution,
native equivalence, round-trip, atomicity or whole-Bible acceptance claim.


### Selected Git tag-message draft review original

Explicit `git: true` preserves optional exact SELECTED-gitdir `TAG_EDITMSG` through
inactive `.git/TAG_EDITMSG` in existing `providerFiles` with false removal. The shared
selected-original list reaches classifier, provenance, selected capture, narrow linked
allowlist and export predicate. Coincident gitDir/commonDir remains selected; linked
capture never stats/reads/substitutes common/main/other-worktree drafts. Common lost-found,
unknown private-storage guards and every active-operation hold remain unchanged.

See [exact contract and pinned Git v2.56.0 tag/path sources](git-provider-user-data-transport.md#inactive-selected-git-tag-message-draft).
Native tag can retain an edited draft after failure; no stored tag object need preserve
those exact bytes, and ordinary working files exclude `.git`. This is a pinned-source
provenance contract, not all-version native equivalence. Exact accepted opaque UTF-8/BOM/
empty-present bytes survive; optional absence creates no original. No message/OID/template
interpretation/reconstruction, tag/sign/editor/trailer or operation continuation,
reference chasing, active draft/config installation or source writes.

Existing canonical same-owner regular single-link no-follow bounded reads and complete
raw before/after identity/hash/absence/association checks refuse observed drift. Recognized
secrets refuse without rewriting; sensitive prose/concealed secrets remain limits, without
a general draft-body URL-userinfo guarantee. NUL/binary/invalid UTF-8, unsafe topology and
foreign ownership refuse. First native-view skip excludes the draft before copy/parse/pack
pairing; shared Git-selection/required-valid-manifest/false-removal checks, working export
validation, import-before-write, numbered mode0600 nonexecutable `.review` originals/maps
and authoritative-original-manifest-only re-export remain shared. Existing per-original,
combined review/raw inventory and hook bounds, graph/config/format/sparse/index/log/shallow
checks and harness selection remain. No DTO/schema/storage-version/format/cap/dependency
changes. Mode/mtime/empty directories/binary and independent-writer atomicity remain limits.
Source-only: no capture execution, native equivalence, round-trip or whole-Bible acceptance.


### Selected Git merge-message review original

Explicit `git: true` preserves optional exact SELECTED-gitdir `MERGE_MSG` through
inactive `.git/MERGE_MSG` in existing `providerFiles` with false removal, only when
all existing export checks pass. The shared selected-original list reaches classifier,
provenance, fixed optional capture, narrow linked allowlist and export predicate.
Coincident gitDir/commonDir remains selected; linked capture never stats/reads/substitutes
common/main/other-worktree MERGE_MSG. Common lost-found and unknown private guards stay.

See [exact contract and pinned Git v2.56.0 merge/commit/branch/path sources](git-provider-user-data-transport.md#inactive-selected-git-merge-message-original).
MERGE_MSG is a distinct commit-message input, with explicit-message precedence; a squash
conflict path can write it without write_merge_state. Ordinary merge state remains held.
Normal cleanup removes the message, so no universal leftover guarantee follows. Presence
or absence proves neither quiescence nor resumability. All existing operation holds and
object/ref/index/shallow/sparse/config/storage checks apply independently; no guarantee
that every conflicted repository exports. Pinned provenance implies no all-version claim.

Exact accepted opaque UTF-8/BOM/empty-present bytes survive; optional absence creates no
original. No message/OID/template interpretation or synthesis, reference chasing, active
MERGE_MSG installation, merge/commit/rebase/cherry-pick/editor/hook continuation or source
writes. Recognized secrets refuse without rewriting; sensitive prose/concealed secrets
remain limits, without a general draft-body URL-userinfo guarantee. NUL/binary/invalid
UTF-8, unsafe topology and foreign ownership refuse. Shared same-owner regular single-link
no-follow bounded reads and complete raw before/after identity/hash/absence/association
checks refuse observed drift. First native skip excludes this slot before copy/parse/pack
pairing. Shared family/valid-Git-manifest/false-removal binding, working export validation,
import-before-write, numbered mode0600 nonexecutable `.review` originals/maps and
authoritative-original-manifest-only re-export remain connected. Existing per-original,
combined review/raw inventory and hook bounds remain; no new provenance slot/traversal/
DTO/schema/storage-version/format/cap/dependency. Mode/mtime/empty directories/binary and
independent-writer atomicity remain limits. Source-only: no capture execution, native
equivalence, round-trip, atomicity or whole-Bible acceptance.


### Selected Git branch-description draft and binary support assets

The shared selected-original list now includes optional exact `EDIT_DESCRIPTION`
as inactive `.git/EDIT_DESCRIPTION`. It remains selected-gitdir data for both
coincident and linked layouts; no common/main/other-worktree draft is inspected
or substituted. Pinned [Git v2.56.0 branch.c850–879](https://raw.githubusercontent.com/git/git/v2.56.0/builtin/branch.c#L850-L879)
writes the draft before editing, then strips comments/whitespace for config;
raw bytes cannot be reconstructed from that transformed value. Editor failure
returns before config update. No universal retention guarantee, branch-name
inference or native continuation follows. The path macro/resolver keeps this
exact name private to selected gitdir. All existing operation holds remain.

Explicit harness selection also carries exact binary support bytes under the
already selected Claude/Codex skills and Claude hooks families. Live/import
inspection scans recognizable ASCII credential syntax and additionally decoded
UTF-8 when valid; compressed/encrypted/other encodings are not decoded. Raw bytes
are directly base64 encoded with false secret-removal status. Existing contained
path, same-owner/single-link/no-follow, drift and bounds checks remain. Structured
settings keep their existing parsers. Earlier text-only family descriptions are
superseded only for these support assets. Import still validates before writing
numbered mode0600 nonexecutable review originals/maps; retained re-export reads
only the authoritative manifest. These additions need no DTO or caller change.

The complete finite remaining list for this lane is maintained in the
[transport checklist](git-provider-user-data-transport.md#finite-remaining-portability-implementation-checklist):
Git association/ref-storage readers; combined/unknown index and sparse grammars;
missing-object/unknown reflog representation; selected submodule roots; exact config
and explicitly selected external support; provider empty-directory/mode/mtime
carrier and importer; reviewed native application; absolute/cross-root mapping;
persistent special-node/platform actions and service contracts; ACL/xattr host
APIs and representation; independent-writer snapshot/drain contracts.
These are remaining recreation requirements, not approved exclusions or evidence
that Bible #8 is complete. Source additions are untested; no execution validation,
native equivalence, round trip or arbitrary-writer atomicity is claimed.


### Selected provider directory and metadata evidence

The current reviewed-user-data manifest requires `providerDirectories`, including
an empty array for Git-only selection. Harness files require `metadata` with
`mode` (the original low 12 POSIX mode bits, including special bits) and
`mtimeNs` (canonical signed decimal nanoseconds since the Unix epoch). Git virtual
originals have no provider metadata. Selected provider directories carry their
path and the same metadata, including empty directories and selected family
roots. No source UID, ownership or destination authority is transported.

Live capture uses the existing fixed family roots and opaque subtree classifier;
it does not follow configured or external paths. Directory identities are
recorded before enumeration and checked again after all capture, as are file
identities returned by the bounded no-follow original reader. This detects
observed changes, not an atomic snapshot against independent writers. Files and
directories share a 1000-record cap; byte caps and secret rules remain unchanged.
The shared parser rejects unselected families, duplicate or conflicting file and
directory paths, noncanonical timestamp integers and out-of-range modes before
working-folder destination writes. This is the current pre-release format;
missing metadata is refused rather than guessed or upgraded.

Import retains the authoritative original manifest unchanged. Numbered mode0600
nonexecutable review files and their map retain file metadata, and the map's
`directories` records preserve directory existence and metadata even when there
are no files. These records are evidence for a subsequent reviewed application;
source execute/set-ID/sticky bits are never applied to review copies. No active
provider settings, skill, hook or executable is installed. Retained re-export
revalidates the authoritative original manifest and its exact artifact bytes;
it never promotes generated maps or review files into authority.

This completes metadata transport and review-map preservation only. Native
recreation of the directories and metadata remains unfinished: it requires an
explicit user-selected application operation, exact destination ownership and
conflict/replacement handling, plus a host operation capable of applying the
retained nanosecond timestamps without silently rounding them. Inert records do
not satisfy full native recreation under Bible #8. No tests, test preparation,
builds, typechecks or runtime/native/provider execution qualified this change.


### Current Git format extension and historical-evidence contract

The current strict manifest additionally requires `git.reflogMissingObjects`,
`git.indexOptionalReview` and both `git.configurationOriginalReview` slots.
Shared validation runs during live export, before import destination writes,
separate Git recreation and authoritative retained-original re-export. Missing
current fields are refused, never filled with guessed historical values.

`reflogMissingObjects` is exactly the sorted unique set of nonzero historical log
endpoints absent from the complete selected object inventory, including the
optional selected ORIG_HEAD log. Import recomputes the set from exact retained
log bytes and verified objects. It does not permit missing active refs, HEAD,
index objects or object-graph dependencies. Existing complete capture snapshots
and all-object enumeration prove observed local absence; no object is fetched,
fabricated or supplied from another root. Ordinary historical logs are recreated
with their exact bytes in the separate repository; ORIG_HEAD/log remains review
only, and missing-object evidence is also in CONFIGURATION-REVIEW.json.

The pinned files backend frames OIDs/timestamps/timezone with ASCII delimiters
but does not declare an identity/message character encoding. The reader checks
that framing in a lossless Latin-1 byte view without translating retained bytes;
known-secret inspection also checks decoded UTF-8 when valid. No locale or
replacement-character conversion is guessed. Invalid framing, zero/zero records,
NUL/control contamination and count/byte overflows still refuse. See
[Git v2.56.0 files-backend.c, show_one_reflog_ent](https://raw.githubusercontent.com/git/git/v2.56.0/refs/files-backend.c).

Unknown index extensions with an uppercase first signature byte are explicitly
optional in the [pinned index format](https://raw.githubusercontent.com/git/git/v2.56.0/Documentation/gitformat-index.adoc).
Their exact signature/body and `index` versus `sharedindex` provenance survive in
`indexOptionalReview`; the existing physical checksum, duplicate, size and
snapshot checks still run. The parser scans original bytes for recognizable
credentials and validates the bounded canonical base64 again at import. These
unknown observations never control parsing, native Git, monitor paths or the
fresh full index; recreation retains them in CONFIGURATION-REVIEW.json and
retained re-export uses only the authoritative manifest. Known derived-cache
and offset policies remain unchanged. Reserved extended bits and unknown
mandatory signatures still refuse. [Pinned sparse-index.c149–162](https://raw.githubusercontent.com/git/git/v2.56.0/sparse-index.c)
explicitly disallows combined on-disk split/sparse storage; no synthetic native
semantics are invented for it.

`configurationOriginalReview` contains `config` with common provenance and
`config.worktree` with selected provenance, each present or explicitly absent.
A synchronous bounded lexer follows [pinned config syntax](https://raw.githubusercontent.com/git/git/v2.56.0/Documentation/config.adoc)
and [config.c parse_value/get_value/get_base_var](https://raw.githubusercontent.com/git/git/v2.56.0/config.c):
sections, quoted/deprecated subsections, implicit booleans, continuations,
comments, quotes/escapes, BOM, CRLF and EOF. Export cross-checks every decoded
original declaration against the isolated no-includes native parser. Recognized
credential/source-ownership/URL-userinfo declaration spans are removed; surviving
nonsecret spelling, whitespace, comments and order remain exact UTF-8 bytes.
Secret section headers are removed with their entries. Concealed/comment secrets
that cannot be safely retained refuse; they are not silently copied. Import
reparses the retained spans, requires no further removals and exact equality to
the logical configuration list. No include/condition/configured target is
resolved. Originals remain inactive in CONFIGURATION-REVIEW.json, never installed
as active Git configuration.

A selected gitfile may point to a canonical same-owner separated repository
contained strictly inside the already selected working root, with no backlink
or commondir; existing snapshot/identity checks cover its association and storage.
Working-folder inventory excludes selected contained common/private storage roots
from ordinary file transport, and direct selected-file export refuses those
paths, so raw native storage cannot bypass the Git transport via a second copy.
External separated/submodule gitdirs still need explicit additional source-root
selection, rather than implicit acquisition. The [pinned repository layout](https://raw.githubusercontent.com/git/git/v2.56.0/Documentation/gitrepository-layout.adoc)
defines gitfiles and states that linked private packed-refs is ignored in favor
of common packed-refs; this change does not reinterpret that ignored file.

Reftable and explicit additional-root selection/application remain unfinished.
This source work does not qualify native equivalence, round trip, independent-
writer atomicity or full Bible #8. No tests, preparation, builds, typechecks or
parser/native/product/provider execution were performed.


### Explicit provider activation backend (successor of frozen 796)

This source adds optional `reviewedUserDataActivation: {git: boolean,
harness: boolean}` to import/copy metadata and Branch file selections. Both
booleans are required, unknown fields refuse, and at least one must be true.
Absent means inert behavior. It is separate from export Include selections and
from `workingFilesActivation`; the latter is also required for native application.
Full package, authoritative reviewed original in each selected root, exact
family presence, unused NEW managed destination and Shared-root confirmation
are checked before native work. Selecting `git: true` currently refuses with a
specific before-initialization working-copy adoption reason; existing init and
Separate Git ownership cannot be overwritten or treated as adoption.

`harness: true, git: false` reaches the actual provider files/directories from the
validated original manifest. `.git/` review originals stay inert. A provider
root collision refuses, including an existing empty directory. No existing
provider node is displaced. Regular files use exclusive no-follow creation;
new directory/file descriptors retain device/inode identity and canonical
membership checks through metadata application. All selected directory children
are created before directory metadata; files precede deepest-first directories.
The separately reviewed native helper is a REQUIRED composition dependency:
`818438b35f87f01263ead83a51d9c4389da49dc4`, parent released 744, exports
`applyExactFileMetadata` from `@ponderosa/native-host`. It is not copied into this
source tranche. No floating-point/Date time fallback, rollback or blind retry is
used for provider metadata. Windows POSIX metadata activation refuses.

Ordinary and worker canonical import identity include the exact activation
choice. Access-preview hash additionally binds package/original bytes, selected
working-root recovery destinations, Shared confirmation, effective mode and
NEW managed destination identity. Import rechecks the same selection. Branch
staged access review, grouped/single forwarding and retained results carry the
choice. Existing durable import result records each attempted source ref,
root path, original SHA256 and selection as applying/completed/incomplete;
partial metadata errors retain code and observed evidence (bigints as decimal
strings). Originals and partial destination bytes remain for recovery; recorded
completion is source behavior, not evidence of executed platform qualification.

Required UI follow-on remains separately owned: import/copy upload metadata,
agent-access-preview upload metadata, Branch file-selection controls and staged
review must send the same explicit choice and display incomplete application
receipts. Backend does not infer activation when these controls are absent.

Finite remaining checklist disposition: rows 1 (reftable and external selected
storage), 4 (extra submodule roots), 7 (native Git adoption), 8 (absolute/cross-root
mapping), 9 (persistent nodes/service context), 10 (ACL/xattr host APIs and
principal mapping), 11 (snapshot/drain evidence) remain incomplete. Rows 2/3/5
retain frozen 796 preservation behavior and its unresolved review boundary.
Row 6 now has provider metadata application caller source with exact native 818
dependency; this is not native-equivalence, round-trip, durability, independent-
writer atomicity or Bible acceptance. No tests, fixtures, preparation, builds,
typechecks, parser/native/provider/runtime/browser/liveDB execution performed.


### Standalone selected reftable source flow

The successor of frozen faff adds required `git.reftableReview`, either `null`
for file refs or `{source: 'common_repository', tablesListBase64, tables}`.
Each table retains `{name, dataBase64}` in exact `tables.list` order. The list
is bounded to 64 KiB/1,000 safe names; each table to 4 MiB; total originals,
inflated log data and expanded keys are bounded to 32 MiB and 20,000 records.
These are current prerelease representations, with strict validation and no
historical schema upgrade or dependency change.

Pinned primary contracts are Git v2.56.0
[technical format](https://raw.githubusercontent.com/git/git/v2.56.0/Documentation/technical/reftable.adoc),
[writer](https://raw.githubusercontent.com/git/git/v2.56.0/reftable/writer.c),
[blocks](https://raw.githubusercontent.com/git/git/v2.56.0/reftable/block.c), and
[backend](https://raw.githubusercontent.com/git/git/v2.56.0/refs/reftable-backend.c).
Source parsing validates header/version/hash/footer CRC, bounded unsigned varints,
record prefix/restart/key order, block/section boundaries, compressed-log consumed
bytes, index links/last keys/root-level coverage and object-index ref mappings.
Pinned writer details take precedence over assumptions from the prose: log-only
first blocks include the file header in logical offsets; replacement log keys may
precede the table's minimum; index roots may span several blocks. Log bytes remain
raw, with Latin-1 secret scans plus UTF-8 scans when valid; no encoding is guessed.

Live selection reads only the canonical same-owner selected stack list and
listed regular no-follow table originals, with existing identity/hash/absence
and before/after association drift checks. Orphan tables are not read or followed.
Stack order and ref/log tombstones derive current logical refs/HEAD and surviving
historical endpoints; shared validation recomputes them from exact originals,
checks complete current object graph and peeled targets, and recomputes absent
historical endpoint evidence. File-backend observed log originals remain separate
exact evidence. Ref directory/file conflicts are permitted for reftable refs.

Native read views use only these validated original tables, generated local
config and verified object copies; physical dummy HEAD never supplies logical
HEAD. Reconstruction writes exact tables/list into the separate review repository
with generated refStorage config, rather than flattening conflicting refs or
rewriting binary log histories as file logs. The authoritative original manifest
retains tables for re-export. None of this activates the live native root.

Linked shared/private reftable stacks remain an exact provenance dependency:
raw common tables also contain main-worktree private refs/HEAD, which cannot be
silently transported as selected-worktree originals. A filtered selected/shared
representation and corresponding recreation are still required. Root pseudoref
families other than HEAD/ORIG_HEAD/FETCH_HEAD, unsupported ref encodings and
excessive representations refuse; they are remaining implementation, not invented
external failures. Legacy ignored loose ref files are not declared recreated.
Finite row 1 now has standalone reftable source support; the other finite rows and
native Git adoption remain as previously recorded. No parser, tests, fixtures,
preparation, builds, types, native/runtime/provider/browser/liveDB execution,
round-trip, equivalence or atomicity qualification occurred.


### Direct native Shared Git creation before initialization

The next successor implements `git: true` only for one complete selected working
folder, with all imported members using the same NEW managed Shared destination.
Separate Git copies and multiple source roots refuse before writes. The importer
binds the validated original artifact SHA256 and activation choice, records the
native Git initialization phase, and passes that exact original to
`initializeImportProject`. For this explicit path the service directly creates
Git in the proved canonical empty root and returns before the ordinary
`git init`/empty-commit path. It never deletes or replaces generated metadata.
No Git command, hook, provider or include target executes during this creation.

Native configuration is exact accepted common source bytes, limited to explicit
literal core repository/filemode/log/ignorecase/precomposeunicode/autocrlf/safecrlf/
eol/quotepath/whitespace/symlinks fields, object/ref storage extensions and
user.name/email. Source worktree config, removed spans, other settings, bare
sources, sparse patterns/collapsed directories, unknown optional index records,
submodules and active hooks/legacy/recovery originals require further application
contracts and refuse. Selected draft/web originals and nonexecuting `.sample`
hook files can be installed; no hook execution is inferred. These are narrow
supported semantics, not a universal native restoration claim.

The shared writer creates verified loose objects, refs or exact reftable stack,
logical HEAD, supported config, reflog bytes, full index/flags/REUC, shallow and
info originals, ORIG_HEAD/FETCH_HEAD evidence and verified retained pack/keep/mtimes
originals. Parent directories are created exclusively or matched to this writer's
known directory identities; regular files use exclusive no-follow descriptors.
It verifies created file hashes/identities before returning. The working-copy
service retains current in-process creation proof (not restart/retry authority),
checks exact root/.git identities and complete expected Git inventory, and reads
bounded originals/hashes before and after working-file population. No unknown
state is cleared or reapplied when proof is unavailable. Partial roots and
recovery originals remain, with applying/completed/incomplete phase receipts.

Provider activation can follow this supported Git path. Ordinary root metadata
is deferred until provider children and exact provider metadata complete, avoiding
premature root permissions or directory-time changes. Application failures after
an attempted population conservatively retain possible partial-state evidence.
Reftable one-level root names now follow pinned `refs.c:is_root_ref` syntax;
operation-in-progress roots still require continuation semantics and refuse.

Finite disposition: rows 1/2/3/5 have the source preservation coverage recorded
above, with linked shared/private stack privacy and unsupported source semantics
still explicit remaining work. Rows 6/7 now have actual provider metadata and
narrow NEW Shared Git caller source, dependent on reviewed native 818 for provider
metadata; neither is execution-qualified. Rows 4/8 await the tracked named-root
selection/provenance/destination mapping decision. Rows 9/10/11 require real
special-node/service, ACL/xattr/principal, and snapshot/drain APIs; concrete
contracts were sent to the root owner, with no fabricated implementations or
blanket exclusions. Both earlier frozen review tranches remain unchanged.
No tests, fixtures, preparation, parser/native/runtime/provider/browser/liveDB
execution, builds or types were run. Full native equivalence, round trip,
independent-writer atomicity and whole-Bible acceptance remain unqualified.


The same native-creation successor also closes a provider-parent metadata gap:
selected `.claude` and `.codex` parents carry their own mode/mtimeNs, including
empty parents, without enumerating unrelated session/profile contents. Canonical
same-owner parent identity and optional absent parents/families/fixed files are
rechecked before return. Existing accepted directory records drive recreation
and deepest-first native metadata application, so a parent is finalized after
its children. Export exclusions now distinguish inert evidence from separately
reviewed native activation. Capture drift observations still prove no consistent
snapshot against independent writers.


### Reviewed source corrections: physical EOF and descriptor cleanup

The shared local Git config lexer follows pinned Git v2.56.0 `get_next_char`/`parse_value`: physical EOF supplies a synthetic LF. A final backslash byte in an unquoted value consumes that LF as a continuation, then the next synthetic LF terminates the value. The backslash contributes no value byte; an unclosed quoted value still refuses. This does not append a physical newline, rewrite retained original bytes, change original hashes, or authorize excluded configuration. Primary source: https://raw.githubusercontent.com/git/git/v2.56.0/config.c (lines 756–852).

Provider application owns every opened descriptor before its first stat, attempts all closes, and preserves the primary application code/observed partial-state evidence when cleanup also fails. Cleanup failure after otherwise successful application reports an incomplete, possibly partial result; it never authorizes rollback or retry. Root-inspection cleanup failure preserves its primary cause before any provider mutation. These are source changes awaiting independent exact-head review; no parser/native execution or installed qualification was performed.

Destination-root finalization also owns its descriptor before stat, runs after ordinary/provider children, attempts close on every path, and keeps the primary finalization cause/code plus any cleanup failures. A failed finalization collects held-descriptor observed identity/mode/mtime where stat remains available; successful metadata application followed by failed cleanup is explicitly incomplete and possibly partial. No automatic retry, deletion or rollback is authorized.

## Unreviewed selected-root and metadata contract candidate after 24a

This candidate is incomplete implementation, not an owner release or evidence of
Quality SUPPORT. The released 24a source and its review remain separate. No native
117 implementation is copied into this tree and no new native function is called.

The public selection type adds independently selectable
`extendedMetadata:{userXattrs,posixAcl}` and
`persistentNodes:{fifo,evidenceOnly}`. Both keys in each supplied family are
required booleans. Omit an unused family; all-false family objects, unknown keys,
wrong types and an entirely empty selection refuse. Git/harness booleans remain
explicit. The retained selection type no longer projects away these families,
and retained-original selection equality checks them. Live capture of either
new family currently refuses before any metadata values are inspected. A
manifest claiming these families without authoritative node evidence also
refuses. There is no serialized metadata evidence carrier yet. In particular,
unsupported/unread/error states have not been represented as successful absence.

The separate `reviewedMetadataActivation` shape is
`{sourceQualifier,destinationQualifier,principalMappings,replaceInheritedUserAndPosixAcl:true,rootRefs,fifo}`.
Mappings contain `{sourceQualifier,kind:'user'|'group',sourceId,destinationId}`.
Validation bounds qualifiers, rejects unknown fields and duplicate roots, requires
canonical decimal IDs in 0..4294967294, and rejects duplicate source or collapsing
destination mappings of the same kind. This is structural validation only:
completeness against captured owners/named ACLs, observed destination provenance,
current destination ownership, combined selected-family evidence and exclusive
custody are not implemented. Consequently ordinary and Branch paths explicitly
refuse metadata application before it can reach filesystem mutation. No new
per-root applying/completed/incomplete metadata receipt is fabricated.

The activation field is retained in ordinary request/upload allowlists, JSON
worker and direct canonical hashes, copy identity/forwarding, access-review
selection/hash inputs and ordinary Branch grouped/single forwarding. The
unsupported gate currently prevents a successful metadata access preview.
The existing git/harness activation is independent and unchanged in authority.

Incoming export `gitStorageBindings` use
`{id,worktreeAgentId,storageAgentId,relativePath,role:'common'|'private'|'module'}`.
The ordinary export query takes a JSON array; the internal Branch export options
carry the same array. Selections require a full organization, all whole working
folders, live Git selection, included current Agent selectors, and same observed
owners. Relative paths are canonical contained spellings; `.` names the selected
storage root itself. No selected path is followed from the binding yet: reciprocal
descriptor-relative association/content capture is unfinished and explicitly
refuses. The current per-Agent Branch exporter cannot supply another root's
authority; no new export-wide Branch orchestration has been implemented.

Ordinary organization-folder export now allocates the complete selected-root ref
map before associated Git reads. POSIX roots are opened no-follow and descriptors
enter cleanup ownership before fallible stat. Canonical root identities and
registered current Agent membership are checked before each root capture and
before return. Identical canonical roots share a ref. Different canonical aliases
with equal device/inode refuse until mount/view equivalence is proved; root inode
equality does not prove identical nested mount views. Windows ordinary export
retains named identity checks without claiming held-descriptor cross-root proof.
Every owned descriptor close is attempted, and cleanup failure preserves the
primary cause/code and observed evidence. These checks are drift detection,
not coherent acquisition against independent writers.

The package carrier `gitStorageBindings` uses
`{id,worktreeRootRef,storageRootRef,relativePath,role}`. Shared validation requires
both final roots in actual full-package closure, unique IDs/role associations and
nonconflicting storage roles. The composer deterministically remaps both root
refs and binding IDs for its currently supported complete single-Agent inputs;
it refuses incomplete closure and validates the result. Multi-root individual
Branch composition/capture and reciprocal provenance remain unfinished. Imported
bindings are inert declarations, never proof of source association or a current
grant. Native Git activation of a package carrying bindings refuses until mapped
recreation is implemented; original host absolute pointers are never installed.

### Finite eleven-row disposition at this candidate

| Row | Current source disposition |
| --- | --- |
| 1. Git refs/storage | Existing contained file refs and standalone reftable retained; external association capture and linked common/private stack provenance remain unfinished. |
| 2. Index semantics | Existing supported full/split/sparse review evidence retained; unsupported native optional/mandatory semantics still refuse. |
| 3. Historical refs/logs | Existing historical pointer/reflog/reftable evidence retained; no new execution qualification. |
| 4. Extra roots/modules | Selection types/validation, prebuilt ordinary root map, inert package closure and both-ref composition added; actual reciprocal capture/native recreation and Branch-wide orchestration unfinished. |
| 5. Configuration/hooks | Existing spans and narrow literal native configuration retained; external includes/hooks/path activation unfinished. |
| 6. Provider metadata | Released 24a descriptor/cleanup/finalization corrections retained; no new execution claim. |
| 7. Native roots | Existing one-complete-Shared NEW native Git flow retained; multiple-root/Separate Git mapped recreation unfinished. |
| 8. Links | Existing passive in-root topology retained; absolute/cross-root link mapping and callers unfinished. |
| 9. Persistent nodes | Selection/activation structural contract added; native117 FIFO/evidence inspection not called, no carrier/creation/grant receipts; device/socket recreation absent. |
| 10. ACL/user xattrs | Structural selection/activation validation, retained-selection guard and forwarding added; source/destination qualifier observation, node evidence, secret-safe capture, native application and receipts unfinished. |
| 11. Coherent acquisition | No actual snapshot or independent-writer drain backend. Root identity/drift checks do not establish atomicity. |

### Frozen backend wire and reserved UI caller list

This describes the candidate wire only; metadata capture/restore and cross-root
controls must not be advertised as working. Web remains UI-owned. Later caller
work includes ordinary Agent export selections (naming full attribute VALUES and
possible sensitive contents before affirmative capture), organization storage
Agent selectors, import/copy/upload activation choices, exact access-review
binding, Branch staged export/import selections and grouped/single forwarding,
and observed partial-application display once real receipts exist. No source
Agent IDs or imported principal IDs become destination authority. The current
full-package sensitive-data warning and secret exclusions remain mandatory.

The candidate was limited to source editing, Git metadata, physical bytes/hashes
and whitespace. No tests, fixtures/preparation, builds, typechecks, compilation,
Node/parser/native/product/provider/browser/liveDB/capture execution or new
Agents. Native parity, roundtrip, durability, atomicity and Bible acceptance are
unqualified. Remaining implementation is feasible source work; approved
abc903/14ae/13f817 are not pending approval and no new external technical blocker
has been established by this candidate.


## Bounded ordinary organization common/private capture increment (unreviewed source)

This section records the current increment; earlier 256 candidate dispositions
above describe its predecessor. This is a source candidate awaiting independent
review. No capture, native command, parser, build, typecheck, or test was executed
for qualification of this increment.

Ordinary full organization export now connects `gitStorageBindings` to the
existing supported file-ref Git capture. The human selects included source
Agents, whole working folders and Git. The server allocates the complete final
working-root map first, deduplicates roots, checks current organization membership,
registered roots and owners, then proves each common/private pair. Modules,
linked reftable, non-Linux cross-root capture, overlapping selected roots and
cross-device descendant traversal and unproved physical aliases refuse. A storage-only root can participate
without fabricating a Git review for that root; whole-root storage combined with
harness review refuses because it cannot also carry ordinary working files.

All source Git directory components are opened relative to held selected root
or descendant descriptors with no-follow and same-owner checks. Source files
remain held across comparison snapshots; readers borrow handles and do not
reopen source originals. Raw absolute and relative pointers are interpreted
component by component against canonical selected roots and their known
ancestors. A declaration is checked against the exact pointer target before
association-target reads. The selected `.git` file must identify the selected
private directory; its `commondir` must identify the selected common directory;
its `gitdir` backlink must identify that exact selected worktree `.git` file.
The private directory must have the common `worktrees/<name>` topology. The
common `worktrees` directory is held, never enumerated. Only explicitly selected
private storage is enumerated. Membership, roots, directory entries, held file
identities and reciprocal originals are checked before and after capture; drift,
unsupported evidence and cleanup failures fail closed. Every descriptor cleanup
is attempted and preserves primary and cleanup errors. No source rollback,
automatic retry or source deletion was added.

The connected capture retains the existing bounded object, loose/packed ref,
selected/shared reflog, HEAD/historical-pointer, index/split/sparse and literal
configuration review families, secret exclusions and exact absence/error
rules. Native parsing only receives the existing isolated copies/stdin, never
live source pointer authority, includes, URLs or module initialization. Selected
common/private storage is excluded from ordinary working-file topology, including
storage roots selected as `.`. Unsupported required formats still refuse.

### Frozen backend carrier and caller scope

Incoming selectors remain
`{id,worktreeAgentId,storageAgentId,relativePath,role:'common'|'private'|'module'}`;
module capture stays unsupported. Generated package bindings retain
`{id,worktreeRootRef,storageRootRef,relativePath,role}` and add optional
`capture:{version:1,currentAuthority:false,reviewSha256?,roots,records}`.
`roots` are `{rootRef,sourcePath,identity}`. `records` are
`{rootRef,relativePath,identity,dataBase64?,absent?:true}`. Identities retain
observed device/inode/mode/owner/size/mtime-ns/ctime-ns, as evidence only. Exact
bounded gitfile/commondir/backlink bytes remain inert; common association
absences are explicit. Package captures require the SHA256 of the included
canonical review artifact. `ReviewedUserData.associationReview` retains the
unhashed proof pair inside that original, avoiding a circular hash.

Shared validation checks both final-root refs, proof closure, reciprocal pointer
semantics, directory evidence, explicit common absences, the authoritative review
artifact hash/content and storage-versus-working-topology collisions. Composer
remapping updates both binding refs and every nested provenance ref while
retaining original bytes/hash. The current single-Agent Branch composer still
refuses incomplete cross-root closure; Branch-wide capture/composition is a
follow-on. Retained-original export preserves the embedded association proof
verbatim and never recaptures source paths or manufactures new live closure.
Mapped native activation refuses both outer bindings and embedded association
originals, including retained originals without outer bindings. Recreating
mapped roots remains separate work.

Exact changed caller surfaces are `routes/agent-packages.ts`:
`buildPortablePackage` (HTTP organization export and existing internal
`exportAgent`); `portable-working-files.ts`: `inventoryWorkingFolder`,
`exportWorkingFiles`; `portable-reviewed-user-data.ts`:
`createGitExportCapture`, `verifyGitExportAssociations`, `gitAssociation`,
`selectedReviewedGitStorage`, `exportReviewedGit`, `exportReviewedUserData`,
`regularOriginal`, `captureSparseConfiguration`, `captureIndexStorage`,
`captureGitRaw`, `validatePortableGitStorageBindings`,
`gitBindingSourceEvidence`, `parseReviewedUserData`,
`planReviewedUserDataActivation`, `validateNativeGitSelection`;
`portable-agent-package-validation.ts`: `validatePortableAgentPackage`;
`compose-agent-packages.ts`: `remapPortableGitStorageBinding`,
`composeAgentPackages`; and the shared core portable user-data carriers.
No worker-envelope field changed: bindings/proofs are inside the package and its
existing canonical payload hash. Metadata flags and activation retain their
explicit unsupported guards. UI remains reserved; later UI controls must use
these source-Agent selectors and existing full-package sensitive-data review.
No UI or Runtime custody/staging source was edited.

### Finite eleven-row disposition for this increment

| Row | Current source disposition |
| --- | --- |
| 1. Git refs/storage | Ordinary selected cross-root common/private file-ref capture connected; linked reftable and mapped recreation remain unsupported. Existing standalone reftable source retained. |
| 2. Index semantics | Existing bounded full/split/sparse review capture reused through held source IO; unsupported formats still refuse. |
| 3. Historical refs/logs | Existing selected/shared historical-pointer and reflog capture retained; no new execution qualification. |
| 4. Extra roots/modules | Complete ordinary selected-root context, reciprocal capture provenance, closure validation and both-ref remap connected. Modules, overlapping roots and Branch-wide orchestration remain follow-on. |
| 5. Configuration/hooks | Existing exact nonsecret/literal configuration and narrow hook evidence retained; external include/hook/path activation remains unsupported. |
| 6. Provider metadata | Released predecessor behavior retained; no native117 metadata calls or new harness equivalence claim. |
| 7. Native roots | Mapped native Git activation still refuses; multiple-root/Separate Git recreation remains follow-on. |
| 8. Links | Existing passive in-root topology retained; mapped absolute/cross-root links remain follow-on. |
| 9. Persistent nodes | Metadata selection contract retained with unsupported capture/application guards; FIFO integration and device/socket recreation remain absent. |
| 10. ACL/user xattrs | Structural selection/activation retained; metadata evidence/native callers/current grants/receipts remain follow-on. |
| 11. Coherent acquisition | No snapshot or independent-writer drain backend. Held custody and observed-change refusal provide no atomicity or durability qualification. |

This bounded source candidate makes no native parity, roundtrip, durability,
atomicity, review, release, integration or whole-Bible acceptance claim.
