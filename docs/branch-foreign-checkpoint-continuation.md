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

Standalone manual, sync/async or proven committed closed EXIT-mode, effect-free Script/human-gate definitions with declared JSON state (`sum`, `append`, `replace`) and existing `condition`/`route` and canonical fork/Map/Join controls are accepted, along with the proven automatic-source serial Script subset described below. Workflow and per-step failure policies must stop; retries, secrets and other control families remain excluded. Selected and latest exported source cuts must have no issued Requests, resources, custody facts, actions, bundles, recovery-purpose gates, pending process outcomes or execution-owned Chats. The selected and latest source cuts must each pass the existing Script frontier and full audit replay, including exact original definition/binding pins, input, state-seal settlement order, condition/route choices, fork and Join selections, Map inventory/order/bounds and traversal/loop counters. The selected cut must be resumable: running, or canonically waiting for supported parallel work or a workflow gate. For sync/async the latest cut may be running, canonically waiting or canonically completed/failed; EXIT additionally requires an exact committed closed latest frontier as described below; both cuts must remain effect-free and pass full replay. Missing or corrupted evidence refuses before fresh acceptance. The only shared replay extension supplies retained immutable owner/audit evidence instead of querying nonexistent foreign database owners. It is restricted to effect-free Script cuts with independently validated retained generation links and returns only a validation result, never authority. No foreign rows or fake Requests are inserted to satisfy validation.

The preview independently verifies the actual recreated-held imported native frontier/maps/participant ownership through existing runtime-data readback. It checks the imported owner remains waiting/unaccepted, current destination availability/pins/configuration/policy and accessible directories. Any unknown custody or native authority on the held owner refuses. `not_applicable` means no selected/latest source or native resource exists; it never means an unavailable receipt was treated as released.

Confirm recomputes that exact review in the existing immediate owner transaction. It calls existing `acceptInput` with a fresh manual occurrence/provenance, `hasRunnableCapacity` and canonical `BranchExecutionBudgetAuthority.admit`. Manual acceptance retains the existing manual budget exemption; admission still writes a fresh current-policy receipt. This tranche does not create a new budget system or silently charge a manual continuation as automatic work.

The same `remapBranchFrontier`/`insertBranchFrontier` writer used by canonical historical continuation allocates new local IDs, inserts/verifies the selected prefix, restores counters and records the actual fresh admission/start. Completed prefix work is data and is never scheduled again. Only the new owner can schedule the uncompleted suffix under normal current lease/policy checks. No Request, native lease, acceptance, admission or process identity is copied from the source. No source effect is settled, source retired, custody released or pin released.

The original held owner row, frontier, import command, original manifest and private facts stay unchanged. A new namespaced command receipt is attached to that owner for ordinary deletion/retention semantics. It binds original imported evidence to the fresh acceptance/admission and local ID map. Last-receipt failure rolls back acceptance, admission, native frontier, counters and receipt together. Replay/status validates the saved receipt, original imported data and real fresh acceptance/admission without requiring unchanged *current* policy after a successful command. Existing import re-export remains data-only. Supported running continuation generations produce restorable Script checkpoints through the same local lineage walker.

## Deferred verification and remaining scope

`tests/branches/foreign-checkpoint-continuation.test.mjs` uses actual full export/import/review/continuation/status HTTP callers and canonical inert source APIs. It covers different destination directories, persisted private checkpoints, restart between review and confirmation, fresh manual admission/current budget revision, exact held-owner preservation, remapped completed prefix, only suffix leasing, lost response/replay/restart, stale budget/policy/directory refusal, unknown latest source/native custody, command conflict, and final-receipt rollback. SQL observes rows or injects corruption/failure only; it does not fabricate source acceptance/frontier or destination admission. The state/control extension adds no fixture or test preparation under the source-only instruction; no runtime qualification of that extension is claimed.

Remaining beyond the supported Call-tree family described below: unproven automatic and automatic gate/parallel/Call-tree frontiers; issued/unknown/resource/bundle/Agent frontiers; EXIT trees without the closed saved proof described below; secret choices; recovery-purpose gates; changed historical definitions/configuration; execution-owned Chat continuation; external file/artifact restoration proofs. These paths refuse explicitly before fresh acceptance. Existing tree DATA recreation, standalone held import, composer, deletion/retention/precleanup and Git/config transport remain unchanged. This is no whole-portability, all-family or runtime qualification claim.

## Saved continuation recovery in the UI

Reopening the standalone continuation panel automatically looks up the original saved command through the existing receipt GET. A verified result offers the fresh execution link without copying browser-storage entries or pasting receipt JSON. Detailed receipt data remains inspectable. A missing receipt or connection error stays visible; it does not trigger another acceptance request or create a replacement command. Refresh saved result repeats only that read.

Read-only lookup remains available when the exact original command is already in memory, even if browser storage becomes unavailable. Fresh acceptance still requires successful storage and readback before POST. Unreadable or invalid saved commands block fresh acceptance; the UI never reconstructs their keys. Changing the viewed owner clears old review, consent and receipt state, and ignores responses from the previous view. Existing exact receipt/import-map checks, supported-family restrictions and unknown-effect refusals are unchanged.

This UI change is source-only and has not been run, built or typechecked.

## Selected state and routing continuation

The same export facts/private checkpoints, reviewed held import and runtime-data readback carry state seals and condition/route/fork/Map/Join frontiers. No extra import format, endpoint, acceptance system or mutable state store is introduced. Source definitions are canonically validated; current definition and nonsecret configuration must still match exactly. A selected cut can stop before or after a supported control, or at an unstarted Script invocation. Unknown, issued, resource, recovery-gate, automatic, bundle and secret families remain refused by this standalone consumer; the separate Call-tree family is described below.

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
Script processes, unknown outcomes, retries, recovery-purpose gates, issued work, resources,
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
canceled gates without supported canonical replay remain refused. Closed standalone EXIT support and the narrower proven automatic serial subset are described below; unsupported automatic and effectful work remain excluded.

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


## Proven automatic-source standalone serial Scripts

An original automatic execution can supply an independently supported selected
checkpoint and latest cut for standalone effect-free serial Node Scripts, declared
JSON state, conditions/routes and their existing loop counters. Schedule, webhook
and filesystem definitions keep their actual trigger kind/configRef and exact
pinned configuration; no trigger is rewritten to manual. Automatic approval gates,
fork/Map/Join, Call trees, issued/effectful/native/resource/Agent work and secrets
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
selected and latest cuts independently replay full canonical Script audit/state/
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
process exit is inferred. Automatic sources in this subset have no copied gates.

Existing snapshot listing and foreign picker use codec eligibility; server/SDK/UI
review and confirmation carry full private checkpoint/manifests and current choices,
so no new DTO, endpoint, storage version or UI is needed. Native intake and historical
proof now share the exact envelope formatter. No timing/durability, scheduling,
notification, round-trip or rollback execution was performed for this source tranche.
