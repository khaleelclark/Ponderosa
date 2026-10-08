# Ponderosa Branches — architecture proposal

Current architecture: [Branches product model](branches-product-model.md) supersedes the ownership and package proposals below.

Historical status: conceptually approved by the operator on September 17, 2026. This is the original research/design record; see `branches-phase1.md` for implementation status. The ownership/approval blockers and proposed next actions in the historical handoff below were subsequently resolved by the operator.
Research date: September 17, 2026.

## Recommendation

Build Branches as a workflow product over the existing Engine, with a small durable workflow domain inside the existing SQLite authority and scheduler service. Use **Step** in the UI and contracts. Keep Agents, Requests, Agent Joins, Activations, provider Runs, steering, artifacts, and provider adapters intact.

Use the Chat-owned experimental model as the design baseline. A Branch belongs to a Chat execution context; folders organize it but confer no authority. Persistent organizations are addressed by a root Agent in that Chat, not by inventing an independent organization runtime. A Branch version describes workflow structure; a Branch execution records one accepted invocation; a step invocation binds to an existing Request or to a supervised non-provider operation.

The first proposed implementation proves manual trigger → persistent Agent Request → Script → terminal result, including immutable version pinning, queued executions, and restart recovery. This milestone remains a proposal until the complete model below is approved.

## A. Evidence and current-state architecture

### Baseline and limits of verification

The remote advertises `experiment/chat-first` at **f3e44b8f94d2fa106c4e4c0c51119e2fb18301f5**, dated September 16. I fetched that branch and inspected committed source directly without checking it out or executing its runtime. It follows `experiment/project-rail-runtime`, whose remote tip is **2dd5f6faa5c39cdcd4ea2ccbb138b1441be18bac**. The remote also advertises `experiment/browser-overhaul`; this report does not claim to audit that separate experiment.

The supplied checkout is `master` at **32dc7bf0f2bc4c6c3f1b7dbf833961bd6d56ac42**. Its cached upstream is 889 commits ahead; the separately queried current remote `master` is **e1c88eab3c923be4c6dfb300282e3cccb75c3a7f**. The checkout contains untracked `PONDEROSA_BLIND_UI_AUDIT.md` and `ux-audit-screenshots/`. Both were preserved. No build, tests, provider invocation, live-state migration, commit, push, or repository file edit was performed. Fetch updated Git metadata only.

All source references below refer to the inspected experimental commit, not to the old local checkout. This is a source audit, not a claim that the branch has passed live deployment qualification.

### Ownership actually implemented

| Concept | Experimental behavior | Branches consequence |
| --- | --- | --- |
| Chat | Independent instructions, runtime defaults, working-directory association, and live Agent ownership. Migration preserves IDs. | Use `chatId` publicly, resolving the existing `conversationId` internally. |
| Agent | Stable ID, exactly one owning conversation, mutable manager, model/engine settings, working copy, history. | Reference identity; never copy history to a workflow record. |
| Organization | Agent reporting relationships and root/descendant projections; portable packages have `rootRef` and `managerRef`. | Address a persistent organization by its entry/root Agent and owning Chat. No separate organization authority is required initially. |
| Sidebar folder | Presentation preferences only. | Moving a Branch or Chat cannot change scope, paths, or permissions. |
| Automation | Intended to become Chat-owned, but DTOs, occurrence authority, routes, and storage still carry Project ownership and require a target Agent. | This is an unfinished migration, not a ready general-purpose workflow trigger API. |
| Artifacts | Existing managed catalog/journals; experimental ownership validation and explicit legacy custody recovery. | Reuse IDs and access checks. Never infer sharing from an old Project visibility label. |
| Working directory | Chat context supplies a host path; Agents may use explicit separate Git copies. | Bind environment paths locally. A folder association is not a sandbox. |
| Deletion | Chat deletion archives/fences intake, delegates Agent cleanup, and commits a durable deletion receipt; failures remain pending. | Add Branch dependency/drain checks to this lifecycle, not a separate delete cascade. |
| Provider session | Replaceable session machinery beneath stable Agent identity and scheduler Runs. | Never use a session ID as Branch execution or step identity. |

`getChatContext()` currently returns a `ProjectDto` shaped compatibility object using the Chat's settings. New public Branches contracts must not repeat that shape. A narrow typed Chat execution-context contract should replace this dependency at the integration boundary, while legacy storage identifiers remain internal.

The experimental migration document is more current than portions of `docs/system-model.md`, trigger DTO comments, and `AGENTS.md` product wording. The latter still describe Project-wide ownership. Preserve their safety invariants while following the explicit Chat-first product direction. The migration document also requires separately authorized promotion and exact snapshot qualification; this task does not authorize promotion.

### Research findings and reuse map

| Required research | Source evidence at the baseline | Finding |
| --- | --- | --- |
| Automation → Activation → Run | `trigger-service.ts`; `coordination-v3-trigger-occurrence-authority.ts:63–175,261–382`; `coordination-v3-scheduler.ts:216–219,340` | Occurrence acceptance snapshots trusted instructions/config, hashes payload, deduplicates `(trigger_id, occurrence_key)`, and later creates an Activation. Only scheduler leasing creates provider Runs. |
| Occurrence provenance | Same occurrence authority; `trigger-service.ts:324,406–416` | Webhook event IDs and schedule occurrence keys already exist. Missed schedule times may be grouped into one occurrence. One accepted occurrence should mean one Branch execution, not automatically one execution per missed timestamp. |
| Stable Agent identity | `packages/core/src/dto/agents.ts:74–105`; `store-agent-catalog-authority.ts` | UUID identity is separate from title, model, manager, history, and provider session. |
| Config/instructions | `dto/agents.ts:271–283`; `routes/agent-maintenance.ts:119–226`; `store-workspace-catalog-authority.ts:711–749,923–965` | Title/model/engine/effort updates exist; Chat instructions are mutable. Agent preset guidance is an immutable-at-spawn snapshot. A general versioned mutable Agent-instruction contract does not already exist in this PATCH API. |
| Portable organizations | `dto/agents.ts:111–163`; `routes/agent-packages.ts:303–478,735–839,1154` | `ponderosa.agent-package.v1` supports template/full modes, logical refs and manager refs. Template mode forbids history/artifacts; import allocates destination Agent IDs. It is import/copy, not stable-ID deployment reconciliation. |
| Managed child creation | `routes/agent-creation.ts:396–420,498–517`; creation-operation and management authorities | Existing tracked creation receipts/quarantine and opening Request/optional Join must be reused. Do not bypass them with direct inserts. Extract a callable Engine operation where orchestration currently lives in routes. |
| Steering | `coordination-v3-steering-authority.ts:50–168,257–351,418–562` | Steering has durable injection identities, Run fences, acknowledgement and outcome-unknown recovery. Branches must not disable or replace it. |
| Requests and Joins | `coordination-v3-coordinate-authority.ts:120–265,323–326`; request and question authorities | Requests support absent requester Agent and create normal Activations. Existing Joins explicitly require an Agent requester. Terminal Request updates are the handoff; ordinary Run output is not. |
| Leases/recovery | `coordination-v3-scheduler-lease-authority.ts:134–245,470–545` | One leased/running Run per Agent. Pre-injection expiry can retry; post-injection expiry becomes outcome unknown. This distinction must survive workflow retry policy. |
| Experimental ownership | `docs/chat-owned-model.md`; `store-workspace-catalog-authority.ts:711–749`; runtime-scope authority | Chat snapshots and validation exist while Project-shaped compatibility remains. Cross-chat sharing is explicitly outside the current migration scope. |
| UI vs Engine gaps | Trigger DTO; package routes; Decision/question authority; scheduler source | “Automation” is a product label over Trigger records. Workflow definitions, invocation results, gates, script leases and reconciliation do not exist as complete Engine contracts. UI labels alone cannot supply them. |
| Correlation sufficiency | Request IDs, request updates, activation sources, scheduler Run-Activation relationships | Sufficient for an Agent-step boundary once bound to a StepExecution. Insufficient for an entire graph, immutable deployed version, script receipt, or workflow gate. No need to tag every internal communication with execution ID. |

Source entry points: [Chat migration](https://github.com/khaleelclark/Ponderosa/blob/f3e44b8f94d2fa106c4e4c0c51119e2fb18301f5/docs/chat-owned-model.md), [Chat context](https://github.com/khaleelclark/Ponderosa/blob/f3e44b8f94d2fa106c4e4c0c51119e2fb18301f5/packages/agents/src/store-workspace-catalog-authority.ts#L741), [occurrence authority](https://github.com/khaleelclark/Ponderosa/blob/f3e44b8f94d2fa106c4e4c0c51119e2fb18301f5/packages/agents/src/coordination-v3-trigger-occurrence-authority.ts#L63), [coordination authority](https://github.com/khaleelclark/Ponderosa/blob/f3e44b8f94d2fa106c4e4c0c51119e2fb18301f5/packages/agents/src/coordination-v3-coordinate-authority.ts#L211), [scheduler leases](https://github.com/khaleelclark/Ponderosa/blob/f3e44b8f94d2fa106c4e4c0c51119e2fb18301f5/packages/agents/src/coordination-v3-scheduler-lease-authority.ts#L134), [portable types](https://github.com/khaleelclark/Ponderosa/blob/f3e44b8f94d2fa106c4e4c0c51119e2fb18301f5/packages/core/src/dto/agents.ts#L124).

## B. Proposed domain model

### Naming

**Step** is the best term: clear to users and developers, natural in “retry step” and `StepExecution`, and valid for nodes with successors. Leaf falsely implies a terminal graph node. Needle fits branding but requires explanation and provides no useful semantic distinction. Reserve Branch for the product's workflow definition; call conditional graph elements “conditions” and “paths.”

| Record/concept | Responsibility |
| --- | --- |
| Branch | Stable installation-local ID, owning Chat, name, enabled/archived state, active version pointer. |
| BranchVersion | Immutable validated graph, one trigger declaration, policies, templates, script digests, config references, format version, content hash. |
| Deployment binding revision | Immutable resolution of package refs to local Agents, Chat, provider configuration and approved filesystem locations. Contains references to environment values, not exported credentials. |
| BranchExecution | One accepted occurrence, exact BranchVersion and binding revision, provenance/input reference, admission time, status, terminal outcome. |
| StepExecution | One logical invocation of a versioned step in one execution/path. Separate attempts preserve retry evidence. |
| Step attempt | Attempt identity, input/hash, pinned execution configuration, Request ID or script operation ID, timestamps, fence and outcome evidence. |
| Gate | Durable proposed text/options, resolution identity, operator response and expected state revision. |
| Checkpoint | A committed workflow transition and its outgoing durable work; not a copy of provider context. |

Minimal completed step result remains `{ failed: boolean, output?: string }`. Waiting/running/cancelled states, timing, attempts, error classifications and correlation IDs belong to runtime records rather than an arbitrary result envelope. A gate's selected option and edited text are gate records; its resulting text is normal step output. A merge is an explicit execution command, not a magic string parsed from Agent output.

### Step kinds

- **Persistent Agent:** reference a live Agent by stable ID; invoke one correlated Request with explicit trusted instructions and bounded input.
- **Persistent organization:** same boundary, targeting the organization root/entry Agent. Internal delegation, Joins, steering and child Agents remain ordinary Engine behavior.
- **Ephemeral Agent:** use a template through tracked creation with an opening Request. Retain audit evidence; archive after settlement and observed cleanup, not immediate hard deletion.
- **Ephemeral organization:** instantiate a template hierarchy once per logical invocation via recoverable creation operations. Retries reuse the recorded creation result unless an explicit fresh-attempt policy requests new identities.
- **Script:** invoke immutable packaged script bytes with explicit interpreter, argv, working-directory binding and input on stdin. Keep stderr/execution evidence separate from optional output text. No shell interpolation of trigger text.
- **Human gate:** persist waiting state, consume no provider slot, and release successors only after canonical resolution.
- **Action:** eventually an Engine-owned executor with a small named configuration and operation receipt. Initially scripts cover ordinary deterministic work; no action catalog is required.

### Graph and data flow

Use a validated directed graph with stable node/edge IDs. Executable steps are distinct from condition, fork and join control nodes. Conditions use a small allowlisted predicate contract over explicit inputs/results or gate choices, not arbitrary code in a string. Complex transformations/classification belong in Script or Agent steps.

Default linear data flow passes the predecessor's optional text. Forks copy an immutable input reference. A mixed join has an explicit ordered list of incoming paths and a deterministic text-composition policy; completion order must not accidentally determine input order. No arbitrary metadata bus is required.

A fork creates durable path identities. A join refers to one exact fork instance, not every execution of a similarly named node. Support all/any/quorum policies, record the selected arrivals once, and define whether losing paths finish or are cancelled. Closed conditional paths are marked unselected; an all-join waits for selected paths only. If failure makes quorum impossible, apply the declared failure policy. An execution is terminal only when required paths reach a terminal point and any required cancellation/cleanup is settled. For an intentional detached background activity, require an explicit future capability rather than silently leaking work.

Initial validation rejects graph cycles. The conceptual upgrade for loops is an explicit bounded iteration node with an iteration identity and limits, rather than weakening deduplication or permitting uncontrolled graph cycles. Initial implementation can accept linear graphs while rejecting unsupported node kinds precisely; its records must already identify logical invocations independently of attempts.

### Existing Join boundary

Use ordinary aggregate Request Joins for Agent-owned fan-out inside an organization. Do not create a fake coordinator Agent just to host a Branch graph. The existing Join requires an Agent requester and only represents Requests; it cannot directly join scripts and gates. Mixed workflow joins therefore need a small durable path-arrival barrier in the same Engine SQLite domain. This is graph progress, not a replacement Agent coordination system. Reuse all/any/quorum semantics and tests where separable; do not force synthetic Requests for script processes.

## C. State ownership and scheduling

| Owner | Canonical responsibility |
| --- | --- |
| Engine SQLite | Branch/version deployment records, execution/step progress, attempt links, gates, path arrivals, scheduling eligibility, operation leases/fences, idempotency and transition outbox. Existing coordination remains in its existing tables. |
| Canonical authored journal and audit | Authored Communication stays where it is today; workflow transitions and operation evidence are emitted through existing audit mechanisms. Journal replay cannot reconstruct authoritative workflow runtime. |
| Definition package | Desired topology, trusted instructions, templates, scripts, configuration requirements and execution policies. |
| Persistent Agent | Stable identity, canonical communication/history, organization position, configuration and bounded context continuity. |
| Runtime execution | Immutable accepted inputs, version/bindings, attempt outcomes, operator decisions and progress. |
| Dev UI | Interactive work, Agent/organization inspection, steering and existing Automations. |
| Branches UI | Definition editing/deployment, executions, attention, gates, operational intervention and history projections. |

Extend the **existing scheduler service**, rather than starting a Branch worker scheduler. Its bounded work cycle will reconcile eligible workflow transitions and claim supervised script/action operations in addition to the existing Agent scheduling path. Agent work still enters through a durable Request → Activation → existing scheduler Run. Only that scheduler creates/claims provider Runs; a Script operation is not a redefined Ponderosa Run.

A non-provider operation needs a lease/fence and process receipt. Store that authority with the step attempt (or a shared operation table if extraction actually warrants it), using the existing transaction and lifecycle conventions. Do not reuse an Agent lease under a made-up Agent identity. Use shared process containment/observed-exit machinery after extracting provider-neutral pieces as needed; no second provider adapter is involved.

Trigger acceptance atomically commits occurrence identity, selected active version/binding revision, BranchExecution and initial transition eligibility. Existing Agent-targeted Automations keep their behavior. Add a mutually exclusive trigger destination: existing Agent destination or Branch destination. Never deliver both. Manual invocation becomes a first-class occurrence source for Branches; today's trigger source union contains only schedule/webhook/filesystem even though manual run commands exist.

No synthetic Activation is needed for a script-only Branch. Activations remain reasons to run Agents; a durable workflow occurrence is a scheduler-consumed cause for non-provider work. This is an explicit extension of the current Agent-only trigger path, not permission for triggers to create Runs.

Every transition uses a state-version compare-and-swap plus an idempotent durable outgoing operation. When Request creation and step binding share SQLite, commit them together. Where managed creation or files cross storage boundaries, use existing recoverable receipts/outbox conventions. A restart scan of unfinished canonical bindings backs up notifications; SSE delivery is never progression authority.

## D. Versioning, deployment and reconciliation

Validate and store an immutable version before activation. Atomically advance the active pointer only after required bindings/config are valid. A transaction accepting a trigger sees either the old or new version, never a mixture. Queued executions remain pinned. Definitions and script bytes referenced by live/retained executions cannot be garbage-collected.

There is an important distinction between **workflow version pinning** and **persistent Agent configuration**. Preserving Agent A's identity while changing its global instructions in v8 could change work still executing v7. The design must not promise isolation it does not provide.

Recommended rule: Branch-owned invocation instructions/model overrides and immutable script bytes are pinned to the accepted version. Existing live Agent context remains shared and can evolve through normal steering. Deployments that mutate global Agent guidance or other incompatible settings wait until affected invocations drain, or require an explicit operator choice to affect future turns of in-flight work. Active Runs retain their existing snapshots. Full reproducibility requires ephemeral resources or separately bound Agents, not a misleading version badge.

Create a deployment preview with unchanged/update/create/detach/reset operations and expected current revisions. Bind package logical refs to local IDs once. Updates preserve those bindings. Re-import as a new installation creates new IDs; update an existing installation reuses its mapping. A literal ID from another Engine is never assumed to identify the same live Agent.

Referenced existing Agents are borrowed by default: the Branch cannot silently overwrite their settings or delete them. Definition-managed Agents have one declared configuration owner, avoiding conflicting reconcilers across Branches. Removing a reference detaches it and preserves history. Archive/reset/delete are separate explicit operations subject to dependency checks and lifecycle draining. Branch deletion disables intake and requires an explicit policy for active work/history; it does not delete borrowed Agents, user directories, or Chat history.

Mutable Agent guidance needs a new narrow audited Engine contract; do not rewrite immutable preset provenance. Deployment operations spanning Agent metadata and SQLite require a resumable deployment receipt, not a false claim that an ordinary database transaction covers filesystem writes.

## E. Concurrency

Separate four limits: admitted Branch executions, active step operations, outstanding Requests to a persistent target, and active provider Runs. Persist admission and release atomically; process restarts must not reset counters or lose queued work. Waiting gates release compute capacity; an optional outstanding-execution cap controls accumulated waits separately. Queue capacity and rejected intake must be visible—never silently drop an accepted occurrence.

Branch executions may overlap freely within policy. Multiple executions can submit Requests to one persistent organization; the organization can delegate and manage task ownership. The current scheduler still permits only one simultaneous leased/running provider Run per Agent. It supports many concurrent Agents and many outstanding obligations; this is not equivalent to multiple concurrent sessions for one identity.

Do not expose a setting promising same-Agent parallel provider Runs until the Engine's context, session and fence model supports it. Parallel worker pools and ephemeral workers satisfy high concurrency today. Increasing true per-Agent Run concurrency is a separate Engine change, not a Branches shortcut.

Introduce optional organization outstanding-work limits and host-wide provider/process budgets. Spawn/recursion limits must be enforced through the tracked creation authority, with durable reservations before creation. A future per-execution child cap needs a propagated resource-budget token on spawn causality. That token accounts for resources without claiming perfect ownership of every internal conversation. If work merges, reservation transfer/release must be atomic.

Shared working directories require deliberate coordination. Offer existing separate Git copies where appropriate. A shared pathname cannot guarantee race-free scripts; definitions that share data must use an explicit locking/atomic-write convention or an Engine state operation.

## F. Failure, recovery and intervention

Execution display states: queued, running, waiting, completed, failed, canceled, skipped, merged. Waiting reasons distinguish gate, retry time, provider recovery and operator attention. `merged` records the surviving execution ID. Reject self-merges, cycles, and invalid targets transactionally. A merge does not rewrite the survivor's pinned version or automatically inject the loser's private context.

Failure category is evidence on an attempt: Agent-reported failure, provider failure, script failure, invalid input/config, or action failure. Waiting for a human is not a failure. Configurable policies are stop, bounded retry/backoff, ask human, or invoke a recovery Agent through an ordinary Request. Recovery itself has finite attempts; it cannot recursively create unlimited recovery work.

A canonical terminal Request update settles an Agent step. The step reducer maps existing Request states deliberately: completion succeeds, explicit failure fails, unresolved questions/dependencies wait, and outcome unknown requires reconciliation. A provider Run ending or a Work log sentence saying “done” never advances the graph.

| Checkpoint/crash boundary | Recovery rule |
| --- | --- |
| Occurrence accepted | Reuse execution/version via unique occurrence identity. |
| Invocation prepared | Reuse attempt and Request/creation receipt; no duplicate Agent or Request. |
| Agent provider submission ambiguous | Respect existing outcome-unknown semantics; do not blindly reinvoke under a workflow retry policy. |
| Request terminal before workflow reducer runs | Reconcile the bound canonical terminal update and commit progress exactly once. |
| Script leased before launch | Recover only after checking the durable launch/process receipt and authority fence. |
| Script side effect occurs before result commit | Outcome is unknown. Require idempotent effect key/reconciliation or human resolution; arbitrary external side effects are not exactly-once. |
| Step completes before successor dispatch | Outbox/eligibility transition resumes successor without rerunning predecessor. |
| Gate entered/resolved | Recover durable gate; duplicate resolution returns the same result, conflicting resolution fails. |
| Retry due | Claim the next attempt once, preserving earlier failure evidence. |
| Cancellation requested | Fence exact authority, stop eligible successors, drain owned processes, retain retryable cleanup if exit is unobserved. |

Script output must follow existing text normalization/size and artifact publication rules. A large result can be published through managed storage with a plain-text reference, rather than adding an artifact envelope to all results. Exact submitted input and hashes must be auditable for Agent prompts and script stdin/argv.

Cancellation of one execution must not indiscriminately kill a persistent Agent Run shared with unrelated Requests. Cancel the execution's bound obligation and reject its later workflow advancement. Hard interruption targets an observed Run only through existing authority, with explicit effects on other work. Already initiated external effects may require reconciliation even when the workflow is canceled. Ephemeral operation cleanup can be stronger where ownership is exclusive.

Human gates belong to workflow state and can project through shared Decision UI components. Existing Decision suspension is Agent/Run-oriented; generalize ownership only if it is smaller than a workflow gate record with shared presentation. Provider live elicitation is not a substitute: it depends on an in-memory provider call. Approval must atomically record the chosen/edited value and enable exactly the intended successor. Reject can route to a declared rejection path or terminal skipped outcome.

## G. Portable format and shared state

Use canonical UTF-8 JSON plus ordinary relative files. JSON provides deterministic validation without adding a YAML dependency; editor formatting can remain human-friendly. Hash canonical validated content and referenced file bytes. Reject unknown schema versions and unsupported required features explicitly.

Illustrative package (proposed, not implemented):

```text
summary.branch/
  branch.json
  agents/reviewer.ponderosa.json
  scripts/format-summary.mjs
  README.md
```

```json
{
  "schema": "ponderosa.branch.v1",
  "packageId": "8f4e6341-0381-4ac0-bdb9-f35e04a552bc",
  "version": "1.0.0",
  "name": "Reviewed summary",
  "requires": { "engineFeatures": ["branch.agent-request", "branch.script"] },
  "bindings": {
    "reviewer": { "kind": "persistentAgent" },
    "workspace": { "kind": "directory" }
  },
  "trigger": { "kind": "manual" },
  "entry": "summarize",
  "steps": [
    { "id": "summarize", "kind": "agent", "agentRef": "reviewer", "instructions": "Summarize the supplied input." },
    { "id": "format", "kind": "script", "file": "scripts/format-summary.mjs", "runtime": "node", "cwdRef": "workspace" }
  ],
  "edges": [{ "id": "summary-to-format", "from": "summarize", "to": "format", "on": "success" }],
  "policy": { "maxConcurrentExecutions": 4, "failure": { "action": "stop" } }
}
```

The local deployment maps `reviewer` to a stable Agent ID and `workspace` to a validated path in the owning Chat's environment. Package/step logical IDs survive sharing; installation IDs and persistent Agent IDs survive updates within that installation through the binding ledger. A schema revision is different from a package release version and a local immutable deployment revision.

Include desired templates, trusted scripts, trigger instructions/configuration without credentials, configuration/input schema, capability requirements and compatibility declarations. Reuse `ponderosa.agent-package.v1` **template mode** for organization definitions. Omit histories, live execution state, provider/browser sessions, local absolute paths, private artifacts, environment values and secrets. Current full Agent export is intentionally unsuitable as the default Branch package.

Credentials are supplied through existing host/service configuration references. Do not create a password store. Package installation validates paths, rejects traversal/escaping links, verifies file digests and shows scripts/capability requirements before enabling execution. Importing a package does not execute it automatically.

Existing files and managed artifacts cover shared documents and immutable outputs, but neither is a transactional mutable state store. Initially use explicit named directory bindings with documented atomic file updates for workflows such as daily accumulation. If an actual workflow needs concurrent counters or compare-and-swap values, add a small named/versioned state cell to Engine SQLite with explicit access bindings. Do not hide mutable workflow truth in Agent memory, overload artifact metadata, or build a generic state framework preemptively. Separate Branches sharing a state binding must remain within permitted Chat scope until explicit cross-chat sharing exists.

## H. UI architecture

Provide a distinct Branches shell, initially inside the existing React application with its own routes/navigation. Share authentication, REST/SSE clients, design components, artifact previews and Engine endpoints. A later separate bundle is a packaging choice, not a reason to fork backend authority.

The landing page answers: what is running, what failed, and what needs my response? Navigation covers Branches, Executions and Needs attention. A Branch page shows active version, trigger, configuration, recent outcomes and a readable step graph. Execution detail shows selected paths, step inputs/results, attempts, waits and durable outcomes with bounded pagination. Present effective concurrency and queueing clearly.

Gate review shows the exact proposed text, edit/approve/reject controls and conflict feedback if already resolved. Deployment preview shows retained/created/detached Agent identities and settings effects. Deep links open existing Dev Agent/Team/Run inspection for interactive debugging and steering. Do not stream ordinary tools, logs or internal collaboration into a new chat feed.

Dev Automations remain available and unchanged by default. New Branch destinations can appear in shared Engine trigger tooling once compatible. Do not auto-convert existing Automations before an explicit migration path is qualified.

## I. Security and capability gaps

The inspected Codex adapter supports configured sandbox modes and sets approval policy to never; its constructor default is workspace-write. Claude defaults to bypassPermissions. These are source-level adapter facts, not a claim about the installed CLI versions or the deployed host configuration. The task did not run provider probes, and this report does not certify a portable permission matrix.

Consequently, do not promise that a Branch capability checkbox restricts all provider tools, browser access, shell access or skills. Before offering enforced scopes, qualify the actual subscription CLI versions through the adapters and expose capability evidence through shared Engine contracts. Unsupported enforcement must be reported honestly; no API-key integration is proposed.

An Engine gate can enforce the order of an Engine-owned send-email Action. It cannot physically prevent an earlier full-authority Agent or Script from sending email through another channel. Strong action restriction requires real sandbox/tool/credential separation; a prompt saying “ask first” is not enforcement.

Trigger bodies and filesystem events remain untrusted data, separate from versioned operator instructions. Preserve media type, provenance and input hash; do not automatically read watched file contents. Validate Chat membership, artifacts and runtime authority at invocation time as well as deployment time. Archived/deleted targets fail closed without silently substituting another Agent.

## J. Implementation roadmap and approval decisions

### Phase 0 — approve the model and establish ownership

Approve the Chat-owned baseline, Step naming, Request completion boundary, scheduler extension for non-provider work, and persistent-resource update rules. Assign this task a dedicated branch/worktree based on the experimental commit (or a newly reviewed successor). Confirm one writer and leave current checkout evidence intact. Repository instructions require an independent reviewer for a PR; use the project's tracked mechanism rather than spawning untracked managed Agents.

### Phase 1 — proposed first implementation milestone

Implement manual Branch intake, immutable versions/bindings, execution and step/attempt records, idempotent Agent Request binding, one supervised Script executor, durable transition eligibility and bounded REST/SSE inspection. Use two steps: persistent Agent/organization entry → Script. Allow multiple executions while preserving the current one-active-Run-per-Agent rule. Expose a minimal Branches execution view; do not spend the milestone building a visual editor.

Changes belong in shared DTOs/validation under `packages/core`, existing SQLite authorities/migrations under `packages/agents`, and existing scheduler/lifecycle/routes under `apps/server`. `packages/engines` remains the provider boundary, with only justified provider-neutral process-helper extraction. UI lives under the existing web application. No new orchestration dependency or scheduler service.

Acceptance checks must prove: duplicate trigger retry yields one execution; conflicting duplicate payload is rejected; queued v1 survives deployment of v2; terminal Request—not Run text—advances the step; restart between terminal Request and transition commits does not duplicate work; script exit/result checkpoint advances once; ambiguous external effect stays unresolved; cancel fences stale completion; cleanup failure blocks unsafe replacement; unrelated shared-Agent work is preserved; text output reaches Script stdin exactly; Dev Automation behavior remains unchanged.

Use disposable state and controlled process fixtures for crash points, then proportionate live qualification with subscription-backed tooling. Build in dependency order (engines → agents → server → web, with shared core prepared first). Validate current upstream divergence before PR; exact feature base and merge target need to be explicit because experimental work is not interchangeable with master.

### Phase 2 — complete workflow control and intervention

Add durable gates, condition/fork/join nodes, bounded retry/recovery Agent policy, cancel/retry/gate commands, and schedule/webhook/filesystem Branch destinations. Prove fork-instance joins, unselected paths, quorum impossibility, losing-path cancellation, resolution conflicts, post-injection failure recovery and version pinning at trigger intake.

### Phase 3 — portability and lifecycle

Add template-based ephemeral Agents/organizations through tracked creation, deployment previews/binding ledger, immutable script package storage, import/export, dependency-aware archive/delete and safe garbage collection. Add the narrow mutable guidance contract only with a concrete reconciliation use case. Qualify Chat migration independently; never bundle a live ownership migration into a Branches feature launch.

### Later, with demonstrated need

Engine-owned external Actions, provider-enforced capability scopes, worker-pool selection, shared state cells, bounded iteration, finer resource budgets and package distribution. None requires redesigning step identity, version pinning or Request completion.

### Decisions needing approval, with proposed defaults

1. **Ownership:** Branches and their persistent targets share one Chat; cross-chat organization invocation is deferred until explicit access semantics exist. This is a real limitation of the selected baseline, not an unnoticed Project dependency.
2. **Persistent updates:** pin invocation configuration; defer incompatible global Agent changes until affected work drains. Borrowed Agent settings are never silently reconciled.
3. **Mixed work:** extend the current scheduler with supervised non-provider operation claims and use workflow path-arrival barriers where Agent Joins cannot represent the work.
4. **First slice:** manual → existing Agent Request → Script, including crash recovery and versions, before a broad editor or action catalog.

### Handoff

Objective: complete Branches architecture research and prepare an approved implementation slice.
Research source/head: `experiment/chat-first`, `f3e44b8f94d2fa106c4e4c0c51119e2fb18301f5`.
Current checkout: `/Users/patmi/Desktop/Ponderosa`, branch `master`, base/head `32dc7bf0f2bc4c6c3f1b7dbf833961bd6d56ac42`.
Writer: no repository writer/worktree ownership assigned; this task performed read-only source research.
Dirty state: the two pre-existing untracked audit entries remain; no repository file changes made.
Commits/pushes: none. Verification: remote-tip queries, source/contract inspection and preservation check; no runtime tests claimed.
Blockers: requested full-model approval and confirmed dedicated writer/base/worktree before implementation.
Next authorized action: review this proposal; following approval and ownership assignment, implement Phase 1 on an isolated branch, obtain independent review, and open a PR. No merge or deployment is authorized.

### Execution admission accounting

`branch_execution_budgets` is local SQLite policy and counter authority, independent of frozen workflow configuration and portable packages. `branch_execution_budget_commands` stores hash-bound policy/grant receipts; `branch_execution_budget_events` is a durable outbox for the existing append-only workspace audit. Budget commands require the current policy revision and period identity. A replay returns its original receipt, including after rollover; new stale grants conflict. Budget mutations and expiry increment policy revision; ordinary debits do not change the policy revision.

The scheduler's existing Branch reducer acquires a SQLite immediate write transaction before rereading queued work. The conditional debit, execution admission receipt, queued→running transition, initial path, and workflow-start checkpoint commit together. Manual and unlimited starts also receive receipts. Denial leaves the execution queued with a typed admission-budget wait and no entry path. Scans remain bounded and rotate past held work. No additional scheduler or provider Run authority is introduced. Period expiry is checked lazily under the same write authority, including reads, so Call-only workflows recover without a trigger timer.

Migration 0031 defaults policy to unlimited and grandfathers historical started executions. It classifies historical intake using canonical parent-attempt and trigger-occurrence bindings; it never trusts occurrence prefixes, provenance, or input text. New intake stamps a trusted source from the direct-manual, trigger, or exact-Call path. The operator trigger-run route supplies its Branch-only exemption as a server field, independently of untrusted payload/provenance. Existing Dev Automation hashes and charging remain unchanged. Drain-first Branch deletion waits for budget audit publication and removes the local counters, commands and outbox alongside execution receipts.
