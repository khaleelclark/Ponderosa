# Branches foundation — Phase 1

The approved target remains [the complete architecture](branches-architecture.md), including conditions, fork instances, mixed joins, ephemeral Agents/organizations, gates, actions, retry policies and portable packages. The current executor deliberately rejects unsupported features at deployment rather than accepting a definition it cannot faithfully execute.

## Implemented behavior

A Chat owns each Branch. An immutable definition version and immutable local binding revision are selected atomically at manual intake. Repeating an occurrence key returns the accepted execution; changing its input conflicts. Queue admission survives restart. No Project ID is part of the Branch contract.

A Step invocation is identified by execution, path, step and invocation number. Attempts have separate identities, input hashes and fences. Paths, join arrivals and gates have distinct durable schema records; no linear array cursor is persisted. Only the linear success path is exercised in Phase 1. Shared contracts distinguish executable Steps from control nodes.

Persistent Agent and organization Steps bind to a canonical Request addressed to the existing Agent/root. Request creation and step binding share a transaction. Ordinary provider output and Run completion cannot advance the graph. Requests reporting unknown outcomes or supersession wait for reconciliation rather than guessing which workflow owns the result. Borrowed Agents retain identity, history and ordinary steering behavior.

Node Script Steps run as supervised non-provider operations in the existing scheduler. Script source bytes live in the immutable definition; a separate control pipe withholds them until process identity and the lease fence commit. The bootstrap verifies the source digest before evaluation. Workflow input travels through stdin, without shell interpolation. Cancellation fences completion immediately and remains waiting until complete process-group exit is observed. Recovery of submitted work becomes outcome unknown; only an unsubmitted lease can return to prepared. No script is disguised as an Agent or a Ponderosa Run.

The existing workspace audit receives durable checkpoints through an outbox, including process exit evidence and stderr. A crash between append and acknowledgement can replay the same `checkpointId`; consumers should treat that as one logical checkpoint. SQLite remains workflow authority; the audit is not replayed to reconstruct execution state. Cleanup proceeds before audit publication so publication failure cannot prevent process termination.

`CreateServerOptions.branches.maxConcurrentScripts` configures the host script-process budget (default 4). Each definition separately configures execution admission. The Engine still permits only one active provider Run per Agent.

`/branches` provides a distinct operational shell for installed workflows, manual input, recent executions, pinned version IDs, results, waits and cancellation. It links back to Dev. Existing Dev Automations are unchanged. Definitions are deployed through the Engine API in this first slice; a visual authoring/import experience is later work.

## Engine API

- `POST /api/branches/deploy`: `DeployBranchRequest` from `packages/core/src/branches.ts`. Updating an existing Branch requires its `expectedVersionId`. Deployment keys deduplicate exact retries.
- `GET /api/branches?chatId=...`: bounded installed-Branch list; omission lists the first 100 installations.
- `GET /api/branches/:id/versions/:versionId`: immutable definition and content hash.
- `POST /api/branches/:id/executions`: `{ occurrenceKey, input }` for manual intake.
- `GET /api/branches/:id/executions?before=executionId`: up to 100 executions in reverse acceptance order, with explicit older retrieval.
- `GET /api/branch-executions/:id`: step and attempt evidence.
- `POST /api/branch-executions/:id/cancel`: idempotent cancellation of that workflow, not indiscriminate interruption of a shared Agent Run.
- `DELETE /api/branches/:id`: explicit removal of workflow-owned definitions/history, only after executions drain and audit publication finishes. It does not delete borrowed Agents or source directories.

Chat and legacy container deletion fail closed while Branches still exist. Drain and explicitly remove those Branches first. This intentionally avoids introducing an unreviewed cascade through script authority.

Example deployment body (replace Chat/Agent IDs and the working directory with local bindings):

```json
{
  "chatId": "local-chat-id",
  "idempotencyKey": "summary-v1",
  "definition": {
    "schema": "ponderosa.branch.v1",
    "name": "Reviewed summary",
    "trigger": { "kind": "manual" },
    "entry": "review",
    "steps": [
      { "id": "review", "kind": "agent", "target": { "kind": "persistent_organization", "ref": "reviewer" }, "instructions": "Summarize the input and complete this Request with the summary text." },
      { "id": "format", "kind": "script", "runtime": "node", "source": "let text=''; for await (const chunk of process.stdin) text += chunk; process.stdout.write(text);", "cwdRef": "workspace", "timeoutMs": 5000 }
    ],
    "controls": [],
    "edges": [{ "id": "review-to-format", "from": "review", "to": "format", "on": "success" }],
    "policy": { "maxConcurrentExecutions": 4, "failure": { "action": "stop" } }
  },
  "bindings": { "agents": { "reviewer": "local-agent-id" }, "directories": { "workspace": "/local/chat/working-directory" } }
}
```

## Deliberate initial limits

- Recoverable Script launch currently requires macOS or Linux. Windows is rejected explicitly; its existing provider Job Object support is unchanged. A Windows control-pipe equivalent must be qualified before enabling scripts there.
- Scripts run with host authority, using the Chat's bound working directory. They are not sandboxed. No permission UI makes stronger claims.
- The first script runtime evaluates an ES module from a data URL containing pinned bytes. Node built-in imports work; bare package and relative imports are not resolved from the Chat directory. Package dependency resolution remains later work.
- Text is normalized using the shared canonical policy. This slice accepts inline text up to the existing 10,000-code-point ceiling. Larger input/output must use explicit managed file/artifact references; automatic long-result publication is not implemented here.
- Definitions currently support manual intake, persistent Agent/organization Steps, Node Script Steps and stop-on-failure. Gate resolution, conditions/forks/joins, retry/recovery operations, merging commands, ephemeral creation, other trigger destinations and package import/export remain future executor capabilities. Their runtime identities are not collapsed into a linear-only model.
- A borrowed persistent Agent remains a living shared resource. Definition pinning does not freeze its future context or global settings. This slice does not mutate borrowed Agent settings or implement mutable-guidance reconciliation.
- Branch/Step results are operational records, not new Communication or shared organizational context.
- The UI polls bounded projections; deployment APIs and checkpoint audit are canonical. No new transport, scheduler, provider abstraction or orchestration dependency was added.

## Verification

Focused runnable checks live in `packages/agents/test/branches.test.mjs` and `apps/server/test/branches.test.mjs`. They cover duplicate intake, version/binding pinning, restart without duplicate Requests, terminal Request settlement, script stdin/results, script-only execution without a provider Run, queue concurrency, cancellation fencing/observed exit, scope validation, inline output limits, deletion barriers, and actual daemon SIGKILL after an external effect. Recovery must not repeat that effect.

See the PR for exact final verification counts and commit. No merge, deployment, live ownership migration, or live subscription-provider qualification is implied by these tests.

Local verification on macOS/Node 24.15.0: 27 focused Branches checks, all 111 Agent package tests, all 207 web unit checks, and 39 focused server checks passed. Shared packages/server/web typechecks and the web production build passed. Browser qualification submitted a manual execution and observed its completed result in the distinct Branches shell.

The broad server run initially passed 223/225 checks. The HEIC test failed on `/proc/self/fd/17`; an untouched export of the approved baseline reproduced that failure (219/220 broad baseline checks passed). The copy-import rollback assertion also failed in the initial concurrent run, then passed all 11 import checks on rerun and in the baseline suite. This remains recorded as an intermittent qualification finding, not silently treated as a clean broad run.

## Phase 1 qualification fixes

The independent tracked reviewer found queue starvation, shutdown overlooking durable Script identities, and cancellation losing exit evidence. Qualification also reproduced partial Step settlement after a failed successor write and found workflow errors could block unrelated scheduler admission. Bounded scans now finish a fixed acceptance window before revisiting older work, persistence failures roll back the full transition, failed cleanup remains durable and visible, shutdown drains durable identities even before its first tick, and process observation can be audited after cancellation without accepting the canceled result. The shared scheduler contains workflow errors so ordinary Dev work remains admissible.

Regression checks include transaction-abort injection at intake, Request binding and successor creation; ongoing intake while earlier Requests settle; old Agent and Script bindings after deployment; provider Run completion without a Request outcome; failed cleanup retries; cancellation retaining stderr; and actual daemon death followed by shutdown before recovery. The UI displays canonical attempt status and cleanup errors. A running Script Step is now projected as running, rather than remaining leased.

The full model remains a target contract, not a claim that future execution features already work. Control evaluation, fork/join reduction, ephemeral resource ownership/cleanup, gate resolution, Action dispatch, and import/export still need their own implementations and tests. Step invocation and attempt identities, path and fork-instance identities, local bindings and immutable definitions support those additions without replacing current execution identity. Branch-level waits and terminal transitions in the current reducer are explicitly linear Phase 1 behavior; a parallel reducer must derive aggregate state from every live path.

Outcome-unknown executions currently support inspection and cancellation, not a Branch resume/retry/reconciliation command. Do not modify SQLite or repeat intake to hide an unresolved external side effect. Persistent Agent history and settings remain live shared authority; they are not frozen by a Branch version. Concurrency thresholds are pinned per accepted definition and count all running/waiting executions of that Branch across versions.

A second independent review caught cancellation cleanup failure followed by successful retry leaving the Step in outcome-unknown state. Recovery now settles the Step, attempt and execution consistently as canceled in the same transaction; an ordering-specific regression reproduces and covers the fix.
