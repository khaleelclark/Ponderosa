# Retained coordination into fresh resource participants

Source-only implementation. No tests, typecheck, build or runtime qualification was run for this change. The bounded Branch issued-resource consumer is connected through the operator commands below. Qualification remains deferred; ordinary historical rewind retains its issued-resource refusal.

The existing `restoreHostCoordinationCut` still means fresh graph IDs in the **original** live scope and participants. Its authorizer and ordinary `coordinate`/`updateRequest` actor rules are unchanged. The new host-only `CoordinationV3Store` API admits explicitly mapped fresh participants; no provider tool exposes it. Operator-only Branch destination commands compose this host API.

Shared DTOs are in `packages/core/src/coordination-destination.ts`. Runtime authority is `packages/agents/src/coordination-v3-destination-admission-authority.ts`, exported through the store facade. Migration `0037_coordination_destination_admissions.sql` is registered in `db.ts`.

## Caller ordering

1. Resolve an immutable server-retained Branch checkpoint and independently retained checkpoint package. Its exact issued host frontier, selected resource generation, ordered source package refs, binding pins and current effects disposition must agree. The source execution must be settled; surviving original Requests must have settled known outcomes and original provider processes must drain. No old Run, grant, lease, reply route or native effect is restored.
2. On the canonical connection inside the Branch owner transaction, call `reserveCoordinationDestination(reservation, authority)`. Reservation includes source Branch/execution/checkpoint/hash, command key, human operator identity, `reconcileEffects:true`, full custody receipt, and fresh destination project/Chat/execution/resource Step/generation. Reserve BEFORE the Chat exists. For existing workspace creation, `workspaceCreationId('conversation', projectId, creationKey)` exposes the same deterministic identity already used by `AgentStore.createConversation`; do not duplicate its algorithm. Managed new-workspace creation must similarly supply its exact preallocated Project/default Chat identity through its existing host service. The destination Project may itself be a reserved future identity; it must exist before import staging. There is no wildcard fence for an unknown future Chat.
3. Create that exact Chat. The durable reservation fences the entire Chat, including subsequently created Agents, through runtime scope, ordinary coordinate intake, activation factory, scheduler leasing, public product owner SQL and Agent pending/readiness projection. There is no implicit timeout release. Failure/restart leaves it held. A new ordinary import must not bypass the dedicated staged import hooks.
4. Use `BranchImportHooks.stage(plan)` to call `stageCoordinationDestination(admissionId, stage)`. The importer invokes this synchronous hook within its reservation transaction before artifact publication or Agent creation. Plan contains canonical `creationOperationId`, project/Chat, explicit `{sourceRef,agentId}` entries from actual import nodes, and `{sourceRef,destinationId,sha256,byteLength}` artifact entries. Stage binds full explicit original Agent -> fresh Agent and original runtime artifact -> fresh artifact maps. Never infer mapping from array order. This operation accepts only fresh imported Agents and complete resource package membership, with no aliasing or unmapped graph participant. Savepoint rollback prevents a caught failure from committing partial maps.
5. `BranchImportHooks.beforeAdmit(result)` may await durable human disclosure review outside SQL transactions. It does not remove staging. `reviewCoordinationDestination(admissionId, authority)` runs within a short owner transaction after imported identities are present and before completion. Its review hash binds the immutable reservation/cut/custody, explicit import and participant/artifact maps, current destination policy projections, artifact bytes/metadata and current disclosure authority revision. A source access-settings choice is NOT disclosure authorization. If import commit changes destination restrictions after the review, the hash changes and admission refuses: obtain review against the final intended policy, or use an unchanged reviewed destination policy. The consumer must journal this policy/review sequence explicitly rather than fabricate approval from a successful import.
6. In `BranchImportHooks.admit(result, completeImport)`, call `admitCoordinationDestination(id, approvedReviewHash, authority, compose)` under the existing `transaction(operation)` owner hook. The authority rechecks current custody/owner, disclosure, policy, fresh membership and effect eligibility, validates the retained reducer chain/closure, and reuses the same canonical final-projection writer as original-scope restore. It imports system-labelled historical questions/answers with original actors/audiences retained as provenance, new graph IDs, mapped Request scope/participants, Join owner/member order/continuations and suspension owners/edges. Intermediate historical actions never enqueue wakes.
7. `compose(graph)` is synchronous. It persists actual Branch issued-Step/attempt Request references, resource ownership, whole owner-tree acceptance/readback receipts and invokes `completeImport()`. Return `CoordinationDestinationOwnerReceipt` with exact execution/resource/generation/import identity, a durable Branch command key in `receiptId` and every issued root Request binding. That command’s `result_json.coordinationDestination` must equal the exact graph receipt, and actual `branch_resources`/`branch_resource_members` must bind the mapped Chat/Agents and generation. Runtime verifies persisted attempt/Step references and completed import before readiness. All these writes, graph maps, immutable restoration receipt, final admission readiness and ONLY final pending activation/outbox records share the same connection and outer transaction. Runtime uses a nested savepoint, so composition/publication failure rolls back its partial graph even if a caller catches the exception. Do not catch an outer owner commit failure and claim success. No await/provider launch is permitted inside composition. Output-role finalization remains held until admission commits.
8. Read back `readCoordinationDestination(admissionId, reservationHash, authority)` before repeating import/source access after a lost response. It checks current human permission to disclose the complete original private fact inventory, immutable maps/provenance, mapped Request/Join/suspension edges, persisted issued-Step refs, import completion and activation source lineage. Live post-admission Request progress does not invalidate its immutable imported prefix. It reads the retained snapshot copy and does not require surviving source Agents, source Chat or package bytes. Existing source Branch/checkpoint/execution retention is explicitly pinned by RESTRICT foreign keys until owner reconciliation removes the admission; automatic admission reclamation is not supplied. Deleting the source Branch itself is not supported recovery and fails closed while this pin remains. Exact reserve/stage/admit replays recover the same identities/maps; changed key inputs or review refuse, and no replay calls composition or creates additional activations.

## Mandatory host authority

`CoordinationDestinationAuthority` has no permissive defaults:

- `requireCustodyAndOwner(reservation)` synchronously proves exact independently retained package receipt/bytes and current owner-tree, resource Step/generation, release/deletion/unknown-effect state, pins and current right to perform admission, returning a nonempty current authority revision bound into the review hash. Preparatory async reads must yield a server-owned immutable proof whose eligibility can be synchronously rechecked. An imported JSON receipt is not such a proof.
- `authorizeDisclosure(review)` authorizes the named current human to read **each original private fact** AND disclose it to every listed mapped recipient. It returns a current authority revision. Facts include original Request participants, original Communication audience/sender and update actor with immutable hashes. Neither manager relationship, Join membership nor fresh destination access grants implies source disclosure permission. Returning a string without performing these checks is an invalid integration. The same callback is required for receipt readback.
- `resolveArtifact(...)` proves an independently retained fresh canonical artifact's exact content, including its explicit `importArtifactId` from the actual package import receipt and current grant for its mapped Request audience. Runtime verifies fresh metadata/hash/length/role and creates its new canonical update ownership. Imported managed artifact IDs and newly prepared canonical text artifact IDs are distinct explicit mappings; the host adapter must materialize/authorize the latter before review, never infer grants from equal bytes. It never reuses source publication ownership, origin Run or source grants.

These are trusted host service functions, not serialized permissions or request-body callbacks. The Branch consumer must supply the real current operator/disclosure proof and custody service adapter; this module does not invent a human approval UI.

## Limits and remaining work

This operation admits one exact resource organization generation in one original Chat into one fresh destination Chat. All canonical graph participants must have explicit fresh imported identities in that organization; external control participants, multiple resource generations, recovery chains, unknown effects, expired lifetimes, Decision suspensions, communication-owned artifacts and missing reference closure refuse. Request-update-owned artifacts require actual fresh canonical content and explicit import map entries. The shared tree resolver has a separate opt-in for retained resource evidence used only by this operation/provenance; ordinary original-audience restoration keeps its existing resource refusal. Branch must capture an issued resource frontier and its bytes together, not reuse an earlier pre-opening package for a later Request cut.

No automatic staging retry, failed-import revival, unknown-effect replay or abandoned reservation reclamation is supplied. Import compensation may clean its own partial bytes/Agents, while the durable reservation remains held for owner reconciliation. The bounded consumer now supplies issued capture, executable continuation, real custody/disclosure adapters, managed Chat reservation, acceptance/budget, staging and single-owner receipts. Unsupported families and abandoned-stage reclamation remain refused. General tree/multi-resource execution is not qualified. Deferred regression source is in `tests/branches/destination-admission.test.mjs`.

Lifecycle integration must explicitly reconcile/remove admission/member rows only after its historical canonical references and any staged destination runtime/bytes are safely retired. Retained source deletion fails closed on these pins; do not bypass them or directly delete admission rows to make deletion succeed.


## Branch human disclosure adapter (source integration)

The server now provides `BranchDisclosureReviewService` and operator-only
preview/approve/revoke/command-readback endpoints documented in
`branches-public-engine.md`. Its bound `authorizeDisclosure` function implements
the existing host callback using an exact durable human choice; it does not admit
or grant anything itself. `inspectCoordinationDestinationDisclosure` is a host-only
staged preview using the same retained inventory builder and destination checks,
without a permissive approval callback. `destinationDisclosurePolicy` shares the
policy projection with admission and includes actual policy-layer revisions.
The composer must reserve with host constant `BRANCH_DISCLOSURE_OPERATOR`, complete
actual staging, obtain the explicit human choice, and supply this callback alongside
its real current custody/owner adapter. The bounded `BranchIssuedDestinationService` supplies prospective managed identities, actual staging, current byte/owner verification and final Branch composition.
Tests/builds/types/runtime execution remain deferred; this is source coverage only.


## Connected bounded Branch composer

The server operator endpoints under
`/api/branches/:id/executions/:executionId/destinations` now implement:

- GET: canonical discovery of the latest 50 reserved/staged/admitted destination
  summaries. It returns real `admissionId`, command key, selected checkpoint and
  destination identities, including after restart. It never constructs an ID in
  the browser. Admitted summary discovery does not disclose the graph receipt.
- GET `?commandKey=...`: exact durable command inspection. Admitted readback
  validates Runtime maps/owner/import/activations and the saved final checkpoint;
  it reads neither source packages nor current source participant objects.
- POST `{commandKey,checkpointId,expectedHash,reconcileEffects:true}`: reserve and
  prepare. Optional `accessSettingsResolution` uses the existing import schema.
  Current support refuses nonempty source restriction settings rather than
  silently dropping them. The server uses the existing `workspaceCreationId`
  Project/default Chat identities and managed `createChat` service, reserving
  BEFORE publication, with fresh Branch manual acceptance and execution budget
  admission. It stages actual import source-ref maps before Agent publication.
- GET/POST the existing `/:admissionId/disclosure` operation for exact explicit
  human review. Import reaches durable `canonical_committed` with a dedicated
  prepared result, remains hidden/idle, and returns `awaiting_disclosure`; no
  long-lived HTTP request, process-local promise or SQLite transaction holds the
  human wait. Restart recovery retains the prepared import. No automatic approval.
- POST `/admit` `{commandKey,reviewHash}`: requires the current approved HUMAN
  preview hash, then recomputes Runtime's separate current authority review hash.
  The final transaction synchronously re-verifies the independent issued receipt
  and custody bytes, exact `hostCutSha256`, current source/destination ownership,
  pins, policies and budgets. `composeIssuedDestination` uses the sealed codec and
  inserts mapped actual Step/attempt/resource/member/context rows, fresh Chat and
  import receipts, counters, lineage/owner command, completed import and a final
  saved selected checkpoint before Runtime releases final-only wakes/readiness.
  It creates no new native effects or intermediate historical wakes. Exact
  admission replay checks the saved human-hash command before package access;
  changed input conflicts. Current disclosure permission still governs readback.

One standalone nonsecret serial generation-zero ASYNC/SYNC resource is supported.
Package/runtime artifacts, memory payloads, native working copies, source
restrictions, elevated automatic management permissions, missing old envelopes,
unknown effects and broader codec cases explicitly refuse. The browser approval
surface remains separately owned. This does not enable ordinary rewind or claim
full resource-family restoration.

Admitted resources enter the existing exact-member Branch cleanup lifecycle with
new operation/context receipts. Unknown/partial imports and abandoned reservations
remain durably held; they never reallocate staged identities, auto-retry unknown
native effects, release source custody or bypass source retention pins. Automatic
abandonment reclamation/removal of admission lineage is still unsupported. The
original Project audit scope remains required for disclosure and receipt access.

Deferred source fixtures cover ASYNC/SYNC reserve/stage/approval/admit/restart,
no preapproval activation or executable rows, current custody failure, policy
revision drift/revocation, final readiness and exact replay without package access.
They use inert package/folder adapters and have not been executed. They do not
constitute runtime qualification.
