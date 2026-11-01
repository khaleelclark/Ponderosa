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
