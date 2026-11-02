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

Only first-generation, standalone manual, sync-mode, serial Script definitions without controls/shared state/secrets are accepted. Selected and latest exported source cuts must have no issued Requests, resources, custody facts, actions, bundles, gates, pending process outcomes or execution-owned Chats. The selected cut must pass the existing Script frontier and full audit replay, including exact original definition/binding pins, input and traversal integrity. The only shared replay extension supplies retained immutable owner/audit evidence instead of querying nonexistent foreign database owners. It is restricted to effect-free first-generation Script cuts and returns only a validation result, never authority. No foreign rows or fake Requests are inserted to satisfy validation.

The preview independently verifies the actual recreated-held imported native frontier/maps/participant ownership through existing runtime-data readback. It checks the imported owner remains waiting/unaccepted, current destination availability/pins/configuration/policy and accessible directories. Any unknown custody or native authority on the held owner refuses. `not_applicable` means no selected/latest source or native resource exists; it never means an unavailable receipt was treated as released.

Confirm recomputes that exact review in the existing immediate owner transaction. It calls existing `acceptInput` with a fresh manual occurrence/provenance, `hasRunnableCapacity` and canonical `BranchExecutionBudgetAuthority.admit`. Manual acceptance retains the existing manual budget exemption; admission still writes a fresh current-policy receipt. This tranche does not create a new budget system or silently charge a manual continuation as automatic work.

The same `remapBranchFrontier`/`insertBranchFrontier` writer used by canonical historical continuation allocates new local IDs, inserts/verifies the selected prefix, restores counters and records the actual fresh admission/start. Completed prefix work is data and is never scheduled again. Only the new owner can schedule the uncompleted suffix under normal current lease/policy checks. No Request, native lease, acceptance, admission or process identity is copied from the source. No source effect is settled, source retired, custody released or pin released.

The original held owner row, frontier, import command, original manifest and private facts stay unchanged. A new namespaced command receipt is attached to that owner for ordinary deletion/retention semantics. It binds original imported evidence to the fresh acceptance/admission and local ID map. Last-receipt failure rolls back acceptance, admission, native frontier, counters and receipt together. Replay/status validates the saved receipt, original imported data and real fresh acceptance/admission without requiring unchanged *current* policy after a successful command. Existing import re-export remains data-only. Continuation snapshots are not advertised as a new restorable foreign generation.

## Deferred verification and remaining scope

`tests/branches/foreign-checkpoint-continuation.test.mjs` uses actual full export/import/review/continuation/status HTTP callers and canonical inert source APIs. It covers different destination directories, persisted private checkpoints, restart between review and confirmation, fresh manual admission/current budget revision, exact held-owner preservation, remapped completed prefix, only suffix leasing, lost response/replay/restart, stale budget/policy/directory refusal, unknown latest source/native custody, command conflict, and final-receipt rollback. SQL observes rows or injects corruption/failure only; it does not fabricate source acceptance/frontier or destination admission. No fixture has been executed.

Remaining: tree/called owners and multi-owner current admission; automatic/issued/unknown/resource/bundle/Agent frontiers; exit/async modes; secret choices; shared state/controls; changed historical definitions/configuration; execution-owned Chat continuation; re-exported-generation continuation; external file/artifact restoration proofs. These paths refuse explicitly before fresh acceptance. Existing tree DATA recreation, standalone held import, composer, deletion/retention/precleanup and Git/config transport remain unchanged. This is no whole-portability, all-family or runtime qualification claim.

## Saved continuation recovery in the UI

Reopening the standalone continuation panel automatically looks up the original saved command through the existing receipt GET. A verified result offers the fresh execution link without copying browser-storage entries or pasting receipt JSON. Detailed receipt data remains inspectable. A missing receipt or connection error stays visible; it does not trigger another acceptance request or create a replacement command. Refresh saved result repeats only that read.

Read-only lookup remains available when the exact original command is already in memory, even if browser storage becomes unavailable. Fresh acceptance still requires successful storage and readback before POST. Unreadable or invalid saved commands block fresh acceptance; the UI never reconstructs their keys. Changing the viewed owner clears old review, consent and receipt state, and ignores responses from the previous view. Existing exact receipt/import-map checks, supported-family restrictions and unknown-effect refusals are unchanged.

This UI change is source-only and has not been run, built or typechecked.
