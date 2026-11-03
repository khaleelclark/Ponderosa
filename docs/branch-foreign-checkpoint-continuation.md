# Foreign selected Script continuation — source tranche

Source only, unqualified. No test, type, build, Node, native, browser, provider, installation preparation, migration or deployment command was run for this tranche. The deferred fixture must pass after the execution hold is lifted before runtime behavior can be claimed.

## Supported caller flow

The existing full package exporter, reviewed installation preview/confirm and runtime-data GET first recreate a private standalone held data owner. Its receipt supplies no acceptance or execution authority. Preserve that installation receipt and original manifest; set current destination settings to the selected source configuration (including `checkpointMode: sync`) using existing settings GET/PUT, then enable the current destination explicitly using the existing availability action. Standalone import does not itself adopt the source checkpoint mode.

On `/api/branches/:id/executions/:executionId/foreign-continuation`, `executionId` is the imported held owner, not the original foreign owner:

1. POST `/review` with `{planId,sourceExecutionId,checkpointKey,checkpointSha256}`. The checkpoint key/hash identify an exact original private `checkpoint` fact in the imported manifest. Review returns the private selected checkpoint, original manifest/owner hashes, exhaustive import maps, current destination version/binding/configuration and configuration revision, current effective capability policy with persisted revision records and execution budget, resolved directory paths/device/inode, and explicit `current_destination` access, `node` engine, `none` secret choice and `not_applicable` custody.
2. Human POST to the base path with the same selection plus `{commandKey,reviewSha256,acceptCurrentAuthority:true}`. A review digest includes all fields above except the budget observation timestamp. The handler inherits existing operator-only authentication; Agent capability tokens cannot use it.
3. GET the base path with `?commandKey=<original key>` retrieves the original immutable command receipt. Repeated identical POSTs after a lost response/restart return that same receipt and IDs. A changed original command conflicts. GET never accepts, admits or creates a review.

SDK methods: `reviewForeignContinuation`, `continueForeignCheckpoint`, `foreignContinuationReceipt`.

Current choices are established through the existing destination configuration/bindings and capability controls before review. This first cut deliberately requires current nonsecret parameters/limits/checkpoint mode and definition to match the selected source checkpoint exactly. Destination directories can differ; review resolves and checks current directories again on confirm. No source Agent access, engine credential, secret, resource, provider/browser state or filesystem restoration claim is adopted.

## Authority and atomicity

Only standalone manual, sync-mode, effect-free Script definitions with declared JSON state (`sum`, `append`, `replace`) and existing `condition`/`route` and canonical fork/Map/Join controls are accepted. Workflow and per-step failure policies must stop; retries, secrets and other control families remain excluded. Selected and latest exported source cuts must have no issued Requests, resources, custody facts, actions, bundles, gates, pending process outcomes or execution-owned Chats. The selected and latest source cuts must each pass the existing Script frontier and full audit replay, including exact original definition/binding pins, input, state-seal settlement order, condition/route choices, fork and Join selections, Map inventory/order/bounds and traversal/loop counters. The latest cut may be running or canonically terminal, but the selected resumable cut must be running. Missing or corrupted evidence refuses before fresh acceptance. The only shared replay extension supplies retained immutable owner/audit evidence instead of querying nonexistent foreign database owners. It is restricted to effect-free Script cuts with independently validated retained generation links and returns only a validation result, never authority. No foreign rows or fake Requests are inserted to satisfy validation.

The preview independently verifies the actual recreated-held imported native frontier/maps/participant ownership through existing runtime-data readback. It checks the imported owner remains waiting/unaccepted, current destination availability/pins/configuration/policy and accessible directories. Any unknown custody or native authority on the held owner refuses. `not_applicable` means no selected/latest source or native resource exists; it never means an unavailable receipt was treated as released.

Confirm recomputes that exact review in the existing immediate owner transaction. It calls existing `acceptInput` with a fresh manual occurrence/provenance, `hasRunnableCapacity` and canonical `BranchExecutionBudgetAuthority.admit`. Manual acceptance retains the existing manual budget exemption; admission still writes a fresh current-policy receipt. This tranche does not create a new budget system or silently charge a manual continuation as automatic work.

The same `remapBranchFrontier`/`insertBranchFrontier` writer used by canonical historical continuation allocates new local IDs, inserts/verifies the selected prefix, restores counters and records the actual fresh admission/start. Completed prefix work is data and is never scheduled again. Only the new owner can schedule the uncompleted suffix under normal current lease/policy checks. No Request, native lease, acceptance, admission or process identity is copied from the source. No source effect is settled, source retired, custody released or pin released.

The original held owner row, frontier, import command, original manifest and private facts stay unchanged. A new namespaced command receipt is attached to that owner for ordinary deletion/retention semantics. It binds original imported evidence to the fresh acceptance/admission and local ID map. Last-receipt failure rolls back acceptance, admission, native frontier, counters and receipt together. Replay/status validates the saved receipt, original imported data and real fresh acceptance/admission without requiring unchanged *current* policy after a successful command. Existing import re-export remains data-only. Supported running continuation generations produce restorable Script checkpoints through the same local lineage walker.

## Deferred verification and remaining scope

`tests/branches/foreign-checkpoint-continuation.test.mjs` uses actual full export/import/review/continuation/status HTTP callers and canonical inert source APIs. It covers different destination directories, persisted private checkpoints, restart between review and confirmation, fresh manual admission/current budget revision, exact held-owner preservation, remapped completed prefix, only suffix leasing, lost response/replay/restart, stale budget/policy/directory refusal, unknown latest source/native custody, command conflict, and final-receipt rollback. SQL observes rows or injects corruption/failure only; it does not fabricate source acceptance/frontier or destination admission. The state/control extension adds no fixture or test preparation under the source-only instruction; no runtime qualification of that extension is claimed.

Remaining: tree/called owners and multi-owner current admission; automatic/issued/unknown/resource/bundle/Agent frontiers; exit/async modes; secret choices; human gates; changed historical definitions/configuration; execution-owned Chat continuation; external file/artifact restoration proofs. These paths refuse explicitly before fresh acceptance. Existing tree DATA recreation, standalone held import, composer, deletion/retention/precleanup and Git/config transport remain unchanged. This is no whole-portability, all-family or runtime qualification claim.

## Saved continuation recovery in the UI

Reopening the standalone continuation panel automatically looks up the original saved command through the existing receipt GET. A verified result offers the fresh execution link without copying browser-storage entries or pasting receipt JSON. Detailed receipt data remains inspectable. A missing receipt or connection error stays visible; it does not trigger another acceptance request or create a replacement command. Refresh saved result repeats only that read.

Read-only lookup remains available when the exact original command is already in memory, even if browser storage becomes unavailable. Fresh acceptance still requires successful storage and readback before POST. Unreadable or invalid saved commands block fresh acceptance; the UI never reconstructs their keys. Changing the viewed owner clears old review, consent and receipt state, and ignores responses from the previous view. Existing exact receipt/import-map checks, supported-family restrictions and unknown-effect refusals are unchanged.

This UI change is source-only and has not been run, built or typechecked.

## Selected state and routing continuation

The same export facts/private checkpoints, reviewed held import and runtime-data readback carry state seals and condition/route/fork/Map/Join frontiers. No extra import format, endpoint, acceptance system or mutable state store is introduced. Source definitions are canonically validated; current definition and nonsecret configuration must still match exactly. A selected cut can stop before or after a supported control, or at an unstarted Script invocation. Unknown, issued, resource, gate, called/tree, automatic, bundle and secret families remain refused by this standalone consumer.

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
continuation authority. Tree/called, issued/Agent/resource/automatic/unknown,
gate/bundle/secret, changed-definition and external-file-proof
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
Join resolution. Selected owners must remain resumable; latest owners may be
running or canonically completed/failed. Cuts between required arrival, item-seal,
item-settlement or loop observations are refused by canonical replay. Active
Script processes, unknown outcomes, retries, gates, issued work, resources,
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
