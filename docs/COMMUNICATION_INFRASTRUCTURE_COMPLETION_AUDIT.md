# Communication Infrastructure Completion Audit

Audit date: 2026-07-12  
Branch: `program/communication-infrastructure`  
Scope: implementation readiness, not production cohort approval

## Verdict

The planned implementation is code-complete through the guarded cutover and
production-default routing-retirement stage. The repository proves contract,
persistence, routing, projection, context, lifecycle, backfill, authoritative-read,
scale, recovery, and rollback behavior. Production rollout remains deliberately
gated on human architecture/security review, a real-host backup/restore drill,
cohort SLO evidence, and expiration of the compatibility observation window.
Those operational gates must not be represented as completed by unit tests.

## Requirement evidence

| Requirement | Evidence | Assessment |
|---|---|---|
| Master Chat primary UI | Web Master Chat/Collaboration views, recipient picker, authoritative health consumer; web routing/responsive/identity tests | Implemented and verified |
| Master Chat contains shared organizational knowledge | Main writes canonicalize as broadcasts; agent-to-agent delivery is confined to Collaboration; local/direct events classify `local_only` | Implemented and verified |
| Local conversations excluded from shared context | Individual history remains thread-scoped; Collaboration context is delivered only to explicit recipients; golden promotion tests exclude raw local source | Implemented and verified |
| Explicit Broadcast / Direct-to-user / Collaboration intents | `CommunicationIntent`, `/api/agent-messages`, runtime prompt, validation tests | Implemented and verified |
| Server owns routing and mention rendering | Stable `recipientAgentIds`, explicit resolver, UI sends IDs, production rejects mention routing | Implemented and verified |
| Direct Agent Chat is an audit timeline | Direct turns and output have canonical events plus `direct_agent_audit` projections; authoritative Direct reads use projection metadata | Implemented and verified |
| One event, many projections, no duplicate records | Project event log plus tuple-unique projection ledger; multi-surface/idempotent retry tests | Implemented and verified |
| Collaboration requires explicit recipients | Empty/stale/non-member validation; production-default legacy rejection; recipient-picker tests | Implemented and verified |
| Curated shared history | Explicit classification and provenance-linked promotions; fresh-seed-only summary injection; cursor/compaction boundaries | Implemented and verified |
| Stable immutable IDs and hierarchy | UUID thread/agent IDs, server-bound delegation lineage, parent/child health projection and depth controls | Implemented and verified; effective-dated reassignment remains a pre-multi-tenant concern |
| Eight lifecycle states and manager visibility | Health DTO/projector/UI, durable running/terminal/cancel transitions, compaction state, leases, aggregate project/room endpoints | Implemented and verified |
| Bounded supervision without storms | Exception-oriented policy, one adaptive aggregate UI poll, no per-agent polling, 1,000-agent projection test | Implemented and verified |
| Persistence, receipts, audit, recovery | Fsynced repairable JSONL, delivery ledger, idempotency receipts, restart interruption recovery, SQLite rebuild tests | Implemented and verified |
| Migration and rollback | Independent capture/read/context/routing flags, deterministic dry-run backfill, readiness fail-closed, two read rollback rehearsals | Implemented and verified in repository; production rehearsal pending |
| Scaling to thousands | O(1) canonical append indexes, sustained 500-event test, 1,000-agent health test, bounded recipient and retry limits | Verified for single-daemon target; distributed multi-writer is explicitly out of scope |

## Deliverable audit

The requested executive assessment, roadmap, phase breakdown, per-phase staffing,
dependency graph, risks, tests, rollback, migration, success criteria, execution
organization, span-of-control policy, and pre-implementation concerns are all in
`COMMUNICATION_INFRASTRUCTURE_PROGRAM.md`. Each phase records its objective,
deliverables, dependencies, risks, testing, migration/rollback, staffing, and gate.

## Verification map

- Core contracts: `packages/core/src/communication.ts`, `packages/core/src/dto.ts`.
- Canonical persistence, backfill, projection reads, reconciliation, restart repair:
  `packages/threads/src/store.ts` and `packages/threads/test/store.test.ts`.
- Routing, capabilities, context boundaries, readiness, lifecycle transitions:
  `apps/server/src/app.ts` and `apps/server/test/app.test.ts`.
- Health/lease aggregation: `apps/server/src/agent-health.ts` and its tests.
- Explicit recipient UI and adaptive aggregate supervision:
  `apps/web/src` with `collaborationRecipients`, `agentStatus`, routing, responsive,
  sender-label, and interaction tests.
- Operator migration, backup, restore, and rollback instructions: `deploy/README.md`.
- Per-cohort executable gate and evidence checklist: `deploy/COMMUNICATION_CUTOVER.md`.

Repository gates required on the final SHA:

```text
git diff --check
pnpm typecheck
pnpm test
```

## Operational gates still requiring evidence

1. Architecture, security/privacy, SRE, product/UX approvals at their named gates.
2. A quiesced backup and clean-directory restore on the target host, including
   authoritative reconciliation after a projection rebuild.
3. Two production-like cohort rehearsals with recorded SLOs and rollback duration;
   repository tests rehearse mechanics but cannot substitute for host evidence.
4. A clean observation window with `PONDEROSA_LEGACY_ROUTING=reject` before deleting
   the opt-in compatibility parser and legacy-only storage.
5. A retention/erasure decision before public multi-user or multi-tenant use.

Any failed item keeps the rollout at its current cohort. It does not justify
deleting canonical events, bypassing readiness, or expanding the organization.
