# Explicit recovery of unmeasurable uncertain context

Ordinary continuation refuses unmeasurable retained context with
`context_recovery_required`. Recovery never replays an uncertain turn, revives a
terminal Request/Join, erases history, or changes human permissions.

## Admission and inspection

`GET /api/agents/:id/context-recoveries` returns native support, the exact eligible
unknown boundary, source evidence and any active hold/progress. It never opens or
probes a provider. Eligibility requires an accepted tracked native session, normal
contract hash, latest injected Run terminal `outcome_unknown`, and no busy Run,
pause or context transition. Source evidence includes input/system hashes, event
position and attached Request IDs. Prior effects and native-tail completeness stay
explicitly unknown.

POST the same path with `idempotencyKey`, `expectedSessionId`,
`expectedSourceRunId`, `expectedToolContractHash` and
`acknowledgeUnknownEffects: true`. Arbitrary seeds/context are refused. SQLite binds
the original Agent/project/scope/session/Run/fence and retains an active dispatch
hold. The historical storage state is named `unsupported_fenced`; executable
progress and response code describe the actual recovery outcome.

Future input manifests retain the exact non-secret native launch contract: engine,
working-copy identity/path, model/effort/speed, expected billing mode, tool schemas
and native restrictions. Exact system text is retained in the same input ledger.
The accepted-session event selects that record. Old capability tokens, credentials
and callback closures are never stored in the retained contract. Legacy sessions
without this record cannot be reconstructed from current settings or Chat.

## Codex managed compaction

Codex support is `managed_compaction` with crash policy `hold_without_native_query`.
For a future retained contract, recovery performs:

1. Reserve the exact source once in SQLite (`reserved`).
2. Observe retained/recovered process-group exit (`drained`).
3. Reopen the same native session with its retained normal configuration. Current
   human restrictions and billing selection must still match. There is no new Run,
   no replayed task, and no expired host-tool/elicitation capability.
4. Persist `native_started` before invoking the existing structured native Compact.
5. Require matching native compaction completion and fresh exact session occupancy.
6. Observe recovery-process exit, then persist `context_accepted` and the occupancy.

A failure becomes `held` where it can be durably recorded. Cleanup errors preserve
working-folder use and admission barriers until observed exit; diagnostics name
the cause. Unknown native results are never repeated. Same-key retries return the
record; different keys cannot replay an uncertain native compaction of that session.
No startup worker replays recovery. A crash leaving `reserved`, `drained` or
`native_started` requires reconciliation, not a fresh task turn.

`context_accepted` is context measurement acceptance only. It is not proof that
unknown original work completed, had no effects, or has enough headroom for another
turn. The response says `sourceWork: held_unknown`; original Runs, Requests, Joins,
injections and history remain unchanged. The active hold prevents dispatch until explicit dismissal. Acceptance references
the canonical context-usage event; after dismissal, independent new instructions
may continue on the same native session with that measurement, provided no newer
injection or unmetered native work invalidated it. Unknown original activations are
never requeued. Without acceptance, the original uncertainty guard stays intact. Successful context recovery returns
HTTP200 with `recoveredContext: true`; it never returns original-work success.
Other recorded phases return409. Ambiguous failures return503 and require exact-key
inspection before any further action.

POST `/api/agents/:id/context-recoveries/:recoveryId/stop` requests an exact live
recovery stop and drains its process. `stopRequested` acknowledges the request;
inspect GET for the settled phase. Shutdown and deletion also fence native input
and acceptance. There is no generic Agent task cancellation manufactured for a
command that owns no scheduler Run.

## Unsupported and legacy sessions

Claude has no mapped structured retained-session compaction command. Its support
is `unsupported` with `missingOperation: structured_retained_session_compaction`.
Legacy packets without a retained contract also stay on the refusal path. The POST
records a hold and returns409 `provider_context_recovery_unsupported` without
launching a provider, replacing a session, changing permissions or accepting context.
Requiring an unchanged-context no-effects diagnostic turn is not a separate Bible
requirement; the supported managed-compaction path intentionally changes context.

POST `/api/agents/:id/context-recoveries/:recoveryId/dismiss` with
`acknowledgeStillBlocked: true` removes only a settled hold and returns
`recovered: false`. It never resolves prior effects or requeues original work. A successful accepted
measurement permits independent future work; without it the original context guard
remains. An in-progress/ambiguous native phase cannot be dismissed as settled.
Deletion removes recovery records through existing fenced cleanup ownership.

## Exact remaining reconciliation seam

The mapped Codex `thread/resume` result contains `thread.id` and model, without a
complete original turn/transcript/outcome boundary. `thread/compact/start` accepts
only `threadId` and returns an empty acknowledgement; it has no mapped client
operation key or result lookup after a crash. Completion and usage notifications
can certify an observed invocation, but cannot reconstruct an unseen original tail
or a lost invocation result. Original-work continuation exactly once therefore
needs a native source-turn outcome/transcript read and queryable operation identity.
Claude additionally needs a mapped structured compaction equivalent.

A host replacement requires an immutable complete native transcript plus the
canonical journals. Authored Chat alone is insufficient after unseen native work.
These remain concrete missing interfaces; implemented retention/reservation/drain/
acceptance plumbing is no longer classified as blocked on a hypothetical primitive.
Tests/regressions are source only until the authorized combined execution phase.

An explicit Stop also reconciles an interrupted reservation after restart by
observing exact Agent process-group exit and recording `held`, without opening a
provider. A saved `nativeInvoked` marker remains: clearing process custody cannot
turn an unknown native compaction into permission to repeat it.

Accepted context measurements reference their canonical `context_usage` event by
sequence. Admission rechecks native session/contract, source fence, absence of a
newer injected Run, and absence of subsequent unmetered work; later text is accounted
for as a conservative tail estimate. The measurement is usable for an independent
new instruction after explicit hold dismissal. It never marks the old Run completed
or retries its original Activation/Request. This separation permits useful ongoing
work without inventing certainty about past effects.
