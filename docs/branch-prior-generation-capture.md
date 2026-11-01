# Prospective precleanup generation evidence

Source implementation only. Historical admission remains disabled. This producer cannot reconstruct a generation whose original Chat, Agents or provider registrations were already removed.

The Branch retry cleanup service now runs `captureGenerationExitBeforeCleanup(stepId)` before any Agent/Chat deletion. It records a same-owner `branch_commands` journal under `resource-generation-exit:<stepId>:<generation>`, schema `branch-resource-generation-exit.v1`. Initial `state:fencing` retains exact `identity:{executionId,stepId,generation,projectId,chatId,agentIds,creationKey,branchId,versionId,bindingRevisionId,configurationSha256}`. Every original Chat member must be a current resource member; original Chat ownership and live identities are required. Branch owner dispatch waits while any journal is fencing/capturing. The same owner transaction publishes Runtime `fenceBranchGenerationExit` and retains its immutable `{identity,sha256}` receipt as `intakeFence` in the journal and envelope. The independent `host_lifecycle_commits` fence permanently holds every original Chat/Agent across scope/intake/activation/lease paths, including after owner/journal deletion. Readback revalidates canonical receipt bytes and exact original input. Before runtime drain or package capture, Branch positively requires that shared canonical gate recognize every participant; without it capture/cleanup stay held.

The server uses its actual `drainProviderRuntimeAuthority`, `ProviderProcessAuthority.terminateAgents` and `readExitEvidence` hooks, checks active Runs/runtime teardown/retry/process authority, and retains original live identities. Cancellation uses existing canonical Branch Request/activation cancellation. A terminal scheduler row or successful storage deletion never substitutes for observed process exit. Missing original Run registrations, unobserved/unknown processes, open Requests/Joins/suspensions, unrelated effects, unresolved imports/resource operations, missing native Script process-exit receipts, missing host coverage, deleted original scopes or changed owner pins refuse capture.

After drain, `reserveGenerationExit` records exact selected frontier and complete `BranchHostCut` (including original provenance), native Script exit rows/process identities/hashes, exhaustive participant effect inventories and actual `ProviderExitEvidence` bytes/revision. Its `envelope` schema is `branch-prior-generation.v1`; fields are `{identity,intakeFence,selected,hostDependencies,nativeScriptExits,effectClosure,providerExitEvidence,nativeState:'not_captured',restore_supported:false}`. `envelopeSha256` seals canonical bytes. An actual `CheckpointPackageSource` binds the same selected frontier, host, generation, binding and configuration. Phase becomes capturing; no source package identity is reallocated on retry.

Runtime's permanent execution fence preserves normal source package ownership visibility; package capture uses all existing admission/deletion/installation checks without an exception. Actual durable package capture happens outside SQL through the existing package engine. The synchronous callback `sealGenerationExit` requires its real receipt inside the same owner transaction. It rechecks original generation/member/owner pins, full selected/host/native/effect envelope and `readProviderExitEvidence(expectedRevision)` immediately before inserting the snapshot and changing the journal to sealed. Any drift refuses the seal and pins cleanup. Package outcomes already persisted without a Branch seal remain held under the existing package engine's uncertainty contract; no automatic recapture/reallocation from mutable history.

Retained snapshot schema remains `branch-unit-selected.v2` with `captureKind:'retired_resource_generation'`, `restore_supported:false`, and `priorGeneration:{...envelope,source,receipt,envelopeSha256}`. `readGenerationExitCapture` verifies canonical journal/snapshot hashes, package/source bindings, retained native evidence and `verifyRetainedProviderExitEvidence` against immutable ledger bytes after original identities disappear. It never recaptures or reimports. `resourceCanRetire` requires this seal for fresh-context retry generations; `resourceRetired` retains the journal/checkpoint/envelope hash reference in its immutable generation retirement evidence before pointer replacement. Existing resource membership/deletion and unknown-effect checks remain.

Supported source bound is one standalone owner with 1..32 current local resources; both serial and parallel retry cleanup use the same producer. Complete host Request closure must already be settled; parallel frontiers with other open Requests remain held. Called owner trees, incomplete old generations, secret bindings, host artifacts, missing provider registration coverage and unavailable original roots refuse. Because full host capture still requires original Request scopes, a later cleanup with an already-deleted earlier root stays held until Runtime's separate historical partition/validated retained-host composition exists. No historical partition/admission or provider/native replay is enabled here. Native process state stays not_captured. Group partial-capture abandonment remains a distinct lifecycle operation.

Deferred source extends the actual existing serial/parallel ASYNC/SYNC fresh-context retry fixture with explicit synthetic terminal Runs and process handles passed through real ProviderProcessAuthority registration/observation/readers, missing-proof holds, selected-cut drift/rollback, exact package seal, deletion/retirement linkage and postcleanup readback. Package bytes are inert receipts. These fixtures do not qualify a live provider, OS group, native Job, filesystem custody or runtime execution. No tests/checks/build/types/Node/native/browser/runner preparation/execution/migrations were performed.

Runtime intake/lease integration and exact deletion guard029fade1ee8b3307429add26aa974d736bb59772 are assembled together. Agent subtree preview/pending/commit, Chat pending/storage/commit and Project pending/commit independently require the original sealed journal, immutable fence, envelope, provider/native evidence and matching custody/checkpoint seal before destructive progress. Branch begin/final deletion independently scans immutable original-generation fences by original Branch/execution, including the execution subtree, before flags/cancellation or journal/checkpoint removal. Installation owner cleanup rechecks the same guard before private-state rollback or Agent/Chat storage effects. Removed/reparented original Chats cannot hide a pending capture. New immutable fence receipts retain resource.original_branch_id, and both readers bind it to the captured Branch. Legacy receipts without that field are conservatively validated on every Branch deletion; no original owner is guessed from a current Chat. Missing evidence after owner/journal removal conservatively holds later deletion. The fence is never released. This closes the source assembly prerequisite, not executable qualification. Historical admission remains false.

Owner-deletion deferred fixtures cover missing/pending/forged seals with removed/reparented original Chats, and real producer sealed cleanup plus rollback of final Branch deletion. Existing Runtime proof verification is reused, not duplicated. Complete source is assembled; all execution and qualification remain deferred.

The additive Runtime destination reservation now supports an explicit evidence-only historical partition from these exact sealed generation receipts; see [historical-evidence-partition.md](historical-evidence-partition.md). This does not remove the later-generation Branch retained-host/retry consumer hold described above. Current executable roots and old nondispatchable evidence must be composed explicitly; no preupgrade proof or restoration is inferred.

### Called-owner issued-resource producer (source only)

An explicit `issuedResources:true` context extends the existing Script-tree/serial
codec. It retains the actual call ancestry, per-owner selected frontier, complete
host cut, audit, version/binding/configuration pins and resource import/release
receipts. The initial bound is exactly a manual parent and one called child,
one generation-zero issued resource per owner, serial ASYNC/SYNC owners waiting
at a supported frontier. Parallel controls, EXIT, secrets, artifacts, forwarded
or unknown effects and incomplete host evidence refuse. The ordinary tree
checkpoint/rewind reader explicitly excludes this context.

`branch-issued-tree-capture.ts` supplies preview, reserve, per-member seal and
exact retained readback. A root-owned `issued-tree-capture:<command hash>` journal
retains two distinct `CheckpointPackageSource`s: each intent names its ORIGINAL
execution and hashes THAT owner's frontier, host, binding and configuration.
Every preview/seal checks current enabled owner pins, original Chat ownership,
live participants and provider/runtime drain. Full snapshot hash is the tree CAS;
any child frontier, audit or host change invalidates the preview. Existing real
package capture runs outside SQL; its synchronous callback seals inside SQL.
Only the second exact receipt writes the complete checkpoint and retained journal
in that owner transaction. Partial custody keeps automatic resource cleanup held;
owner deletion conservatively holds even after sealing, because this source has
no tree admission/retirement consumer. No new pin-release or abandonment path is
provided. Direct original scope loss remains a readback refusal, never proof.

The existing group service exposes `/destination-groups/tree-capture-preview`,
`/tree-capture` GET/POST and bounded current-owner `/tree-captures` discovery.
The SDK supplies `previewTreeGroupCapture`, `captureTreeGroup`,
`treeGroupCaptureStatus`, and `discoverTreeGroupCaptures`. Preview/status return
`currentAuthority:false,actionEligible:false`. Discovery is limited to 100 exact
commands per current root; overflow refuses. It does not replace the retained
owner-independent canonical group audit. The existing package engine reads both
actual captured receipts before returning success, followed by SQL proof readback.

`issuedTreeFreshOwnerMap` generates prospective fresh execution/frontier/Chat/Agent/Request
maps and preserves parent execution/attempt ancestry. It creates no acceptance,
budget, import, Request, Step, graph receipt, checkpoint or runnable authority.
Maps are ephemeral planning data, not reusable admission authority.

The deferred parent/child fixture uses actual Branch calls, resource reservations,
import-operation ledgers, Agent/Chat creation and canonical Requests, with inert
Script/custody evidence. It covers child-source identity, preview conflict,
partial cleanup hold, changed child host facts before seal, exact two-receipt
checkpoint readback, fresh ancestry maps without SQL allocation, owner deletion
hold, ordinary rewind refusal, corruption and reopen. It has NOT been executed.

Remaining: consume Runtime's owner-tree audit/read/retirement contract, then one
outer transaction/one canonical group admit composing fresh accepted/budgeted
owners, human disclosure, owner/Chat/Agent/Request/Step/import/resource maps,
all owner command receipts and post-admit checkpoints. No usable destination
consumer, historical partition/admission, later-generation replay, native/provider
qualification or complete feature claim is made by this producer slice.

The serial one-resource generation-one destination successor now supplies explicit
current-cut/retained-host replay and exact historical selections through the
existing singular capture/disclosure/admit/readback path. See
[branch-generation-one-destination.md](branch-generation-one-destination.md).
This supersedes only that narrow source hold, not parallel/later-generation,
called-tree admission, missing-old-proof or executable qualification limits.

## Bounded serial generation history

The existing later-generation serial module and shared serial replay now cover
current generations 1–32, configured maxAttempts up to 33, exhaustive prior seals/
retirement/failed-Request/attempt/provider/native/custody evidence, and current-only
host capture. Later precleanup seals retain the full original selected cut but
capture only that generation's failed root; their prior chain prefix is bound in
the envelope. Existing singular human-reviewed admission consumes ALL exact
server-derived selections and preserves consumed attempt numbers/maxAttempts.
The generation-history preview/discovery and SDK are source-connected. See
[the complete bound and deferred qualification](branch-generation-one-destination.md).
This supersedes earlier generation-one-only serial limits in this document;
parallel retry and called-tree atomic consumption remain refused. Nothing was run.
