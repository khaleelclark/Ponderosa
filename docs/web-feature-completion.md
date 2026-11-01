# Current web implementation coverage

Source-only integration through `c38b209b395dcf53744702758addf1c74944d0b2`.
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
budget receipts. UI rendering remains M4; existing controls label undisplayed fields
unavailable/server-verified pending that adoption.
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

Source successor of `83e340a883480f4f8a45bbc4495b89cc9faaf403`, sole UI writer
on `phase2/web-feature-completion` at
`/home/phoenix/ponderosa-worktrees/phase2-web-feature-completion`.
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
