# Current web implementation coverage

Source-only integration through `5df7f0a04` (including current native, state and lifecycle source).
No execution, preparation or acceptance claim. [Historical detail](web-feature-completion-history.md)
is archival; [current all32/Build coverage](implementation-coverage.md) and the
[remaining implementation inventory](phase2-remaining-implementation.md) define current limits.

| Requirement | Source coverage |
| --- | --- |
| #3, #26, #29; output frontends | `OutputAgentApp`, `BranchChats`, `AgentDetail.header` use focused output Chat, everyday settings and More options; existing Chat/Branch folders retained. |
| Build list Assistant/speaker | `AssistantSettings`, `AssistantEntry`, `OutputAgentDesignation`: visible disabled state, canonical explicit enable, refreshed status, serialized role changes and expected-speaker move with confirmation; singleton authority remains server-owned. |
| Output settings | Model saves use existing `updateAgent(agentId,{activeEngine,model})` on the persistent workflow Agent. Schedule saves include both `expectedVersionId` and `expectedSettingsRevision`. |
| Attachments and voice messages | `VoiceMessageRecorder`, `voiceRecording`, `DictationControls`, `Composer`, `ComposerAttachment`, `ChatAttachments`: microphone recording/review, existing durable draft uploads, native audio preview/playback. |
| #27 appearance/mobile | `TextSizeSetting`, `textSize`, root `index`, shared settings; standalone `useAppViewport` and font hook; relative prose line height, native audio labels and touch-sized attachment removal. |
| #31 streaming | `AgentResponseText` reaches Agent work/task receipts through `ResponseRow` and Branches live output. `useAgentStream` batches ordered text and closes exact-Run segments on terminal lifecycle. Shared human, private human and passive peer provisional text use explicit authorized routes. |
| #31 calls | Existing voice reply association/memory checks retained; sentence stability threshold 300 ms / poll 100 ms; standalone phone layout wired. Runtime-qualified early acknowledgement source is assembled; call timing remains unqualified. |
| #21 source performance | Ordered 16 ms text batching, memoized stable rich Markdown, literal open segments; accepted timestamp reuse retained. No measured improvement claimed. Historical red evidence remains unchanged. |
| #18, #24 | Accepted notification/unread behavior and exact canonical figures retained. No cost estimates; call timing details behind explicit disclosure. |
| #22 onboarding | Existing provider-first New Chat flow and recovery retained; redundant creation-description blocks removed. No installation/timing claim. |
| Inbox | Existing Inbox naming retained; no legacy user-facing label introduced. |
| #8 import/export | Explicit file/root/organization-folder export, per-root recovery destinations, fresh managed destination creation and opt-in live activation; access restrictions reviewed before import, memory/browser suggestions separately reviewed after import. |

## Current Branch review controls

Standalone groups consume server-authoritative complete 2–32 gen0 previews, canonical
revision-bound discovery, exact persisted CAS commands, full human disclosure and one
atomic admission. Standalone history consumes server-classified serial/local_parallel
one-invocation generations 1–32 with verified saved budget/full cut and checkpoint evidence.
Legacy absent proof is unavailable; classified evidence cannot downgrade.

Called owner trees use separate tree preview/status/discovery: manual parent plus one
called child, one gen0 serial ASYNC/SYNC resource each. Full preview is saved before POST;
status binds both original execution/Step/Chat identities, reviewHash/versionId and retained
checkpoint. Destination matching requires two exact owners, root/child ownerMap, separate
per-owner hashes/Chats, all returned private facts/current policies and both admitted receipts.
Unknown outcomes recover by original-key GET only; stale selections require rediscovery.

Tree DTO now supplies saved hash-bound ancestry, idMap/counters and numeric fresh owner
budget receipts. M4 UI validates and renders that exact saved proof with prospective
versus committed ancestry; absent legacy proof stays unavailable and malformed proof refuses.
No larger/parallel/later-generation tree or multi-item retry history is implied.
Original Project and Request audit scope, current policy and human full-facts choice stay
separate. Review does not replay original effects or create a separate working copy.

Lifecycle controls include canonical discovery, whole-group retirement, partial capture
abandonment and retained historical audit. New canonical deletion retains exact journals;
old erased proof remains unavailable. Audit is evidence-only, never action authority.
Precleanup/deletion guards and private historical projections remain intact.

M5 source cleanup is integrated: [UI copy census](phase2-ui-copy-census.md) inventories concise labels/evidence rows and retained consequential consent. Exact authored facts and policy/server content remain verbatim; no visual #29 verdict is claimed. Claude native compaction/fresh occupancy is delivered in source; lost native outcomes and original source effects remain M2/M3. Package,
provider/native/runtime, end-to-end, accessibility/mobile and all Bible/Build qualification
remain deferred, as does F1 fixture-source repair. Deferred UI sources include
branch-owner-tree-group.test.mjs and branch-group-review-mounted.tsx; neither was run.

## U5 — explicit Preserve unknown memory hold decision

Integrated UI source `557dfcd75333efab8c4377998d87ba149c199226`; prior concise
copy and current guide retained.
Required backend/core: exact `06ce4b3c51c5a77a92e949996624e3203153e56a` at
`/tmp/ponderosa-portability-recovery-inventory`, including exported shared DTOs,
mutation hold inventory/disposition validation and separate preserve-unknown route.
Actual operator contract in `docs/portability-recreation-inventory.md`, shared
`lifecycle-reconciliation.ts`, route/service/authority and original hold receipt
implementation were source-read. No backend/core/SDK/DTO edits. Prior backend
requirements remain required or integration-verified equivalents.

The lifecycle inventory mounts a distinct Preserve unknown dialog alongside
existing memory reconciliation. It reads inventory only, including legacy holds
and known-effect holds whose backend cannot be queried. Exact original hold/hash
and `preserveUnknownReviewSha256` are displayed in full evidence. The ordinary
backend reconciliation hash is never used. Reason (16–4096 characters), explicit
acknowledgement and a separate confirmation precede saving the complete original
command and one POST. Failed storage prevents POST; corrupt saved input holds new
commands. Unknown/409/mismatched receipt keeps original input unchanged. No
refresh substitutes its hash or key. Explicit GET inspection matches original
hold/review/key/reason and the entire disposition contract; deliberate unchanged
POST repeat requires separate confirmation and is never automatic.

Receipt validation requires unknown outcome, held:true, backendModified:false,
replayed:false, original id/hold hash and local operator identity. Decision copy
continues saying hold unsettled/capture blocked, never completion or drain proof.
Existing Reconcile eligibility, backend review, capture fences and original hold
state remain unchanged. No explanatory product paragraphs were added.

Six deliverables: `apps/web/src/components/lifecycle/{LifecyclePanel.tsx,
MemoryPreserveUnknown.tsx,memoryPreserveUnknown.ts}`;
`tests/chats/{memory-preserve-unknown.test.mjs,memory-preserve-unknown-mounted.tsx}`;
this report. Deferred pure fixtures cover legacy/known-effect inventory, exact
receipt flags/identity, malformed and wrong-scope storage, distinct hashes and
settled-state refusal. Deferred mounted fixture covers inventory-only legacy and
known-effect recovery, save-before-effect, separate confirmation, lost response,
remount/no replay, wrong receipt hold, exact GET resolution, stale409/hash change,
explicit unchanged repeat and unchanged Reconcile gate.

SOURCE ONLY: fixtures unexecuted. No tests/checks/types/build/Node/native/browser/
runner preparation or execution, installs, backend writes, push/merge/deploy or
new workers. Backend/core source is assembled; external-effect evidence remains unavailable where
not retained. Runtime/provider/native/filesystem/accessibility/mobile qualification remains open. No whole
UI/lifecycle/Bible/Phase2 acceptance claimed.


## M4 — saved owner review evidence and published retry ceiling

Source successor of `557dfcd75333efab8c4377998d87ba149c199226` (retains the
memory Preserve unknown work), on sole UI writer `phase2/web-feature-completion`
at `/home/phoenix/ponderosa-worktrees/phase2-web-feature-completion`.
Required backend/core exact `172fc335bc8efc327be27335a507f51710cdd35a` at
`/tmp/ponderosa-branches-finite-contract`; earlier backend dependencies remain
required or integration-verified equivalents. Actual group DTO, saved evidence
projection/reader, admission receipt producer, published policy bounds and
`docs/branch-finite-contract-dispositions.md` M4 contract were source-read.

Group review now renders actual saved `reviewEvidence` per owner: original/fresh
frontier `idMap` and execution `ownerMap`, both parent execution/Call attempt
identities, global/path/loop/Step invocation counters, pinned limits/policy,
resolved numeric concurrency/path/Step/Agent capacity, exact selected usage and
fresh acceptance source/time/kind plus full numeric saved budget receipt.
`policy:null` is labelled unlimited, never zero quota. No estimated remaining
allowance or Request-derived counters appear. Reserved ancestry is explicitly
prospective until server admitted readback verifies committed parent foreign keys.
The existing all-facts acknowledgement includes saved owner evidence. Missing
legacy evidence stays unavailable; no replacement from current mutable quota or
workflow layout. Present malformed evidence refuses destination/disclosure
validation, including wrong owner/parent maps, missing counters or numeric budget,
policy shape and prospective/committed status mismatch. The prior blanket M4
ancestry/budget-unavailable display limitation is resolved for verified new plans;
legacy absence remains honest.

Server validates immutable evidence hash against saved plan, exact selected source
and actual acceptance admission snapshot; final owner receipt commands retain the
existing complete plan hash binding. UI retains that boundary and unchanged
whole-fact/current-policy/resource/choice/admission receipt validation. It does
not invent a plan-hash field or independently grant ancestry/budget authority.
Minimal additive UI-owned `branch-group-client.ts` adopts only the exact frozen
shared evidence interfaces and optional DTO field; Branch owner notified.
No backend service/producer/store/shared runtime implementation was changed.

Generation-history preview and verified status now accept original published
`maxAttempts` through100, independently of current generation1–32. Original
consumed counts, proof hash, complete saved cut/ordered selections and matching
preview/status budget remain required. No budget reset, new preview substitution,
extra generations, old effect replay or eligibility inference.

Ten deliverables: `packages/core/src/branch-group-client.ts`;
`apps/web/src/components/branches/{BranchGroupReview.tsx,branchGroupReview.ts,
branchGroupReviewEvidence.ts,branchGenerationOne.ts}`;
`tests/chats/{branch-owner-tree-group.test.mjs,branch-group-review-mounted.tsx,
branch-generation-history.test.mjs,branch-generation-history-mounted.tsx}`;
this report. Deferred pure/mounted fixtures cover exhaustive two-owner saved
maps/counters/ancestry/capacity/budget, legacy absence, malformed non-first owner
refusal, prospective→committed labels through original-command GET recovery,
whole-fact/policy consent and generation2/32 policy100 evidence. Policy101 and
generation33 stay refused; changed saved maximum stays held.

SOURCE ONLY: fixtures unexecuted. No tests/checks/types/build/Node/native/browser/
runner preparation or execution, installs, backend writes, push/merge/deploy or
new workers. Backend/core is assembled; runtime/provider/native/filesystem/accessibility/mobile
qualification remains open. No whole
UI/group/lifecycle/Bible/Phase2 acceptance claimed.

## Browser console and JPEG-frame recording operator controls

Source successor of UI `6706540420065f45711e508205f4b872d4de3ab2`.
Required backend/core: exact `1e1d1ccda5474ae3688fda4c3460c89877e27aae`
(`/tmp/ponderosa-browser-operator-observation`), based on G7 integration
`afc8e0286f941bc154ce700d704b45660207af03`, including exported shared
`BrowserOperatorObservationClient`/DTOs, exact operator routes, managed immutable
artifact registration and download authority. Actual API/DTO, operator route and
serialized session/control/page admission implementation were source-read.
No backend/core/SDK source is changed by this UI slice.

Both existing browser surfaces mount the same concise observation dialog.
Owned Chat/saved/private browser adapters use their existing REST base and
explicit operator transport; no `/api/agent-browser`, Run token, inferred grant,
control takeover, browser opening or alternate browser selection occurs.
Console query is bounded to 50 entries and the inspected admitted page, with
level filter, next cursor, timestamp/level/page evidence and visible eviction.
Session/control/connection/page/filter changes clear stale console projection;
late results from a different projection are ignored. Entries render as text.

Recording is enabled only on the exact private Agent/Run endpoint. Shared Chat
and saved browsers explicitly show recording unavailable: canonical Chat/operator
artifact publication remains backend work. Native manual/private sign-in/paused
connections require existing explicit resume; unsupported drivers fail visibly.
Operator control, ready session, page admission and current active page are
required. Recording start has a separate visible-sensitive-data confirmation;
stop publishes only the exact original recording ID. Frame/time/byte limits are
shown without inventing audio or MP4 output. The server remains authoritative
for live Run, session, epoch, queued actual active page and lifecycle admission.

Complete original start/stop input is stored before effect under origin/product/
route identity. Storage failure/corruption holds new recording mutations.
Mutation calls execute once; no effect runs on mount, no automatic retry or
POST replay. Lost response/remount uses explicit read-only recording/status
POST at the same session/epoch. Original start page plus prior recording ID,
or original stop ID and recovered artifact, must match before clearing the
pending command. Old receipts cannot substitute for a new start. Missing proof,
wrong receipt, changed authority or publication failure remains unconfirmed.
A separate acknowledgement of Project-artifact inspection permits a deliberate
new attempt while explicitly retaining the prior outcome as unresolved; current
status and a new explicit confirmation are still required. Status is in-memory,
not crash-durable. Backend deliberate repeated-stop capability is not auto-used.

Published receipts provide the exact ordinary Project managed download URL.
Playback/download validate Project/artifact URL, artifact reference/path/media/
frame count/reason; playback additionally binds recording/page/start/ended time,
format, frame count, ordered bounded timestamps and bounded JPEG base64. Frames
use only JPEG data URLs and actual atMs delays with play/pause/frame stepping.
Downloads remain ordinary operator Project audit access, including after Run end;
the live status API itself does not survive Run end. No remote playback images,
HTML execution or synthesized media. Layout stacks controls on narrow screens;
copy uses labels, structured evidence and concise consequential warnings.

Eight deliverables: `apps/web/src/components/{AgentBrowserDialog.tsx,
ProjectBrowserDialog.tsx}`; `apps/web/src/components/browser/{browserAdapters.ts,
BrowserObservations.tsx,browserObservation.ts}`; `tests/chats/{browser-observation.test.mjs,
browser-observation-mounted.tsx}`; this report. Deferred pure fixtures cover
identity/format/bounds/filter/cursor/substituted proof. Deferred mounted fixture
covers page query/eviction, separate confirmation, save-before-start/stop,
lost response/remount, exact status recovery without replay, wrong recording,
missing receipt/epoch/corrupt storage holds, managed download/playback and shared/
Agent-control refusals. Fixtures are source only and unexecuted.

SOURCE ONLY: no tests/checks/build/types/Node/native/browser/provider or runner
preparation/execution, installs, backend writes, push/merge/deploy or new workers.
Backend/core `1e1d` and this UI are now assembled in integration. Shared-browser canonical recording publication is now source integrated from `3bd24282d6d023fe61b12f0ade786e0a869f6746`. Remaining: shared recording destination controls and operator producer rendering,
actual HTTP/download/native lifecycle qualification and separately authorized
runtime/accessibility/mobile/keyboard/screen-reader validation. No whole #3/#19,
native parity, whole UI or Phase2 acceptance claimed. Earlier UI/M4/lifecycle/
history/copy changes remain preserved.

## G5 native file history and transcript fork controls

Source successor of browser UI `350d6fab18b0200b68eaa177afa2e022c06bde0a`.
Required backend/core exact `3d97ba4d2381c56b7395ec0d047c8753ddc4033d`
(`/tmp/ponderosa-native-file-checkpoint-fork`), direct successor of
`b5c34a924437a497eca06440207050cfbc311ec8`. Both commits and their ordinary
Runtime/Claude/scheduler/shared-adapter prerequisites must be composed. This UI
uses exported shared REST/catalog/physical-fact types; no backend/core/engine/
SDK implementation or reference-checkout writes. Actual routes, authority,
physical collector, projection, future-preference startup handoff and updated
`docs/native-file-checkpoint-fork.md` were source-read. Browser/history/group/
M4/lifecycle/copy changes remain preserved.

Agent Settings adds an explicit Native file history & transcript fork dialog.
No provider/session operation runs on mount or dialog open. Claude preference
inspection/save targets only `native-history/tracking` with exact `{enabled}`.
UI distinguishes observed future preference, optional retained native session
startup flag, absent/unconfirmed startup evidence and actual backup availability.
Default-off preference comes from the backend. Saving opens/restarts no session,
adds no retroactive backups and disabling does not erase existing backups. Input
is stored before preference POST; a lost response holds further saves until an
explicit GET observes the desired preference. That is current-setting evidence,
not an invented keyed operation receipt. No automatic preference replay.

Native catalog inspection verifies canonical Agent/Project/Chat/engine/root,
source native session, completed Run/fence, tool-contract hash and exact boundary
SHA-256. Only server-returned checkpoint/cut IDs are selectable. Only canonical
`eligibleTargets` populate the empty same-Chat/project/engine/root target selector;
IDs remain exact evidence, not guessed directory eligibility. POST still
revalidates emptiness/current authority. No Agent or native ID is manufactured.
Codex tracked-file rewind is explicitly unavailable; transcript fork follows the
actual returned capability. Claude catalog tracking is startup configuration,
not proof that particular files have backups.

Preview tracked file rewind is a distinct native dry-run command. Display keeps
native outcome/canRewind/error/optional changed files/counts/skippedLinks honest;
missing counts remain unavailable. Saved physical preview displays complete file
and ancestor facts, exact current byte hashes, boundary hash, original key and
60-second creation/expiry window. Client freshness gates revalidate immediately
before POST; backend rechecks unchanged physical facts, current write restrictions
and other managed writers. Catalog has no current policy decision field: UI says
that permission evidence is unavailable there and server-enforced, never infers
permission from catalog support. Host/user writers are not locked by the snapshot.
File and ancestor malformed/non-first hashes/stats/path/root proof fail closed.

Rewind requires its original matching preview and separate restore/delete
acknowledgement plus confirmation; file consent cannot authorize transcript fork.
The full original boundary/body and exact preview body/receipt are stored before
rewind POST. Native `completed` is displayed as a native receipt, never whole
restoration proof. Refusal/partial/unconfirmed native outcomes remain explicit.
Conversation, original Runs, Requests, publication, browsers, memory and external
effects are not settled or replayed by any of these controls; Branch restore is
labelled separately.

Transcript fork has separate context-only acknowledgement and confirmation.
Preparing targets the existing empty Agent, stores exact source/cut/target/key,
holds the source and starts no work. Open target Agent only navigates. UI requires
a separate new human message through normal Chat to start the real destination
scheduler Run; it submits no message and opens no provider. Reserved native ID
is labelled unobserved; observed fresh identity/target Run/fence are displayed
only from exact canonical receipt. `opened` remains distinct from normal completed
Run snapshot acceptance. Copied context grants no old tool/Request/browser/source
authority. Cancel unstarted preparation persists cancellation intent first, uses
the original fork key and remains enabled only for a verified `prepared` receipt;
started/unknown/opened forks cannot be cancelled by that control.

All native commands are saved before one POST. Original-key GET recovery remains
available when the retained runtime/catalog changes; a fresh catalog never
substitutes for the original body. Request hash, complete immutable source
boundary, canonical input hash, operation/key, chosen checkpoint/cut/target,
physical preview and result semantics must match. Storage corruption/conflict,
missing/wrong receipts, HTTP409, native `started`/unknown and lost cancellation
hold new commands. No automatic POST retry or native replay. A terminal verified
receipt can start a separate review; held/missing proof cannot be dismissed as a
failed operation. Original input stays saved across remount. Client SHA-256
verification requires browser WebCrypto; unavailable verification holds actions.
Labels/evidence rows/short consequential consent preserve #29; controls stack on
narrow layouts and full evidence wraps/scrolls.

Six deliverables physically inventoried/source-read:
`apps/web/src/components/{AgentDetail.settings.tsx,NativeHistoryControls.tsx,
nativeHistory.ts}`; `tests/chats/{native-history-ui.test.mjs,
native-history-ui-mounted.tsx}`; this report. Deferred pure fixtures cover
boundary/hash/catalog/target/physical-fact/optional-field validation, exact original
request/input hashing, preview expiry, rewind-preview binding, reserved/observed
fork identity and future/current tracking distinctions. Deferred mounted source
covers explicit opt-in/save-before-effect, lost preference response, preview/
rewind/fork/cancel lost response and remount GET, separate acknowledgements and
confirmations, full physical evidence, target navigation without work, started/
wrong-receipt/corrupt-storage holds and honest Codex capability display.

SOURCE ONLY: fixtures unexecuted. No tests/checks/build/types/Node/native/provider/
browser or runner preparation/execution, installs, backend writes, push/merge/
deploy or new workers. Backend/core/Runtime composition is now source integrated. Remaining: actual provider/
filesystem/HTTP/native-ACK/goal/permission/lifecycle qualification; browser WebCrypto,
rendered accessibility/mobile/keyboard/screen-reader validation. Current policy
is not exposed as a read decision in this backend DTO; native lost-ACK and
compatibility limits remain those of the frozen contract. No full native parity,
#3/#19/#29, UI or Phase2 acceptance claimed.

## Native task inventory and stop successor (source only)

Agent Settings adds Native tasks using the exact human REST contract at backend/core
`11619f93fb187e8fe5fc8f3c663ad1c9e9046552` (phase2/native-task-lifetimes).
Inventory is explicit GET, showing exact Run/fence/session and opaque task/native
identities. Known cron rows remain noncancellable. Confirmation sends one stop
POST after the complete original command is persisted; each exact target retains
its original key and cannot be resubmitted with a new key. Storage corruption or
conflict holds new stops. Unknown responses and remount recover by explicit GET
with the original key and full original boundary, including after source drift.
No automatic retries or guessed IDs. Server still enforces current authority,
canonical target uniqueness, lease/fence and latest complete inventory.

Receipts show acknowledged/terminated/not_found/unknown exactly, always
processDrainObserved:false. They do not complete the source Run or settle its
effects. Existing Run Stop in the Agent header remains distinct. Concise controls,
wrapped evidence and separate confirmation preserve narrow-screen source intent.

Deliverables: AgentDetail.settings.tsx, NativeTaskControls.tsx, nativeTasks.ts,
tests/chats/native-tasks-ui.test.mjs and native-tasks-ui-mounted.tsx, this report.
Fixtures cover exact identities/receipts, lost response, saved-before-effect,
remount GET, drift, cron refusal and no replay. All remain unexecuted. No checks,
build/typecheck/Node/provider/native/browser preparation or execution authorized.
Backend/runtime composition, actual provider qualification, HTTP recovery and
rendered accessibility/mobile/keyboard/screen-reader validation remain pending.

## Shared Chat/saved recording successor (source only)

Consumes frozen backend/core `3bd24282d6d023fe61b12f0ade786e0a869f6746`
from /tmp/ponderosa-browser-chat-recording. Chat browser adapter binds its canonical
owner Chat. Saved browser offers explicit actual live Chat choices from the current
Project's canonical conversation listing; no automatic selection, Agent grant or
Run inference. Deleted and execution-owned Chats are excluded locally; active,
staged, deleting, product and temporary scope refusals remain server-enforced.
All shared status/start/stop calls retain nested destination:{conversationId}.
The full original command includes destination Project/Chat evidence, saved before
mutation together with an immutable destination binding retained across remount.
An existing binding cannot be redirected by selection or changed response. Status
is in-memory recovery only. Missing/wrong destination/status/receipt remains held;
no automatic retry. Private Agent/Run behavior remains distinct and unchanged.

Shared receipt destination must match both retained IDs; download namespace,
artifactRef and path bind the fresh artifact ID, independently from recording ID.
Playback keeps exact recording/page/time and bounded timestamped JPEG JSON checks.
Chat result lists and retained previews render Operator producer without fictitious
Agent attribution or automatic sharing. Concise destination/access evidence is shown.

Source deliverables: ProjectBrowserDialog.tsx, ConversationFilesResults.tsx,
browser/{browserAdapters.ts,BrowserObservations.tsx,browserObservation.ts},
filePreview/ArtifactPreview.tsx, tests/chats/browser-observation{.test.mjs,-mounted.tsx},
and this report. Deferred fixtures include immutable destination, independent
artifact identity, saved-before-effect, lost start/stop, remount, wrong destination
and Operator rendering. No execution/checks/build/typechecks/Node/native/browser or
provider preparation. Actual HTTP/download/lifecycle qualification, current-scope
refusals and rendered accessibility/mobile/keyboard/screen-reader validation remain.


## Current G7/G8 integration composition (source only)

Only task UI `5ec1d8c1d8368da2e536953a5cf692dc1cef0c9d`, then shared recording UI
`1636a80d2921290f3bf1cffb4c6d1d6a12f7a280`, are integrated onto the current
c0cc-based integration. Settings retains RuntimeControls, HistoryControls and
TaskControls together. Shared backend/core contracts were already assembled;
no backend, provider, schema, portability or state implementation changes here.
The later owner commit `68319a2620a9039976355ee70ff734a080a7d156` is excluded.
All six task and nine recording deliverables were physically inventoried/read;
fixtures remain unexecuted. Source delivery does not qualify HTTP recovery, native
producer compatibility, browser lifecycle/download, accessibility/mobile, or full
Bible/Build acceptance. G2 external continuation admission, G6 envelope/maximum-media
qualification, native receipt/restart unknowns and remaining Branch tree/foreign
continuation/portability contracts remain explicit. No whole parity verdict.
