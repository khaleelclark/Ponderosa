# Human Agent pause/resume

Pause is a durable human hold on an exact observed scheduler Run. It fences late
output first and requests observed provider/browser cleanup. It preserves the
original task activations, Request/reply routes, satisfied replies, access,
provider input packets and execution history. New work stays queued. Stop is
terminal cancellation; it supersedes the pause and recovery and does not undo
external effects or file edits.

POST `/api/agents/:id/pause` accepts `targetRunId` and `idempotencyKey`.
POST `/api/agents/:id/resume` accepts `pauseId` and `idempotencyKey`.
Agent Chat exposes Pause and Resume. Exact-target mismatches return 409. Resume
requires observed cleanup. Its waiting state persists until provider
acknowledgement, and durable preparation errors appear in Agent detail. Native
provider commands and Context Refresh cannot bypass the hold. Human access
settings and provider authentication are unchanged.

## Canonical recovery authority

SQLite `agent_run_pauses` retains the hold, exact input/injection snapshots,
phase, checkpoint, source Run and current recovery activation. Immutable
`agent_pause_recoveries` receipts bind each human command key to one isolated
activation and a fresh execution/fence. The normal scheduler alone leases it,
using normal scope/resource admission and excluded-Agent filtering. Original
Runs remain terminal; original task activations are never re-executed.

The recovery activation copies source lineage using the continuation pattern.
The existing required-reply authority transfers pending roots and preserves
satisfied roots and exact routes. Only that activation can pass the hold;
queue coalescing and passive deliveries cannot add unrelated work. The hold is
released on actual provider acknowledgement, not leasing or preparation.

Source/requested-refresh recovery reconstructs cold from frozen canonical
source payloads and at most eight exact same-session input packets, with their
original hashes/manifests. For an unsubmitted source, the latest completed,
injected same-scope canonical packet can supply historical input; it is never
admitted as a retained opaque checkpoint. No incomplete session is relabeled
completed. Repeated pauses flatten prior checkpoint sources instead of nesting
old recovery prompts. Earlier history remains retained and explicitly omitted.

The checkpoint includes at most 16 tool/command/file/error observations plus
four final text observations, with a 16 KiB inline evidence ceiling and 4 KiB
per observation. Oversized observations retain exact event IDs, hashes and byte
counts. They and earlier observations remain in execution history. This is
selected non-authoritative partial evidence, never a fabricated model summary
or completed turn. Current and previous bounded observations, parent checkpoint
identity and uncertainty remain inspectable. The compiler refuses an oversized
required checkpoint while retaining the hold; it never silently clips it.

A pause identifies the exact attached execution role, including after handoff commit.
Once committed, Resume preserves that handoff and frozen tail and atomically binds
one sanctioned continuation to the pause receipt, inheriting its original task
lineage. Any superseded pending continuation is fenced from admission. Stale
handoff finalization cannot publish output or create another continuation.

An interrupted uncommitted isolated handoff recovers only its bounded handoff contract from
its frozen checkpoint, then uses ordinary continuation. An unverified
replacement uses the existing exact replacement-recovery path: saved prompt,
system and manifest hashes stay identical, with no appended resume prose.

Submitted/unacknowledged steering remains outcome-unknown. Human Resume is not
proof that external effects failed. Recovery instructions require inspection
before retry; the scheduler never automatically replays original activations.

## Failure, Stop and restart

Canonical lifecycle containment precedes generic failure settlement. Rejected
pre-submission preparation, resource deferral or unavailable scope restores the
same hold and visible diagnostic without failing original work. A repeated
command key returns its original receipt, including a rejection. After cleanup,
a different human command key may authorize a corrected attempt. If a committed
continuation already bound its provider packet before preparation failed, the
rejected candidate remains fenced with its exact packet/handoff/tail proof.
After confirmed cleanup and proof of no submitted or unknown input, the new
command uses the existing exact replacement-packet recovery path. It transfers
the latest rejected attempt's pending and satisfied reply roots, preserves
immutable command receipts and checks the same packet hashes before submission.
The rollover candidate pointer and hashes are never cleared to enable a retry.
An audit projection failure still requires restart/replay before new commands.
Submitted or
unknown delivery retains uncertainty and ownership and cannot automatically
retry; Stop remains available. This implementation provides no automatic
reconciliation of external effects.

Stop and deletion atomically supersede pending/accepted recovery ownership,
fence descendants, cancel reply obligations and request observed cleanup.
Restart preserves receipts and holds; abandoned recovery execution is contained
before generic orphan settlement. Pause receipts do not reference the
replaceable Agent projection. Direct Agent deletion removes private receipts;
project scheduler-Run deletion cascades them.

The unpublished migration has exact supported predecessor signatures (0029,
0028 and 0027). Foreign and partial schemas remain refused. The metadata object
ceiling remains 528; byte/row/work read ceilings are unchanged.

## Qualification

Run `node --import ./tests/shared/workspace-resolution.mjs --test tests/context-recovery/pause-resume.test.mjs`
after sequential builds. Tests cover all four phases through original Request
completion, exact replacement hashes, queue isolation, stale output, satisfied
roots, failure boundaries, Stop, restart, cleanup, fairness, command holds,
resource/scope rejection, supported migrations and schema refusal. Controlled
providers perform no inference. Passing tests do not establish native-provider
or UI parity. Exact-head independent runtime review and subsequent UI review
are required before integration.
