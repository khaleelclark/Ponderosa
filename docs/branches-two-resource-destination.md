# Two-resource issued destination consumer

The bounded host source now connects one standalone serial Branch execution with
exactly two distinct generation-zero ephemeral organizations. Both must already
have issued their opening Requests; capture while the second Request waits and
the first has completed, with all native providers/processes drained and both
organizations still present. It uses the shared Script/control replay, not a second
executor. Parallel owners, called trees, later generations, retries/recovery,
secret bindings and additional resource families remain refused.

## Exact capture and operator flow

Operator-only routes under `/api/branches/:id/executions/:executionId/destination-groups`:

- `POST /capture {commandKey}` reserves the whole exact selected/host/audit frontier,
  then captures each resource's actual private package through the existing engine.
  Each source receipt binds that same frontier/host digest and its own Chat/member
  inventory. Synchronous seals recheck current pins/frontier/replay. Only both seals
  produce one retained checkpoint. Incomplete capture blocks cleanup; changed cuts
  refuse and require lifecycle work rather than reconstructing old bytes.
- `POST` with existing Branch issued destination input `{commandKey,checkpointId,
  expectedHash,reconcileEffects:true,accessSettingsResolution?}` validates both
  retained packages, reserves one destination execution/budget, all Step/attempt
  maps, a fresh Project and two fresh Chats under ONE Runtime group reservation.
  Current source custody, owner/version/configuration/binding, resource retirement,
  native/import/request cleanup and destination owner are rechecked. A changed retry
  command conflicts. Read the exact command before attempting ambiguous work again.
- The canonical Project writer creates a fresh ordinary Project using the current
  owner Project's existing directory. No package working root/copy is activated.
  It also creates its usual default Chat; the two separately reserved resource Chats
  are Branch/execution-owned through the canonical Chat writer. This slice restores
  identities and private state, not a separate filesystem workspace. Only two source
  packages without artifacts, memory, working roots, restrictions or elevated grants
  are accepted; the importer additionally enforces its prepared-hold limits/roles.
- Imports run sequentially with `holdForDisclosure`, releasing the same-Project lock
  after each durable prepared receipt. Every stage supplies actual fresh maps before
  Agent effects. A persisted uncertain slot stays held; it is never reallocated.
- `GET /:admissionId/disclosure` returns the whole exact original private fact
  inventory, original actors/audiences, mapped recipients and both final policies.
  `POST` there uses the existing explicit human approve/revoke DTO with revision CAS.
  The distinct group authority checks both resources. No approval is synthesized.
  Revocation remains possible without package bytes/current preview.
- `POST /admit {commandKey,reviewHash}` requires that current human approval. Nested
  `finishDestinationImport` validation wraps ONE synchronous Runtime group admission.
  The composer inserts one remapped frontier, both resources/current members/contexts,
  both actual import receipts and separate resource owner command receipts referencing
  the SAME whole graph. Every issued root is bound once to its mapped actual Step.
  Both completion callbacks run before Runtime verifies all owners and final policy,
  commits the one admitted state and publishes frontier wakes. No independent admits.
- Final historical snapshot/owner readiness receipts are captured AFTER Runtime admit
  returns but before the SAME outer transaction commits. Any failure rolls back both
  imports' completion, graph, owners, readiness and admission command together.
- `GET ?commandKey=...` and exact repeated admission read canonical group provenance,
  maps, owners, imports and final checkpoint without package bytes or reimport/wakes.
  Persisted disclosure revision/state/reviewHash and both destinations are discoverable.
  Current disclosure revocation may deny receipt content; no revoked fact is exposed.

The existing singular endpoint stays strict. The group readiness fence covers every
resource slot/ancestor. Runtime group lifecycle pins stay held; no group retirement,
abandonment, history release or unknown effect reconciliation is added here. A
partial group capture has no abandonment command in this slice and remains held.

## Deferred verification source

The historical rewind test source builds a real two-Step serial owner through
canonical resource reserve/Chat/import/opening Request paths; inert adapters supply
package bytes/effects without providers. ASYNC/SYNC fixtures drive whole capture,
source completion/retirement, two staged imports, explicit whole human review,
one admission, actual two owner/resource/issued-Step receipts and no-byte restart
readback. Further source cases cover second-completion rollback then exact retry,
second-Chat policy invalidation, no-byte revocation, omitted custody, changed generation
and removed/rehashed opening audit. Fixture source is unexecuted. Neither these source
cases nor the host changes establish provider/native/transaction/runtime qualification,
UI availability, broad group capability, parity or Phase 2 acceptance.
