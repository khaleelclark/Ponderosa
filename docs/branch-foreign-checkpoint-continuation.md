# Foreign selected workflow continuation — source tranche

Source only, unqualified. No test, type, build, Node, native, browser, provider, installation preparation, migration or deployment command was run for this tranche. The deferred fixture must pass after the execution hold is lifted before runtime behavior can be claimed.

## Supported caller flow

The existing full package exporter, reviewed installation preview/confirm and runtime-data GET first recreate a private standalone held data owner. Its receipt supplies no acceptance or execution authority. Preserve that installation receipt and original manifest; set current destination settings to the selected source configuration (including its exact checkpoint mode; omitted mode retains the native async default) using existing settings GET/PUT, then enable the current destination explicitly using the existing availability action. Standalone import does not itself adopt the source checkpoint mode.

On `/api/branches/:id/executions/:executionId/foreign-continuation`, `executionId` is the imported held owner, not the original foreign owner:

1. POST `/review` with `{planId,sourceExecutionId,checkpointKey,checkpointSha256}`. The checkpoint key/hash identify an exact original private `checkpoint` fact in the imported manifest. Review returns the private selected checkpoint, original manifest/owner hashes, exhaustive import maps, current destination version/binding/configuration and configuration revision, current effective capability policy with persisted revision records and execution budget, resolved directory paths/device/inode, and explicit `current_destination` access, `node` engine, `none` secret choice and `not_applicable` custody.
2. Human POST to the base path with the same selection plus `{commandKey,reviewSha256,acceptCurrentAuthority:true}`. A review digest includes all fields above except the budget observation timestamp. The handler inherits existing operator-only authentication; Agent capability tokens cannot use it.
3. GET the base path with `?commandKey=<original key>` retrieves the original immutable command receipt. Repeated identical POSTs after a lost response/restart return that same receipt and IDs. A changed original command conflicts. GET never accepts, admits or creates a review.

SDK methods: `reviewForeignContinuation`, `continueForeignCheckpoint`, `foreignContinuationReceipt`.

Current choices are established through the existing destination configuration/bindings and capability controls before review. This first cut deliberately requires current nonsecret parameters/limits/checkpoint mode and definition to match the selected source checkpoint exactly. Destination directories can differ; review resolves and checks current directories again on confirm. No source Agent access, engine credential, secret, resource, provider/browser state or filesystem restoration claim is adopted.

## Authority and atomicity

Standalone manual, sync/async or proven committed closed EXIT-mode, effect-free Script/human-gate definitions with declared JSON state (`sum`, `append`, `replace`) and existing `condition`/`route` and canonical fork/Map/Join controls are accepted, along with the proven automatic-source standalone Script/approval-gate subset described below. Workflow failure policy must stop. Per-step policies also stop, except canonical Script retries in manual standalone serial or parallel graphs and proven automatic-source standalone serial or parallel graphs as described below, plus the manual serial/mixed and proven automatic-root serial/parallel Call-tree successors below; secrets and other control families remain excluded. Selected and latest exported source cuts must have no issued Requests, resources, custody facts, actions, bundles, recovery-purpose gates, pending process outcomes or execution-owned Chats. The selected and latest source cuts must each pass the existing Script frontier and full audit replay, including exact original definition/binding pins, input, state-seal settlement order, condition/route choices, fork and Join selections, Map inventory/order/bounds and traversal/loop counters. The selected cut must be resumable: running, or canonically waiting for supported parallel work, a proven prepared retry or a workflow gate. For sync/async the latest cut may be running, canonically waiting or canonically completed/failed; EXIT additionally requires an exact committed closed latest frontier as described below; both cuts must remain effect-free and pass full replay. Missing or corrupted evidence refuses before fresh acceptance. The only shared replay extension supplies retained immutable owner/audit evidence instead of querying nonexistent foreign database owners. It is restricted to effect-free Script cuts with independently validated retained generation links and returns only a validation result, never authority. No foreign rows or fake Requests are inserted to satisfy validation.

The preview independently verifies the actual recreated-held imported native frontier/maps/participant ownership through existing runtime-data readback. It checks the imported owner remains waiting/unaccepted, current destination availability/pins/configuration/policy and accessible directories. Any unknown custody or native authority on the held owner refuses. `not_applicable` means no selected/latest source or native resource exists; it never means an unavailable receipt was treated as released.

Confirm recomputes that exact review in the existing immediate owner transaction. It calls existing `acceptInput` with a fresh manual occurrence/provenance, `hasRunnableCapacity` and canonical `BranchExecutionBudgetAuthority.admit`. Manual acceptance retains the existing manual budget exemption; admission still writes a fresh current-policy receipt. This tranche does not create a new budget system or silently charge a manual continuation as automatic work.

The same `remapBranchFrontier`/`insertBranchFrontier` writer used by canonical historical continuation allocates new local IDs, inserts/verifies the selected prefix, restores counters and records the actual fresh admission/start. Completed prefix work is data and is never scheduled again. Only the new owner can schedule the uncompleted suffix under normal current lease/policy checks. No Request, native lease, acceptance, admission or process identity is copied from the source. No source effect is settled, source retired, custody released or pin released.

The original held owner row, frontier, import command, original manifest and private facts stay unchanged. A new namespaced command receipt is attached to that owner for ordinary deletion/retention semantics. It binds original imported evidence to the fresh acceptance/admission and local ID map. Last-receipt failure rolls back acceptance, admission, native frontier, counters and receipt together. Replay/status validates the saved receipt, original imported data and real fresh acceptance/admission without requiring unchanged *current* policy after a successful command. Existing import re-export remains data-only. Supported running continuation generations produce restorable Script checkpoints through the same local lineage walker.

## Deferred verification and remaining scope

`tests/branches/foreign-checkpoint-continuation.test.mjs` uses actual full export/import/review/continuation/status HTTP callers and canonical inert source APIs. It covers different destination directories, persisted private checkpoints, restart between review and confirmation, fresh manual admission/current budget revision, exact held-owner preservation, remapped completed prefix, only suffix leasing, lost response/replay/restart, stale budget/policy/directory refusal, unknown latest source/native custody, command conflict, and final-receipt rollback. SQL observes rows or injects corruption/failure only; it does not fabricate source acceptance/frontier or destination admission. The state/control extension adds no fixture or test preparation under the source-only instruction; no runtime qualification of that extension is claimed.

Remaining beyond the supported Call-tree family described below: unproven automatic frontiers and automatic Call trees outside the proven root-only family below; issued/unknown/resource/bundle/Agent frontiers; EXIT trees without the closed saved proof described below; secret choices; recovery-purpose gates; changed historical definitions/configuration; execution-owned Chat continuation; external file/artifact restoration proofs. These paths refuse explicitly before fresh acceptance. Existing tree DATA recreation, standalone held import, composer, deletion/retention/precleanup and Git/config transport remain unchanged. This is no whole-portability, all-family or runtime qualification claim.

## Saved continuation recovery in the UI

Reopening the standalone continuation panel automatically looks up the original saved command through the existing receipt GET. A verified result offers the fresh execution link without copying browser-storage entries or pasting receipt JSON. Detailed receipt data remains inspectable. A missing receipt or connection error stays visible; it does not trigger another acceptance request or create a replacement command. Refresh saved result repeats only that read.

Read-only lookup remains available when the exact original command is already in memory, even if browser storage becomes unavailable. Fresh acceptance still requires successful storage and readback before POST. Unreadable or invalid saved commands block fresh acceptance; the UI never reconstructs their keys. Changing the viewed owner clears old review, consent and receipt state, and ignores responses from the previous view. Existing exact receipt/import-map checks, supported-family restrictions and unknown-effect refusals are unchanged.

This UI change is source-only and has not been run, built or typechecked.

## Selected state and routing continuation

The same export facts/private checkpoints, reviewed held import and runtime-data readback carry state seals and condition/route/fork/Map/Join frontiers. No extra import format, endpoint, acceptance system or mutable state store is introduced. Source definitions are canonically validated; current definition and nonsecret configuration must still match exactly. A selected cut can stop before or after a supported control, or at an unstarted Script invocation. Unknown, issued, resource, recovery-gate, unsupported automatic, bundle and secret families remain refused by this standalone consumer; the separate Call-tree family is described below.

Human review includes the declared channels/reducers, selected state projection and latest saved source projection, each with revision and evidence hash, plus the actual control definitions. These fields join the existing review digest and are rechecked atomically on confirmation. The UI shows which state revision will resume and reveals the values/reducers and control definitions for review. A later saved state is evidence only; continuation resumes the selected state, never the latest state by accident.

Canonical replay verifies each original immutable result seal and its state revision in actual settlement order, applies the existing reducers and verifies Script lease state hashes plus routing/loop evidence. The existing frontier remapper changes native identities while retaining canonical result bytes, state updates, seal hashes and selected counters. Before transaction completion the new owner’s state must equal the selected projection. Prefix writes are not settled again: normal suffix settlement allocates the next revision from the retained seals.

Original-key receipt GET checks every mapped prefix seal’s ownership, result and content hash. It recomputes the retained prefix state against the reviewed selected projection, and validates the current new-owner state without requiring it to stay at that old revision after legitimate suffix progress. The held original/native import still passes strict readback. All checks run within the existing confirmation transaction; any state/seal/receipt mismatch rolls back fresh acceptance, admission and frontier writes together. Saved-command lookup and storage-before-POST behavior are unchanged.

Source inspection only: no tests, test preparation, builds, typechecks, runtime/native capture or live database actions were performed for this extension.

## Re-exported Script generations

Full export now retains a continuation fact for each foreign-continuation owner:
the exact original command receipt, its original imported manifest, and the
existing accepted owner's admission timestamp/JSON. It also retains the actual
imported owner and its original command/import facts; a detached or incomplete
continuation fact is refused. These private facts supply evidence, not execution
or native-process authority. Original bytes and ID maps are never flattened or
rewritten. No foreign operational database rows are inserted for validation.

Held imports can be exported/imported repeatedly. The existing continuation
picker follows the retained import chain to display the original private
checkpoint choices. The server independently checks every held mapping against
the shared frontier remapper, immutable pins, configuration and counters. Review
includes `generationChain` manifest/owner identities in its existing digest.
Selected and latest source frontiers are independently replayed; a later state
revision cannot replace the selected revision.

The existing `composeScriptCut` walker now reads retained private facts as well
as local snapshots. Historical-rewind links still require their original snapshot,
command receipt, exact ID map, pins and audit. Foreign-prefix links require the
original reviewed command, import receipt/manifest, real fresh admission evidence
and complete source chain. Only then does the existing Script replay accept a
seeded prefix. State seals and reducer revisions are checked in settlement order;
restoring a prefix does not settle it again. Fresh confirmation still uses the
current destination review, acceptance/admission and immediate transaction, and
schedules only the unfinished suffix. Original-key receipt GET verifies the
retained source chain and mapped seals without requiring unchanged current policy.

Retention bounds are explicit: the existing 32 MiB manifest limit remains, nested
import/foreign chains and each retained rewind chain are limited to 16 links, and
one portable validation permits at most 128 uncached replay frames. Missing,
changed, corrupt, cyclic, ambiguous or oversized evidence refuses continuation.
Unsupported chains may remain imported as evidence-only data; this grants no
continuation authority. Parallel tree/gate combinations, issued/Agent/resource/automatic/unknown,
recovery-gate/bundle/secret, changed-definition and external-file-proof
families remain excluded from this standalone continuation path.

Source review only. No tests, new fixtures, test preparation, Node, build,
typechecking, runtime/native/browser/provider work or live database access was
performed for this extension. The earlier uncertain operation is not settled or
replayed by this successor work.

## Parallel, Map and Join continuation

The standalone consumer also accepts the effect-free Script subset of the existing
parallel graph codec. It uses the same definition, frontier and full audit replay
validators as local continuation; repeated-generation lineage validation is
unchanged. No alternate graph replay or foreign database authority is introduced.

Selected cuts may precede a fork or Map, retain an open fork with completed arrivals
and unfinished paths, retain a sealed Map with undispatched or partially settled
items, or follow a completed fork/Map/Join while another eligible suffix remains.
Empty Maps are supported only when canonical audit proves their item seal and
Join resolution. Selected owners must remain resumable (running or canonically waiting); latest
owners may be running, canonically waiting or canonically completed/failed. Cuts between required arrival, item-seal,
item-settlement or loop observations are refused by canonical replay. Active
Script processes, unknown outcomes, unproven automatic-source retries, recovery-purpose gates, issued work, resources,
bundles and other excluded families remain unsupported.

Fork/path ownership, ordered selected Join arrivals, Map identities, item indices,
input hashes, dispatch order/concurrency bounds, loop counts and state-seal
settlement order are replayed from original evidence. Fresh Map item IDs retain
the existing remapper's `<new Map ID>:<original index>` rule. Restoring a prefix
copies its exact sealed item inventory and dispatch markers: completed items are
not expanded or dispatched again, resolved Joins are not resolved again, and
completed branch/item reducers are not applied again. Only unfinished eligible
paths/items proceed through the normal scheduler under current destination
acceptance, policy, directories and admission.

Original-key receipt recovery verifies mapped control ownership, immutable Map
inventory and item content, settled Join choices/arrivals, terminal paths and
prefix state seals. Open controls, dispatch markers and loop counts may advance;
settled prefix evidence cannot change. These checks allow later legitimate suffix
progress without demanding the destination stay at its selected checkpoint.
The existing runtime-data, Shared/export/import, review digest and full retained
lineage carry the same control rows; no additional format or endpoint is needed.

Source-only extension: no tests, fixtures, test preparation, builds, types, Node,
runtime/native/browser/provider or live database checks were performed. Parallel
round trips and failure rollback still require execution qualification.

## Human workflow gates

The same standalone consumer supports canonical `human_gate` nodes in serial and
parallel Script workflows. Selected and latest cuts independently replay gate
ownership, approval purpose, prompt/proposal, choices, editability, revision,
response, routing and state seals. Waiting and resolved gates are supported;
parallel canceled gates require the existing cancellation audit. Recovery-purpose
gates remain refused. Gate decisions control workflow order, never host access,
capability grants, native consent or recovery approval.

Review includes separate selected and latest gate projections in its digest.
The UI exposes selected decisions and pending prompts/choices. A later source
approval cannot approve the selected pending gate. Resolved selected decisions
and sealed results remain historical data restored once; their command keys are
not inserted into the fresh execution's command table. Foreign notification IDs
and open command authority are never copied.

Each selected waiting gate gets a new mapped destination identity and a new
pending notification through the established local restoration flow. It requires
a fresh normal gate response against that destination gate and revision. Gate
resolution uses the same shared choice/edit/decision validation as audit replay.
The fresh owner remains waiting when no path is active; eligible parallel paths
retain their normal running state. Waiting gates block dependent Script work
through the existing scheduler rules. Acceptance, admission, notification rows,
frontier restoration and final receipt share the existing rollback transaction.

Original-key receipt GET verifies immutable gate identity, prompt, proposal,
choices and purpose. Settled selected responses/revisions cannot change. A
selected waiting gate may later resolve only with its actual destination command,
resolution key, gate audit and sealed settlement; cancellation requires its exact
audit and canceled work. Notification ownership/state is checked too. These checks
permit legitimate suffix progress while rejecting changed evidence or aliases.
Repeated-generation export/import and Shared transport retain gate evidence using
the same bounded lineage and frontier format. Saved-command storage-before-POST
and read-only receipt recovery are unchanged.

Source only: no tests, fixtures/preparation, builds, types, Node, runtime/native,
browser/provider or live database actions were performed for this extension.
Waiting/resolved/canceled round trips, notifications and failure rollback remain
unqualified until execution checks are authorized.


## Foreign Call trees and repeated generations

The existing foreign checkpoint review/confirmation/original-key receipt flow also
accepts supported `ponderosa.branch.script-tree-continuation.v1` cuts from
held execution-tree imports. Supported owners are manual sync/async or proven closed EXIT, quiescent,
effect-free Script/Call workflows using the canonical state/control/tree codec.
The selected root must remain runnable or waiting on its selected children;
completed/failed children are immutable prefix data. Latest source owner evidence
is independently replayed, including supported terminal latest roots (the EXIT evidence limit is described below). The selected child
inventory comes from the historical checkpoint boundary, never from later work.

This tree family supports serial and parallel human workflow gates and excludes issued/native/unknown work, resources,
custody, actions, bundles, Agents, execution-owned Chats, secrets, automatic,
unproven EXIT cuts, changed historical definitions/configuration and external restoration.
Supported held re-exports and admitted continuation generations retain exact proof
as described below. Supported local tree rewinds, including ordinary approval gates, retain portable proof as described below. Standalone gate/parallel and repeated
Script continuation retain their existing supported families; these are not a
promise of every combination with Call trees.

`GET .../foreign-continuation/source?planId=...` and the SDK's
`foreignContinuationSource` read original private evidence and immutable native
held mappings after explicit enablement. Ordinary execution-tree DATA readback
still requires disabled unchanged Branches and its complete owner inventory.
Continuation uses a separate immutable-held check; it does not weaken DATA
readback, adopt a source acceptance or release held owners. Reopening the imported
root's installation panel can inspect continuation directly after enablement.
The existing saved-command storage-before-POST and original-key GET remain in use.

Review binds every mapped Branch's current exact definition/configuration,
bindings and Call target graph, directory identity, policy records, revisions and
budget; selected owners expose their selected state and selected/latest shared
state seals. Definitions and nonsecret configuration match original source pins;
Call references match the current imported Branch map. All mapped destinations
must be explicitly enabled. A changed digest requires fresh human acknowledgment.

One all-owner SQLite transaction topologically accepts a fresh manual root and
fresh real child calls, remaps parent attempts/occurrences/input hashes/frontiers
and Map indices, and admits every owner under current capacity/budget rules.
Manual root admission retains the ordinary exemption; children use normal Call
budget admission. Completed children/results and reducers restore once; only
unfinished suffixes run. No source commands, notifications, Requests, leases or
process identities are copied. Original held manifests, rows and private facts
remain unchanged. Failure at any owner or the final receipt rolls back the entire
fresh tree, including budget admission.

Original-key recovery checks exact immutable source/held maps and the reviewed
command, every fresh owner's acceptance/admission/provenance/pins, real mapped
child admission, prefix paths/attempts/control rows/seals and selected state.
Terminal selected children cannot change; unfinished owners may make legitimate
suffix progress. Current policy need not remain unchanged after successful
acceptance. The receipt's `treeOwners` and global `idMap` expose fresh owner and
frontier mappings. No separate execution database or restoration authority exists.

Source-only implementation: no tests, fixtures/preparation, builds, typechecks,
Node/runtime/native/browser/provider or live database actions were performed.
Tree round trips, saved-command recovery, capacity/budget failure and final-owner
rollback remain execution-unqualified.

### Retained whole-tree generation proof

A continued root exports one private `tree-continuation` fact containing the exact
root command, reviewed receipt and original held tree manifest/native maps. Each
current tree owner also exports its exact acceptance/admission fact. Child
provenance remains `branch_call`; no child is made into a second manual root.
Export/import validation requires the original held owner and its saved command in
the current owner inventory, verifies their bytes against that fact, and recursively
validates retained manifests. The data receipt still conveys no admission.

The canonical local tree composer and private foreign fact reader share a whole-tree
lineage validator. It independently replays the prior selected tree and latest
source owner evidence, proves the global remap and every restored owner's current
pins, real acceptance/admission, parent attempt, occurrence/input identity and prefix
seal. Previously completed children remain terminal. New suffix children must have
ordinary Call provenance and admission under the exact reviewed Branch graph.
Restored child admission events are checked once without resettling old results.
New checkpoints retain the bounded generation reference in canonical tree provenance.

A held-only re-export follows immutable `tree-import` links separately. Every mapped
held frontier, counter, definition/configuration and Call edge must match its typed
remap before the original checkpoint can be selected. Review binds both the outer
held import and resolved generation identities, while allocating another fresh tree
through the existing transaction. The checkpoint picker follows the same bounded
held links; original-key recovery and command persistence are unchanged.

The 32 MiB manifest bound remains. Tree generation validation limits nesting to 16
links and memoizes at most 128 uncached manifests/replay frames per traversal;
cycles, missing owners, ambiguous commands, unsupported or oversized proof refuse.
No source effects or old acceptance authority are replayed. Ordinary disabled DATA
readers remain unchanged. Repeated round trips, suffix dispatch, rendered recovery
and rollback are source-reviewed behavior only until separately executed.


### Human gates in serial and parallel Call trees

Manual sync/async or proven closed EXIT effect-free Script/Call owners may contain ordinary
`human_gate` steps, including a root gate before the first child is admitted.
Selected and latest trees independently replay prompt, proposal, choices,
response/revision, checkpoint closure, routing and sealed results. A pending
selected gate stays pending even when the latest source gate has resolved.
Completed selected decisions remain historical prefix data, restored once.
Review includes selected/latest gate details for each owner and pending/completed
decision counts; all current destination choices remain in the same review digest.

Each selected pending gate receives a fresh mapped destination ID and notification
owned by its newly accepted execution. Normal destination human responses resolve
it; imported decisions grant no host, recovery or native approval authority.
Suffix gates use the normal workflow gate path. Original-key recovery verifies
immutable prefix gates and genuine later destination resolution/settlement and
notification ownership. Held re-exports and admitted continuation generations use
the same bounded retained lineage and canonical replay. All owners and gate
notifications are written in the existing acceptance transaction.

Fork/Map/Join owners use the existing parallel frontier and audit replay for
ordinary workflow gates alongside Calls. Selected and latest owner cuts independently
validate exact fork selections, Map items, Join arrivals, state seals and gate
evidence. Selected canceled gates require authentic path/Join cancellation and
matching gate/item cancellation events; a terminal child is never cancellation
proof. Active parallel paths remain running while only dependent gate/Call paths
wait. Fresh pending notifications and normal later responses use the same atomic
acceptance and original-key recovery paths as serial gates. Completed prefix
decisions are copied once; suffix gates and genuine later children follow normal
workflow execution. Held and admitted repeated generations retain these proofs.
Original-key recovery after a selected pending gate is canceled additionally
replays the complete current destination tree through the shared composer,
including the mapped prefix, real child contexts and causal Join/item/gate
cancellation events and attempt fences. Missing destination audit refuses recovery.
This proof requires a supported quiescent frontier; an in-flight Script process or
unknown outcome does not qualify, and never authorizes a replacement command.

Canceled serial gates, recovery-purpose gates, unproven local rewinds,
issued/resource/unknown/effectful work and unsupported automatic workflows remain refused.
EXIT trees require the saved closure proof described below. Standalone serial/parallel gate behavior is
unchanged. Source review does not qualify live gate notifications, round trips,
suffix scheduling or rollback.


### Portable local tree rewind lineage

Successful local historical rewinds of supported manual sync/async or proven closed EXIT effect-free
Script/Call trees, including ordinary serial and parallel approval gates, can use the existing foreign review/confirm/source and
original-key recovery flow. The shared canonical tree composer reads either local
private rows or their exact retained portable checkpoint/command facts. No foreign
rows, synthetic Requests, replacement commands or admission system are introduced.

The complete original source owners must remain in the exported Branch inventory.
Export already retains all their private snapshots, root/child lineage records,
commands (including key, input/result hashes/bytes and creation time), transitions
and actual acceptance/admission facts. The walker verifies exact source checkpoint
bytes/hash, original root command and child lineage, pins/configuration, all-owner
map coverage/injectivity, mapped Call parent attempts/inputs and prefix seals.
Historical children are recognized only through this validated rewind lineage; later
children retain genuine normal Call provenance. Terminal restored children retain
the original local acceptance without inventing a missing admission.

Every retained source tree is replayed independently at its selected checkpoint
and latest frontier. Completed prefix results/state are seeded once; unfinished
suffix work and later children use their normal audit. Portable replay shares the
16-link, 32 MiB manifest and 128 uncached-frame limits, active-cycle detection and
memoization with held/admitted foreign generations. Missing, erased, corrupt,
ambiguous or unsupported proof refuses continuation. Existing held-only validation
stays separate from fresh admission, and current all-destination review and atomic
acceptance/remapping remain mandatory for each destination generation. Existing
review evidence includes the exact checkpoint and its lineage provenance.

Gate-bearing local links require the same exact root/child rewind seeds, original
command and acceptance proof; gate metadata alone cannot establish a rewind.
Selected and latest source gate/owner cuts replay independently. A selected pending
gate remains pending despite later source resolution; resolved prefix decisions
are historical data copied once. Both the successful local writer and fresh foreign
acceptance map waiting gates to new identities and create destination-owned pending
notifications atomically. Only normal responses to those new gates can resolve them.
Later gates and genuine suffix children follow the ordinary workflow path.
Parallel canceled gates still require canonical Join/path/item cancellation proof.
Original-key recovery after later destination cancellation retains the complete
current-tree replay and supported quiescent-frontier requirement described above.

Recovery-purpose gates, unproven coordination lineage, issued/resource/native/unknown/effectful, automatic and unproven EXIT-tree
combinations remain refused. Original data, partial/failure evidence and existing
standalone gate/parallel/rewind behavior are preserved. This is source support;
round trips, suffix scheduling and rollback remain execution-unqualified.


## Durable standalone async checkpoints

Standalone manual effect-free Script/human-gate continuation also accepts explicit
`async` configuration and the native async default when mode is omitted. The
original configuration is preserved exactly; omission is not rewritten to an
explicit mode. The private selected snapshot must name that resolved mode and a
nonempty saver invocation identity, carry canonical continuation evidence, and
match an actual retained `checkpoint` fact byte for byte with its content hash.
Only committed snapshot rows are exported as those facts. A pending saver ticket,
failed write, missing snapshot or changed selected bytes cannot supply this proof.
Export refuses a source whose current async invocation records durability failure.
An older committed cut can qualify while a newer write is pending, but it must
still independently pass selected replay and complete latest-frontier replay; the
pending write is never claimed durable. Missing original command/lineage, active
Script attempts and unknown outcomes remain refusals.

The same proof applies to retained accepted generations and supported standalone
local rewind links. Held generations remain data only. Selected pending decisions
remain pending even if latest source evidence resolves them. Historical resolved
prefix work is copied once, and new pending gates receive fresh destination-owned
notifications. State reducers, condition/route and fork/Map/Join proof, current
human choices, directory identity, capacity and real admission are unchanged.

Acceptance still commits through `unitTransaction` and its existing mode-aware
saver. Sync dispatch waits for saved matching bytes; async dispatch follows the
native readiness rule after commit and remains subject to saver failure and
pending-byte backpressure. Async acceptance is not a saved acknowledgement and
makes no immediate durability promise. Receipt recovery reuses the original
command and canonical later-progress checks; it never issues a replacement
command. A copied pending gate later canceled in the destination additionally
requires complete current Script replay, including causal Join/path/item/gate
events and exact attempt fences. Recovery refuses a running/leased Script attempt
or unknown outcome; it requires a supported quiescent current frontier. Serial
canceled gates without supported canonical replay remain refused. Closed standalone EXIT support and the proven automatic standalone subset are described below; unsupported automatic and effectful work remain excluded.

This extension changes source support only. No async timing, durability, runtime,
notification delivery, round-trip or rollback validation was performed.


## Durable async Call trees

The shared tree consumer accepts manual effect-free Script/Call/ordinary approval
owners in sync or async mode, including native default async when configuration
omits the mode. Each owner's exact configuration stays unchanged; a tree may mix
sync and async owners. Every current destination must still match its source
configuration and mapped definition/bindings and be explicitly enabled, reviewed
and admitted under current choices.

The selected root must be the exact complete committed saver snapshot retained
in its private checkpoint fact, with matching hash, root selected state and
invocation metadata. Every selected async descendant additionally needs its own
committed saver snapshot with exact selected inventory, invocation identity,
resolved async mode and closing flag. A child saver snapshot need not itself be
standalone-restorable: its Call context and audit are proven by the complete root
tree codec. Missing or pending child saves cannot be inferred from a root save.
A different saved child cut does not qualify. The original exporter refuses
recorded async durability failure; no failed or pending write becomes saved proof.

Saver capture remains possible before child writes drain; this only creates a
candidate. Portable validation later requires those committed child bytes. The
latest tree is independently replayed from full retained audit and inventory,
with the existing bounds, exact lineage, acceptance and Call ancestry. Latest
proof makes no claim that a newer pending save has become durable. Local rewind,
held and admitted generations retain the same shared proof, including actual
nonadmission of copied terminal historical children and real admission of
unfinished or genuine suffix owners.

Fresh acceptance still uses the existing transaction and per-owner saver and
readiness rules. Sync ancestors wait for matching saves; async owners retain
normal failure/backpressure checks and no immediate durability acknowledgement.
Pending decisions get new destination notifications; completed prefix decisions
remain historical once. Original-key receipt recovery keeps complete current-tree
causal cancellation proof and its supported quiescent-frontier limit. No new
command, codec, storage format or execution authority is introduced. Unproven EXIT,
automatic, issued, resource, secret and unknown/in-flight cuts remain refused.
This is source support only; async timing, durability, round trips and scheduling
were not executed or qualified.


## Committed closed standalone EXIT checkpoints

The standalone consumer also accepts manual effect-free Script/ordinary human-gate
selections in explicit `exit` mode. Exact original configuration and invocation
metadata remain unchanged. The selected checkpoint must be an actual committed
complete saver snapshot, byte-identical to its retained fact and SHA-256, marked
restorable and closing, with the same nonempty invocation identity and EXIT mode
in its continuation. Existing local replay verifies the complete canonical
interruption or waiting-gate closure, invocation ordinal/outcome, selected state
and audit, including observed Script process exits. Process absence, an interrupt
request alone, a pending/coalesced saver candidate or a failed write is not proof.
Export refuses recorded async or EXIT durability failure.

Latest source replay is independent. EXIT requires a committed closed snapshot
whose entire selected inventory equals the latest retained frontier. A nonterminal
latest cut must itself have the supported restorable EXIT continuation; both that
codec and the full latest audit replay. A completed/failed latest frontier may use
its exact committed closing observation even when the saver marks it nonrestorable:
it is not selected for continuation, and terminal audit/state and process-drain
proof still replay. A newer active invocation, changed frontier without matching
closed saved bytes, unsupported failure/terminal shape or missing drain evidence
refuses. This deliberately does not claim that an old closed selection proves a
newer invocation closed or that an in-memory closure is already durable.

Held imports and re-exports preserve private evidence without admission. Accepted
generations and supported local historical rewinds use the same bounded lineage
walker, original command and snapshot proof, selected/latest replay and ID maps.
No source interruption identity becomes destination authority. Fresh acceptance
uses the existing transaction, current human review/configuration/enablement,
capacity/admission and mode-aware saver/readiness. The fresh destination starts
its own EXIT invocation; unfinished suffix work follows that lifecycle. Copied
completed work remains historical once, and pending gates receive new destination
identities and notifications. Destination gate closure and any later explicit
interrupt/resume are established by destination events and saved bytes.

Original-key receipt recovery retains immutable acceptance/prefix proof after
legitimate suffix progress. A copied gate later canceled additionally requires
complete causal current Script replay, including Join/path/item/gate events and
attempt fences. For EXIT this requires the exact saved closed current frontier;
active, pending, leased/running/unknown or unsupported cancellation shapes refuse.
No lookup creates a replacement command. Existing review/receipt DTOs, SDK and UI
already expose exact checkpoint, configuration and original-key data; no separate
codec, storage version or authority system is added.

EXIT Call trees without the additional proof below, unsupported automatic/effectful/issued/native/resource/custody/Agent/bundle,
secrets and execution-owned Chat continuation remain excluded. This is source
support only. No tests, typechecks, builds, execution, timing/durability,
notifications, round trips, scheduling or rollback validation was performed.


## Closed EXIT Call trees

The existing tree consumer accepts proven closed EXIT owners alongside sync and
async owners, retaining each exact configuration, including omitted native async
defaults. The selected root remains the actual complete committed tree checkpoint,
with exact bytes/hash and root metadata. Every EXIT owner, including the root and
terminal historical children, separately requires its own committed complete saver
snapshot with exact selected inventory, invocation identity, EXIT mode and closing
flag. Child observations may be nonrestorable because a child cannot independently
encode Call ancestry. The complete root tree retains original per-owner invocation
ordinal/state/outcome and interruption metadata; canonical per-owner and Call-tree
replay proves it. Neither an ancestor save nor a pending child ticket supplies
missing child durability. Encoding may freeze a candidate before saves drain;
nonencoding validation requires the actual committed rows.

The same serial/parallel replay checks supported JSON state, conditions/routes,
fork/Map/Join and ordinary approval gates. A waiting-gate closure omits an absent
interruption identity in the shared replay checkpoint; it does not invent an
explicit interruption. Existing gate-close events and observed Script process
exits are still required. Explicit interruption retains its actual identity and
ordinal. In-flight, unknown, failed or missing saves and missing canonical audit
or process-drain proof refuse.

Latest entire-tree proof independently uses current inventories and full audits.
Each latest EXIT owner must match its exact owner cut and invocation metadata in
a retained committed complete root tree checkpoint, with matching pins/configuration,
selected inventory and complete owner audit. It must also independently match its
own closed saver snapshot. Different EXIT owners may obtain invocation observations
from different retained root snapshots, but all are replayed together against the
actual latest Call tree. Current process absence cannot supply an invocation.
A terminal child can qualify through its retained root-tree observation and own
terminal save. Newly frozen supported terminal root trees retain the same complete
codec with `latestOnly:true` in the actual after-COMMIT saver row and
`restore_supported:false`. Capture replays the terminal tree, retaining exact owner
inventories, full audits, pins/configurations and original invocation metadata,
without requiring that candidate or child writes have already drained. This is
an immutable observation, not a saved acknowledgement before COMMIT/publication.
Latest portable proof can read its invocation observations only after the actual
canonical bytes/hash are retained, and still requires every EXIT owner's separate
matching closed save and independent entire latest-tree replay. Terminal root
observations are never executable selected cuts: listing reports them unsupported,
review/confirm and local rewind retain the existing restorable checks, and an
earlier genuine supported saved cut remains the only executable source.
Old terminal observations lacking the complete tree codec are not backfilled and
still refuse; standalone terminal evidence does not manufacture a tree codec.
A changed latest EXIT owner without a matching retained complete observation,
including a newer active or pending invocation, also refuses. Sync/async ancestors
can retain their supported latest terminal replay when every EXIT descendant has
this exact proof. Local rewind links remain supported only where original
selected/latest evidence and subsequent destination cuts satisfy these conditions.

The runtime tree package reader/planner remains unchanged: it already preserves all
private checkpoint facts, recreates supported terminal frontier data held without
authority, and passes original facts to the same selected/latest consumer. Runtime
export retains each actual snapshot unchanged and refuses recorded async/EXIT save
failure. Held/re-exported and retained-generation readers keep these original bytes;
no imported snapshot is promoted into a new save or invocation. Historical listing
and local rewind use the existing restorable predicate; foreign review/confirm
validates an independently restorable selection and latest proof separately.
Existing server, SDK and UI calls carry those snapshots and eligibility decisions
without a new endpoint or DTO, so none needs a format or caller change.

Held import/re-export and admitted generations use the existing bounded walker,
all-owner maps, original commands/receipts, pins, acceptance and authentic Call
ancestry. Local terminal historical children retain actual nonadmission and no
invented start; unfinished and genuine suffix Calls require normal admission.
Fresh all-destination review still checks current enabled configurations, bindings,
directories, policies, budgets and capacity. Acceptance creates destination-owned
invocations through existing selected-write tracking and mode-aware saver/readiness.
No source interruption becomes destination authority. Completed prefix work runs
once as history; genuine suffix work follows the fresh destination invocation.
Pending gates receive fresh destination identities and notifications.

Original-key recovery retains immutable acceptance/prefix proof. Later copied-gate
cancellation additionally replays the complete causal current tree, including
Join/path/item/gate events and attempt fences. Every current EXIT owner needs its
exact saved closed snapshot and matching actual current invocation identity/mode,
interrupted/terminal state and saved durability. Active/pending/unmatched current
EXIT owners refuse recovery, without generating replacement commands. Existing
review/receipt DTOs, SDK and UI already expose complete configuration/checkpoint
and per-owner evidence; no schema, storage version or parallel codec is added.

Automatic/effectful/issued/native/resource/custody/Agent/bundle/secret/execution-Chat
families remain excluded. This is source support only: no tests, builds,
typechecks, runtime, timing/durability, notifications, round trips, scheduling or
rollback qualification was performed.


## Proven automatic-source standalone Scripts

An original automatic execution can supply an independently supported selected
checkpoint and latest cut for standalone effect-free serial or parallel Node Scripts, ordinary
`human_gate` approval steps, declared JSON state, conditions/routes, fork/Map/Join
controls and their existing loop counters. Schedule, webhook and filesystem definitions keep their actual trigger kind/configRef and exact
pinned configuration; no trigger is rewritten to manual. Automatic Call trees beyond the proven root-only tree family below,
issued/effectful/native/resource/Agent work, retries and secrets
remain outside this origin-proof subset. Manual graph behavior is unchanged.

The shared origin validator reads the genuine native occurrence or original private
`trigger` fact with `retained_data` disposition. It requires exact execution/Branch/
occurrence ownership, activated state, canonical payload/provenance/trigger snapshot,
media type and native automatic input hash (without the operator-manual marker).
The snapshot must identify the same original Branch/trigger and source kind and
retain enabled/full-access Branch scope and source configuration. Original pinned
workflow/binding hashes are checked by the existing consumer. The execution input
must equal the same native envelope, or the canonical large-input occurrence
reference produced only when that envelope exceeds inline limits. Execution
provenance must equal the native untrusted-trigger envelope. Original accepted and
started events, including the original nonmanual admission, remain mandatory;
selected and latest cuts independently replay full canonical Script/gate audit/state/
process evidence. An occurrence-row match alone, `unavailable_held`, changed or
missing input/acceptance/pins, unknown work or missing saved proof cannot qualify.

The saver uses its existing standalone codec and after-COMMIT modes. Exact sync,
async, omitted-native-default async and genuinely closed EXIT predicates remain;
active EXIT cuts do not become restorable. Missing old codecs are not backfilled.
The runtime held-frontier planner uses the same origin proof, leaving unproven
sources as evidence only. Export/import/re-export preserve original private facts
without creating, consuming, advancing or replaying any occurrence or scheduling
lease. The runtime package format/reader is unchanged because it already retains
these canonical original trigger and nested generation facts; proof belongs at the
continuation boundary, not the general data-preservation boundary.

Explicit human review/confirm still requires the actual current destination
published definition/configuration, Script policy, accessible directories, secret
choices, capacity and current admission. The original automatic hash remains
immutable historical evidence. A destination accepts the same input text using
its own canonical **manual** hash, fresh occurrence/provenance, acceptance and
admission. Receipt recovery and retained foreign-prefix replay prove both input
identities separately and bind the original command/occurrence key; they never
replace the command or claim source scheduler authority. Completed prefix is copied
once and only unfinished suffix can run under destination authority.

Genuine local historical rewind uses the same original origin proof and existing
settled-source/pins/authority checks before fresh manual acceptance. Its existing
lineage walker keeps the original automatic identity and the new manual identity
separate. Held/admitted/re-exported generations follow the same bounded original
selected/latest proof and immutable receipts. Cancellation/unknown latest outcomes
retain existing refusal or complete-current-causality requirements; no missing
process exit is inferred. Serial canceled source gates remain refused; parallel cancellation needs its full
causal proof below and cannot become a pending or resolved prefix through a receipt.

Ordinary approval gates use the existing serial gate proof, including exact opening,
revision, input/proposal, prompt, choices, validated response/routing and sealed result.
Selected and latest gate cuts replay independently: a later source approval never
resolves a selected pending gate. For EXIT, waiting-gate invocation closure or explicit interruption and actual
Script process drains remain mandatory, alongside exact committed checkpoint bytes.
Copied completed decisions remain historical once, with no source command authority.
Each selected pending gate receives a fresh mapped destination ID and pending
notification atomically with acceptance. Only a fresh normal response against that
destination gate/revision can resolve it; no source notification or response authority
is adopted. Suffix gates follow the same ordinary destination lifecycle.

No continuation/store lifecycle, saver, remap, runtime-package, server, SDK or UI
implementation change is required for gates: shared eligibility feeds the existing
codec, selected/latest replay, held planner and bounded retained-generation/local
rewind walker. The store diagnostic names the enlarged eligible family. Existing
confirmation inserts destination notification rows; original-key receipt recovery
checks their owner/state, exact destination resolution command, audit and settlement.
Later cancellation of a copied pending gate additionally requires complete quiescent
current causal replay with attempt fences; cancellation without that proof refuses.
Held import/re-export itself emits no notification or response authority. Recovery-
purpose gates, leased/inflight/unknown work and operator-manual-marker hash mismatches
remain refused. Automatic Call trees have the separate root-only proof below.

Existing snapshot listing and foreign picker use codec eligibility; server/SDK/UI
review and confirmation carry full private checkpoint/manifests and current choices,
so no new DTO, endpoint, storage version or UI is needed. Native intake and historical
proof now share the exact envelope formatter. No timing/durability, scheduling,
notification, round-trip or rollback execution was performed for this source tranche.


### Automatic standalone parallel graph proof

The same original occurrence proof now covers supported standalone fork/Map/Join
Script/ordinary-gate graphs. The structural parallel frontier permits automatic
admission only for a genuine standalone owner, or its standalone terminal
observation with no child/resource/issued context. Called owners remain distinct.
`replayScriptCut` proves the original automatic origin and canonical owned audit
before entering `replayParallelCut`; the parallel structural check alone never
supplies origin authority. Foreign proof uses original retained facts only, never
destination SQL fallback. Stop policies remain mandatory; this change adds no retries.

Selected and latest cuts independently replay full Fork ancestry/selections, ordered
Map inventory/item hashes/bounds/concurrency, Join satisfaction/results/remainder
cancellation, state-seal order, route/condition/loop/traversal counts and gate
opening/resolution/cancellation. A canceled parallel gate qualifies only with the
actual causal Join/path/item/gate cancellation and exact attempt fence transitions;
a canceled serial source gate still refuses. Every authorized Script process must
have its actual observed exit, including canceled work. Unknown or in-flight work
and result bundles remain outside the portable consumer. Pending saver tickets do
not attest bytes: selected cuts require exact committed mode/invocation/hash proof;
EXIT latest additionally requires its own matching committed closed inventory and
invocation/closure proof. Sync/async latest replay remains an independent observation,
not a claim that a pending latest save is durable.

Existing bounded retained-generation/local-rewind composition, held export/import,
review/confirm and original-key receipt recovery carry parallel state and both input
identities without change. Completed prefix work and decisions are restored once;
only unfinished destination suffix work may schedule after fresh human/manual
acceptance. Selected pending gates receive fresh destination IDs/notifications and
normal response ownership. Source trigger/scheduler/response authority is never
adopted. Copied pending-gate cancellation after acceptance still requires complete
quiescent current causal replay, not just a matching canceled gate row.

No saver, continuation composer, runtime-package, remap, server, SDK or UI change is
needed: their shared eligibility/frontier/replay callers already preserve private
parallel facts, current configuration, full gate/state/control review and explicit
confirmation. The store diagnostic names the wider standalone family. This is
source support only; no execution, timing/durability, notification, round-trip,
scheduling or rollback qualification was performed.


## Proven automatic-root Script/Call trees

The existing foreign tree consumer now admits an original schedule, webhook or
filesystem root with effect-free Node Scripts, ordinary approval gates and native
Calls to supported **manual-definition children**. The root keeps its original
trigger/configRef and all owners retain their exact configuration, including mixed
sync, async, omitted-default async and genuinely closed EXIT. State, condition,
route, loops and existing fork/Map/Join replay are reused. Workflow and step policies
must stop throughout this initial automatic-root family; the serial successor below separately admits proven per-Script retries. This is an
explicit tree eligibility path, separate from standalone eligibility, called-child
admission and issued/resource contexts.

The shared origin validator accepts a Call-capable definition only when the tree
consumer explicitly opts in. Original selected and latest root cuts each prove the
same immutable activated occurrence, canonical payload/media/provenance/trigger
snapshot, native envelope or large-input reference/hash, original pins and original
accepted/started nonmanual admission. Foreign tree replay passes the root's actual
private runtime owner to that validator. Missing/unavailable original facts refuse;
there is no destination SQL fallback or occurrence reconstruction. Called children
prove their actual parent attempt, input hash, definition/binding, admission and
result through the existing complete tree replay, never as independent automatic
origins. Automatic child definitions remain unsupported.

Selected root bytes/hash must match an actual committed complete tree checkpoint.
Every selected child in this automatic-root family also needs its own exact committed
saver inventory, invocation, mode and closing flag, including sync children. A saved
root cannot attest missing or pending child saves. Child saver observations may be
nonrestorable independently: the complete root codec supplies Call context. Freezing
a candidate does not acknowledge that these writes have committed. Latest replay is
independent. Every EXIT latest owner additionally needs its own exact committed
closed inventory and real closure/process-drain evidence; root invocation metadata
comes from a retained complete tree. Genuine terminal `latestOnly` nonrestorable
tree observations qualify only as latest evidence and never become selected cuts.
Sync/async latest replay does not certify a pending latest write as durable.

Explicit interruption/resume of a live original automatic-root tree uses the same
original occurrence validator in the existing current owner-chain check. All current
pins/configuration, policies, owner states, genuine Call edges, saved quiescence and
observed process exits remain required. Process absence never proves drain; imported
source interruption never authorizes destination work. Waiting-gate closure continues
to use the existing gate lifecycle.

Held DATA planning uses the explicit structural tree eligibility only, preserving
complete private original facts without acceptance or notifications. Continuation
requires the stronger selected/latest origin and tree proof before review or fresh
acceptance. Unproven evidence remains held. Existing bounded held re-export,
admitted generation and local rewind composition separately replay the original
automatic root and each fresh manually accepted root; original manifests, commands,
maps and admission evidence remain mandatory. Local historical terminal children
retain their genuine nonadmission; unfinished restored owners and suffix Calls need
actual admission. No missing old codec is synthesized.

All-Branch human review still compares the actual current published definitions,
configRefs/configurations, mapped Call targets, policies, budgets, capacity,
directories and absence of secrets. The current root may retain its automatic
**definition**, while explicit confirmation accepts a new **manual execution** with
its own canonical manual hash, occurrence key, provenance and admission. Receipt
recovery now checks that destination manual hash rather than the original automatic
hash. Native child acceptance retains its own Call hash and current authority.
Completed prefix, children and decisions remain historical once; only unfinished
suffix runs. Selected pending gates receive fresh destination IDs/notifications in
the acceptance transaction and require fresh ordinary destination responses. Source
occurrences, schedules, leases and response authority are never adopted or advanced.

The existing original-key receipt and immutable-prefix checks remain; later copied
pending-gate cancellation requires complete quiescent current-tree causal replay,
including Join/path/item/gate events and attempt fences. Unknown, in-flight or
unsupported latest work refuses rather than creating a replacement command/key.
Saver lanes/readiness/after-COMMIT publication, runtime fact capture, tree generation
maps, remap and server/core SDK review/confirm/receipt paths already carry the needed
evidence and configuration, so they need no new format, DTO, endpoint or authority.
The existing UI warning now labels the fresh manual execution rather than calling
the original workflow manual; full current root/child definitions and configuration
remain inspectable in the existing review. The changed store paths are current tree review, exact destination-hash receipt
validation and genuine original automatic owner-chain interruption eligibility.

Native/issued/effectful/Agent/resource/custody/bundle/secret/execution-Chat/unknown/
in-flight/retry families, automatic children, unproven origins and EXIT trees without
the required closed saves remain unsupported. This is source-only implementation;
no execution, timing/durability, notification delivery, round-trip, scheduling,
rollback or whole-Bible acceptance is claimed.


## Manual standalone parallel Script retries

The shared portable definition guard now accepts per-Script `retry` policies only
for manual standalone graphs with existing fork or Map controls. The serial
successor below extends the same portable guard. Workflow policy and human-gate
policies still stop. Proven automatic serial and parallel retry successors are described below. The manual serial Call-tree successor below has a separate opt-in. This uses the existing local parallel frontier and causal replay codec,
not a new retry codec or a broader effect family.

Both the retained selected checkpoint and the independently replayed latest source
frontier must prove every ordered prior failed attempt, exact original input hash,
step purpose, attempt number/count, fence, lease, authorization, actual process
exit, settlement and canonical `retry_scheduled` observation. The codec verifies
`maxAttempts`, `delayMs`, consecutive attempt numbers, original failed-result bytes,
absence of an overriding failure edge, and that no intermediate failed retry is
sealed as a terminal Step result. Only successful immutable result seals contribute
state writes; failed attempts do not contribute reducer revisions. Existing full
Fork/Map/item/Join, gate, routing, loop and traversal replay still applies. Missing,
unknown, leased, running or process-undrained evidence cannot authorize continuation.

A prepared retry is supported when that replay proves its exact original
`available_at`: the retry event timestamp plus the unchanged policy delay. Remap
and insertion preserve that deadline, attempt numbers, consumed attempts, policy
limits and waiting path. They do not restart the delay or assert that source time
has elapsed. The existing destination Script claim checks `available_at` against
its current time and still requires current readiness, capacity and Script policy.
Future retries use the next number after the retained maximum. New native IDs reset
execution fences to zero; original fences and process proof stay in private source
evidence. Native row creation/update timestamps describe destination insertion;
they do not replace the retained original retry event/creation proof. Seeded replay
uses the proven remapped prefix without repeating its failed attempts or state.

Original-key receipt recovery additionally checks each mapped prefix attempt's
immutable purpose and `available_at`, alongside number/input/ownership and settled
result/fence checks, while allowing legitimate unfinished suffix progress. Copied
gate cancellation still requires complete quiescent current causal replay. A
replacement key or acceptance command is never used for recovery.

Existing committed selected saver bytes/hash, exact sync/async/default or closed
EXIT configuration, independent latest and EXIT closure/process-drain proof,
bounded held/admitted/re-export/local-rewind lineage and exact original commands
remain mandatory. Fresh explicit human review, manual acceptance/admission,
current budgets/policy/directories/no-secrets, transaction rollback and pending-gate
notifications stay on their existing paths. Completed retry prefixes remain
historical once; only unfinished work may schedule under destination authority.

No parallel codec, remap/storage, saver, runtime-package, server, SDK, DTO or UI
change is needed: existing typed facts carry every attempt and deadline, insertion
reads them back, and the UI exposes the exact checkpoint and complete review.
The shared guard reaches both portable replay and `foreignCut`; the receipt check
is the only store change. No schema, storage version or dependency changes.
Source inspection only: no tests, test preparation, builds, types, runtime or native
execution were performed. Timing, durability, notifications, round trips,
scheduling, rollback and whole-portability qualification remain unverified.


## Manual standalone serial Script retries

The existing serial continuation codec now admits canonical per-Script retry
histories for manual standalone effect-free Node Script/ordinary-approval-gate
workflows, with no controls or existing condition/route and loop edges. Workflow
and gate failure policies still stop. Serial definition eligibility uses an
explicit retry opt-in; the frontier enables it only for genuine parentless manual
owners and the exact standalone or standalone-terminal context. The automatic-source successor below extends that same codec; Call,
issued/Agent and resource contexts retain their prior serial eligibility. The
parallel codec and its supported manual retry family are unchanged.

The serial frontier retains every attempt, sorts consecutive numbers per Step,
checks original purpose/input/hash/fence, validates canonical failed prior results
without state updates, and enforces the original per-Script attempt ceiling. It
rejects orphaned, leased/running/unknown, request/recovery/native or uncertain
attempts. Only the final attempt can own the Step's terminal seal. A selected
prepared delayed retry keeps the genuine waiting path; an arbitrary waiting
Script without that supported retry evidence does not qualify.

Serial replay tracks each Script attempt from preparation through exact lease,
authorization, actual process exit and settlement. Process output/failure/hash and
fence proof refer to that attempt's result, not the final Step result. Each retry
requires the preceding failed settlement and drain, no overriding failure edge or
terminal seal, the next consecutive number within unchanged `maxAttempts`, exact
`delayMs`, original event/creation timestamp equality and the resulting absolute
`available_at`. A terminal failed attempt cannot seal before the retry ceiling
unless its genuine failure edge takes precedence. Successful state revisions are
validated only at the final immutable seal; failed attempts never write state.
Existing routing, conditions, loops, ordinary gate decisions and counters remain
in the same causal replay, not a parallel-codec bypass.

Exact selected and independently replayed latest cuts must both qualify, including
terminal latest observations and actual closed EXIT invocation/process-drain proof.
Incomplete events, unobserved process exits, unsupported recovery observations,
unknown effects or missing original retry evidence stay held. The existing saver
now reaches this serial codec; exact committed sync/async/default selected bytes
and hash remain required, and pending saves supply no acknowledgement.

Prepared retries retain their original absolute deadline through typed remap and
insertion. Destination claim checks current time/readiness/capacity/policy; no
elapsed-time claim, delay restart or consumed-attempt reset occurs. Seeded replay
checks mapped attempt numbers, purpose, input and deadline, preserves settled
results and zero destination fences under new IDs, then replays only actual new
suffix observations. Original timestamp/fence/process evidence remains private.
Later retries use the existing `MAX(number)+1` and policy ceiling. Existing bounded
held/admitted/re-export/local-rewind composition and exact original commands/maps
remain in use.

The only new store caller change lets the existing explicit EXIT interruption
path recognize the same portable definition for an actual manual standalone owner
without parent, Call depth or children. Existing current pins, authority, saver,
closure/drain and hold-identity checks still govern interruption/resume. This
makes genuine closed selected retry cuts capturable; it does not supply imported
source interruption authority to a destination. Ordinary gate closure and fresh
manual destination invocation lifecycle remain unchanged.

Fresh human review/current configuration/budgets/directories/no-secrets,
acceptance/admission, pending-gate destination notifications, original-key receipt
purpose/deadline checks and legitimate suffix recovery remain existing paths.
Serial canceled source gates remain refused; no new gate-cancellation family is
claimed. Runtime-package capture/held recreation/readback, remap/insertion, saver,
server, SDK, DTO and UI need no format changes because their existing paths carry
and expose all attempts and private selected/latest proof. Both shared portable
callers use the updated guard. No schema/storage-version/dependency changes.
Source only: no tests, preparation, builds, types, Node/parser/native/runtime or
live database work. Execution, timing/durability, notifications, round trips,
scheduling, rollback and whole-Bible/portability acceptance remain unverified.


## Proven automatic-source standalone serial Script retries

The serial retry codec also accepts proven original `schedule`, `webhook` or
`filesystem` standalone effect-free Node Script/ordinary approval-gate histories.
Definitions may retain JSON state, condition/route controls and loop edges, with
workflow/gate failure policies set to stop and per-Script retry policies. The automatic parallel successor below separately extends its existing codec;
The manual and automatic-root serial Call-tree successors below use separate tree contexts; automatic parallel
Call-tree, issued/Agent/resource/native/effectful/unknown families do not gain this
standalone automatic opt-in.

The automatic definition and origin validators add an explicit serial retry flag
that defaults off. It cannot combine with Calls or parallel controls. The shared
serial frontier/replay opts in only for a parentless owner in the exact standalone
or standalone-terminal context. Every original automatic selected and independent
latest cut must still prove its immutable occurrence identity, payload/provenance/
trigger snapshot, input/hash, accepted/started observations and native admission
through `automaticScriptOriginSupported`. Foreign validation reads the retained
owner facts, never fallback source-owner SQL. Missing occurrence or admission proof
is a hold; no trigger, schedule, lease or response authority is recreated.

The original definition may remain automatic after held import, fresh manual
acceptance, re-export or local rewind. Such a mapped destination is validated as
its actual human/manual acceptance and admission, not as a fabricated automatic
occurrence. Existing bounded lineage independently validates the original source
and its latest evidence, exact manifest/checkpoint/command/maps and each admitted
generation. Original source proof never substitutes for current permission.

All serial retry proof remains unchanged: consecutive consumed attempts, exact
failed results/input/purpose/hash/fences, lease/authorization/actual exit/settlement,
ceiling/delay/event-time/creation/absolute deadline, no overriding failure edge and
no intermediate seal/state write. Prepared delayed retries preserve the waiting
path and `available_at`; seeded replay preserves prefix work once, and destination
claim checks current time/readiness/capacity/policy. Later retries use `MAX(number)+1`.

Exact committed sync/async/default selected saver bytes/hash, independent latest
and authentic closed EXIT invocation/closure/process drain remain mandatory. The
existing EXIT definition caller recognizes an automatic standalone owner without
parent/Call depth/children; its owner-chain origin check explicitly opts into serial
retries while retaining current pins, authority and saved-quiescence checks. Held
recreation and local rewind likewise pass that explicit origin flag. Gate closure,
mode-aware saver/readiness and fresh destination invocation lifecycle are unchanged.

Fresh human review/manual acceptance, current choices/budgets/directories/no-secrets,
original-key receipt and legitimate suffix progress retain the existing transaction
and checks. Pending gates get destination notifications; serial canceled source
gates remain excluded. Runtime capture/import/readback/re-export, remap/storage,
saver, server/SDK/DTO/UI already retain and expose the required proof; no format,
schema, storage-version or dependency changes are needed. Only the shared consumer,
origin validator, necessary store callers and both guides change.

Source inspection only: no tests/preparation/builds/types/Node/parser/native/runtime/
browser/provider/liveDB execution. Execution, timing/durability, notifications,
round trips, scheduling, rollback, atomicity and whole-Bible acceptance remain
unvalidated.


## Proven automatic-source standalone parallel Script retries

Original schedule/webhook/filesystem standalone effect-free Node Script/ordinary
approval-gate graphs can also retain canonical per-Script retry histories through
the existing parallel codec. Existing fork/Map/Join, condition/route/loop, JSON state
and reducer semantics remain supported only with full canonical proof. Workflow
and gate failure policies still stop. Manual serial/parallel and automatic serial
behavior is unchanged; the automatic parallel Call-tree successor below is separate. Issued/Agent/resource/native/effectful/
unknown retry families gain no eligibility.

`automaticScriptDefinitionSupported` adds a fourth `parallelRetries=false` flag;
`automaticScriptOriginSupported` adds the matching seventh flag. The serial flag
remains serial-only. Parallel retry opt-in requires no Calls and an actual fork or
Map, and permits only Node Script retries within the supported controls. Default
and tree callers retain default stop-only automatic eligibility; the serial and parallel-tree successors below have separate opt-ins. Structural
parallel frontier opts in only for a parentless, no-Call-depth standalone owner or
its exact terminal context. It grants no automatic origin or execution authority.

The shared portable guard and selected/latest validator explicitly opt in. Before
parallel replay, `replayScriptCut` still validates the original automatic occurrence
through retained owner facts: exact payload/provenance/trigger snapshot, input/hash,
accepted/started and native admission evidence. Missing foreign facts refuse
without source-owner SQL fallback. Both selected and independent latest must prove
the entire graph; a valid prefix cannot qualify corrupted later evidence. Mapped
held/admitted/re-exported/local-rewind destinations may retain the automatic
definition while proving their real fresh human/manual acceptance. No source
trigger advancement, scheduler/lease/response authority or missed-trigger replay
is adopted. Original origin proof remains history, never current permission.

No parallel attempt, replay or seed algorithm changes. Consecutive consumed failed
attempts retain exact input/purpose/hash/results/fences, per-attempt authorization/
actual process exit/settlement, retry ceiling/delay/failure-edge precedence and
original absolute `available_at`. Intermediate retries cannot seal or write state.
Complete fork/Join choices, Map item order/inventory/bounds, reducer/loop/traversal
and causal gate/cancellation evidence remain required. Remap/seed preserves the
proven prefix once and permits legitimate suffix progress; current destination
time/readiness/capacity/policy controls claim, and future retries use `MAX(number)+1`.

Held recreation and local rewind explicitly pass the separate parallel origin
flag. The existing EXIT definition producer already reaches the portable guard;
its childless owner-chain origin path now opts into parallel retries separately
from tree proof. Parents/Call depth/children, current pins/configuration/authority,
actual interruption/closure/drain, saver success and saved-quiescence checks remain
in place. Exact committed selected sync/async/default bytes/hash, authentic closed
EXIT invocation and independently proven latest whole graph remain mandatory.
Missing, running, undrained or uncertain evidence stays held.

Fresh human review/manual budget admission/current choices/directories/no-secrets,
original command/key receipt and purpose/deadline checks, legitimate suffix
recovery and pending-gate destination lifecycle/notifications remain unchanged.
Canceled parallel gates require existing complete causal proof; serial canceled
source gates remain excluded. Capture/import/readback/re-export, saver, typed
remap/storage and server/SDK/DTO/UI already carry and expose all required evidence.
Changed files are shared consumer, automatic origin, parallel structural consumer,
necessary store callers and both guides; no schema/storage-version/format/dependency
change. Source inspection only; no tests/builds/types/Node/parser/native/runtime/
browser/provider/liveDB execution. Timing/durability, notifications, round trips,
scheduling, rollback, atomicity and whole-Bible acceptance remain unvalidated.

## Manual serial Call-tree Script retries

The existing serial/tree codec now accepts proven manual-root, actual Call-child
Node Script/ordinary approval-gate/branch_call trees with canonical per-Script
retries. Every retained owner definition must be manual and effect-free and must
omit parallel controls: existing condition/route, edge loops and declared JSON
state remain supported. Workflow, gate and Call failure policies still stop;
only Node Script attempts may retry. Automatic roots, parallel trees and
issued/Agent/resource/native/effectful/unknown retry families gain no eligibility.
Standalone manual and automatic serial/parallel eligibility stays separate.

`manualSerialTreeDefinitionSupported` explicitly opts into the existing shared
serial definition guard. `serialTreeRetries` is a distinct owner context supplied
by complete-tree validation and runtime-tree recreation only after every owner
qualifies. The replay additionally checks actual manual-root or matching Call
parent/attempt/input membership and excludes issued/resource contexts. The normal
definition guard defaults and automatic origin flags are unchanged.

The same serial attempt/frontier/audit replay now proves each owner's consecutive
consumed numbers, exact input/purpose/hash, fence/lease/authorization, actual
process-exit result and settlement, retry ceiling, unchanged delay and absolute
`available_at` derived from the original retry event/creation time. Failure edges
retain precedence; intermediate failed attempts cannot seal results or change
shared state. A genuine delayed prepared retry retains its waiting path. A
waiting Call must instead match the actual unfinished admitted child; arbitrary
waiting states do not become retry proof. Call attempts retain one attempt and
never gain a retry policy. Seed replay keeps consumed prefix attempts, results,
seals and deadlines once, allowing only legitimate new suffix work/children.

Both selected and independently replayed latest **whole trees** must qualify.
Existing exact parent/attempt/input/hash/Call occurrence, acceptance/admission,
mapped bindings, depth/ceiling, descendant counters and complete owner inventory
remain mandatory. Completed terminal children retain historical prefix semantics;
latest-only terminal observations remain observations, never executable selected
cuts. The unchanged bounded held/admitted/re-export/local-rewind generation walker
still proves original manifests, maps, commands, source and destination facts.

Sync, async, omitted native-default async and proven closed EXIT configurations
remain exact per owner. Selected committed bytes/hash and invocation metadata,
each required child save, and EXIT interruption or gate closure plus actual
process drain remain mandatory. Root bytes cannot bless a pending/missing child
save. Missing/running/undrained/unknown facts hold rather than manufacturing proof.
The saver freeze/encode/after-commit/readiness path is unchanged. The EXIT producer
now recognizes this structural family only with a manual/Call serial ancestor
chain; its separate current pins/configuration/authority, closure and drain checks
still govern interruption and dispatch.

Portable tree preflight and current destination review use the same explicit
manual serial family. Existing fresh human review, exact current mapped graph,
directories, no-secret choices, Script/Call permissions, per-owner capacity and
budget admission remain required. Root destination acceptance is genuinely manual;
children are genuinely Call-admitted. Retained source evidence grants no current
authority. Existing transactions, typed remap/insertion and original-key receipt
checks preserve exact prefix attempts/deadlines after legitimate suffix progress.
No replacement key or command is introduced. Ordinary pending gates retain fresh
destination notification/response ownership. Serial canceled source gates remain
unsupported; this change adds no cancellation-proof shortcut.

Capture/export/import/held readback/re-export, local rewind, generation/receipt,
scheduler Script claim/finish and Call-child creation retain their existing paths.
New retries still use `MAX(number)+1`; current destination time, mode-aware saver
readiness, capacity and policy govern claims. The server still observes actual
process-group closure and pipe drain before exit evidence/settlement. Existing
API/SDK/UI retain selected/latest proof and current review without DTO or format
changes. No schema, storage version or dependency changed.

Source review only: no tests, typechecks, builds, preparation, Node/parser/native,
runtime/browser/provider/liveDB or integration actions were performed. Timing,
durability, notifications, round trips, scheduling, rollback, atomicity and
whole-Bible/portability acceptance remain unvalidated.


## Proven automatic-root serial Call-tree Script retries

The serial-tree codec now also accepts a proven schedule, webhook or filesystem
root with manual-definition, actually Call-admitted descendants. Every owner must
qualify as an effect-free serial Node Script/ordinary approval-gate/branch_call
owner, with no controls or existing condition/route controls, loop counters and
JSON state. Workflow, gate and Call failure policies stay stop; only Script steps
may retry. The parallel/mixed-tree successor below separately extends this initial serial scope.
Manual trees and standalone manual/automatic serial/parallel families retain
their separate eligibility. Issued, Agent, resource, native, effectful, unknown,
bundle, secret and execution-owned Chat families gain no retry support.

`automaticScriptDefinitionSupported` and `automaticScriptOriginSupported` have a
separate default-off serial-tree retry opt-in. The shared consumer exposes an
explicit automatic serial tree structural helper, while whole-tree validation
and runtime-tree recreation enable serial retries only if every owner qualifies
and carries no host/issued/resource/action/bundle evidence. Only the parentless
root may have an automatic definition; children require manual definitions and
actual native Call ownership. Structural eligibility never proves an origin.

Before whole-tree causal replay, an original automatic root must pass the existing
occurrence proof for the selected cut and independently for latest evidence:
exact occurrence, payload/media/provenance, trigger snapshot, input/hash,
activated occurrence, accepted event and workflow-started native admission.
Foreign proof reads retained owner facts and refuses missing evidence without
foreign-owner SQL fallback. Runtime-tree structural recreation checks retained
root origin facts with no database handle; it still grants no dispatch authority.
Existing bounded held/admitted/re-exported/local-rewind manifests, maps, original
commands and causal generations remain required. A fresh destination root retains
the original definition but has real human/manual acceptance; descendants have
real Call acceptance. Original automatic proof supplies history only: no source
trigger advancement, scheduler/lease/response adoption or missed-trigger replay.

The unchanged serial retry replay proves each owner's consecutive consumed attempt
numbers, exact input/purpose/hash/fence, lease/authorization, actual process exit,
settlement/results, ceilings/delays/event times and absolute `available_at`.
Failure-edge precedence and absence of intermediate state writes/seals remain
mandatory. A genuine delayed prepared retry remains distinct from a waiting Call
with its actual unfinished child. Complete owner inventory, parent/attempt/input/
hash, mapped bindings, acceptance/admission, depth/ceiling and descendant counters
remain mandatory. Completed prefixes and historical terminal children seed once;
legitimate suffix children remain possible. Future attempts use `MAX(number)+1`,
with current destination time/readiness/capacity/policy controlling claims.

Selected sync/async/default or closed EXIT cuts still require committed exact
saver bytes/hash/invocation and independent latest whole-tree replay. Every
required child save remains mandatory, including sync children of automatic-root
trees. A root save cannot replace missing or pending child bytes. EXIT requires
authentic interruption or gate closure, actual process-group/pipe drain and
current authority; latest-only terminal observations cannot become selected cuts
or invented closure history. The necessary EXIT producer ancestor and owner-origin
checks and current foreign graph review use the explicit structural family while
retaining their separate current pins/configuration/authority/saver checks.

Existing review/confirm/receipt, per-owner budgets, Script/Call permissions,
capacity, current choices/directories/no-secrets, exact original-key recovery
after legitimate suffix progress and pending-gate destination notifications stay
in their existing paths. Serial canceled-source-gate semantics are unchanged.
Missing, running, unknown, undrained or effectful proof stays held.

This is source implementation and independent source review only. No tests,
builds, typechecks or runtime qualification were performed. Execution, timing,
durability, notification delivery, round trips, scheduling, rollback, atomicity
and whole-Bible/full-portability acceptance remain unvalidated. No schema,
storage-version, DTO, format or dependency changes are introduced.


## Proven automatic-root parallel and mixed Call-tree Script retries

An original schedule, webhook or filesystem root may now use the existing
fork/Map/Join controls itself or own a parallel descendant, with canonical
per-Script retries in qualifying serial and parallel owners. Every descendant
still has a manual definition and actual Call admission. Every owner must be an
effect-free Node Script/ordinary approval-gate/branch_call graph with existing
condition/route/fork/Map/Join controls, loop edges and declared JSON state.
Workflow, gate and Call failure policies stop; Calls and gates never gain retries.
Existing manual parallel Call-tree replay is reused without a new retry engine.

A new default-off `parallelTreeRetries` definition/origin/context opt-in is
separate from standalone and all-serial tree opt-ins. Complete-tree validation
requires an automatic root definition, at least one parallel owner and an entirely
qualifying owner inventory without host/issued/resource/action/bundle evidence.
Only the root may have an automatic definition. Each serial owner explicitly
receives the existing serial-tree retry context; parallel owners use the existing
parallel frontier and causal replay. This handles serial-root/parallel-child and
parallel-root/serial-child histories without deriving eligibility from one owner.
All-serial and previously supported manual/standalone behavior stays unchanged.

Original selected and independent latest automatic roots must pass the existing
occurrence proof before whole-tree or parallel causal replay: exact occurrence,
payload/media/provenance/trigger snapshot, input/hash, accepted/started events
and native admission. Foreign evidence stays in retained facts; missing facts
refuse without foreign-owner SQL fallback. Runtime-tree held recreation uses
the same retained origin validator with no database handle and complete inventory
eligibility, then limits each owner's context to its own automatic-root ancestry.
It creates no admission authority. Fresh destinations retain definitions but have
actual human/manual root acceptance and actual Call descendants; source trigger
history never adopts scheduler/lease/response authority, advances the source
trigger or replays missed triggers.

Each owner keeps its existing exact retry proof: consumed consecutive attempt
numbers, input/purpose/hash/fence/lease/authorization, actual process exit and
settlement/results, ceilings/delay/event time/absolute `available_at`, failure-edge
precedence and no intermediate seal/state writes. Parallel replay still proves
all fork paths, Map inventory/order/bounds, Join selection/reducers, state/loops,
gates and causal cancellation, including actual process drain for canceled work.
It refuses unsupported cancellation of an admitted Call child. Serial canceled
source gates remain refused. Delayed retries and genuine unfinished Calls remain
distinct. Prefix results and deadlines seed once; historical terminal children
stay historical, legitimate suffix children remain possible, and future attempts
use `MAX(number)+1` under current destination time/readiness/capacity/policy.

Selected sync/async/default and authentic closed EXIT cuts still require exact
committed saver bytes/hash/invocation, independent latest whole-tree replay and
every required child save, including sync children of an automatic root. Root
bytes never substitute for missing/pending child saves. EXIT requires original
interruption or gate closure plus process-group/pipe drain and current authority.
Latest-only terminal observations never become executable selected cuts or
backfilled closure history. Necessary structural EXIT ancestor/origin and foreign
review callers opt in while their current pins/configuration/authority/saver
checks remain separate. Bounded held/admitted/re-export/local-rewind lineage,
original maps/commands, per-owner review/budgets/current directories/no-secrets/
Script+Call permissions/capacity, original-key receipt recovery after suffix
progress and pending-gate destination notifications remain existing paths.

Issued/Agent/resource/native/effectful/unknown/secret/bundle/execution-owned Chat
families gain no support; missing/running/undrained proof stays held. No schema,
storage-version, DTO, format or dependency changes. This is source implementation
only: no tests/builds/types or execution were run. Timing/durability, notifications,
round trips, scheduling, rollback, native equivalence, atomicity and whole-Bible/
full-portability acceptance remain unvalidated.


## Proven manual-root mixed Call-tree Script retries

A proven original manual root may now combine serial and parallel owners with
canonical per-Script retries in serial owners: a parallel root with a serial retry
child, a serial retry root with a parallel child, or deeper mixed Call trees.
The complete owner inventory must contain both a serial owner and an owner using
existing fork/Map controls. Every owner must have a manual, effect-free Node
Script/ordinary approval-gate/Call definition, workflow/gate/Call stop policies,
no secrets and no host/issued/recovery/runtime-outcome/resource/action/bundle
work. Existing condition/route/loop/JSON state and fork/Map/Join semantics remain.

A separate default-off whole-tree eligibility check supplies the existing
`serialTreeRetries` context only to serial owners after the full inventory
qualifies. Parallel owners retain their existing manual codec. No automatic
origin flag is used to label a manual root. Existing all-serial manual trees,
automatic-root families and already supported manual parallel-owner retries
retain their behavior. EXIT structural ancestor eligibility now recognizes
qualifying manual mixed ancestors; this is only a producer guard, not whole-tree
replay or current authority. Existing current foreign review and portable
preflight already accept these per-owner definitions and need no new bypass.

Selected and independent latest whole-tree replay still prove exact root manual
input/hash/acceptance and actual Call-child parent/attempt/input/hash/admission,
pins, mapped bindings, depth/ceilings/counters and complete inventory. Serial
replay retains consecutive attempts, input/purpose/hash/fence/lease/authorization,
actual process exit/settlement/results, retry ceilings/delay/event time/absolute
`available_at`, failure-edge precedence and no intermediate seals/state writes.
Parallel causal replay and cancellation proof are unchanged. Calls/gates never
retry; canceled serial source gates and cancellation of admitted Call children
remain refused. Genuine delayed retries remain distinct from unfinished Calls.

Exact committed selected sync/async/default saver bytes/hash/invocation,
independent latest whole-tree proof and every required child save remain.
Authentic EXIT interruption/gate closure, actual process-group/pipe drain and
current authority remain separate requirements. Root bytes cannot replace
missing/pending child bytes; latest-only observations cannot become executable
cuts or invented closure history. Held/admitted/re-export/local-rewind manifests,
maps/commands, prefix-once results/deadlines, historical terminal children and
legitimate suffix children retain the existing proof. Fresh human/manual root
and real Call-child destination admission, per-owner budgets/permissions/capacity,
current choices/directories/no-secrets, original-key receipts and pending-gate
ownership/notifications remain shared paths. Future `MAX(number)+1` attempts obey
current destination time/readiness/capacity/policy.

Runtime-tree recreation limits mixed eligibility to the owner's own validated
manual-root ancestry, excluding unrelated histories; it remains held and grants
no authority. Issued/Agent/resource/native/effectful/unknown/secret/bundle/owned-Chat
families gain no support. Missing/running/undrained evidence stays specifically
held. No schema/storage-version/DTO/format/dependencies changed. Source only:
no tests/builds/types or execution were run; timing/durability, notifications,
round trips, scheduling, rollback, native equivalence, atomicity and whole-Bible/
full-portability acceptance remain unvalidated.


## Runtime recreation eligibility follows each complete root tree

A runtime package may retain multiple original execution roots across its
Branches. Recreation now derives an owner's root and every related owner from
already validated parent links before checking any serial, manual mixed or
automatic parallel tree family. The same complete related inventory supplies
all family checks, original automatic-root occurrence proof and per-owner codec
context. Unrelated histories neither provide a required serial/parallel mixture
nor suppress an otherwise supported tree; unrelated automatic origins are not
used as proof or a prerequisite for that tree. Manual and automatic admission
and definition rules remain distinct. Only the root may retain an automatic
definition, with actual Call descendants and the existing retained-origin proof
without a database handle or foreign-owner SQL fallback.

Whole-package integrity remains global and precedes eligibility: manifest hashes,
versions/object shapes, owner and global identity inventories, all Branch/Call
dependencies, complete parents, cycle checks and bounded lineage are unchanged.
No owners or facts are removed or moved. Planning still allocates and stages
every owner with its existing `recreated_held` or `evidence_only` disposition.
Unsupported unrelated leaves can retain complete evidence without a native
frontier. An unsupported parent with children still refuses before staging when
native Call ancestry cannot be recreated; this does not make every package
importable. Insertion/readback/re-export continue validating the entire package
and original maps, commands, ancestry and held receipts. Recreation grants no
acceptance, scheduler, lease, response or current execution authority.

Existing definition/frontier/serial/parallel/tree codecs and automatic occurrence
proof remain unchanged. Per-root selected and independent latest whole-tree
replay, committed saver bytes/hash/invocation, every required child save and
authentic EXIT interruption/gate closure/process-group and pipe drain/current
authority remain mandatory. No trigger advancement or missed-trigger replay is
introduced. Original manual root/actual Call children and fresh human/manual
root/Call-child destination admission remain the existing paths. Retry attempts,
deadlines, `MAX(number)+1`, full fork/Map/Join/state/gate/cancellation proof,
bounded lineage, original-key receipts, pending-gate lifecycle, current choices,
per-owner budgets/permissions/capacity/directories/no-secrets and scheduler claim
behavior are unchanged. Unsupported issued/Agent/resource/native/effectful/
unknown/secret/bundle/execution-owned Chat families and canceled serial gates
gain no support.

No schema/storage-version/DTO/format/dependency changes. Source only: no tests,
builds, types or execution were run. Execution, timing/durability, notifications,
round trips, scheduling, rollback, native equivalence, atomicity and whole-Bible/
full-portability acceptance remain unvalidated.


## Root-scoped review and disposition-aware held generations

Foreign tree review compares historical definitions, configurations and Call
bindings against the selected root's complete validated ancestry inventory. This
includes latest legitimate suffix children, rather than only owners present in
the selected checkpoint. Unrelated historical roots on the same Branch may retain
older pins as evidence without requiring one current destination to match several
historical definitions. Review and confirmation use this shared source cut; the
review digest and original-key receipt continue binding the exact original
manifest, checkpoint, held maps and current reviewed choices.

Whole-package validation and exhaustive held readback remain global. Every mapped
Branch still undergoes the existing enabled/current definition, configuration,
Call dependency, permission, budget, directory and no-secret review. Narrowing
historical comparisons neither adopts a foreign configuration nor removes any
current destination authority check.

Repeated held export/import follows the original complete manifest and all owner,
Branch, frontier reservation and publication-pin maps. Each owner must retain its
exact import/provenance, unaccepted waiting hold, output, counters, mapped ancestry,
input/hash/configuration and original private command. Map reservations remain
complete, fresh and unique even when no native frontier was recreated. No owner,
private fact, earlier generation or original command is discarded or rewritten.

The resolver validates both existing dispositions. A `recreated_held` owner needs
its exact definition, mapped Call bindings and typed frontier remap. An unrelated
`evidence_only` leaf needs an empty native frontier and empty executable idMap;
its actual destination version/binding pins remain bound to the import receipt.
Its native definition may describe the imported current Branch, while its older
historical definition remains unchanged in the private original manifest. It does
not gain a frontier or admission. Evidence-only parents and any evidence-only
owner in the selected root's complete related tree still refuse. Global
manifest/command/hash, identity/map closure, no-admission and held-authority checks
continue for every owner, with the existing 16-link/cycle/alias bounds.

Original manual or automatic root history and actual Call ancestry remain distinct
from fresh human/manual root and Call-child destination authority. Selected and
independent latest replay, original automatic occurrence proof, exact committed
saver bytes/hash/invocation and every required child save remain mandatory.
Authentic EXIT interruption/gate closure and observed process-group/pipe drain are
still required; root saves never supply missing child proof. Retry deadlines,
fences, consumed attempt numbers, `MAX(number)+1`, fork/Map/Join/state, gates,
causal cancellation and serial canceled-gate refusals retain their existing rules.
Bounded lineage, original-key recovery, pending destination notifications and
current permissions/capacity/budgets/directories/no-secrets are unchanged. No source
trigger, scheduler, lease or response authority is adopted, and no issued, Agent,
resource, native, effectful, unknown, secret, bundle or execution-Chat family gains
support. Held recreation remains nondispatchable.

Source only: no tests, preparation, builds, typechecks, Node/parser/native/runtime,
browser/provider/live database actions or executed reproductions were performed.
Execution, timing/durability, notification delivery, round trips, scheduling,
rollback, native equivalence, atomicity and whole-Bible/full-portability acceptance
remain unvalidated. No schema, storage-version, DTO, format or dependency changes.
