# Held execution-tree DATA recreation

Source-only successor to 553122dcb0d1bd54ce3825ffa744bee224536378. This is
implementation through the existing exporter, reviewed installation composer,
final publication transaction and receipt reader. It is not runtime qualification
or authority to execute an imported checkpoint.

## Caller contract

The existing full package exporter adds `InstalledBranchPackage.executionTree`
(schema `ponderosa.branch-runtime-tree.v1`) when the selected workflow graph has
execution owners. `definitionTree` still carries all current Branch definitions,
configuration, binding pins, package identities and final Chat ownership. Its
package hash binds the ENTIRE flattened package, including execution-tree bytes.

Export closure follows current definition dependencies, exact historical owner
Call definition/binding targets, and both sides of actual parent/child ownership.
Visited Branch identities handle cycles/shared dependencies; every owner in each
included Branch is retained, including terminal children and independent roots.
An omitted parent, aliased Call attempt, malformed edge, ancestry cycle or
unavailable dependency pin refuses; it cannot silently truncate source data.
Rosters, configurations, selected owner frontiers and all retained private facts
are recaptured around awaited Agent exports and custody reads across the WHOLE
graph. A moving source refuses rather than returning a mixed cut.

Each per-Branch runtime-data envelope reuses the standalone fact codec (empty
owner arrays are allowed only inside a validated tree, so template-only Branches
still contribute EVERY original native Chat/Agent identity): exact
historical definition/binding/configuration pins, selected local frontier,
original input/provenance, saved checkpoint byte strings/hashes, transition and
command journals, host facts and retained custody packages or explicit unavailable
receipts. Every template and execution-owned Chat/Agent remains in the existing
portable Agent composer inventory. Credentials remain excluded; original checkpoint
bytes containing credentials refuse. Missing/erased bytes are never manufactured.
Existing standalone non-Call packages retain their old envelope and behavior.

Preview uses the existing `treeBindings` for EVERY source Branch. In addition to
the definition/destination `definitionTreeReview.reviewSha256`, it returns
`runtimeDataReview.manifestSha256` and every private tree fact as a review operation.
Confirmation requires BOTH `acknowledgeDefinitionTreeSha256` and independent
`acknowledgeRuntimeDataSha256`, plus the existing full-context acknowledgment.
Per-Agent access/files/working-root/output-role review remains in the same composer.
No UI is assumed. The SDK's existing runtime-data GET now returns a schema-discriminated
standalone-or-tree readback union; tree data uses `data.branches`, not `data.owners`.

## Native publication and supported families

The private plan persists all execution identities and ALL local frontier identity
reservations before asynchronous staging. Reserved IDs for an evidence-only leaf
are explicitly not claims that those rows exist. Replays/restarts reuse the maps.
Current disabled definitions/dependencies are published in the existing final
SQLite transaction. Owners are topologically inserted; each supported parent's
canonical frontier is inserted through `remapBranchFrontier`/`insertBranchFrontier`
BEFORE any child needs its actual fresh parent attempt foreign key.

Original Call validation checks the pinned parent definition, exact parent Step
and attempt, original binding target, original occurrence/input hash, source
provenance, call depth/ceiling and terminal-child output/state relationship.
Fresh children use REAL mapped `parent_execution_id` and `parent_attempt_id`,
`call:<fresh attempt>` occurrence keys and the canonical hash of fresh parent
attempt plus input. Original hashes and ancestry remain unchanged in private facts.
No fake Request or source process/lease/grant is inserted.

An exact-definition, nonsecret, effect-free frontier accepted by the existing
shared Script/parallel frontier codec receives native rows labelled `recreated_held`.
This includes supported manual Call parents, supported Script children and terminal
children. Counters, nonsecret original owner configuration and call-depth ceilings
are preserved. An unsupported/unknown/issued/resource/automatic/historical-definition
LEAF receives a fresh held native owner linked to its REAL supported parent attempt,
while all original frontier/private facts remain `evidence_only`; it receives no
invented paths/Steps/attempts/resources. Unsupported parents with children REFUSE
preview before staging because their parent attempts cannot be invented. There is
no claim that every frontier permutation is supported.

Cross-owner result-bundle forwarding/native bundle references remain unsupported:
parents requiring that family refuse before staging; unsupported leaves retain
facts without a native frontier. A forwarded child input differing from its exact
original parent Step cannot pass the current strict original-Call validator.
Historical missing/deleted Branch targets, credential-bearing checkpoints and
existing size/nesting limits also refuse explicitly.

All imported owners have `portable-runtime-data` command holds and private
`portable_runtime_data` provenance. Existing reducer/claim/intervention/checkpoint
promotion guards apply to EACH owner and ancestor, including if a workflow is later
enabled. Owners remain waiting; no fresh acceptance, execution-budget admission,
Run, Request, lease, native process adoption or dispatch is created. Source terminal
state is retained as data, not reported as a new successful execution.

The last-owner/manifest failure rolls back all final Branch versions, bindings,
dependencies, execution owners/frontiers and Chat/Agent resource promotions together.
The existing disabled blank root/staged composer resources remain recoverable.
Deletion, retention, precleanup and Git/configuration/file transport are unchanged.
The private manifest lives in the existing command journal, not a new archive.

## Readback and re-export

Confirm and installation status add `runtimeTreeReceipt`; the existing
`GET /api/branches/installations/:id/runtime-data?branchId=<fresh root>` returns the
complete private tree manifest and receipt. Readback verifies manifest bytes/hash,
exhaustive native owner inventory per Branch, source-to-fresh maps, actual canonical
Call FKs/definition/binding/input identities, fresh pins, complete recreated
frontier rows, source counters/configuration, participant ownership, held provenance
and absence of acquired admission/leases/Requests. Evidence-only leaves must have
NO native frontier rows. All Branches/triggers must still be disabled; later edits
or enabling cause current integrity readback to refuse.

Held tree re-export first verifies the saved native receipt, then includes each
complete original private manifest/receipt in a `tree-import` fact. Validation
recursively checks original-to-native owner/Branch/pin/ancestry mapping, original
input and no-acceptance provenance. Re-import keeps these source generations as
private facts and uses fresh identities again. Original terminal state is consulted
only to validate the copied held frontier; native owners remain held waiting.
Nesting/payload bounds refuse excess rather than silently dropping generations.

## Deferred fixture source and remaining work

`tests/branches/execution-tree-publication.test.mjs` builds original Calls through
canonical source owner APIs and inert Script settlement, then uses ACTUAL server
export -> per-Branch preview -> existing Agent composer -> confirm -> receipt GET.
It includes two distinct parent Call attempts, a terminal first child, distinct
child definition/configuration/directory, template and execution-owned Chats/Agents,
unknown leased second-child evidence, persisted-map restart, replay/readback restart,
held re-export/re-import, native claim refusal even after enabling, actual preview
refusal of a changed-definition parent before staging, original-edge corruption
refusal, native-edge corruption
refusal and last-execution-owner transaction rollback. SQL only observes native data
or injects corruption/failure; it does not manufacture original foreign execution
rows or bypass the import caller. The older definition-only fixture is updated for
the now-supported presence of a runtime manifest.

These fixtures are SOURCE and have not run. No tests, checks, builds, types,
Node/native/provider/browser execution, runner preparation, installation, migration,
push, deployment, new workers or web writes were performed. No runtime qualification
or full Bible #8 completion is claimed.

Remaining consumers/families: runnable foreign selected-checkpoint continuation
still needs current human review, real fresh acceptance, budgets and current custody
reconciliation; no data receipt supplies these. Issued/resource/unknown or changed
historical-definition parents, native automatic frontiers and cross-owner bundle
families need additional supported canonical consumers. External restoration/artifact
proof expansion and erased/unavailable source bytes retain their earlier explicit
dispositions. Current source APIs/SDK are usable code contracts, not executed proof.


## Explicit checkpoint continuation after DATA import

A separate reviewed consumer now supports effect-free sync/async and proven closed EXIT
Script/Call selected owner trees. See `branch-foreign-checkpoint-continuation.md`
for its exact family and refusals. DATA publication/readback remains held and
requires disabled unchanged destinations. Explicit enablement does not admit any
held owner. Continuation separately checks immutable import/native evidence,
reviews every current destination and allocates fresh acceptances, Call provenance,
admissions and remapped frontiers in one transaction. Original DATA stays held.
Supported held re-exports and admitted continuation generations retain the exact
root command, reviewed receipt, held manifest and all-owner remap proof. Shared
canonical replay checks prior selected/latest trees and genuine later Call children;
held-only generations are validated separately and never treated as admission.
Re-export checks immutable held evidence even after current enablement and fresh
continuation owners; the ordinary disabled DATA readback contract is unchanged.
Tree proof is bounded to 16 nested links, 32 MiB manifests and 128 uncached
manifest/replay frames per traversal. Unproven local rewind and issued/unproven-EXIT/resource/
unknown combinations remain outside this consumer. This change has source review only, with no runtime
round-trip or rollback qualification.

Serial and parallel workflow approval gates are supported in the manual sync/async or proven closed EXIT effect-free
foreign Script/Call consumer, including root gates before the first Call, completed
selected decisions, newly mapped pending decisions and later suffix gates. Each
owner review separates selected/latest gate evidence; fresh pending notifications
belong to fresh destination owners. Existing bounded held/admitted generation
proof and atomic owner restoration apply. Parallel canceled gates require exact
canonical path/Join cancellation evidence; a child outcome never supplies it.
Original-key recovery of later gate cancellation replays the current destination
tree and requires a supported quiescent frontier.
Canceled serial and recovery-purpose gates remain unsupported. See the foreign continuation guide for
the exact scope. Live notification delivery and rollback remain unqualified.

Supported manual sync/async or proven closed EXIT Script/Call trees, including ordinary approval gates, may also migrate after a
local historical rewind. Existing private snapshot/command/acceptance facts retain
the original source checkpoint and authentic root/child lineage. The same canonical
composer uses bounded retained readers, independently replays selected/latest source
trees, verifies complete maps, pins and ancestry, and refuses erased or changed
proof. Held and admitted migration generations can retain these links without
converting held data into authority. Terminal prefix children do not acquire
invented admission; genuine suffix children keep normal Call provenance. Selected
pending gates stay pending, prefix decisions remain historical, and fresh mapped
notifications belong to fresh owners. Gate-bearing links require exact rewind seeds
and independently replayed selected/latest proof. Recovery gates, unproven lineage
and effectful/issued/resource/automatic/unproven-EXIT combinations remain
unsupported. See the foreign continuation guide; no runtime qualification is claimed.


## Saved async tree cuts

Portable continuation also supports mixed sync/async manual effect-free Call
trees while preserving each exact configuration, including an omitted native
async default. The complete selected root checkpoint must match retained committed
bytes and hash. Each selected async child must separately match a committed saver
snapshot's selected inventory, invocation identity, mode and closing flag. A
pending child save is not covered merely because the ancestor saved. Child
snapshots may be non-restorable on their own; the root tree proves their Call
context, exact audit, pins and lineage. Full latest-tree replay remains independent.

The same source proof is used after supported local rewinds and retained held or
admitted generations. Fresh all-destination review/admission, destination-owned
gate notifications and per-owner mode-aware saver/readiness rules are unchanged.
Original-key cancellation recovery still requires complete causal tree replay at
a supported quiescent frontier. Missing matching child bytes and recorded async
save failures refuse; no mode conversion or pending-write acknowledgement is
invented. Async timing, durability, round trips and scheduling remain unvalidated.


## Saved closed EXIT tree cuts

The shared consumer accepts closed EXIT owners in heterogeneous manual effect-free
Script/Call/ordinary-gate trees without mode conversion. Every selected EXIT owner,
including the root and terminal historical children, needs its own exact committed
closing saver bytes/hash, selected inventory and invocation identity/mode. Complete
root tree bytes retain original invocation ordinal/outcome and interruption or
gate-close evidence, with normal canonical state/control/Call/process-exit replay.
An ancestor save cannot acknowledge a missing or pending child save. Nonrestorable
child saver observations prove only saved inventory; the complete root proves
context and ancestry.

Latest replay independently reconstructs the actual whole current tree. Every EXIT
owner's exact current inventory, audit, pins/configuration and original invocation
must occur in a retained committed complete root tree checkpoint, and must match
its own closed saver snapshot. It cannot be inferred from an older different cut
or process absence. Terminal children can qualify. Newly captured supported
terminal root trees retain complete immutable `latestOnly:true` tree observations
in the existing saver row, always with `restore_supported:false`. Freezing reuses
canonical terminal replay without requiring its own pending save; later latest
proof requires the actual committed bytes/hash and every EXIT owner's own matching
closed save. These observations never qualify for selection, confirmation, admission
or local rewind; only an earlier genuine supported cut can execute. Old terminal
observations without the complete codec still refuse and are never backfilled.
Sync/async latest ancestors retain normal terminal support when every EXIT child
has the required evidence. Original local rewind and held/admitted links use this
same proof and existing bounds; missing latest codec evidence remains a refusal.

Fresh current all-destination review/admission and per-owner saver/readiness remain
in place. Destination invocations and gate notifications are fresh; imported
interruption identities remain evidence. Local historical terminal children keep
actual nonadmission, and genuine unfinished/suffix Calls require admission. Later
copied-gate cancellation recovery requires complete current causal tree replay;
each current EXIT owner must match its actual saved closed invocation and saver
snapshot. Active, pending, failed, unknown and unsupported cases refuse. See the
foreign continuation guide for exact limitations. No timing/durability, notification,
round-trip, scheduling or rollback execution was performed.
