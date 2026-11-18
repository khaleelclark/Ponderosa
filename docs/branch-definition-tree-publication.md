# Execution-free multi-Branch package publication

Source implementation, not runtime qualification. The original frozen
56a6cf55459c506b08cbefa884f40736ae7787e1 checkout remains unchanged.

## Usable caller contract

`GET /api/branches/:id/package?mode=full` now exports the complete published
Branch Call dependency closure when any Call is present, including shared targets,
self-dependencies and cycles. A visited set bounds this inventory to 100 Branches.
Any execution owner anywhere in that closure, unsettled installation, or retained
owned resource in a non-active state refuses before identity/export writes. The
existing standalone full held-runtime exporter remains unchanged for non-Call
workflows. Template-only export remains unchanged.

The additive `InstalledBranchPackage.definitionTree` inventory contains each source
Branch ID, exact current version/binding pins, package identity, own definition,
nonsecret configuration including checkpoint mode, logical Agent binding map,
unique flattened Chat refs, engines/trigger declarations and exact dependency
ref-to-source-Branch targets. Secret bindings never enter this inventory; secret
parameters refuse. Every template Chat and Agent still travels through the existing
Agent package exporter and reviewed composer. Existing Git/configuration/file
transport is reused unchanged. The complete inventory has its own SHA-256 and
binds the entire flattened package payload hash, including Chat instructions,
Agent data and output-role declarations. Existing total Chat/Agent/payload bounds
still refuse oversized packages rather than truncate the closure.

Send `treeBindings: Record<sourceBranchId, BranchBindings>` to the existing
`POST /api/branches/install-preview`. Every source Branch requires a destination
entry with its own directories/engines/current automatic-trigger configuration.
Caller Agent and Branch bindings must be empty: the exact portable Agent inventory
and dependency closure determine those fresh targets. Existing top-level `bindings`
is retained for SDK compatibility; the reviewed root entry is authoritative for a
tree. Existing per-Agent context/files/access/output-role reviews still apply.
This tranche supports new installations only. Incomplete closure, duplicate Chat
ownership, unowned Chats, unreachable nodes and execution-bearing manifests refuse.

Preview returns `definitionTreeReview` with `manifestSha256`, `reviewSha256`,
Branch count and every reviewed destination binding. The review digest covers
both manifest hash and all destination bindings. Confirm with
`acknowledgeDefinitionTreeSha256: preview.definitionTreeReview.reviewSha256`
and the existing `acknowledgeFullImport: true`. Using the source manifest hash
alone does not acknowledge the destination choices. The SDK adds optional
`treeBindings` as the final `importPreview` argument and the new confirmation
acknowledgment field. No UI contract is assumed or changed.

One private plan persists the once-allocated fresh Branch map, logical Chat final
owners, reviewed bindings and review digest. The existing root staging Branch is
reserved disabled at confirmation. Awaited Chat/Agent creation, working-root review,
access review and restart recovery continue under that root plan. Each Chat uses its
own final Branch's definition, configuration, directory and engine mapping while
staging. No child installation is confirmed or published early.

After staging, the existing final SQLite transaction resolves all resource handles
before changing any resource keys, reserves every remaining disabled Branch,
assigns actual final Chat ownership so canonical Agent validation succeeds,
publishes every definition through the existing publisher with fresh dependency
maps, and promotes the existing installation resources to their final Branch/package.
Source triggers are forced disabled. Every fresh workflow remains disabled; there
are zero execution owners, admissions, leases, accepted Requests or dispatches.
A last-child publication/receipt failure rolls back all final versions, bindings,
dependencies, resource promotion and Chat reassignments. The preexisting disabled
blank root and staged resources remain recoverable under the existing plan.

Confirm and `GET /api/branches/installations/:id` return
`definitionTreeReceipt`: exhaustive source-to-fresh Branch, logical Chat and Agent
maps, source/fresh version and binding pins, exact definitions/configurations/
resolved bindings and dependency maps. Readback verifies current native ownership,
resource identity inventories, pins, definitions, configuration and dependencies,
disabled workflows/triggers and absence of execution owners. Later edits or enabling
a workflow make this historical zero-authority outcome fail integrity readback;
the receipt does not attest to changed current state. Existing terminal plan expiry,
count bounds and normal deletion apply. No new archive or retention policy exists.

Re-export follows the recreated actual Branch dependencies and original package
identities; it creates another execution-free manifest with the current native
source IDs. Runtime imported-owner provenance remains handled by the unchanged
standalone runtime codec.

## Deferred fixture source

`tests/branches/definition-tree-publication.test.mjs` uses actual server callers and
Agent composer for source installation, definition publication, full export,
per-Branch preview, confirmation/access review and readback. Source inventory has
distinct parent/child definitions and directories, two refs sharing a child and a
child-to-parent cycle. It includes reviewed-plan restart, completed lost-response
replay/restart, re-export, incomplete/aliased closure refusal, execution-bearing
export refusal before resource writes, and injected final-child publication failure
with native rollback assertions. SQL is used for observations and fault injection,
not to manufacture foreign source rows or bypass the installation caller.

## Remaining work

This slice recreates definitions/dependencies/template Chats with ZERO execution
owners. Called/cross-Branch runtime owner trees still refuse. The next tranche needs
all-owner execution/frontier identity preallocation, real fresh parent Call attempt
ancestry through the canonical codec, held owner publication and exhaustive native
frontier readback. Automatic standalone native frontiers remain evidence-only;
existing standalone automatic evidence preservation and private held-owner re-export
are retained. Runnable foreign selected-checkpoint continuation still requires a
separate current-review/fresh-acceptance/budget/current-custody consumer. No full #8
or runtime-tree completion claim follows from this change.

No tests, checks, builds, types, Node/native/provider/browser execution, preparation,
installation, migrations, push, deployment or new workers were run. Deferred source
fixtures have not been executed.

## Execution-bearing successor

The [held execution-tree source implementation](branch-execution-tree-publication.md)
extends this definition-only slice. Full export now inventories runtime owners
instead of applying the original blanket execution-owner refusal. Independent
runtime-manifest acknowledgment, held native Call ancestry, evidence-only leaf
handling and receipt readback are described there; unsupported parents still refuse
before staging. Definition-only packages retain this document's original flow.
