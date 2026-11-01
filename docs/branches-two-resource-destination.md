# Bounded issued resource-group destination consumer

The host source connects one standalone Branch execution with **2–32** distinct
generation-zero ephemeral organizations, in serial or local parallel control flow.
Every resource must have issued its own opening Request. The shared Script/control/
parallel replay validates the entire selected graph and owned audit prefix, including
each resource's reservation, Chat/import operations, opening payload/root/Step,
member/context/creation receipts and selected completion evidence. Parallel operation
state is keyed by resource Step, so interleaving cannot borrow another resource's
completed import. No slot is assigned a fixed completed/waiting role: serial topology
requires earlier Steps to finish to reach later resources, while parallel cuts can
have multiple open roots and completed roots in any resource slot. All source native
providers/processes must satisfy the existing capture drain fences and participants
must remain present through sealing. These source checks are not new observed-exit
receipts or provider qualification.

Parallel cleanup-held frontiers still refuse: the shared codec does not validate
that terminal cleanup boundary. Called trees, later generations, resource retries/
recovery, secret bindings and additional resource families remain refused.

## Exact capture and operator flow

Operator-only routes under `/api/branches/:id/executions/:executionId/destination-groups`:

- `POST /capture {commandKey}` reserves the whole exact selected/host/audit frontier,
  then captures each resource's actual private package through the existing engine.
  Each source receipt binds that same frontier/host digest and its own Chat/member
  inventory. Synchronous seals recheck current pins/frontier/replay. Only all resource seals
  produce one retained checkpoint. Incomplete capture blocks cleanup; changed cuts
  refuse and require lifecycle work rather than reconstructing old bytes.
- `POST` with existing Branch issued destination input `{commandKey,checkpointId,
  expectedHash,reconcileEffects:true,accessSettingsResolution?}` validates every
  retained package, reserves one destination execution/budget, all Step/attempt
  maps, a fresh Project and one fresh Chat per resource under ONE Runtime group reservation.
  Current source custody, owner/version/configuration/binding, resource retirement,
  native/import/request cleanup and destination owner are rechecked. A changed retry
  command conflicts. Read the exact command before attempting ambiguous work again.
- The canonical Project writer creates a fresh ordinary Project using the current
  owner Project's existing directory. No package working root/copy is activated.
  It also creates its usual default Chat; the separately reserved resource Chats
  are Branch/execution-owned through the canonical Chat writer. This slice restores
  identities and private state, not a separate filesystem workspace. Only source
  packages without artifacts, memory, working roots, restrictions or elevated grants
  are accepted; the importer additionally enforces its prepared-hold limits/roles.
- Imports run sequentially with `holdForDisclosure`, releasing the same-Project lock
  after each durable prepared receipt. Every stage supplies actual fresh maps before
  Agent effects. A persisted uncertain slot stays held; it is never reallocated.
- `GET /:admissionId/disclosure` returns the whole exact original private fact
  inventory, original actors/audiences, mapped recipients and every final policy.
  `POST` there uses the existing explicit human approve/revoke DTO with revision CAS.
  The distinct group authority checks every resource. No approval is synthesized.
  Revocation remains possible without package bytes/current preview.
- `POST /admit {commandKey,reviewHash}` requires that current human approval. Nested
  `finishDestinationImport` validation wraps ONE synchronous Runtime group admission.
  The composer inserts one remapped frontier, all resources/current members/contexts,
  all actual import receipts and separate resource owner command receipts referencing
  the SAME whole graph. Every issued root is bound once to its mapped actual Step.
  All completion callbacks run before Runtime verifies all owners and final policy,
  commits the one admitted state and publishes frontier wakes. No independent admits.
- Final historical snapshot/owner readiness receipts are captured AFTER Runtime admit
  returns but before the SAME outer transaction commits. Any failure rolls back every
  import's completion, graph, owners, readiness and admission command together.
- `GET ?commandKey=...` and exact repeated admission read canonical group provenance,
  maps, owners, imports and final checkpoint without package bytes or reimport/wakes.
  Persisted disclosure revision/state/reviewHash and every destination are discoverable.
  Current disclosure revocation may deny receipt content; no revoked fact is exposed.

The existing singular endpoint stays strict. The group readiness fence covers every
resource slot/ancestor. Separate whole-group destination retirement is integrated in lifecycle-reconciliation.md;
this consumer adds no capture abandonment, history release or unknown effect reconciliation. A
partial group capture has no abandonment command in this slice and remains held.

`GET /capture?commandKey=...` reads the retained capture intent without trying to
recapture a changed live frontier. Its shared DTO reports each source seal, capture
state, whether this incomplete capture holds cleanup, and `abandonment: unsupported`.
A failed or unknown member capture retains **all** group cleanup pins, including
already sealed members. The last exact seal alone creates the shared checkpoint.
Status readback verifies canonical journal bytes, complete unique source inventory,
receipt bindings and, when retained, the exact saved checkpoint. There is no delete,
release, synthetic retirement receipt or silent conversion to singular abandonment.
Reliability has been notified of the exhaustive group abandonment adapter boundary;
no new lifecycle hook or migration is added. Existing lifecycle0040 schema is unchanged; singular retirement still refuses groups,
while the separate whole-group destination protocol requires exhaustive proof. `cleanupHeld:false` on a fully sealed capture
only describes that capture; it does not release destination or history custody pins.

## Deferred verification source

The existing real SQLite/inert-package host fixture now generates N resource Steps
and serial or fork/join owners. Additional unexecuted source cases cover ASYNC/SYNC
serial 3/32 and local parallel 2/3/4/32 groups, completed non-first parallel slots,
all per-resource owner/issued-Step/whole-graph/readiness receipts, only selected open
root wakes and no-byte restart readback. Three-resource serial/parallel cases inject
the last completion failure and require whole rollback, then change the last Chat
policy and require a new human choice. Partial last-package failure asserts all
cleanup pins survive restart, only earlier seals exist, no shared checkpoint is
published and abandonment is explicitly unsupported. Count 1/33 capture refusals
and multi-resource audit/custody/member tampering are also deferred source. Prior
two-resource cases remain. These fixtures use real Branch/Runtime/Chat/Request/
choice/transaction writers with inert package/import/provider adapters.

No tests, checks, builds, typechecks, Node/native/browser processes, runner preparation
or migrations were executed. The separate UI eba8fa646 offers exactly two serial resources; 2–32/parallel UI remains absent. No separate filesystem workspace, capture abandonment or later-generation partition is implemented in this consumer. Separate
group destination retirement source is integrated, with execution still deferred. Source capability
is not provider/native/runtime qualification, parity or Phase 2 acceptance.

## Canonical group discovery and capture comparison

The operator-only `GET /api/branches/destination-groups/discovery?kind=captures|admissions&limit=50&cursor=...` returns bounded pages (1..100). The opaque cursor binds the kind and current connection/database revision; any intervening database write or daemon restart conservatively refuses with 409 and requires a fresh first page. Discovery reads retained owner journals, canonical admission reservations and retirement tombstones without requiring live destination Agents/Chats or invoking admission, importing packages, or dispatching work. It returns original prepare keys, source Branch/execution identities, admission/checkpoint identity, resource count, canonical state and source owner presence. Prospective capture items also return the saved review hash/version for exact interrupted-command recovery. Deleted destination identities do not suppress retained records. Source journals remain constrained by existing custody/owner pins; this does not invent evidence after journal reclamation.

New capture journals retain their exact original command key, selected-cut review hash and version. Legacy journals without the original capture key return `discovery: unsupported_legacy_key` with no key. A hash cannot recover that key. Existing callers holding a legacy key retain the unchanged exact GET capture status; discovery never guesses a key or replays POST.

Before a new capture, `GET .../destination-groups/capture-preview` performs the same authoritative serial/local-parallel codec eligibility, complete host-cut, generation-zero inventory, current owner/binding/configuration and participant drain validation as reservation. It performs no writes, allocation or package effects. Its result includes `reviewHash`, `versionId`, `bindingRevisionId`, `frontierHash`, `hostCutHash` and all 2..32 resource Steps/Chats/generations/participants. `POST .../destination-groups/capture` now requires exactly `{commandKey,reviewHash,versionId}`. The owner transaction recomputes and compares the preview before allocating package IDs or recording intent. Changed cut/version refuses without package effects. Each still-unsealed member rechecks the review before its package call; seals retain their existing transaction revalidation. A changed cut never reallocates an existing intent. A retained exact command reads saved seals without recapturing; reuse with another preview refuses.

Core exports `BranchGroupDiscoveryPage`, `BranchGroupCapturePreview`, `BranchGroupCaptureInput` and `BranchGroupCaptureResult`. SDK helpers are `discoverDestinationGroups`, `previewGroupCapture`, `captureGroup` and `groupCaptureStatus`. GET status preserves its prior shape. POST capture returns the retained checkpoint and actual receipt inventory, a different shape. UI6b1f7a398 now supplies the required exact preview/CAS body and canonical discovery; the prior commandKey-only mismatch is resolved. Exact GET recovery remains available. A separate backend preview read-transaction correction remains unassembled; see current implementation coverage. Discovery is private operator audit, inherited from the existing route authorization hook, and must never be exposed through an Agent token.

Partial group abandonment remains unsupported with all member pins held. This does not enable historical generations, provider/native replay, or broaden the artifact/secret/memory/root limits. Deferred regression source covers preview purity/stale comparison, exact and legacy discovery, pagination/reopen/invalidation and existing serial/parallel 2..32 capture flows. No executable qualification was performed.

## Atomic partial-group capture disposition

Branch now provides `custodyLifecycle.inspectGroupCapture(executionId,captureKey)` and `abandonGroupCapture(input,confirmPackagesRetired)` for the separately owned all-package host adapter. `captureKey` is the exact raw SQL `issued-group-capture:<sha256(original command)>` key, including legacy journals. The inspection returns raw intent hash, state, complete 2..32 sources and existing sealed receipts, per-source custody/source hash/revision/references/abandonment blockers, whole revision and eligibility. Only `capturing` journals with every source drained and no references except their exact own group intent qualify. Retained checkpoints and other admissions/commands remain pins. Open related Joins and question suspensions also hold.

Input is `{executionId,captureKey,commandKey,captureSha256,expectedRevision}`. One same-owner unit transaction calls the synchronous callback exactly once with `{sources,receipts}`. It requires exactly one durable `{custodyId,sourceSha256,revision}` proof for EVERY source, including never-sealed members; deterministic custody IDs derive from original checkpoint IDs. Missing, duplicate, changed or asynchronous proof inventory refuses the entire disposition. Evidence is rechecked after the callback. Exact replay calls the callback once to verify the identical retained durable proof set. The host callback must therefore provide idempotent journal readback, not duplicate effects.

One canonical `branch-group-custody-abandon.v1` command retains the exact input, original raw capture JSON, all original source/receipt bytes and proof inventory. Original capture rows are preserved. Verified disposition blocks reserve/seal revival and atomically removes only that group's cleanup/reference pins; unrelated pins remain. Raw status stays `capturing` with optional `disposition: abandoned` and `cleanupHeld:false`; its old `abandonment:unsupported` field still means the ordinary capture endpoint cannot perform abandonment. The dedicated host adapter owns actual tombstones/archive preservation, human review and HTTP support. Canonical hooks do not independently claim package retirement or delete bytes.

New deferred canonical proof fixture and actual existing Branch group fixture source remain unexecuted; no qualification claim.
