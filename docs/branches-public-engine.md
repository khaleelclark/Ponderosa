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

Content-only destinations remain the default. Explicit live activation now uses
the portability service described below, requiring fresh local ownership. In-progress checkpoint resource/provider codecs, parallel/map cases beyond the bounded standalone Script subset below, and general
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


### Reviewed live working-root activation (portability f3a009bac dependency)

Per-target `fileSelections` accepts `workingFilesActivation:{}` for Separate-only
imports into an existing Git Project. Recovery destinations remain required.
To create a fresh managed destination, select `newManagedChatFolderName` plus
`workingFilesActivation:{}` for a single-Agent package Chat. The workflow uses the
ordinary managed Chat creator, then pauses with status
`workingRootReview:{chatRef,agentRef,chatId,sharedRoot}`. No Agent import occurs
until the human confirms the actual returned root through
`POST /api/branches/installations/:id/working-root-review` with
`{chatRef,agentRef,sharedRoot}`. The public client exposes
`resolveImportWorkingRoot`. A later ordinary confirmation/scheduler pass performs
import. Initial previews cannot fabricate a confirmed Shared root. Confirmation
is exact, durable, refused after cancellation, and excludes overlapping recovery
paths. The importer revalidates managed ownership, empty destination, mode and
fresh local working-copy receipts before population.

Status `importResults` retains `liveWorkingRoots` along with recovery destinations
and reviewed-grant suggestions, through receipt recovery and terminal compaction.
Omission retains content-only behavior. Same-Chat organizations and independent reporting roots use one grouped importer call described below (shared engine dependency d7ca2d196 atop 82cf46284).
Existing access/folder UI callers remain implemented; UI must additionally expose
this new creation/activation choice and actual-root confirmation. No tests, build,
types, browser or runner preparation were executed for this source change.


### Grouped organization and forest activation (shared composer dependency d7ca2d196)

For a same-Chat organization or forest, place the managed creation/activation and
recovery selection on its first authored reporting root target only. The caller delegates to `BranchPackageEngine.composeAgents` for one
organization package, keeps original parent refs, namespaces canonical artifact
refs and their historical attachment/artifact bindings, consolidates compatible
same-Chat memory, and collapses identical Shared manifests to one originals owner.
Conflicting source bytes/manifests refuse with a fresh-export instruction. Separate
root identities remain separate; differing source Chats do not acquire a shared
root by composition. Preview operations expose `groupedAgentRefs` and canonical
`workingRootRefs` when explicit per-root recovery mappings are needed.

After actual-root confirmation the caller reviews the complete composed package
against the actual destination Chat. `accessSettingsReview.agentRefs` identifies
the group. The access-review endpoint accepts optional exhaustive `agentActions`
for every source node with accessSettings, alongside action and the grouped
reviewSha256. Individual-package digests cannot authorize the group. One import
creates every Agent; planned IDs bind atomically to one creation receipt. Reopen
checks the complete ordered receipt membership and result mapping, verifies staged
memory once for the combined package, and retains group root/grant receipts on
each target. Partial/missing groups cannot fall through to individual import.
Cancellation uses the existing staged resource retirement and owned-copy cleanup.

Independent reporting roots remain explicit `rootRefs`; no synthetic manager is introduced. Grouping applies to fresh managed activation of the entire Chat. Existing-Agent regrouping remains unsupported. Shared identity comes from retained source Chat and working-copy mode, including whole-folder exports without preexisting `workingRootRef`. Preview uses the shared composer’s canonical root refs; submit a discovery preview then re-preview with exact NEW recovery mappings when needed.
Deferred regression source covers composition/reference invariants, conflicting
Shared exports, staged actual-root confirmation, mixed per-Agent review choices,
one receipt and two Agents sharing their actual fresh cwd. All execution deferred.
In-progress checkpoint fork/map/provider/resource families remain incomplete.

### Parallel checkpoint remapping groundwork (source only)

`branch-continuation-remap.ts` now supplies the typed data remapping used by
historical single-path and child-tree path restoration. It inventories Fork IDs,
Map/Fork shared identity, indexed Map items, bundles and existing Step/result/gate
IDs. Nested paths are ordered by captured ancestry rather than UUID sort. It
preserves graph node/edge keys, Join selection order, item indices, sealed item
bytes and original bundle content, and remaps captured ownership links. Exact
owned result-bundle pointers update together with input/result hashes. Missing
links, aliasing, cycles, foreign Join membership, changed item inventories or
bundle bytes, Requests and live/unknown attempt states refuse. Attempts reset to
zero fences; execution admission, resource custody and provider state are excluded.

### Standalone Script Fork/Map historical restoration (source only)

`branch-parallel-continuation.ts` now admits a bounded executable frontier:
standalone Node Script graphs containing nested Fork/Map controls, successful
`all` Joins and acyclic edges. It reconstructs the entire per-path inventory from
the owned audit prefix, including Fork start, sealed Map extraction, indexed and
concurrency-limited dispatch, Script preparation/lease/authorization/observed
successful exit/settlement/sealing, arrival, Join input order and nested parent
completion. Selected paths, traversal totals, Step invocations, attempts, sealed
results, Forks, arrivals, Maps and item state must match the reconstruction exactly.
A completed Script requires observed matching exit bytes and hash; manual result
settlement without that proof does not qualify a parallel cut.

The codec deliberately refuses `any`/quorum Joins, failures/unselected paths,
loops, condition/route controls in a parallel graph, bundles, human/recovery gates,
Branch Calls, Agent/Request/Action/resource dependencies and secrets. Single-path
and child-tree support retains its separate previous eligibility. Parallel child
owner trees are not enabled by this change. This limited subset is not full #32.

Standalone rewind and child-tree restoration now use
`branch-frontier-storage.ts`: one owner transaction inserts all ancestry-ordered
paths and remapped control rows, followed by selected-column read-back comparison.
Failures abort fresh acceptance, prefix, lineage and receipt together. Only owned
column lists enter SQL; old process identities, Request bindings, leases and
nonzero attempt fences cannot be inserted. Standalone lineage maps now inventory
Fork/Map/item identities as well as Step/path/result identities. Subsequent
checkpoints resolve the immutable source cut, remap its typed prefix, and replay
the fresh audit suffix before they qualify for another rewind. Current pins,
capability checks, fresh manual admission and durability barriers remain required.
No old scheduler admission or lease becomes runtime authority.

Deferred `tests/branches/parallel-continuation.test.mjs` covers actual Map and
nested Fork/Map capture/restoration, sealed undispatched items, ordered Joins,
reopen/idempotency, repeated historical selection, tampered audit/inventory,
unknown Request/effect refusal and atomic control insertion failure. The earlier
remapping regressions remain in `tests/branches/continuation-remap.test.mjs`.
No tests, checks, types, build, native/browser/runner preparation or execution were
performed, and no passing behavior is claimed.

Remaining #32 work includes the excluded parallel frontiers above,
Request/answer/Join immutable cuts with fresh authority, created-resource custody,
reviewed recovery/secret bindings and broader crash reconciliation. No atomic
historical Request/provider-cut serializer or native historical provider snapshot
API is available in the retained runtime contract. Current Request/getJoin views,
compact/resume and the Script codec cannot stand in for those mechanisms. Unknown
native effects remain refused; this change does not roll back external effects.

### Expanded parallel host replay and immutable dependency capture (source only)

This follow-through supersedes the narrow exclusions in the preceding standalone
Script section for the cases described here. The parallel replay codec now
reconstructs `all`/`any`/quorum thresholds, successful selection order at the
actual resolution point, impossible thresholds, partial-result policy,
failed/unselected arrivals, and both remainder policies. Cancellation is admitted
only for work that has not launched and has no child-owner dependency; any live,
unknown or previously authorized incomplete Script effect still refuses. A
canceled unlaunched attempt stays canceled after remapping and never receives an
old fence or operational cancellation obligation.

Conditions and routes reproduce selected/failure edges and direct unselected
conditional arms. Loops preserve per-path counts, global iteration evidence and
invocation numbering. Owned oversized Join bundles verify original content bytes
and hashes; remapping updates only owned pointers and derived hashes. Cross-owner
bundle forwarding remains unsupported. Failed Script results must match the
runtime's sanitized failure summary and an observed exit with matching stream
hash, rather than turning raw stdout/stderr into a result or inventing an exit.
Limit exhaustion, retry/recovery and unknown-native events remain ineligible.

Ordinary human gates may coexist with parallel work. The codec checks the
interpolated prompt, exact proposal, choices, response revision, explicit decision
and edited output, including rejection/unselected behavior. Restored waiting gates
receive fresh identities and pending notifications. Existing human decisions are
retained only as data for already sealed prefixes. The existing child-tree codec
now supplies parallel owners with exact parent/call identities, completed or
unfinished child membership, descendant traversal/loop totals and owned source
prefixes. Child admission and completion must match that context. Parallel tree
restoration inserts all controls atomically; waiting tree reviews get fresh
notifications. Failed children, cancellation of child-owned work, foreign bundles,
provider calls and released resource transfers are not enabled by this extension.

`branch-host-cut.ts` adds a separate observational dependency serializer, invoked
by the checkpoint saver inside the same SQLite owner transaction. It starts only
from exact Request/recovery bindings of the selected execution's own attempts,
then captures canonical Request versions and payloads, updates (including
question/answer links), late results, question suspension references, recovery
predecessors/successors, ordered Join members, continuation identities and frozen
Join outcome observations. It preserves original Project/Chat/participant and
Communication scope. Original update-envelope hashes are retained as provenance;
new per-row hashes bind the captured bytes without pretending the original hash
was merely a hash of payload text. Artifact original identities, hashes and byte
lengths are retained as references; artifact blob bytes are not embedded.

The same host cut captures resource membership, per-generation original contexts,
creation operation records already selected by the Branch, cleanup receipts and
the binding revision/hash plus required logical secret refs. It never copies
secret values/handles, reply authority, Run admission, leases, scheduler state,
process identities, activation delivery state or outbox effects. Frozen Join
observations exclude inherited reply authority and continuation instructions;
they do not become new activations. The cut has explicit
`fresh_admission_required` / `not_captured` authority/native-state markers.
Missing retained references or gaps in the host update prefix are marked as
incomplete coverage, not repaired from current UI views or silently treated as
complete. Explicit Project/Chat escape or malformed canonical bytes refuses.
The bounded capture refuses more than 512 connected Request/Join identities,
more than 512 retained updates for a Request, or an aggregate cut above 8 MB.

Dependency evidence is frozen at that capture boundary. It does not make an
Agent/Request/resource frontier executable and is excluded from the comparison
that grants dispatch coverage to an unchanged selected executable frontier.
Current selected rows, continuation bytes and saved snapshot hashes still must
match. This prevents unrelated later Request progress from stranding a sync
execution behind an observational digest. The saver uses a read transaction for
standalone coverage reads, so selected inventory and dependency bytes are never
assembled from different SQLite views. Historical dependency verification uses
saved row hashes, not mutable current Request projections.

Deferred regression source extends `parallel-continuation.test.mjs` with
threshold/remainder variants, failed exits, excluded conditional paths, route and
loop state, bundles, fresh parallel human reviews, and unfinished parallel child
owners. `host-cut.test.mjs` covers question/answer and Join lineage, preserved
scopes, immutable capture under later progress, absence of operational authority,
and observational-only checkpoint admission. These are source fixtures, not
executed or passing results.

Still incomplete: restoring historical Agent Requests under a newly reviewed
admission, transferring released created-resource custody, rebinding changed or
secret-dependent authority through an explicit review workflow, provider-native
historical state and general crash reconciliation. Existing strict current-pin
checks and retired-resource ownership checks are retained. Atomic SQLite restore
rollback does not roll back external effects. No full #32 claim follows.

Runtime contract review further constrains host capture to exact owned root
Request Chats and participant scope. A related Join owned outside that scope or a
member unavailable to its Join owner refuses capture; manager/roster visibility
is not authorization. The saved bundle is private evidence, not a grant to
Branch readers: capture/read/adoption services must recheck current grants and
original Communication/artifact audiences before disclosure. Those service
paths are implemented below for bounded independent adoption; graph Request
admission remains unfinished. This serializer freezes
the current transaction boundary; arbitrary older Join state cannot be rebuilt
from mutable Join rows, which have no complete transition journal. An older cut
requires its already saved immutable bundle. Deferred privacy regression source
is included; no tests or execution were performed.

### Operator read and fresh host Request adoption

`POST /api/branches/:id/executions/:executionId/host-request-review` takes
`{checkpointId,expectedHash,requestId}`. It reads an already retained immutable
cut, verifies complete retained coverage, snapshot/row hashes and the selected
update prefix, and returns
only the selected Request's payload, versioned updates and artifact hash/length
references. It never returns the whole dependency closure, unrelated Join member
payloads, blob paths, secret handles, or runnable authority. Operator-only HTTP
request hooks reject Agent capability tokens; this is not a Branch-reader or
provider tool. Both original participants must still exist in their original
Project/Chat. The exact Chat must remain owned by this Branch (or be its explicit
legacy Chat), with no deletion or installation retirement in progress. Original
Communication audience/payload identity and artifact ownership/hash are checked
against canonical retained rows. The server additionally requires current managed
artifact grants for both the operator and the original recipient. Missing grants
refuse even if the old cut is intact. Blob availability is not asserted by a
metadata reference. Temporary-Agent recipients refuse until custody is resolved.

The review includes a digest bound to the saved cut, current Request version,
current Branch version/binding/configuration revisions, policy and enabled state.
It displays current safe configuration, binding/version identities, restrictions
and logical secret names, without handles/values. It does not revive old grants.
Branches with no legacy Chat now capture exact owned root Request Chat scopes;
multiple Branch-owned Chats are not conflated into a synthetic shared scope.

`POST .../adopt-host-request` takes the same selection plus
`{reviewHash,commandKey,instruction,mode}` (`mode` is `reconcile` or `independent`),
and optional `acknowledgeChangedBindings` / `acknowledgeSecretBindings`. The
client exposes `reviewHostRequest` and `adoptHostRequest`. A changed review returns
409 and requires another explicit review; the client does not silently retry it.
Changed version/bindings/configuration and secret-dependent current authority
require their explicit acknowledgements. These acknowledgements apply only to
this independent work, not to graph-prefix rebinding or granting secret access.

Adoption rechecks original scope and current grants inside the same immediate
owner transaction as ordinary canonical `coordinate` intake and a Branch command
receipt. The new Request has fresh identity and the exact original recipient and
Chat, no requester impersonation, inherited reply authority, recovery edge,
activation identity, lease, or synthetic old completion. It requires a settled
source/Request and a drained recipient runtime. An unknown original outcome
requires `reconcile`; automatic effect replay is not offered. The operator must
supply a fresh instruction. Evidence is explicitly untrusted, carries the saved
cut reference, original Request and latest selected update, and is capped at
256 KB rather than injecting an entire update journal. Larger cuts remain
readable separately and refuse automatic adoption intake.

A crash before COMMIT rolls back Request intake, activation, idempotency and
receipt together. A committed command whose HTTP response was lost returns the
same fresh Request after scope/grant and receipt validation, without creating a
second activation. Changed command bytes conflict. A revoked grant still refuses
an idempotent retry. This is a local transactional reconciliation mechanism; it
makes no claim about rolling back provider or external effects.

Settled failed child owners are now part of supported Script/control trees.
Their terminal invocation/outcome, failed root path and sanitized Script failure
must match canonical audit replay and the parent `child_completed` state/result.
Failure edges are followed explicitly. Fresh restoration retains failed child
state as historical data and never schedules those terminal children again;
restored-prefix verification handles the preserved failure as well as success.
This does not authorize cancellation of live or child-owned work.

Remaining exact seams: graph restoration still lacks a reviewed identity mapping
from an old Agent Request to a newly admitted obligation and its unresolved
answer/Join dependencies. Independent adoption deliberately does not wire its
result into an old Step. Resource restoration lacks a reviewed old-to-new
Chat/Agent/creation-operation custody mapping, complete retained private managed
content and a service-owned adoption transaction; existing resource provisioning
and cleanup tokens belong to the original execution/generation and cannot be
transplanted. A deleted original participant therefore remains unreadable and
unadoptable. Changed/secret graph-prefix rebinding needs its own reviewed pin
mapping through restored-prefix and suffix verification; the operator adoption
acknowledgements cannot substitute. Live/child-owned cancellation needs observed
child/process drain plus exact canceled-outcome/gate replay. Forwarded bundles
need a captured cross-owner transfer graph and global typed pointer/hash mapping;
local bundle ownership checks remain strict. Retry/recovery/limit frontiers need
explicit attempt-generation and exhausted-budget replay codecs. None of these
missing internal mechanisms is represented as an unavailable provider API.
Historical native provider state remains a separate absent external contract.

Source-only deferred regressions cover fresh Request/receipt replay, rollback
between intake and receipt, stale and secret-dependent review, changed Chat or
participant custody, artifact revocation/hash change and settled failed-child
restoration/reselection. No tests, typechecks, builds, Node, native process,
browser or runner execution/preparation occurred. No full #32 acceptance follows.


The executable graph codec also accepts persistent-Agent nodes before their first
Request is issued. This includes Agent items in an otherwise supported Fork/Map
graph and persistent-Agent suffixes of supported child-owner trees. Selected
Agent attempts must still be prepared, at fence zero, with no Request, recovery
reference, result or runtime outcome. Issued Requests require the separate
reviewed canonical graph path described below; uncertain effects remain refused.
Exact audit replay and the full owned
frontier remain required; a fabricated Script observation cannot certify an
Agent node. Rewind rechecks each persistent target in its current owning Chat
before accepting fresh graph rows. Normal admission then creates a new Request
and the ordinary Request reducer routes its new result through that restored
Step and Join. This restores a before-effect graph frontier; it does not restore
an unresolved historical question/answer/Join closure.

Deferred regression source covers standalone async/sync Agent cuts, fresh
Request identities/results, lost-response rewind replay, and concurrency-limited
Map Agent items feeding a restored Join. These regressions have not been run.


Parallel Script frontiers now encode automatic per-Script retry generations
under an otherwise stop policy. Every generation is contiguous, shares the
original Step/input, and retains its own exact observed process-exit/result.
A retry must follow a failed, observed generation without a failure edge, obey
the configured maximum attempts and delay, and match the owned retry checkpoint
and availability timestamp. A failed result cannot seal early while an automatic
retry remains due. Delayed prepared paths retain their waiting state until the
next lease. Restoration keeps prior failed generations as immutable data, maps
every attempt identity, resets fences, preserves availability, and submits only
the unlaunched suffix through fresh Script admission. Prior Script generations
are not launched again. The existing transaction and lineage receipt cover
reopen/lost-response replay. Human recovery, Agent recovery, operator retry,
resource fresh-context rotation and exhausted traversal-budget restoration remain
unsupported. Deferred source regressions exercise immediate/delayed Map retries,
restoration/resumption/reselection and generation/time/audit/exit tampering.

Runtime source consultation confirms the unresolved Request seam is an internal
domain operation, not an unavailable provider feature. User updateRequest cannot
author a question; forging the recipient actor would misattribute imported
history. Enclosing live coordinate/update calls in a transaction still leaves
intermediate wake deliveries runnable after commit. An implementation needs
explicit historical provenance and fresh final deliveries without copied reply
authority. The retry-specific resource transfer is similarly usable only with
verified live generation, creation receipts, member/Chat ownership and no cleanup;
its existence does not authorize arbitrary historical resource transfer. These
seams remain refused rather than impersonating an original participant or
reusing old activation/resource authority.


A running Script remainder canceled by a parallel Join can now appear in an
executable historical frontier only after its matching launch-generation exit
and advanced-fence cleanup observation are both in the owned audit. Replay
models canceling as uncertain until that drain closes; Map pending-cleanup
notices are not completion proof. The final canceled attempt has no accepted
result. Restoration maps its identity with fence zero and schedules no
replacement for that canceled effect. Child-owned or Agent cancellation, missing
exit/cleanup, live effects and uncertain frontiers remain refused. Deferred
regression source covers an any-Join canceling an already authorized Map Script,
refusal before drain, exit/cleanup tampering and no relaunch after rewind.

The runtime owner supplied the internal Request restoration contract implemented
by the retained canonical coordination path below. A dedicated owner transaction must
validate the saved cut and current original scopes/grants, assign new Request,
update and Join identities, and retain source authors as historical provenance.
Imported question/answer facts need explicit historical kinds or a separate
restore reducer; live recipient question authorization must stay unchanged.
Mapped open-question pointers and suspensions must reference new identities,
ordered Join members must have exact final version/update outcomes, and only
the final appropriate question/answer/Join activations may be published. The
restoration receipt and all maps/rows/outbox writes must commit atomically.
Question/history readers must label imported provenance and support new live
answers without treating historical facts as freshly authored messages. These
requirements apply together to every supported issued-Request frontier.
Provenance tables alone cannot enable restoration.

### Retained canonical coordination graph import (source continuation)

`BranchesClient.reviewHostGraph` / `restoreHostGraph` call operator-only
`host-graph-review` / `restore-host-graph` execution routes. The server selects an
already retained hash-verified complete host cut; request bodies never supply
canonical rows, actors, grants or SQL. Every Request is reviewed independently
against its exact original live Project/Chat/requester/recipient and original
Communication, plus current artifact grants for every participant receiving its
material. A Join owner is a participant of every member, never an inferred
manager/roster grant. Review hashes bind the per-Request current authority reviews
and the entire selected graph. Reads and idempotent adoption recheck original
scopes; deleted participants or revoked artifacts refuse.

The new internal `CoordinationV3CutRestorationAuthority` validates the saved
transition prefix with a dedicated fact-validation path over the canonical
reducer. It inserts fresh Request identities and final projections, mapped
updates/open-question/answer pointers, fresh ordered Join memberships and
continuations, and mapped question suspensions. It never calls live `coordinate`
or live `updateRequest` to synthesize history. Imported question/answer rows use
`historical_question` / `historical_answer` and system import authorship. Other
historical update facts also have system import authorship and immutable origin
rows containing source identity, version, original envelope hash and original
actor as evidence. No historical actor is impersonated. The live authorizer does
not accept the historical kinds. Source payloads are nested, explicitly labelled
untrusted evidence; they do not supply reply/run/lease/session authority.

The migration registers immutable restoration receipts and update origins. The
receipt maps, canonical rows, suspensions, only final pending Activations and
outbox records commit in the same immediate owner transaction. A precommit
failure rolls them all back. A committed lost response returns the same maps
without a second activation after rechecking scope and new Request identities;
a changed command conflicts. This covers this admission transaction, not external
effects or general recovery.

An outstanding historical question gets its fresh mapped ID and one question
delivery to its original requester Agent (or remains an operator-visible question
when the requester was the user). An open Join keeps its continuation suspended.
A new live answer references the mapped historical question and uses the normal
answer reducer and delivery path; future new member completions use the canonical
Join authority and wake mapped continuations. Answered/runnable recipients get
explicit reconciliation work. Completed facts do not relaunch their effects.
Terminal Join deliveries require frozen observations to agree with final selected
member versions and payloads; later post-resolution member changes refuse. There
are no intermediate historical progress/question/answer/result wakes. Each final
delivery is bounded to 256 KB and uses normal pending-intake limits.

Question retraction/failure readers recognize historical questions; lifecycle
history and summaries order by canonical version, expose immutable origin labels,
and show historical question/answer labels and numbering in the existing Request
card. Imported facts cannot become newly authored Agent Communications. Artifact
publication ownership is not copied. Re-capturing an imported question/answer as
a second restorable cut currently marks coverage incomplete until restoration
provenance itself has a retained-cut codec.

Current refusal boundaries: original graph/source must be settled and participants
must have observed drained runtime with no conflicting pending delivery or live
Request ownership; temporary participants require custody transfer; pending Agent
creation, unknown outcomes, supersession/recovery chains, expired lifetimes,
Decision suspensions, untracked dependency waits, changed or secret-dependent
graph pins and inconsistent frozen Join outcomes are not admitted. Explicit
`reconcileEffects:true` is required. This never authorizes replay of an unknown
native effect.

**Issued-Request Branch rewind:** supported nonsecret persistent-Agent single-path
and Fork/Map cuts attach canonical restoration maps to fresh Branch
Step/attempt/path identities in the historical-rewind owner transaction. The
operator first calls `reviewHostGraph`, then supplies
`graphReview:{reviewHash,reconcileEffects:true}` to the existing historical rewind
route/client. The server supplies current artifact grants; no grant is accepted
from JSON. Ordinary before-effect rewind keeps its existing input.

Capture and replay verify the original binding, original `branch:<attempt>`
Request identity, exact authored task/input, original audience, complete update
prefix and reducer projection, one owned `request_bound` event per issued
attempt, and version-matching completed output for settled Agent prefixes.
Historical payload hashes are verified. Supported cuts may contain an unresolved
question/answer/Join graph or a completed Request awaiting Branch reduction.
A selected completed Agent prefix requiring user Communication remains refused;
a live restored suffix still requires fresh Communication proof. This proof uses
canonical Request/update/Join source lineage and exact submitted Run/Agent IDs.
Concurrency accounting uses the same source lineage for restored update-based
deliveries. Historical rewind now participates in the server work-admission fence
because it can commit canonical runnable deliveries.

Fresh Branch budget admission, canonical graph identities/final-only deliveries,
mapped frontier rows and lineage/command receipts commit together. The lineage
retains complete canonical maps and the graph review hash. Lost-response retries
revalidate current original grants and both canonical and Branch ownership
without publishing another delivery; insertion failures roll back both graphs.
An independently restored graph cannot be adopted as a rewind suffix. Retained
terminal facts are consumed as data; waiting attempts observe only the mapped
fresh Request. No old Run, reply, lease, session or effect is relaunched.

Issued-Request child-owner trees, resources, failed/cancelled/uncertain or recovery
attempts, changed or secret pins and restored-history recapture remain refused. Released resource
custody, graph binding/secret remapping, Agent/child cancellation, forwarded-bundle
pointer/hash transfer, recovery/exhausted-budget codecs and broader crash
reconciliation remain outside this increment. This is a supported internal path,
not full #32 acceptance.

Deferred regression source in `tests/branches/host-cut.test.mjs` covers imported
terminal facts without effect relaunch, fresh identity/provenance/receipt replay,
rollback during origin insertion, exact mapped historical question/live answer,
and new member completion waking the mapped Join continuation. These files have
not been executed. No tests, typechecks, builds, Node/native/browser/runner
preparation or execution was performed for this source continuation.

Migration integration: coordination restoration uses `0036_coordination_cut_restorations.sql`; Runtime owns `0035_provider_context_recovery_progress.sql`. Integration must preserve both registrations and Runtime context-recovery behavior. The Branch worktree does not copy or replace the Runtime migration.

Branch terminal reduction now requires an update matching both the Request's final
state and exact canonical version. For imported results it verifies the immutable
restoration receipt, fresh Request/update mapping, retained cut hash and coverage,
source payload hash/version/state/actor and the import envelope before consuming
the retained result payload. Import explanation text is never a Step output.
Missing or inconsistent result provenance leaves the attempt waiting for explicit
reconciliation. Ordinary live results retain their ordinary payload semantics;
authored fields cannot opt into import authority. Required user Communication
still needs the existing fresh Request/Run proof and is not satisfied by old
historical evidence. Deferred source regressions cover retained output, altered
mapping/version/payload, missing provenance and a missing final update version.
The issued-Request rewind path above uses this reader for retained terminal
facts and normal canonical reduction for future fresh outcomes.

Deferred issued-prefix integration regressions cover live and retained terminal
results in fresh Branch suffixes, mapped historical question/live answer/member
completion/Join continuation, receipt replay before and after completion,
canonical-plus-frontier rollback, refusal without review, and refusal to borrow
an independently restored graph. No regression or execution check has run.
Additional deferred cases reject mismatched Request links, removed owned audit
events and terminal versions, and retain capacity accounting for update-sourced
restored delivery.
A mapped suffix requiring user Communication also refuses completion without
fresh canonical publication proof; a historical or missing event ID is insufficient.


### Issued Fork/Map, exit and mixed human-gate frontiers (source continuation)

The existing parallel replay reducer now consumes each issued Agent's exact
`request_bound` event between preparation and settlement. Shared issued-frontier
validation checks original `branch:<attempt>` identity, complete canonical
update prefixes and final projections. Binding/Chat/task/input validation still
runs in the enclosing Script/control replay before delegation. Agent settlement
must match the selected terminal Request version and retained payload; human
gate and Script observations cannot certify Agent output. Waiting Requests retain
active owned paths, so concurrency-limited Map dispatch and ordered Fork/Map
Join reduction resume through the mapped canonical Request. Agent cancellation,
retries, unknown outcomes and child-owned effects remain refused.

Mixed captured human gates use the existing gate codec, fresh identities and
fresh pending notifications. Canonical restoration records budget admission and
workflow start once; gate restoration reuses them and preserves running paths
alongside waiting reviews. Resolved reviews remain historical prefix facts.
No old gate notification or decision authority is copied.

Exit-mode prefixes containing issued Requests are admitted only when the existing
closing-invocation proof succeeds. Waiting issued Requests still prevent closure;
this increment does not treat a live or uncertain native effect as drained. A
closed exit cut may include a completed Agent prefix followed by a captured human
gate or safe control frontier. Rewind uses a fresh invocation and retains the old
closing invocation only in lineage. Terminal Request facts create no recipient
Request delivery. Original grants, final-only canonical wakes, exact Communication
proof, owner-transaction rollback and lost-response receipts are unchanged.

Child-owner tree integration remains unfinished: its per-owner sealed host cuts,
reviewed owner pins and shared Request/Join closure must be captured and validated
before a single canonical mapping can be attached to all fresh tree owners. The
existing tree validator still rejects issued Requests. Calling restoration once
per child would conflict on shared participants/graphs and is not an accepted
substitute. No unrelated resource, secret, recovery or cross-owner forwarded
bundle cases were widened.

Deferred source in `tests/branches/host-cut.test.mjs` covers async/sync/closed-exit
Map and Fork frontiers, simultaneous captured review and Agent work, fresh
canonical IDs and zero fences, pending Map dispatch, receipt replay before and
after suffix completion, exact request-bound/terminal-version/gate-response
refusal, and rollback of canonical rows/outbox plus fresh gate notifications.
No test, check, typecheck, build, Node/native/browser/runner preparation or
execution was run. This is a partial source slice; child-owner trees and full
#32 acceptance remain outstanding.
