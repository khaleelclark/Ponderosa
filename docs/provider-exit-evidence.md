# Observed provider exit evidence

Source API only; fixtures are deferred. This does not enable historical destination admission or a retired-generation Branch capture producer.

`ProviderProcessAuthority` already owns actual engine/runtime handles and restart-recoverable POSIX process identities. Previously its successful `terminateRows`, native `terminateScope`, and `pruneExited` paths discarded the process authority row/handle. They now retain immutable registration and observed-exit evidence in the existing `host_lifecycle_commits` table (migration 0040). No new schema or native/provider API is introduced. Agent deletion already awaits runtime drain and `terminateAgents`; it therefore uses these same writers, but Branch must collect evidence **before** deleting original Agent/Chat/Run state. Completed storage deletion never supplies this proof.

Producer boundaries:

- POSIX registration retains the actual PID, PGID, OS birth marker and optional systemd scope, canonical Agent/Project/Chat, original spawn/turn Run fence (passed from `v3FencingToken` by the actual Run executor), worker and purpose. Persistent sessions preserve every immutable Run rebinding, rather than only their last Run.
- Windows registration retains the existing code-owned native Job lifetime identity, paired with worker and scope. It does not fabricate a Windows PID/birth marker or a recoverable Job API. The existing `ownerIdentity` binds readiness/session facades to the same actual lifetime.
- `pruneExited` writes only after actual `isAlive()` reports false. Termination writes only after awaited `close()` succeeds **and** `isAlive()` reports false. Exceptions or unknown observations leave the authority pending. These observations concern the complete process-group/systemd scope/native Job according to the existing engine handle contract, not merely the root provider's response stream.
- One receipt has operation ID `provider-exit:<authorityId>`, result `observed_exited`, observation kind, observed timestamp and all registration revisions. Its SHA-256 is the receipt revision. Evidence publication and POSIX authority removal share a SQLite savepoint; failed persistence/deletion retains the authority and rolls back publication. Native handles remain retained until publication succeeds.
- A lifetime cannot change Project/Agent/Chat/process ownership. Same-lifetime Run rebinding is allowed. Exact immutable registration replay is idempotent. There is no operator-input receipt writer or HTTP endpoint.

## Branch consumer API

Shared DTOs are exported from `@ponderosa/core`: `ProviderProcessRegistration`, `ProviderProcessExitReceipt`, `ProviderExitEvidence`.

Use `providerProcessAuthority.readExitEvidence(input)` in the server. It observes/prunes actual exited handles, then calls the reusable `@ponderosa/agents` reader:

```ts
readProviderExitEvidence(db, {
  projectId,
  conversationId, // original generation's live Chat
  participants: [{agentId, runIds}], // complete original Chat members and all their Runs
  expectedRevision, // omit on initial reserve, require on seal
}) // -> ProviderExitEvidence
```

This reader is synchronous and uses a nested canonical transaction. It requires exact live Chat/Project/member closure, exact complete original participant Run inventory, terminal known Run states, original registration fences and current terminal fence snapshots, no surviving provider authority and actual observed-exit receipts for every retained registration. A canonical terminal fence may advance beyond the recorded spawn fence during cancellation or recovery; it cannot regress. Both are retained and the terminal snapshot binds the aggregate revision. Every supplied Run must have actual process registration/exit evidence. A Run registration lacking its actual supplied spawn fence refuses capture. Agent-scoped provider commands/recovery without a Run are also included and must have exited, but cannot substitute for a Run's registration. Any missing, new, changed, unobserved, unknown or out-of-scope identity refuses. Missing registration coverage is never equivalent to an empty process set. Bounds are 256 participants, 4096 Runs per participant, 4096 total registrations and 16 MiB of assembled evidence; each ledger value is bounded to 4 MiB.

The evidence includes complete original identity bindings and receipt bytes/hashes plus an aggregate `revision`. It proves observed provider exit only. Branch still owns exact generation/frontier/host/custody bindings, current owner pins, settled Request/Join/effect closure, native script exit evidence and prevention of replacement/cleanup during capture. The caller must hold those gates, reserve the initial evidence with the generation/frontier, perform actual package capture outside SQL, then call the reader with `expectedRevision` inside the same final owner transaction that seals the capture. No await or dispatch may occur between that recheck and seal. A newly registered process, missing process exit or new Run makes the seal stale/held.

After a real Branch seal, retain the exact returned bytes inside its immutable snapshot. `verifyRetainedProviderExitEvidence(db, evidence)` verifies aggregate hash and every original immutable registration/exit ledger value after Agent/Chat/Run removal. It is readback only: it does not authorize new capture, deletion, restoration, admission or execution, and does not reconstruct a missing Branch seal. Persisted evidence hashes must be bound to the Branch generation/host/custody receipt, not supplied afresh by an operator.

## Deliberate holds

Pre-upgrade deleted process rows have no retrospective proof. Legacy live POSIX authority can still be safely drained and retained with empty registration coverage, but that receipt cannot qualify a historical capture. A Run with no recorded provider process remains held by this API; it does not assert that no process existed. Existing prior generations without full precleanup Branch host/custody/exit evidence remain unsupported.

A Windows daemon restart loses the live Job handle. Kill-on-close containment is not an observed exit receipt. Retained native registrations without a successfully recorded observation remain held, even if process authority counts are zero. No absence of rows, operator testimony, scheduler terminal status, deletion completion or signal delivery synthesizes exit evidence.

The deferred fixtures in `tests/organizations/provider-exit-evidence.test.mjs` exercise actual registration/retention reader paths with synthetic process/native handles and canonical ledger schema. They cover unobserved termination, identity/Run coverage, immutable replay, stale revision, owner deletion readback, savepoint failure and Windows restart refusal. They do not qualify real provider/native exit behavior. No execution checks have been run for this source delivery.
