# Superseded integration history

Historical snapshots below record what was known at each increment. Missing-code
statements here are not the current backlog. Use implementation-coverage.md.

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
| 8 | `portable-agent-package-validation.ts`, `portable-execution-archive.ts`, `portable-memory-snapshot.ts`, `portable-output-roles.ts`, `docs/combined-migration-contract.md` | Reliability increment integrated: portable role/speed/preset snapshot and remapped guidance refs, validated import selections, shared export warning. Shared composer/forest activation, workflow folder controls, grouped review and mapped Settings are integrated; see latest continuation for remaining gaps. Full recreation remains unverified. Known secret fields stay excluded. |
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
| 31 | `routes/streams.ts`, Agent/Workspace hooks, `BranchLiveOutput.tsx`, `voice-reply-stream.ts` | UI shared-human/private/peer previews and recovery controls integrated; mixed-route generation and early qualified voice remain Runtime work. Latency thresholds/recordings deferred. |
| 32 | `packages/core/src/branches.ts`, `branch-store.ts`, host-cut/provenance and canonical restoration authorities | Integrated bounded Fork/Map/control, issued persistent Request graph and owner-tree rewind, including restored-history recapture; see latest continuation. Resource consumer, secret/recovery/cancellation/forwarded-bundle/crash gaps and framework examples remain implementation work. No acceptance inferred. |

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
| Exactly one app-wide Ponderosa speaker; move designation | Output-role preferences and dedicated role routes | Features singleton route plus UI expected-speaker confirmation integrated; runtime/UX acceptance deferred. |
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
| Checkpoints and rewind | Initial/historical routes, branch-unit-saver, branch-host-cut/provenance, canonical cut restoration | Bounded parallel/issued Request/tree/repeated rewind source integrated. Shared retained package API present; Branch resource consumer and fresh destination policy review remain open, as do secret/recovery/budget/cancellation/forwarded-bundle/crash families. |
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

## Connected workflow organization import caller

Branches `8d5ee5a11475de121f86099a433c92cd4e4b8fea` integrated conflict-free
with Reliability82cf46284 already present. One connected same-Chat organization
can now compose into one canonical import with namespaced artifact/history refs,
compatible Shared originals/memory consolidation and preserved Separate roots.
Conflicting source manifests/bytes refuse. All fresh IDs bind atomically to one
creation receipt; recovery validates ordered membership/result mapping and staged
memory, and missing partial groups cannot fall back to individual imports.
Actual-root confirmation, Stop and complete grouped policy digest remain required.
All six changed source/doc/regression deliverables are present and source-read.
This supersedes the blanket missing grouped connected-organization backend caller
in earlier inventory entries. Disconnected same-Chat forests still need shared
importer batch admission without inventing a manager; existing Agents are not
regrouped. UI workflow-package controls remain sole UI-owner work. In-progress
checkpoint fork/map/Request/provider/resource/recovery-secret families remain open.
No tests/checks/builds/types/browser/native/runner preparation or execution,
push/deploy or full #8/#32 completion claim.

## Shared composition and independent reporting roots

Reliability `d7ca2d196a6e1e90d3f80ff46f7bd5a0b9644da0` then Branches
`537b12517dd51c88ec719869174480455bd501be` integrated in dependency order,
conflict-free. One shared async composer now owns artifact/history/role/preset,
working originals and compatible memory remapping; the duplicate Branch composer
is removed. Explicit rootRefs admits same-Chat reporting forests without invented
managers. Shared root identity derives from explicit source Chat and shared mode,
including full-folder exports lacking input root refs. Group staged memory uses
ordered complete receipt membership; commit/recovery also checks result.agentRefs.
All fourteen changed-file entries (fourteen distinct paths) physically present and
source-read. This supersedes the earlier forest/importer-batch missing-source note.
Recovery mappings must be rediscovered/re-previewed with shared-composer root IDs;
old Branch-composer keys cannot be retained. UI ownership remains unchanged.
Existing-Agent regrouping and in-progress checkpoint fork/map/Request/provider/
resource/recovery-secret families remain incomplete. No tests/checks/build/types/
Node/native/browser/runner preparation or execution, push/deploy or full #8/#32 claim.

## Workflow web caller assembled with shared composer contracts

UI `468d5b64f1f7a2bc79c67172f88408a782ca9523` then
`d84e766c6283a481b3758d76242d1417ee4908d5` integrated as `490c2f0d6` and
`8fca25674` after prior webchain. Current Reliability d7ca and Branches537b
contracts are present; migration0035 and shared audio path were not replayed.
All twelve distinct changed deliverables physically present/source-read. Only
conflict was superseded documentation; retained current sole UI ownership.

Workflow full export now offers paginated canonical Agent folder/file selection.
Import collects per-target new recovery paths, explicit managed creation/live
activation and actual-root confirmation, grouped exhaustive access choices, then
mapped Settings review before opening. Discovery preview replaces old root keys
with shared-composer identities and requires exact-path re-preview. Single-folder
receipts render directly in BranchPackageDialog; grouped root/live/suggestion
receipts deduplicate in the shared review. This supersedes earlier blanket missing
workflow web caller entries. A tentative merge-helper omission concern was
withdrawn after reading the direct single-folder rendering; no fix is required.

All32/Build-list tables remain implementation navigation, never acceptance.
Concrete remaining implementation includes existing-Agent regrouping and general
in-progress #32 fork/map/Request/provider/resource/recovery-secret continuations;
Runtime mixed-route generation/early voice and unknown-native/Claude limitations
remain. No consolidated qualification started. No tests/checks/build/types/browser/
runner preparation or execution, push/deploy or whole-UI/Bible pass claim.

## Common optimistic source-capture boundary integrated

Runtime owner `7a6293325ec4cf1e40135a5b2eac1e09d503c760` integrated as
`1d7805d18` atop `914e45363`. All sixteen changed deliverables are present
and source-read, including the API, writer hooks, exact contract documentation,
and deferred regression source. No migration was added; existing0035 remains.
Resolved two integration conflicts by preserving the shared recordingMediaType
import/audio map and forwarding portableState through the tracked async imported
history wrapper. Additive agents API exports are retained.

For all32/Build-list #32 coverage this adds only the common optimistic host
boundary: supplied SQLite connections plus participating journal, imported-history,
artifact, attachment and deletion writers. Reliability's retained package caller,
memory/import writer hooks and durable unknown-outcome checks remain required for
combined all-domain capture. No native provider snapshot or complete resource
custody claim. Newer Branches a62ef through6c4a9eb source is not yet integrated in
this tree; its implementation notices do not establish integration or acceptance.
Other previously listed gaps remain open. No tests/checks/build/types/Node/native/
browser/runner preparation or execution, push/deploy or qualification performed.

## Retained checkpoint package API and shared memory boundary integrated

Reliability chain43c571ab5,4f01fe953,6a93cd75a,6424afa34 integrated in order
as3f5baaaf6,df916a390,80853b521,0c83c07ea atop6c1adfa39. Runtime-equivalent
c0b0118dd was skipped because1d7805d18 already supplies the same resolved source.
All26 distinct chain deliverables are physically present; API/caller/memory
source, exact contract docs and all four deferred regression files source-read.
Current final custody/memory/boundary source matches the owner handoff.

This supersedes the preceding missing Reliability caller/hooks note. The shared
engine exposes capture/inspect/read/release with exact immutable capture intent,
ordered closed organization membership, independent private fsynced retained
bytes, actual Runtime boundary identity, lost-response receipt lookup before
source access, and durable release tombstones. Final synchronous receipt
publication locks all supplied source SQL connections. Memory mutation views use
the same registry and durable unsettled holds across restart; no automatic
remote-write replay or hold reclamation. Read-only exports remain readers.

For all32/Build-list #32 this is resource-custody API source coverage only.
Branches capture-intent journal/finalization/readback/retention/rewind consumer
and fresh destination policy review remain owner work. Newer Branches
 a62ef-through6c4a9eb chain remains unintegrated in this tree. Old metadata-only
cuts and arbitrary shell/user-folder/native-transcript/remote-bypass changes
remain unsupported. No native snapshot, complete resource restoration, full
#8/#32 or passing claim. No tests/checks/build/types/Node/native/browser/runner
preparation or execution, push/deploy or qualification performed.

## Branches parallel, canonical coordination and recapture chain assembled

All sixteen actual owner commits a62ef242 through6c4a9eb integrated in ancestry
order atop123f91222; final source commit1b1ffa842. Runtime/custody equivalents
were not replayed. One source collision family: db.ts migration registration,
resolved to preserve0035_provider_context_recovery_progress.sql followed by
0036_coordination_cut_restorations.sql exactly once. Neither migration executed.
The sole UI owner reviewed the complete RequestLifecycleCard file and exact
frozen delta and approved adoption as-is. Historical question/answer labels,
full-text buttons, numbering and historical-origin actor rendering are included;
no correction was needed. This approval covers only provenance rendering, not
browser graph review/adoption callers or #32 acceptance.

This supersedes older blanket statements that Fork/Map, issued Request prefixes,
owner trees or restored-history recapture lack source implementation. Supported
bounded codecs now include nested Fork/Map; all/any/quorum joins; route/condition/
loop/owned bundle replay; sanitized Script failures, retry generations/delays and
observed drained Script remainder cancellation; human gates with fresh reviews;
before-Request persistent Agent admission; reviewed persistent issued Request/
question/answer/Join graph restoration; serial/parallel child-owner trees with
one canonical map/receipt/transaction; and bounded provenance-verified recapture.
Current grants/pins, complete owned audits, terminal versions, observed drain,
fresh admission and exact fresh Communication proof remain required. Imported
historical facts stay labelled data; no native Run/session/lease is restored.
Host-cut evidence is scoped to original participants and immutable saved bytes.

Operator host Request/graph review/adoption endpoints and public SDK are present.
Browser review/adoption callers are now assembled in the successor below; UX
acceptance remains deferred.
Same-transaction canonical/frontier insertion and readback, final-only wakes,
immutable provenance maps and lost-response receipts are source coverage only.

All32 and named Build capability inventory remain navigation, not acceptance.
Shared checkpoint package custody/memory boundaries remain present. Branch
resource capture-intent/finalization/readback/retention/rewind consumption and
fresh destination policy review are a separate open continuation. Old metadata-
only cuts have no retained private bytes. Changed/secret binding remap, Agent/
child cancellation, cross-owner forwarded bundles, recovery/exhausted budgets,
unknown native outcomes and broader crash reconciliation remain unsupported.
Pinned framework examples/equivalence and prior Runtime/UI/performance gaps
remain open. No tests/checks/build/types/Node/native/browser/runner preparation
or execution, push/deploy, complete #32/Bible/Phase2 or passing claim.


## Reviewed historical Request and graph browser caller assembled

Sole UI-owner successor41797eb8b integrated as a4fe236ca atop6c3dfa854;
all six deliverables are present. BranchHistoryReview mounts in ExecutionPanel,
loads paginated checkpoints and obtains exact scoped Request/graph review before
fresh adoption, graph restoration or historical rewind. Controls require current
review, explicit effects reconciliation, changed-binding/secret acknowledgements
where applicable and a fresh instruction for adoption. Unsupported graph cuts
remain gated. Retained exact submissions reconcile ambiguous outcomes with the
same command key; stale409 clears prior acknowledgement and refreshes review.
These are source behaviors, not observed browser results.

Backend/core and existing historical provenance rendering are preserved. No
resource access-review or custody-release UI is included; those controls remain
separately assigned. Branch resource consumer and issued/parallel/tree extensions
remain separately tracked, not integrated by this UI successor. Existing source
gaps and qualification limits above continue to apply. Deferred regression files
branch-history-review.test.mjs and branch-history-review-mounted.tsx are present;
no tests/checks/build/types/Node/native/browser/runner preparation or execution,
push/deploy or full #32/Bible/Phase2 verdict.


## Retained pre-opening resource consumer and inspection contract assembled

Source-only consumer7a190fbe3, child correction1d6278349 and contractf482ecfc0
are integrated in order as e7055ab87,42f126be0,a8c4af20e atopcf4ff5159.
The broad dependency merge55ab6c75/7110930 was not replayed. Existing Runtime,
custody, migrations and sole UI-owner graph caller41797eb8 remain preserved.
The current script continuation keeps its prior removal of a duplicate gate loop.

This supersedes prior blanket missing-resource-consumer statements: a nonsecret
serial ephemeral-organization resource can capture the exact imported generation
before its first opening Request, retain/finalize the immutable intent and bytes,
retire, rewind and obtain fresh destination access review/import. Eligible child
owners receive independent validation, retirement/release proof and mapped ancestor
readback. Fresh Agent maps and current policy review remain required; historical
provider authority is never restored. Lost-response lookup uses retained custody,
not a recapture of newer source state.

The operator API/SDK now supplies pure resource inspection with exact generation,
destination availability, custody identity and canonical receipt digest; pure
release-command readback; explicit current access choice; and identity-bound
custody release carrying the original command key/generation/custody/receipt hash.
Releasing or ambiguous outcomes stay explicit, completed commands are idempotent,
and referenced custody refuses release. The older access-review GET still stages
a journal; pure inspection is the reconciliation read. Resource inspection/release
UI is separately assigned and remains open; no new web source is included here.

All seventeen distinct owner deliverables across these three commits, plus this
coverage inventory, are physically present, including both owner docs and two
deferred regression sources. Issued-resource
Request restoration, resource-local parallel paths, later captures, multiple
resources within one owner, changed/secret bindings, broader reconciliation and
owner-deletion/orphan custody reclamation remain open. Multiowner/parallel resource
behavior is not qualified. All other source gaps above remain explicit. No tests,
checks, builds, types, Node/native/browser/runner preparation or execution,
push/deploy or full #32/Bible/Phase2 acceptance claim.


## Resource destination review and custody-release browser caller assembled

Sole UI-owner successora1da73c5 integrated as185f5814d atop9f6904e7a,
consuming the already integratedf482ecfc0 backend/core contract. All six owner
deliverables are present. ExecutionPanel mounts resource review beside temporary
resources. Pure inspection supplies exact owner/generation/destination/custody and
current policy; explicit per-Agent choices and shared confirmation precede access
submission. Stale or ambiguous access outcomes refresh pure canonical inspection
without replay. This supersedes prior missing resource-review/release UI notes.

Release requires local retained custody and the full returned receipt identity.
The caller retains the entire original command before deletion, inspects the same
key after ambiguity/remount, and allows only explicit confirmed retry of that
original input across generation changes. Only matching released readback clears
it. Restoration-source custody remains managed by its original owner; referenced
refusals and unconfirmed outcomes remain visible. These are source behaviors,
not observed browser results. Backend/core, Runtime and existing web provenance
and graph callers remain preserved.

Issued-resource restoration and broader resource families, deleted-owner/orphan
reconciliation, accessibility/mobile/performance and integrated qualification
remain open. Deferred regressions are source only. No tests/checks/types/build,
Node/native/browser/runner preparation or execution, push/deploy or full
UI/#32/Bible/Phase2 pass claim.


## Runtime fresh-participant destination admission assembled

Runtime owner71c557a06 integrated as d4e4821bf atopadbcaa8df without source
conflicts. All twenty owner deliverables are physically present. Migration0037
coordination_destination_admissions follows existing0035/0036 exactly once;
none executed. Runtime/package/core source equals the frozen owner successor.

Host-only reserve/stage/review/admit/readback APIs and additive import hooks now
provide durable fresh Chat/Agent holds, actual import identity/artifact maps,
mandatory current custody/owner and per-fact disclosure authority, current policy
hash review, synchronous Branch composition and final-only activation publication
inside the canonical owner transaction. Savepoint rollback, exact receipt readback
and staged intake/readiness/scheduler gates are source implementation. Ordinary
original-participant restoration and actor authorizers remain strict. Access
settings review alone does not authorize historical disclosure.

This does NOT complete issued-resource restoration: Branch must supply exact
issued-frontier capture bytes, deterministic initial destination identity,
real custody/disclosure/artifact adapters and human review, final policy sequencing,
issued Step/resource/import/owner receipts and lifecycle reconciliation. Existing
issued-resource refusal must remain until that consumer is connected. One
nonsecret organization/Chat generation is the bounded Runtime scope; external
participants, unknown/recovery effects, expired deadlines, Decision suspensions
and communication-owned artifacts refuse. Source lifecycle RESTRICT pins can
block deletion until owner reconciliation; no automatic hold reclamation exists.

Deferred runtime fixture source is present, not end-to-end qualification. Existing
resource/UI/performance and broader #32 gaps remain open. No tests/checks/build/
types/Node/native/browser/runner preparation or execution, push/deploy or
#32/Bible/Phase2 acceptance claim.


## Archived coverage before current tree UI reconciliation

# Current implementation coverage and backlog

Source-only inventory includes Branch1aa09968 (2–32 serial/local-parallel resources; c462d403 predecessor), Branch72f46799/e7602fc15 (parallel8ccf446bb plus retention-only evidence/fixtures), Runtime publication7bc728008,
retirement9edf00516, group API31bf3636 and memory exposure13bf72442, sole UI-owner through6b1f7a398 (12e744222/eba8fa646 predecessors) (91e8f8ad2/6ddf47dfa predecessors),
and lifecycle source throughf73a1e5a discovery atop393a02f5 (including Runtime713af3ad equivalent1e4d9e2). Integration owns
`phase2-implementation-integration` at
`/home/phoenix/ponderosa-worktrees/phase2-implementation-integration`.
No tests/checks/build/types/Node/native/browser/runner preparation or execution,
push/deploy or new workers. Nothing here is a passing or whole-Bible verdict.

Older contradictory missing-code statements are retained separately in
[implementation-coverage-history.md](implementation-coverage-history.md).
The tables below distinguish known implementation gaps from owner dispositions
and deferred qualification; an unverified behavior is not automatically absent code.
Owners: Runtime, Reliability, Features (Branches), UI, Integration; Cliff assigns scope.

## Current all32 inventory

| # | Source coverage / current implementation disposition | Owner / deferred qualification |
| --- | --- | --- |
| 1 | Persistent history, imported history and managed context recovery are assembled. Unknown native compaction outcomes have no result-query/idempotent recovery; never replay them. | Runtime; history continuity/crash trials deferred. |
| 2 | Canonical authority/context mechanisms documented beside source; no second state authority introduced. | All; whole mechanism inventory audit deferred. |
| 3 | Shared desktop/mobile Chat, output, Assistant and review controls assembled. No new specific missing UI code demonstrated by this integration. | UI; comparative usability judging deferred. |
| 4 | Native harness adapters/recovery source assembled; Claude structured compaction and lost native outcome reconciliation remain gaps. | Runtime; provider parity trials deferred. |
| 5 | Configurable native/memory/browser integrations; limits remain explicit. No new infrastructure dependency added. | Runtime; dependency/limit justification review deferred. |
| 6 | Human access/settings reviews plus explicit historical disclosure choice; live policy revisions rechecked at admission. Access review alone grants no disclosure. | Runtime/UI; authority invariant trials deferred. |
| 7 | Runtime source disposition: dedicated operator authentication is already absent; origin/cross-site checks remain. See runtime-publication-and-voice.md for live gate references. | Runtime; boundary qualification deferred. |
| 8 | Shared full package composer, independent reporting forests, working files/roots, authored history, memory, roles/settings and retained custody source assembled. Cross-Chat existing-Agent/root relocation and broad workflow restoration families remain gaps; same-Chat reporting uses its existing canonical writer. | Reliability/Features; fresh-instance equivalence deferred. |
| 9 | Shared DTOs/composer/dialogs and canonical graph writer retained; no broad dead-code verdict. | All; dead-code/duplication analysis deferred. |
| 10 | Public Branch routes/SDK and standalone examples/branches-client/client.ts present. | Features/Integration; external-client execution deferred. |
| 11 | Canonical scoped asks/results and artifact references remain the communication path. | Runtime; token/log efficiency judging deferred. |
| 12 | Durable journals/outbox/receipts and retained custody; unknown effects stay held. Explicit package/import/memory reconciliation and Branch checkpoint retirement source now exist; destination/abandoned-intent and external-writer gaps remain. | Reliability/Runtime/Features; crash trials deferred. |
| 13 | Steering/fences/pause/review controls assembled; held destinations do not silently reimport or release. | Runtime/UI; state-specific steering trials deferred. |
| 14 | Provider errors, explicit unconfirmed outcomes and recovery surfaces assembled. | Runtime/UI; backoff/failure delivery trials deferred. |
| 15 | Marker-only unlink and nonrecursive tombstone cleanup preserve unexpected user content; private custody is independent. | Reliability; racing-file/deletion trials deferred. |
| 16 | Trigger schedules/conditions/occurrence identity source assembled. | Features; timing/clock-change trials deferred. |
| 17 | Exact additive predecessor fixtures and migrations0035/0036/0037/0038/0039/0040 retained once each. | Runtime/Reliability; upgrade/reliability runs deferred. |
| 18 | Inbox/notification journal and Assistant cadence source assembled. | UI/Features; quiet-default/deduplication trials deferred. |
| 19 | Authored communication, activity and execution evidence stay distinct; known secret-field redaction source retained. | Runtime/UI; redaction/diagnostic trials deferred. |
| 20 | Host/origin operator authority has no general token gate; local-operator is server-owned. Native account login, scoped Run/internal/browser capabilities and human access remain domain authority. No further dedicated-auth deletion warranted by inspected source. | Runtime; secure-environment boundary trials deferred. |
| 21 | Streaming/virtualized projections source assembled. Historical LCP failure is unresolved evidence, not a measured improvement. | UI; INP/LCP/performance qualification deferred. |
| 22 | Setup/user guides and standalone client guidance updated. | Integration/Runtime/UI; installation/platform timing deferred. |
| 23 | Current source docs and historical integration record separated. | All/Integration; whole public-guide audit deferred. |
| 24 | Exact usage/budget counts and semantic status source retained; no invented progress or subscription cost figures. | UI/Features; numeric accuracy trials deferred. |
| 25 | Native subscription/API-key billing selection and settings source assembled. | Runtime/Features/UI; both-mode usage trials deferred. |
| 26 | Shared chat/output/review/confirmation patterns assembled. | UI; comparative consistency judging deferred. |
| 27 | Semantic controls, keyboard/text-size/theme source assembled. | UI; accessibility/device qualification deferred. |
| 28 | Branches remains subject to all32; partial source slices confer no acceptance. | All; whole-product qualification deferred. |
| 29 | Shared Chat/output/Assistant/folder/navigation source assembled. | UI; blind panel/mobile/flicker judging deferred. |
| 30 | Unified local-memory search/settings and portable memory source assembled. Exact effect-bearing failed holds have explicit reviewed preserve-current reconciliation; legacy/unknown cases stay held and no automatic reclamation exists. | Runtime/Reliability/Features; backend permission/search trials deferred. |
| 31 | Runtime adds explicit document/mixed-route/attached-Request final generation through canonical publication, and native-receipt-qualified early voice acknowledgement. Separate UI acknowledgement/answer buffers and exact private Request previews are assembled with validated Request memory exposure; see runtime-publication-and-voice.md. | Runtime/UI; source only, native/UI execution and latency/recordings deferred. |
| 32 | Parallel/control, persistent issued graph/tree/recapture, pre-opening resource rewind, single-resource review UI and bounded 2–32 serial/local-parallel gen0 group operator consumer assembled. See exact scope and missing-code list below. | Features/Runtime/UI; framework equivalence and all execution deferred. |

## Current bounded issued-resource source

Seven actual Branch commits integrated in ancestry order: d1e79d107,ea3d6fa37,
e5a6fee0f,778a001d3,fd8a55e63,d39f40f80,6b7f18a4a. UI00c62faa1 is the sole
UI-owner successor to already integrateda1da73c5. No old dependency merge replay.
Branch8ccf446bb extends local parallel replay; UI2c7db556e adds publication/voice consumers.
Runtime staging/authority, retirement and migrations0035–0040/custody retained.

Actual source now seals independently retained package bytes, selected frontier,
host digest and executable audit envelope; verifies issued custody; reserves exact
prospective Project/Chat and manually accepted Branch execution/budget; stages actual
fresh imports under durable holds; applies final policy; discovers persisted choice;
previews original private facts/audiences and mapped recipients; records explicit
local-operator approval/revocation; and composes mapped Branch/Runtime/import/resource
receipts and final selected checkpoint in one transaction before final activations.
Exact command readback avoids package access/effect replay after committed admission.
UI exposes prepare, preview, approval, revocation, separate admission and retained-key
inspection, with exact identity/hash/CAS checks and no automatic mutation retries.

Supported: standalone nonsecret ASYNC/SYNC generation-zero single organization,
serial or local fork/join/map/Script/control paths with complete owned audit replay,
complete fresh participant map, settled/drained original effects and retirement
proof, no runtime/package artifacts, memory, source restrictions, elevated automatic
management grants or native working copies. Original Project audit scope must remain
available. Ordinary historical rewind still refuses issued-resource cuts; this is a
dedicated reviewed destination command. Pending summaries remain restoreSupported:false;
only committed admitted receipts report true. This is assembled source, not observed
end-to-end behavior. See branches-public-engine.md, coordination-destination-admission.md
and web-feature-completion.md for ordering and limits. Completed parallel cleanup
holds and called resource trees remain refused.

Branch72f46799 prospectively retains canonical hashed retired-generation evidence
in the owner transaction before member deletion and current-pointer replacement:
exact resource/members, immutable generation Chat context, operation receipts and
ordered checkpoint audit. Conflicting evidence aborts. This does not reconstruct
old evidence or enable later-generation continuation; current codecs still refuse
retry history until all earlier custody, Request and host cuts are validated.

See [branches-later-generation-block.md](branches-later-generation-block.md):
the singular Runtime contract has no evidence-only historical participant partition.
Reservation requires current custody Chat scope, staging requires both an exact
current-custody Agent map and every historical participant in that map, and the
canonical writer restores all Requests into current destination state. Runtime must
define validated historical-only roots with original identities, provenance, update
prefixes, disclosure/authority, readback and no dispatch. A multi-current-resource
group API alone does not supply this partition. Separately, Branch still needs
precleanup immutable host closure, observed historical native drain and actual sealed
package custody, plus serial/parallel failed-attempt settlement, retry scheduling,
retirement and fresh-generation replay. Existing retention does not supply these.

Branch aa6be267 adds a consumer readiness fence over singular destination and
all `resources[*].destination.executionId` entries for every non-admitted admission.
Matching owners and ancestors remain held, including repeated group slots; only
whole admission releases this fence. Two deferred ASYNC/SYNC synthetic-row fixtures
cover non-first/repeated destinations and reserved/staged holds versus admitted
release. This is not group intake/composer implementation or executed group proof.

Runtime31bf3636 delivers the host-only atomic group API: 2–32 distinct source/fresh
resource Chats in one destination Project, exhaustive custody/import/participant maps,
per-import held staging or all-at-once staging, distinct whole-group custody/disclosure
authority, one canonical writer/composer/savepoint, verified owner/Step/resource/import
receipts, final-policy recheck and final-only wakes/readback. Migration0039 pins every
source resource-owner execution and holds every group Chat. The existing Branch
any-resource readiness fence remains integrated. See coordination-destination-groups.md.
Three deferred synthetic Runtime boundary fixtures are present, unexecuted; no actual
owner-tree/provider or Branch group consumer qualification is implied.

### Bounded 2–32 resource group consumer

Source extends the one-owner group consumer to 2–32 distinct generation-zero
resources in serial and local parallel flow. Each exact selected resource retains
its own package bound to the same whole host/frontier/audit; all seals are required.
Shared parallel replay now keys reservation/operation/opening proof by resource Step,
with exhaustive whole-cut and per-resource member/context/import/Request checks.
Fresh Project/per-resource owned Chats/full maps, sequential prepared imports,
current whole human fact/policy choice, recursively nested finish wrappers around
ONE Runtime admit, every owner receipt and after-admission same-transaction final
checkpoint/readback are connected. Private package selection uses custody identity,
not receipt-array position. See `branches-two-resource-destination.md` for exact
routes, directory reuse and scope. Current budgets/capability/pin/unknown fences stay.

A read-only group capture status route and shared DTO expose exact member seals,
cleanup hold and unsupported abandonment. Partial captures retain every cleanup pin;
no capture abandonment, package deletion or inferred disposition is enabled. Separate
whole-group destination retirement is integrated below; migration0040 is unchanged. Source cases cover ASYNC/SYNC
serial/local-parallel count/order, upper/lower bounds, final-import rollback,
non-first policy changes, tampering and partial capture restart. No fixture or
check/build/typecheck/preparation was executed; inert adapters are not native proof.

Called trees, later-generation evidence-only participants/resource retry/recovery,
parallel cleanup-held frontiers, broader package payloads and atomic multi-package
group capture execution qualification remain incomplete; dedicated source abandonment is described below. The fresh ordinary Project reuses
the owner Project directory and its usual default Chat plus N separately reserved
owned resource Chats. UI source now consumes authoritative 2–32 serial/local-parallel preview/discovery as described below;
separate filesystem workspace/imported native working roots remain absent. No qualification or acceptance claim.

### Resource group UI source

UI6b1f7a398 supersedes eba8's two-serial/browser-only capture presentation. See the
current authoritative preview/discovery section below. Both SDKs and core exports
remain; original commands persist before POST and recovery does not replay mutations.

## Actual missing implementation / owner requirements

Lifecycle successor source adds operator package/import evidence reconciliation and
explicit evidence-bearing remote-memory hold reconciliation, with preserved originals,
fresh CAS/drain checks and no unknown-write replay. See
[lifecycle-reconciliation.md](lifecycle-reconciliation.md) for endpoints/DTOs and limits.
Legacy memory holds without effect metadata remain held. Existing same-Chat reporting
regrouping already has a canonical operator endpoint; cross-Chat/root relocation remains
unsupported. Runtime staged-destination retirement is integrated with immutable
tombstones, review CAS and independent identity/import refusals. Branch owner lifecycle review and explicit checkpoint-retirement endpoints are wired;
package custody composes canonical references and cleanup/drain proof. Destination
retirement now has a destination-specific deletion/drain/reference adapter, durable
exact private fsynced human approval and operator review/approve/retire/receipt routes.
Combined capture abandonment joins a package prepare/tombstone/archive recovery journal
to Branch disposition and independent immutable SQL commit receipt. Exact unchanged
replay verifies retained original bytes after owner deletion; missing/corrupt/conflicting
proof and older unsealed filesystem receipts remain held. Source drain is not
destination proof. Global runtime quiescence is deliberately conservative; pre-stage
reservations lacking completed destination deletion receipts remain held. Singular retirement
continues to refuse groups; the separate exhaustive group lifecycle source successor is
described below. No preserve-only upgrade or cascading retirement is provided.
Source only; focused regression/crash execution deferred. Lifecycle migration renamed
`0040_lifecycle_reconciliation.sql` after existing Runtime0039; both registered once,
neither executed.

Scoped lifecycle UI source now provides Settings custody/memory inventories and orphan
staging evidence, actual import-operation review, canonical Branch destination retirement
and source-bound checkpoint/capture review. Commands persist before POST; ambiguous
outcomes retain exact input, stale409 refreshes without automatic replay, and destination
approval/retirement require separate confirmations with identical choice/key/hash.
Singular and group destination retirement have pure receipt GETs; other recovery requires explicit
unchanged POST replay. Corrupt retained browser input blocks new mutations. Two deferred
command/mounted fixture sources are present, unexecuted. See web-feature-completion.md.
Backend f73a1e5a now supplies paginated current/deleted/retained import and singular/group
current/retired destination discovery plus full supported unsealed capture source/key
metadata independently of destination review. UI12e744222 now consumes all three lifecycle
collections with independent pagination/revision validation and explicit restart, and
provides separate whole-group retirement controls. Branch checkpoint retirement still
depends on retained owner/source identity; no owner-independent journal. These are
source deliveries, not executed qualification; separate group capture preview/CAS UI
is now assembled by6b1f7a398 below, with the Branch preview read-transaction correction now assembled.

- Features + Runtime: called resource trees, later-generation historical participants,
  retry/recovery, parallel cleanup-held frontiers and broader package payloads remain
  refused beyond the delivered 2–32 standalone generation-zero serial/local-parallel
  consumer. UI source for2–32 serial/local-parallel capture/disclosure is assembled; atomic
  multi-package group capture abandonment source is composed below. Separate group retirement UI is integrated.
  Changed/secret bindings, exhausted-budget frontiers, Agent/child cancellation and
  cross-owner forwarded bundles remain open. Keep unsupported families refused.
- Runtime staged retirement boundary is assembled: reviewed hash CAS, synchronous
  approval/evidence recheck, immutable receipt/tombstone and optional proven-safe source-pin
  release for unadmitted destinations only. Retired identities stay held; admitted
  provenance cannot retire. See coordination-destination-reconciliation.md.
- Features + Reliability: exhaustive group lifecycle host protocol is included in the
  source successor below; Runtime canonical retirement and host callbacks are composed.
  Singular destination deletion/drain/reference/deleted-owner authority, durable approval
  and combined abandoned-intent/package retirement source are delivered.
  Other retained checkpoints/commands/admissions/package references still pin source
  custody; there is no cascading history retirement or preserve-only upgrade. Unknown
  effects and legacy unsealed receipts remain held; source-only protocols are unqualified.
- Features + Reliability: artifact/memory/working-copy/source-restriction/elevated-grant
  support in the new issued destination consumer; its current narrower refusal is explicit.
  Old metadata-only cuts cannot reconstruct purged private bytes.
- Runtime: native lost-outcome result-query/idempotency, Claude structured compaction,
  source-turn reconciliation remain external-contract gaps. Explicit selected
  document/mixed-route/Request generation and early native voice receipt source
  and UI consumers now exist; native/browser execution remains deferred.
- Reliability + UI: cross-Chat existing-Agent/root relocation; broader external-writer and
  legacy/independently unresolved remote-memory effects. Exact effect-bearing holds have
  preserve-current operator reconciliation; backend drain text is testimony, not native
  result-query proof. Arbitrary shell/native/user-folder writers are outside the
  participating source-boundary guarantee.
- Features: released comparator baseline now pins LangGraph 1.0.5 / LangChain 1.0.8
  with matched Python research/subgraph, independent critique and editable review source
  in examples/branches-capabilities. All nine dispositions have official documentation
  links in branches-framework-capabilities.md. Transitive locks, provider/model pins,
  source compatibility and executed equivalence remain unqualified; no parity verdict.
- Runtime/UI/Features: the Runtime auth disposition is recorded in
  runtime-publication-and-voice.md; remaining Build/native parity questions need
  concrete source dispositions before a missing-code or completion claim.

## Every Build-list subrequirement — current source navigation

These existing source anchors remain current. Required behavior text is a scope/owner
responsibility, not an assertion of absent code. No new Build-specific defect was
established by this bounded integration. Shared publication/voice source and the
remaining consumer requirements above apply equally to Output and Assistant.
UI/iOS/mobile/call/schedule/model/setup,
role lifecycle/notifications and cross-project behavior all await executed qualification.

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
| Exactly one app-wide Ponderosa speaker; move designation | Output-role preferences and dedicated role routes | Features singleton route plus UI expected-speaker confirmation integrated; runtime/UX acceptance deferred. |
| Edit workflow/model/prompt without breaking role | Branch editor and Agent runtime settings | Features + UI: keep designation through ordinary edits. |
| Delete/remove role disables; settings shows disabled | Role/deletion lifecycle and Assistant settings | Features + UI: disabled means no speaker, no silent recreation. |
| Explicit re-enable fresh defaults only if absent | Resumable Assistant setup | Features: no duplicate creation if speaker exists; preserve old workflow/user data. |
| Import speaker collision dialog disables imported speaker | `portable-output-roles.ts`, import UI | Features + Reliability/UI: collision warning/consent path and inactive imported role. |
| Preferred model unavailable: ordinary settings switch | Output model controls | Features + UI: no special recovery-only replacement or identity reset. |
| Inbox everywhere: UI/docs/code | Inbox component/routes/DTOs and shared composer | Integration: stale All Messages composer comment removed; historical stable storage IDs/`/messages` are intentional compatibility identities, not user-facing product labels. |

## #32 named capability disposition — source navigation

| Named capability | Source anchor | Owner disposition still needed |
| --- | --- | --- |
| Graphs | BranchDefinition steps/controls/edges; WorkflowCanvas | Features: graph authoring and runtime routing share canonical definition. |
| State | Branch parameters, execution input/results and configuration | Features: describe state semantics and missing general state operations explicitly. |
| Checkpoints and rewind | Initial/historical routes, branch-unit-saver, branch-host-cut/provenance, canonical cut restoration | Bounded parallel/issued Request/tree/repeated rewind source integrated. Pre-opening resource consumer and bounded issued-destination composer/disclosure UI are assembled. Broader secret/recovery/budget/cancellation/forwarded-bundle/crash families remain implementation gaps. |
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


## Qualification deferred, separate from missing implementation

No tests, types, builds, native/browser runs or runner preparation were executed.
Deferred regression sources were integrated, not passed. e7602fc15 delivers four
ASYNC/SYNC × serial/parallel fresh-context retry fixture variants with canonical
cleanup/retirement, immutable-conflict rollback, exact operation/context/audit retention
and reopen readback. Readback models a lost response, not an idempotent retirement
command against a new generation. Complete later-generation capture/review/admission,
tamper, stale/omitted prior custody/Request/drain and admission lost-response fixtures
remain undelivered; no legitimate historical-only admission contract exists yet.
Required future evidence
includes package fresh-instance equivalence, canonical rollback/crash/lost-response,
source-boundary/concurrency, destination authorization/lifecycle, provider parity,
upgrade/reliability runs, all Build flows, desktop/mobile/accessibility and measured
performance. Historical LCP failure remains unresolved. None of all32, #8, #12,
#32, Build, full UI, Bible or Phase2 is accepted by this inventory.


### Whole-group lifecycle source successor

Group destination retirement host source reuses the singular per-resource observer across the exhaustive 2–32 resource inventory, aggregates one review/revision, privately fsyncs one exact approval and calls one Runtime-owned whole-group retirement. Separate review/approve/retire/receipt routes and BranchesClient methods are provided. Every Chat, mapped/additional deleted member, current/deleted Project, import rollback, owner subtree/native exit and cross-owner reference is observed; unknown or stale evidence refuses. Singular retirement remains group-refusing, preserve-only is permanent and admitted provenance/package bytes remain retained. Deferred two-resource host/canonical composition and separate Runtime SQL fixtures are source only. No tests/checks/build/types/Node/native/browser/runner preparation/execution/migration/push/deploy or acceptance claim. Paginated backend discovery is integrated below; atomic multi-package group capture abandonment source is composed below; group history/disk reclamation and external unknown recovery remain open. Bounded global policy/history and native-exit inventories bind approval, conservatively invalidating it on unrelated policy changes; each source owner must also pass non-deletion drain inspection. No migration change was introduced.

### Lifecycle discovery source successor

Operator audit discovery now provides revision-bound paginated import-operation, current/retired destination and supported unsealed capture/source collections under `/api/lifecycle/{agent-imports,destinations,checkpoint-captures}`. It preserves exact current/deletion-receipt/retained-only owner labels and original product/Branch/execution identities, validates retained hashes/receipts, and exposes complete source/capture keys without gating source discovery on destination deletion review. DTOs/BranchesClient and deferred source fixtures are present. Unknown evidence remains held; bounded inventories refuse rather than truncate. This closes the backend identity reachability gap, with UI integration now described below; this does not qualify group capture abandonment, disk reclamation or broader lifecycle acceptance. No tests/checks/build/types/Node/native/browser/prep/execution/migrations/push/deploy/newworkers or web writes.

Discovery limits: page size1–100/default50; follow nextCursor until absent, explicitly
restart after revision409. SQL/recognized metadata inventories refuse above4096 records
or16MiB; import directory enumeration is separately capped at16384 entries and individual
files at4MiB. Invalid, conflicting, changed or oversized evidence returns409. Unrecognized/
quarantined import filenames produce a count, never guessed IDs or quarantine writes.
The read-only reader calls only pure import validation, not readOperation/hydration.
Current/deletion_receipt/retained_only labels are evidence states, never deletion proof
or eligibility. Supported singular resource/issued capture schemas expose stored full
source and exact key; unknown matched schemas refuse, while this lifecycle collection excludes GROUP capture journals. Separate canonical
group discovery below exposes prospective retained keys without reconstructing legacy hashes. Group multi-package abandonment uses the separate protocol below.
Discovery changes no pins, policies or payloads and returns no Request/snapshot bodies.
Five deferred metadata/SQLite fixtures are present and source-read, not executed.


## Prospective observed provider exit evidence (source only)

Runtime successor 61ad0416 adds immutable process registration and actual observed-exit
receipts in the existing lifecycle 0040 ledger. Four Run executor registration sites
supply the original spawn/turn fence. POSIX PID/PGID/birth/scope and code-owned Windows
Job lifetime bindings retain exact Project/Agent/Chat ownership and every same-lifetime
Run revision. `pruneExited` requires actual `isAlive() === false`; termination also
requires awaited successful `close()`. Receipt publication and POSIX authority removal
share one savepoint; failed publication/removal retains the hold. Native handles remain
held until publication succeeds. Neither deletion, terminal scheduler state, signal
submission nor absence of authority rows supplies observed exit.

`readProviderExitEvidence` requires the live original Chat, complete members and Run
inventory, exact registration coverage, terminal fences and all actual exit receipts.
The aggregate revision supports reserve/recheck before a Branch seal; retained readback
verifies immutable ledger bytes after owner removal and grants no new action authority.
Bounds are 256 participants, 4096 Runs per participant, 4096 total registrations and
16 MiB aggregate evidence, with 4 MiB ledger values and bounded retained readback.
See [provider-exit-evidence.md](provider-exit-evidence.md).

The prospective provider producer/reader alone does not implement Branch precleanup capture;
the separately assembled Branch producer and deletion guard are described below. Broader
retry/replay remains unsupported. Runtime historical-only
participant partition remains missing. Pre-upgrade removed rows cannot be reconstructed;
legacy empty registration coverage, missing Run spawn fences and Windows restart without
an observed retained Job exit remain held. No historical admission or later-generation
capture completion is claimed. Five deferred synthetic-handle fixture cases cover exit/
readback, complete inventory/rebinding/fences, savepoint failures, legacy coverage refusal
and Windows restart refusal; none ran, and they do not qualify actual provider/native exit.
All existing Branch group, retirement, discovery and scoped UI limits remain in force.



### Canonical group discovery and capture CAS (source only)

Branch e7d27801 delivers operator-only paginated retained capture/prepare intent discovery,
including original keys, source identities, resource counts and current admission or
retirement state without live destination membership. Prospective capture journals retain
original commandKey, reviewHash and versionId. Legacy hashed keys are explicitly
unsupported_legacy_key; supplied known legacy keys still support exact GET status.
This collection is separate from lifecycle singular-capture discovery and does not
reconstruct reclaimed journals or grant action eligibility. Pages default to 50, accept
1–100, and require nextCursor traversal. Any database write or daemon restart can
conservatively invalidate the cursor with 409; restart explicitly, never auto-replay.

Pure authoritative capture preview exposes the exact selected/host hashes, binding/version
and complete 2–32 serial/local-parallel generation-zero resource inventory without IDs,
intent writes or package effects. Reservation recomputes reviewHash/versionId in the owner
transaction before allocation; each remaining package effect rechecks preview and seals
retain existing transaction validation. Existing intent cannot be reallocated against a
changed cut. Exact retained commands read saved seals without recapture.

UI6b1f7a398 now supplies the required commandKey/reviewHash/versionId and full persisted
preview. The earlier commandKey-only input mismatch is resolved. Both BranchesClient
and additive BranchGroupClient retain shared DTOs and all prior exports/methods. GET
status remains compatible, with an additive disposition field. The Branch preview
read-transaction correction is assembled; executable qualification remains open.
Partial multi-package abandonment requires the separate explicit whole-group protocol below. Existing
historical participant and broader payload limits remain; prospective precleanup evidence is assembled below.
Deferred source covers preview purity/stale cut, serial/parallel exact and legacy keys,
retained owner audit scope, paging/invalidation/reopen and partial pin retention; none ran.


### Lifecycle global discovery and whole-group retirement UI (source only)

UI12e744222 mounts three independent Settings inventories for imports, singular/group
current/retired destinations and supported unsealed capture sources. Each follows opaque
nextCursor in 50-entry pages with one revision; invalid/revised pages or409 hide stale
entries, unmount review/confirmations and require explicit restart of that collection.
Other collections remain available, including capture source discovery if destination
review refuses. Original uncertain commands remain in scoped browser storage. Labels
show current/deletion_receipt/retained_only evidence, operation/product/status/phase,
all destination slots and full exact stored capture source/key. Unverified metadata
supplies a count only; retained identity is not deletion/drain/authority proof.

Discovered group admissions use separate group review/approve/retire/receipt routes,
display all resource/slot evidence, require one durable whole-group choice and separate
retirement confirmation, and reuse identical key/hash/body/pin disposition. Pending
input is saved before POST; ambiguous outcomes lock new input and409 resets review
confirmation without silently replacing original input. Pure receipt GET works after
response loss/remount or without successful review/saved command (historical evidence
only). Matching validates command/admission/review/pin identity and group resource-count,
slot-array and evidence-hash shape; the UI does not independently re-prove host evidence
or compare every receipt slot byte to the original review. Canonical backend proof
remains authoritative. No polling, automatic mutation/retry or singular-action loop.

This closes lifecycle discovery callers and group retirement UI source. Separate Branch
capture/prepare discovery and e7 preview/CAS UI are now assembled by6b1f7a398; legacy
lost GROUP keys cannot be reconstructed. The backend read-transaction correction is assembled.
Atomic multi-package abandonment source is composed below; existing eligibility,
bounds, quiescence, references, historical partition and Branch precleanup-seal gaps
remain. Two new deferred discovery fixture files plus command receipt additions were
read, not executed; no native/browser/mobile/accessibility or release qualification.


### Authoritative 2–32-resource preview and group command UI (source only)

UI6b1f7a398 uses the server's exact generation-zero standalone serial/local-parallel
preview, displaying every resource/participant and review/version/binding/frontier/host
hash. It rejects malformed, duplicate, later-generation or outside2–32 inventories.
Inventory/effect acknowledgements plus final confirmation precede capture; full original
preview and exact commandKey/reviewHash/versionId persist before POST. Independent GET
status must bind all Steps/Chats/seals before preparation. Every package/map/current
policy and whole private fact/actor/audience/recipient inventory participates in review;
approval, revocation and admission remain separate with current revision/hash checks.

Canonical capture/admission discovery follows opaque50-entry pages until no cursor;
invalid/409 pages clear stale selections and confirmation, requiring explicit restart.
Legacy missing keys are unsupported. Exact discovered capture key/review/version can
restore local GET recovery without browser history; admission GET can recover without
a capture key. Discovered preparation lacks optional original import settings and is
never replayed as POST. Other source Runs are audit-only in this component; actions
require their original source Run. Retained journal input survives ambiguous outcomes;
no capture/prepare/admit/choice replay is offered. Unknown slots remain held.

Preview transaction correction (source only): Branch owner f623c81ffe0cfee94ab447580617b61589460b13 is assembled. BranchStore.previewIssuedGroupCapture now invokes the synchronous helper inside this.sqlite.transaction on the same connection, providing the host-cut read snapshot and existing-transaction savepoint nesting. The source dependency is resolved; no executed usability or qualification claim.

Owner-independent group command readback remains missing: discovery can show retained
owners while exact scoped GET still refuses missing source owners. Partial multi-package
abandonment uses the separate explicit protocol below, with all pins held until commit. Called trees, later generations,
historical-only participant partition, broader Branch precleanup/retry/replay, broader
payload/native roots and unknown external effects remain gaps. Directory reuse/default
Chat plus one Chat per resource warning remains. Deferred helper/transport/mounted
sources cover2/3/32 inventory and last-policy binding, stale cut, exact CAS persistence,
response loss/remount/pure GET, canonical discovery/51st row/legacy/409 and independent
revocation; none executed. No native/browser/mobile/accessibility or acceptance claim.

Multiple-package unsealed issued-group capture abandonment: source-only host discovery/review/commit protocol and deferred boundary fixtures. One complete prepare inventory, all package tombstones and one canonical owner disposition; filesystem progress cannot release a subset of SQL cleanup pins. See `checkpoint-group-capture-abandonment.md`. No executed qualification, historical-group reclamation or unknown-outcome replay claim.
Canonical group partial-capture abandonment hooks now compare whole raw intent/revision, every source's drain/effect/reference inventory and all actual package retirement proofs in one owner transaction. Original bytes retained, exact proof replay and reserve/seal revival guards; only verified group disposition releases its own cleanup/reference pins. Host adapter is composed with these hooks in the dedicated protocol; package bytes are archived, never deleted. Deferred source only, no execution qualification.


### Composed whole-group abandonment integration (source only)

Successors535301c24/46ba3475e/9bbdaad1b are assembled without replaying already-equivalent lifecycle discovery. The separate fourth lifecycle group-capture collection exposes exact raw keys and full sources independently of destination review/drain. One complete private prepare journal precedes every package tombstone/archive; one Branch owner callback validates all proofs and one outer SQL commit releases group pins. Filesystem or SQL failure keeps every SQL cleanup pin held; unchanged explicit replay verifies original archives, including after owner removal. Current generation/import/member/subtree/attempt/Chat effect checks and reserve/seal revival fences remain mandatory. Retained/sealed groups, history/disk reclamation, unknown schemas/outcomes and external writers remain held. Dedicated group abandonment UI356b90b77 is now assembled below. Fixture source includes actual Branch-hook/host composition with synthetic payloads and injected SQL failure; no execution occurred.


### Permanent Runtime generation-exit fence prerequisite (source only)

Runtime b56852d995ecf9d134ad1cd9613dd1c15732394a is assembled as an isolated
successor; its parent was not replayed. The existing observed-exit producer/reader,
0040 immutable host lifecycle table and preview transaction correction already supply
its source dependencies. No parent-only API reference is unresolved.

The new exported fence API requires the same owner transaction as Branch's initial
fencing journal and stores exact original execution/Step/generation/Project/Chat/member
identities plus resource/member rows. Exact replay verifies retained canonical bytes;
all phases and owner/journal deletion retain the hold. Public intake/current scope
checks, external activation creation and independent scheduler candidate SQL reject
original identities and current members of the original Chat. Trusted terminal closure
may record continuations, but fenced identities cannot acquire new scheduler leases.
Product/source visibility, destination-admission checks and package capture capability
checks remain unchanged by explicit owner design, so source package reads remain possible.

The Branch producer and direct-deletion guard are now assembled below. It publishes
fenceBranchGenerationExit with the initial journal and retains identity/hash through
final evidence. Fencing is not observed exit or completed drain. Historical participant
partition/admission and broader retry/replay gaps remain. Three deferred synthetic-resource canonical Runtime
fixtures were source-read only; no tests/checks/build/types/Node/native/browser/preparation/
execution/migration/push/deploy or qualification claim. See branch-generation-exit-fence.md.


### Whole-group capture abandonment UI (source only)

UI356b90b771672731ee45150d0aaa39262f70e9d2 adds a fourth independent Settings
inventory for exact raw group capture keys/full original sources/captured subset.
Opaque50-entry pages follow one revision until absent; malformed/409 pages unmount
stale review/confirmation and require explicit restart. Destination failures do not
block this collection. Current/retained labels remain audit evidence only.

The separate whole-group review shows every package/source/file/revision/reference/
blocker, and any member hold blocks all. Acknowledgement and final confirmation create
one stable exact evidence-preserving body saved with original review before POST.
Unknown/409/FS-SQL partial outcomes retain input; no automatic mutation replay, singular
fallback or replacement key/hash. There is no receipt GET: recovery requires separate
deliberate confirmation of the identical saved POST, including remount after owner or
inventory disappearance. Origin/product-scoped unreadable storage blocks new choices.
Receipt matching binds exact command/group/review/Branch input/source inventory,
exhaustive unique package/proof identities, per-package review and preserved byte counts.
Hash fields are shape-validated; actual source/file/archive hash verification remains
host-owned. Only a selected receipt summary is displayed; originalCaptureRaw/private
Branch snapshot is not stringified by the UI.

All seven owner deliverables are assembled (three UI/helper sources, three deferred
fixture sources and web-feature documentation). The f623c81ff preview read transaction
correction remains assembled; no obsolete missing-correction note was restored.
Retained/sealed-group history/disk reclamation, unknown schemas/outcomes, external
writers, called trees/later generations, historical partition/broader Branch precleanup and native/provider/accessibility/mobile qualification remain separate or open.
Fixtures are source only: no tests/checks/build/types/Node/native/browser/runner preparation
or execution/migrations/push/deploy/newworkers and no acceptance claim.

Prospective retry-generation exit capture producer source: durable pre-drain identity journal and owner hold, real server runtime/process drain wiring, complete selected/host/native/effect/provider envelope, real package engine outside SQL and exact same-owner revision seal before Agent/Chat cleanup. Retirement retains immutable seal reference; after-deletion reader verifies retained provider ledger evidence. Canonical Runtime intake/lease fence is now published in the same owner transaction, with its immutable receipt bound into every journal/envelope/readback. Direct Agent/Chat/Project deletion guard029fade1e is assembled with the producer. Existing package visibility checks remain unchanged. Missing/preupgrade registrations, open parallel effects, deleted earlier roots and unsupported families remain held; historical partition/admission stays disabled. Deferred synthetic-provider/canonical-writer fixture source only.


### Precleanup producer and direct deletion protection (source only)

Branch a28f82d73 plus connecting4fdae620 are assembled without replaying the already
equivalent5bb7f6f2/b568 Runtime fence. Exact Runtime deletion guard029fade1e is
assembled first. Actual server drain cancels resource work, drains current runtime and
terminates/observes provider processes while original identities remain. Same-owner
initial journal publishes immutable intake fence; reservation binds exact generation,
selected frontier/host/native Script exit/effect/provider evidence; actual package engine
capture occurs outside SQL. Its synchronous callback rechecks full envelope and original
provider revision in the same owner transaction before custody/checkpoint sealing.
Cleanup/retirement require the seal and retain its hash reference. Retained reader verifies
journal/snapshot/custody/native/provider hashes without recapture after source cleanup.

Agent subtree preview/pending/commit, Chat pending/storage/commit and Project pending/
commit independently require matching sealed journal, immutable intake fence/envelope,
provider/native evidence and custody/selected snapshot. Bare sealed flags and missing or
changed evidence refuse. Branch begin/final deletion independently validates immutable original-owner/execution
fences, including descendant executions, before cancellation, storage effects or journal
removal, even if original Chats have disappeared or changed ownership. Installation
cleanup rechecks before private-state/Agent/Chat effects. New receipts retain original
Branch identity; legacy receipts without it conservatively gate every Branch deletion. Owner/journal removal does not release permanent
intake fencing; later deletion without seal evidence conservatively holds.

Enabled source scope is prospective standalone1–32 current local-resource retry cleanup
with complete original identities/registrations/settled host closure. Parallel open effects,
already-deleted earlier roots, missing preupgrade evidence, called owners, secret bindings,
host artifacts and unknown package outcomes hold. Historical partition/admission remains
false; nativeState stays not_captured. This is not later-generation admission or executed
provider/native/custody qualification. Deferred serial/parallel ASYNC/SYNC fixture source
uses synthetic process handles/terminal Runs and inert receipts with real evidence writers;
direct deletion refusal fixture adds missing/pending/forged seal cases. None ran.


Branch owner guard successor assembles the preserved prospective producer on current
44a919 with Runtime Agent/Chat/Project guards. Removed/reparented original-Chat refusal
and exact sealed cleanup/owner deletion rollback fixtures are source only and unexecuted.
No historical partition or later-generation admission is enabled; no acceptance claim.

Owner-independent group journal audit readback source: discovery emits exact raw journal/custody/admission/reservation hash selectors; operator read route and SDK validate retained group intent/receipt/retirement evidence after source-owner loss with explicit historical/no-current-authority/no-action flags. Current scoped authorizers remain unchanged. Deferred host and real Branch/canonical map-corruption fixtures are source only; no execution or broader lifecycle acceptance claim. See `group-journal-audit-readback.md`.


Integration source reconciliation: prior producer isolation at44a919 is superseded by the assembled independent Branch-owner guard from c5bb4f32. The isolated5ee source branch remains historical. Current source connects the producer with original-Branch/subtree fence validation before installation storage effects, beginDeletion and final SQL. Historical admission remains disabled; nativeState remains not_captured. No execution or qualification claim.


### Historical group journal audit UI (source only)

UI19bb4f26 is assembled with backend38ec equivalent. Canonical discovered
auditSelection is passed verbatim through BranchGroupClient.journalAudit GET; both
core clients share backend-owned DTOs. A separate read-only panel requires all four
historical/no-current-authority/no-action/held flags and exact selector/hash envelope,
shows the full retained map/import/resource/receipt inventory, and projects known
fields while excluding unexpected top-level and raw disposition snapshot fields.
Scoped GET refusal preserves discovery selectors; audit refusal clears audit/selection
and confirmation state for explicit rediscovery, without retry or inferred action.
Audit results are not assigned to capture/target/review/command mutation state.
The earlier audit UI adoption gap is resolved in source. Deep receipt/custody proof
validation remains backend-owned; UI helper shape checks do not independently prove
every nested map/import value. Erased journals remain unrecoverable; no retention
writer, reclamation or mutation authority is added. Historical participant admission,
later-generation admission and broader native/payload/recovery limits remain open.
Producer and independent Branch-owner guard remain assembled. Both helper/transport
and mounted fixture sources are deferred, unexecuted. No tests/checks/build/types/
Node/native/browser/preparation/execution/migrations/push/deploy/newworkers; no
qualification or acceptance claim.

Runtime historical evidence partition: canonical destination reservations can retain exact prospective sealed prior generations separately from current executable roots, using existing human disclosure/policy and current graph writer, immutable same-owner receipts/readback and custody pins. Source only; Branch later-generation retained-host/retry consumer and full integration/provider/native/package qualification remain separate. See historical-evidence-partition.md.


Integration: canonical evidence partition source is assembled; earlier blanket partition-missing notes are superseded only for this canonical API. Branch later-generation current-cut/retained-host/retry consumer and historical selection UI remain pending. Existing issued-consumer restrictions remain held. Old envelopes are historical and nondispatchable, never old Agent imports or provider/native capture. Historical partition-bearing group audit correction is assembled in source: explicit source(row,'audit') preserves the real admission identity for immutable partition receipt validation after original seals are removed. Admitted audit alone permits absent live slots using the retained canonical stage and committed maps/receipt; surviving slots must agree, while ordinary reads and staged/retired inventories retain strict checks. The existing GET/SDK/selector contract now exposes at most 32 historical nondispatchable metadata summaries (identity/hashes and Agent/Request/update/Communication counts), never private seals, envelopes, retirement bytes or recipient lists. Existing audit UI/client are unchanged; no historical selection/review UI or later-generation consumer is implied. Deferred producer/context, missing-slot and host private-projection fixtures are present but unexecuted. Erased original selectable group journals still refuse; no retention/reclamation writer or end-to-end qualification is added.

Called-owner issued-resource continuation: independent producer SOURCE now extends
shared tree/serial replay for exactly parent+called-child, one gen0 issued resource
each, ASYNC/SYNC serial waiting frontiers. Perowner custody/hash seals, exact tree
preview CAS, existing package-engine capture/readback, bounded discovery and SDK,
prospective fresh ancestry maps and deferred real Branch/import/Request fixture
are present. Ordinary restore/admission remains refused. Tree canonical Runtime
audit/read/retirement contract and atomic budgeted/human-reviewed multiowner group
consumer are still missing; no tests/build/types/native/provider qualification ran.

Integration scope: called-tree producer348d05c5 is assembled alongside canonical
historical partition312a95fb and audit UI19bb4f26 equivalents. Producer-only tree
scope is a manual parent plus one called child, each with one generation-zero
resource, serial ASYNC/SYNC. Preview/status/planning maps have currentAuthority:false
and actionEligible:false; ordinary tree restore and destination admission remain
refused. Runtime owner-tree contract dependency23446 and its Branch-owned Join
remain separate/unassembled here. Canonical historical partition remains delivered
for its explicit API; no called-tree historical admission or later-generation
consumer is implied. Parallel/EXIT/larger/later-generation trees remain unsupported.
No tests/checks/build/types/Node/native/browser/preparation/execution/migrations/
push/deploy/newworkers; no end-to-end qualification or acceptance claim.

Serial standalone one-resource gen1 destination SOURCE is connected on the shared
serial retry/current-host codec: exact old seal/retirement and failed attempt,
explicit current roots, current package CAS, server historical selector discovery/
SDK, real human all-facts disclosure, final policy, existing one-owner atomic
admission/receipts/readback. Integration separates sealed original Project audit-
read from fresh destination policy. Deferred actual producer->retry->capture->
review->admit fixture includes policy drift and owner rollback; nothing executed.
Parallel/later generations/called-tree admission and live native/provider/package
qualification remain unsupported. See branch-generation-one-destination.md.

Integration successor: generation-one consumer1fb4b4e is assembled alongside the
called-tree producer and ff40 historical audit identity/privacy correction. Earlier
blanket later-generation-consumer-missing notes are superseded ONLY for a manual
standalone owner with one serial resource at generation one, ASYNC/SYNC, exact
failed generation-zero evidence and automatic fresh-context retry maxAttempts=2.
Current roots/maps exclude the old attempt; its full original evidence remains
historical and nondispatchable. Original historical Project audit-read and no
pending deletion are required at preparation/candidate/final authorization; only
old/fresh Project equality is removed. The bounded historical selection/review web UI is assembled below;
parallel/EXIT/gen>1/manual recovery/called-tree admission consumers remain absent.
Erased original proof still prevents new admission; audit retains its bounded
metadata-only projection and requires an original selectable group journal.
Actual native/provider/package, accessibility/mobile and end-to-end qualification
remain open. All deferred fixtures are source only. No tests/checks/build/types/
Node/native/browser/preparation/execution/migrations/push/deploy/newworkers.

Bounded serial generation-one UI678493ca is integrated in source: canonical
resource Step IDs mount server preview/capture/status/discovery, exact saved
preview and full historical selection persist before CAS POST, pure original-key
GET recovers lost responses, and preparation carries historicalReviewHash.
Human review shows retired generation-zero nondispatchable facts and original
actors/audiences separately from current participant maps and policy; explicit
approval and admission remain separate. Receipt display projects private seals/
retirement bytes out; this does not remove intentionally authorized human fact
review. Capture/preparation/choice/admit409 and unknown outcomes retain original
commands for GET-only inspection, never POST replay. This supersedes earlier UI-
pending notes ONLY for one standalone manual serial resource generation1,
ASYNC/SYNC, retry attempt2of2. No parallel/EXIT/gen>1/manual recovery/tree admission,
unknown payload/native/provider/effect expansion or erased-evidence recovery.
Deferred helper/transport/mounted sources are present but unexecuted; runtime,
package/provider/native/accessibility/mobile and end-to-end qualification remain
open. No tests/checks/build/types/Node/native/browser/preparation/execution/
migrations/push/deploy/newworkers.

### Serial resource generation history source extension

The one-resource serial ASYNC/SYNC source path now covers generations 1–32 with
configured fresh-context maxAttempts <=33, exhaustive EVERY prior sealed capture,
retirement audit/failed Request/attempt/provider/native/custody chain, current-only
executable roots, server-owned preview/discovery/SDK selection lists, current human
all-facts review/policy, existing one-owner Runtime admission/receipt/readback and
preserved consumed attempt numbers. Later exit capture explicitly partitions older
roots after prior original Chat deletion. Deferred actual producer->retry->capture
->review->admit fixture SOURCE includes generations 2, 3 and 32 plus no-reset-budget
behavior. No execution, qualification or passing assertion is claimed. The already
joined Runtime529 source-scope/fence correction omitted by the assembled base is
included. See docs/branch-generation-one-destination.md for exact bounds and
remaining parallel/called-tree/EXIT/unknown/secret/artifact/web limitations.

Integration: cbe266387 is assembled on6aafb338 without ancestor replay. Runtime529
original-Chat scope and resource-Chat Project fence files are owner-byte-equal;
historical audit-read checks include each retained Request Project at package
prepare/candidate/final authorization. ff40 real admission audit context and bounded
private-evidence summary projection remain unchanged. Earlier generation-one-only
backend statements are superseded only by the serial one-resource generations1–32
source bound, maxAttempts<=33, with complete prior proof and consumed attempt numbers.
The Runtime32-selection/32MiB evidence bounds still apply. No parallel/tree consumer
or retry-offset restoration is established; a fresh destination starts generation0
while retaining consumed attempt number, and further offset retry restoration remains
held. The subsequent bounded history UI integration below supersedes the earlier
generation-one-only UI and fixed attempt2of2 limitation; no UI/full-feature
qualification is claimed. Deferred generation2/3/32 ASYNC/SYNC fixture source
is present but unexecuted, including rollback/readback and no replenished budget.
No tests/checks/build/types/Node/native/browser/preparation/execution/migrations/
push/deploy/newworkers.


### Bounded serial history UI integration — source only

UI7b28b68eb is assembled as db634aa16 on96ea1594e, with only its ten
required files plus this coverage update. Nine files are owner-byte-equal; the
web report retains prior integration notes and records already assembled cbe266387
backend/core. No ancestor replay or backend/reference copy. Current writer is
Integration on phase2-implementation-integration.

Generation-history preview requires every ordered prior selection0..g-1 for source
generations1–32, distinct checkpoint/envelope/fence identities, exact hashes and
current package refs. It displays actual consumedAttempts=g+1 and pinned maxAttempts
through33, retaining the complete preview and expectedGeneration/reviewHash before
one capture POST. Original-key status GET, bounded100 canonical discovery and exact
whole-selection/hash matching feed preparation; legacy saved gen1 evidence remains
inspectable without mutation replay. All history persists beside preparation and
only server historicalReviewHash enters the wire command. Missing/reordered facts,
seal identities, participant/current recipient mappings or differing receipt lists
hold review. Every original package/fact/actor/audience remains available to explicit
human all-facts review; approve and admit remain separate. Receipt projection omits
raw retired seal/retirement bytes. Backend is authoritative for eligibility,
proof/package validation, attempt budget and one atomic current-only admission.

The fixed attempt2of2 label is removed. Preview uses real variable budget metadata;
the subsequent saved-budget backend integration below resolves the status/discovery
DTO gap. The subsequent saved-budget UI integration below adopts verified/unavailable
budget evidence; legacy missing proof remains honestly unavailable. Deferred2/3/32 helper
and mounted sources cover ordered proof/facts, budget bounds, saved CAS, lost-response
GET-only recovery, canonical discovery and whole-list preparation receipt checks.
No fixture was executed. ff40 audit identity/privacy, called-tree producer, original
owner/deletion fences, current group/lifecycle/UI/client and0035–0040 preserved;
schema files exist and are each registered once in order, never executed.

Remaining: parallel/EXIT/called-tree admission consumer, generations>32/maxAttempts>33,
offset retry restoration/manual recovery, unknown or broader payload/native/provider/
secret/artifact/external-effect families, missing/preupgrade/erased proof and erased
selectable-journal recovery remain held. Runtime owner-tree dependency/Branch Join
is separate. Real package/custody/provider/native/runtime/end-to-end/accessibility/
mobile qualification and full Phase2/Bible acceptance remain open. No retention or
reclamation writer. ZERO tests/checks/build/types/Node/native/browser/runner preparation
or execution, migrations, push/deploy/newworkers; commit hooks disabled. Source and
Git inspection only.


### Saved capture retry budget status integration — source only

Branch df05c945b is assembled as57eab4596 on42a1295d6. Exactly six required
files are physically present and owner-byte-equal: server branch-resource-service,
branch-generation-one-destination doc, agents branch-issued-resource-capture/index,
core branches DTO, and historical-checkpoint-rewind deferred fixture. Only this
coverage file is additional. Parentcbe266387 was already assembled; no ancestor
replay, backend copies or duplicate equivalent changes.

Status and bounded canonical discovery now return retryBudget verified with consumed
attempt count, pinned maxAttempts and evidenceHash, or explicit unavailable with
missing_saved_retry_proof. Verified values also populate optional top-level numbers;
not_found has no budget. The shared DTO reaches existing SDK status/discovery methods.
Reader uses saved review hash/snapshot/continuation, exact binding/configuration,
hash-checked original version definition and exhaustive original retry replay. One
selected original attempt must match resource generation+1 and the pinned retry
policy; mutable active Branch configuration is irrelevant. evidenceHash binds the
entire saved snapshot plus reviewHash. Existing journal read verifies retained
checkpoint seal/source receipt before status. Missing legacy retry proof returns no
numbers; present malformed proof refuses. No fresh preview, new mutation or budget
reset is introduced.

Backend status-budget contract gap is resolved in source. The subsequent UI successor below resolves verified/unavailable budget adoption
and evidenceHash display in source; executed empty-browser UI qualification is
still deferred. Saved-preview budget remains intact. Eligibility
stays one standalone manual serial resource, ASYNC/SYNC generations1–32 with pinned
maxAttempts<=33 and Runtime32-selection/32MiB bounds. No parallel/tree/EXIT/offset
restoration or broader payload authority is added.

Deferred existing2/3/32 ASYNC/SYNC fixture gains saved-key empty-client status,
discovery equality, restart, mutable configuration independence, corrupted original
attempt refusal and explicit legacy unavailable cases; source inspected, unexecuted.
Current UI, historical proof/audit identity/privacy, called-tree producer, original
owner fences and group/lifecycle preserved.0035–0040 physically present/registered
once in order, untouched/unexecuted. Remaining eligibility/proof/payload/recovery and
real package/custody/provider/native/runtime/end-to-end/accessibility/mobile/full
Phase2 qualification limits above remain. No tests/checks/build/types/Node/native/
browser/runner preparation or execution, migrations, push/deploy/newworkers. Commit
hooks disabled; source/files/Git inspection only.


### Verified saved-budget UI adoption — source only

UIcd92e8b06 is assembled as3eb6d8689 on40f4472be, with its five required
deliverables plus this coverage update. BranchGenerationOne.tsx, branchGenerationOne.ts,
branch-generation-history helper/mounted deferred fixtures are owner-byte-equal;
web-feature-completion.md reconciles only additive integration notes and records
already assembled df05c945 backend/core. No ancestor replay, SDK/backend writes or
reference copies. Current writer is Integration on phase2-implementation-integration.

Canonical discovery validates verified retryBudget state, exact matching top-level
consumedAttempts/maxAttempts, generation+1, pinned limit<=33 and evidenceHash shape.
Exact generation, ordered history, review hashes, checkpoint and proof copy into
original-key status GET evidence. Changed cut/list/checkpoint/hash or conflicting
saved-preview budget holds and clears stale discovery for explicit rediscovery.
Verified discovery cannot downgrade to missing/unavailable evidence. Matching verified
status upgrades recovered selection with real budget/proof, retains complete original
preview and reaches existing saved preparation; no fresh preview, POST replay or
retry budget reset. Legacy absent/unavailable proof supplies no inferred numbers;
existing saved original preview numbers remain intact. UI validates proof structure
and equality; backend alone verifies saved snapshot, pinned policy and checkpoint.
Budget proof/hash is visible in discovery and successful capture readback; preparation
retains it beside exact server historicalReviewHash/current cut. Existing full-list
preparation receipt comparison and separate human approve/admit remain unchanged.

Saved-budget backend and UI source gaps are resolved; no executed qualification is
claimed. Deferred helper source covers verified/unavailable/malformed proof, exact
top-level fields, proof/cut/checkpoint/preview-budget drift and downgrade refusal.
Mounted source covers empty-client discovery, changed-proof hold, explicit rediscovery
and exact GET selection for preparation, with no fresh-preview or mutation requests.
Fixtures were read, not executed. Current historical/audit privacy/current maps, tree
producer, owner fences, group/lifecycle/UI preserved.0035–0040 files physically present,
each registered once in order, unchanged/unexecuted. Final task delta six paths.

Eligibility remains one standalone manual serial resource ASYNC/SYNC generations1–32,
maxAttempts<=33 and32-selection/32MiB bounds. Parallel/EXIT/tree admission consumer,
offset restoration/manual recovery, missing/preupgrade/erased proofs/selectable journals
and broader unknown/payload/secret/artifact/native/provider/external-effect families
remain held. Runtime owner-tree dependency/Branch Join stays separate. Real package/
custody/runtime/provider/native/end-to-end/accessibility/mobile and full Phase2/Bible
qualification remain open. ZERO tests/checks/build/types/Node/native/browser/runner
preparation or execution, migrations, push/deploy/newworkers. Hooks disabled; source,
files and Git inspection only.


Local-parallel history source extension: the current bounded contract in [branch-local-parallel-history.md](branch-local-parallel-history.md) supersedes the earlier serial-only limit for exactly one resource invocation with settled local siblings. It reuses the same generation-history producer, parallel replay, current-only cut and canonical single-owner admission; it does not enable arbitrary parallel or called-owner consumers. Source fixtures are deferred and unexecuted.


### Minimal local-parallel history integration — source only

Branchbc524ed30 is assembled ase5e677551 on12b74a079 with its exact ten
required paths, no conflicts or ancestor replay. All ten owner-byte-equal before
this coverage addition: server resource service; generation-one/prior-generation
and new local-parallel docs; coverage; parallel continuation, generation proof,
BranchStore; core branches DTO; historical checkpoint deferred fixture. Current
writer Integration, phase2-implementation-integration.

The SAME parallel frontier/replay codec consumes the existing complete historical
proof through validation-only host union while current selected frontier/host
contain only the actual current resource root. For each old generation, resource
operations/opening bind that generation's original resource, latest exact attempt,
Request/Chat/import result and host root. Failed result uses independently verified
history proof; retry checks original configured policy/delay/timestamps/consumed
attempt budget; resource generation advances only at exact retained retirement audit
prefix. End requires every generation consumed, no pending retry and exhaustive
path/step/attempt/fork/map/join closure. Existing serial paths remain supported.

Eligibility is one standalone manual owner, ONE resource Step invocation, ASYNC/SYNC,
generations1–32, pinned maxAttempts<=33 with32-selection/32MiB limits. Local fork/join
and map are allowed only with settled local siblings without Request roots, no other
active/waiting paths, and actual map item_count exactly1. Multiple resource invocations,
multi-item maps, active sibling effects and called owners remain refused. All earlier
seal/retirement/provider/native/custody/audit/full-envelope/identity-disjointness proof
requirements remain; old/current union never supplies graph/import authority. Existing
all-facts/package review, fresh accepted/budgeted owner and ONE canonical admission,
immutable nondispatchable receipt, rollback and restart readback are reused unchanged.

Server preview and verified saved-budget status/discovery expose historyKind serial
or local_parallel from exact current cut. Existing SDK methods receive shared DTO;
unavailable legacy proof supplies no shape eligibility. The subsequent UI integration below adopts server historyKind in source and
updates deferred fixture contracts. Executed UI qualification remains deferred.

Deferred actual producer-to-destination source now includes ASYNC/SYNC fork and
one-item map generations1/2/32 alongside serial2/3/32. Source includes original provider
exit/seal/cleanup/retirement per generation, current capture, full human review, rollback,
current-only maps, consumed budget exhaustion and restart readback. Missing proof,
stale CAS, omitted/reordered/aliased chain, cross-path resource, prepared sibling,
active ancestor and unknown attempts are refusal cases. Inert provider/native/package
adapters remain; none executed. All current UI, saved-budget adoption, historical/audit
privacy, tree producer, owner fences/group/lifecycle preserved.0035–0040 physically
present and registered once in order, untouched/unexecuted. Final delta ten paths.

Remaining: multi-resource/multi-item/active-host-effects/tree consumer/EXIT/offset
restoration/manual recovery, missing/preupgrade/erased proof/selectable journal and
unknown/broader payload/secret/artifact/native/provider/external-effect families;
Runtime owner-tree dependency/Branch Join separate. Real package/custody/provider/
native/runtime/end-to-end/accessibility/mobile and full Phase2/Bible qualification
remain open. ZERO tests/checks/build/types/Node/native/browser/runner preparation or
execution, migrations, push/deploy/newworkers. Hooks disabled; source/files/Git only.


### Server-classified local-parallel history UI integration — source only

UI5c4accc09 is assembled as9438fbc81 on6c3f9dcfe. All seven required files
physically present/source-read: BranchDisclosureReview.tsx, BranchGenerationOne.tsx,
branchGenerationOne.ts; web-feature-completion.md; generation-history helper/mounted
and generation-one mounted deferred fixtures. Six owner-byte-equal; report reconciles
only additive notes and records already assembled bc524ed backend/core. This coverage
is eighth task path. Current writer Integration, phase2-implementation-integration.
No ancestor replay, reference copies or server/core/SDK changes.

Fresh previews require exact server historyKind serial/local_parallel and persist
complete classification/current cut/ordered history/budget before capture POST.
Discovery and original-key status preserve classification; classified evidence cannot
change or downgrade, and classification without verified saved-budget proof refuses.
Legacy absence stays explicitly unavailable, never inferred from workflow UI or budget.
Exact older commands can adopt server classification only with matching saved cut.
Verified budget/top-level numbers/proof hash, full selected history, current checkpoint
ID/hash and original-key GET/no replay checks remain. Drift clears stale discovery
and holds for explicit rediscovery; legacy saved-preview budget stays intact.

Preparation verifies retained preview/capture pair before enabling, persists it beside
command, and validates it again with original checkpoint/hash/historicalReviewHash and
whole historicalPartition when resolving receipt. historyKind is local evidence only:
existing wire DTO gets no invented classification field. Human full-facts/current maps,
original Project/Request audit-read, private receipt projection and separate approve/
admit remain unchanged. UI explains exact bound: standalone manual one owner/ONE
resource invocation, ASYNC/SYNC generations1–32, serial or server-proved local fork/join
or actual one-item map; settled siblings without Request roots/active effects only.
Pinned maxAttempts<=33 and32-selection/32MiB bounds remain backend authority.

Bounded parallel UI adoption gap is resolved in SOURCE, not qualification. Deferred
fork/join and one-item-map transport cases1/2/32 inspect server classifier persistence,
CAS/save-before-POST, lost response/remount GET, mismatch hold, canonical recovery and
full preparation/readback. UI fork/map cases share local_parallel discriminator;
backend-owned actual workflow fixtures prove shape eligibility separately when run.
Unknown/missing classifications, missing proof, cut/checkpoint/budget conflict and
legacy unavailable cases remain source-covered. None executed.

Preserved all current serial/history/budget/audit privacy/tree producer/owner fences/
group/lifecycle.0035–0040 physically present, registered once in order, unchanged and
unexecuted. Remaining: multi-resource/multi-item/active or unknown siblings/tree
consumer/EXIT/offset restoration/manual recovery; missing/preupgrade/erased proofs/
selectable journals and broader unknown/payload/secret/artifact/native/provider/external
effects remain held. Runtime owner-tree dependency/Branch Join separate. Real package/
custody/provider/native/runtime/end-to-end/accessibility/mobile and full Phase2/Bible
qualification remain open. ZERO tests/checks/build/types/Node/native/browser/runner
preparation or execution, migrations, push/deploy/newworkers. Hooks disabled;
source/files/Git inspection only.


### Runtime remaining implementation disposition — source only

Runtime successor on assembled64d950ad consumes frozen owner-tree5a76a6b0f
without duplicating its authority. Canonical group reserve/stage/review/admit/read,
audit and retirement now validate exact per-owner selected frontier, host,
binding/configuration/member/custody inventory through retainedBranchHostGraph
with destination resources enabled. Explicit source(row,'audit') preserves real
admission identity for immutable historical partition readback and allows missing
live slots; current authority remains required for ordinary paths. Destination
Chat queries use actual branch_execution_id, aliased to the existing local field.
Branch request23446 previously received its canonical terminal committed contract;
its owner-tree dependency is implemented in Runtime source, not still awaiting code.
Branch consumer composition and successful execution remain separate.

One feasible crash gap is implemented: exact-key context-recovery POST replay can
reconcile native_started to context_accepted from the ONE exact already durable
post-completion/post-drain occupancy event. Agent/session/contract/source Run/fence,
command invocation and observed process absence are checked again. Missing or
ambiguous evidence, changed source and existing provider handles refuse. No native
command, source Run/Request settlement or new activation is performed. The original
sourceWork stays held_unknown. GET remains read-only. See
[runtime-native-recovery-contract.md](runtime-native-recovery-contract.md).

Actual unimplemented external integration boundaries remain: Claude structured
retained-session compaction and query/idempotency reconciliation of native outcomes
whose exact durable completion was never recorded. The current integrated Claude
stream transport has user messages, initialization/model control response, steering
and process close; no structured compact/result-query method is implemented. Codex
uses thread/compact/start with empty acknowledgement plus correlated live turn/item
completion and occupancy; the successor below adds known-ID stored completion
readback, while persistent operation-key lookup remains absent.
RuntimeSession likewise exposes no such native query. This is evidence about the
current integrated interfaces, not a claim about every vendor release. Inventing a
control subtype, substituting /compact command input under the no-prompt constraint,
reading arbitrary session files,
or treating thread resume/process exit as completion would not implement that
contract. Source-turn unknown effects therefore remain held. No provider execution
or external contract probe was performed.

Deferred fixtures cover per-owner evidence and exact durable completion readback;
full testing remains after implementation. No tests/checks/build/types/Node/native/
browser/preparation/execution/migrations/push/deploy/new workers were performed.


Integration: Runtime chain2f8893bd7→8700860c9 is assembled asc86f3fbe1→f11ed8f5b
on64d950ad4. Actual direct ancestry verified; frozen5a76 helper compared exact and
not separately replayed. Ten required paths physically inventoried/source-read and
owner-byte-equal before this coverage note; no conflicts or reference copies. Writer
Integration on phase2-implementation-integration. Existing Branch history/UI, ff40
real-ID source(row,'audit'), admitted missing-slot handling and bounded private-byte
historical projection remain. Actual conversations.branch_execution_id is used;
surviving owner Chat/execution Branch identities are checked per original owner.
The owner-tree Runtime contract is now assembled, superseding earlier pending-Runtime
code statements; atomic Branch tree admission consumer remains separate owner work.

Recorded-completion reconciliation grants no new source authority: only exact-key idle
POST replay, native_started phase, unchanged Agent/session/contract/Project/source
Run/scope/fence and no provider authority can accept exactly ONE existing context_usage
event matching compact invocation/execution/fence and both session fields. Existing
acceptance validates exact nonnegative occupancy/window/event sequence. No native
invocation, activation, source settlement or effect replay occurs; sourceWork remains
held_unknown. Missing event stays held; ambiguity/changed source/invalid usage refuse.
GET unchanged. Durable event writer and prior completion/drain chain source inspected.

Deferred owner-tree evidence and recovery reopen/idempotency/fence/no-native fixtures
read only. Claude structured retained-session compact and native unrecorded-outcome
query/idempotency integrations remain missing in current interfaces; host recorded-
event correction does not implement either. No universal vendor capability claim.
Other tree consumer/history/payload/recovery limits and real provider/package/native/
custody/runtime/end-to-end/accessibility/mobile/full Phase2 qualification remain open.
All0035–0040 files physically present, registered once in order, unchanged/unexecuted.
Final task delta exactly ten paths. ZERO tests/checks/build/types/Node/native/browser/
runner preparation or execution, migrations, push/deploy/newworkers. Hooks disabled;
source/files/Git inspection only.


### Prospective group audit journal retention (source only)

Final canonical Branch owner deletion now publishes exact original selectable group capture/destination journals and abandonment dispositions into existing immutable host lifecycle receipts in the same transaction before command removal. Operator discovery/audit reads current or validated retained originals without reconstructing IDs/commands/owners or granting authority. Original key, input hash, private bytes and timestamp survive; conflicts, corruption, unknown evidence and bounds refuse. Live mutation/disclosure/admission and deletion readiness checks remain unchanged. Existing historical-partition audit projection stays metadata-only. Deferred source covers canonical deletion/rollback/reopen plus capture/destination readback, held imports and immutable conflicts; none ran. Earlier erased-selectable-journal statements remain true for pre-retention deletions, but prospective preservation is now implemented. No migration, package/sourcebytes/history reclamation, external-writer reconciliation or native/provider qualification is supplied.

Integration: selectable-journal retention e68dedeed is assembled as fdd227157 on
f7d30f17b, preserving assembled Runtime owner-tree and recorded-completion fixes.
Actual parent64d950ad4 already assembled; only the requested delta was applied.
All eleven required paths physically inventoried/source-read; ten owner-byte-equal,
with the sole coverage conflict resolved by preserving both additive sections.
Writer Integration on phase2-implementation-integration; final task delta eleven paths.

Source inspection confirms retention within final deleteBranch unitTransaction,
after existing readiness checks and before deletion mutations. Exact original key,
input hash, private result_json bytes and created_at are retained per execution in
immutable host lifecycle receipts; retention or later deletion failure rolls back
both. Audit-only lookup/discovery verify receipt scope/hash/canonical bytes and live
agreement, deduplicate execution/key and bind cursors to inventory revision. Existing
capture/admission/custody readers validate original evidence; ordinary action paths
keep live-owner reads. No command reinsertion, authority fallback, owner restoration
or private historical seal projection is added. Unknown states remain held.

Prospective erased-selectable-journal gap is resolved in source only for these new
canonical deletions. Already erased records without receipts remain unsupported.
Bounds refuse, never truncate: 16 MiB per command, 4096 commands per execution and
4096 owners per deletion, 64 MiB deletion/receipt and combined discovery evidence;
discovery also caps selected journals and retained manifests at 4096 each. Existing
Branch deletion guards, tree custody journals and precleanup remain. No SDK/UI,
Runtime, db/schema or migration delta;0035–0040 physically present, registered once
in order and unchanged/unexecuted. Deferred deletion/rollback/reopen, exact bytes,
conflict/corruption, held imports and privacy fixtures read only.

Remaining: old erased/missing/preupgrade proofs, atomic called-tree admission
consumer, multi-resource/multi-item/active or unknown sibling history, EXIT, offset
restoration/manual recovery and broader payload/secret/artifact/native/provider/
external-effect families. Existing bounded serial/local-parallel history eligibility
is unchanged. Claude structured retained-session compact and native unrecorded-result
query/idempotency remain unimplemented in current integrated interfaces. Real package/
custody/provider/native/crash/runtime/end-to-end/accessibility/mobile and full Phase2/
Bible qualification remain open. No reclamation writer or external reconciliation.
ZERO tests/checks/build/types/Node/native/browser/runner preparation or execution,
migrations, push/deploy/newworkers. Hooks disabled; source/files/Git inspection only.


Runtime official-native-contract successor: existing Codex invokeCommand compact
now performs bounded stored-history completion readback for an already observed
exact native turn/item pair through official thread/read and thread/turns/list.
It never retries native mutation or infers fresh occupancy/source effects. Missing
operation IDs and unsupported history remain held. Claude official documentation
DOES support retained-session /compact command input and structured result/boundary
observations plus a separate occupancy control; no dedicated structured compact
control was established. The current no-prompt recovery constraint leaves that
adapter unsupported. See runtime-native-recovery-contract.md for pinned official
protocol sources, exact limits and minimal upstream requirements. No tests/checks/
build/types/Node/native/browser/preparation/execution/push/deploy were performed;
whole implementation and qualification remain incomplete.

Integration: official-native-contract successor0dc8e232d assembled asd1571b5db on
d0bf77caf, retaining Runtime870 and prospective selectable-journal retention. Actual
parent8700860c was already assembled/equivalent on all three non-coverage paths;
no ancestor replay. All FOUR required files physically inventoried/source-read;
engine, recovery contract and deferred fixture owner-byte-equal. Only additive
coverage conflict merged both prior integration notes and successor. Final delta
exactly four paths; writer Integration on phase2-implementation-integration.

Actual source requires accepted compact acknowledgement plus observed exact native
turn/item identities. Five seconds are reserved within the existing45-second
invokeCommand budget for thread/read session binding then thread/turns/list full
items, at most four100-turn pages. One matching completed/error-free full turn and
one exact contextCompaction item confirm completion. Foreign session, substitutions,
duplicates in selected turn/item evidence, missing IDs, bad/repeated cursors,
unsupported protocol and timeout remain unknown. No latest/newest guessed identity,
mutating RPC retry, occupancy synthesis or source-effect settlement is introduced.
The read helper does not mutate the operation; its caller only records confirmed
completion. Existing fresh telemetry, recovery acceptance/fence and observed drain
requirements remain. Deferred exact identity/session/pagination/refusal fixture
source inspected only; no live protocol or installed-version qualification.

This narrows earlier missing native-result-query statements: a lost completion
notification with BOTH original IDs still present can now use stored completion
proof. Lost acknowledgement/no IDs, durable operation-key/idempotency lookup across
crashes and original source-effect queries remain unimplemented. Claude documented
native command transport is distinct from current no-prompt recovery scope; structured
compact remains unsupported under that constraint. No universal vendor absence claim.
All current Branch history/UI, audit privacy, owner-tree/runtime event recovery,
retention/deletion/tree guards and lifecycle source preserved; no server/core/SDK/
db/schema changes.0035–0040 physically present, registered once in order, unchanged
and unexecuted. Existing tree consumer/history/offset/payload/erased-proof limits
remain; real package/custody/provider/native/crash/runtime/end-to-end/accessibility/
mobile/full Phase2/Bible qualification is open. ZERO tests/checks/build/types/Node/
native/browser/runner preparation or execution, migrations, push/deploy/newworkers.
Hooks disabled; source/files/Git inspection only.

The [issued owner-tree destination contract](branch-issued-owner-tree-destination.md) now connects the preserved bounded parent/called-child producer to one canonical group destination admission and per-owner checkpoints. It also adds exact mapped item identities for 2–32 generation-zero map resources. This supersedes the earlier blanket called-consumer refusal for this precise source bound. Broader called/multi-resource historical families remain refused; no tests or execution were performed.

Integration: bounded owner-tree consumer47ec3a1e8 assembled as73b15bf1a on
bb3b8dda1. Actual parent760bba9 Runtime per-owner contract is already assembled
through870; its two branch_execution_id SQL aliases already match this successor.
ONLY requested own delta applied, no ancestor replay or broad reference copies.
Sixteen own and nineteen cumulative paths physically inventoried/source-read;
twelve cumulative paths owner-byte-equal. Seven composed paths retain existing
journal retention/discovery/fixtures and coverage notes. Final task delta fifteen
paths because Runtime alias changes were already present. Writer Integration on
phase2-implementation-integration. Core group client adds only optional scope and
ownerMap fields; current UI/SDK methods and existing additive contracts preserved.

Actual source bound: manual parent plus ONE called child, each ONE gen0 resource,
serial ASYNC/SYNC frontiers. Original owner-specific selected/binding/configuration/
host/member/package proofs remain mandatory. Both sources settle/retire before
preparation; every original Project participates in human audit-read checks. Fresh
accepted parent/manual and child/call owners have individual capability/capacity/
budget checks, own engine bindings and own Chats. Child input/provenance binds mapped
parent attempt; actual parent_attempt_id FK attaches only after parent frontier
insertion inside final admission. N import finish wrappers enclose ONE canonical
group admit, current-only per-owner frontier/resource/Request composition and final
per-owner checkpoints; receipt readback checks exact owner maps/checkpoints/ancestry.
Deferred rollback/restart/child-policy/all-facts fixtures read only. Standalone
2–32 resource gen0 map items now use mappedMapId:itemIndex, preserving original
indices/path/join closure; deferred ASYNC/SYNC2/3/32 source inspected only.

Preserved e68 prospective journal retention/current discovery, ff40 real audit
identity and metadata-only historical private projection, Runtime owner-tree/event
recovery and known-ID Codex stored completion, current history/budget UI, conservative
tree deletion guard and lifecycle.0035–0040 physically present, registered once in
order, unchanged/unexecuted. Merge-resolution trailing-content mistake was caught
in Git review and corrected from exact three-way inputs before final handoff.

Specific remaining source fixture debt: tests/organizations/group-journal-audit.test.mjs
admission mocks provide no coordination_destination_admissions/retirements snapshot
scope, now read directly by the stronger owner-scope audit validator. Those deferred
mock fixtures need owner reconciliation before execution; no production scope check
was weakened and no test outcome is claimed. Web tree adoption, broader called trees,
parallel/EXIT called frontiers, per-called-owner multiple resources/retry history,
standalone multi-resource/multi-item retry history, offset restoration/manual recovery,
missing/preupgrade/already erased proofs and broader payload/secret/artifact/native/
provider/external-effect families remain unsupported. Native lost-ack/no-ID/durable
operation-key/source-effect query and Claude no-prompt structured compact gaps remain.
Real package/custody/provider/native/crash/runtime/end-to-end/accessibility/mobile/full
Phase2/Bible qualification is open. ZERO tests/checks/build/types/Node/native/browser/
runner preparation or execution, migrations, push/deploy/newworkers. Hooks disabled;
source/files/Git inspection only.

## Full Bible / Build remaining implementation reconciliation

Current requirement-by-requirement disposition is now
[phase2-remaining-implementation.md](phase2-remaining-implementation.md), against
assembled391d682c0 and the full published Bible2. It accounts for32 commandments
and all3 Build features with24 explicit Build behavior rows. Finite remaining
inventory:6 concrete code/documentation items,6 unresolved contract/scope entries;
1 separate deferred-fixture source repair. These are not12 proven required new
features or a closed defect universe. Deferred verification is entirely separate.
This pointer supersedes older blanket remaining-category counts; bounded source
presence supplies no whole-Bible verdict. No product code or owner worktree changed;
no tests/checks/build/types/Node/native/browser/preparation/execution/newworkers.
