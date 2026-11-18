# Chroma to canonical memory: migration design and prerequisites

Status: **design only, not implemented or qualified.** This describes a possible
migration for existing installations; it is not a runbook authorizing production
actions. The normal Chroma service, its policy database, user data and live
instances were not changed. Source reviewed: integration
`8722aa252bd068af8e060fad86e4d4fc822d074a`; disabled canonical-backend
draft `e5e9cb832db3a990093d681fda220b2a3a2a7729`. The draft is changing and
must be rechecked before implementation.

## Current evidence and boundaries

- Chroma is configured through an arbitrary URL and prefix; a process-local
  `raw.exclusive` queue cannot exclude another client. The installed client
  has no identified all-collection atomic snapshot, independent-writer fence or
  drain-and-cutover operation. A backend call may have an unknown outcome.
  [Chroma's collection-fork documentation](https://docs.trychroma.com/cloud/features/collection-forking)
  describes Cloud, per-collection forks; it does not establish a local,
  all-scope snapshot or a fence that persists through cutover.
- The canonical database's `local_memory_host_binding` binds data generation,
  source principal, storage identity and physical policy custody. Scope intents
  bind that same source plus project and collection creation identities. The
  separate host policy database holds the global-memory grants. Pre-0044
  scopes may have no retained historical collection UUID. Submitted creates or
  remote mutations with unknown outcomes remain held. Those gaps cannot be
  reconstructed from a matching name or copyable metadata.
- Current Chat package export deliberately excludes global memory and some
  staged rows, has 16 MiB and 10,000-row limits, and import remaps IDs and
  provenance. It is not a lossless installation migration. The draft canonical
  adapter also has a 10,000-row staged-session inventory bound and no migration
  staging or established-binding cutover API.
- A new SQLite backend would not migrate or clean existing Chroma data by
  itself, and does not resolve the existing Chroma cleanup/rollback failures
  until a specific installation has a safe, qualified transition.

## Proposed migration authority

1. **Review and freeze.** Present the exact installation/data generation,
   Chroma endpoint and namespace, physical policy custody, principal, scope
   states, target and preservation consequences. Obtain approval immediately
   before any production migration, service interruption or destructive
   operation. A supported backend or infrastructure authority must then drain
   all previously submitted operations and enforce exclusion of *every*
   independent source writer and policy mutator through cutover. Record
   durable, authenticated source identity and the precise barrier generation;
   fail closed if the authority cannot be verified or maintained. A user
   checkbox, repeated equal reads, a process-local queue, an advisory lock or a
   client-supplied assertion does not establish this barrier.
2. **Inventory and stage.** With the barrier continuously held, capture a
   complete, ordered census of all relevant source collections and records,
   including both collection types, global and private Chat audiences,
   hidden/pending package records, conflicts and references, vectors,
   collection IDs, source stamps, creation intents, policy grants, ownership
   and generation, and unresolved evidence. Preserve valid finite legacy
   zero vectors and exact identities. Use bounded, resumable streaming into
   an unpublished, distinct destination; the 10,000-row and package-transfer
   limits above are not a complete installation census. Independently validate
   count and identity coverage, metadata, vector representation, lineage,
   conflict references and scope/Agent ownership. Hold on unknown foreign,
   missing, duplicate, malformed or unprovable data; retain it at source.
3. **Atomic cutover.** In a canonical immediate transaction, recheck the
   barrier, old binding and physical policy custody, current grants and
   lifecycle ownership, source/effect holds, exact staged census and target
   revision. Reject unsettled target delivery results, pending or unknown MCP
   calls, and active or unknown provider incarnations/episodes. Only then
   atomically install the complete new binding, scope receipts, grants and
   data plus a durable cutover receipt and preserved prior-binding reference.
   Preserve the source principal and row identities where needed for existing
   provenance; do not manufacture retroactive UUID proof. Startup and restart
   must select a backend solely from the committed binding and receipt.
4. **Recovery and rollback.** Persist each phase and its exact receipts so a
   restart can distinguish not-started, staged, committed and uncertain
   outcomes without replaying remote effects. Keep the original policy and
   Chroma data intact. Before any post-cutover target write, a verified
   cutover can be reversed only if the source barrier and both bindings still
   hold. Once target writes may have occurred, restoring the old binding alone
   would lose those writes: hold access and use a separately designed,
   verified reconciliation/forward-repair path. Do not clear unknown outcomes,
   delete either store, or resume old independent writers on an assumption.

## Implementation and validation checklist

- [ ] Supply and independently qualify an enforceable source snapshot and
      writer/policy barrier for the selected Chroma deployment. For arbitrary
      remote Chroma without such an authority, migration remains held.
- [ ] Design explicit review for legacy scopes lacking retained source UUIDs
      and unknown writes without treating a human assertion as backend proof.
- [ ] Implement bounded, complete, unpublished target staging and a
      versioned census/receipt with ownership, grants and lossless metadata.
- [ ] Implement the atomic binding/intent/grant transition and crash-safe
      recovery, with no implicit fallback to a missing or changed store.
- [ ] Integrate canonical delivery, MCP and provider-process fences and
      verify that their unresolved states block cutover.
- [ ] Qualify empty and populated stores, private/global and staged records,
      multi-batch inventory, zero vectors, legacy IDs, unknown writes,
      independent source-writer races, changed policy, target collision,
      interruption at each phase, restart, and rollback before and after
      target writes. Use synthetic disposable stores and no real provider.
- [ ] Present the exact proposed production target and operations for approval
      only after the implementation, review and qualification are concrete.
      No production migration, restart, deletion or external sharing is
      authorized by this design.
