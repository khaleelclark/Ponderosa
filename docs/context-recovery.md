# Explicit recovery of unmeasurable uncertain context

Ordinary continuation still refuses unmeasurable retained context with
`context_recovery_required`. Native Compact and Context Refresh still require
their existing safe completed boundary. Neither is a way to replay an uncertain
turn, recreate a failed Request/Join, erase history, or silently change tools.

Codex app-server and Claude currently report **unsupported** for
`immutable_normal_contract_no_effects_recovery`. They have no mapped native
operation that can ingest/measure recovery context and produce trustworthy
successful completion under the unchanged normal tool contract while preventing
all task execution, tool calls, native shell/file/network/connector effects and
outbound messages. Read-only sandbox labels, an instruction to avoid tools,
removing Ponderosa tools or a fresh normal turn are not that operation.

## Refusal and admission controller

`GET /api/agents/:id/context-recoveries` returns static support, the exact narrow
eligible boundary (or null), and any active explicit hold. It never probes or
opens a provider. Eligibility is an accepted tracked session with its normal
contract hash, no valid completed-tail measurement/estimate, and the latest
injected Run of that session terminal `outcome_unknown`. Busy, paused, changing,
untracked and completed sources are refused.

An operator may POST that path with `idempotencyKey`, `expectedSessionId`,
`expectedSourceRunId`, `expectedToolContractHash` and
`acknowledgeUnknownEffects: true`. Arbitrary seed/context fields are rejected.
The route atomically records an `unsupported_fenced` request in coordination
SQLite and returns HTTP409 `provider_context_recovery_unsupported`, not202 or
recovery success. The record binds original Agent, project, scope, session,
contract and Run/fence. It contains no prompt, secret, replacement session,
reply authority, candidate Run or provider invocation. Unknown effects, failed
requests, joins and original source audit remain unchanged.

The explicit hold keeps future inputs queued across restart. Scheduler admission,
Run preparation and Agent provider-command/refresh routes consult it. Original
expired Run capabilities remain expired. No new effect capability is issued.
The request never starts native recovery, invokes compaction, opens a diagnostic
session, retires/drains the accepted runtime or writes an acceptance snapshot.
This does not certify absence of prior native effects or completion of old
cleanup. Thus there is no new candidate to clean up, no low-water receipt, and no
cross-store acceptance transaction to imply. Existing runtime cleanup owners
continue to own any old processes; this record is not an exit/drain receipt.

Retrying the same key returns the same record, including after dismissal, and
cannot start work. A different boundary with that key conflicts. Inspect a key
using GET with `?idempotencyKey=...`, including after an ambiguous HTTP/write
failure; do not infer that a thrown write means it did not commit. Request/hold
creation is one SQLite transaction with no asynchronous provider boundary:
crash before commit leaves neither; crash after commit retains both. No startup
worker replays recovery. Concurrent requests cannot create two active holds.

To remove just this refusal hold, POST
`/api/agents/:id/context-recoveries/:recoveryId/dismiss` with
`acknowledgeStillBlocked: true`. Dismissal is idempotent and returns
`recovered: false`. It does not claim old processes drained and cannot accept,
replace or measure context. Original uncertainty/completed-boundary guards
remain in force. Only these non-executable refusal states may be dismissed this
way. Agent deletion removes private recovery records through the existing
cleanup/deletion ownership path.

## Missing native operation and remaining work

Usable recovery remains blocked on a concrete adapter/native no-effects
operation bound to the normal immutable session/contract, recovery generation
and exact input, with acknowledged successful completion and complete-tail
occupancy proof. It must mediate native effects before execution, not just host
callbacks. Neither current adapter advertises this support; there is deliberately
no executable or accepted recovery state and no fictitious fake-provider success
path in this controller.

After that primitive is specified and implemented, recovery-linked durable
old/candidate drain receipts, candidate-only proof reading, ordinary-snapshot
suppression, and idempotent canonical acceptance/coordination reconciliation must
be implemented and independently qualified before any fence release for recovered
work. Those seams are not implemented by this refusal controller. Original work
retry/reissue remains a distinct authorized operation with distinct identities;
context recovery cannot revive a terminal Request/Join or replay unknown effects.

The receipt schema expands initialized metadata to 531 objects (532 including
the current-state generation marker). Its fixed schema-object envelope is 536;
the maintained regression pins 536 accepted and 537 refused, plus complete
current-state admission. Ordinary byte/row/work budgets remain unchanged.
