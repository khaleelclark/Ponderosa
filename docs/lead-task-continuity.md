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
- Recovery transfers one original source root and its increasing bounded retry
  generation. After six unsuccessful delivery Runs, existing actionable
  delivery-failure handling stops automatic recovery. No final text is fabricated.

`taskDelivery` is a provider declaration, not independent proof that files,
signatures, pushes or releases exist. A completed Run is still only an execution
fact. No completion or permission is inferred from message prose. Multiple
coalesced source routes remain separately authorized; a private specialist reply
does not satisfy an operator obligation or get forwarded to the operator.

## Waiting rollover

Old-process retirement, immediate replacement scheduling, and retained continuity
are separate. A rollover can be `completed/no_continuation_required` with
`continuity_waiting=1`: the old process is closed, no replacement is needed yet,
and its bounded handoff remains available only to an exact task-related wake.

Canonical Request/Join/question/Decision wakes bind this retained handoff before
leasing. The existing scheduler isolates that activation as the replacement
candidate; there is no polling Run or extra synthetic continuation. Existing
observed-process-closure, provider-input manifest and low-water guards remain.
Cancellation, deletion and terminal task roots retire waiting eligibility.
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
Decision continuation.

Orderly store reopening and an injected association-transaction rollback are
distinct checks, not abrupt crash/power-loss qualification. Local synthetic CLI
fixtures use no subscription profile and do not qualify live provider behavior.
No historical task is revived or marked complete by migration. No live Agent,
browser, dev/production service or user data is used by this qualification.
