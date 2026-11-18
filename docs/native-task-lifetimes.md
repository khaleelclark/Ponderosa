# Native accepted work and the managed Run lifetime

This document records the original a10b Claude lifetime delivery. Its statements
that native per-task controls and Codex wiring remain unimplemented are superseded
by [native-task-controls.md](native-task-controls.md), the source successor. The
original provider contract evidence and restart limits remain applicable.

G8 source implementation, 2026-11-01, based on
`04e8e60bb` (the full base is recorded in the commit parent). This changes the
Claude persistent stream path only. It is not a whole-harness parity verdict.
Tests, builds, typechecks, native execution and provider qualification are deferred.
M2's lost-compaction-identity contract remains unchanged.

## Callable behavior and ownership

`ClaudeStreamSession.startTurn` opens a `ClaudeTaskLifetime` alongside the
existing provider turn. A native `result` no longer unconditionally ends the
managed Run. Observed accepted tasks and session-scoped schedules keep the
same managed Run open. After the final result, the matching session must report
`session_state_changed: idle`, with no retained tasks or schedules, before the
adapter emits the single final `turn_done`. Task completion before the result
is insufficient: the native background follow-up may still be running.

The host already owns this Run durably; no second Request, Agent, scheduler or
goal is created. The existing persistent executor waits for `turn_done` or error.
Keeping that boundary open retains the original scheduler lease, fence, scope,
tool capability and exact provider process authority. Existing steer inputs can
reach the retained session while it is waiting. Native timing, jitter, expiry
and job delivery stay with the provider; Ponderosa creates no new clock.

`ClaudeTaskLifetime` is used directly by the stream reader, not an unattached
journal. It provides `beginTurn`, exact registered `stopHook`, native lifecycle
`observe`, and result `project`. `ownsRun` also prevents idle compaction from
entering a still-held or uncertain source lifetime after an ordinary error.
Native-command receipts otherwise remain isolated from normal turn mapping.

Discovery reuses existing `work_item_update` and the Work-items projection.
Each native key encodes `[sessionId, taskKind, taskId, taskRunId|null]` as a
bounded JSON tuple after `native:`. The normal executor adds its exact
`executionId`; `persistRuntimeEvent` rejects canceled/replaced Run output.
Native terminal status is retained in the work-item title without treating a failed child as a successful receipt. The append-only log retains these identities; SQLite work items are existing
rebuildable projections, never a second scheduler. Repeated starts update the
same item; completed task-run identities cannot be revived by a duplicate start.
A newer native run of the same task ID retires the older item. Old/missing run
IDs cannot settle a stronger observed identity. A process-local background
snapshot never erases foreground edge-tracked work.

A registered native Stop hook supplies `background_tasks` and `session_crons`.
Only its exact callback ID and session are answered. Missing snapshot fields
do not clear known obligations. A native scheduling tool call adds only an
unresolved-receipt hold until that snapshot arrives; intent is never represented
as a successfully accepted schedule. Prompts, descriptions and command text
are not copied from these snapshots into authored communication or new work.
Schedule IDs alone suffice to retain the original lifetime.

A terminal provider error while this lifetime is open starts owned process teardown before emitting the error; the existing failure path cannot release the source fence while accepted tasks continue to mutate. This is failure containment, not successful task settlement.

Cancellation uses the **existing exact managed Run stop**, which fences the
Run and tears down its owned native process group. It does not reinterpret a
control acknowledgment as observed process drain. This lane does not introduce
a per-task stop UI or call Claude's `stop_task`. That provider control exists;
per-task cancellation is a distinct remaining integration surface. No
`perTaskStopAffordance` is advertised by this lane.

## Durability and honest unknowns

An injected source Run already survives restart as canonical scheduler state.
Existing startup recovery holds an orphaned injected Run as `outcome_unknown`;
this lane neither completes it from a task title nor restarts native work.
Observed native work-item identities remain auditable. In-memory lifecycle sets
are not restored as if they were a live provider registry. There is no claim
that a callback acknowledgment atomically commits the preceding work-item event:
the adapter stream is buffered, while canonical host persistence is downstream.
A crash before that append can still lose a particular native identity; the
original source Run remains unknown, never blindly replayed.

Restart-stable handoff to a *different* managed Run would require exact native
job/run discovery and a durable resume/deduplication contract. This implementation
retains the existing Run instead. It does not migrate scheduled prompts from
Stop-hook summaries: `SessionCronSummary.prompt` can be clipped, and the shape
has neither an authoritative next-fire occurrence nor a complete payload receipt.
The native schedule remains native. A recurring cron or deliberately long-lived
shell/watch can therefore keep the original Run open until native removal or
explicit Run cancellation. No independent host activation is promised.

Older producers with neither lifecycle signals nor observed obligations retain
the prior ordinary-turn completion behavior. Once work is observed, missing
terminal/idle evidence leaves it held. No universal compatibility claim is made
for producers that silently omit *all* lifecycle and schedule receipts. Invalid
identity/snapshot data fails the stream instead of silently dropping ownership.
Identity retention is bounded at 1000 native identities/results; overflow fails
rather than evicting replay protection. No automatic native mutation is used to
repair missing receipts.

## Pinned official contract research

Published official `@anthropic-ai/claude-agent-sdk` releases
[0.3.301](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.301) and
[0.3.316](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.316) were
read as tarball declaration source, without installation/import/execution.
Their `sdk.d.ts` SHA-256 values respectively are
`26f9a0c91ad64e2020f0d3734932302e3cc09685bddf2b2f9ef60839ce278773` and
`c7b4242562a4501812a86af97d4fb6d9cd3f631798442f692339b8a90a0c0f8a`.
The [official SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)
is an unversioned explanation, not installed-version qualification.

The declarations expose `task_started`, `task_updated`, `task_notification`,
`background_tasks_changed`, `session_state_changed`, Stop-hook background tasks
and session crons, and correlated `stop_task`. `run_id` identifies a task run;
a resumed task retains `task_id` but receives a new sortable run ID. The
background level is **per process**, with no startup snapshot; reinitializing an
already-running newer process requests a fresh level. The session idle comment
in 0.3.316 explicitly places idle after held-result flush and the background
agent continuation loop. No startup/restart durability is inferred from it.
The [native scheduling guide](https://code.claude.com/docs/en/scheduled-tasks)
distinguishes open-session scheduling from Desktop/cloud scheduling. This lane
maps only accepted work in the owned persistent CLI process, not external
Desktop/cloud routines or another account/session.

Codex official source is pinned to
`cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2`:
[method inventory](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/src/protocol/common.rs)
and [thread types](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/src/protocol/v2/thread.rs).
The real experimental APIs are `thread/backgroundTerminals/list` (paged exact
`threadId`, `itemId`, provider `processId`) and
`thread/backgroundTerminals/terminate` (`threadId`, `processId`, boolean
`terminated`). They are also in the
[official app-server documentation](https://learn.chatgpt.com/docs/app-server).
A provider process ID is not an OS PID or a durable scheduled-task receipt.
These APIs are **not wired by this Claude-only delta**. This is remaining host
implementation, not a claim the provider lacks discovery/cancellation. No
Codex schedule/accepted-future-turn receipt contract was established in these
inspected sources; no universal absence is asserted. Codex G2/G3 owner was
notified of these exact source seams.

Two guessed generated/Rust-flat source paths returned 404 during research;
official directory listings resolved the actual split `v2/thread.rs`. No 404
was treated as capability-absence evidence.

## Deferred regressions and composition

`tests/providers/claude-task-lifetime.test.mjs` contains deferred cases for
foreground/background ownership, task completion before native result, native
follow-up text, same-ID newer task runs, late/foreign/replayed frames, duplicate
result usage, native cron retention/removal, unresolved schedule receipts,
missing/malformed snapshots, weak-to-strong identity upgrades, blocked compact
while source ownership is uncertain, and the real stream-session callback/read
path through an inert owned CLI fixture. They are registered for later engines
execution, and have **not run**. The existing compaction prototype fixture
receives the new lifecycle member; its assertions are retained.

Runtime G1/G4 edits to `claude-stream-session.ts` must retain the Stop matcher and
exact G8 callback dispatch, alongside their own callback/control machinery.
This isolated delta does not modify provider routes, Run/receipt/authority
files, core adapter types or another writer's checkout. It claims Claude source
lifetime coverage only; Codex wiring, per-task stop UI, producer compatibility,
restart/unknown reconciliation and whole-implementation qualification remain
separate. M2 and M3 retain their prior exact boundaries.
