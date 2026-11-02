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
| Cyclic symlinks | Refuse explicitly at bounded symbolic expansion; passive cycle preservation is not implemented. No dereference, guessed target or silent flattening. |
| FIFO/socket/block/character device | Refuse at inventory before opening/reading it. A live endpoint's process/kernel state is not ordinary bytes and is not fabricated. Persistent FIFO/device-node topology is still unsupported; if needed for the selected workflow it remains a concrete recreation gap, not a Bible-approved blanket exclusion. |
| uid/gid, ACLs, xattrs, birth/ctime/atime, sparse extents, special ownership bits | Not represented by the current DTO. Ordinary content/mode/mtime are the only preservation claims. Host principal numbers/native attributes are not destination authority; loss of nonsecret required ACL/xattr/special-file semantics remains an exact format/platform gap. No byte-identical filesystem claim. |
| `.git` working-tree pointer; common-dir/worktrees links, ownership markers, branch creation/cleanup receipts, locks | Not adopted. Destination working-copy service creates its own branch, paths, receipts and cleanup ownership. Adopting source receipts would misidentify a foreign worktree as locally owned. This is separate from user Git data. |
| Git commits/objects, branches/tags/refs, reflogs, index/staged state, config/hook content | Unchecked Agent/organization and full Branch export controls pass explicit `reviewedUserData` choices for selected whole folders. This selection transports supported local Git objects/history, refs/HEAD, normal local reflogs with exact nonsecret user/time/message metadata and staged index originals through the shared package flow into a separate review repository. Nonsecret configuration is inactive review data; Git hook files are explicitly excluded and destination Git ownership stays local. See [exact contract and refusals](git-provider-user-data-transport.md). Linked worktrees, unsupported reflog formats or missing/pruned reflog objects, extended index semantics, live activation and other listed families remain unsupported; fresh Git initialization alone is not equivalent recreation. |
| Provider `.codex` / `.claude` profiles, browser sessions, `.ssh` / `.aws` / `.gnupg`, `.env*`, known credentials/private-key paths | Listed exclusions; credentials and live owner/session state must be re-entered/recreated. Explicit harness selection transports the supported project-root settings/instructions/commands/agents/skills/rules listed in [the review-copy contract](git-provider-user-data-transport.md), with known secrets removed or refused. They remain inactive review files. Host home profiles, sessions and unsupported configuration families are not read or adopted. No universal claim that those directories contain only secrets. |
| `.ponderosa-import-backups` | Private destination recovery bytes/path sidecars retained locally, excluded from package traversal. The source package originals remain managed artifacts; this exclusion does not permit deleting the recovery folder. |
| Concurrent shell/native writers outside Ponderosa | Local stat/identity checks detect observed changes; the in-process source fence cannot stop independent external writers. No arbitrary-writer atomic snapshot guarantee. Use an independently consistent snapshot/export or stop writers before selecting content. |

The shared route forwards `links` through ordinary recovery destinations and
confirmed `populateImportedRoot` live destinations. The existing import operation
retains the manifest for re-export; Shared composition unions identical links and
refuses conflicting topology. Existing owner deletion, group journal retention,
precleanup, source custody and tree-deletion holds are unchanged.

This closes the demonstrated in-root link transport gap. It does **not** close
whole #8 or silently approve Git/native-directory/user-metadata exclusions. The
remaining U3 implementation targets include linked-worktree/unsupported-reflog/extended-index
Git data, broader native configuration and explicit reviewed activation; cross-root/absolute/cyclic link
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
