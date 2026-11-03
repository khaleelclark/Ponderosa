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

Large Join outputs can be canonical `branch-result-bundle` references. Use
`resultBundle(executionId, bundleId)` to read their retained content and hash through
the existing execution-scoped public route. The client does not substitute bundle
text into arbitrary authored input or treat it as continuation authority.

`export(branchId, mode, {includeValues:true}, fileSelections)` explicitly selects
nonsecret parameter values through the existing export contract; omission preserves
the existing default. File-family selections remain separate. Known secret fields
stay excluded, and full packages can contain sensitive history and stored data.

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
separate supported frontier. General parallel/map continuations beyond the bounded standalone Script subset below, provider/Agent
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

The public client exposes `designateOutput(agentId, {enabled, speaker})` and
`configureAssistant({enabled, initialize})` through those same server controls.
`initialize:true` requests ordinary first setup; `enabled:true` explicitly enables
or retries setup, and `enabled:false` disables it. Use `assistant()` to inspect the
current status after an uncertain response; these calls have no automatic retries.
`moveSpeaker` retains the reviewed-current-speaker check described above.

Output settings include `settingsRevision`, a hash of graph/binding/configuration
revisions, availability and trigger settings (excluding routine fire-time advances).
Saving requires `expectedVersionId` and `expectedSettingsRevision`; a direct
trigger switch or parameter edit cannot be overwritten from stale settings. Automatic runs cannot
be reported as enabled while the workflow remains human-disabled. Interval changes
preserve the workflow's busy policy and do not erase already accepted occurrences.
Schedule intake failures now name their actual cause while retaining due-time
retry and occurrence identity semantics.

## Current implementation scope

The public engine includes graphs, execution input/immutable result state, human gates,
streaming, configured native tools/memory, branch_call subgraphs and canonical multi-Agent
fork/join/map execution. Exact named capability semantics remain U1/U6, not a parity verdict.

Reviewed restoration includes bounded Script/parallel/Request/coordination-tree cuts,
standalone gen0 issued resources/groups/maps 2–32, standalone one-resource serial/local-parallel
history 1–32, and manual parent plus one called child with one gen0 serial ASYNC/SYNC resource
each. Tree web controls and the atomic per-owner consumer are assembled. Current bounds,
retained proof/privacy, lifecycle and Runtime gaps are in
[implementation coverage](implementation-coverage.md); exact remaining requirements/owners
are in the [single remaining inventory](phase2-remaining-implementation.md).

These interfaces retain current acceptance/policy/budget checks, explicit all-facts human
review and original-key readback; ordinary rewind cannot infer issued authority. Unknown
external effects and absent proof remain held. Broader unsupported combinations are scope
dispositions U2–U5, not an invented mandatory feature list. Numeric tree budget/counter and
Call ancestry review evidence is M4; tree controls themselves are delivered.

[Historical protocol continuations](branches-public-engine-history.md) retain earlier
source designs and route detail; their blanket missing-code statements are superseded.
No builds, types, tests, native/browser sessions or preparation were performed. Public-client,
framework comparator and full Bible/Build qualification remain deferred.
