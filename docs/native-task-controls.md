# Native task controls for the original managed Run

This source successor extends the frozen G8 `a10b3b353dc0392e760bf815b2187e5c59423c3e`
in the same isolated `phase2/native-task-lifetimes` worktree. It adds native
list/stop backends and a human REST contract. UI wiring and every execution,
build, typecheck and provider qualification are deferred. There is no whole-G8
or Bible acceptance claim.

## Frozen UI contract

Shared types are exported from `@ponderosa/core` in `native-tasks.ts`.

- `GET /api/agents/:id/native-tasks` returns `NativeTaskInventory`:
  `{runId, sourceFence, sessionId, tasks}`. Each task contains `taskKey`,
  `taskId`, `kind`, `cancellable`, and observed optional `taskRunId`, `itemId`,
  `processId`. Display native identities as text; keep `taskKey` opaque.
- `POST /api/agents/:id/native-tasks/stop` accepts exactly
  `{runId, sourceFence, sessionId, taskKey, idempotencyKey}` from that inventory.
  Generate one human command key and retain it across an uncertain HTTP result.
  A new key cannot retry the same exact task target.
- A successful response is `NativeTaskStopReceipt`, echoing the boundary and key,
  with `outcome` equal to `acknowledged`, `terminated`, `not_found`, or `unknown`,
  and **always** `processDrainObserved: false`.
- `GET /api/agents/:id/native-tasks/stops/:key` reads that receipt with query
  `runId`, `sourceFence`, `sessionId`, `taskKey` (URL-encode every field).
  It remains read-only after the source Run ends. Repeating the identical POST
  also reads the existing receipt without dispatch. A missing receipt is not
  permission to replay native work or invent a replacement ID.

409 means unsupported/unavailable/conflicting live authority, invalidated
inventory, or an uncertain persistence boundary; it never means the native
registry is empty. 400 means malformed input; 404 means absent Agent or exact
receipt. Do not automatically retry mutations. Offer the existing exact Run
stop as fallback. Source effects and original Run completion are separate from
these per-task receipts. Backend controls do not yet declare Claude's
`perTaskStopAffordance`: that declaration must wait for the actual human UI.
The manager queues UI work from this contract; no UI files change here.

## Host authority and durability

The route uses the existing descriptor-safe runtime facade and checks the live
ActiveRun identity, non-aborted controller, running/stalled ownership (never cancelling/terminal), exact native
session, current canonical scheduler Run/fence, injected prompt, unexpired lease,
and absence of a side-effect fence. It checks again after asynchronous discovery
and immediately before dispatch. A task must belong to the most recent complete
inventory for this exact owned Run/session. No prompt, title, tool output prose,
OS PID, guessed task ID, resumed orphan or foreign session can create authority.

`native_task_stops` is a canonical SQLite extension, with the same fresh-baseline
schema. It saves `unknown` plus exact boundary/key and timestamp before native
input. The key cannot bind another target; a unique exact target constraint also
blocks attempts under a different key. Receipt updates cannot resolve source
effects. A crash before the terminal receipt leaves `unknown`; neither restart
nor a later POST replays it. Agent deletion cascades these private receipts.
A local inventory cache is never reconstructed as a live registry after restart.

This does not make native mutation and host persistence atomic. A lease can be
revoked or a native task can change after the last observation. The provider
controls accept a stable task/process ID, not a conditional host fence or a
compare-and-stop native run/item ID. Observed run/item identities are checked
locally; no stronger remote atomic comparison or ID-retention promise is invented.
The existing canonical cancellation and process ownership remain the final host
containment boundary.

## Claude

`ClaudeTaskLifetime.inventory` projects exact active edge/background identities;
known cron IDs are visible with `cancellable:false`. `requireTask` rejects ended,
replaced, foreign or invented task keys and excludes schedules from `stop_task`.
The live session writes one `{subtype:'stop_task', task_id}` control request with
one UUID request ID. `ClaudeTaskStop` consumes only matching control responses on
the existing single reader, before other control consumers. Matching success is
`acknowledged`; wrong session, error, write failure, timeout or teardown is
`unknown`. No acknowledgement removes a task from the lifetime sets. Native
terminal/idle evidence is still required to release the original Run.

The protocol accepts task ID only: task-run generation is an observed local
binding, not an upstream compare-and-stop field. There is no cron deletion or
cross-Run schedule migration in this change. The original Stop matcher and exact
callback dispatch must coexist with Runtime's controls.observe,
handleNativeRequest and cancellation machinery. Preserve Runtime's later typed
startTurn/steer/writeInput serializer wiring when composing the shared session.

## Codex

`CodexBackgroundTasks` calls `thread/backgroundTerminals/list` with the exact
owned `threadId`, `limit:100` and opaque cursors, up to 100 pages/1000 tasks.
It requires every `itemId` and provider `processId`; rejects duplicates, invalid
pages and repeated cursors; coalesces concurrent reads; and invalidates its cached
inventory on a failed read. It ignores native command text, cwd, OS PID and
resource measurements. It never invokes terminal `clean` or `command/exec`.

Stopping consumes the listed identity before a single
`thread/backgroundTerminals/terminate {threadId,processId}`. Boolean true yields
`terminated`, false yields `not_found`, and malformed/lost acknowledgement yields
`unknown`. None is observed host process-group drain. The durable host target
constraint prevents refreshed inventory from authorizing a repeated mutation.

Every controllable Codex registry row must also match the exact item/process pair
observed on the current source turn. A foreign or older item in the same thread
fails discovery and cannot be stopped through this API. Thread identity alone
never grants a later Run ownership of an earlier terminal.

An exact current-turn `commandExecution.processId` receipt arms a terminal-registry
read at native successful turn completion. A complete nonempty registry retains
the original Run and produces exact identity work-item telemetry. Read-only
registry polling once per second waits for a complete empty registry before
forwarding the original `turn_done`. This is observation of already accepted
native work, never a model turn, host scheduler, clock for a future prompt, or
new goal. While held, new start/compact are blocked; human native list/stop remains
available. Read failure/unsupported endpoint after an observed PTY receipt holds
the source outcome unknown and starts owned process teardown. It never treats
failure as emptiness. Exact Run stop still closes the owned process.

Producers that expose neither a PTY identity nor another accepted-terminal
receipt retain ordinary-turn behavior and are not background-parity qualified.
Only provider-reported registry membership/removal is projected; removal does not
claim a successful exit code. Codex goal continuations remain G2's separate
external admission boundary. No scheduled-future-turn lookup contract is invented.

## Pinned primary contracts and remaining work

Codex source pin is `cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2`:
[thread types](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/src/protocol/v2/thread.rs),
[method inventory](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/src/protocol/common.rs),
and [exact commandExecution processId field](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts).
The existing RPC initializer already enables experimental APIs. This is source
contract support, not installed-version qualification.

Claude SDK 0.3.301 and 0.3.316 declarations and hashes are pinned in
[native-task-lifetimes.md](native-task-lifetimes.md). They expose `stop_task` with
`task_id`, correlated control responses, live task/run identities and the UI
capability caveat. No SDK was imported, installed or executed for this work.

Deferred fixtures cover paging, malformed/partial identity data, coalesced reads,
exact stop inputs, true/false/unknown semantics, no retry, Claude correlation and
unchanged lifecycle ownership, Codex terminal hold/removal, descriptor accessors,
canonical fence/lease/cancel/discovery changes, and durable duplicate command
behavior. The existing Codex compact prototype fixture receives only its new
identity-map member; its assertions remain unchanged. They have not run. UI integration, actual composed provider controls,
installed producer qualification, and whole-implementation testing remain work.
The original receipt-before-host-append gap, orphaned outcome_unknown recovery,
M2 lost-compaction/noIDs block, and unsupported cross-restart schedule discovery
remain unchanged. No new admission, deployment, push or production merge occurs.
