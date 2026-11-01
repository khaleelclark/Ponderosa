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
branch intentionally depends on owners' newer core DTOs. Grouped workflow folder composition/caller integration,
full generation coverage, early voice response, consolidated compatibility,
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
Grouped fresh-Chat folder activation is the current remaining caller dependency:
8d5ee5a1 introduces connected composition and grouped review, but exact composed
root inventory bootstrap and normal all-folder export root identity need the
Branches owner's source-contract handoff before enabling that web path. The
tracked dependency preserves the current UI continuation; no full UI completion
is claimed. Disconnected same-Chat forests remain an explicit backend batch gap.

Deferred source includes branch-package-files.test.mjs and
branch-package-export-mounted.tsx. Existing post-import mounted regression mocks
the new mapped-name reads. No tests/checks/types/build/browser/runner execution,
push, merge or deployment occurred.
