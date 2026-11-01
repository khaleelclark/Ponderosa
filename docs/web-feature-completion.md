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

Residual implementation dependencies: server/core validated audio formats and model-to-workflow binding need the respective owner handoff. A genuine early qualified Agent voice acknowledgement must originate in runtime/workflow, not canned browser text. Broader source audit and combined verification remain required; this document is coverage, not a True verdict or release claim.
