# Communication and Organization Infrastructure Program

Status: active program plan  
Owner: Program Director  
Strategy: gated strangler migration; no big-bang cutover

## Architectural invariants

1. A communication is recorded once and may have many projections.
2. Agents request semantic intents; the server owns routing and mention rendering.
3. Collaboration always has one or more explicit stable agent-ID recipients.
4. Display names and handles are mutable presentation attributes, never identity.
5. Visibility in a chat or audit timeline does not imply future-context eligibility.
6. Local and collaboration messages remain local unless an authorized promotion record makes selected knowledge organizational.
7. Canonical logs are append-only; SQLite and chat surfaces are rebuildable views.
8. Delivery is at-least-once and presentation is idempotent.
9. Supervision is event-driven; polling is bounded, jittered reconciliation only.
10. Every rollout unit has a feature flag, reconciliation measure, and rollback owner.

## Current-state assessment

Ponderosa already has immutable thread event logs, rebuildable SQLite projections,
stable UUID thread/agent identities, durable collaboration inboxes, idempotency
receipts, delegation lineage, and lifecycle audit events. The primary gaps are the
channel-and-mention agent API, Master Chat's append-only context semantics,
fragmented communication persistence, incomplete organization health projections,
and lack of explicit knowledge-promotion records.

The first migration seam is `/api/agent-messages`. Newly seeded runtimes use
`broadcast`, `direct_to_user`, or `collaboration` intents. Collaboration supplies
stable recipient IDs and the server renders handles. The old channel/mention shape
is rejected by the production default; a restart-scoped `accept` mode remains
only for a time-bounded old-session rollback cohort and is not advertised.
Agent-originated intents are now shadow-written once to the project's fsynced
`communication-events.jsonl`; existing room and thread logs remain authoritative
until reconciliation and projection rebuild gates are satisfied.
New projection records carry `communicationEventId`. The store can reconcile each
project for missing, duplicate, and orphan links entirely from canonical disk
records, and linked Direct Agent audit projections survive a SQLite rebuild.
Every new canonical event also receives an explicit context classification:
broadcasts are organizational candidates, while collaboration and direct-user
events are local-only. Local knowledge becomes organizational only through an
idempotent, provenance-linked promotion record created by the operator endpoint.
Active, non-superseded promotion summaries are injected only when seeding a fresh
runtime. The underlying local text is never injected, and resumed sessions do not
receive repeated context packets.
Manager broadcasts, direct replies, and Collaboration writes now enter the same
canonical log and carry their event ID into legacy projections. Recipient-free
Collaboration is rejected before persistence; the old mention-parsing request is
available only when the explicit legacy-routing rollback mode is enabled.
Projection identity is recorded separately from events and delivery state.
Multiple surfaces for one event are valid; only repeated
`(eventId, surface, projectionKey)` tuples are duplicates. Startup repairs the
ledger from linked canonical room/thread records before reporting migration parity.
Direct manager turns, queued turns, delivered Collaboration entries, normal agent
text, and agent report-backs now retain canonical causation and project into the
appropriate Direct Agent audit, agent inbox, user inbox, Master, or Collaboration
surfaces without creating another underlying communication record.

## Delivery phases and gates

| Phase | Deliverable | Gate |
|---|---|---|
| 0. Baseline | producer/consumer inventory, invariants, SLO baselines | all paths classified |
| 1. Contracts | identity, event, routing, lifecycle, context contracts | architecture/security/operations approval |
| 2. Foundation | canonical envelope, idempotent persistence, shadow capture | 99.99% reconciliation |
| 3. Routing | typed intents, explicit recipients, unified projections | zero recipient-free collaboration; replay-safe |
| 4. Supervision | lifecycle leases and manager health projection | bounded load and accurate stale detection |
| 5. Knowledge | promotion, provenance, compaction checkpoints | no local-context leakage in golden corpus |
| 6. Interface | Master Chat primary UI; Direct Agent audit projection | cohort workflow and routing targets met |
| 7. Cutover | scale, chaos, recovery, authoritative reads/writes | two successful rehearsals |
| 8. Retirement | legacy disable/observe/remove | rollback window expired |

Phases 4 and 5 may overlap only if integration and review queues are healthy.
Every other phase is sequential. A phase can proceed, proceed with conditions,
repeat targeted work, or stop for architectural revision.

## Phase controls and success evidence

### Phase 0 — baseline and inventory

- Objective/deliverables: enumerate every producer, consumer, durable log, inbox,
  projection, context boundary, delivery receipt, and lifecycle transition; record
  reconciliation, queue, context-size, and manager-polling baselines.
- Dependencies/staffing: Program Director plus one platform engineer and fractional
  SRE/product review; no delivery team and no schema changes.
- Risks/tests: missed hidden producers are the principal risk. Trace a manager turn,
  agent output, direct reply, Collaboration delivery, retry, delegation completion,
  cancellation, and restart end-to-end.
- Migration/rollback/success: read-only phase. It succeeds only when every path is
  classified by intent, authority, persistence, projection, and context eligibility.

### Phase 1 — contracts and identity

- Objective/deliverables: immutable global agent IDs; parent/child lineage; typed
  communication, delivery, projection, lifecycle, classification, and promotion
  contracts; routing and span-of-control invariants.
- Dependencies/staffing: baseline approval; 2–3 platform engineers with security
  and privacy review. One contract owner controls shared types.
- Risks/tests: identity reuse, hierarchy cycles, ambiguous audiences, and schema
  lock-in. Use contract fixtures, invalid-recipient tests, idempotency collisions,
  cycle/depth tests, and backward-readable version fixtures.
- Migration/rollback/success: additive versioned fields only. Old readers continue;
  rollback ignores new fields. Success means names never select identity and every
  Collaboration event has at least one stable recipient.

### Phase 2 — canonical foundation

- Objective/deliverables: fsynced project event log, explicit classification log,
  promotion log, projection ledger, O(1) append indexes, repairable tail handling,
  and reconciliation API.
- Dependencies/staffing: Phase 1 contracts; 3 platform/data engineers, one reviewer.
- Risks/tests: dual-write drift, torn appends, duplicate events, and non-tail
  corruption. Exercise kill-during-append, restart rebuild, collision, multi-surface,
  sustained-write, and SQLite deletion/rebuild tests.
- Migration/rollback/success: shadow capture is independently disabled with
  `PONDEROSA_COMMUNICATION_MODE=off`; canonical records are never deleted on
  rollback. Success requires zero missing/orphan/classification drift.

### Phase 3 — routing and projections

- Objective/deliverables: intent API, server-owned routing/rendering, explicit
  recipient picker, durable agent inbox, user inbox, Master/Collaboration/Direct
  audit projections, receipts, bounded at-least-once retry, and FIFO barriers.
- Dependencies/staffing: clean foundation reconciliation; 3–4 API/UI engineers.
- Risks/tests: unauthorized delivery, retry fan-out, duplicate presentation,
  recipient removal, and queue storms. Test capability abuse, empty/duplicate/
  stale recipients, failure retry, cancellation, batching, and 50+ queued turns.
- Migration/rollback/success: legacy routing is a separately observable switch.
  Success means new prompts contain only semantic intents, recipient-free writes
  fail before persistence, and each event renders once per projection tuple.

### Phase 4 — lifecycle and supervision

- Objective/deliverables: durable execution generations and terminal states,
  bounded leases, restart interruption recovery, project/room health aggregates,
  hierarchy visibility, adaptive aggregate polling, and incident deduplication rules.
- Dependencies/staffing: stable identity/lineage; 2 platform engineers plus SRE.
- Risks/tests: false stale detection, heartbeat/poll storms, lost cancellation, and
  manager overload. Test all eight states, lease expiry, crash recovery, cancellation,
  1,000-agent aggregation, active/idle poll backoff, and subtree lineage.
- Migration/rollback/success: health is a projection; disable the UI consumer to
  fall back without changing logs. Success is fresh manager visibility with one
  bounded aggregate poll and no per-child wake loop.

### Phase 5 — context and knowledge

- Objective/deliverables: local-only versus organizational classification,
  provenance-linked operator promotions, supersession/expiry, bounded session
  history, cursor checkpoints, and explicit compaction rollover.
- Dependencies/staffing: canonical event identity; 2 platform engineers with
  privacy/security and product review.
- Risks/tests: local data leakage, corrupt summaries, repeated injection, and lost
  provenance. Golden prompts prove Collaboration/direct source text never enters
  future-agent context; promotion, expiry, resume, and rollover tests cover edges.
- Migration/rollback/success: `PONDEROSA_CURATED_CONTEXT=off` stops injection while
  retaining records. Success is zero leakage in the corpus and every injected
  summary resolving to an authorized source event.

### Phase 6 — primary interface

- Objective/deliverables: Master Chat as the primary manager UI, separate explicit
  Collaboration composer, Direct Agent audit timeline, authoritative roster health,
  accessible recipient selection, and stable author labels.
- Dependencies/staffing: routing, supervision, and knowledge gates; 2–3 UI/API
  engineers plus UX/accessibility review.
- Risks/tests: accidental audience selection, hidden local context, stale status,
  and mobile regressions. Test keyboard/paste, responsive layout, sender identity,
  recipient ID payloads, routing separation, and adaptive health refresh.
- Migration/rollback/success: UI can roll back independently while new APIs remain.
  Success requires cohort users to complete broadcast, direct, collaboration,
  inspection, cancellation, and promotion workflows without routing syntax.

### Phase 7 — migration and authoritative cutover

- Objective/deliverables: deterministic historical backfill, explicit resolution
  for ambiguous recipients, canonical DTO parity, authoritative room/direct reads,
  readiness fail-closed gates, scale/chaos recovery, and two rollback rehearsals.
- Dependencies/staffing: Phases 2–6 green; 3 platform/SRE engineers and release owner.
- Risks/tests: partial backfill, read divergence, old-binary incompatibility, and
  restore failure. Dry-run/apply/retry/restart tests, projection rebuild, sustained
  load, torn-tail recovery, authoritative parity, and two cutover/rollback passes
  are mandatory.
- Migration/rollback/success: cohort order is shadow → backfill → reconcile →
  authoritative. `PONDEROSA_COMMUNICATION_READ_MODE=shadow` is the immediate read
  rollback. Success requires HTTP-200 reconciliation and ready status throughout
  both rehearsals, with no canonical data mutation during rollback.

### Phase 8 — contract retirement

- Objective/deliverables: reject mention-parsed routing and the agent `channel`
  wire by default, observe rollback cohorts, then remove compatibility code and
  legacy-only storage after the retention window.
- Dependencies/staffing: clean authoritative cohorts and expired rollback window;
  1–2 platform engineers with release/security approval.
- Risks/tests: stranding an old session or deleting the only readable history.
  Test explicit intent success under rejection, legacy 4xx/410 behavior, old-session
  rollback mode, backup restore, and repository searches for retired consumers.
- Migration/rollback/success: `PONDEROSA_LEGACY_ROUTING=accept` is time-bounded and
  audited. Success means production defaults reject, no current prompt/UI emits the
  old shape, and compatibility removal occurs only after observation evidence.

## Dependency graph

```text
Baseline (0) → Contracts/identity (1) → Canonical foundation (2) → Routing (3)
                                                            ├→ Supervision (4) ─┐
                                                            └→ Knowledge (5) ───┤
                                                                                ↓
                                                                      Interface (6)
                                                                                ↓
                                                              Backfill/cutover (7)
                                                                                ↓
                                                                    Retirement (8)
```

Security/privacy review gates Phases 1, 3, and 5. SRE/release approval gates
Phases 4, 7, and 8. A failed gate returns to the owning phase; it never bypasses
the dependency edge by adding more agents.

## Supervision policy

- Publish lifecycle transitions immediately.
- Renew an execution lease every 30–120 seconds while active; do not emit chat.
- Treat three missed intervals as stale, subject to measured clock-skew bounds.
- Notify managers immediately only for blocked, failed, unexpected cancellation, expired lease, or breached deadline.
- Produce one deduplicated 5–15 minute health digest while a subtree is active.
- Reconcile hierarchy and leases centrally on a jittered 15–30 minute schedule.
- Collapse subtree incidents and suppress repeats by agent, execution generation, and incident class.
- Do not wake idle managers for unchanged state.

Every execution now writes a durable generation-tagged `running` transition and
a terminal `completed`, `failed`, or `cancelled` transition. Runtime activity
renews a six-minute in-memory lease; the aggregate health projection exposes the
execution ID and expiry and marks an expired lease `blocked` without producing a
chat message. On daemon startup, a durable start with no later terminal evidence
is closed as `failed/execution_interrupted`. This makes crash recovery auditable
while keeping heartbeat writes and manager polling bounded.

Project- and room-scoped health projections now expose every required lifecycle
state. Scheduled active-session rollover supplies the bounded `compacting`
interval; ordinary cancellation is a durable thread lifecycle event, and expected
abort transport errors are suppressed rather than misclassified as failures.
Canonical event, classification, projection, and promotion indexes are built once
from repairable disk logs by the single authoritative daemon, then updated in O(1)
on append. Restart still reconstructs them from canonical files. Tests exercise
sustained indexed writes and a 1,000-agent health projection without per-agent
polling.
Manager surfaces consume the server-owned project health projection instead of
deriving status from each agent's task rows. One aggregate refresh runs every
5 seconds only while work is active and backs off to 30 seconds otherwise;
per-agent detail polling was removed. All eight lifecycle states retain distinct
labels and exception counts in the roster.
Four independent rollout and rollback controls are available at daemon start:
`PONDEROSA_COMMUNICATION_MODE=off` preserves legacy writes while skipping the
canonical shadow plane; `PONDEROSA_COMMUNICATION_READ_MODE=legacy|shadow|authoritative`
cuts room reads over independently; and `PONDEROSA_CURATED_CONTEXT=off` stops
promotion injection without disabling event capture. Authoritative readiness
fails closed on missing projection metadata, unlinked legacy room rows, or DTO
parity drift. `/api/ready` reports every effective mode and reconciliation state.
`PONDEROSA_LEGACY_ROUTING` is a separate contract-retirement switch. Production
defaults to `reject`, making recipient-free mention routing and the old agent
`channel` wire unavailable; `accept` exists only as a time-bounded session rollback.

Initial values are tuning ranges, not schema constants. Phase 0 measurements set
production values.

## Migration and rollback

Use expand-migrate-contract and organization-sized cohorts:

1. Add versioned contracts and compatibility adapters.
2. Shadow-write and reconcile canonical events.
3. Shadow-route and rebuild projections.
4. Dry-run `POST /api/projects/:id/communication-backfill`; supply explicit stable
   recipient IDs for any ambiguous historical Collaboration rows, then apply it.
   Backfill IDs are deterministic and retries are idempotent. No audience is guessed.
5. Require a clean reconciliation/read-parity report, then enable new reads for
   internal organizations with `PONDEROSA_COMMUNICATION_READ_MODE=authoritative`.
6. Expand cohorts only while SLOs and reconciliation remain healthy.
7. Freeze legacy writes, observe, disable, observe again, then remove.

Write, routing, projection, context, supervision, and UI planes retain independent
kill switches. Rollback never deletes new canonical events; forward reconciliation
replays them after the incident. Destructive database changes wait until the
rollback window has expired.

## Staffing and span of control

Keep a 3–5 person architecture/program cell and one focused 3–5 person delivery
team. Add specialist review from security, privacy, SRE, product, and UX at gates.
Target 3–7 active direct reports per manager and no more than two simultaneous
critical workstreams. Reduce or redeploy a phase team before activating the next.

Execution organization:

```text
Program Director / integration owner
├── Architecture cell (contracts, identity, privacy; 2–3 active contributors)
├── Current phase delivery lead
│   └── Focused implementation team (2–4 contributors)
└── Gate reviewers (SRE, security/privacy, product/UX; consulted, not queued reports)
```

The Program Director owns the dependency graph, decision log, rollout cohort,
integration branch, and stop/go decision. The delivery lead owns one phase backlog
and reports one synthesized checkpoint, not every worker event. Specialists review
artifacts at named gates rather than joining the reporting tree. A manager wakes on
deduplicated exception events or its bounded digest; unchanged child state never
wakes it. If a manager reaches seven active reports, two critical workstreams, or
a growing review queue, pause delegation and collapse/synthesize results before
staffing more work. Completed/failed/cancelled children leave the active span after
their terminal delivery is recorded.

## Program risks

| Risk | Severity | Prevention/detection | Stop or rollback trigger |
|---|---|---|---|
| Dual-write/read divergence | Critical | event/projection IDs, DTO parity, reconciliation | any unexplained missing/orphan/mismatch |
| Unauthorized or recipient-free routing | Critical | capabilities, stable-ID validation, explicit non-empty audiences | any delivery outside recorded audience |
| Local-context leakage | Critical | classification and promotion provenance, golden prompts | any raw local source in future-agent context |
| Identity reuse or hierarchy cycle | Critical | immutable UUIDs, server-owned lineage/depth | duplicate identity or cyclic ancestry |
| Privacy versus append-only audit | Critical | minimize payloads, retention/legal policy before multi-user launch | deletion obligation cannot be met safely |
| Retry/queue storm | High | bounded attempts, FIFO barriers, deduped receipts | sustained retry amplification or queue SLO breach |
| Polling/manager wake storm | High | aggregate adaptive poll, event exceptions, digest dedupe | per-agent polling or unchanged wake amplification |
| Summary corruption | High | operator authorization, provenance, supersession | injected summary lacks valid active source |
| Partial backfill/old binary incompatibility | High | deterministic IDs, dry run, backup/restore rehearsal | authoritative readiness false or restore mismatch |
| Manager overload | High | 3–7 span, one phase team, two-workstream cap | review queue grows across two checkpoints |

## Architectural concerns requiring explicit decisions

- Append-only audit versus erasure/retention law must be resolved before public or
  multi-tenant deployment. Encryption-key destruction and redacted tombstones are
  candidates, not an implicit promise in this program.
- The current single-daemon writer model makes fsynced JSONL plus rebuildable
  SQLite appropriate. Horizontal multi-writer deployment requires a consensus or
  partitioned-log design; sharing this data directory between writers is forbidden.
- Parent/child lineage is delegation history, while room membership is current
  organizational placement. Effective-dated reassignment history should be added
  before hierarchy becomes an authorization boundary across organizations.
- Projection revisions now carry immutable attachment/reply snapshots and Direct
  Agent sequence keys, so authoritative reads do not consult legacy message rows.
  Legacy-store removal still requires backup/restore proof and a clean observation
  window; it is an operational retention decision, not a read-path dependency.
- A six-minute activity lease intentionally reports a quiet execution as blocked;
  it does not kill work. Runtime-specific heartbeats may refine this only through
  the adapter boundary, never by adding chat traffic or per-agent manager polls.
- Promotions are human-authorized summaries, not truth. Sensitive deployments need
  reviewer roles, revocation policy, and provenance access controls before sharing
  across trust domains.

## Program-level success criteria

- One canonical communication event can rebuild every applicable projection.
- Newly seeded agents never construct routing syntax.
- Recipient-free collaboration is rejected before persistence.
- Shared context contains only broadcasts, project events, and authorized provenance-linked promotions.
- Manager status is fresh within its SLO without per-child polling.
- Target thousand-agent load plus headroom survives retry and subtree bursts.
- Cohort rollback is rehearsed and completes inside its recovery objective.
- Legacy communication stores are removed only after a clean observation window.
