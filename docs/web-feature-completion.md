# Web implementation coverage

Base: `f64f631b490dbfc8125f0f7a2f8c649b6c54d19f`. Writer: Phase 2 UI and accessibility fixes.
Branch: `phase2/web-feature-completion`. Worktree: `/home/phoenix/ponderosa-worktrees/phase2-web-feature-completion`.

Implementation-first: no tests, suites, typechecks, builds, browser sessions,
benchmarks, capacity checks, or acceptance packets executed in this work.
Regression source is written for the later combined verification.

| Requirement | Source coverage |
| --- | --- |
| #3, #26, #29; output frontends | `OutputAgentApp`, `BranchChats`, `AgentDetail.header` use focused output chat, everyday settings and More options; existing Chat/Branch folders retained. |
| Build list Assistant/speaker | `AssistantSettings`, `AssistantEntry`, `OutputAgentDesignation`: visible disabled state, canonical explicit enable, refreshed status, serialized role changes; singleton authority remains server-owned. |
| Build list attachments and voice messages | `VoiceMessageRecorder`, `voiceRecording`, `DictationControls`, `Composer`, `ComposerAttachment`, `ChatAttachments`: microphone recording/review, existing durable draft uploads, native audio preview/playback. Server audio admission is coordinated separately. |
| #27 appearance/mobile | `TextSizeSetting`, `textSize`, root `index`, shared settings; standalone `useAppViewport` and font hook; relative prose line height, native audio labels and touch-sized attachment remove action. |
| #31 streaming | `AgentResponseText` reaches Agent work/task receipts via `ResponseRow` and Branches live output directly. Existing Chat/Assistant/output streams reuse Agent detail. `useAgentStream` batches ordered text updates and closes exact-Run segments on terminal lifecycle. |
| #31 calls | Existing voice reply association/memory checks retained; sentence stability threshold 300 ms / poll 100 ms; standalone phone call layout now actually wired. Actual early Agent acknowledgement remains runtime-owned. |
| #21 source performance | Ordered 16 ms text batching, memoized stable rich Markdown, literal open segments. Accepted timestamp formatter reuse retained. Distributed mapped startup work did not justify speculative pagination/style rewrites. No measured improvement claimed. |
| #18, #24 | Accepted notification/unread behavior and exact canonical figures retained. No cost estimates added; call timing details collapsed under an explicit disclosure. |
| #22 onboarding | Existing provider-first New Chat flow and recovery retained; redundant creation-description blocks removed. No installation/timing claim. |
| Inbox | Existing Inbox UI/code naming retained; no legacy user-facing label introduced. |
| Imports | `ImportAgentDialog` role warning moved outside action row; role review invalidates on package/destination/provider-mapping changes. Branch package preview retains server-owned collision warning/confirmation. |

The Branches owner confirmed that output model saves use the existing `realApi.updateAgent(agentId, {activeEngine, model})` contract: output workflows target that same persistent Agent, so no duplicate graph model or new endpoint is needed. Schedule saves send both `expectedVersionId` and the observed `expectedSettingsRevision`. Server/core validated audio formats were delivered in the joined owner handoff; source integration is required. A genuine early qualified Agent voice acknowledgement must originate in runtime/workflow, not canned browser text. Broader source audit and combined verification remain required; this document is coverage, not a True verdict or release claim.

## Portability and authorized DM text continuation

Full Agent export offers explicit relative working-file paths, passed through copy
and download APIs as the JSON `workingFiles` selection. Import offers a new host
folder destination and source/shared/separate Git mode; server validation remains
authoritative. Source restrictions still need the portability owner's structured
review preview for the existing asynchronous import operation. No source access
settings are adopted by the browser.

`DirectReplyPreview` renders only host status snapshots with `presentation:text`
under the latest explicit Direct Message's recipient, including Assistant and output
apps through shared Agent Chat. It checks message/conversation/Agent/Run identity,
fence/stream continuity, sequence and memory exposure, clears on invalidation, and
yields to canonical Communication. SSE prompts authoritative status reads; a
sequential 500 ms fallback covers reconnects. It never publishes Communication or
speaks text. Both voice snapshot entry points reject text presentation. Other
communication scopes remain runtime dependencies. No execution or qualification
was performed; combined verification remains deferred.

## Joined API integration

Backend source dependencies: Branches `c7acbd864e01fd3becdc3ace733d5d25dbaa270e`,
portability/audio `94f7bafc63f17c82ff231d0211b61b0cf2d0bace`, and runtime text
`8d9dfaa84ac190aca5f60f5887d0680e319016df`. These must be integrated with this web
branch; no backend cherry-pick or execution occurred here.

- `ImportAgentDialog` now previews source/destination restrictions using the staged
  upload endpoint, requires explicit keep/apply choice, and forwards the returned
  digest. Package/destination/provider/folder/instructions changes invalidate it;
  delayed previews cannot replace a newer draft. Failed imports require review again.
- `AgentPackageDialogs`, `useAgentPackageActions`, and `realApi` forward explicit
  whole-root-folder export through both copy/download. Selected files remain an
  alternative; fixed newline splitting for multi-file entry. Existing new-folder
  import control remains explicit and never rebinds an existing Chat.
- `ImportedCommunications` is an on-demand owning-Agent technical-view reader,
  with bounded/versioned pages, immutable source/audience and revision disclosure,
  and only server-authorized original download links. It does not insert history
  into live Chat or confer source authority.
- Shared Agent Chat human broadcast and DM text previews use generic reply-stream
  status. `textReplyRoute` rejects wrong intent, peer recipients, voice and foreign
  source/conversation; existing exact Agent/Run/fence/memory checks remain.
  `tests/chats/text-reply-route.test.mjs` is written, not executed.
- Recorder MIME preferences match backend audio WebM/Opus, Ogg/Opus and MP4 admission;
  backend preserves metadata/reload originals. Container admission is not playback
  qualification, and integration has not been executed.

Remaining implementation gaps: same-Chat peer provisional text and the separate
shared human Chat consumer still need expansion beyond the Agent Chat consumer;
post-import mapped memory/browser suggestion review and explicit Settings actions,
and a convenient new-root Chat creation flow remain unwired. Existing Chat creation
and Settings remain available; source grants/profile IDs are never applied. Genuine
early qualified voice acknowledgement remains runtime-owned. Full portability,
performance, Bible and Phase 2 completion are not claimed. All tests, types, builds,
browser runs and consolidated qualification remain deferred by direction.

## Workflow installation access review

`BranchPackageDialog` consumes Branches `7b655b210e674ced1680276413b362b903de0012`
(with reliability `ec80fdea58` and ancestors). During applying, it shows the exact
pending Chat/Agent's source restrictions and current destination restrictions,
requires an explicit keep/apply choice and posts the server digest and opaque
references to `/api/branches/installations/:id/access-review`. A changed pending
review clears the choice. Success or failure refreshes canonical status; a mutation
response never replaces a later Stop/terminal state. Stop and background progress
remain available. This applies no memory/browser grant. No tests, checks, builds,
types or browser execution accompanied this caller increment. Folder bundles and
additional import Settings actions remain separate implementation work.
