# Implementation inventory — implementation-first successor

Baseline: `f64f631b490dbfc8125f0f7a2f8c649b6c54d19f`. Integration writer owns
`phase2-implementation-integration` in its separate worktree. The baseline,
other owners' worktrees, frozen execution roots and Bible are unchanged.
Patrick's current direction defers all test execution, builds, type checks,
benchmarks, browser checks and runner preparation until implementation is complete.
This inventory is source navigation and an implementation backlog, not a True
verdict, a claim that every path has been audited, or a passing-test report.

Owners: **Runtime** = Phase 2 Runtime and access fixes; **Reliability** = Phase 2
Reliability and portability fixes; **Features** = Phase 2 Branches and feature
builds; **UI** = Phase 2 UI and accessibility fixes; **Integration** = Phase 2
Integration and release verification. Cliff resolves scope and assigns omissions.
Owner handoffs must distinguish an absent behavior from deferred qualification.

## All 32 commandments

| # | Source implementation anchors | Owner / remaining implementation decision |
| --- | --- | --- |
| 1 | `packages/agents/src/coordination-v3-context-recovery-authority.ts`, `packages/engines/src/seed-history.ts`, `docs/context-recovery.md` | Runtime: preserve persistent history across assignments; report any actual truncation path separately from unexecuted history trials. |
| 2 | `AGENTS.md`, `docs/PERMISSION_HISTORY_AND_PROTOCOL.md`, `docs/CONTEXT_ROLLOVER_STEERING.md` | Runtime + Integration: document every changed authority/context mechanism; no second authority store. |
| 3 | `apps/web/src/components`, shared chat and output shell | UI: complete usable desktop/mobile flows; comparative judging deferred, not missing backend code. |
| 4 | `packages/core/src/adapter.ts`, `packages/engines/src`, server browser tools | Runtime: name any missing native-harness capability and replacement; parity cannot be inferred from an adapter interface. |
| 5 | `apps/server/src/local-memory-config.ts`, `deploy/README.md`, configurable adapters | Runtime: classify required infrastructure versus optional integrations; no new outside dependency in this slice. |
| 6 | `apps/server/src/runtime-authority.ts`, `local-memory-authority.ts`, capability-policy history | Runtime: human-origin access mutations and live rechecks; UI exposes human settings. |
| 7 | `apps/server/src/operator-auth-proxy.ts`, server origin boundary | Runtime: finish removal of dedicated authentication while retaining browser-origin checks; file name alone does not establish a live token gate. |
| 8 | `portable-agent-package-validation.ts`, `portable-execution-archive.ts`, `portable-memory-snapshot.ts`, `portable-output-roles.ts`, `docs/combined-migration-contract.md` | Reliability increment integrated: portable role/speed/preset snapshot and remapped guidance refs, validated import selections, shared export warning. Concrete remaining transport gaps listed below; full recreation remains incomplete. Known secret fields stay excluded. |
| 9 | Shared core DTOs, Adapter interface, shared composer/dialogs | All owners: remove abandoned paths and avoid duplicated authority; broad dead-code analysis deferred. |
| 10 | `apps/server/src/routes/branches.ts`, **new `examples/branches-client/client.ts`** | Integration: standalone outside-app start/status/result client, public HTTP only; not executed. No private fixture dependencies. |
| 11 | Communication catalogs/prompts and canonical tool routing; `docs/PERMISSION_HISTORY_AND_PROTOCOL.md` | Runtime: concise asks/results and artifact references; message-log judging deferred. |
| 12 | SQLite coordination/outbox, event journal, `runtime-event-authority.ts`, imported history retrieval | Reliability: preserve recoverable writes and disclose truncation; crash evidence deferred. |
| 13 | `coordination-v3-steering-authority.ts`, scheduler fences, pause/resume UI | Runtime + UI: retain unfinished work, human priority/newest-sender order, noninterrupting FYI handling; state-specific behavior requires owner handoff. |
| 14 | `packages/engines/src/auth.ts`, provider diagnostics, operational notifications | Runtime + UI: exact failures visible, bounded backoff disclosed, no silent abandonment. |
| 15 | `agent-deletion-authority.ts`, `conversation-deletion-authority.ts`, managed workspaces | Reliability increment integrated: marker-only unlink plus nonrecursive tombstone rmdir preserves unexpected/racing user content; broader removal invariance remains unverified. |
| 16 | `branch-trigger-service.ts`, `packages/agents/src/branch-trigger-store.ts` | Reliability + Features: schedules/conditions/reasons, clock changes, occurrence identity; timing trials deferred. |
| 17 | Scheduler/request recovery authorities, source regression tests | Reliability increment integrated: exact ordered 0027–0033 predecessor schema reconstruction; current runtime initialization and leased transaction preserved. Actual upgrade and 20-run evidence deferred. |
| 18 | `notification-routing.ts`, notification journal, Inbox projection, `docs/notification-defaults.md` | UI + Features: quiet default unread state, human-selected mentions/alerts; Assistant uses same notification path. |
| 19 | Activity/Run/Work log projections, provider diagnostics, `portable-secrets.ts` | Runtime + UI: trace real causes and redact known secrets without obscuring failures; no new competing log. |
| 20 | Server origin boundary, operator-auth paths | Runtime: remove live operator/network token gates; preserve origin checks and human-owned grants. |
| 21 | Virtualized chat/stream projections and UI layout | UI: identify actual rendering/retention problems; numerical INP/LCP qualification deferred. No invented performance figures. |
| 22 | README, `docs/user-guide.md`, launcher/provider setup | Integration + Runtime/UI: correct stale setup guidance; install timing and platform trials deferred. |
| 23 | User guide and behavior-specific docs beside owner changes | All owners + Integration: update source-facing docs while preserving public-beta/version distinctions. |
| 24 | Exact token usage and `budgetPresentation.ts`, `BranchExecutionBudget.tsx` | UI + Features: exact source-backed counts, no subscription cost estimates or fabricated percent completion. |
| 25 | `adapter.ts` billingMode, `packages/engines/src/auth.ts`, engines routes/settings | Features + Runtime/UI: source already has native-harness billing selection; finish real caller/settings gaps, not a direct HTTP provider client or credential store. Both-mode real usage evidence deferred. |
| 26 | Shared composer, rename/settings dialogs, output shell | UI: common actions share behavior; comparative consistency judging deferred. |
| 27 | Shared semantic controls, personalization settings, keyboard handlers | UI: complete keyboard/screen reader/font/theme behavior; automated scans deferred. |
| 28 | All Branches rows and shared components/services above | All owners: whole-Bible requirement applies to Branches, not just its graph engine. No aggregate True verdict from partial features. |
| 29 | Core, Branches, OutputAgentApp, AssistantEntry, folder navigation | UI: retain folders; remove explanatory UI blocks, overlaps/flicker causes. Blind panels/recordings deferred. |
| 30 | `local-memory-catalog.ts`, `local-memory.ts`, dynamic-tool handler | Features + Runtime: combined chat/global search and global-write human settings; named external model/runtime prerequisites do not prove memory correctness. |
| 31 | `routes/streams.ts`, Agent/Workspace hooks, `BranchLiveOutput.tsx`, `voice-reply-stream.ts` | UI + Runtime/Features: enumerate all output surfaces, use shared stream events and incremental call audio; inspect actual missing callers. Latency thresholds/recordings deferred. |
| 32 | `packages/core/src/branches.ts`, `branch-store.ts`, routes/engine/checkpoint authorities | Features: named capability checklist below; framework examples and any incomplete restoration are implementation work where absent, not automatically a verification gap. |

## Every Build-list subrequirement

| Feature | Existing source anchor | Required coverage / owner |
| --- | --- | --- |
| Output designation, one or more Agents, stable independent URLs | `output-agent-apps.ts`, `OutputAgentDesignation.tsx`, `/apps/<agent-id>` | Features: persistent designation and URL lifecycle; UI: standalone navigation. |
| Output direct user conversation with workflow behind it | `OutputAgentApp.tsx`, shared Agent chat/runtime | Features + UI: canonical direct routing, no duplicate history. |
| Output attachments | Shared chat/working-file authority | UI + Runtime: same upload/read/result flows as core. |
| Output voice messages | Shared voice input/reply components | UI + Runtime: recording/playback and readable failure/recovery. |
| Output phone calls | Shared voice reply stream/call surfaces | UI + Runtime: real call flow, incremental speech; do not substitute a supported flag. |
| Output iOS Messages/phone polish | Shared output shell | UI: finish layout/interaction code; blind panel deferred. |
| Output simple automatic on/off and frequency | Output settings and real Branch trigger routes | Features + UI: settings update workflow, preserve event-trigger semantics and errors. |
| Output model switch | Native Agent settings route and output settings | Features + UI: real bound Agent model change, identity/history unchanged. |
| Output More options | Output app workflow link | UI: owning workflow destination, usable without technical setup. |
| Output #29 and #31 | Shared stream/layout paths | UI + Runtime: same surface completeness as core, not independent acceptance waiver. |
| Assistant auto-created workflow/default preferred model | `output-agent-apps.ts`, `AssistantEntry.tsx` | Features: idempotent fresh setup, saved provider/model defaults. |
| Assistant create Chat/start cross-project work | Workspace tools and `docs/assistant-workspace.md` | Features + Runtime: destination/source human access, durable action receipts, real scheduler work. |
| Assistant proactive default 10min/configurable interval | Assistant workflow trigger and digest cursor | Features: completion/issue sources, no successful-Run-as-task-completion inference. |
| Assistant reports follow settings/no flood | Notification journal and assistant digest | Features + UI: quiet default, deduplication/cadence, canonical reports. |
| Assistant same output UI attachments/voice/calls in app | `/assistant`, shared OutputAgentApp | UI + Runtime: all same capabilities, no special stripped shell. |
| Exactly one app-wide Ponderosa speaker; move designation | Output-role preferences and dedicated role routes | Features: singleton across workflows, human-controlled relocation. |
| Edit workflow/model/prompt without breaking role | Branch editor and Agent runtime settings | Features + UI: keep designation through ordinary edits. |
| Delete/remove role disables; settings shows disabled | Role/deletion lifecycle and Assistant settings | Features + UI: disabled means no speaker, no silent recreation. |
| Explicit re-enable fresh defaults only if absent | Resumable Assistant setup | Features: no duplicate creation if speaker exists; preserve old workflow/user data. |
| Import speaker collision dialog disables imported speaker | `portable-output-roles.ts`, import UI | Features + Reliability/UI: collision warning/consent path and inactive imported role. |
| Preferred model unavailable: ordinary settings switch | Output model controls | Features + UI: no special recovery-only replacement or identity reset. |
| Inbox everywhere: UI/docs/code | Inbox component/routes/DTOs and shared composer | Integration: stale All Messages composer comment removed; historical stable storage IDs/`/messages` are intentional compatibility identities, not user-facing product labels. |

## Concrete backlog and integration status

1. Integration added the previously absent standalone public HTTP example and
   corrected source billing/setup documentation plus remaining Inbox comment.
2. Reliability commit `b003ae28b8c3eeb3b0890971d552ffa68d138da6` integrated
   as `1fab1e1f4` without conflicts. UI commit `99a5b75211a61330197e95117a2444b516717330` integrated as
   `cee7295ab` without conflicts. Features and Runtime handoffs remain open;
   Reliability and Runtime are assigned additional implementation successors.
   Source changes cover portable Agent setup, safe tombstone cleanup and exact
   additive predecessor matching; regression source is present but unexecuted.
3. Concrete #8 implementation backlog (Reliability; Cliff assigns continuation):
   structured authored communication scope/metadata; general uploaded attachment
   DTO and bytes; working-copy and cross-Chat topology destination bindings;
   human-reviewed transport of nonsecret capability settings; selected external
   working-folder content. These are missing implementation, not deferred tests.
   Workflow operational/checkpoint preservation remains Features-owned. Native
   sessions, credentials and live scheduler ownership remain excluded/inert;
   selected global-memory transfer already has its separate operator flow.
   Caller follow-through: Features must use the shared export warning and replace
   the Assistant regression's hybrid predecessor fixture with an exact prefix;
   UI must use the shared warning. Reliability notified both owners.
   #12 has no additional demonstrated defect from this increment; crash recovery
   remains unverified. #16 requires the Features trigger disposition.
4. Historical Branches feature-map still describes an earlier implementation
   plan; current owner source inventory supersedes it for backlog decisions.
   Checkpoint/refused frontier restoration and all named framework capabilities
   need concrete owner dispositions, not a broad parity label.
5. Merge owner commits only into this integration worktree after their handoff;
   retain their source trees and accepted fixes. Record conflict resolutions by
   file and requirement. No production push, merge or deployment authorized.

All test results are deferred. The final whole-implementation test phase starts
only after implementation is complete under Patrick's current direction.

## #32 named capability disposition

| Named capability | Source anchor | Owner disposition still needed |
| --- | --- | --- |
| Graphs | BranchDefinition steps/controls/edges; WorkflowCanvas | Features: graph authoring and runtime routing share canonical definition. |
| State | Branch parameters, execution input/results and configuration | Features: describe state semantics and missing general state operations explicitly. |
| Checkpoints and rewind | Initial/historical checkpoint routes, branch-unit-saver, checkpoint invocations | Features + Reliability: identify unsupported resource-frontier restoration versus required capability. |
| Human-in-the-loop | human_gate, BranchGateResolution, execution actions | Features + UI: interruption/edit/resume and exact Decision state. |
| Streaming | BranchLiveOutput and shared Agent stream | UI + Features: every agent-output surface, reconnect without duplicate authored results. |
| Tools | Agent native harness tools and Script/action steps | Runtime + Features: optional tool integrations and actual harness access parity. |
| Memory | Unified local-memory catalog/search, Branch resource bindings | Runtime + Features: single chat/global search and human-only limits. |
| Subgraphs | branch_call, bound Branch refs and child execution lineage | Features: nesting, cancellation and declared limit behavior. |
| Multi-agent | persistent/ephemeral Agent and organization targets; fork/join/map | Features + Runtime: real managed identities, no shadow worker subsystem. |

Pinned LangGraph/LangChain versions and runnable representative application
coverage must remain explicit in the feature owner's handoff; this table does
not invent external-framework parity. Capabilities outside these nine stay
recorded gaps. Existing Python/native prerequisites are not new feature claims.

## UI integration increment

Shared Agent/task/Branches response rendering, ordered SSE batching, standalone
Output/Assistant chat and call controls, microphone recording/review/playback,
100–200% device text size and mobile/keyboard layout changes are integrated.
`docs/web-feature-completion.md` maps the source; regressions remain unexecuted.
Integration also connects `PackageExportDisclosure` to core's shared warning;
its deferred regression retains an explicit mocked shared-constant binding.

UI follow-up `944a6e00` integrated; corrected by `e2bf2275`: schedule sends
`expectedSettingsRevision: app.settingsRevision` (covers same-version trigger edits)
and no-app Assistant renders `setupError.message`; corresponding Branches DTOs
remain pending integration. Owner confirms existing `updateAgent` model changes
already reach subsequent workflow Runs, resolving the model API question.
`5e65ed01` is byte-identical to our already integrated shared-warning source
change, so no duplicate commit was applied.

Pending backend combination: validated audio MIME/admission, general authorized
canonical Chat publication and actual early qualified voice acknowledgment. These are implementation dependencies,
not deferred judging. Await Features/Runtime contracts before wiring missing DTO
fields. Runtime increment `5511e2bd` is held pending its assigned successor:
nonvoice publication, transactional account binding and recovery/crash handling.
Reliability's remaining #8 transport work is assigned back to that owner.

No measured performance improvement is claimed; existing mapped LCP failure
remains unresolved. All runtime, accessibility, phone and comparative judgments
remain deferred. Baseline and owners' worktrees remain untouched.

## Direct reply and selected-file UI increment

UI commit `1227d1b5` integrated: shared ChatPane presents host-authorized
`presentation:text` snapshots for the latest direct user message in DM, Assistant
and output apps. Preview checks exact message/Agent/Run/scope, memory exposure,
fence/stream identity and sequence; canonical authored reply replaces it. Both
audio consumers reject text presentation. This remains dependent on Runtime's
core field/endpoint implementation and does not cover other Communication scopes.
SSE refresh plus sequential 500 ms fallback is source behavior, not measured latency.

Selected relative working-file copy/download controls and import destination
folder/working-copy controls are integrated pending Reliability's transport
successor. Permission adoption remains blocked on its structured preview contract;
no adoption defaults were introduced. No new test execution or preparation.

Portability owner reports its continuation is not yet committed: structured
communication and working-file modules, imported-history envelope and a
`workingCopies` package-route context binding. Await exact committed handoff;
no edits copied from its active tree. Cross-Chat organization reporting bindings
remain a model decision because canonical organizations are same-Chat-only;
owner refuses unsupported multi-Chat imports before writes. No silent widening
of that invariant or completed-portability claim.

## Portability transport continuation

Committed successor `cccd84af` is now integrated without conflicts, including
the one-line existing `workingCopies` service context in application routes.
Source now transports structured historical Communication/revisions, uploaded
originals and remapped artifact bindings, source Chat/mode, explicit hash-bound
reviewed capability restrictions, and selected regular working-file bytes into
an exclusively new folder with a retained failure-location receipt. This
supersedes the earlier absent-backend backlog for those specific fields.

Remaining implementation: UI must submit explicit access review and display
structured imported provenance/attachments; Branches must forward the reviewed
choice (restrictions otherwise refuse with 409). Selected-file UI is integrated,
but complete destination Chat/root binding is still absent. Selected bytes do
not preserve Git history/modes/timestamps/symlinks or recursively recreate every
organization folder. Memory-read and saved-browser grants still need explicit
local Settings, with no general reviewed portable mapping claimed.
Cross-Chat reporting remains an ownership-model decision under the canonical
same-Chat invariant. See the updated portability status and migration contract.
Full #8 remains incomplete; all changes remain unexecuted.

## Branches public engine and human frontier increment

`c7acbd86` integrated conflict-free: public fetch/SSE client and independent
`examples/branches-engine-app`, startup Assistant provisioning/error DTO, movable
compare-and-set singleton speaker, output settings revision concurrency, trigger
diagnostics, standalone Script human-gate checkpoint audit/remap/rewind.
The integrated UI `expectedSettingsRevision`/`setupError` callers now have their
core/backend contracts. Owner confirms ordinary Agent model changes govern
subsequent workflow Runs. `docs/branches-public-engine.md` details the scope.

The original minimal `examples/branches-client` remains a separate direct HTTP
CLI; the new sample uses the public package client with gate/cancel/SSE support.
Neither imports private runtime/store APIs; neither has been executed.

Concrete #32 restoration gaps remain Features-owned: general parallel/map
continuations, Agent/Request/provider effects, ephemeral resource histories,
recovery/secret restoration, crash/external-writer atomicity and complete
native/external-folder historical recreation. Standalone human gates do not
close these gaps or establish framework parity. Features follow-up remains
pending for shared export warning, exact predecessor fixture and explicit
portability access-review forwarding. No whole-implementation completion claim.
