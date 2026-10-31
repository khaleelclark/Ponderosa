# Script polling, schedules and runtime stall evidence

Script settlement commits the known result and outgoing edge before any suffix
preparation. A worker first claims already prepared work. If that scan is empty,
`BranchStore.claimScript` runs one ordinary bounded `advance` batch and scans
again. Each frontier still commits separately, existing checkpoint permits and
fairness cursors still apply, and a caller-owned transaction never drives this
extra batch. A Script claim is a scheduler/worker operation; it must not be used
as a read-only readiness probe. It does not execute user code or bypass leases,
loop ceilings, policy, concurrency or teardown.

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
