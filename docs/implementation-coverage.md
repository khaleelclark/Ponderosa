# Current implementation coverage and backlog

Source-only inventory includes Branch8ccf446bb, Runtime publication7bc728008,
retirement9edf00516 and memory exposure13bf72442, plus sole UI-owner2c7db556e. Integration owns
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
| 8 | Shared full package composer, independent reporting forests, working files/roots, authored history, memory, roles/settings and retained custody source assembled. Existing-Agent regrouping and broad workflow restoration families remain gaps. | Reliability/Features; fresh-instance equivalence deferred. |
| 9 | Shared DTOs/composer/dialogs and canonical graph writer retained; no broad dead-code verdict. | All; dead-code/duplication analysis deferred. |
| 10 | Public Branch routes/SDK and standalone examples/branches-client/client.ts present. | Features/Integration; external-client execution deferred. |
| 11 | Canonical scoped asks/results and artifact references remain the communication path. | Runtime; token/log efficiency judging deferred. |
| 12 | Durable journals/outbox/receipts and retained custody; unknown effects stay held. Broader crash/external-writer reconciliation and orphan reclamation remain gaps. | Reliability/Runtime/Features; crash trials deferred. |
| 13 | Steering/fences/pause/review controls assembled; held destinations do not silently reimport or release. | Runtime/UI; state-specific steering trials deferred. |
| 14 | Provider errors, explicit unconfirmed outcomes and recovery surfaces assembled. | Runtime/UI; backoff/failure delivery trials deferred. |
| 15 | Marker-only unlink and nonrecursive tombstone cleanup preserve unexpected user content; private custody is independent. | Reliability; racing-file/deletion trials deferred. |
| 16 | Trigger schedules/conditions/occurrence identity source assembled. | Features; timing/clock-change trials deferred. |
| 17 | Exact additive predecessor fixtures and migrations0035/0036/0037/0038 retained once each. | Runtime/Reliability; upgrade/reliability runs deferred. |
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
| 30 | Unified local-memory search/settings and portable memory source assembled. Failed/unknown remote mutation holds have no automatic reconciliation/reclamation. | Runtime/Reliability/Features; backend permission/search trials deferred. |
| 31 | Runtime adds explicit document/mixed-route/attached-Request final generation through canonical publication, and native-receipt-qualified early voice acknowledgement. Separate UI acknowledgement/answer buffers and exact private Request previews are assembled with validated Request memory exposure; see runtime-publication-and-voice.md. | Runtime/UI; source only, native/UI execution and latency/recordings deferred. |
| 32 | Parallel/control, persistent issued graph/tree/recapture, pre-opening resource rewind, bounded fresh issued-resource destination and review UI assembled. See exact scope and missing-code list below. | Features/Runtime/UI; framework equivalence and all execution deferred. |

## Current bounded issued-resource source

Seven actual Branch commits integrated in ancestry order: d1e79d107,ea3d6fa37,
e5a6fee0f,778a001d3,fd8a55e63,d39f40f80,6b7f18a4a. UI00c62faa1 is the sole
UI-owner successor to already integrateda1da73c5. No old dependency merge replay.
Branch8ccf446bb extends local parallel replay; UI2c7db556e adds publication/voice consumers.
Runtime staging/authority, retirement and migrations0035–0038/custody retained.

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

## Actual missing implementation / owner requirements

Lifecycle successor source adds operator package/import evidence reconciliation and
explicit evidence-bearing remote-memory hold reconciliation, with preserved originals,
fresh CAS/drain checks and no unknown-write replay. See
[lifecycle-reconciliation.md](lifecycle-reconciliation.md) for endpoints/DTOs and limits.
Legacy memory holds without effect metadata remain held. Existing same-Chat reporting
regrouping already has a canonical operator endpoint; cross-Chat/root relocation remains
unsupported. Runtime staged-destination retirement is integrated with immutable
tombstones, review CAS and independent identity/import refusals. Operator route wiring
still requires Features current owner/reference and observed-drain authority; no
ordinary operator assertion can replace that proof. Existing pins remain enforced.

- Features + Runtime: broader issued-resource/tree/multi-resource/later-generation
  consumers and atomic Runtime group destination API (no independent-loop substitute); changed/secret bindings; recovery/exhausted-budget frontiers; Agent/child
  cancellation and cross-owner forwarded bundles. Keep unsupported families refused.
- Runtime staged retirement boundary is assembled: reviewed hash CAS, synchronous
  approval/evidence recheck, immutable receipt/tombstone and optional proven-safe source-pin
  release for unadmitted destinations only. Retired identities stay held; admitted
  provenance cannot retire. See coordination-destination-reconciliation.md.
- Features + Reliability still must implement exhaustive current owner/capture/restore/package
  reference and observed-exit/resolved-outcome evidence, deleted-owner authority, durable
  human review and operator routes. Abandoned owner references require explicit reconciliation;
  unknown import/effect outcomes remain held. Retaining pins has no later release upgrade
  in this slice. This host boundary alone is not end-to-end lifecycle reclamation.
- Features + Reliability: artifact/memory/working-copy/source-restriction/elevated-grant
  support in the new issued destination consumer; its current narrower refusal is explicit.
  Old metadata-only cuts cannot reconstruct purged private bytes.
- Runtime: native lost-outcome result-query/idempotency, Claude structured compaction,
  source-turn reconciliation remain external-contract gaps. Explicit selected
  document/mixed-route/Request generation and early native voice receipt source
  and UI consumers now exist; native/browser execution remains deferred.
- Reliability + UI: existing-Agent regrouping; broader external-writer/remote-memory
  failed-hold reconciliation. Arbitrary shell/native/user-folder writers are outside the
  participating source-boundary guarantee.
- Features: comparator version pins and matched equivalence dispositions remain missing.
  Nine capability source dispositions and a public-client research/critique/subgraph/human
  review example now exist in branches-framework-capabilities.md and
  examples/branches-capabilities; neither establishes LangGraph/LangChain parity.
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
Deferred regression sources were integrated, not passed. Required future evidence
includes package fresh-instance equivalence, canonical rollback/crash/lost-response,
source-boundary/concurrency, destination authorization/lifecycle, provider parity,
upgrade/reliability runs, all Build flows, desktop/mobile/accessibility and measured
performance. Historical LCP failure remains unresolved. None of all32, #8, #12,
#32, Build, full UI, Bible or Phase2 is accepted by this inventory.

