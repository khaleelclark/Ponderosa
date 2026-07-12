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
is accepted temporarily for already-running sessions and is not advertised.
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
accepted only as a temporary client migration path.

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

## Supervision policy

- Publish lifecycle transitions immediately.
- Renew an execution lease every 30–120 seconds while active; do not emit chat.
- Treat three missed intervals as stale, subject to measured clock-skew bounds.
- Notify managers immediately only for blocked, failed, unexpected cancellation, expired lease, or breached deadline.
- Produce one deduplicated 5–15 minute health digest while a subtree is active.
- Reconcile hierarchy and leases centrally on a jittered 15–30 minute schedule.
- Collapse subtree incidents and suppress repeats by agent, execution generation, and incident class.
- Do not wake idle managers for unchanged state.

Initial values are tuning ranges, not schema constants. Phase 0 measurements set
production values.

## Migration and rollback

Use expand-migrate-contract and organization-sized cohorts:

1. Add versioned contracts and compatibility adapters.
2. Shadow-write and reconcile canonical events.
3. Shadow-route and rebuild projections.
4. Enable new reads, then new writes, for internal organizations.
5. Expand cohorts only while SLOs and reconciliation remain healthy.
6. Freeze legacy writes, observe, disable, observe again, then remove.

Write, routing, projection, context, supervision, and UI planes retain independent
kill switches. Rollback never deletes new canonical events; forward reconciliation
replays them after the incident. Destructive database changes wait until the
rollback window has expired.

## Staffing and span of control

Keep a 3–5 person architecture/program cell and one focused 3–5 person delivery
team. Add specialist review from security, privacy, SRE, product, and UX at gates.
Target 3–7 active direct reports per manager and no more than two simultaneous
critical workstreams. Reduce or redeploy a phase team before activating the next.

## Program risks

Critical risks are dual-write divergence, unauthorized routing, local-context
leakage, identity reuse, privacy/immutability conflict, and big-bang cutover.
High risks are retry fan-out, projection duplication, polling storms, hierarchy
cycles, summary corruption, schema lock-in, and manager overload. Each phase must
test these failure modes directly rather than relying on aggregate pass rates.

## Program-level success criteria

- One canonical communication event can rebuild every applicable projection.
- Newly seeded agents never construct routing syntax.
- Recipient-free collaboration is rejected before persistence.
- Shared context contains only broadcasts, project events, and authorized provenance-linked promotions.
- Manager status is fresh within its SLO without per-child polling.
- Target thousand-agent load plus headroom survives retry and subtree bursts.
- Cohort rollback is rehearsed and completes inside its recovery objective.
- Legacy communication stores are removed only after a clean observation window.
