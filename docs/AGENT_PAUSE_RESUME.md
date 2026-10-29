# Human Agent pause/resume — implementation under review

This branch is an incomplete prototype. Do not integrate or release it.

The intended behavior is a durable human hold on an exact observed Agent Run.
Pause must close output authority before observed provider/browser process cleanup,
retain unfinished canonical activations, Request/reply lineage, history and human
access settings, and hold newly arriving input. Resume must continue unfinished
work through the existing scheduler with a new fence. Stop remains terminal
cancellation, including when invoked on paused work; it does not resume it.

The prototype adds POST `/api/agents/:id/pause` with `targetRunId` and
`idempotencyKey`, and POST `/api/agents/:id/resume` with `pauseId` and
`idempotencyKey`. Agent Chat exposes Pause/Resume using the existing action and
query invalidation patterns. Exact-target mismatches return 409. Resume waits
for completed provider-operation cleanup. There is no provider dynamic tool or
permission change associated with these human controls.

SQLite `agent_run_pauses` records current holds and retains the previous exact
provider-input and prompt-injection snapshots. It is canonical lifecycle state,
not reconstructed from rendered status. Its Agent identity deliberately has no
foreign key to the replaceable Agent projection; direct Agent deletion clears
these private receipts and project Run deletion cascades them. The scheduler
excludes held Agents. Failed pre-injection resume preparation restores the hold
rather than failing its attached work. A history row is not yet a complete
user-facing error surface for failed Resume.

The migration has an exact immediate predecessor signature, alongside the
existing explicit history/workspace predecessors; arbitrary schema repair
remains refused. The schema now has 513 objects, exceeding the former fixed 512
object ceiling. The fixed metadata-object allowance is 528; row, byte and work
budgets remain bounded and unchanged. No install or provider authentication change.

## Unresolved engineering boundaries

Reactivating the same Run after killing its provider is insufficient. The
current retained-context contract requires a trustworthy completed-session
checkpoint or explicit recovery; paused incomplete work cannot be mislabeled as
completed. Native work can change provider context without a host token count.
An attempted relaxation of this proof was removed. The source/requested-refresh
resume cases therefore remain red. Unverified replacement inputs are separately
hash-bound and cannot be changed merely by reusing a Run ID. Handoff/replacement
and restart-resume coverage is required before approval.

The next design must reuse canonical bounded continuation/recovery, preserve
partial work as non-authoritative evidence, retain exact reply authority and
explicit queue isolation, and avoid automatic re-execution of already performed
actions. It must never broaden context admission merely because a pause receipt
exists. No product decision or human-only check is asserted as the cause of
these engineering failures.

Run `node --import ./tests/shared/workspace-resolution.mjs --test tests/context-recovery/pause-resume.test.mjs`
after sequential agents/server builds. All failures are retained separately;
this document makes no passing lifecycle or full-commandment claim.
