# Current implementation coverage and backlog

Source-only inventory includes Branch1aa09968 (2–32 serial/local-parallel resources; c462d403 predecessor), Branch72f46799/e7602fc15 (parallel8ccf446bb plus retention-only evidence/fixtures), Runtime publication7bc728008,
retirement9edf00516, group API31bf3636 and memory exposure13bf72442, sole UI-owner througheba8fa646 (91e8f8ad2/6ddf47dfa predecessors),
and lifecycle source through393a02f5 (including Runtime713af3ad equivalent1e4d9e2). Integration owns
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
group capture abandonment remain incomplete/refused. The fresh ordinary Project reuses
the owner Project directory and its usual default Chat plus N separately reserved
owned resource Chats. UI is limited to exactly two serial resources as described below;
2–32/parallel UI and separate filesystem workspace/imported native working roots remain absent. No qualification or acceptance claim.

### Bounded two-resource serial UI

UI eba8fa646 adds BranchGroupReview beside the singular execution review, an additive
BranchGroupClient with distinct group outputs, and two deferred regression sources.
The existing BranchesClient/coordination exports and backend capture-status DTO remain.
Only a complete standalone exactly-two serial generation-zero presentation is offered;
backend2–32/local-parallel support is not broader UI support. Real eligibility remains
host-validated. Capture accepts only commandKey, with no count/cut CAS; a concurrent
broader result is rejected and held, never prepared. Both exact retained source seals
are required before preparation, plus terminal source and external-effects acknowledgement.
Full original commands persist before POST; browser-local capture/prepare keys survive
success for pure GET status/destination/choice recovery. Unknown outcomes lock new
mutations; corrupt/unwritable storage blocks them. Choice CAS409 invalidates review;
staging/admission409 retains input. Human whole-fact approval and admission are separate;
current persisted approval hash/revision and fresh acknowledgement are required.
Independent destination/choice readback permits revocation without source/preview proof.
There is no group collection or original capture-key discovery, cross-device recovery,
mutation replay, partial-capture abandonment, group retirement or source-pin release UI.
Preparation discloses directory reuse/default Chat plus two owned resource Chats.
Both deferred command and mounted fixtures are source only; none executed.

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
Global/deleted-owner import and destination inventories remain absent; scoped destination
listing requires source ownership and is capped at50. Custody review lacks complete
source intent, so unsealed capture discovery remains missing; destination review may
refuse before deletion proof and limit Branch/capture reachability. Branch checkpoint
retirement still depends on retained owner/source identity; no owner-independent journal.
This is scoped lifecycle UI source, not broad discovery or executed qualification. The
separate bounded group admission UI below does not add group retirement UI.

- Features + Runtime: called resource trees, later-generation historical participants,
  retry/recovery, parallel cleanup-held frontiers and broader package payloads remain
  refused beyond the delivered 2–32 standalone generation-zero serial/local-parallel
  consumer. UI beyond two serial resources, group retirement UI and atomic multi-package
  group capture abandonment remain absent.
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

Group destination retirement host source reuses the singular per-resource observer across the exhaustive 2–32 resource inventory, aggregates one review/revision, privately fsyncs one exact approval and calls one Runtime-owned whole-group retirement. Separate review/approve/retire/receipt routes and BranchesClient methods are provided. Every Chat, mapped/additional deleted member, current/deleted Project, import rollback, owner subtree/native exit and cross-owner reference is observed; unknown or stale evidence refuses. Singular retirement remains group-refusing, preserve-only is permanent and admitted provenance/package bytes remain retained. Deferred two-resource host/canonical composition and separate Runtime SQL fixtures are source only. No tests/checks/build/types/Node/native/browser/runner preparation/execution/migration/push/deploy or acceptance claim. Paginated backend discovery is integrated below; atomic multi-package group capture abandonment, group history/disk reclamation and external unknown recovery remain open. Bounded global policy/history and native-exit inventories bind approval, conservatively invalidating it on unrelated policy changes; each source owner must also pass non-deletion drain inspection. No migration change was introduced.

### Lifecycle discovery source successor

Operator audit discovery now provides revision-bound paginated import-operation, current/retired destination and full unsealed capture/source collections under `/api/lifecycle/{agent-imports,destinations,checkpoint-captures}`. It preserves exact current/deletion-receipt/retained-only owner labels and original product/Branch/execution identities, validates retained hashes/receipts, and exposes complete source/capture keys without gating source discovery on destination deletion review. DTOs/BranchesClient and deferred source fixtures are present. Unknown evidence remains held; bounded inventories refuse rather than truncate. This closes the backend identity reachability gap, not UI integration/qualification, group capture abandonment, disk reclamation or broader lifecycle acceptance. No tests/checks/build/types/Node/native/browser/prep/execution/migrations/push/deploy/newworkers or web writes.
