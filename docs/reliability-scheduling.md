# Script polling, schedules and runtime stall evidence

Script settlement commits the known result and outgoing edge before any suffix
preparation. A worker first claims already prepared work. An empty scan may
prepare one direct Script suffix from a committed sealed Script result on the
same active path, then scan again. This uses the same traversal and Step budgets
as ordinary path preparation, in a separate commit. It cannot admit queued work,
reduce controls, resume a checkpoint or drive unrelated executions. Both claim
and suffix scans rotate bounded batches. A caller-owned transaction cannot
prepare this extra suffix. Explicit scheduler advance still owns all other work.

An accepted operator retry opens a fresh invocation after a terminal failure;
the failed cut and its save remain immutable. Explicit checkpoint interruptions
still require their own resume authority. Failed saver lanes remain blocking.

The exact async saver applies backpressure at 32 MiB of queued immutable string
storage (conservative UTF-16 bytes). It pauses fresh functional work until the
queued saves settle; known results, cancellation and cleanup still commit. It
does not coalesce or discard cuts, raise V8 limits, or make unsupported Map cuts
restorable. One transaction/known-result batch can exceed the threshold; total
host memory and snapshot disk retention are not bounded by this queue budget.
Fixture loops must allow committed frontier progress while awaiting saver drain,
then reject a no-lease poll with no new committed watermark as a stall.

Repeating schedules enumerate distinct due times through the persisted cursor.
Clock catch-up and busy-work policy are separate: `queue_all` accepts each run;
`run_latest` and `update_current` may explicitly combine checks while retaining
their immutable occurrences and association. Unsupported steering waits for a
new Run rather than pretending a Script was steered. Clock rollback never resets
the cursor. The accepted schedule target is within 60 seconds during ordinary
polling; recovery after downtime retains due occurrences rather than claiming
that past deadlines were met.

The current runtime event-consumer threshold is 30 seconds (`app.ts`). It detects
an event received but not persisted, exposes `stalled` with
`runtime_event_consumer_stalled` and exact execution identity in Agent health,
and returns to `running` after actual event persistence. This is not a generic
provider-silence timer: a quiet long-running command is not sufficient evidence
of failure. The existing execution lease is a separate failure boundary. A
universal stuck-task timeout, rendered explanation/Copy Logs and eligible clarity
panel remain separate qualification requirements; this document does not claim
those pass.

Prepared validation (not yet executed): full `branch-calls`,
`unit-checkpoint-handoff`, `sources`, `schedule-overlap`, `schedule-steering`,
`notification-reconciliation`, plus the existing checkpoint/control and Script
safety groups in one final consolidated batch after fresh dependent builds and
typechecks. Preserve the two original immediate-next-lease assertions unchanged.
No reliability streak is restarted by these focused regressions.


A Join that has failed from a canonical traversal/loop limit stops unstarted leaf
remainder paths even when its ordinary remainder policy is `finish`. It retains
leased, running, uncertain, Request/process and child-execution authority, plus
nested path owners, for their existing settlement or cleanup. Ordinary failures,
successful/partial joins and all existing `cancel` behavior keep their policy.
No traversal count is raised and no completed result is reclassified.

Resource work is awaited before Script or notification admission in a workflow
pass; stop is checked again at that await boundary. The outer scheduler tracks
the pass separately so unrelated Run admission and exact cancellation can still
proceed while resource provisioning waits. Cleanup-only passes also await their
resource maintenance before returning or reporting errors.
