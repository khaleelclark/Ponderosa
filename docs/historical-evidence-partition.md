# Retired evidence with current destination admission

Source implementation only; no checks or qualification executed. The prospective producer at `c5bb4f32a1a7dea5644e994ff4103b5cb484921b` is the prerequisite. Older captures without its sealed original identity/intake-fence/observed-provider/native/host/custody evidence refuse.

The existing canonical singular and whole-group reserve APIs accept optional `CoordinationDestinationReservation.historicalPartition` (also inherited by the group reservation). Each selection is:

```ts
{
 executionId, stepId, generation, checkpointId, checkpointHash,
 envelopeSha256, intakeFence: {identity, sha256},
 discloseTo: [currentSourceAgentRef]
}
```

Copy exact producer `readGenerationExitCapture` seal references. `discloseTo` contains explicit keys from the CURRENT `stage.agentMap`, selected by the human for the complete envelope. It does not map historical identities. One selection discloses every retained fact in that full generation envelope to that explicit current audience; there is no selective omission or actor/audience rewriting. At most 32 selections and 32 MiB total evidence are accepted. Duplicate selections, unmapped recipients, sources outside the sealed original Branch/Project/execution scope, missing or changed seals/retirement links and aliased current/historical Chat/Agent/Request identities refuse. Historical generations must precede the selected current generation of the same resource Step.

Source admission reads the real sealed journal with `readGenerationExitCapture` and its canonical generation-retirement link. Full original envelope, selected frontier, host graph/provenance/update prefixes, original actors/audiences, actual package source/receipt, provider registration/observed-exit ledger, native exit proof and permanent intake fence remain intact. Historical graph validation reuses the canonical reducer/Join/outcome/suspension validators in terminal evidence-only mode. Expired deadlines on settled historical facts remain historical facts; they never become fresh lifetimes or schedulable work. Open/unknown/incomplete facts and runtime artifacts remain held.

Continue with the existing stage, inspectDisclosure, explicit human disclosure choose, review, and admit methods. Preview adds `kind: historical_generation` facts containing full original seal bytes and original audience/actor inventories. The existing host review service verifies original Project audit-read and reads each actual retained package with the real package engine before human approval. The approval revision binds the complete reservation, exact recipients, current final policy, current cut and historical seal hashes. Approval/revocation and policy changes retain their existing stale-refusal behavior. No callback fabricates authority and no provider tool can approve these facts.

The existing graph writer/composer receives ONLY the current executable cut. Historical evidence is never inserted into coordination_requests, request_updates, joins, activations, Agent imports or the current Request/Agent maps. A historical Request cannot also appear as a current root. Historical envelopes are not attached to provider activation payloads. The only new write is an immutable `host_lifecycle_commits` receipt of kind `coordination-historical-partition`, in the SAME owner transaction as graph/import/Branch composition, before readiness/wakes. Rollback removes that receipt with the current admission.

The existing admission receipt includes `historicalPartition` with exact selections, full original seals, hashes, explicit current destination recipients and `historical:true, dispatchable:false`. Current request/update/join maps remain executable-current maps only. Exact readback checks the immutable receipt, reservation/stage/review hash, map and persistent intake/provider evidence. Once admitted, retained receipt bytes support historical readback after original owner journals/snapshots disappear; this is a prior successful canonical admission receipt, not a way to admit missing source evidence. Current human permission/policy and current destination receipt checks remain mandatory. The custody lifecycle reads these immutable records as permanent original package pins; they have no release/reclamation path.

`readDestinationHistoricalPartition` and `destinationHistoricalFacts` are exported from `@ponderosa/agents` for canonical owner/audit composition. They require the owner transaction and grant no dispatch or current admission. Passing a committed admission identity is readback only, requires the exact immutable admission receipt, and cannot publish new proof. The normal reserve/stage/review/admit APIs remain the sole admission path.

Remaining work is separate: Branch must compose a later-generation current cut/retained host and explicitly pass these selections through its retry/destination consumer. Existing issued-resource consumer restrictions are not widened here. A checkpoint containing mixed old/current roots is not silently split or repaired; the current cut must explicitly exclude retired evidence, with complete historical selections supplied separately. No previously deleted preupgrade generation is reconstructed, no provider/native state is restored, and no UI flow or live qualification is claimed.

Deferred regression source extends the real serial/parallel producer fixture: exact sealed proof after original deletion, full-byte preservation, no new Agents/Requests/activations from evidence selection, changed hash/unmapped audience/alias/current-root/missing-journal refusal, immutable receipt exact readback after source removal and transaction rollback. The partition fixture uses inert current destination references and does not qualify a complete real imported destination or provider/package execution.

Branch gen1 integration supplies the narrow serial consumer described in
branch-generation-one-destination.md. Original historical Project identity is
bound by the seal/fence/provider evidence and exact original Branch/execution/
Step; a fresh destination Project need not equal it. Explicit human review now
checks original historical Project audit-read/deletion-pending status separately
from current destination policy in candidate, prepare and final authorization.
No old actor/audience/dispatch map is changed. Broader retry families and all
executable qualification remain separate.

The bounded serial Branch consumer now supplies the complete ordered generation
history through generation 32, with configured maxAttempts <=33, canonical server
preview selection and current-only executable roots. Runtime selection/evidence
byte bounds and explicit current-recipient human disclosure remain unchanged.
The original surviving Chat must match its sealed Project/Branch/execution, while
the destination may have a fresh Project. Exit fencing binds Project via the actual
resource Chat. See branch-generation-one-destination.md for the source-only bound
and deferred actual producer/consumer fixtures; no execution is claimed.
