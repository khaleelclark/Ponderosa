# Phase 2 remaining implementation inventory

Source snapshot: `f2b05c5584a947f9ee03214d983093cea1367064`, integration worktree.
Includes bounded called-owner-tree UI and correlated Claude native command recovery;
M1, M5 and M6 are resolved in source, with runtime qualification deferred.
Basis: full `/tmp/ponderosa-phase2-upgrade-c8ace/published/bible-2.md`, all 32
commandments, verification/Phase 2 instructions and all Build-list text. Source/document reconciliation; current guides and coverage are maintained together.
No owner worktrees changed, no workers created, no execution or preparation.

**No: the earlier four categories were not four final tasks.** This inventory
accounts for all 35 top-level requirements (32 commandments + 3 Build features),
with 24 explicit Build behavior rows below. It identifies **9 remaining source
work/disposition entries: 3 concrete implementation/contract items and 6
unresolved contract/scope items**, plus **1 separate deferred-fixture source repair**.
These are finite inventory counts, not acceptance percentages or a promise that
future verification cannot discover another defect. Unresolved does not mean code
must be invented: disposition may establish an existing implementation or a
justified limit. No whole-commandment True verdict follows from source presence.

## Single remaining implementation/disposition checklist

Owners are the existing Phase 2 Runtime, Features (Branches), Reliability and UI
Agents; Integration owns assembled docs. Cliff resolves scope across owners.

| ID / state | Exact requirement | Concrete user behavior missing or unresolved; implemented boundary | Owner | Dependency |
| --- | --- | --- | --- | --- |
| M2 — missing code/contract | #1, #4, #12 crash survival | Recover a compaction whose acknowledgement/operation identities were lost, without repeating mutation. Codex now reads stored completion only for an accepted operation with both already observed turn/item IDs; durable caller-key lookup/idempotency across crashes is absent. | Runtime | External exact-session operation-key/result contract plus internal durable binding. Existing host durable-event reconciliation covers a different, already-recorded event gap. |
| M3 — missing code/contract | #12 work survives restart; #13 unfinished work retained; #17 reliability | Resolve original uncertain source Run/tool/publication effects from exact original receipts instead of leaving source work indefinitely unknown. Context completion does not settle those effects; sourceWork remains held_unknown. | Runtime + Reliability | External/native result evidence where no host receipt exists, then canonical internal per-effect reconciliation. Never infer success from process exit or repeat effects. |
| M4 — missing review display contract | #2 inspectable mechanisms, #3 clear controls, #24 accurate figures, #28/#32 checkpoint/subgraph review | Bounded tree web preview/capture/discovery/prepare/all-facts choice/admit/recovery is integrated. Actual DTO omits Call parentAttemptId, Branch idMap/counters and numeric fresh per-owner acceptance budgets; UI labels them unavailable/server-verified. Expose the appropriate nonsecret review evidence and render exact returned values. Backend already validates ancestry, mapped frontier and each fresh budget; do not invent values or expose private saved snapshots. | Features + Runtime DTO; UI rendering | Internal additive review/readback contract. These fields explain the already implemented mapped destination and acceptance; this does not require broader tree eligibility. |
| U1 — unresolved source disposition | #4 **every** native harness capability | Exhaustive provider capability inventory has no established complete mapping to the inspected implementation. Browser/native tools and capability discovery exist; the identified compact gaps are not proof that they are the only parity gaps. | Runtime | Internal mapping against pinned official harness surfaces; provider compatibility execution separate. Do not create features from vague parity language without identifying the native capability. |
| U2 — unresolved limit disposition | #5 no unjustified rules, #6 human-only access, #32 human-set limits | Determine which hard bounds are stability/byte bounds and which constrain user capability without the required justification/control. Generation32/maxAttempts33, group32 and evidence-size caps are explicit; the Bible permits documented stability limits, so increasing every cap is not automatically required work. | Features + Runtime; Cliff scope | Internal limit-purpose/access classification, then code only for a demonstrated violation. This is not a request to implement arbitrary combinations. |
| U3 — unresolved portability scope | #8 everything needed to recreate Agent/org/workflow, excluding known secrets | Complete package/file semantics beyond current regular-file/new-managed-root transport: symlink/special/hardlink topology and native/Git ownership are refused/excluded. Shared/Separate roots, independent same-Chat roots, authored history, artifacts, memory and reviewed access suggestions already have source. Cross-Chat relocation of an existing Agent is not itself required by export/import and is not counted as a new feature. | Reliability + Features; Cliff scope | Internal field/topology inventory and explicit recreation semantics. If a refusal loses required nonsecret data, implement transport or record an approved exception; no arbitrary shell-writer guarantee is assumed. |
| U4 — unresolved checkpoint scope | #8 workflow with data; #32 named checkpoints/rewind/subgraphs/multi-agent | Decide required recreation/rewind behavior for currently refused families: changed/secret bindings, cancellation/recovery/budget-held cuts, forwarded bundles, richer package memory/artifacts/working roots/restrictions, and multi-resource/called retry histories. Current source supports bounded Script/Request/tree cuts, standalone gen0 groups/maps, standalone one-resource serial/local-parallel history1–32, and the exact parent/child gen0 consumer. These refusals are **not** individually counted as mandatory new combinations. | Features + Runtime + Reliability | Internal capability contract against pinned checklist; some proofs require M2/M3 and current package/policy composition. Missing/preupgrade/erased evidence cannot be fabricated; restoring an already-restored owner with an offset is not established. |
| U5 — unresolved reconciliation scope | #12 no silent data loss; #15 files; #30 memory | Define terminal user recovery for legacy remote-memory holds lacking effect metadata and independently unresolved external writes. Evidence-bearing preserve-current memory reconciliation, package/import journals, abandonment/retirement and prospective group-journal retention exist; old erased evidence and nonparticipating shell/native writers do not become proven by these mechanisms. | Reliability + Runtime | External backend effect evidence where available; internal explicit disposition otherwise. No automatic retry, cascade retirement or blanket disk reclamation is a Bible requirement. |
| U6 — unresolved state semantics | #32 pinned named **state** capability | Establish whether execution input/parameters, immutable Step results and ordered bundles satisfy the required pinned state capability. Representative source does not implement arbitrary mutable shared/reducer state. No accepted state-semantics disposition establishes whether another operation is required. | Features; Cliff scope | Internal comparison of exact named state operations with LangGraph1.0.5/LangChain1.0.8 baseline. Transitive/model pins and running examples are verification prerequisites, not proof of missing product code. |

M1 is resolved in source by correlated Claude native command completion plus fresh
occupancy control; provider/runtime compatibility remains unqualified. M2/M3 remain
different observable behaviors: compaction does not resolve lost identity or source effects.
M5 concise copy/evidence-row cleanup is resolved in source; see phase2-ui-copy-census.md.
Rendered wrapping/accessibility/mobile and whole #29 judging remain deferred.
M4 now concerns missing review evidence fields, not tree control adoption. M6 (current documentation correction) is resolved by the current coverage/framework/guide rewrite; historical snapshots are separate. M4 does not broaden backend eligibility. U2/U4 prevent turning every documented
unsupported permutation into invented scope. Unknown proof remains held visibly.

## All 32 commandments accounted for

S = source anchors physically present and relevant implementation/source excerpts
inspected; **no additional missing code established by this bounded reconciliation**.
M/U link to the finite checklist. A = aggregate criterion, not another implementation.
S is not “fully implemented” and is not an execution verdict. For broad universal
criteria, a complete audit may still find concrete missing code.

| # | Disposition | Current source evidence / exact remaining boundary |
| --- | --- | --- |
| 1 | M2/M3 | `packages/agents/src/coordination-v3-context-recovery-authority.ts`, `packages/engines/src/codex-app-server.ts`, `packages/engines/src/claude.ts`; Claude correlated native compact/fresh usage and durable known-event recovery exist; lost native identities/source effects remain unknown. |
| 2 | S | Canonical admission/context authority modules and adjacent docs; whole mechanism/run-history correspondence still unverified. |
| 3 | S + M4 | Shared `OutputAgentApp.tsx`, `BranchGroupReview.tsx`, `BranchGenerationOne.tsx`; desktop/mobile comparative quality is verification. |
| 4 | M2 + U1 | Native adapters include Claude native compact with fresh usage and Codex exact known-ID reads; `runtime-native-recovery-contract.md`; complete parity U1 remains unestablished. |
| 5 | S + U2 | `server-request-hooks.ts` separates capacity admission from authority; explicit codec/byte limits need complete purpose classification. |
| 6 | S + U2 | `capability-policy-store.ts`, `runtime-capability-policy.ts`, human import/disclosure review; read-only audit did not establish another automatic grant change. |
| 7 | S | `server-request-hooks.ts` admits ordinary operator calls without an operator token; native account login and scoped Agent capabilities have separate domain roles. Origin checks allowed. |
| 8 | S + U3/U4 | `compose-agent-packages.ts`, `portable-working-files.ts`, `routes/agent-packages.ts`, `branch-store.ts`; broad recreation semantics remain unresolved. |
| 9 | S | Shared package composer, canonical graph writer and shared UI; dead-code/duplication scans and review are verification, not invented refactor work. |
| 10 | S | `packages/core/src/branches.ts`, `branch-group-client.ts`, `examples/branches-client/client.ts`; outside HTTP-only execution deferred. |
| 11 | S | Canonical reply/publication and scoped protocol; sampled log/token judging deferred. No “four categories” answer substitutes for this inventory. |
| 12 | S + M2/M3/U5 | Lifecycle journals, exact receipts, `branch-group-journal-retention.ts`, `local-memory.ts`; durable holds preserve uncertainty, not successful recovery. |
| 13 | S + M3 | Current context fences/recovery authority and existing Run controls; state-by-state steering execution deferred. |
| 14 | S | Explicit provider errors/unconfirmed recovery and shared UI errors; induced failure/clarity trials deferred. |
| 15 | S + U5 | `empty-tombstone.ts` unlinks marker and nonrecursive rmdir; `portable-working-files.ts` retains displaced/import bytes. Race/folder equivalence trials deferred. |
| 16 | S | `branch-trigger-service.ts`, `branch-trigger-store.ts`; occurrence keys/catch-up source present, clock/timing trials deferred. |
| 17 | S + F1 below | `state-admission.ts`, `db.ts`, additive0035–0040 registered once; existing deferred fixture source mismatch is concrete, repeated suites/upgrades unrun. |
| 18 | S | `notification-routing.ts`, `notificationActiveView.tsx`, Assistant report cursor; burst/default-settings trials deferred. |
| 19 | S | Canonical audit receipts, `group-journal-audit.ts`, activity/UI projections; random action trails/redaction/log judging deferred. |
| 20 | S | Same origin/domain authority disposition as #7; no new token-gate deletion justified by inspected source. |
| 21 | S | `useAgentStream.ts`, `useWorkspaceStream.ts`, streamed/virtualized UI; historical failed timing remains unresolved evidence, not proof a particular optimization is missing. |
| 22 | S | `docs/installation-checks.md`, `docs/user-guide.md`, `AssistantEntry.tsx`; fresh-install timed walkthrough deferred. |
| 23 | S | Current coverage/framework/guides reconciled; historical snapshots separated. Public-guide behavior execution deferred. |
| 24 | S | Verified saved retry budget/hash UI and exact usage/billing source; numeric traces deferred. |
| 25 | S | `packages/engines/src/auth.ts`, `routes/engines.ts`, human provider/model settings; both billing modes/state-preserving switch execution deferred. |
| 26 | S | Shared confirmation/chat/settings components; complete pattern review deferred. |
| 27 | S | `TextSizeSetting.tsx`, shared themes/dialog labels; keyboard/reader/contrast/critical-accessibility trials deferred. |
| 28 | A | All rows apply to Branches too. No separate magic implementation closes this aggregate criterion. |
| 29 | S | M5 concise copy/evidence-row successor integrated; exact content and consequential consent retained. Blind panel, rendered layout and flicker/overlap evidence remain separate. |
| 30 | S + U5 | `local-memory-catalog.ts` explicitly defaults search across authorized chat/global; `local-memory.ts` preserves human settings. Seeded recall/log misuse trials deferred. |
| 31 | S | `reply-stream-publication.ts`, `voice-reply-stream.ts`, `speech/voiceReplyStream.ts`, `BranchLiveOutput.tsx`, shared Request/Chat streams; early acknowledgement/answer separation exists. All-surface recording and <1s average/never>2s call result unqualified. |
| 32 | S + M4/U2/U4/U6 | Public graph/HITL/tools/memory/subgraph/multi-agent source and representative application/comparator present. Broader feature contract remains unresolved; no parity verdict. |

## Every Build behavior accounted for

All rows inherit #29/#31 verification; no stripped Output/Assistant shell is
assumed from the absence of a dedicated implementation for each shared behavior.

| ID | Required behavior | Source disposition / anchor |
| --- | --- | --- |
| O1 | One or more output designations | S: `output-agent-apps.ts`, `OutputAgentDesignation.tsx`. |
| O2 | Stable own URL without opening Branches | S: `/apps/<agent-id>` / `OutputAgentApp.tsx`. |
| O3 | Direct output-Agent conversation with workflow behind it | S: standalone shell mounts canonical `BranchChats`; no second message store. |
| O4 | Attachments | S: shared chat upload/attachment path inherited by standalone BranchChats; reload/media acceptance unverified. |
| O5 | Voice messages | S: shared `VoiceMessageRecorder.tsx`, audio attachment admission; microphone/playback unverified. |
| O6 | Phone calls/iOS phone feel | S: shared `speech/VoiceConversation.tsx` and voice stream; latency/polish unverified. |
| O7 | Simple automatic on/off and frequency settings reach workflow | S: Output Settings schedule PUT with expected version/settings revision; event schedules explicitly redirect to More options. |
| O8 | Model setting reaches bound Agent | S: Output Settings `realApi.updateAgent(activeEngine,model)`; identity/history not replaced by this control. |
| O9 | More options opens owning workflow | S: explicit Branch workflow URL in Output Settings. |
| O10 | iOS Messages quality, no paragraphs, streaming | S plus verification: same shared shell/streams and concise-copy successor; no visual or stream acceptance claimed. |
| A1 | Named Assistant, automatic organization, preferred-model default | S: `AssistantEntry.tsx` POST initialization and `output-agent-apps.ts` resumable setup pins saved model/effort. |
| A2 | Create Chat on request | S: `routes/agent-workspace.ts` canonical managed Chat action/receipt. |
| A3 | Start work across Projects within human access | S: same route resolves current source/destination policy and canonical Request/scheduler work. |
| A4 | Default10-minute check reports finished work/issues | S: actual scheduled default Step invokes assistant check; check reads explicit terminal task results/issues, not successful Run inference. |
| A5 | User-configurable interval | S: shared Output Settings updates real workflow trigger. |
| A6 | Reports obey notifications/no flood | S: durable source cursor/cadence + notification routing; quiet burst/dedup execution deferred. |
| A7 | Same attachments/voice/calls UI inside Ponderosa | S: `/assistant` uses same OutputAgentApp/BranchChats. |
| A8 | Exactly one speaker, movable to another workflow | S: singleton preference and `moveSpeaker(expectedSpeakerId)` route; concurrency execution deferred. |
| A9 | Freely edit Assistant workflow | S: existing Branch editor via More options; it is not replaced by a separate Assistant engine. |
| A10 | Model/prompt edits retain role; unavailable-model ordinary switch | S: role stored independently; ordinary shared provider/model controls. No special identity reset path added. |
| A11 | Delete/remove role disables, Settings says disabled | S: role status + `AssistantEntry.tsx`/Output settings disabled state; ordinary initialization does not recreate removed speaker. |
| A12 | Explicit enable creates fresh defaults only when absent | S: canonical initialize(force)/status/setup path, existing speaker prevents second creation. |
| A13 | Imported speaker collision dialog disables imported role | S: `portable-output-roles.ts`, output role review/epoch checks and package import review. |
| I1 | Rename Messages across Ponderosa to Inbox in UI/docs/code | S: `InboxView.tsx`, `ProjectNavigation.tsx`, Inbox API/internal symbols; scoped search found no old label in web source/current user guide. `/messages` and persisted draft/index IDs intentionally retained. Compatibility-key renaming is not required; current guide reconciliation is documented separately. |

## Verification kept separate

**F1 — one known fixture-source repair, owner Features + Reliability, internal:**
`tests/organizations/group-journal-audit.test.mjs` admission mocks do not create
`coordination_destination_admissions`/`coordination_destination_retirements` retained
snapshot scope now directly queried by `group-journal-audit.ts`. Reconcile mocks
with the stronger owner-scope contract; do not weaken production validation.
This is not an observed failing test: nothing ran. It is not a new user feature.

All Bible execution gates remain deferred: repeated core/upgrade/crash trials;
provider capabilities and subscription/API mode trials; export/fresh import data
equivalence; trigger clock/timing; quiet notifications; memory seeded recall and
misuse review; external-engine/comparator runs; whole-surface streaming/calls;
accessibility/keyboard/reader/font/theme; desktop/mobile load profile, comparative
blind panels and recordings; documentation behavior audit. Human-only account
steps, if actually unavailable, are handed off separately; emulators qualify.
Nothing here prepares or executes those gates, and no previous run qualifies this
snapshot. Compilation/type compatibility likewise remains untested, not silently
included in the missing-product-code count.

## Inspection record and limits

Read full Bible and current coverage/feature/portability/framework/output/Assistant/
native/UI acceptance docs, then actual source for native compact/readback, context
holds, group/tree consumer/map identities, disclosure/audit/retention, Output setup
and Settings, workspace actions/reports, shared streaming/voice, memory schema/
reconciliation, auth/billing, file cleanup/transport and representative app. Exact
source anchor paths in the tables were physically inventoried; earlier integration
physically reviewed the full19 tree-consumer deliverables. Source presence alone
is never labeled whole implementation. Current-head source was preserved; active
owner work remains outside this snapshot until separately handed off/integrated.

This is exhaustive **requirement accounting**, not an exhaustive proof that there
are only three concrete gaps in a large codebase. The bounded read cannot close U1–U6 or
unrun universal criteria. Cliff should assign each numbered entry or resolve its
scope; “four categories left” and “all implemented” would both overstate evidence.
