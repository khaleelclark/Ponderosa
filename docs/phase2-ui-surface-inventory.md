# Phase 2 UI review inventory

Source pinned to commit 33e9494e1f7efd3903b937ff4f32027d052ae9e9. This is a source-derived inventory and review plan, **not** evidence that screens were opened, that a control works, or that the UI meets the Bible. Reconcile it with the final candidate diff before judging: later changes can add or remove surfaces. Every checkbox is unperformed work. Some entries require particular permissions, populated data, provider state, or error fixtures. Use disposable data and avoid production or destructive actions.

## Entry points and review units

- [ ] Core Ponderosa shell / and /home: first load, home, sidebar, project/resource switching, search, notifications, Assistant entry, connection/read-only/error/retry states. Sources: apps/web/src/index.tsx, App.tsx, App.workspace-content.tsx, components/HomeView.tsx, WorkspaceSidebar*.tsx, WorkspaceFrame.tsx.
- [ ] /create/chat and /create/agent (including contextual project/chat/manager and recovery): blank, filled, validation, import, pending, failed, unconfirmed, success and cancel/back. Sources: CreateWorkspace.tsx, NewChatComposer.tsx, AgentCreateDialog.tsx, ChatCreationRecovery.tsx.
- [ ] /messages Inbox: empty, populated, action-needed, read/unread, filtering/navigation and linked decision/request responses. Sources: InboxView.tsx, NotificationPanel.tsx, decisions/.
- [ ] /manage/chats and /manage/agents: empty, list/tree/grid, search/sort/filter, folders, selection and management, creation, deletion confirmation and partial/error outcomes. Sources: ManageChatsWorkspace.tsx, WorkspaceResourceViews.tsx, ChatFolders.tsx, ResourceFolders.tsx.
- [ ] /projects/:projectId/chats/:conversationId with view=main|team|files|agents: shared Chat, Team Chat, Files & Results, Agent roster; messages, streaming, recipient, broadcast/direct/collaboration, queued/held/retry/unknown, decisions, attachments, pagination, file navigation and settings/action menus. Sources: ConversationView*.tsx, chat/, MessageDeliveryStatus.tsx, RequestLifecycleCard.tsx.
- [ ] /projects/:projectId/agents/:agentId with view=chat|activity|subagents|artifacts|settings|technical: individual Chat, output/activity/runs, organization, files/results, settings and technical details; focused message/telemetry; idle, active, paused, stopped, unconfirmed and provider-error states. Sources: AgentDetail*.tsx, AgentWorkInspector.tsx, activity/, filePreview/.
- [ ] /projects/:projectId/work, /projects/:projectId/files/view?path=…, /projects/:projectId/reviews/:agentId: work and files, preview variants and workspace review, ownership and return navigation; loading, empty, unavailable, unsupported, read-only and error. Sources: WorkspaceFileView.tsx, ConversationFilesResults.tsx, files/, filePreview/.
- [ ] /projects/:projectId/browser and /projects/:projectId/agents/:agentId/runs/:runId/browser: hosted/manual and local browser setup, pairing, sessions/pages, keyboard, viewport, observations and uploads; connecting, permissions, detached, error/retry and ownership. Sources: browser/, ProjectBrowserDialog.tsx, apps/browser-extension/src/popup.ts.
- [ ] /settings/profile, /settings/general, /settings/providers, /settings/notifications, /settings/activity and /usage: profile, Assistant, voice, global memory transfer/lifecycle, tool permissions, appearance, default instructions/runtime/context, providers/models/connection, notifications, activity/status/usage; save, unsaved, concurrent change, error, confirmation and return. Sources: WorkspaceSettingsView.tsx, AssistantSettings.tsx, speech/BrowserVoiceSettings.tsx, RuntimeSettings.tsx, ProviderStatusDialog.tsx, ProviderUsageCenter.tsx, ResourceNotificationSettings.tsx.
- [ ] /assistant and /apps/:id: standalone direct Agent chats and settings, speaker designation, scheduling/provider/model edits, streaming/voice, save conflict, disabled/missing and connection/error states. Sources: OutputAgentApp.tsx, OutputAgentDesignation.tsx, AssistantEntry.tsx. Entry point is index.tsx; paths are in api/productScope.ts.
- [ ] /branches home and sidebar: workflow list/folders, search, notifications, new/import, desktop/mobile navigation and settings. Sources: BranchesView.tsx, branches/BranchHome.tsx, BranchesSidebar.tsx, BranchFolders.tsx, BranchNotifications.tsx.
- [ ] /branches?branch=…&tab=workflow: canvas, empty/populated graphs, node selection, guided insertion, outline, pan/zoom, undo/redo, drag/keyboard, validation, editing, unsaved navigation; workflow setup/manual/schedule/webhook/filesystem, publication review, run confirmation, version history, rename, JSON and discard. Sources: WorkflowEditor.tsx, WorkflowCanvas.tsx, NodeEditor.tsx, AgentStepFields.tsx, BranchesView.tsx.
- [ ] Workflow node variants: Agent (existing/temporary setup), Script, called Branch, human gate, condition, route, fork/join and map/for-each; success/failure/cancel routes, retry/recovery, parameters and directory bindings, empty/invalid states. Sources: branches/NodeEditor.tsx, WorkflowAgentSetup.tsx, ParameterDefinitions.tsx, model.ts.
- [ ] /branches?branch=…&tab=executions and execution=…: list/filter/pagination; live/terminal/failed/blocked/unknown runs, graph and live output, item/step details, gates, retry/skip/merge and observed-result decisions, temporary/persistent Chat links, cancellation and loading/errors. Sources: BranchRunHistory.tsx, ExecutionPanel.tsx, BranchGraph.tsx, BranchLiveOutput.tsx.
- [ ] /branches?branch=…&tab=chats with persistent/temporary Chat, execution and nested workspace= route: full shared Chat/Agent/browser/file surfaces with Branch ownership, create/delete/navigation and read-only cases. Sources: BranchChats.tsx, branchesRouting.ts, shared components above.
- [ ] /branches?branch=…&tab=settings, including section=variables|execution-controls: variables/secrets status, local execution settings/budgets, availability, capabilities, deletion and review/confirmation/errors. Sources: BranchSettings.tsx, BranchExecutionBudget.tsx, CapabilityPolicyEditor.tsx.
- [ ] /branches?settings=general|providers|notifications|activity|profile|usage|status: shared workspace settings embedded in Branches, including route aliases usage→activity and status→providers. Check return and unsaved state separately. Sources: branchesRouting.ts, BranchGlobalSettings.tsx.
- [ ] Branch import/export/update: package choice, file picking, working data and bindings, private facts, diff/acknowledgments, progress/stop/background, completion, conflict/retry and partial/unavailable/held evidence. Sources: BranchPackageDialog.tsx, BranchPackageExportDialog.tsx, BranchRuntimePackageReview.tsx, BranchWorkingDataFiles.tsx, BranchImportFiles.tsx.
- [ ] Branch advanced retained data, history, resource, disclosure, group and generation reviews: trace entry points in ExecutionPanel.tsx, BranchOperations.tsx, BranchHistoryReview.tsx, BranchResourceReview.tsx, BranchDisclosureReview.tsx, BranchForeignContinuationReview.tsx, BranchGroupReview.tsx, BranchGenerationOne.tsx, GroupJournalAudit.tsx, lifecycle/. Record unsupported/held states as such; do not execute uncertain effects.
- [ ] PWA/install and system-notification surfaces: install/update prompts where offered, notification permission, delivery, replacement, click routing and app re-entry. Sources: apps/web/public/push-handler.js, notification hooks, NotificationPanel.tsx and ResourceNotificationSettings.tsx. System UI differs by browser/OS and needs separate device coverage.
- [ ] Companion interfaces when included in product qualification: desktop Engine launch/status/open/restart/quit/logs (apps/engine-desktop/src/index.html, renderer.ts, styles.css); browser-extension pairing/connect, permissions, pause/resume/disconnect/retry (apps/browser-extension/popup.html, popup.css, src/popup.ts). Browser/OS-specific capability and real hardware remain separate qualification.

## Transient surfaces and interactive states

For each applicable review unit, inspect actual controls and their open/close transitions, not only resting screens. Review reachable menus, context menus, selects, popovers, tooltips, accordions, drawers, dialogs, native file pickers, confirmation/leave guards, notifications, alerts and loading indicators. The source index below identifies common controls but is not a reachability proof. Review shared components in materially different hosts. Record native browser prompts and OS permission dialogs separately.

- [ ] For major actions record before, pressed/disabled/pending, success, failure/retry, cancel/back/close and uncertain/partial states; verify placement, preserved input, owner, destination and actual result. Use disposable data for destructive flows.
- [ ] Inspect hover, keyboard focus, pressed, disabled, expanded/collapsed, selection, long/wrapped content and tooltips; tab order, Enter/Space/Escape, focus restoration and accessible labels.
- [ ] Evaluate desktop and narrow/mobile layouts, resize, mobile drawer/swipe, portrait/landscape as applicable, scroll positions, keyboard/IME/composer behavior, text scaling, and light/dark themes.
- [ ] Capture motion: dialog/menu/drawer opening and closing, tab/route changes, panels/canvas transitions, loading and streaming. Compare timing and reduced-motion behavior where implemented; distinguish deliberate absence from an untested state.
- [ ] Exercise navigation and browser back/forward/reload with clean and dirty edits, draft retention and save/discard/cancel prompts. Inspect error boundaries, reconnect/stale banners, unavailable data, empty states, partial results, offline/recovery and concurrent-update conflicts where supported.
- [ ] Independently judge screenshots and interaction recordings against the user's chosen reference and Bible; record candidate commit, exact route/state, viewport, fixture, actions, observed result and finding. A filename, one screenshot or passing unit test does not establish complete visual/interaction coverage.

## Source-backed component inventory

This is a complete filesystem index of apps/web/src/**/*.tsx at the pinned commit, grouped by source location. Tags indicate syntactic signals, not confirmed reachability: dialog, menu/popover, drawer, tabs/accordion, motion and interactive. Each tagged number is the first source line with that signal. Shared primitives are intentionally included. Trace each from its hosts; untagged components can still render conditional states or custom wrappers. This index does not enumerate every server-driven state, dynamic content, browser-native UI, or CSS transition.


### (entry points) (5 files)

- apps/web/src/App.mobile.tsx — drawer:55, motion:73, interactive:57
- apps/web/src/App.tsx — motion:321, interactive:500
- apps/web/src/App.workspace-content.tsx — interactive:120
- apps/web/src/index.tsx
- apps/web/src/notificationActiveView.tsx

### components (111 files)

- apps/web/src/components/ActiveOperationStopDialog.tsx — dialog:22
- apps/web/src/components/AddAgentsFlow.tsx — dialog:93, menu/popover:135, interactive:93
- apps/web/src/components/AgentBrowserDialog.tsx — menu/popover:84, interactive:85
- apps/web/src/components/AgentCreateDialog.tsx — menu/popover:351, tabs/accordion:454, interactive:344
- apps/web/src/components/AgentDeletionDialog.tsx — interactive:118
- apps/web/src/components/AgentDetail.composer.tsx — interactive:61
- apps/web/src/components/AgentDetail.dialogs.tsx — dialog:28
- apps/web/src/components/AgentDetail.header.tsx — menu/popover:105, interactive:106
- apps/web/src/components/AgentDetail.panels.tsx — interactive:180
- apps/web/src/components/AgentDetail.parts.tsx — dialog:142, menu/popover:231, interactive:144
- apps/web/src/components/AgentDetail.settings.tsx — dialog:271, menu/popover:138, interactive:72
- apps/web/src/components/AgentDetail.tsx — interactive:715
- apps/web/src/components/AgentDetailSettingsController.tsx
- apps/web/src/components/AgentPackageDialogs.tsx — dialog:134, menu/popover:77, interactive:76
- apps/web/src/components/AgentWorkInspector.tsx — menu/popover:108, tabs/accordion:305, motion:321, interactive:109
- apps/web/src/components/AgentsTab.tsx — dialog:1285, menu/popover:714, drawer:878, motion:1087, interactive:643
- apps/web/src/components/AssistantEntry.tsx — interactive:13
- apps/web/src/components/AssistantSettings.tsx — interactive:22
- apps/web/src/components/BranchesView.tsx — dialog:357, drawer:354, tabs/accordion:372, motion:354, interactive:281
- apps/web/src/components/CapabilityPolicyEditor.tsx — tabs/accordion:76, interactive:48
- apps/web/src/components/ChatContextSettings.tsx — dialog:25, interactive:25
- apps/web/src/components/ChatCreationRecovery.tsx — dialog:67, interactive:66
- apps/web/src/components/ChatDeletionDialog.tsx — dialog:32, interactive:32
- apps/web/src/components/ChatFolders.tsx — interactive:24
- apps/web/src/components/ChatInstructionsImportChoice.tsx — menu/popover:25, interactive:24
- apps/web/src/components/ChatOverflowMenu.tsx — menu/popover:74, interactive:79
- apps/web/src/components/CollectionPrimitives.tsx — menu/popover:389, motion:686, interactive:112
- apps/web/src/components/ComposerRuntimeSelector.tsx — menu/popover:261, motion:382, interactive:261
- apps/web/src/components/ConfirmationDialogs.tsx — dialog:53, interactive:55
- apps/web/src/components/ContextRecoveryPanel.tsx — interactive:56
- apps/web/src/components/ConversationComposerStatus.tsx — menu/popover:43, interactive:43
- apps/web/src/components/ConversationFilesResults.tsx — dialog:329, interactive:184
- apps/web/src/components/ConversationView.dialogs.tsx — dialog:86, interactive:72
- apps/web/src/components/ConversationView.parts.tsx — menu/popover:245, motion:633, interactive:249
- apps/web/src/components/ConversationView.tsx — motion:1128, interactive:675
- apps/web/src/components/CopyMessageButton.tsx — menu/popover:16, interactive:17
- apps/web/src/components/CreateWorkspace.tsx — dialog:248, interactive:194
- apps/web/src/components/FeatureErrorBoundary.tsx — interactive:32
- apps/web/src/components/GitStorageBindingsEditor.tsx — menu/popover:11, interactive:11
- apps/web/src/components/GlobalChatSearch.tsx — dialog:348, interactive:154
- apps/web/src/components/GlobalMemoryTransfer.tsx — dialog:51, interactive:43
- apps/web/src/components/HeaderRelationshipLinks.tsx — menu/popover:111, interactive:59
- apps/web/src/components/HomeView.parts.tsx — motion:67, interactive:63
- apps/web/src/components/HomeView.tsx — interactive:97
- apps/web/src/components/HostPathPresentation.tsx — menu/popover:37, interactive:65
- apps/web/src/components/IconTitle.tsx
- apps/web/src/components/ImportAgentDialog.tsx — dialog:700, menu/popover:556, interactive:444
- apps/web/src/components/ImportedCommunications.tsx — interactive:14
- apps/web/src/components/InboxView.tsx — menu/popover:1576, interactive:1404
- apps/web/src/components/LazySyntaxHighlightedCode.tsx
- apps/web/src/components/LoadingState.tsx — motion:21
- apps/web/src/components/ManageChatsWorkspace.tsx — menu/popover:224, interactive:218
- apps/web/src/components/MessageDeliveryStatus.tsx — dialog:376, menu/popover:214, interactive:200
- apps/web/src/components/MessageRequestAction.tsx — dialog:33, menu/popover:25, interactive:26
- apps/web/src/components/MessageSenderLabel.tsx
- apps/web/src/components/MessageTimestamp.tsx — interactive:66
- apps/web/src/components/MobileNavigationContext.tsx — menu/popover:33, interactive:37
- apps/web/src/components/MutationNotifications.tsx — interactive:136
- apps/web/src/components/NativeHistoryControls.tsx — dialog:96, menu/popover:110, interactive:95
- apps/web/src/components/NativePortableDataChoices.tsx — menu/popover:12, interactive:12
- apps/web/src/components/NativeRuntimeControls.tsx — menu/popover:24, interactive:20
- apps/web/src/components/NativeTaskControls.tsx — dialog:36, interactive:35
- apps/web/src/components/NewChatComposer.tsx — interactive:112
- apps/web/src/components/NotificationPanel.tsx — dialog:489, tabs/accordion:506, interactive:489
- apps/web/src/components/OperatorAvatar.tsx
- apps/web/src/components/OperatorProfileEditor.tsx — menu/popover:145, interactive:123
- apps/web/src/components/OutputAgentApp.tsx — dialog:111, menu/popover:121, interactive:100
- apps/web/src/components/OutputAgentDesignation.tsx — dialog:19, interactive:17
- apps/web/src/components/PackageExportDisclosure.tsx — dialog:9
- apps/web/src/components/PendingAgentImportRecovery.tsx — interactive:59
- apps/web/src/components/PostImportAccessReview.tsx — dialog:72, menu/popover:24, interactive:24
- apps/web/src/components/PrimaryHeaderActions.tsx
- apps/web/src/components/ProjectBrowserContext.tsx
- apps/web/src/components/ProjectBrowserDialog.tsx — dialog:175, menu/popover:153, interactive:152
- apps/web/src/components/ProjectNavigation.tsx — menu/popover:101, interactive:102
- apps/web/src/components/ProjectRuntimeFields.tsx — menu/popover:102, interactive:92
- apps/web/src/components/ProjectShell.tsx — interactive:212
- apps/web/src/components/ProviderFailureBanner.tsx — dialog:64, interactive:59
- apps/web/src/components/ProviderStatusDialog.tsx — interactive:57
- apps/web/src/components/ProviderUsageCenter.tsx — menu/popover:395, motion:10, interactive:177
- apps/web/src/components/RecoverableLazyRoute.tsx — interactive:123
- apps/web/src/components/RequestLifecycleCard.tsx — dialog:447, tabs/accordion:321, motion:334, interactive:190
- apps/web/src/components/ResourceContextMenu.tsx — menu/popover:85, interactive:96
- apps/web/src/components/ResourceFolders.tsx — dialog:256, menu/popover:232, interactive:118
- apps/web/src/components/ResourceNotificationSettings.tsx — menu/popover:20, interactive:19
- apps/web/src/components/ResourceSettingsContext.tsx
- apps/web/src/components/ReviewedContinuationDialog.tsx — dialog:193, interactive:193
- apps/web/src/components/RuntimeSettings.tsx — interactive:21
- apps/web/src/components/SemanticStatus.tsx
- apps/web/src/components/SidebarActivityBadge.tsx — menu/popover:13
- apps/web/src/components/SidebarNotificationBadge.tsx — menu/popover:8
- apps/web/src/components/SidebarResourceRow.tsx — menu/popover:19, interactive:20
- apps/web/src/components/SyntaxHighlightedCode.tsx
- apps/web/src/components/TargetedNextRunReceipts.tsx — tabs/accordion:38
- apps/web/src/components/TextSizeSetting.tsx — menu/popover:14, interactive:13
- apps/web/src/components/TokenUsageButton.tsx
- apps/web/src/components/TriggerOccurrenceAudit.tsx — interactive:18
- apps/web/src/components/TriggerSourceFields.tsx — menu/popover:88, interactive:88
- apps/web/src/components/WorkspaceConnectionContext.tsx
- apps/web/src/components/WorkspaceConnectionNotice.tsx — menu/popover:22, interactive:19
- apps/web/src/components/WorkspaceDialogs.tsx — dialog:54, interactive:77
- apps/web/src/components/WorkspaceErrorBoundary.tsx — interactive:46
- apps/web/src/components/WorkspaceFileView.tsx — menu/popover:19, interactive:19
- apps/web/src/components/WorkspaceFrame.tsx — menu/popover:137, tabs/accordion:136, motion:417, interactive:153
- apps/web/src/components/WorkspaceReadOnlyContext.tsx
- apps/web/src/components/WorkspaceRefreshContext.tsx
- apps/web/src/components/WorkspaceResourceViews.tsx — menu/popover:266, interactive:264
- apps/web/src/components/WorkspaceSettingsView.tsx — dialog:1216, menu/popover:211, interactive:115
- apps/web/src/components/WorkspaceSidebar.chrome.tsx — menu/popover:134, motion:134, interactive:59
- apps/web/src/components/WorkspaceSidebar.parts.tsx — menu/popover:67, interactive:71
- apps/web/src/components/WorkspaceSidebar.tsx — dialog:789, menu/popover:400, motion:618, interactive:368

### components/activity (4 files)

- apps/web/src/components/activity/ActivityOutput.tsx — interactive:76
- apps/web/src/components/activity/ActivityRows.tsx — motion:330, interactive:202
- apps/web/src/components/activity/ActivityStreamPane.tsx
- apps/web/src/components/activity/ResponseFileActivity.tsx — interactive:55

### components/branches (34 files)

- apps/web/src/components/branches/AgentStepFields.tsx — menu/popover:51, tabs/accordion:50, interactive:33
- apps/web/src/components/branches/BranchChats.tsx — dialog:127, interactive:90
- apps/web/src/components/branches/BranchDirectoryStatus.tsx — menu/popover:16
- apps/web/src/components/branches/BranchDisclosureReview.tsx — dialog:94, menu/popover:108, interactive:93
- apps/web/src/components/branches/BranchExecutionBudget.tsx — dialog:51, menu/popover:42, interactive:38
- apps/web/src/components/branches/BranchFolders.tsx — interactive:18
- apps/web/src/components/branches/BranchForeignContinuationReview.tsx — menu/popover:81, interactive:81
- apps/web/src/components/branches/BranchGenerationOne.tsx — dialog:25, interactive:19
- apps/web/src/components/branches/BranchGlobalSettings.tsx — interactive:20
- apps/web/src/components/branches/BranchGraph.tsx — interactive:90
- apps/web/src/components/branches/BranchGroupReview.tsx — dialog:161, interactive:160
- apps/web/src/components/branches/BranchHistoryReview.tsx — dialog:58, menu/popover:64, interactive:57
- apps/web/src/components/branches/BranchHome.tsx — interactive:37
- apps/web/src/components/branches/BranchImportFiles.tsx — menu/popover:24, interactive:9
- apps/web/src/components/branches/BranchLiveOutput.tsx
- apps/web/src/components/branches/BranchNavigation.tsx — dialog:182
- apps/web/src/components/branches/BranchNotifications.tsx — menu/popover:48, interactive:48
- apps/web/src/components/branches/BranchOperations.tsx — dialog:32, interactive:11
- apps/web/src/components/branches/BranchPackageDialog.tsx — dialog:130, menu/popover:145, tabs/accordion:159, interactive:131
- apps/web/src/components/branches/BranchPackageExportDialog.tsx — menu/popover:31, interactive:26
- apps/web/src/components/branches/BranchResourceReview.tsx — dialog:65, menu/popover:83, interactive:64
- apps/web/src/components/branches/BranchRunHistory.tsx — menu/popover:70, interactive:53
- apps/web/src/components/branches/BranchRuntimePackageReview.tsx — tabs/accordion:9, interactive:34
- apps/web/src/components/branches/BranchSettings.tsx — tabs/accordion:84, interactive:20
- apps/web/src/components/branches/BranchWorkingDataFiles.tsx — interactive:26
- apps/web/src/components/branches/BranchWorkspaceHeader.tsx — menu/popover:29, interactive:29
- apps/web/src/components/branches/BranchesSidebar.tsx — menu/popover:9, interactive:9
- apps/web/src/components/branches/ExecutionPanel.tsx — dialog:210, menu/popover:29, tabs/accordion:184, interactive:29
- apps/web/src/components/branches/GroupJournalAudit.tsx — interactive:21
- apps/web/src/components/branches/NodeEditor.tsx — menu/popover:19, tabs/accordion:80, interactive:18
- apps/web/src/components/branches/ParameterDefinitions.tsx — menu/popover:15, interactive:14
- apps/web/src/components/branches/WorkflowAgentSetup.tsx — dialog:29, interactive:29
- apps/web/src/components/branches/WorkflowCanvas.tsx — dialog:130, menu/popover:58, motion:52, interactive:58
- apps/web/src/components/branches/WorkflowEditor.tsx — dialog:94, menu/popover:97, drawer:113, tabs/accordion:103, motion:106, interactive:91

### components/browser (9 files)

- apps/web/src/components/browser/BrowserArtifactUpload.tsx — menu/popover:88, interactive:64
- apps/web/src/components/browser/BrowserKeyboard.tsx — menu/popover:26, interactive:26
- apps/web/src/components/browser/BrowserObservations.tsx — dialog:107, menu/popover:114, interactive:106
- apps/web/src/components/browser/BrowserPageStrip.tsx — menu/popover:58, interactive:43
- apps/web/src/components/browser/BrowserViewport.tsx — interactive:279
- apps/web/src/components/browser/BrowserWindow.tsx — menu/popover:78, interactive:78
- apps/web/src/components/browser/BrowserWorkspaceHost.tsx — menu/popover:92, interactive:92
- apps/web/src/components/browser/HostedManualBrowser.tsx — interactive:61
- apps/web/src/components/browser/LocalBrowserSetup.tsx — interactive:25

### components/chat (24 files)

- apps/web/src/components/chat/AgentResponseText.tsx
- apps/web/src/components/chat/AgentWorkReceipt.tsx — interactive:137
- apps/web/src/components/chat/ChatAttachments.tsx — dialog:184, menu/popover:215, motion:142, interactive:107
- apps/web/src/components/chat/ChatComposerDock.tsx — interactive:21
- apps/web/src/components/chat/ChatDocumentCard.tsx — dialog:49, interactive:45
- apps/web/src/components/chat/ChatLiveBanner.tsx
- apps/web/src/components/chat/ChatMessageFrame.tsx — menu/popover:115, interactive:91
- apps/web/src/components/chat/ChatMessages.tsx — dialog:225, menu/popover:342, motion:496, interactive:221
- apps/web/src/components/chat/ChatOperatorLabel.tsx
- apps/web/src/components/chat/ChatPagination.tsx — interactive:17
- apps/web/src/components/chat/ChatPane.tsx — interactive:63
- apps/web/src/components/chat/ChatSurface.tsx — interactive:93
- apps/web/src/components/chat/Composer.controls.tsx — menu/popover:397, interactive:107
- apps/web/src/components/chat/Composer.parts.tsx — menu/popover:53, interactive:59
- apps/web/src/components/chat/Composer.tsx — dialog:3659, interactive:3661
- apps/web/src/components/chat/ComposerAttachment.tsx — interactive:79
- apps/web/src/components/chat/ComposerEditor.tsx — motion:1613, interactive:500
- apps/web/src/components/chat/DirectReplyPreview.tsx
- apps/web/src/components/chat/LiveAgentProgress.tsx — motion:32, interactive:31
- apps/web/src/components/chat/OutgoingMessage.tsx
- apps/web/src/components/chat/QueuedMessageTray.tsx — menu/popover:66, interactive:71
- apps/web/src/components/chat/RichMessageDisplay.tsx
- apps/web/src/components/chat/ScrollableMessageTable.tsx
- apps/web/src/components/chat/scroll.tsx — menu/popover:26, interactive:29

### components/decisions (6 files)

- apps/web/src/components/decisions/DecisionActions.tsx — interactive:49
- apps/web/src/components/decisions/DecisionCard.tsx
- apps/web/src/components/decisions/DecisionQuestionContent.tsx
- apps/web/src/components/decisions/DecisionResponseDialog.tsx — dialog:82, interactive:82
- apps/web/src/components/decisions/DecisionResponseMessage.tsx — dialog:47, interactive:45
- apps/web/src/components/decisions/RuntimeElicitationActions.tsx — menu/popover:271, interactive:160

### components/filePreview (5 files)

- apps/web/src/components/filePreview/ArtifactPreview.tsx — interactive:90
- apps/web/src/components/filePreview/ArtifactsPane.tsx — interactive:90
- apps/web/src/components/filePreview/DocxPreview.tsx — interactive:27
- apps/web/src/components/filePreview/FilePreview.tsx
- apps/web/src/components/filePreview/PdfPreview.tsx — interactive:100

### components/files (2 files)

- apps/web/src/components/files/ConversationWorkspaceFiles.tsx — dialog:45, interactive:28
- apps/web/src/components/files/WorkspaceReviewPane.tsx — menu/popover:114, interactive:114

### components/lifecycle (6 files)

- apps/web/src/components/lifecycle/BranchLifecycleReview.tsx — dialog:48, menu/popover:57, interactive:48
- apps/web/src/components/lifecycle/GroupCaptureAbandonmentReview.tsx — dialog:37, interactive:36
- apps/web/src/components/lifecycle/LifecycleDiscovery.tsx — menu/popover:35, interactive:29
- apps/web/src/components/lifecycle/LifecyclePanel.tsx — menu/popover:41, interactive:33
- apps/web/src/components/lifecycle/LifecycleReview.tsx — dialog:88, interactive:87
- apps/web/src/components/lifecycle/MemoryPreserveUnknown.tsx — dialog:62, interactive:61

### components/speech (6 files)

- apps/web/src/components/speech/AudioMessagePlayer.tsx — interactive:19
- apps/web/src/components/speech/BrowserVoiceSettings.tsx — interactive:17
- apps/web/src/components/speech/DictationControls.tsx — menu/popover:108, interactive:118
- apps/web/src/components/speech/ReadAloudControls.tsx — menu/popover:38, interactive:38
- apps/web/src/components/speech/VoiceConversation.tsx — dialog:499, interactive:499
- apps/web/src/components/speech/VoiceMessageRecorder.tsx — dialog:71, interactive:71

## Motion and companion source anchors

- apps/web/src/global.css — motion lines 40, 125, 126, 192, 197, 198, 199, 214, 220, 224, 225
- apps/engine-desktop/src/styles.css
- apps/engine-desktop/src/index.html
- apps/engine-desktop/src/renderer.ts
- apps/browser-extension/src/popup.ts

apps/web/src/routing.ts, routeRegistry.ts, branchesRouting.ts, and api/productScope.ts define route and product-scope boundaries; apps/web/src/index.tsx selects the top-level entry point. This index is not a substitute for interaction discovery or final-candidate reconciliation.
