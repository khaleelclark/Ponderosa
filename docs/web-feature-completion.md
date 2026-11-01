# Web implementation coverage

Base: `f64f631b490dbfc8125f0f7a2f8c649b6c54d19f`. Writer: Phase 2 UI and accessibility fixes.
Branch: `phase2/web-feature-completion`. Worktree: `/home/phoenix/ponderosa-worktrees/phase2-web-feature-completion`.

Implementation-first: no tests, suites, typechecks, builds, browser sessions,
benchmarks, capacity checks, or acceptance packets executed in this feature work.
Regression source is written for later combined verification. This is source
coverage, not a Bible verdict, portability qualification or release claim.

| Requirement | Source coverage |
| --- | --- |
| #3, #26, #29; output frontends | `OutputAgentApp`, `BranchChats`, `AgentDetail.header` use focused output Chat, everyday settings and More options; existing Chat/Branch folders retained. |
| Build list Assistant/speaker | `AssistantSettings`, `AssistantEntry`, `OutputAgentDesignation`: visible disabled state, canonical explicit enable, refreshed status, serialized role changes and expected-speaker move with confirmation; singleton authority remains server-owned. |
| Output settings | Model saves use existing `updateAgent(agentId,{activeEngine,model})` on the persistent workflow Agent. Schedule saves include both `expectedVersionId` and `expectedSettingsRevision`. |
| Attachments and voice messages | `VoiceMessageRecorder`, `voiceRecording`, `DictationControls`, `Composer`, `ComposerAttachment`, `ChatAttachments`: microphone recording/review, existing durable draft uploads, native audio preview/playback. |
| #27 appearance/mobile | `TextSizeSetting`, `textSize`, root `index`, shared settings; standalone `useAppViewport` and font hook; relative prose line height, native audio labels and touch-sized attachment removal. |
| #31 streaming | `AgentResponseText` reaches Agent work/task receipts through `ResponseRow` and Branches live output. `useAgentStream` batches ordered text and closes exact-Run segments on terminal lifecycle. Shared human, private human and passive peer provisional text use explicit authorized routes. |
| #31 calls | Existing voice reply association/memory checks retained; sentence stability threshold 300 ms / poll 100 ms; standalone phone layout wired. Actual early Agent acknowledgement remains runtime-owned. |
| #21 source performance | Ordered 16 ms text batching, memoized stable rich Markdown, literal open segments; accepted timestamp reuse retained. No measured improvement claimed. Historical red evidence remains unchanged. |
| #18, #24 | Accepted notification/unread behavior and exact canonical figures retained. No cost estimates; call timing details behind explicit disclosure. |
| #22 onboarding | Existing provider-first New Chat flow and recovery retained; redundant creation-description blocks removed. No installation/timing claim. |
| Inbox | Existing Inbox naming retained; no legacy user-facing label introduced. |
| #8 import/export | Explicit file/root/organization-folder export, per-root recovery destinations, fresh managed destination creation and opt-in live activation; access restrictions reviewed before import, memory/browser suggestions separately reviewed after import. |

## Authorized text projections

`DirectReplyPreview` consumes generic reply-stream status, including Assistant and
output apps through shared Agent Chat. `textReplyRoute` checks explicit text
presentation, source event/conversation, reply intent and recipients. Human
broadcast previews appear under the latest broadcast in shared human Chat; human
DM previews stay private. Same-Chat passive peer previews appear only in the
receiving Agent audit view, matching source sender, sole return recipient and
responder. Correlated Requests are excluded. No peer draft enters shared Chat.

Existing exact Agent/Run/fence/stream/sequence and memory exposure/reset checks
remain. Canonical replies replace provisional text in the same scope. SSE prompts
authoritative reads and a sequential fallback covers reconnects. Voice consumers
reject text presentation. The browser neither publishes Communication nor speaks
text snapshots. Mixed routes, attachments/documents and correlated reports still
use canonical publication; generation support for those is runtime-owned.

## Reviewed import and retained provenance

`ImportAgentDialog` previews source/destination restrictions using staged package
upload, requires explicit keep/apply choice and forwards the server review digest.
Package, destination, engine, instructions, folder map or activation changes
invalidate review. Delayed reviews cannot replace newer drafts. Role collision
review remains separate. Completed async imports retain their full result receipt;
missing result receipts surface an error.

`PostImportAccessReview` groups memory suggestions by exact mapped destination
Chat, reads current grant/revision and applies only an explicit human choice via
revision-checked Settings. The UI explains the Chat-wide effect. Browser choices
use destination-local profiles and existing Settings APIs, never source profile
IDs. Import/review alone changes no grants. Each action reports errors; Done
protects unapplied choices. Returned recovery folders and actual `liveWorkingRoots`
are displayed separately.

`ImportedCommunications` is an on-demand owning-Agent technical reader with
bounded/versioned pages, immutable provenance/audience, revisions and authorized
original downloads. Imported history does not become live Chat or source authority.

## Working files and fresh live destinations

Full export supports selected relative working files, whole root, or an explicit
full-organization all-folders option. Copy/download forward the same options.
Off-thread preview groups opaque workingRootRef values and all member Agents.
Import requires one new absolute, distinct, nonnested recovery destination per
root; the server validates canonical paths, existence and ownership. Selected/root
packages retain the single new-folder control.

The form offers explicit creation through `createChat({label,defaultEngine,
createFolderName},idempotencyKey)`. It never registers an existing user path. The
returned Chat and Project become the actual destination for name checks, access
review, import operation reads, role recovery and result Settings. Creation remains
retained if import is cancelled or fails; the UI says so.

Live activation is off by default and offered only for full packages containing
working originals. A newly created destination requires a second explicit
confirmation of its exact returned workingDirectory. Both access-preview and
import receive `workingFilesActivation:{sharedRoot}`. This also initializes the
new Git baseline for fresh all-Separate imports. Existing Git destinations require
an explicit Separate Git copy mode and send `workingFilesActivation:{}`. Existing
Shared activation is unavailable. Source-root membership incompatibilities remain
server refusals; no source ownership receipt is adopted.

Recovery destinations remain required and separate from live roots. The server
preserves displaced baseline bytes and recovery locations on failure. Source Git
history, symlink topology, credentials and native ownership remain excluded.
Content-only import remains available by leaving activation off.

## Branches installation

`BranchPackageDialog` shows each pending Chat/Agent's source and destination
restrictions and requires an explicit choice using the server digest/opaque refs.
Changed review clears the choice. Success or error refreshes canonical status;
delayed mutation results do not replace later Stop/terminal state. Background
progress and Stop remain available. All web callers are owned by this UI lane. Branches backend APIs are owned by
the Branches lane. Workflow folder export/import controls are described below;
the Agent-package form alone does not establish their coverage.

## Backend integration and remaining limits

Integrate these owners' source chains before combined execution:

- Portability `f3a009bac31d1c6829f17da1136b802b66c2c042` and ancestors (including
  dc73 organization bundles, access review DTOs, imported provenance, memory grant
  contract and live working-root activation).
- Runtime text `8d9dfaa84ac190aca5f60f5887d0680e319016df` and its final successor for
  routed generation. Voice acknowledgement generation remains runtime-owned.
- Branches `c7acbd864e01fd3becdc3ace733d5d25dbaa270e`, installation access-review
  `7b655b210e674ced1680276413b362b903de0012` and successors.
- Audio admission `94f7bafc63f17c82ff231d0211b61b0cf2d0bace` and reconciled runtime
  audio changes. Recorder preferences match WebM/Opus, Ogg/Opus and MP4 admission;
  container validation does not establish playback qualification.

No backend cherry-pick, push, merge or deployment occurred here. This isolated web
branch intentionally depends on owners' newer core DTOs. Combined source integration, full generation coverage, early voice response, consolidated compatibility,
accessibility/mobile judging and performance acceptance remain external or
unexecuted gates. Full #8, Bible and Phase 2 completion are not claimed.

Deferred regression sources include `text-reply-route.test.mjs`,
`working-root-destinations.test.mjs`, `post-import-access-mounted.tsx` and
`import-live-root-mounted.tsx` under `tests/chats`, alongside prior live-text,
recording-format, mounted-recorder, phrase-buffer and text-size regressions.
No runner/configuration was added or executed.

Shared Chat/peer previews, Agent new-Chat/live activation and mapped Settings
above are source coverage only.

## Exact native-context recovery consumer

Consumes runtime `f446d63e357e16c7cc1365bcf0c2d0c7dd8b028b` and its core types.
`ContextRecoveryPanel`, mounted in the persistent Agent technical view, inspects
status on demand without opening a provider. Recovery requires an explicit unknown
effects acknowledgement and freshly rechecks the exact session/Run/contract/fence
boundary before submission. The exact idempotency key is retained in browser
storage before POST; failed/ambiguous requests are inspected by that key, never
automatically retried or replaced with a new identity.

Recorded phase, source evidence, unsupported-provider limitations, context-only
acceptance and original-work uncertainty remain visible. Exact recovery Stop is
available while the original POST is pending. Only a settled hold has a dismissal
control, with a separate human acknowledgement; server authority still decides
admission/cleanup. No recovery action manufactures a scheduler task, retries
original work, changes access or marks it successful. The old fresh-session
Settings action remains a separate explicit action. Source regression
`tests/chats/context-recovery-mounted.tsx` covers acknowledgement, key custody,
exact Stop during pending recovery and explicit dismissal without replay.
No test/check/build/type/browser execution accompanied this increment.

Branches delivered backend caller `d9fb504d766b24a3891a458657f58451e4a833ef`
(no web edits), superseding earlier content-only backend limits. Its workflow
package file-selection/live-activation controls are now wired as described below;
Agent-package controls alone do not establish the separate workflow coverage.

## Workflow folder caller continuation

`BranchPackageExportDialog` uses the complete paginated canonical workflow Agent
list. Full export offers all Agent folders or explicit per-Agent whole/selected
relative file choices and forwards local-ID-keyed fileSelections. The sensitive
data warning remains in the shared confirmation dialog. No subtree is exported
again on the client.

`BranchImportFiles` collects target-keyed NEW recovery destinations. Retained
existing Agents expose no folder mutation controls. Client lexical checks require
complete, distinct, nonnested absolute destinations across all targets; backend
canonical/link/ownership validation remains authoritative. Single-Agent fresh
managed destinations forward newManagedChatFolderName and workingFilesActivation
without a fabricated sharedRoot. Existing destination live activation is limited
to source Separate Git mode. A staged workingRootReview displays the actual
returned root and submits only an explicit confirmation to working-root-review.
Success/error re-reads canonical status; stale mutation responses never overwrite
a later Stop/terminal result. Stop and background progress remain available.

Pending grouped access review now offers one independent choice for each source
node with accessSettings and sends exhaustive agentActions with the complete
grouped review digest. No single-Agent digest or blanket source grant is reused.
Completed importResults are deduplicated by their canonical mapped identities and
shown through the shared PostImportAccessReview before opening the workflow.
Chat-wide memory choices remain grouped; browser choices use destination-local
profiles. Conflicting mapped Settings receipts surface an error. No automatic
grant/profile change occurs.

Runtime recovery controls are already committed at 21569c922 and remain unchanged.
All web surfaces are this lane's responsibility; backend owners supply APIs only.
Grouped fresh managed activation now consumes Branches
537b12517dd51c88ec719869174480455bd501be and shared composer
portability d7ca2d196a6e1e90d3f80ff46f7bd5a0b9644da0 (atop 82cf46284).
Both connected organizations and same-Chat forests select only the first authored
reporting root; child target selections are removed. Existing-Agent regrouping
is refused. Shared source identities, including exports without workingRootRef,
are composed by the backend; the browser never recreates their hashing scheme.

A non-confirmable discovery preview reads retain-content.after workingRootRefs
and groupedAgentRefs. It discards old per-package mappings, requests NEW recovery
paths for exact composed refs, and requires a second preview before confirmation.
Changes to package, destination bindings, parameters, memory choices or managed
folder identity invalidate the inventory. Missing canonical inventory refuses
confirmation. Changed returned refs discard prior paths again. Root and access
review success explicitly continues the same installation through confirm; stale
review errors refresh status and require fresh choices. Stop remains available.
No backend dependency was cherry-picked here. Combined integration and executed
qualification remain required; no full UI, #8, #12, Bible or Phase 2 pass is claimed.

Deferred source includes branch-package-files.test.mjs and
branch-package-export-mounted.tsx. Existing post-import mounted regression mocks
the new mapped-name reads. No tests/checks/types/build/browser/runner execution,
push, merge or deployment occurred.

Grouped regression source extends branch-package-files.test.mjs for discovery,
canonical-map replacement, child selection refusal, retained-Agent refusal,
changed root identities and independent reporting roots. Execution remains deferred.

## Reviewed saved Request and graph actions

BranchHistoryReview mounts in ExecutionPanel's existing Run actions. Opening
"Review saved work" loads retained checkpoints with explicit older-page loading.
The operator selects one checkpoint and either one exact Request ID for fresh
adoption, a graph restore, or a historical Run rewind with graphReview.
Review reads never submit an adoption, restore or rewind. Exact branch/execution,
checkpoint hash and Request identities are checked before displaying a review.

One shared ConfirmDialog pattern displays saved Request state/version, original
Project/Chat/requester/recipient, current state/version/binding revision/hash,
changed workflow/bindings/configuration, restrictions and logical required secret
names. Expandable saved payload/update/artifact evidence and current safe
configuration remain explicit historical evidence. Graph review includes exact
Joins/member/continuation identities. No original actor, grant, native ownership
or completed effect is adopted as fresh authority.

Request adoption requires a fresh instruction, explicit reconcile/independent
choice, reconciled-effects acknowledgement and separate acknowledgements for
changed pins and current secret requirements. Unknown outcomes only admit
reconciliation. Graph restore and rewind require the whole opaque graph review
hash and explicit effects reconciliation. Backend admission/refusal remains
canonical; the UI does not widen unsupported graph families or grant secrets.

409 clears prior confirmation and acknowledgements, refreshes the same review,
and requires a fresh human choice. There is no automatic mutation retry.
Before sending, the exact command/input is retained in browser localStorage;
uncertain submissions lock new choices and can only reconcile the same input/key,
including after remount. Confirmed responses and definitive 4xx clear that pending
command. Run/Branch projections refresh after accepted changes or stale review.

Consumes Branches contracts through6c4a9eb in the source integration tree;
owner confirmed the preserved contract at7a190fbe. Graph restore/rewind controls
require checkpoint restoreSupported and script_control_frontier eligibility;
individual Request review/adoption remains separately admitted by the server.
Resource access-review/custody-release controls are supplied by the subsequent
bounded increment documented below. Deferred source for this increment:
branch-history-review.test.mjs and branch-history-review-mounted.tsx cover exact
scope/hash checks, nonmutating review, stale409/fresh acknowledgement and ambiguous
response reconciliation. No tests/checks/types/build/browser/runner preparation
or execution, push, merge or deployment. Backend continuation/refusal families
and qualification remain open; no #32/Bible/full-UI pass is claimed.

## Resource destination review and exact checkpoint release (source only)

The successor to41797eb8 mounts `BranchResourceReview` beside each temporary
resource in `ExecutionPanel`. It consumes the exact shared DTO/HTTP contract at
Branches f482ecfc0e9a99a7ad682f8ee27fefe0ec62f5e0 (required backend/core source
dependency; not cherry-picked into this sole-writer web branch). The earlier
contract blocker is resolved by that dependency, not by UI-invented identities.

On-demand pure resource inspection displays exact Branch/Run/Step, numeric
resource generation, actual destination Chat and availability, import state,
current policy hash, source/current restrictions and expandable policy details.
Per-source-Agent choices explicitly keep destination or apply source restrictions;
an empty source settings set still requires an explicit choice. Shared
`ConfirmDialog` confirms before POST. Stale409 clears all choices and confirmation,
refreshes canonical inspection, and requires a fresh decision. Ambiguous access
responses inspect canonical state without resubmitting the choice. Neither this
caller nor its inspection uses the older journal-writing GET access-review.

Only retained local capture custody with a full returned receipt identity can
offer release. Restoration-source custody points to the original owner instead.
The caller displays checkpoint/custody/receipt identity and referenced-custody
refusal, and requires shared human confirmation of permanent byte removal.
Before DELETE it durably retains the entire original commandKey, generation,
custodyId and full receipt hash in browser localStorage. Package hashes never
substitute for receipt hashes. Unconfirmed/releasing/error responses retain that
input, including across remount. Pure same-key inspection precedes any explicit
retry; retry confirmation resends the original input even if current generation
has advanced. Returned command/Step/generation/custody/receipt must all match.
Only an exact released receipt clears pending input. not_found is unconfirmed,
not proof of release. No automatic mutation retries or effect-completion inference.

Six deliverables: `apps/web/src/components/branches/BranchResourceReview.tsx`,
`branchResourceReview.ts`, `ExecutionPanel.tsx`,
`tests/chats/branch-resource-review.test.mjs`,
`tests/chats/branch-resource-review-mounted.tsx`, and this document. Deferred
regression source covers owner/identity checks, local-vs-source custody gating,
opaque full receipt matching, pure inspection, fresh choices after stale409,
referenced refusal, lost response/remount, and original-key retry after generation
change. These regressions have not run.

No tests/checks/types/build/Node/browser/native/runner preparation or execution,
installs, workers, push, merge or deployment. Source was read and deliverables
physically inspected. Owner-deletion/orphan reconciliation is not available in
the backend contract; retained commands cannot be reconciled through a deleted
owner. Wider resource admission/refusal families, integrated qualification,
accessibility/mobile judging and performance gates remain open. No full
UI/#32/Bible/Phase2 pass is claimed.

## Issued destination composer and human disclosure (source only)

The bounded successor to a1da73c5 mounts `BranchDisclosureReview` in the existing
ExecutionPanel action surface. Required backend/core source is Branches
6b7f18a4a10afdb378c60f38a7699be03cbda022 atop
d39f40f80ee447d4d08ebc03366b0133de80ac4e and
fd8a55e638420bbe006bfa241f2e1c2af728eb13, source-read in
`/tmp/ponderosa-branches-issued-resource`. No backend files were edited or copied
into the sole web branch. These committed discovery contracts resolve the prior
missing-admission-ID blocker.

Canonical destination discovery supplies actual admission/command/checkpoint,
Project/Chat/Run/resource Step/generation and lifecycle. The latest 50 summaries
are shown; exact retained command inspection remains separate. No manual IDs,
map construction or browser-generated authority. Saved checkpoint selection is
paginated and exact; ordinary original-scope restoreSupported is deliberately not
treated as issued-destination eligibility. The server owns supported-cut admission.
Explicit effects reconciliation plus shared confirmation precede preparation,
which creates held fresh participants rather than approving or activating them.

On-demand disclosure preview verifies exact source/checkpoint/admission and all
destination identity fields. It shows original fact content/hashes/actors/audiences,
fresh recipients, custody and explicit maps, host-cut digest and current policy.
Human acknowledgement and shared confirmation precede hash/CAS-bound approval.
Fresh current active approval, matching canonical persisted revision/hash and a
separate confirmation are required for final admission. Persisted choice alone,
old command receipts and equal policy content never stand in for current preview.
Approval creates no activation; admission may release eligible final work.

Revocation uses the exact canonical persisted choice revision/hash from discovery,
remaining available when package bytes or current-policy preview fail. It does
not infer current choice from an old approval receipt. Receipt state and current
active are displayed separately; an inactive historic approval never revives
permission. Already disclosed facts are not erased by revocation.

All command inputs persist before POST in owner-scoped browser localStorage.
Ambiguous prepare/choice/admit responses and remounts offer pure exact-key receipt
inspection; there is no automatic mutation retry. Choice receipts must match exact
admission/key/action/hash/next revision/state. Preparation/admission readback checks
canonical key and source/admission identity and does not import/activate again.
Stale409 clears review/acknowledgement/confirmation and refreshes discovery without
resubmitting; choice/admit input clears on definitive409. Preparation can have a
durable reservation even on409, so it retains its command. Reserved/import_unknown
or unresolved preparation stays held; no automatic reset, new generation selection,
abandonment reclamation or unknown-effect recovery is supplied by this UI.

Six named deliverables: `apps/web/src/components/branches/BranchDisclosureReview.tsx`,
`branchDisclosureReview.ts`, `ExecutionPanel.tsx`,
`tests/chats/branch-disclosure-review.test.mjs`,
`tests/chats/branch-disclosure-review-mounted.tsx`, and this document. Deferred
regression source covers exact source/destination identity, canonical persisted
revocation without preview bytes, inactive old approval receipt, stale409/fresh
acknowledgement, lost-response/remount choice lookup, separate admission/readback,
and preparation from an exact checkpoint followed by pure inspection. Not run.

No tests/checks/types/build/Node/browser/native/runner preparation or execution,
installs, workers, push, merge or deployment. Source integration and authorized
executed qualification remain required. Backend limits include standalone serial
nonsecret generation-zero supported cuts, no broader issued/multi-resource/native
unknown-effect recovery, and no abandoned-stage/deleted-owner reclamation. Actual
accessibility/mobile/performance qualification remains open. No whole UI/#32/Bible/
Phase2 pass is claimed.

## Explicit publication and acknowledgement consumer continuation

Source-only continuation of `00c62faa106d42450dce40a54a50dad113b203d0` in
`phase2/web-feature-completion`, sole UI writer. Requires Runtime's frozen
`101594dc87d522dadae42601021440f7572cba91` then
`7bc728008d7ef8bf5151665815c8f2b968ed4898` contracts; backend/core were read, not
copied into this UI tree. Runtime's `docs/runtime-publication-and-voice.md` owns
native receipt qualification and the shared `VoiceReplySnapshot` DTO.

`VoiceConversation` now uses separate acknowledgement and answer phrase buffers.
Only actual nonempty native-receipted acknowledgement snapshots supply speech;
open snapshots remain silent. Exact stream/sequence and operation/provider identity
deduplicate receipt playback. Acknowledgement tails can finish their own buffer,
but cannot finish the speech queue, settle the accepted input, become Play reply,
set answer completion/onset clocks, or restart hands-free recognition. One queue
retains ownership between acknowledgement and answer, including the silent work
gap. The answer has its own prefix and stream identity; later old acknowledgement
events cannot replace its text or replay speech. Run/fence/steering/publication
changes still refuse playback. A reconnect that missed the acknowledgement receipt
can accept the separately authorized answer without inventing acknowledgement audio.
Existing memory validation before each phrase, visible-surface suspension, exact
accepted input/Agent/Chat matching and canonical DM settlement remain in place.
No browser filler, provisional Communication or latency claim is introduced.

Shared `DirectReplyPreview` accepts explicit message publication scopes for human
Broadcast/DM and sole peer returns; documentTitle/taskDelivery do not widen their
source audience. A Request publication is excluded from every message preview.
The same preview mounts only in an expanded exact `RequestLifecycleCard`, reads
`reply-streams/:requestId/:recipientAgentId`, and requires publication.kind
`request_update`, matching requestId/messageId, exact Project/Chat/Agent/current
Run, no legacy message route, and completed/blocked/failed selection. Drafts are
labeled Request result in progress, not added to authored history. The canonical
terminal state of that same Request hides the draft; unrelated Chat messages do
not settle it. Memory/session invalidation clears it and stream/fence/steering
drift remains blocked even after a transient read failure.

Contract issue resolved by Runtime successor
`13bf724423bc97321f48c61c4f999b278fc261e4`, source-read at handoff. Apply that
self-contained four-file backend commit after frozen7bc; it has no retirement
dependency. The text status route now always returns memoryExposure. Request mode
verifies the canonical packet/hash, submitted injection, exact Run/Agent/Project/
Chat, current reset/memory validation and an attached packet activation whose
canonical lineage names this exact Request. The existing UI valid/disabled gate
therefore works unchanged; missing/pending/invalid exposure stays silent.
Backend changes remain outside this UI branch.

Runtime also confirmed the native acknowledgement stays streaming sequence1 after
its exact successful receipt, with duplicate receipts unchanged and ordinary work
continuing. It never completes on speech drain. The final answer starts a fresh
stream sequence0 in the same current Run/fence/steering scope. Ending without an
answer projects interrupted failure, never canonical acknowledgement completion.
The separate buffers and held queue implement this lifecycle without a new API.

Ten deliverables: `apps/web/src/components/speech/voiceReplyStream.ts`,
`VoiceConversation.tsx`, `apps/web/src/components/chat/textReplyRoute.ts`,
`DirectReplyPreview.tsx`, `apps/web/src/components/RequestLifecycleCard.tsx`,
`tests/speech/voice-acknowledgement-consumer.test.mjs`,
`tests/chats/text-reply-route.test.mjs`, `request-reply-route.test.mjs`,
`request-reply-preview-mounted.tsx`, and this document. Deferred regressions cover
short acknowledgement tails/deduplication, separate answer prefixes, changed native
receipt/scope/stream refusal, reconnect gaps, exact private Request routing,
explicit document/mixed routes, mounted Request context revocation and canonical
terminal hiding. These sources have not run.

No tests/checks/types/build/Node/browser/native/runner preparation or execution,
installs, new workers, backend writes, push, merge or deployment. Source integration,
executed native/browser speech qualification, cancellation/revocation races,
accessibility/mobile and actual performance remain open. No whole UI/#8/#12/#32/
Bible/Phase2 acceptance is claimed.

## Operator lifecycle caller continuation

Source-only successor of `2c7db556e20b6e9b0981cd7852f019d95dad8a14` in the same
sole-writer UI branch. Requires Reliability's lifecycle chain through
`1544fee9d4eb66f50028d1bb697a9f76a36c79fe` atop
`c1d8316465dcfb064c98d010f6785bac1b815e8c`. Backend/core source is read, not copied
into this web tree. Existing origin/operator boundaries remain unchanged.

Settings now provides on-demand canonical checkpoint-custody and memory-hold
inventories plus retained orphan staging metadata. Reviews show exact identity,
current digest, file inventory, references, drain blockers and current backend
readback metadata without importing package/backend bodies. Custody reconciliation
preserves originals; memory reconciliation requires explicit external backend drain
observations and preserves current backend state. That field is operator testimony,
not a result-query guarantee. Legacy canReconcile:false holds remain disabled.
Import forms retain the actual returned/polled operation ID, including a just-failed
operation, and expose preserve_unresolved or eligible retire_mutation_free review.
No manual lifecycle identity entry is introduced.

A canonical Branch destination selection exposes destination retirement review.
The exact returned source/destination/member/reference/hash evidence is available;
permanent preserve-only retirement, source pins, completed destination deletion and
global runtime quiescence are explicit. Approval and retirement are separate human
confirmations with identical body/key/hash/pin disposition. Approval alone never
retires. Pure receipt GET reconciles only the exact retained retirement choice.

The returned destination reservation custody supplies the full original
CheckpointPackageSource to Branch lifecycle review. Canonical owner references
supply selectable exact checkpoint IDs/hashes and command keys. Initial and
foreign-owner checkpoints are not selected. Explicit checkpoint retirement binds
the current Branch revision and selected hashes. Capture abandonment first obtains
the combined Branch/package review for the exact selected command, then confirms
its opaque digest with preserveEvidence:true. Remaining references/blockers refuse
abandonment; the backend independently validates supported unsealed capture cuts.
All original package bytes and selected snapshot rows remain retained evidence.

Every mutation persists its entire original command before POST. Lost responses,
remounts and conflicts lock new inputs. Pure destination receipt lookup does not
retry a mutation. Other assigned APIs provide exact-command replay but no pure
command receipt lookup; the UI states this limitation and requires a fresh explicit
confirmation to resend unchanged input. 409 clears review acknowledgement/selection
and confirmation and refreshes canonical evidence without automatically resubmitting
or treating a refreshed state as an exact command receipt. Interrupted filesystem/
SQL dispositions remain held until their original command can be reconciled.

Reliability confirmed the frozen1544 discovery limits by source review. There is
no global/deleted-owner import operation inventory: import creation/polling supplies
known IDs, and orphan staging metadata is evidence rather than an operation
selector. Branch destination discovery returns at most 50 entries and requires
current source execution ownership; no global/deleted-source admission inventory
exists. Known admission review/receipt remains independent of scoped discovery.
GROUP retirement remains refused.

Custody inventory/review does not return complete CheckpointPackageSource intent.
An issued-checkpoint receipt can contain the full source, but capturing status
contains only commandKey/state; unsealed capture source discovery is missing.
Current callers use actual import/Branch destination identities and the full source
returned by destination review. That review can refuse before destination deletion
proof, limiting Branch/capture reachability. They never infer missing intent from
custody hashes or accept pasted IDs. Exact Branch command references supply actual
capture keys; own checkpoint references supply IDs/hashes, excluding initial and
foreign checkpoints. No global source/capture selector is claimed.

Only destination retirement supplies a dedicated pure receipt GET. Custody,
import, memory, capture abandonment and Branch checkpoint retirement recover full
receipts through explicitly confirmed identical POSTs with the retained original
body. Current review state alone does not prove original command completion.
Capture abandonment committed replay survives owner deletion and verifies retained
bytes; Branch checkpoint retirement replay still requires retained owner command
and source identity, with no owner-independent host journal. These API limits
remain backend gaps; the UI does not present scoped recovery as global discovery.

Deferred source regressions: `tests/chats/lifecycle-command.test.mjs` exercises exact
approval/retirement and memory/import/custody/capture/Branch receipt boundaries;
`tests/chats/lifecycle-review-mounted.tsx` covers separate approval/retirement,
identical retained choice across response loss/remount, pure receipt reconciliation,
legacy-memory refusal and stale409 without automatic replay. Neither has run.

No tests/checks/types/build/Node/native/browser/runner preparation or execution,
installs, backend writes, workers, push, merge or deployment. Source integration
and executed lifecycle/native/remote-backend/accessibility/mobile qualification
remain open. No whole UI/lifecycle/#8/#12/#32/Bible/Phase2 pass is claimed.

Ten named deliverables for this continuation: `apps/web/src/components/lifecycle/`
`LifecyclePanel.tsx`, `LifecycleReview.tsx`, `BranchLifecycleReview.tsx`,
`lifecycleCommand.ts`; existing mounts `WorkspaceSettingsView.tsx`,
`ImportAgentDialog.tsx`, `branches/BranchDisclosureReview.tsx`;
`tests/chats/lifecycle-command.test.mjs`, `lifecycle-review-mounted.tsx`; and this
document. Corrupt/unreadable retained browser commands block new mutations rather
than silently resetting an unknown outcome. Branch selection is bounded to 128
exact owner checkpoints, matching the route's admission limit.
