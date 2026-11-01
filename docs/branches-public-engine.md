# Branches as an application engine

`@ponderosa/core/branches-client` exports `BranchesClient` and `BranchesHttpError`.
The client uses public HTTP routes only and accepts a base URL, an optional fetch
transport, and per-call cancellation signals. It contains no provider adapter,
SQLite, host-folder access, alternate scheduler, or authentication mechanism.
An outside application can deploy a graph, submit inputs, inspect state, answer
human gates, cancel work and subscribe to existing canonical streams.

```js
import {BranchesClient} from '@ponderosa/core/branches-client';
const branches = new BranchesClient('http://localhost:3000');
const run = await branches.invoke(workflowId, JSON.stringify(input), requestId);
const state = await branches.state(run.id);
const actions = await branches.actions(run.id);
// Show the current gate and use its own id/revision when the human answers.
const action = actions.items.find(action => action.kind === 'gate');
if (action) await branches.resolveGate(action.gate.id, {
  commandKey: answerId, expectedRevision: action.gate.revision,
  decision: 'approve', output: JSON.stringify(reviewedState),
});
```

Keep `occurrenceKey`, deployment idempotency keys and human command keys stable
when recovering an uncertain response. Changed payloads with the same key conflict.
The client never retries a mutation or changes workflow authority on the caller's
behalf. Gate ids resolve through the server's canonical execution ownership. Cancellation of an HTTP
request closes that request; use `cancel(executionId)` to cancel canonical work.
No HTTP disconnect is a claim that an external Script or provider process stopped.

`state` returns complete text for one explicitly requested history page. Follow
`nextCursor` explicitly for older pages. `actions` is the independently bounded
current decision/failed-attempt projection. `evidence` retrieves one complete
Step; `result` retrieves the execution output. Input/output are strings and can
carry JSON; no client-side state is execution authority. Graph composition,
conditions/routes, forks/joins, maps, loops, tool-using Agents, memory-bearing
Agents and subgraph calls use the normal published `BranchDefinition` and local
bindings. Existing persistent Agent history and human access settings apply.

`streamWorkspace` and `streamAgent` make one SSE connection. Messages preserve the
wire event name, id, JSON payload, reset and snapshot indications. Callers persist
their last delivered cursor and choose reconnect policy explicitly; neither an
HTTP failure nor end-of-stream is silently retried. Returning from the iterator
or aborting its signal closes its reader. Workspace reset/snapshot requires a
canonical state refresh. Agent history may be a bounded preview; use `agent` for
its current projection and `fullOutput` with a segment's sequence for complete
canonical text. For live work, use `state.liveOutputs` and retain only response
chunks with that exact Agent and scheduler Run identity. Work telemetry must not
be republished as final authored Chat results.

`examples/branches-engine-app/server.mjs` is a separate Node application using this
public client. It exposes invocation, state, actions, gate answers, results,
cancellation and exact-current-target streaming for one configured workflow.
It reads `PONDEROSA_URL`, `BRANCH_ID` and optional `PORT`; it requires the installed
built `@ponderosa/core` package. It never imports Ponderosa server/store internals.
The example enforces its workflow boundary before operating on supplied execution
ids. It uses the user's existing Ponderosa runtime and does not start providers.

## Checkpoints and human review

`initialCheckpoint`, `checkpoints`, `interrupt` and `rewind` expose the existing
hash-bound checkpoint API. Rewind requires a settled source, unchanged owned
version/bindings/configuration, current capabilities, an immutable source cut,
and a stable command key. It creates a fresh execution; it does not roll back a
user's external files, undo external effects, copy old leases, or revive Requests.

Standalone single-path Script/condition/route continuations now include ordinary
human gates, both waiting review frontiers and resolved review prefixes. Audit
replay verifies the gate's prompt, proposal, choices, decision, edited output,
revision and sealed result against its graph. Gate closure records an explicit
checkpoint invocation identity. Waiting review is admitted as fresh manual data
before its fresh gate is exposed. Old gate/attempt/path/result ids are remapped,
old decision command receipts are not transferred, and a fresh pending review
notification belongs to the new gate. Source cancellation/history is preserved.
An approving human can edit the carried state through an editable gate; the next
node receives that output. Async, sync and exit checkpoint modes retain their
existing durability barriers. Script effects must have matching observed exit
proof before a saved gate frontier is executable.

Tree/subgraph and unstarted resource reservation rewind retain their existing
separate supported frontier. General parallel/map continuations, provider/Agent
Request effects, created ephemeral resource histories, recovery gates and secret
binding restoration are not encoded by this added human frontier. Those remain
specific implementation gaps; this is not a claim of full LangGraph/LangChain
parity, external-effect rollback, or cross-process writer isolation.

## Output apps and Assistant lifecycle

The server provisions the default Assistant metadata on first startup without
waiting for its page to be opened. Existing initialized/disabled installations
are respected; startup never recreates a deliberately removed speaker. Provisioning
failures are journaled as `AssistantStatusDto.setupError` and logged with their
cause. Explicit enable retries the same durable setup operation. Provisioning
creates metadata only; the first ten-minute schedule uses ordinary scheduler
admission and never expands the Agent's human-granted access.

`POST /api/branches/assistant/speaker` takes `agentId` and the reviewed
`expectedSpeakerId` (or null). It moves the one global speaker designation in one
workspace append, preserving the old Agent's history and output URL while
pausing its previous automatic workflow. A stale expected speaker conflicts.
Ordinary output designation still rejects creating a second speaker. Existing
portable-role reviews continue to require collision acknowledgement and never
silently replace a local speaker. Model/prompt edits retain the speaker identity;
the existing persistent-Agent settings path supplies its model to subsequent
workflow Requests and resumes provider-blocked work through normal recovery.

Output settings include `settingsRevision`, a hash of graph/binding/configuration
revisions, availability and trigger settings (excluding routine fire-time advances).
Saving requires `expectedVersionId` and `expectedSettingsRevision`; a direct
trigger switch or parameter edit cannot be overwritten from stale settings. Automatic runs cannot
be reported as enabled while the workflow remains human-disabled. Interval changes
preserve the workflow's busy policy and do not erase already accepted occurrences.
Schedule intake failures now name their actual cause while retaining due-time
retry and occurrence identity semantics.

## Implementation scope

This source change addresses #10 public composability, #16 schedule settings
concurrency/diagnostics, #28 output/Assistant lifecycle, and #32 public interfaces
plus standalone human-review rewind. The current graph engine already handles
subgraphs, multi-Agent workflows, tool/memory Agent access and three checkpoint
modes. Broader dependency frontier restoration, external-writer protocols and
full named capability parity remain implementation work. No builds, typechecks,
tests, browser runs, benchmarks or acceptance verdicts accompany this change;
regressions are written for the consolidated implementation run.

## Reviewed restrictions during workflow installation

The Branches installer uses the shared `BranchPackageEngine` contract from
`routes/agent-packages.ts`. Integrate portability commit `ec80fdea58` before this
caller; it supplies `reviewAccess`, reviewed-choice forwarding and typed conflicts.

After confirming the ordinary installation preview, poll
`GET /api/branches/installations/:id`. An `applying` installation can return
`accessSettingsReview: {chatRef, agentRef, chatId, review}`. The review contains
`reviewSha256`, exact source restrictions and current destination policy. New
Chats must exist before this review; their staged resources stay hidden. No
Agent is imported until its restriction choice is reviewed. Scheduler passes
leave a pending human review alone; ordinary Stop remains available.

Display the source and destination policy, then submit the human's choice to
`POST /api/branches/installations/:id/access-review` with
`{chatRef, agentRef, resolution: {action, reviewSha256}}`, where action is
`keep_destination` or `use_source`. The choice is durable per package Agent.
The endpoint rechecks the actual destination, durable pending review and applying
state after asynchronous policy retrieval. A stale choice returns 409 with the
current installation status/review; display it and ask again. A stopped or
terminal installation cannot be revived. A successful response clears this
pending review; the ordinary scheduler resumes installation. More Agents may
require their own review. The shared importer rechecks the hash again before
its writes. Existing Agents' destination access is preserved; this choice applies
to newly imported Agents only, and grants no browser sessions or credentials.

Deferred regression source covers keep-destination/use-source, missing and stale
review refusal, no pre-review Agent creation, terminal refusal and Stop. The web
review controls remain a separate owned caller. Working-folder bundles, new-Chat
mapping and additional reviewed grant forwarding still need their own shared
engine contract and callers; this access-first increment does not complete #8.
No execution or passing claim accompanies this source.

## General before-entry rewind

Explicit initial checkpoints now cover every validated graph node family when the
manual source was canceled before admission: parallel/map controls, human gates,
Agent/tool/memory nodes, ephemeral organizations and subgraph calls. Source must
have no admission time, paths or Step records. Rewind retains exact owned version,
binding, configuration, input and immutable checkpoint hash; it creates a queued
execution and durable idempotent lineage in the same SQLite transaction. The
ordinary scheduler admits all work anew, using current access/provider/resource
checks. No Request, lease, process, created resource or external effect is copied.
Secret-bearing configuration remains refused rather than restoring omitted values.
This removes the former Script-only initial-frontier restriction; in-progress
parallel/map/provider/resource cuts still require separate full continuation codecs
and cannot be inferred from this before-entry case. Deferred regressions cover
parallel/map/human-gate initial rewind, reopen/idempotency and empty runtime rows.
No consolidated execution has run.

## Workflow folder and nonsecret suggestion forwarding

Requires shared engine `54abf5bbdce4` and ancestors. Workflow package GET accepts
`fileSelections` as JSON keyed by local output/organization Agent IDs, with
`{selectedWorkingFiles?: string[], wholeWorkingFolder?: boolean}`. Each workflow
Agent is exported once using the shared folder builder; unknown/non-owned Agent
selections refuse. The existing byte, credential, path and link admission stays
in the shared builder. No organization subtree duplication is requested.

`POST /api/branches/install-preview` accepts `fileSelections` keyed by
`JSON.stringify([chatRef,agentRef])`. Values contain `workingFilesDestination` or
`workingRootDestinations` from the shared import contract. Each path is an
explicit NEW absolute retained-content location; destinations across targets
must be distinct and cannot nest. Existing Agent replacements refuse these
choices rather than silently ignoring them. The preview lists the chosen paths
and the retained-content limitation. The shared importer owns exclusive creation,
manifest validation and partial-file retention. Stop never deletes these user bytes.

Installation GET returns `importResults` keyed by the same target identity. It
retains `workingFilesDestination`, `workingRoots` and `accessSettingsToReview`
from canonical creation receipts, including after restart recovery and terminal
plan compaction. Receipt retention uses the existing time/count policy; it is not
an unlimited history service. Destination grants are suggestions: UI must show
Chat-wide memory effects/current revisions and separately call human Settings
APIs for memory, saved-browser access and destination profile choices. No grant,
profile, credential, old native ownership or session is automatically adopted.

Restored files are retained content. Live Project/managed-worktree binding remains
portability-owner implementation work; this caller cannot grant it by changing
paths. In-progress checkpoint resource/provider/parallel/map codecs and general
external-writer reconciliation likewise remain incomplete. No test execution or
full portability/parity verdict accompanies these forwarding changes.

### Current-coverage reconciliation at dispatch and resume

Sync dispatch now compares the current selected bytes with the exact saved
snapshot on every readiness check, including after saver reconstruction. A
process-local saved ticket alone cannot authorize a changed frontier or a new
invocation identity. Explicit checkpoint resume performs the same comparison even
when a local saved ticket exists. Missing, corrupt or mismatched bytes hold work;
these checks do not manufacture a snapshot, recover an unknown effect, or release
old leases. Deferred regression source covers saver reconstruction, changed path
content and changed invocation identity. No execution accompanies this change.

This closes a specific stale-coverage admission gap, not general cross-store
crash atomicity. In-progress fork/map replay, fresh Request/Join lineage, created
resource membership and reviewed secret/recovery bindings still require dedicated
continuation codecs. The single-path validator remains enforced.
