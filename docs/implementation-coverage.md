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

## Shared warning and predecessor fixture follow-through

`5bcbcd6b` integrated: full Branches package exports use the existing core
warning; the Assistant fixture deliberately retaining 0031+ schema objects now
requires hybrid refusal and unchanged state. Exact-prefix populated acceptance
regression source remains in Reliability's additive-upgrade test. No test run.

Manager resolves the portability model boundary by preserving same-Chat parent
and ancestry rules: independent source Chats map to new destination Chats,
without adding cross-Chat reporting authority. Reliability owns whole-folder /
new-Chat mappings and reviewed nonsecret grant continuation; UI owns the related
choices/provenance. Branches reviewed-choice forwarding still remains open.
This supersedes the earlier pending cross-Chat model-decision wording.

## Aggregate handoff snapshot

All four original owner handoffs are consumed. Reliability, UI and Features
increments and their received follow-ups are integrated without source conflicts.
Runtime `5511e2bd` is deliberately **not integrated**, following Cliff's direction
to integrate its eventual successor; its status doc was read from the committed
source. Current UI direct-preview core field/endpoint therefore remains absent
from this assembled tree. Do not treat this tree as buildable or complete.

Remaining implementation ownership:

- Runtime: authorized nonvoice publication (other Communication scopes too),
  transactional account-at-launch/refresh binding, feasible native recovery and
  crash reconciliation, audio admission and early qualified voice response.
- Reliability: whole-folder/new destination Chat mapping preserving same-Chat
  ancestry; explicit reviewed mappings for nonsecret grants.
- UI: explicit permission-review choices and structured imported history/original
  attachment presentation; combine final backend transport and preview contracts.
- Features: workflow-install reviewed-choice forwarding; general parallel/map,
  Agent/provider/Request and ephemeral-history rewind, recovery/secret bindings,
  pinned framework checklist and representative equivalence applications.
- Integration/Cliff: combine these successors and resolve concrete source conflicts
  if any; full 32/Build implementation remains open.

Existing behavior awaiting execution (not newly diagnosed missing code) includes
durability/deletion/upgrade trials, triggers and singleton lifecycle, exact dual
memory recall, native billing/device behavior, accessibility/polish/notification
judging and performance thresholds. Current mapped performance failure remains
unresolved; no measurements were taken in this source-only work.

All 32 table rows, all Build-list rows, nine named #32 capabilities and required
source/docs/examples are present in this tracked tree. Inspection used source
reads and Git metadata only. No tests, builds, types, browser/benchmark, runner
preparation, push, production merge or deployment occurred. Frozen roots, Bible,
baseline and other owner worktrees were not modified.

## Access-first workflow import successor

Reliability `94f7bafc` then `ec80fdea` and Features `7b655b21` integrated
conflict-free. Backend now exposes staged access preview, imported provenance,
whole root-folder originals, nonsecret grant suggestions and canonical audio
container admission. Shared `BranchPackageEngine` preserves structured review
and explicit choices. Workflow installation durably stages destination Chats,
waits for exact per-Agent human policy review, rechecks policy/hash/state after
await, and excludes pending review from automatic scheduler retry. Public client
provides installation status and resolveImportAccess; Stop cannot revive work.

UI must still show both policies and submit explicit keep_destination/use_source
with reviewSha256 via installation access-review. Whole-folder/newChat and grant
wrappers remain separate; Reliability continues distinct per-Agent working-root
bundles. The prior workflow forwarding backlog is now backend-implemented,
while end-to-end human UI remains missing. No policy adoption default introduced.

Runtime `8d9dfaa8` is received but held for the lane's next successor under
manager direction; no Runtime integration/completion credit is assigned here.
All implementation remains unvalidated; no tests/builds/types/browser/runner work.

## Distinct organization working-root transport

Reliability `dc73a5c3` integrated without conflicts. Opt-in full organization
export deduplicates roots with opaque workingRootRef and preserves child Separate
Git folder originals. Exact nonnested new workingRootDestinations mapping is
retained before writes and returned with destination Agent membership.
UI full/organization opt-in and per-root destination controls remain pending.
Restored folders are retained content, **not live Agent roots**: reviewed Project
creation or safe fresh managed-worktree population is still missing. Shared
Project.hostPath and Separate Git ownership invariants remain intact. This closes
source-byte omission without completing #8. Regression source remains unexecuted.

## UI access and provenance consumers

UI ancestry `1240f777` -> `31112e62` -> `b01c287c` integrated conflict-free.
Agent staged restriction review, whole-root export, on-demand structured imported
Communication/original links, generic scoped text status and workflow installation
policy choice UI are now present. New review clears prior choice; mutation
completion refreshes canonical status so late responses do not overwrite Stop.
These supersede earlier absent-review/provenance UI backlog entries.

Organization root-bundle controls, mapped post-import memory/browser Settings
actions, new-root Chat flow, shared human Chat and peer preview consumers remain
missing. Generic text preview also still awaits held Runtime successor source.
No execution, passing test, playback/latency or full portability claim.

## General before-entry rewind

Features `e7394374` integrated conflict-free. Initial canceled-before-admission
nonsecret checkpoints now admit all validated graph families anew with unchanged
pins/input and atomic lineage; no existing paths/Steps/effects/resources restored.
In-progress parallel/map/Agent/provider/resource continuation remains missing.
This source extension does not establish full checkpoint parity. Tests deferred.
Runtime recovery migration 0035 and audio follow-up are reported in progress;
await committed source and inspect schema/asset overlap when handed off.

## Organization-folder UI mapping

UI `bee78038` integrated conflict-free with existing `dc73a5c3` backend.
Full organization opt-in reaches export/copy/download; preview groups opaque
root identities and Agent memberships; explicit per-root new destinations reach
access review and import. Edits invalidate review; lexical UI refusal complements
authoritative backend filesystem checks. The former Agent root-bundle controls
gap is closed in source. Live-root population/new Project, Branches bundles,
mapped Settings actions and shared Chat/peer stream consumers remain missing.
No execution or completion claim; tests remain deferred.

## Workflow folder forwarding

Reliability `54abf5bb` and Features `f13b1c6a` integrated conflict-free. Shared
engine forwards folder options and complete import results. Workflow export
accepts owned per-Agent file selections; install preview validates target-keyed
new nonnested destinations and refuses retained-Agent folder choices. Durable
importResults preserve content locations and grant suggestions through recovery
and terminal compaction under existing retention policy.

Backend Branches folder-forwarding gap is now implemented; UI selection/destination
controls and separate human Settings actions remain missing. Suggestions never
adopt grants/profile identity. Live root binding and in-progress checkpoint codecs
remain open. Regression source unexecuted; no completion or acceptance claim.

## Explicit live-root backend activation

Reliability `f3a009ba` integrated conflict-free. Optional workingFilesActivation
now populates imported originals only after fresh local Chat/worktree ownership,
with separate new recovery destinations and durable liveWorkingRoots receipts.
Shared activation requires exact confirmed fresh managed empty Chat root;
Separate-only existing Git uses fresh managed worktrees. Baseline originals and
failure bytes remain retained; no source ownership/history is adopted.
This supersedes the backend content-only limitation in prior inventory entries.
UI/Branches explicit activation and new-Chat choices remain missing; omission
continues content-only behavior. Full #8 remains incomplete/unverified.
No tests/builds/types/Node/browser/runner work performed.

## Runtime hold lifted and successor integrated

Manager authorized Runtime chain `5511e2bd` -> `8d9dfaa8` -> `f446d63e`.
Integrated retained normal contracts, authorized text reply endpoints/receipts,
exact usage/diagnostics, billing admission and durable Codex recovery custody,
Stop/status/dismiss with original unknown work held. Previous Runtime-held and
missing generic endpoint entries are historical and superseded. UI recovery and
shared Chat/peer consumers still require their owner successors. Unknown original
turn reconciliation and Claude structured compaction remain explicit gaps.

One source conflict: assets.ts duplicate audio admission. Retained existing shared
recordingMediaType validator/extension map, removed Runtime local audioType and
duplicate keys, aligned deferred audio fixtures/documentation to the shared
contract. No broad admission fallback. Migration0035 is unique in the assembled
schema directory and registered once; ALTER-only progress column follows0034.
No migration/test execution. Runtime docs and recovery contract fully read.
No builds/types/browser/native/network/runner checks or passing claim.

## Workflow live-root caller and saved-coverage reconciliation

Features source `628cc23b583692aff38bf9d19b507217592d41c5` and
`d9fb504d766b24a3891a458657f58451e4a833ef` integrated conflict-free as
`fe92c0877` and `29cb44635`. Existing Reliability through `f3a009bac` and
Runtime through `f446d63e` were already integrated and were not replayed.
Sync dispatch and explicit resume now revalidate exact durable saved bytes even
with a process-local saved ticket; regression source covers reconstruction and
external frontier/invocation changes. General crash atomicity remains open.

Workflow file selections now forward explicit live activation and managed Chat
creation. Creation pauses before Agent import for exact actual-root confirmation
through workingRootReview and the public SDK/route; canceled or stale reviews
refuse, recovery copies remain separate, and live-root receipts survive terminal
compaction. This supersedes the missing Branches backend activation caller in
older inventory entries. Single-Agent managed Chat activation is implemented;
grouped Shared multi-Agent imports remain refused pending coordinated owner
implementation requested by the manager. The new UI activation/creation/review
flow and separately reviewed mapped Settings choices remain owner work.

All eleven changed-file entries across both commits were inspected in source;
shared docs overlap once, yielding ten distinct paths. No tests, checks, builds,
types, browser, native execution or runner preparation performed. No push/deploy,
full #8, #32 or Phase 2 completion claim.

## Grouped organization per-Agent access backend

Reliability `82cf46284f918efbd187a5ff3e6df3eab7371c47` integrated
conflict-free. The shared import resolution accepts an exhaustive agentActions
map for source nodes with accessSettings, retaining required action and one
complete-package/actual-destination reviewSha256. Missing/foreign refs refuse
before writes, each explicit choice controls only its fresh Agent restriction,
and current destination policy is rechecked before commit. Existing whole
same-Chat importer supports one-operation Shared-root population. Deferred
regression source covers two members sharing actual live cwd and mixed reviewed
restriction choices. All five owner deliverables are present and source-read.
Branches grouped package assembly/ref remapping, fresh-ID binding/recovery and
staged human decisions remain owner work. No UI completion or full #8 claim.
No tests/checks/builds/types/native/browser/runner execution; no push/deploy.

## Web continuation through explicit fresh live-root import

UI `95ad75b90` and exact `e8dcaa76b5f799ce7f3f54f0d330dc7b179a7f0b`
integrated conflict-free as `58d152c77` and `36d904236`. Earlier web chain was
already present. All thirteen distinct changed deliverables physically present.
Source adds shared human Chat and passive same-Chat peer authorized text previews,
explicit singleton speaker move, mapped post-import memory/browser/profile human
choices, complete async import receipts, fresh managed Chat creation and explicit
actual-root live activation alongside separate recovery destinations. These
supersede the corresponding missing Agent-import/stream-consumer inventory notes;
no execution or acceptance verdict accompanies source coverage.

Exact remaining web product work belongs to the sole UI owner: BranchPackageDialog
workflow folder export/import controls, managed Chat creation/activation choices,
workingRootReview actual-root confirmation, grouped Shared per-Agent choices and
mapped post-install Settings; exact f446 recovery Stop/status/dismiss consumer.
Branches backend grouped assembly/ref mapping/bindings/recovery remain its owner’s
work. Integration does not take ownership of web surfaces. Early qualified voice
acknowledgement is Runtime work. Broader generation coverage, accessibility/mobile
judging and performance acceptance remain unresolved/unverified.
No tests/builds/types/browser preparation or execution, push/deploy or full #8 claim.

## Exact recovery UI consumer integrated

UI `21569c9229020e566beb83f630025b9551b3d541` is integrated after the complete
web chain through e8dcaa76. Persistent Agent technical view now offers on-demand
exact recovery status/evidence, fresh boundary acknowledgement, retained exact
request-key lookup, Stop during pending recovery and separately acknowledged
settled-hold dismissal. The earlier missing recovery UI inventory is superseded.
Original work remains unresolved; no automatic recovery retry/replay or grant
change is implied. All five changed deliverables physically present/source-read.
Only conflict was documentation: removed superseded missing-recovery prose while
retaining explicit UI ownership and source-only qualification.
Remaining UI product work: BranchPackageDialog workflow folder selections,
per-target recovery destinations/activation/new managed Chat/root confirmation,
grouped Shared per-Agent choices and mapped post-install Settings. UI remains sole
web writer; backend grouped composition/binding/recovery stays Branches-owned.
No tests/checks/types/build/browser/native/runner preparation or execution, push,
deploy, #8/#12/Bible/Phase2 completion claim.
