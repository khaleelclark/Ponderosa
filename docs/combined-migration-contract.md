# Combined package migration

This describes the existing product package contract, not a full installation backup or completion of Behavior Bible #8. A full Agent/organization package can carry the selected Chat memory and historical execution evidence together. A template carries setup only. Full workflow packages embed Agent packages and the workflow definition; memory-bearing updates may use the [explicit additive review](branches-additive-memory-update.md) for selected new Agents in preserved Chats, while existing Agents’ memory and destination permissions remain unchanged. Other memory-bearing updates still require fresh installation or a separate supported migration.

| Data | Full package behavior | Destination authority |
| --- | --- | --- |
| Agent setup and included management tree | Engine/model/effort, instructions, relationships and declared management permissions are copied with new Agent IDs. Chat instructions use the existing explicit conflict choice. | User-selected import and existing destination import checks apply. Management settings are distinct from capability restrictions and memory grants. |
| Selected Chat team/private memory | With local memory configured, includes versions, conflicts, embeddings and original provenance for included Agents. Private audiences and lineage are remapped to fresh destination IDs. Cross-Chat organizations require separate packages/Chats. | Compatible local storage/models are required. Current source authority is re-stamped under the destination principal; origin remains historical. Pending import visibility/rollback remains the existing implementation. |
| Execution history | Saved log artifacts contain normalized events and Run status/times. Re-export preserves imported bytes. | Historical only. A source `running` Run never grants a destination lease, schedules work or resumes a process. |
| Managed artifacts and private authored history | Existing package artifact and text rules apply. | Known credential fields are removed; arbitrary free-form content may still be sensitive. Export must fail explicitly at existing limits. |
| Workflow definition/policy | Existing Branch package definition and execution policy travel as workflow configuration. | Existing installation preview, bindings, secret re-entry and current authority apply. This is not installation capability-policy transport. |
| Installation-global memory | Excluded from Agent packages (`excludedScopes: ["global"]`). Separately selected and reviewed global transfer is available in Settings → General. | Explicit selected data only; new destination IDs/principal with inert source provenance. Existing facts, conflicts, capability policy and grants are preserved. |
| Capability restrictions/history and memory read grants | Not serialized into Agent memory or execution logs. | Destination policy and operator grants remain local. Source Agent management settings do not replace these controls. Forged memory `grants` fields are rejected. |
| Active execution/control state | Scheduler leases/fences, activations, outboxes, Requests/Joins, operational Branch execution/checkpoint state and live effects are not restored by Agent packages. | Fresh scheduler admission and current human authority remain required. Historical Branch execution Chats are excluded. |
| Provider-native state and credentials | Native sessions, exact provider inputs, tokens/profiles and known secret values are excluded. External work folders and provider installations are not transported by Agent packages. | Reconfigure explicitly at the destination; do not infer authentication or live process ownership from imported evidence. |

Full Agent export and full workflow download disclose sensitive content and the major exclusions before export. This is disclosure of current behavior, not permission to waive the full-portability requirement.

## Prepared final-batch checks

The new combined test in `tests/memory/package-portability.test.mjs` seeds team/private/global memory, source execution evidence with a historical running Run, a management relationship/settings, differing source/destination capability policies and a source global-read grant. It prepares assertions for fresh HTTP organization import, retry, reopen and re-export: preserved memory/provenance/relationships and execution bytes, no destination live work, no imported source grant/policy and unchanged pre-existing destination global memory. A forged grant must refuse without allocating Agents. Existing workflow-memory and execution tests remain unchanged.

`tests/workspace-navigation/package-export-disclosure.test.mjs` prepares the actual TSX disclosure/cancel/confirm callback check plus the actual view export closures under stubbed transport: no request before review, canceled confirmation, template behavior, retained failure/retry and reviewed-source identity after navigation. These are component/closure-level checks, not mounted browser proof of the entire Branches view. Final qualification must also mount the menu/dialog/download flow with keyboard/focus and pending-state behavior. The source callback captures its reviewed workflow ID/name.

No builds, typechecks, tests, Chroma/provider processes, browser checks or runtime migrations have been executed for this successor. These checks are assembled for the user-requested final batch. Use existing workspace resolution and web TypeScript loaders. The memory fixture needs an owned Chroma executable; its vectors are deterministic fixtures, not inference/recall qualification.

## Selected global-memory transfer (model A)

The operator chose selected Agent/organization packages plus separately selected, operator-reviewed global-memory records. Whole-installation copy or foreign permission/grant adoption is outside this model.

In Settings → General → Transfer selected global memory, choose local records, select each fact/earlier version/conflict and review before downloading. Nothing is selected automatically. Required superseded versions and all affected facts of a selected conflict must be selected explicitly; incomplete lineage or conflict coverage refuses. Import a transfer file, select records again, then review full selected text, metadata/provenance and existing destination facts/conflicts before confirming. Conflicts and parallel facts remain for explicit resolution; no automatic reconciliation, replacement or deprecation occurs. Existing operator global update/forget operations remain the resolution path; an imported conflict record is historical reasoning, not an instruction to perform a write.

Global transfer uses its own strict `ponderosa.selected-global-memory.v1` DTO (16 MiB, 10,000 total rows, compatible 384-vector/model signature), separate from Agent packages. Known credential fields are excluded on source export and rejected on import using the existing portable-secret validator. Arbitrary stored text may still contain sensitive data. Unknown/foreign local rows fail export; they are never adopted. Source policy/grants, credentials and live work have no fields in this format. Source principal/Agent/Run IDs survive only as inert origin evidence; destination source stamps use the local principal and synthetic historical import provenance, with no Run/lease/fence authority.

The source export confirmation binds the reviewed inventory, so changed source content requires reload/review. Import review binds the exact canonical selected packet and current complete destination global inventory; changes require a fresh review before writes. Metadata/key and selected-record order normalization keeps identical selection stable. Deterministic new IDs let exact re-reviewed retries add only missing rows without duplicates; a changed local imported record refuses collision rather than overwrite. Existing destination policies and global-read grants are never read as portable authority or mutated.

This uses the existing ordinary-memory in-process storage queue and authority guard before reads/effects/delivery. The queue is nonreentrant: standalone inventory acquires it once, while import calls a private inventory helper inside its single lock so the complete destination review check and guarded append remain serialized together. There is no new command journal, cross-process lock or atomic/crash rollback claim. Parent versions are written before descendants, conflicts after facts, so an interrupted prefix remains readable for a new review. Multiwrite failure or request revocation can leave only already-selected additions; re-review current destination state before retrying. This does not overwrite existing data or invent whole-installation recovery. External concurrent storage writers, crash/stress/high-cardinality behavior and real model recall remain unqualified.

Implementation and tests are prepared, not executed in this increment. New HTTP cases cover Core/Branches selection/review/import/reopen/reexport, retained provenance/lineage/conflicts/destination policy/grants, missing review/coverage, malformed/foreign/secret/zero-vector data, stale source/destination review, Agent token refusal, collisions, deterministic ordering and partial-write/revocation re-review. Actual TSX callback tests cover no implicit selection or commit, cancel, review content, failed retry, export acknowledgement, malformed/oversize files. Mounted keyboard/focus/pending/download behavior still needs consolidated browser qualification. Full #8/Phase2 remains incomplete pending consolidated execution and remaining qualification.

## Portable setup and API warnings

Agent packages now preserve the standing role, saved processing tier (`speed`), and preset snapshot separately from initial instructions. A preset snapshot records provenance; import does not create or select a destination preset. Its guidance artifact references are rebound like initial guidance. Imported processing tiers are validated against the chosen destination engine/model before creating Agents; unavailable tiers refuse rather than silently selecting another tier. Old packages without these optional fields retain their existing behavior. Known credential keys are not accepted as extra snapshot fields; free-form guidance/history remains sensitive user data.

Full/context Agent exports include `X-Ponderosa-Export-Warning` on the HTTP response, so API download clients receive the sensitive-data and credential re-entry warning too. Templates do not carry the full-data warning. UI confirmation remains required by the existing UI flow; a response header is not a substitute for that confirmation.

The continuation below adds structured history, uploaded originals, working-copy mode, reviewed capability settings and selected external file bytes. The remaining boundaries and owner-dependent consumers are explicit; this does not establish an identical full organization roundtrip. Selected global memory remains separately reviewed, and workflow operational state remains historical.

## Structured history, selected files and reviewed access

The continuation replaces the role/text/time-only transport for canonical authored messages. Full history rows now retain `communication` with original immutable scope, audience, actor, IDs, timestamps, identity labels, correlations, citations and document metadata; `communicationRevisions` retain edits. Imported source IDs are historical provenance. Import does not append those records to the destination communication journal, generate deliveries, adopt a live request or schedule work. Genuine duplicate messages remain separate. Broadcast inclusion follows its canonical Chat scope; private messages follow exact Agent audit routing, never text or rendered mentions.

`attachmentRefs` bind uploaded originals, in source order, to portable managed artifacts. Export reads authoritative original bytes and refuses missing/changed originals. `artifactRefs` separately bind document/managed-artifact source IDs to destination IDs, including collision remapping. Import stages, validates, publishes and rolls back these originals through the existing shared package engine. Re-export reads imported originals rather than attempting to open the old machine's upload URLs. Original source attachment metadata remains inert; destination managed originals have fresh local ownership. Ordinary imported-history text projection remains unchanged; richer scope/attachment presentation is a UI consumer task.

Each Agent includes source Chat identity and Shared/Separate Git copy intent. The new import creates fresh local working-copy ownership using the existing working-copy service, rather than adopting source root paths, native sessions, branch ownership proofs or cleanup receipts. `workingCopyMode` on import/copy can explicitly choose Shared. Source and destination Git repositories/commits are not transported implicitly.

Nonsecret effective capability restrictions are exported as `accessSettings.restrictedCapabilityIds`. A restricted package import first returns HTTP 409 with source settings, current destination policy and `reviewSha256`. The operator submits a new import identity with `accessSettingsResolution: {action: "use_source" | "keep_destination", reviewSha256}`. Applying source restrictions creates an audited operator policy only on the newly created Agents; destination Chat/product/installation restrictions remain in force. A changed destination policy invalidates review again immediately before commit. Source memory-read grants, saved-browser grants/profiles, connector credentials and installation permissions are not adopted. Existing explicit grant Settings APIs remain the human path for those destination choices. Headless workflow callers must forward an explicit reviewed choice; they cannot silently choose one.

To include external working-file content, select regular files relative to the exported root Agent's working folder with the export query `workingFiles` containing a JSON array of paths. This is an explicit selected-file transfer, not a directory/Git/profile backup. Known credential/native ownership paths, links, path escapes, changing files, JSON with known secret fields, and oversized content refuse export loudly. The package retains the selected path manifest and original bytes. Import requires `workingFilesDestination` naming an absent absolute folder with an existing canonical parent. It exclusively creates that folder and each file; existing folders/files are never overwritten. On any later failure, transferred user files remain, with their location in the durable operation/result/error. They are never recursively deleted during Agent rollback. The chosen folder is returned for the user; it does not replace an existing Chat's registered working root. A subsequent export retains the manifest and stored originals. Permissions, timestamps, symlink graphs and Git history are not included by this selected-original-byte transport.

Cross-Chat reporting organizations remain a concrete model conflict: current creation and organization mutation require parents and every ancestor to belong to the same Chat. A package with distinct source Chat bindings refuses before allocating destination Agents, rather than collapsing private namespaces or rewriting those rules. Cross-Chat communication provenance is retained historically. Supporting a live cross-Chat reporting tree requires an explicit ownership-model decision and changes to canonical organization/deletion/context authority; a package flag cannot supply it.

These are unexecuted implementation changes. UI controls and Branches installation review forwarding remain assigned to their owners. They do not establish a complete identical-organization roundtrip or a passing #8 verdict.

### Structured review and historical presentation

`POST /api/projects/:id/agent-access-preview` accepts the same bounded
`application/vnd.ponderosa.agent-import` upload as the asynchronous import route:
JSON metadata followed by a newline and the package JSON. It validates the owned
upload and destination without creating canonical records, then returns
`AgentAccessImportReviewDto`: `{reviewSha256, source, destination}`. Re-upload the
same package with `accessSettingsResolution` to queue an import. Import recomputes
the digest against the current destination policy and refuses stale choices.
Temporary staging is removed after preview. Raw metadata admission now accepts the
review, working-copy and destination-folder fields as well as role review.

`GET /api/agents/:id/imported-communications?offset=0&limit=10` returns
`ImportedCommunicationsPageDto`. It preserves source Communication and revisions,
ordered remapped attachment refs, document bindings, and independently authorized
artifact metadata with server-provided download URLs. Source IDs and scope remain
historical, never live destination authority. Pagination is 1–20 messages, bounded
to 2 MiB; use `archiveVersion` on subsequent pages to detect changes. Oversized
pages return 413 rather than silently clipping; bounded imported-history retrieval
remains available for large text. This is an owning-Agent view, not an unrestricted
archive download.

### Whole root working folder

Full Agent export supports the explicit `wholeWorkingFolder=true` query. It
inventories the selected root Agent's working folder, including empty directories,
relative topology, regular file bytes, ordinary permission bits and modification
times. Special ownership bits are never adopted. Whole-folder inventory is bounded
to 10,000 entries and existing package/artifact byte budgets. Native ownership and
known credential paths are omitted and listed in `workingFolder.excludedPaths`;
text secret assignments, known private-key content and JSON secret fields refuse
export. Symlinks, hardlinks and special files refuse rather than being dereferenced.
There is no guarantee that arbitrary opaque user data contains no secret.

Import uses the existing explicit `workingFilesDestination`, which must be a NEW
canonical absolute folder. It never overwrites or deletes an existing user folder.
Directory and file metadata are restored where the host supports them; errors are
visible and partial bytes remain at the durable receipt's destination. Re-export
retains imported folder intent and originals. Creating/rebinding a Chat to the new
root remains an explicit human Chat creation/settings action. Independent Agent
working copies are not silently combined into this root-folder transport.

### Nonsecret access suggestions

Exported `accessSettings` also retain optional `readGlobalMemory`,
`savedBrowserAllowed`, `browserMode`, and `sourceProfileName`. These are inert
suggestions. Capability restriction review applies only `restrictedCapabilityIds`;
it does NOT grant memory or browser access. Import result `accessSettingsToReview`
contains exact destination Agent/Chat mappings and source suggestions so the web
caller can obtain a separate human choice through existing Settings APIs:

- GET/PUT `/api/local-memory/grants/:chatId`: read the current destination revision,
  show the Chat-wide effect, and submit `{readGlobal,expectedRevision}` only on
  explicit confirmation.
- PUT `/api/projects/:browserOwnerHandle/saved-browser-access/:agentId`: submit
  `{allowed}` only after the human reviews access to the current saved browser.
- Existing Agent browser-preference Settings: choose a DESTINATION trusted profile
  or disposable mode; a source profile name is only a label and never a usable ID.

Credentials, browser profile/session bytes and foreign grants remain excluded.
Source suggestion transport and destination mapping exist in backend; the web
owner must implement the actual review and Settings calls. Source restrictions
cannot automatically elevate destination Chat policy.

### Organization scope

Organization export calls `listAgentSubtree(root.id)`. Canonical parent and ancestor
invariants require one Chat, and one package topology has one root. Therefore a
valid current organization export cannot contain multiple independent Chat roots.
Import retains source Chat identity as historical provenance and binds that one
within-Chat tree to the explicitly selected destination Chat. Multiple independent
Chats require separate exports/imports and explicit destination Chat creation.
No cross-Chat reporting, deletion, context authority, or scheduler ownership is
introduced. Cross-Chat historical references remain historical source data.

### Recorded audio originals

The shared asset media union/admission now recognizes audio/webm (Opus, `.webm`),
audio/ogg (Opus, `.ogg`) and audio/mp4 (audio MP4, `.m4a`/`.mp4`). Container signature,
codec markers, extension and declared content type must agree. Ogg pages and MP4
box lengths are bounded; WebM checks its document/Opus markers and rejects known
video codec markers. This is container admission, not a full codec decoder or an
audio-quality verdict. Existing size budgets, immutable hashes, ownership, staging,
reload and export paths remain shared. Previously admitted opaque recording originals remain downloadable with their stored octet-stream media type; new audio admission does not orphan their bytes. No transcriber, provider HTTP client,
auto-play or implicit execution is introduced.

### Shared package-engine access review

`BranchPackageEngine` is exported by `routes/agent-packages.ts` as the shared
packaging contract. `reviewAccess(pkg, chatId)` returns
`Promise<AgentAccessImportReviewDto>` without canonical writes. It validates the
package and actual destination Chat, including deletion admission, and uses the
same hash/policy helper as HTTP access preview and import. A newly created Chat
must exist before its policy can be reviewed; callers must not fabricate a hash
from a pre-creation Chat reference.

`importAgent(..., options)` accepts `BranchPackageImportOptions`, retaining
`signal` and `branchHooks` and adding `accessSettingsResolution`. The wrapper
forwards that explicit choice to the normal validated importer. Review-required
or stale-review 409 errors preserve `accessSettingsReview` on the thrown
`BranchPackageImportError`, alongside `statusCode` and `provisionRejected`.
Non-access errors do not acquire a fabricated review. No choice or permission is
automatically adopted. Branch installation owns durable human review, per-target
mapping, status/routes and retry decisions; those caller files are unchanged here.

### Organization working-root bundles

Full GET Agent export accepts `organizationWorkingFolders=true` (combine with
`organization=true` for a subtree). Every included Agent declares an opaque
`workingRootRef`. Resolved source root paths identify shared membership inside the
export only; absolute source paths are not published. Each distinct root has one
owner node containing its folder manifest and regular-file originals, including
empty directories, ordinary modes/mtime and excluded-path disclosure. Other nodes
reference the same identity without duplicating bytes. This includes child Separate
Git changes absent from the destination repository's common snapshot. Existing
selected-file and `wholeWorkingFolder=true` root-only export remain available.

Import requires `workingRootDestinations: Record<workingRootRef, absoluteNewPath>`
covering exactly every identity; legacy `workingFilesDestination` cannot be mixed.
Destinations must be distinct and cannot nest. The existing new-only writer refuses
existing paths and preserves partial or previously completed roots on failure. The
durable operation records the entire mapping before its first folder write; errors
name retained locations. JSON/staged import forwards and hashes the same mapping.
Success returns `workingRoots: [{ref,destination,agentIds}]`, preserving the exact
shared-source relationship using fresh destination Agent IDs. These are explicit
retained-content destinations, not foreign execution authority.

Live root assignment remains constrained by existing canonical services: Shared
Agents use exactly `Project.hostPath`; Separate Git Agents require fresh managed
worktree roots, branch receipts and cleanup ownership. Bundle destinations do not
rebind these roots. Recreating modes from a destination Git snapshot does not copy
source uncommitted/ignored work. Thus this transport closes omission of child folder
bytes and records their memberships, but automatic live use of the restored folders
is **not implemented**. It needs a destination Project/root creation or reviewed
copy-into-fresh-worktree service that can preserve conflicting user content and
mint native ownership locally. Credentials, Git/native/session ownership remain
excluded; UI must disclose exclusions and the retained-content/live-root distinction.

The Branch shared engine exposes optional `BranchPackageExportOptions`:
`organization`, `selectedWorkingFiles` (readonly relative-path array),
`wholeWorkingFolder`, `organizationWorkingFolders`. Omitted options preserve the
single-Agent legacy export. `BranchPackageImportOptions` forwards
`workingFilesDestination` and `workingRootDestinations` alongside the existing
reviewed capability resolution, signal and hooks. Its result remains the complete
`ImportAgentPackageResponse`, including `workingFilesDestination`, `workingRoots`
and `accessSettingsToReview`; the wrapper does not project those mappings away.
Folder-retention errors retain their importer error text with destination locations.
Callers must persist explicit human destinations/review and disclose that these are
retained-content locations, not automatic live working-root assignments.

### Explicit live working-root activation (supersedes the content-only limit above)

Import and `BranchPackageImportOptions` accept optional
`workingFilesActivation: {sharedRoot?:string}`. Omission retains content-only
behavior. Recovery destinations (`workingFilesDestination` or the complete
`workingRootDestinations`) are still required, and must be NEW folders separate
from the actual live Shared folder. Source originals are restored there first.

For Shared Agents, the operator first creates a NEW managed Chat using existing
`POST /api/chats` / `createChat` with `createFolderName`, then explicitly confirms
that Chat Project's exact `hostPath` in `sharedRoot`. Import requires its canonical
managed creation identity, no existing Agents and an empty canonical directory.
It initializes a local empty Git baseline with hooks/signing disabled; existing
repositories or user roots cannot pass this admission. This permits mixed Shared
and Separate Git imports into a fresh Chat without adopting source Git history.
Separate-only activation can use an existing destination Git Project: the service
creates fresh managed worktrees using its normal locally minted receipts first.

Only after canonical Agent/worktree creation does the existing mode-change fence
populate each live root. `liveWorkingRoots: [{ref,path,agentIds}]` in the response
and durable operation identifies actual ordinary Agent working directories. Shared
members see the same populated Project root; Separate Git identities remain distinct.
Mode choices that split a shared bundle or merge distinct populated roots refuse.
The importer preserves any displaced destination-baseline regular file in that live
root's exclusively created `.ponderosa-import-backups`, with a `.path.json` sidecar
mapping its random recovery filename to the original relative path. This native
recovery folder is excluded from future package export. Files are installed with
exclusive creation after displacement; a racing writer cannot be overwritten by
that installation. Failure retains recovery copies, displaced bytes and live roots,
with locations in the durable receipt/error; no recursive user-file cleanup is added.
Git history, symlink topology, credentials and source native receipts remain excluded.
UI/Branches callers must explicitly select activation and fresh Shared Chat creation;
there is no silent activation or modification of an existing Shared root.
An all-Separate-Git import into a NEW empty managed Chat may likewise confirm
`sharedRoot` to initialize its fresh repository; omitting that confirmation for
Separate-only activation expects an already initialized destination Git Project.

Grouped within-Chat organization imports use the same one-operation live activation
and shared root; the shared importer accepts the complete organization topology.
For independently reviewed per-Agent capability choices,
`accessSettingsResolution` also accepts `agentActions: Record<portableNodeRef,
'keep_destination'|'use_source'>`. When present it must cover exactly every node
with source `accessSettings`; unknown/missing refs refuse before writes. Existing
`action` remains required and backwards compatible. Each explicit node choice
controls only that newly created Agent's restrictions. `reviewSha256` MUST come
from review of the complete grouped package and actual destination Chat; separate
single-Agent package hashes cannot be combined or reused. Destination policy is
rechecked before atomic commit. Grouping and durable per-Agent human reviews,
actual new-root confirmation, cancellation/staleness admission remain Branch caller
responsibilities; there is no automatic blanket permission or live root adoption.

### Branch grouped package composition

`BranchPackageEngine.composeAgents(inputs)` is an async, mutation-free deterministic
helper. Inputs are `readonly {ref:string,managerRef?:string,package:
AgentPortablePackageDto}[]`, each a validated single-Agent package. Returns
`{package,orderedRefs,artifactRefs,workingRootRefs}`. Output node refs are the exact
caller logical refs; supplied managers are preserved. `rootRefs` explicitly lists
independent same-Chat roots when necessary; no invented manager edge or cross-Chat
reporting authority is introduced. `rootRef` remains the primary result root.
Import processes every declared root and returns `agentRefs:Record<sourceRef,
freshAgentId>`; `agentIds` and Branch hook planned IDs follow `orderedRefs` (input
order). Existing hook plan receives one creation operation ID for the entire group.

Artifacts get deterministic per-logical-Agent namespaced refs, including role/preset
links, historical text/attachment/explicit artifact binding values and working-file
links. Historical authored Communication IDs/scope are unchanged. Original history
messages and uploaded originals stay with their source node, including duplicates.
`artifactRefs[logicalRef]` exposes each old-to-composed artifact binding.

Canonical Shared mode plus the same explicit source Chat identifies one Shared
source root even if separate exports generated distinct opaque root refs. Its selected
files/directories are unioned. Same relative path with different original bytes,
modes or timestamps, or conflicting root/directory metadata, refuses and requires a
coherent re-export. One owner holds the combined working manifest; originals needed
from another node are copied with a distinct binding rather than stealing that
node's historical attachment. `workingRootRefs[logicalRef]` supplies the final root
identity for NEW recovery-path controls. Distinct Separate Git roots remain separate.
Missing source Chat identity does not infer Shared sameness. Every distinct root
has a manifest if folder transport is present, including empty roots.

Compatible source Chat memory snapshots merge by original Chat/signature and
source Agent mappings. Identical team rows deduplicate by exact row identity;
conflicting rows or one source Agent bound to multiple logical Agents refuse.
Private rows retain source audience/identity and their exact Agent bindings. Full
validation reruns on the merged package, including aggregate byte/row limits.
Different package modes, Chat instructions, source Chats or embedding signatures
refuse rather than discard intent. Grouped staged memory verification now maps
source refs using the receipt's complete ordered Agent IDs, instead of assigning all
memory to a singleton Agent.

Caller must compose BEFORE reviewing access; one complete-package review hash plus
exhaustive `agentActions` holds independent human choices. Persist the composed
package/mapping and ONE receipt; cancellation/staleness/actual-created-root review
remain caller responsibilities. Do not reuse separate package review hashes.
