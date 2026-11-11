# Historical web implementation snapshots

Archival source chronology; current limits are in web-feature-completion.md.

# Web implementation coverage

Base: `f64f631b490dbfc8125f0f7a2f8c649b6c54d19f`. Writer: Phase 2 UI and accessibility fixes.
Branch: `phase2/web-feature-completion`. Worktree: `/path/to/worktrees/phase2-web-feature-completion`.

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

## Bounded two-resource group UI continuation

Source-only successor of `6ddf47dfacb72b965bd224599852b4c6394f540c`. The original
consumer is `c462d40367d16d14f6d417e80e990c1850709de3`; exact pure capture status
requires Branch successor `1aa09968ebde45edde84a8e70315f7c95a857bae` in
`/tmp/ponderosa-branches-resource-groups` and its existing Runtime/core prerequisites.
The latter backend supports broader resource groups, but this UI remains bounded
to two serial resources. Integration must preserve the backend's existing exported
`BranchIssuedGroupCaptureStatus` in `packages/core/src/branches.ts`; it is not
redefined here. Backend DTOs/routes are source-read rather than copied into this
older web checkout. No backend routes, stores, migrations or grants are changed.

`BranchGroupReview` is mounted beside the singular review in `ExecutionPanel`.
Capture is offered only from a complete current standalone two-resource, one-path
view and a definition without fork/join/called Branch Steps. This is a presentation
bound, not a claim of capture eligibility. Generation, native drain, issued roots,
exact frontier/configuration/binding/audit pins and supported package contents remain
host-validated. The host capture input accepts only `{commandKey}`, with no count or
cut CAS input: if concurrent changes yield a broader result, this UI rejects its
status and keeps the original command held. It never prepares a broader group.
Only retained exact two-source GET capture status unlocks preparation, which also
requires a terminal source and explicit external-effects acknowledgement. Partial
capture, unsealed members and unknown imports stay held; no POST is replayed and
no group abandonment or per-member lifecycle fallback is offered.

The backend owner explicitly authorized minimal shared group output/client work.
`packages/core/src/branch-group-client.ts` exports `BranchGroupClient`, using the
caller's existing operator JSON transport, plus distinct group destination and
POST capture output DTOs. It reuses existing input/disclosure/group-resource DTOs.
This isolated web base lacks the backend's `branches-client.ts`; the new small
module avoids replacing or duplicating that larger SDK. It is exported from core's
index. GET capture returns status without package receipts; POST capture is a
separate receipt output. Helpers encode every opaque path/key and never retry.

Full original capture/prepare/choice/admission commands are persisted before POST
in browser localStorage scoped by origin, product, Branch and execution. Capture
and prepare keys remain after success so remounts can recover their canonical
server state. Unknown responses retain inputs and block new mutations. GET capture,
GET group `?commandKey=` and exact disclosure choice GET perform pure readback.
They run independently: source proof failure does not suppress destination/choice
readback or no-preview revocation. Retained capture, whole checkpoint/hash, exact
both-resource identities and destination scope are verified before use. Only an
exact admitted readback with the original admission/hash resolves pending admit.
Corrupt or unwritable storage blocks mutations. No UI identity entry is offered.

There is no group collection or original capture-key discovery API in frozen1aa.
Capture journals store only a hashed key and cannot recover the original from
checkpoint identity. This view therefore supports its own client-local retained
keys, not canonical cross-device/global group discovery. It does not adopt singular
destination discovery or decode hashed commands. Reliability's separately announced
lifecycle discovery work is not integrated or claimed here; it needs its committed
exact contract and a separately authorized caller continuation.

Preparation explicitly warns that the fresh ordinary Project reuses the current
owner Project's directory, creates the usual default Chat plus two resource Chats,
and creates no separate filesystem workspace/copy. No imported grant is adopted.
Both actual source package/resource identities, mapped fresh identities, whole-cut
hash, exact original private fact content/actor/audience/recipients, both final
policies and policy hash appear in one review. Human approval and atomic admission
are separate confirmations. The review binds the same full resource arrays and
checkpoint/admission/source identity as canonical readback. Approval is never
inferred from a historical receipt. Admission additionally requires matching current
persisted approval hash/revision and a newly acknowledged preview. Revocation uses
the current persisted revision/hash even without package bytes or preview. A choice
CAS409 clears review/confirmation and the rejected transactional choice; staging or
admission409 retains original input because side effects may already exist. Parent
source/definition/freshness changes discard review acknowledgement. No automatic
replay, independent member admission, retirement, source-pin release, >2/parallel/
tree/later-generation UI or broad lifecycle qualification is introduced.

Deferred regression source: `tests/chats/branch-group-review.test.mjs` covers both
seals, partial holds, resource/package/policy identity, corrupt retained input and
encoded SDK GET-only recovery. `tests/chats/branch-group-review-mounted.tsx` covers
capture/prepare/choice/admission lost responses, remount, policy CAS staleness,
whole private facts, independent source-failure recovery and no-preview revocation.
Neither ran. New required deliverables: `BranchGroupReview.tsx`,
`branchGroupReview.ts`, `branch-group-client.ts`, the two deferred regression files,
plus existing `ExecutionPanel.tsx`, core `index.ts`, and this document.

No tests/checks/build/types/Node/native/browser/runner preparation or execution,
installs, backend writes, push/merge/deploy or new workers. Integration and executed
qualification remain open; no whole UI/group/lifecycle/Bible/Phase2 acceptance.

## Canonical lifecycle discovery and whole-group retirement continuation

Source-only successor of `eba8fa646740aae741aad1e0f389ec30fdb6982e`, preserving the
bounded two-resource capture/disclosure UI. Required backend is exact discovery
`f73a1e5a44bdea1a5e29799416e423afffacfa30` atop composed group lifecycle
`393a02f5c0946fafcebe3577e5432fc9878bb448` in the documented Reliability chain.
The latter composes host0a9c1387/Runtime713af3ad plus393a02f5 callback/policy/native
proof source; Integration owns equivalent assembly. No backend files or shared SDK
source are copied or edited. Exact DTOs, SDK methods and routes were source-read at
`/tmp/ponderosa-lifecycle-discovery`. The older isolated web base continues to require
backend/core source integration before execution; this is not a standalone build.

Settings `LifecyclePanel` now mounts `LifecycleDiscovery`. Three independent
collections call the exact APIs exposed by `BranchesClient.lifecycleImports`,
`lifecycleDestinations` and `lifecycleCaptures`: GET `/api/lifecycle/agent-imports`,
`/destinations` and `/checkpoint-captures`, with limit50 and the returned opaque
cursor. Existing operator `requestJson` preserves product routing and request errors;
no larger SDK is duplicated into this older checkout. Each explicit Load more
preserves the original page revision. Only absence of nextCursor means end of
inventory. No latest50 ceiling is claimed. Invalid pages/revision changes and409
hide all stale entries, unmount selected reviews/confirmations, and require an
explicit restart of that collection. Completed other collections remain usable.
A restart also clears its selected review; unresolved original commands stay in
scoped localStorage rather than being discarded. Collections are on demand with
no polling/reconnect retry or automatic mutation.

Import choices use actual operationId and show product/status/phase, current versus
completed-deletion-receipt versus retained-only Project/Chat identities, journal or
retained-lifecycle origin and lifecycle state. unverifiedEvidenceCount supplies only
a warning, never a guessed operation ID. Destination choices show singular/group
kind, actual source Branch/execution/owner state, checkpoint/hash and every slot's
source Chat, destination Project/Chat/Run/Step and owner evidence class. Retained-only
is explicitly audit evidence, not inferred deletion, drain or action eligibility.
Only these defined metadata fields/hashes and the full capture source are displayed;
no import payload, private Request body or Branch snapshot comes from discovery.

Source capture collection is mounted independently of destination discovery or
retirement review. It passes exact returned `source:CheckpointPackageSource` and
`captureKey` into existing `BranchLifecycleReview`; the discovered key is immutable
presentation, not pasted input or inferred from custody IDs/reference hashes.
The existing Branch/combined abandonment review still decides eligibility. Discovery
does not change pins, authorize effects, manufacture deletion proof or permit group
multiple-package abandonment. No loop of singular capture abandonment is added.
The earlier frozen1544/frozen1aa discovery-gap descriptions remain historical
contracts: this continuation supplies canonical lifecycle discovery fromf73a1e5a;
it does not claim Branch group capture/prepare command discovery or capture CAS
preview from the Branch owner's separate unpublished successor.

Canonical discovered group admission IDs open `LifecycleReview kind=group` using
GET `/api/lifecycle/destination-groups/:id/review`, separate POST `/approve` and
`/retire`, and pure GET `/receipt`. Shared DestinationGroupRetirementReviewDto
preserves the entire2–32-resource reservation, all retained slots and evidence
revision. Group preview refuses missing group resource/slot inventories. Every
resource and slot is displayed in the expandable current evidence; warnings explain
whole-group atomicity, independently completed destination deletion, global runtime
quiescence, policy/native evidence staleness, permanent preserve-only choice and
remaining source references. Human acknowledgement and explicit pin disposition
produce one stable command/hash/body saved before POST; approval never auto-retires.
Retirement reuses that exact body under separate confirmation. Lost response/remount
uses pure receipt lookup without POST. Existing canonical receipt inspection is also available without a saved command or
successful review, displayed only as historical evidence and never as a new choice.
Receipt recovery must bind original admission, key,
review hash and pin disposition plus group resources/slots/evidenceSha256; a singular
receipt cannot satisfy group recovery.409 resets confirmation/acknowledgement while
retaining the original uncertain command. No hidden upgrade from preserve-only or
silent hash replacement is available. Singular retirement callers stay separate;
group reviews do not mount a loop of singular lifecycle actions.

Deferred regression additions: `lifecycle-discovery.test.mjs` covers paging beyond50,
opaque cursor/revision preservation and invalid/changed page refusal;
`lifecycle-command.test.mjs` now covers group versus singular receipt evidence;
`lifecycle-discovery-mounted.tsx` covers retained owner metadata,51st import,
paging409 reset, independent capture source after group proof refusal, every group
slot, separate approval/retirement with identical choice, lost response/remount and
pure receipt lookup. These are source fixtures only; none executed.

Ten deliverables: `apps/web/src/components/lifecycle/LifecycleDiscovery.tsx`,
`lifecycleDiscovery.ts`, `LifecyclePanel.tsx`, `LifecycleReview.tsx`,
`BranchLifecycleReview.tsx`, `lifecycleCommand.ts`; `tests/chats/`
`lifecycle-discovery.test.mjs`, `lifecycle-discovery-mounted.tsx`, and updated
`lifecycle-command.test.mjs`; plus this document (ten files total).

No tests/checks/types/build/Node/native/browser/runner preparation or execution,
installs, migrations, backend writes, push/merge/deploy or new workers. Source
integration and executed lifecycle/native/accessibility/mobile qualification remain
open. No whole UI/group/lifecycle/Bible/Phase2 acceptance is claimed.


Historical integration note (superseded by6b1f7a398): lifecycle discovery/group retirement successor12e744222 is assembled
with equivalentf73a/393 backend source and Branch e7d27801 group command discovery/CAS.
This successor does not adopt e7 capture preview/CAS: the existing eba8 capture UI still
sends commandKey only, so new capture POST is incompatible until its separate successor.
Lifecycle Settings discovery/retirement is distinct from that pending Branch capture UI.
All execution qualification remains deferred.

## Canonical group commands and authoritative 2–32-resource capture continuation

Source-only successor to UI `12e744222fa1f3d0e07ac72ac8d34a14fe93d2e5`.
Required backend is the committed Branch group discovery/capture-CAS contract at
`e7d27801a3dc2e9605f261b246d5ce59deb9da69`, direct parent
`a2581922eeb67ec059a99b6ee5d908e30c987df5`, in
`/tmp/ponderosa-branches-group-discovery`. Actual routes, shared DTOs, SDK and
`docs/branches-two-resource-destination.md` sections on canonical discovery and
capture comparison were source-read. Preserve its assembled group consumer and
Runtime/lifecycle ancestry or equivalent hunks; Integration owns equivalent
assembly. Previous lifecycle discovery still requires `f73a1e5a44bdea1a5e29799416e423afffacfa30`
and whole-group lifecycle `393a02f5c0946fafcebe3577e5432fc9878bb448` or equivalents.
Earlier two-resource/browser-only descriptions above record the previous source
contract; this continuation replaces those limits for group command discovery,
capture and exhaustive disclosure in `BranchGroupReview`.

Capture now starts with pure GET `.../destination-groups/capture-preview`. The
server decides supported standalone serial/local-parallel eligibility, current
host cut, owner/drain and all generation-zero resource identities. The UI rejects
malformed previews, fewer than 2 or more than 32 resources, duplicate Steps/Chats,
later generations and invalid cut hashes. Every resource/participant, review hash,
version, binding revision, frontier and host-cut hash is visible. Separate explicit
inventory acknowledgement, effects acknowledgement and final confirmation precede
POST. The original preview and exact `{commandKey,reviewHash,versionId}` are saved
before effects; no substitute fresh hash or cut is sent after an uncertain outcome.
The pure status GET must independently show every exact source Step/Chat and seal
before prepare. No local resource-count or serial-path heuristic authorizes capture.
Called trees, unsupported native/package payloads and later generations remain
subject to server refusal, with no new payload support in this UI.

Canonical GET `/api/branches/destination-groups/discovery?kind=captures|admissions&limit=50`
lists exact original keys, source Branch/Run, resource count, checkpoint/admission
identity, state and current/retained source-owner presence. Explicit Load more
follows the opaque cursor until absent. Any DB write or daemon restart may stale
that cursor. Invalid/409 pages remove stale rows, selected readbacks and review/
confirmation state; restart is explicit, with no automatic cursor restart or action
replay. Pending original command inputs remain intact. The collection is global
operator audit; it is not a claim of current action eligibility or owner deletion.
Legacy missing original keys are labelled unsupported; no key reconstruction,
pasted IDs or browser guesses are offered.

Selecting a canonical capture uses its exact key for GET status, verifies count/
checkpoint/hash, and retains the canonical saved review/version with returned Step
identities. Selecting an admission uses its exact prepare key and checkpoint/hash
for GET command readback, verifies admission/count/exhaustive resource identities,
and can recover this source Run without needing a capture key or browser history.
The retained preparation identity is only for GET/result binding; discovery does
not supply optional original import settings, and it is never replayed as POST.
Other source Runs can also be inspected through their exact scoped pure GETs here;
those results are audit evidence, and disclosure actions require opening that source
Run. Deleted/missing source owners can still make scoped GET refuse, although their
retained discovery identity is visible. Missing owner-independent command readback
is reported as a backend refusal, never replaced by POST. Lifecycle review for
canonical discovered admissions remains separately available in Settings.

Every resource package/map and every current policy now participates in whole-group
preview matching for 2–32 resources. The whole private fact/actor/audience/recipient
inventory remains explicit. Approval, revocation and atomic admission remain
separate; unknown import/staging/admission slots stay held, exact commands remain
persisted, pure choice/destination reads recover outcomes, and no mutation replay
is introduced. Revocation remains possible after independent source preview refusal.
Fresh Project directory reuse/default Chat/per-resource Chats/no separate workspace
warnings remain visible. Partial group capture abandonment uses a separately assembled backend protocol;
all unresolved member pins remain held. Retirement remains the separate lifecycle
surface, not a loop over members here.

The UI-owned additive `BranchGroupClient` now imports the backend owner's named
`BranchGroupCaptureInput`, `BranchGroupCaptureResult`, `BranchGroupCapturePreview`, and `BranchGroupDiscoveryPage`
from `branches.ts`; it adds only transport methods for the exact existing routes.
This older UI base does not contain those backend DTO declarations, as with the
previous backend group-status dependency: integrate the required backend/core
successor before qualification. Core ownership was coordinated with Branch owner;
no edits to their `branches.ts`, `branches-client.ts`, routes, stores or migrations.
Preserve both additive UI client and backend SDK during assembly.

Six deliverables: `apps/web/src/components/branches/BranchGroupReview.tsx`,
`branchGroupReview.ts`, `packages/core/src/branch-group-client.ts`,
`tests/chats/branch-group-review.test.mjs`, `branch-group-review-mounted.tsx`, and
this document. Existing ExecutionPanel mounting and core barrel exports are reused.
Deferred fixture source covers 2/3/32 complete inventories and last-resource policy
binding, malformed/later-generation cuts, exact preview/CAS transport, stale preview,
three-resource local-parallel presentation, lost capture/prepare/choice/admit responses,
remount without POST replay, no-preview revocation, empty-browser canonical recovery,
51st discovery row, legacy missing keys, opaque pagination and cursor409 reset.

No tests/checks/types/build/Node/native/browser/runner preparation or execution,
installs, backend writes, push/merge/deploy or new workers. Fixtures are unexecuted.
Source integration and separately authorized executed runtime/native/accessibility/
mobile qualification remain open; no whole UI/group/lifecycle/Bible/Phase2 acceptance.



Current integration note: UI6b1f7a398 now sends and persists the required exact
commandKey/reviewHash/versionId; the earlier caller mismatch is resolved. Both SDKs
and their shared DTOs are preserved. Branch owner correction
f623c81ffe0cfee94ab447580617b61589460b13 is now assembled: the synchronous
preview helper runs inside a same-connection SQLite read transaction, including
safe savepoint nesting when a transaction already exists. This resolves the source
dependency described by UI docs51704f458; no executed usability claim.

The separate whole-group abandonment backend protocol is also assembled source only.
Its fourth lifecycle collection and review/abandon UI are now assembled below.
Retained/sealed groups and history/disk reclamation remain separate.


## Unsealed whole-group capture abandonment continuation

Source-only successor to UI `51704f458fb3f1e30905156a8fb8825bc46bb47a`.
Required exact backend contract is composed `9bbdaad1bd8aa42b30a07cb8460d4a67eb8a092e`
at `/tmp/ponderosa-group-capture-abandonment`; its actual shared DTOs, SDK methods,
routes, host protocol, Branch receipt and docs were source-read. Its base is
`e7d27801a3dc2e9605f261b246d5ce59deb9da69`, with successors
`bdcd53812eded821a4f201eea8eafde3416dac21` (lifecycle discovery replay),
`535301c242b960e9e3925e43e184b5f387db481b` (host protocol replay),
`46ba3475ed9d61cd19f9a17c3770acced176ab7a` (canonical owner replay), and
`9bbdaad1` composition/tightening. Preserve equivalent originals instead of duplicate
replays. Integration owns backend/core assembly; this older UI checkout consumes
backend-owned DTOs without copying their declarations or SDK. The separate capture-preview read-transaction correction f623c81ff is already
assembled. This abandonment continuation does not qualify the capture/CAS producer.

Settings lifecycle discovery now mounts a fourth independent canonical collection:
GET `/api/lifecycle/checkpoint-capture-groups?limit=50&cursor=...`. It follows opaque
cursors under one revision using explicit Load more, until absent. A malformed or
changed/409 inventory clears the selected review and confirmations and requires
explicit restart; the other three collections remain independent. Each row exposes
its exact original execution ID, raw persisted `issued-group-capture:<hash>` key,
all full sources, captured checkpoint IDs, current/retained-only owner label and
evidence digest. Distinct 2–32 generation-zero sources/Chats/participants and captured
membership are validated. The raw lifecycle key is different from the plaintext
command used by the separate capture producer; it is neither guessed nor converted.
No destination deletion/review gate, manual ID, inferred deletion or private payload
is added. Retained-only labels supply audit identity, not deletion/drain authority.

`GroupCaptureAbandonmentReview` uses POST
`/api/lifecycle/checkpoint-capture-groups/abandonment-review` with only the discovered
`{executionId,captureKey}`. It binds the complete returned source/package inventory,
group/capture/Branch revisions, per-package file names/lengths/hashes, references,
blockers and review digest. Any top-level or non-first-package hold blocks the whole
group. Zero and partially captured groups are supported by the backend contract;
fully retained/sealed groups require separate history protocols and are not offered
here. Every captured and uncaptured member is shown, with explicit warnings that
all bytes and uncaptured identities remain preserved, disk/history are not reclaimed,
external effects are not replayed, and no member can use a singular fallback.

Human review acknowledgement and a separate final confirmation create one stable
original `{executionId,captureKey,commandKey,reviewSha256,preserveEvidence:true}`.
The whole original entry, reviewed inventory and exact input are stored before
POST `/api/lifecycle/checkpoint-capture-groups/abandon`. There are no automatic
mutation retries, loops over singular abandonment or fresh-hash substitutions.
Unknown responses, filesystem partial progress, SQL failures and409 keep original
commands retained. Stale review/confirmation state clears. No partial package result
is interpreted as canonical success or a subset pin release.

This backend has no pure receipt GET for abandonment. Recovery is an explicit,
separately confirmed unchanged POST, which the host verifies against immutable
archives even after owner removal. A saved-command recovery section scans only this
origin/product's own validated original command records. It can reopen the exact
historical canonical identity after a committed intent vanishes from discovery,
without requiring live source/destination review or inventing a new command. Corrupt
saved input remains held and is not overwritten. Recovery-only views cannot create
new choices. The receipt must match group ID, original key/review, every package
identity/review/retained byte count and the whole Branch input/source/proof inventory
before pending input is removed. Byte/hash verification itself remains authoritative
in the host; the UI does not infer archive success from filesystem progress.

Branch receipts include an original private capture snapshot for durable backend
proof. The UI deliberately displays only disposition metadata, exact identities and
package proofs; it does not stringify the raw Branch receipt/snapshot. Existing
private payload boundaries and the 2–32 capture-preview/CAS flow remain unchanged.

Seven deliverables: new `apps/web/src/components/lifecycle/`
`GroupCaptureAbandonmentReview.tsx` and `groupCaptureAbandonment.ts`, updated
`LifecycleDiscovery.tsx`; new `tests/chats/group-capture-abandonment.test.mjs` and
`group-capture-abandonment-mounted.tsx`, updated
`tests/chats/lifecycle-discovery-mounted.tsx`, and this document. The backend already
exports the DTOs through core; no shared SDK/backend/store/route/migration writes.
Deferred fixture source covers zero/partial capture metadata, non-first-member
holds, every package proof, raw-key validation, missing/mismatched receipts, private
snapshot suppression, corrupt storage, origin/product isolation, fourth inventory
independence from destination refusal,51st record/opaque cursor409 reset, FS-success/
SQL-failure held input, remount after owner/discovery removal, and explicit identical
POST recovery. Existing lifecycle mounted fixture recognizes the added collection.

No tests/checks/types/build/Node/native/browser/runner preparation or execution,
installs, backend writes, push/merge/deploy or new workers. Fixtures are unexecuted.
Remaining: fully retained-group history/disk reclamation, unsupported/unknown schemas
and outcomes, external writers, and separately authorized source integration and
runtime/native/accessibility/mobile qualification. No whole UI/group/lifecycle/
Bible/Phase2 acceptance is claimed.

## Historical group journal audit continuation

Source-only successor to UI `1d6e5da77a9d779921a50541f9685f73e96d9aa4`.
Requires exact backend/core `38ec699b6579715740513ce30a41a38722be4401`, direct parent
approved `3f9b74e1c2077a21d99603110d661252fd1cc86a`, at
`/tmp/ponderosa-group-audit-readback`. Actual discovery producer, audit service,
shared DTO/SDK, canonical audit reader and `docs/group-journal-audit-readback.md`
were source-read. Integration owns equivalent backend/core assembly; prior capture
CAS/read-transaction and group-abandonment dependencies remain preserved.

Canonical group command discovery now exposes `item.auditSelection`. The UI passes
that exact object to its additive `BranchGroupClient.journalAudit` adapter, equivalent
to backend SDK `BranchesClient.groupJournalAudit(selection)`: GET
`/api/lifecycle/destination-groups/journal` with every original query field. Journal
key, journal hash, custody hash, source Branch/Run, optional original command and
admission/reservation identity are neither reconstructed nor replaced. The adapter
imports backend-owned `GroupJournalAuditSelection`/`GroupJournalAuditReadback` DTOs;
no edits or duplicate definitions in backend `branches.ts`, `branches-client.ts`,
`lifecycle-reconciliation.ts`, routes, stores, owner hooks or migrations. Prior
additive UI-client ownership is preserved; keep both client modules in assembly.

Every discovered row with a selector mounts a separate `GroupJournalAudit` panel.
It remains available after a scoped current-owner GET refuses. Legacy capture rows
without plaintext commands still forbid ordinary capture-command recovery while
allowing exact raw-selector audit; older items/servers without selectors display an
explicit unavailable explanation. Missing or erased original journals cannot be
manufactured from custody/reservation metadata. Other source Runs and missing source
owners are inspected through the owner-independent audit route, not a substitute
current-authority read.

The panel requires `historical:true`, `currentAuthority:false`,
`actionEligible:false`, `held:true`, exact returned selector/journal hash, evidence
digest and complete resource/member/owner inventory. The displayed evidence includes
all capture sources/receipts/disposition, destination resources/full ID and Agent
maps, every import status, owner/command presence, canonical receipt and verified
retirement projection. Unknown imports remain held. Source/owner absence is never
presented as deletion, drain, disclosure authority or eligibility. Private Request
bodies, snapshots, configuration and package bytes are suppressed by the backend;
the UI additionally projects only known audit fields and omits unexpected top-level
or capture-disposition raw snapshot fields.

Audit is a separate read-only state/component: results are never assigned to scoped
capture status, prepared destination, disclosure review, saved command or lifecycle
mutation state. Starting audit clears existing review acknowledgements/confirmations.
No audit control offers approve, prepare, admit, cleanup, package reads, hydration,
reimport or replay. Existing scoped reads/actions still retain their authority checks
and exact-key/unknown-outcome protocols. Scoped refusal clears scoped results but
preserves discovered audit selectors. Audit refusal, including selector/hash/custody/
reservation conflict409, clears audit and discovered selection, invalidates scoped
review/confirmation state and requires explicit rediscovery. There is no automatic
audit retry, selector refresh or fallback mutation.

Seven deliverables: new `apps/web/src/components/branches/GroupJournalAudit.tsx`
and `groupJournalAudit.ts`, updated `BranchGroupReview.tsx`;
`packages/core/src/branch-group-client.ts`; new
`tests/chats/group-journal-audit.test.mjs` and `group-journal-audit-mounted.tsx`;
and this document. Existing execution mounting and core exports are reused.
Deferred fixture source covers exact/legacy selector binding, stale journal/custody/
reservation envelopes, all nonauthorizing flags, exhaustive maps/non-first imports,
private snapshot suppression, exact query transport without POST/retry, audit after
scoped missing-owner refusal, legacy-key audit without plaintext reconstruction,
stale409 clearing/explicit rediscovery and no mutation controls from audit evidence.

No tests/checks/types/build/Node/native/browser/runner preparation or execution,
installs, backend writes, push/merge/deploy or new workers. Fixtures are unexecuted.
Remaining: journals actually erased by owner deletion,
actual deletion/provider/native qualification, and separately authorized executed
runtime/accessibility/mobile verification. Audit adds neither a retention writer nor
reclamation or action authority. No whole UI/group/lifecycle/Bible/Phase2 acceptance.

Integration: backend38ec is assembled as61386c0ed; preview read-transaction f623 equivalent and whole-group abandonment9bb remain preserved. The precleanup producer and independent Branch-owner guard are assembled ate4cdff692; this UI adds no generation-exit controls or execution qualification.

## Bounded serial generation-one UI source

Successor to UI `19bb4f26dc3c95aa1b7538423fd8fd104a5dfd8c`; source only,
not executable qualification. Requires exact backend/core
`1fb4b4e541e623c4295131e0575e013d6c3dab20` from
`/tmp/ponderosa-branches-generation-one`, specifically the actual contract in
`docs/branch-generation-one-destination.md`, BranchesClient, branches DTOs,
coordination-destination DTOs, issued resource service and routes. This older UI
base intentionally imports the successor's named BranchGenerationOnePreview,
BranchIssuedResourceCaptureDto and historical selection fields; it does not
copy or modify backend-owned contracts. Existing requestJson operator transport
calls the exact SDK wire contract; no additional shared adapter is needed.
Prior group capture/CAS, preview transaction correction f623c81, group abandonment
9bb tightenings and historical group audit dependencies remain required.
Historical group audit partition correction ff40d389fe37d566fb6d513e24153b101ca168a5
is a separate required source successor for bounded historicalPartition summaries;
it does not change journal selectors or grant action authority.

The existing singular destination dialog mounts bounded generation-one surfaces
for canonical resource Step IDs from the Run DTO. Pure GET generation-one-preview
supplies exact reviewHash, historicalReviewHash and one original retired selection;
no old IDs/maps are entered or inferred. Only generation 1 and one exact retired
generation-zero selection with complete checkpoint/envelope/fence/current-ref
identities are accepted. Server eligibility remains authoritative: standalone
manual serial one-resource ASYNC/SYNC, failed first attempt and retry attempt 2
of 2. Parallel, called-tree, generation >1 and unknown evidence are refused by
the producer; this UI does not broaden that bound.

Explicit acknowledgement plus separate confirmation persists the complete
original preview and {commandKey,expectedGeneration:1,expectedReviewHash} before
POST issued-checkpoint. A separate pure GET issued-checkpoint with that original
key must match full selection/hash and retained checkpoint before preparation.
Lost response, conflict, pending capture and corrupt saved command remain held;
no capture POST retry or replacement hash. Remount uses the original saved key.
Empty-browser recovery explicitly GETs bounded generation-one-captures, then
reads the chosen canonical original key and saved selection via GET status.
The inventory is server-bounded to100, refusing overflow rather than implying
pagination. Failure clears stale inventory/preview/confirmation and parent
preparation selection; rediscovery is explicit. Unknown capture pins stay held.

Preparation reuses singular command persistence, confirmation and readback with
exact historicalReviewHash from that capture. The full saved server selection
stays with the local pending preparation command; returned historicalPartition
must equal it before resolving pending status. The wire input does not accept a
human selection: the server derives/reserves it from the hash. Retained preparation,
choice and admission commands survive409 for pure original-key receipt inspection;
no POST replay or external-effect replay. Fresh review/reapproval remains required
for policy drift, and revocation remains available independently of a new review.

Human disclosure displays every original fact, actor, audience, hash and mapped
fresh recipient, marking historical_generation facts as retired generation-zero,
nondispatchable evidence. Full retired selection and custody are separate from
current package participant maps and final policy. Matching requires the exact
reservation/target historical selection, all current source refs and the complete
server review fact inventory, including actor/audience/recipient metadata. The
explicit all-facts checkbox and separate approve/admit confirmations remain.
Only current generation-one package participants become fresh live maps. Original
Project audit-read and fresh destination Project ownership are separately required
by the server; neither creates a new authorization mechanism. Retirement receipt display projects only selection/hash/nondispatchable metadata,
excluding native seal and raw retirement result bytes. Native/process and
private payload expansion are not added.

Deliverables: apps/web/src/components/branches/BranchGenerationOne.tsx,
branchGenerationOne.ts, BranchDisclosureReview.tsx, branchDisclosureReview.ts,
ExecutionPanel.tsx; tests/chats/branch-generation-one.test.mjs and
branch-generation-one-mounted.tsx; updated branch-disclosure-review.test.mjs and
branch-disclosure-review-mounted.tsx canonical fact inventories; this report. Deferred fixtures cover exact
selection/CAS, malformed/other-generation cuts, omitted facts/actor/audience/map
drift, consumed attempts, save-before-POST, lost response/remount/pure GET,
empty-browser exact canonical discovery and409 clearing/no replay. Existing
singular fixtures remain applicable. No fixtures have been executed.

No tests/checks/types/build/Node/native/browser/runner preparation or execution,
installs, backend writes, push/merge/deploy or new workers. Integration owns
backend/core/equivalent source assembly. Runtime, native/provider, accessibility,
mobile and all full Phase2/Bible qualification remain open. Journals actually
erased by source deletion remain unavailable; no retention writer or reclamation
is introduced.

Integration: backend/core1fb4b4e is assembled asf94aedeaa and ff40 historical audit identity/privacy correction is assembled asba14fb7bc. This UI successor is now source-connected to those contracts; no reference backend copies or ancestor replay. Current called-tree producer, original owner fences, group UI and lifecycle source remain preserved. Historical generation-one selection/review UI is delivered only for the bounded serial case; all executed qualification remains deferred.

## Bounded serial generation history 1–32 UI source

Successor to UI `678493cab9f2674d03e73911ebaa14fd0fae8a04`. Required exact
backend/core: `cbe266387da53f24344285b1a2d052fcaf780568` at
`/tmp/ponderosa-branches-generation-chain`, including actual
`docs/branch-generation-one-destination.md`, BranchGenerationHistoryPreview,
BranchesClient.previewGenerationHistoryCapture/listGenerationHistoryCaptures,
issued-resource status generation, resource routes and service, complete chain
producer and historical disclosure reader. This older UI base intentionally
requires those backend-owned DTO fields. Existing requestJson uses the exact SDK
wire endpoints; no additional shared adapter/SDK/DTO/backend edits. Prior group,
lifecycle, abandonment, historical audit and preview-transaction dependencies
remain required or must be preserved as verified equivalents during assembly.

Existing generation-one UI modules now use GET generation-history-preview and
GET generation-history-captures, followed by the unchanged exact issued-checkpoint
POST/status GET and singular prepare/disclosure/admit routes. Existing backend
generation-one routes remain restricted/compatible; no server fallback or route
mutation is introduced. The storage key and generationOne command property remain
unchanged deliberately: existing pending generation-one commands and preparations
must retain their original selections and pure GET recovery. A prior saved gen1
preview without budget metadata stays inspectable; it is not converted to a new
preview or used to issue another capture POST.

New previews require source generation1–32, ALL exactly ordered selections0..g-1,
matching execution/Step, unique checkpoint/envelope/fence identities, complete
hashes and equal current package source-ref audiences. They also require exact
server consumedAttempts=g+1 and maxAttempts in [consumedAttempts,33]. Every retired
selection/package identity/hash/fence/current-ref audience is displayed separately
with its original generation. Current source generation and both server budget
values are explicit. Nothing resets/replenishes retry allowance; destination
generation numbering is separate from consumed original attempts. Server alone
proves manual standalone one-resource serial ASYNC/SYNC eligibility. Parallel,
called trees, generation>32, offset restore and unknown evidence remain refused;
the server's 32 MiB historical-evidence bound still applies even at32 selections.

Capture confirmation persists the complete original preview including ordered
history/budget and exact {commandKey,expectedGeneration,expectedReviewHash} before
one POST. Pure status must match generation, original cut/history hashes and
EVERY ordered saved selection before a retained checkpoint can feed preparation.
Stale/invalid data clears selected preparation/preview/confirmation; the original
pending command remains held. No mutation retry, automatic read retry, fresh-cut
hash replacement, budget inference, effect replay or old Agent import is added.
Malformed saved commands remain held. Discovery is bounded100 by the server and
client, refusing overflow/duplicate keys rather than pretending it is paginated.
A pending local original command prevents choosing another discovered capture as
its replacement; canonical discovery never supplies guessed IDs or map entries.

Contract limitation: capture discovery/status DTO includes generation, selections
and hashes but DOES NOT include consumedAttempts/maxAttempts. When saved original
preview metadata exists, it remains displayed and persisted unchanged. Empty-
browser/status-only recovery copies the exact canonical selection/generation/hash
fields and explicitly marks budget metadata unavailable. It never supplies
invented budget values, fetches a fresh preview to substitute a different cut, or
claims the status proved a retry limit. Server historicalReviewHash/cut validation
and destination composition remain responsible for preserving actual attempt and
configured maxAttempts. Extending status budget metadata would be a separate
backend-owned contract change, not implemented here.

Preparation persists the entire original selection list beside its command and
uses exact server historicalReviewHash. Pure preparation receipt recovery must
return the identical whole historicalPartition before pending input clears.
Disclosure now requires exactly one ordered original sealed fact bundle for each
prior generation; its seal execution/Step/generation/checkpoint/envelope/fence
and original participants must match that selection. Every bundle must use the
complete CURRENT package source-ref audience and map to exactly the fresh
recipients; retired Agents cannot appear in either side of executable maps.
Complete current plus historical fact metadata remains bound to the server review,
with original actors/audiences, every original package, current custody/participant
maps and final policy displayed. Per-bundle labels come from verified original
seal generation, never a guessed journal identifier. Explicit all-facts human
acknowledgement, separate approve/revoke/admit, policy drift reapproval and exact
pending-command GET recovery remain reused. Original Project AND original Request
Project audit-read stay separate from fresh destination Project authority. Receipt
projection still excludes raw retired native seal/retirement bytes; no additional
private-byte surface is introduced.

Ten deliverables: apps/web/src/components/branches/{BranchGenerationOne.tsx,
branchGenerationOne.ts,BranchDisclosureReview.tsx,branchDisclosureReview.ts};
tests/chats/{branch-generation-one.test.mjs,branch-generation-one-mounted.tsx,
branch-generation-history.test.mjs,branch-generation-history-mounted.tsx,
branch-disclosure-review-mounted.tsx}; this report. Existing ExecutionPanel mount
is reused without changes. Deferred 2/3/32 fixtures cover ordered complete history,
budget bounds/no reset, omitted/reordered/aliased/non-first package evidence,
current-only refs/maps, per-generation package labels, all-facts approval,
save-before-POST/exact CAS, lost response/remount/original-key pure status,
empty-browser canonical status without fabricated budget, last-selection receipt
refusal and exact GET preparation recovery. Existing gen1 helper fixture now uses
the real original-seal shape; singular mounted fixture explicitly resolves a409
held choice by matching original-key GET before a new choice. All fixtures remain
UNEXECUTED.

No tests/checks/types/build/Node/native/browser/runner preparation or execution,
installs, backend writes, push/merge/deploy or new workers. Source review only;
no passing, restored-runtime or live-provider claim. Remaining: backend/core
source assembly, status-only budget metadata limitation above, actual retry and
native/provider/filesystem custody qualification, accessibility/mobile execution,
and all full UI/group/lifecycle/Bible/Phase2 acceptance. No retention writer,
reclamation, budget reset or offset restore is added.

Integration: required cbe266387 backend/core chain is already assembled as b5ed36c58 (coverage96ea1594e); no reference backend copies or ancestor replay. This successor supersedes the earlier UI generation-one-only and fixed attempt2of2 limitation. The subsequent saved-budget backend/UI integrations below resolve the status-only contract/adoption gap in source; no executed qualification is claimed.


### Saved generation-history retry budget successor (source only)

UI successor to `7b28b68eb8a1a5d809676025226aeca2dcd1f32a` requires backend/core
`df05c945bc97c40c1be1701d10da0927aa786da3` from
`/tmp/ponderosa-branches-generation-chain`, including its shared DTO and saved-proof
reader. This supersedes the earlier status-only missing-budget limitation above.
The actual contract is `retryBudget: {state:'verified', consumedAttempts,
maxAttempts, evidenceHash}` with identical top-level numbers, or
`{state:'unavailable', reason:'missing_saved_retry_proof'}` without numbers.
Legacy absent proof is honestly unavailable; malformed present proof or numbers
without verified proof refuse. UI checks bounded generation/attempt counts and
hash shape; backend verifies the saved snapshot, pinned definition and retained
checkpoint seal. The hash is evidence, never source policy or action authority.

Canonical discovery copies the exact generation, ordered historical selections,
review/hash and saved budget evidence into pure original-command status recovery.
A changed proof hash, cut, selection or conflicting saved preview budget stays
held; the UI clears stale discovery and requires explicit rediscovery. No fresh
preview substitutes for recovery, no POST retries, no retry reset or old-Agent
import. Legacy status cannot downgrade previously verified discovery evidence.
Original preview budget values remain intact when legacy status has no proof.
Verified status budget/hash is visible and reaches preparation alongside the
unchanged cut; legacy unavailable status shows no invented numbers.

Deliverables: `apps/web/src/components/branches/branchGenerationOne.ts`,
`BranchGenerationOne.tsx`, `tests/chats/branch-generation-history.test.mjs`,
`branch-generation-history-mounted.tsx`, and this report. Deferred pure fixtures
cover malformed/unavailable/verified budgets, missing/mismatched top-level values,
proof/hash/budget conflicts, exact cuts/checkpoints and preserved legacy preview.
Deferred mounted fixture covers empty-client discovery, changed-proof hold,
explicit rediscovery and exact GET preparation recovery without fresh preview.
No tests/checks/types/build/Node/native/browser/runner preparation or execution,
backend writes, installs, push/merge/deploy or new workers. Backend assembly and
separately authorized runtime/provider/native/filesystem/accessibility/mobile
qualification remain; no Phase 2 acceptance claimed.

Integration: df05c945 backend/core is already assembled as57eab4596 (coverage40f4472be). This UI successor adopts that exact DTO without SDK/backend writes, ancestor replay or reference-source copies. Source-only status budget adoption is delivered; real runtime and broader qualification remain open.


### Server-classified bounded local parallel history (source only)

Successor to UI `cd92e8b06c6eeac07e1afbe8e22d51f67293dec3` requires exact
backend/core `bc524ed308a615a613ecb4360563998ec855f039` at
`/tmp/ponderosa-branches-parallel-history`, including
`docs/branch-local-parallel-history.md`, shared preview/status DTOs, canonical
capture status/discovery and the original source history validators. Previous
backend/core and UI dependency requirements remain, or verified equivalents.

Fresh history previews require server `historyKind: 'serial' | 'local_parallel'`.
The complete preview, including classification, is saved before capture POST.
Canonical discovery copies classification intact; issued status must match any
previously classified preview/discovery, original ordered selections, cut/hash,
verified budget/evidence hash and retained current checkpoint ID/hash. Unknown
classification or a classified status without verified saved-budget proof refuses.
Legacy absent classification stays explicitly unavailable, never inferred from
UI layout, siblings or budget numbers. Original unclassified commands can still
recover exact status, adopting classification only when actually supplied by the
server; fresh preview cannot replace that original cut.

The UI now explains the actual bound: one standalone manual owner and one resource
Step invocation, generations 1–32, ASYNC/SYNC, serial or local fork/join and one-item
map only after server proof; settled siblings without Request roots/active effects,
unchanged consumed attempts and pinned retry limit. Multi-item maps, multiple
resource invocations, active/unknown siblings, called trees, offset restore and
unsupported generations remain refused. UI does not implement a second eligibility
validator or inspect workflow shape. Historical actors/audiences/packages remain
nondispatchable evidence; current recipients/maps and all-facts policy approval stay
separate. No old-Agent imports, effect replay or retry reset.

Preparation persists matching preview/capture classification with the original
selection, verifies that pair before enabling preparation, and validates it again
when resolving the saved preparation receipt. The actual preparation DTO/receipt
has no historyKind field: the wire still sends only original checkpoint/hash,
historicalReviewHash, command key and reconcileEffects. Receipt must match the
saved current checkpoint and full historicalPartition; no invented classifier
field is sent or expected. Original Project/historical Request Project audit-read,
private byte projection, pending/corrupt command holds, explicit stale rediscovery
and pure original-key GET recovery remain.

Seven deliverables physically inventoried/source-read: UI
`apps/web/src/components/branches/{branchGenerationOne.ts,BranchGenerationOne.tsx,BranchDisclosureReview.tsx}`;
`tests/chats/{branch-generation-history.test.mjs,branch-generation-one-mounted.tsx,branch-generation-history-mounted.tsx}`;
this report. Deferred fork/join and one-item map transport fixtures cover
1/2/32-generation preview CAS, save-before-POST, lost-response/remount GET,
classification mismatch hold, canonical recovery, full saved preparation and exact
receipt readback. UI receives the same local_parallel discriminator for fork/map;
actual shape/settled-sibling eligibility is covered by backend-owned producer
fixtures, not manufactured in UI fixtures. Legacy unavailable and unknown kinds,
missing proof, current-checkpoint and budget conflicts remain covered.

No tests/checks/types/build/Node/native/browser/runner preparation or execution,
installs, backend writes, push/merge/deploy or new workers. Fixtures unexecuted.
Remaining: backend/core assembly and separately authorized runtime/provider/native/
filesystem/accessibility/mobile qualification. No full UI/lifecycle/Bible/Phase2
acceptance claimed.

Integration: bc524ed backend/core is already assembled ase5e677551 (coverage6c3f9dcfe). This UI successor adopts that exact server historyKind and saved budget contract without backend/SDK writes or ancestor replay. Bounded parallel UI adoption is delivered in source; all executed qualification remains deferred.
### Called parent/child group destination and standalone multi-item generation zero (source only)

UI successor to `5c4accc096de441ac21ff01eb1c5abf339102afa` requires exact
backend/core `47ec3a1e8087d2d0225952cd0f98ac6598262e8b` at
`/tmp/ponderosa-branches-tree-consumer`, including
`docs/branch-issued-owner-tree-destination.md`, actual tree preview/status/discovery
DTOs, group scope/ownerMap and Runtime per-owner evidence integration. Previous
history/audit/lifecycle/abandonment dependencies remain required or verified equivalents.
The prospective selectable journal retention successor
`e68dedeedc85d1355fad5f4672339a52675b69a6` is separate backend-owned work; no new
UI selector/API is needed, no erased journals or current authority inferred.

Existing group dialog now offers a separate canonical tree preview and bounded
(maximum100; overflow refused by server) tree capture inventory. Exact
`tree-capture-preview`, `tree-captures` and original-key `tree-capture` GETs and one
CAS POST are used through the additive UI-owned BranchGroupClient adapters.
Whole server preview/owners/resource Step IDs, reviewHash/versionId and stable
command are persisted before capture POST. Status must match both original
execution/Step/Chat identities and CAS; discovered retained checkpoint ID/hash
also stay bound. Tree status has no cleanupHeld field: UI does not infer pin release from retained
state; tree journals still hold owner deletion. Partial/unknown/409 holds retain the original command with no
POST replay, singular fallback or new owner/map selection. Explicit rediscovery
is required after stale canonical tree readback. Standalone capture, history,
historical read-only audit and lifecycle surfaces remain separate and preserved.

Retained tree capture feeds existing whole-group prepare/review/approve/revoke/
admit/original-key readback. `scope:'owner_tree'` requires exactly two original
owners, one generation-zero resource each, distinct fresh executions and exact
ownerMap. Resource custody/frontier/binding/configuration/host hashes stay local
to each original owner, rather than forced equal. Every current resource keeps its
actual fresh owner and Chat; admitted readback requires both owner receipts and
identical resource evidence. Known tree capture cannot become standalone or
substitute another child/Step/Chat. Whole review binds complete per-owner resource
inventory, every returned fact summary/actor/audience/recipient to its displayed
content and one current policy per source Chat. Child policy drift invalidates
whole-group approval; no independent child admission. All facts still require a
separate acknowledgement and final choice. Original Project audit access remains
distinct from fresh Project ownership; original external effects are not replayed.

Server eligibility only: manual parent plus one called child, one gen0 serial
ASYNC/SYNC resource each. Larger/parallel/later-generation called trees remain
refused. Existing standalone server preview also supports complete 2–32 gen0
multi-item map resources without a UI path/layout heuristic. Historical multi-item
retry support is not inferred. Source settlement, exact Call ancestry, current
per-owner capacities/policies/budgets, all imports and ONE final admission
transaction remain backend responsibilities. This UI adds no graph writer.

Contract display limitation: actual group result exposes scope, ownerMap and
resource identities, and review exposes host facts, stage and current policies.
It does NOT expose Branch parentAttemptId/idMap, original Branch counters or
numeric current per-owner acceptance budgets. UI explicitly labels these fields
unavailable and says the backend verifies them; it never reconstructs ancestry
from Request IDs or ownerMap, or invents budget numbers. Full fresh parent/child
owner mapping, resources, original actor/audience facts, policies and final
per-owner receipts are visible. A backend-owned DTO successor is required for
actual numeric budget/counter and Call-attempt ancestry display. No private saved
Branch snapshot is added to the UI to fill that gap.

Six deliverables: `packages/core/src/branch-group-client.ts`;
`apps/web/src/components/branches/{BranchGroupReview.tsx,branchGroupReview.ts}`;
`tests/chats/{branch-owner-tree-group.test.mjs,branch-group-review-mounted.tsx}`;
this report.
Deferred pure fixtures cover parent/child preview/status/CAS, original storage,
partial captures, child substitution/flattening/per-owner hash differences,
missing non-first facts/policy/receipt, exact tree routes and no mutation replay.
Mounted fixtures reuse full lost-response capture/prepare/choice/admit/revoke
recovery with owner_tree scope, both original/fresh owners and child private
facts, plus exact empty-client tree discovery and stale409 explicit rediscovery.
Standalone mounted variants cover complete2/3/32 gen0 inventories from the actual
server preview; backend fixtures own real map replay and item identity checks.

Source only: no tests/checks/types/build/Node/native/browser/runner preparation or
execution, installs, backend writes, push/merge/deploy or new workers. Fixtures
unexecuted. Remaining: backend/core source assembly, the explicit missing ancestry/
budget display fields, and separately authorized runtime/provider/native/package
filesystem/accessibility/mobile qualification. No whole UI/group/lifecycle/Bible/
Phase2 acceptance claimed.
