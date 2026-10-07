# Lead-task continuity and final delivery

## Durable distinctions

SQLite remains the sole scheduler/coordination authority. This change extends
existing Requests, Joins, reply obligations and rollover records; it adds no
assignment subsystem.

- Provider-authored Requests and Joins record the exact fenced origin Run.
- An operator reply obligation begins in `initial` phase. Tracked delegation
  promotes it to `final`; an already published initial response becomes an
  interim receipt. Passive record-only work without a Join does not establish
  an awaited callback.
- A final-phase ordinary message remains interim, even after the last Join.
  `ponderosa_message` accepts optional `taskDelivery: "final" | "blocked"`
  only for an immediate, authorized operator-facing outcome on that task's
  exact origin route. Explicit final delivery is rejected until all tracked
  results have reached this Run. An explicit blocked outcome is not a claim
  that the requested deliverables exist and does not cancel delegated work.
- A blocking Decision preserves the pending task and exact answer association,
  including when accompanied by a blocked-status message. Its answer resumes
  the existing delivery responsibility rather than creating a new assignment.
  Unrelated review callbacks retain that wait. A second distinct blocking
  Decision is rejected before canonical creation while the first is unanswered;
  replay preserves the exact original Decision. Canonical pending Decisions
  also guard final delivery if their SQLite association requires repair.
  Decision ownership can be recorded before delegation or an initial reply;
  promotion retains it without changing initial reply semantics. Canonical
  pending waits are repaired at shared terminal accounting, including provider
  failure, lease expiry and orphan recovery, as well as before final-delivery
  rejection. A repair failure preserves the actual terminal outcome and records
  a durable recovery hold; it does not leave a falsely active Run. Only operator
  task roots are held, not unrelated collaboration recovery. Bounded repair
  batches rotate by their last attempt, so a persistently failing batch cannot
  strand later healthy tasks, including when a held Run has a displaced sibling
  root. A store reopened without its canonical Decision reader cannot release
  an existing hold or launch recovery through it, including after the same root
  transfers to a later owner. Restoring the reader retries that exact owner.
  An exact Decision answer in a later Run can carry a pending or already-satisfied
  initial origin, preserving its initial receipt. Only subsequent delegation
  promotes that origin to final delivery; generic callbacks cannot revive it.
  An unstarted, uninjected claim that requeues this exact answer restores only
  its unaccepted copied initial root to the immediately preceding live owner.
  Admission deferral, safe preparation retry, partial-compilation isolation and
  abandoned uninjected leases preserve the route, receipt and retry budget.
  Accepted provider input, a new receipt/delegation or genuine cancellation
  cannot use that restoration. The released Run and input audit remain intact.
  An answer recorded while association repair remains unavailable is held from
  both fresh-Run and steering claims. Healthy canonical repair attaches its
  exact task provenance before releasing it; cancellation retires the hold.
  Recovery already queued by an earlier build is also held if it names this
  exact uncertain root. A healthy pending Decision cancels that recovery; a
  healthy empty index releases the original bounded attempt without duplication.
  Startup repair of an older Decision Run holds its exact latest task owner
  too, including recovery queued by that owner before upgrade. The original
  evidence remains intact; unrelated sources and newer cancelled or completed
  final owners cannot inherit this hold or acquire renewed task authority.
  This includes an exact recovery claimed before restart but never submitted.
  Requeuing that claim returns only its copied final root to the immediate
  predecessor, preserving the original activation and retry budget. Repaired
  blockers and existing repair evidence survive the transfer; accepted packets,
  submitted inputs, started providers and genuine cancellation cannot use it.
  An already-satisfied initial receipt can retain that wait after an association
  rollback only with durable proof that the trusted canonical reader observed
  this exact pending Decision for its original Run and root. A generic read
  outage, another Decision, or historical answer text cannot supply that proof.
  Rollover retirement also checks the original source's canonical accounting
  before deciding that no continuation is needed. A held source leaves the
  retirement retryable and its handoff intact. Bounded repair maintenance then
  resumes that exact retirement: pending questions retain continuity, while a
  healthy empty index can retire genuinely completed work without an extra Run.
  If the provider acknowledges the exact answer as steering into its owning
  active Run, that acknowledgement and removal of the matching wait commit
  atomically. Unsubmitted, unrelated or stale-fenced inputs cannot release it.
  Steering claims recheck every coalesced Decision answer against the receiving
  Run's exact live task root. An answer for a different task waits for its own
  continuation, even if the same Agent is busy in the same Chat.
  Canonical repair also covers initial-phase waits and saved answers whose wake
  was not enqueued before reopening. Exact acknowledged answers are not reblocked;
  receipt satisfaction, cancellation and newer terminal roots remain authoritative.
- Recovery transfers one original source root and its increasing bounded retry
  generation. After six unsuccessful delivery Runs, existing actionable
  delivery-failure handling stops automatic recovery. No final text is fabricated.

`taskDelivery` is a provider declaration, not independent proof that files,
signatures, pushes or releases exist. A completed Run is still only an execution
fact. No completion or permission is inferred from message prose. Multiple
coalesced source routes remain separately authorized; a private specialist reply
does not satisfy an operator obligation or get forwarded to the operator.
Distinct authored inputs keep their own reply roots even when their operator
route matches an inherited task's route.

## Waiting rollover

Old-process retirement, immediate replacement scheduling, and retained continuity
are separate. A rollover can be `completed/no_continuation_required` with
`continuity_waiting=1`: no replacement is needed yet, and its bounded handoff
remains available only to an exact task-related wake. Runtime retirement is
separate; observed old-process closure is required before opening a replacement.

Canonical Request/Join/question/Decision wakes bind this retained handoff before
leasing. The existing scheduler isolates that activation as the replacement
candidate; there is no polling Run or extra synthetic continuation. Existing
observed-process-closure, provider-input manifest and low-water guards remain.
Retirement filters wakes by structural task lineage before applying its bounded
selection limit. Normal inbox priorities remain unchanged; unrelated inputs
cannot consume the callback's handoff even if they run first.
The scoped lookup materializes only identity and ordering fields, never queued
message payloads.
Cancellation, deletion and terminal task roots retire waiting eligibility.
An exact, still-live blocking Decision retains the handoff even when it precedes
all delegation and the initial reply has already been published. Its answer can
arrive before, during or after retirement without adding a polling Run.
Historical handoff text may remain as audit evidence; a generic later task can
never select a rollover-owned obsolete handoff.

## Provider history and bounds

Both adapters serialize stable author, direction, audience and Chat provenance
as quoted background. Display labels are untrusted and bounded; canonical text,
scope and routing are not rewritten. Teammate restrictions do not change the
lead's policy or permissions.

New rollover tails account for measured provenance/header UTF-8 cost within the
existing 40-message/24,000-byte bound. An old frozen tail retains every exact
source ID, content hash and source count. Before accepting its replacement
packet, presentation alone may omit labels, summarize recipient identities
(retaining the current recipient and an explicit omitted count), and clip text
with a visible marker. Compact record numbers map to unchanged manifest order;
exact event IDs/audiences remain canonical. Indispensable identity that cannot
fit fails closed, never widens the context budget. Accepted provider inputs and
their exact submitted hashes are immutable.

The new message-tool schema changes the session contract. Old handoffs use only
an exact reconstructed prior definition validated against the complete accepted
contract hash. Their actual MCP `tools/list` retains the selected frozen tools;
only verified fresh replacements adopt the new schema. Unknown or changed
policies still fail before provider startup.

## Qualification

Disposable regressions cover lead/review/pressure/retirement/final delivery,
before/during/after retirement results, multiple Joins and routes, interim/final
and blocked outcomes, Decisions, idempotency, cancellation, deletion, unrelated
and cross-Chat controls, bounded legacy tails, and actual Codex/Claude adapter
serialization. The production HTTP/store/scheduler fixture records exact Run,
activation, handoff, final-event and provider-input hashes, including an exact
Decision continuation, same-Run steering acknowledgement, Decision-only waits
before/during/after retirement, canonical-association rollback, and a saved
answer recovered by reopening the application.
Additional regressions cover repeated exact-answer deferral/reopening, ordinary
uninjected retry/expiry/orphan recovery, compilation-survivor isolation, atomic
restoration rollback, mixed unrelated inputs, provider error after association
rollback, and a persistent repair failure with an answer recorded before
repair and reopening. They assert no rootless answer Run, no unnecessary
reply-recovery Run, unchanged failure truth and one eventual canonical reply.

Orderly store reopening and an injected association-transaction rollback are
distinct checks, not abrupt crash/power-loss qualification. Local synthetic CLI
fixtures use no subscription profile and do not qualify live provider behavior.
No historical task is revived or marked complete by migration. No live Agent,
browser, dev/production service or user data is used by this qualification.
