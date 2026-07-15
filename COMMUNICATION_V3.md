# Communication V3 Domain Contract

Empirical qualification results and retained evidence are documented in
[`docs/communication-v3-qualification.md`](docs/communication-v3-qualification.md).

This contract is the scheduler and coordination source of truth. The executable
request reducer lives in `packages/core/src/coordination-v3.ts`. Authorization,
idempotency, and persistence surround that pure reducer.

## Objects and ownership

- **Agent:** durable identity.
- **Request:** ephemeral, correlated work or consultation between a requester
  and one recipient. It can progress without the requester waiting.
- **Join:** durable condition over an immutable set of request IDs.
- **Activation:** actionable, prioritized reason to wake an agent.
- **Run:** temporary execution consuming one or more compatible activations.
- **Provider session:** resumable cache owned by one agent, never agent identity.
- **OS process:** evictable implementation detail.

SQLite is authoritative for request and join state, activations, run identity and
status, activation attachment and consumption, leases and fencing tokens,
prompt-injection state, terminal outcomes, idempotency, and the activation outbox.
JSONL may retain rich runtime telemetry, but it is not a competing scheduler
authority.

## Request state machine

Nonterminal states are `open`, `in_progress`, `waiting_dependency`, and
`awaiting_answer`. Terminal states are `completed`, `blocked`, `failed`,
`cancelled`, `superseded`, `recipient_unavailable`, `outcome_unknown`, and
`expired`.

Every request explicitly chooses a lifetime:

```ts
type RequestLifetime =
  | { kind: "deadline"; at: string }
  | { kind: "indefinite" };
```

The exhaustive reducer table is authoritative:

| Update | Allowed source | Result |
| --- | --- | --- |
| `progress` | any nonterminal except `awaiting_answer` | `in_progress` |
| `waiting_dependency` | any nonterminal except `awaiting_answer` | `waiting_dependency` |
| `dependency_resolved` | `waiting_dependency` | `in_progress` |
| `question` | any nonterminal without a question | `awaiting_answer` |
| `answer` | `awaiting_answer`, correlated to its open question ID | `in_progress` |
| any terminal update | every nonterminal | the matching terminal state |

Only one blocking question may be outstanding per request. `blocked` means the
request cannot continue without replacement or a new request;
`waiting_dependency` is temporary. Terminal requests reject mutation. Exact
idempotent replay of the same authenticated actor, scope, key, and payload is
safe and is handled before reduction.

Authorization is checked before reduction:

- recipient: `progress`, `waiting_dependency`, `dependency_resolved`, `question`,
  `completed`, `blocked`, `failed`;
- requester or user: `answer`, `cancelled`, `superseded`;
- system only: `recipient_unavailable`, `expired`;
- runtime supervisor/system or explicitly authorized user: `outcome_unknown`.

Request deadlines and join deadlines are independent. A request deadline moves
only that request to `expired`, reevaluates its joins, and activates a surviving
requester only when action is needed. Expiring a join never expires its requests.

## Join state machine

A join stores immutable request IDs and a mode: `all`, `any`, or `quorum`.
It moves from `open` to exactly one of `satisfied`, `impossible`, `expired`, or
`cancelled`. Satisfied, impossible, and expired joins activate their surviving
owner. A join cancelled by its owner closes without creating a redundant
activation.

Superseding terminates the original request. A replacement request uses a new
join; V3 has no mutable logical slots. Deleting a join owner cancels its open
joins and invalidates their pending activations transactionally. Deleting a
recipient transitions its open requests to `recipient_unavailable` and
reevaluates affected joins.

## Scheduling and failure invariants

The governing execution invariant is:

> Every actionable event becomes an Activation. Only the scheduler may attach
> an Activation to a Run or create a new Run.

Actionable events include directed human work, coordination requests, answers,
questions, blockers, terminal joins, triggers, deadlines, recovery decisions,
and steering. Informational broadcasts are passive: their communication event
is durable, but they create no Activation and wake no agent. Communication
creation and the decision to create its deduplicated Activation are one SQLite
transaction.

An Activation is an actionable cause, not an instruction to create a new Run.
The scheduler alone decides whether to attach urgent steering to the current
authoritative Run, retain passive input without waking, queue work for a later
Run, or create a Run when no compatible execution exists. No HTTP handler,
delivery queue, runtime adapter, or compatibility path may create or claim a Run.

An agent is `running` with an authoritative active Run, `runnable` with an
actionable Activation, `waiting` with neither of those while it owns an open Join
or is recipient of an `awaiting_answer`/`waiting_dependency` request, and `idle`
otherwise.

Activating an agent for a human message, question, or urgent event never cancels
its joins. The Run handles the activation and the agent returns to waiting if its
join remains open. Explicit cancellation is an immediate control-plane action:
it fences the Run, interrupts the provider, and records the outcome without
waiting in a priority lane.

Priority is human/steering, agent question or urgent event, actionable join
problem, satisfied join, new request, ordinary message, then passive progress.
The scheduler coalesces compatible activations once, preserves every source ID,
enforces centralized concurrency and fairness, and assigns a monotonically
increasing fencing token to each lease.

An activation is retryable on another Run only before prompt injection. Once the
prompt was injected, the scheduler resumes that same Run when possible; otherwise
it records `outcome_unknown`. It never blindly replays an injected prompt.

Every provider prompt or steering injection has a durable identity and lifecycle:
`pending -> submitted -> acknowledged`, with `outcome_unknown` as the fail-closed
terminal state. A provider session reference alone never proves whether a prompt
was submitted. Recovery may resume the same Run only when the provider can
reconcile the durable injection identity without resubmitting an acknowledged or
ambiguously submitted prompt.

Cancellation commits before provider interruption. One SQLite transaction
advances the fence, marks the Run cancelled, closes or releases its attached
Activations according to their policy, persists an idempotent cancellation
receipt, and enqueues a provider-interrupt outbox operation. Late provider output
is rejected by the advanced fence. The interrupt is asynchronous and cannot roll
back external effects that already occurred.

Complete communications, request reports, and join outcomes remain durable in
SQLite. Prompt materialization is token-budgeted rather than semantically
truncated: it reserves room for human messages and blockers, may use summaries
and artifact references, splits large result sets into inspectable batches, and
exposes full-result retrieval. An overflow is explicit and actionable.

SQLite is the only runtime authority. Deleting JSONL telemetry cannot affect
scheduling, ownership, recovery, cancellation, or agent availability.

The cutover gate must prove:

- no code path creates a Run except the scheduler;
- every actionable cause has exactly one deduplicated Activation;
- passive broadcasts never activate agents;
- steering attaches without creating a competing Run;
- restart recovery cannot duplicate prompt injection;
- cancellation fences every late output;
- terminal joins cause at most one actionable wake;
- provider failure at each transaction boundary recovers deterministically; and
- V2 communication tables and handlers have no readers or writers.

## Provider-visible tools

Only three coordination tools are exposed to the model:

- `ponderosa_coordinate`: create correlated requests and optionally an immutable
  join; requests do not imply waiting.
- `ponderosa_update_request`: append an authorized, idempotent request update.
  When exactly one correlated request is attached to the current Run, the model
  omits `requestId` and the server resolves it from SQLite's durable Run-to-
  Activation linkage. Multiple attached requests require an exact ID; the server
  never uses fuzzy identifier matching.
- `ponderosa_message`: send an uncorrelated human or agent message.

“Coordinate and wait” is a skill/helper around `ponderosa_coordinate`, not a
fourth runtime tool. All tool mutations commit SQLite state and an outbox record
atomically; scheduling side effects occur only after commit.
