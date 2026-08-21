# Web client simplification review

Date: 2026-07-24  
Scope: `apps/web/src` on the current dirty `master` worktree at `fb0248a7`

## Method and boundaries

This is a read-only product-code review. The only repository change from this
pass is this report.

`docs/UI_REVIEW.md` is not present in the current worktree, `origin/master`, or
any registered worktree/ref, so it could not be read directly. I used the
existing review summary supplied with the task and verified the current source
before excluding its known findings. In particular:

- agent status presentation is already centralized in
  `apps/web/src/agents.ts:111-155`;
- agent deletion is already centralized in
  `apps/web/src/components/AgentDeletionDialog.tsx:14-115`;
- reply actions already converge on
  `apps/web/src/components/chat/ChatMessageFrame.tsx`;
- the earlier knip cleanup is present in the dirty worktree.

I also ran clone detection as a discovery aid, then checked every candidate
manually. The strict detector found only four clone regions (0.27% duplicated
lines), but the higher-value opportunities below are mostly semantic
duplication, dead pass-through contracts, and obsolete code kept alive only by
non-production entry points.

## Ranked findings

Rank is impact divided by change risk. Effort is an implementation estimate,
not including review.

### 1. Remove the dead `onOpenWorkLog` prop pipeline

- Category: dead-code
- Effort: S
- Affected:
  - `apps/web/src/components/MessageDeliveryStatus.tsx:64-75`
  - `apps/web/src/components/chat/ChatPane.tsx:24-62`
  - `apps/web/src/components/chat/ChatPane.tsx:130-137`
  - `apps/web/src/components/ConversationView.tsx:113-143`
  - `apps/web/src/components/ConversationView.tsx:199-205`
  - `apps/web/src/components/ConversationView.tsx:214-251`
  - `apps/web/src/components/ConversationView.tsx:1070-1092`
  - `apps/web/src/components/AgentDetail.tsx:1007-1009`
  - `apps/web/src/components/ProjectShell.tsx:231-250`

`MessageDeliveryStatus` declares `onOpenWorkLog`, but does not destructure or
read it. The value is nevertheless threaded from `ProjectShell` through
`ConversationView`/`ConversationMessage`, and separately from `AgentDetail`
through `ChatPane`. Removing the prop from every layer changes no rendered
behavior and eliminates a misleading capability from five component contracts.

### 2. Delete legacy UI components with no production callers

- Category: dead-code
- Effort: M
- Affected:
  - `apps/web/src/components/activity/ActivityPane.tsx:231-384`
  - `apps/web/src/components/files/WorkspaceReviewPane.tsx:142-208`
  - `apps/web/src/components/filePreview/AttachmentPreview.tsx:1-34`
  - `apps/web/src/components/chat/ChatMessages.tsx:422-424`
  - `apps/web/src/components/browser/browserAdapters.ts:31-45`

Repository-wide symbol searches show no production caller for `RunsPane`,
`ChangedFilesPane`, `AttachmentPreview`, the `UserMessageLabel` compatibility
wrapper, or `runBrowserAdapter`. Their exports remain reachable through direct
paths or the `panes.tsx` barrel despite having no shipped caller.

The live replacements are already in use: `AgentWorkInspector` for technical
run detail, `ActivityPane` for current work, `WorkspaceReviewPane`/artifact
surfaces for files, `ChatOperatorLabel` for operator identity, and
`projectBrowserAdapter` for the browser UI. Removing these obsolete surfaces
should remove roughly 250 lines of product code without changing the shipped
component graph.

### 3. Remove production-dead exported helpers

- Category: dead-code
- Effort: S
- Affected:
  - `apps/web/src/agents.ts:12-15,157-169`
  - `apps/web/src/components/HomeView.tsx:23-28`
  - `apps/web/src/components/WorkspaceSidebar.tsx:80-86,173-184`
  - `apps/web/src/components/AgentDetail.tsx:146-155`
  - `apps/web/src/components/activity/ActivityPane.tsx:688-709`
  - `apps/web/src/collaborationRecipients.ts:1-15`
  - `apps/web/src/responsive.ts:1-7`
  - `apps/web/src/messageSender.ts:1-3`
  - `apps/web/src/workspaceNavigation.ts:48-61,98-100`

These symbols have no consumer under `apps/web/src`: `agentRosterIndent`,
`agentActivity`, `orderHomeResources`, `orderByStableIds`,
`globalSearchShortcutLabel`, `globalSearchShortcutAccessibleLabel`,
`finalizedWorkDurationMs`, `groupActivityByExecution`, all three
`collaborationRecipients` helpers, `isCompactViewport`,
`directMessageSender`, `workspaceChats`, and `projectContextLabel`.

This explains why the prior knip pass can be clean while dead product code
remains: exported application helpers can look reachable despite having no
shipped consumer. Since this is an application rather than a published utility
package, abandoned APIs should not be preserved.

### 4. Remove the one-use `MessageMarkdown` forwarding component

- Category: dead-code
- Effort: S
- Affected:
  - `apps/web/src/components/chat/ChatMessages.tsx:355-367`
  - `apps/web/src/components/chat/ChatMessages.tsx:373-402`

`MessageMarkdown` duplicates the full `ChatMarkdown` prop signature and does
nothing except rename `children` to `text`. It has one caller. Rendering
`ChatMarkdown` directly removes a component and ten repeated prop declarations
with no behavioral change.

### 5. Put `ConversationView` on the existing `ChatSurface` scroll contract

- Category: decompose
- Effort: M
- Affected:
  - `apps/web/src/components/ConversationView.tsx:298-326`
  - `apps/web/src/components/ConversationView.tsx:443-488`
  - `apps/web/src/components/ConversationView.tsx:998-1107`
  - `apps/web/src/components/chat/ChatSurface.tsx:8-71`
  - `apps/web/src/components/chat/useChatScroll.ts:6-77`
  - `apps/web/src/components/chat/ChatPane.tsx:69-147`

`ConversationView` manually owns the scroll ref, follow-latest ref, saved
position, scrollbar reveal, “scroll to latest” state, pagination button, and
prepend behavior. `ChatSurface` plus `useChatScroll` already implement that
contract and are used by Agent chat.

The project/team surface has extra pre-message alerts and operational rows, but
`ChatSurface.beforeMessages`, `history`, `empty`, and `children` already provide
the required extension points. A `project` content-width adjustment is
presentational. Reusing the primitive should remove a substantial block of
state/effects and prevent the two chat surfaces from drifting again. Preserve
the current mobile composer callback through `follow.onPositionChange`.

### 6. Share one operator-profile editor

- Category: dedup
- Effort: M
- Affected:
  - `apps/web/src/components/OperatorProfileDialog.tsx:22-52`
  - `apps/web/src/components/OperatorProfileDialog.tsx:62-117`
  - `apps/web/src/components/WorkspaceSettingsView.tsx:18-19`
  - `apps/web/src/components/WorkspaceSettingsView.tsx:51-54`

The dialog and full-page workspace duplicate profile state, the same validation
regex and reserved handles, avatar choices, upload accept list and 10 MiB
limit, upload state/error handling, labels, and save mapping. They have already
drifted in capitalization, helper copy, avatar size, and explanatory text.

Extract a controlled `OperatorProfileEditor` (or a small
`useOperatorProfileForm` plus fields component) and let each surface supply only
its container/actions. This is safe because both currently emit the same
`WorkspacePreferencesDto["profile"]` shape and call the same upload endpoint.

### 7. Centralize browser-safe request/client ID generation

- Category: util
- Effort: S
- Affected:
  - `apps/web/src/components/AgentDetail.tsx:350-367,585-587,837-856,1008`
  - `apps/web/src/components/ConversationView.tsx:659-683,834-840,865,896`
  - `apps/web/src/components/AllChatView.tsx:133-143`
  - `apps/web/src/components/AgentsTab.tsx:256-260`
  - `apps/web/src/components/MessageDeliveryStatus.tsx:90-97`
  - `apps/web/src/components/chat/Composer.tsx:94-103,220-226`
  - `apps/web/src/pushNotifications.ts:54-64`

The fallback
`globalThis.crypto?.randomUUID?.() ?? \`${Date.now()}-${Math.random()}\``
appears at least fifteen times, with several slightly different prefix and
base-36 variants. A `createClientId(prefix?)` helper can preserve each prefix
while centralizing feature detection and fallback formatting. This is a pure
substitution and reduces the chance that one call site accidentally produces a
different idempotency shape.

### 8. Reuse the existing top-level React Query hooks

- Category: dedup
- Effort: S
- Affected:
  - `apps/web/src/hooks/queries.ts:5-14`
  - `apps/web/src/components/ConversationView.tsx:270-277`
  - `apps/web/src/components/AgentDetail.tsx:493-494`

`useProjects` and `useWorkspacePreferences` already own the canonical keys and
fetchers, but the two largest screens redeclare both `useQuery` calls inline.
Replacing four inline queries with the existing hooks removes duplication and
makes future query-policy changes apply consistently. React Query will use the
same cache entries, so behavior is unchanged.

### 9. Finish centralizing canonical query keys

- Category: dedup
- Effort: M
- Affected:
  - `apps/web/src/queryKeys.ts:1-52`
  - `apps/web/src/hooks/useSendMessage.ts:19-42`
  - `apps/web/src/hooks/useAgentStream.ts:360-362,409-419`
  - `apps/web/src/hooks/useWorkspaceStream.ts:35,133,164-166,204-218,227-230,239-278`
  - `apps/web/src/components/MessageDeliveryStatus.tsx:98-140`
  - `apps/web/src/components/NotificationPanel.tsx:113-130,169-219`
  - `apps/web/src/components/ProjectBrowserDialog.tsx:38-46`
  - `apps/web/src/components/AllChatView.tsx:78-80,147-149`
  - `apps/web/src/components/AgentDetail.tsx:574,582`
  - `apps/web/src/components/ImportAgentDialog.tsx:88`

`queryKeys.ts` explicitly says components should not spell query arrays
themselves, but the same `agent`, `agents`, `agent-health`, `conversation`,
`conversations`, `collaboration-chat`, `notifications`, `projects`, `engines`,
`triggers`, and `all-chat` prefixes are still repeated across streaming,
optimistic updates, and components.

Add missing key families where needed and replace raw arrays with the existing
factories/prefixes. This is behavior-preserving if the emitted arrays remain
byte-for-byte equal. It improves refactor safety because cache reads, writes,
and invalidations cannot silently diverge through spelling or arity.

### 10. Move reusable utilities out of heavyweight components

- Category: util
- Effort: S
- Affected:
  - `apps/web/src/components/AgentDetail.tsx:136-162`
  - `apps/web/src/components/ConversationView.tsx:48,87-105`
  - `apps/web/src/components/WorkspaceSidebar.tsx:71-77,186-194`
  - `apps/web/src/components/WorkspaceResourceViews.tsx:21-26,70-72,110-111,144-146`
  - `apps/web/src/resourcePreferences.ts:1-67`

`ConversationView` imports `formatExecutionElapsed` from the 1,376-line
`AgentDetail` component. `WorkspaceResourceViews` imports
`reorderStableIds` from that sidebar as well.

Move duration formatting to a small time utility, operator initials alongside
`OperatorAvatar`, and stable ordering/reordering into
`resourcePreferences.ts`. The latter also gives the live
`reorderHomeResources` implementation (`HomeView.tsx:30-38`) one canonical
replacement. This changes module ownership, not logic, and removes surprising
dependencies between unrelated UI screens.

### 11. Reuse the canonical runtime-selection state in Project dialogs

- Category: dedup
- Effort: M
- Affected:
  - `apps/web/src/conversationEngine.ts:129-156`
  - `apps/web/src/components/ProjectCreationDialog.tsx:104-107,127-171`
  - `apps/web/src/components/ProjectSettingsDialog.tsx:88-91,106-143`
  - `apps/web/src/components/dialogs.tsx:68-74,140-176,376-379,403-459`

`runtimeControlState` is documented as the canonical presentation state for
creation dialogs, settings, presets, and composers. Preset and Agent dialogs use
it, but both Project dialogs reconstruct model/effort option filtering and
fallback labels around `resolveRuntimeSelection` and
`effortOptionsForModel`.

Extract controlled runtime fields that consume `runtimeControlState`, with
configurable “inherit/default” labels. This removes the strict clone detected
between Project creation and settings while preserving their different copy and
required/optional engine semantics.

### 12. Introduce a small ordered-deduplication helper

- Category: util
- Effort: S
- Affected:
  - `apps/web/src/components/AgentDetail.tsx:102-129,399-405,430-435,715-720`
  - `apps/web/src/components/ConversationView.tsx:63-73`
  - `apps/web/src/components/AllChatView.tsx:36-40`
  - `apps/web/src/components/ProjectArtifactsView.tsx:154-165,263-269`

Pagination and stream reconciliation repeatedly use
`[...new Map(items.map(item => [key, item])).values()]`, sometimes followed by
a sort. `mergeTelemetryPage` repeats the same operation in six type branches.
A generic `uniqueBy`/`mergeByKey` helper that accepts a key selector and optional
sort comparator would collapse these copies while preserving explicit ordering
at each call site. It is safe because the existing “last value for key wins”
semantics can be checked through focused live qualification.

### 13. Remove the no-op `ResourceRow.onDragOver` contract

- Category: dead-code
- Effort: S
- Affected:
  - `apps/web/src/components/CollectionPrimitives.tsx:65-78,80-107`
  - `apps/web/src/components/WorkspaceResourceViews.tsx:57-74,131-148`

Both callers pass `onDragOver={() => undefined}` solely so `ResourceRow` will
call `preventDefault`. The callback carries no information. Let `ResourceRow`
prevent default whenever `onDrop` exists, then remove the prop, its guard, and
both no-op callbacks. Drag behavior remains the same and the primitive contract
matches its actual use.

### 14. Share the global-search result row shell

- Category: dedup
- Effort: S
- Affected:
  - `apps/web/src/components/GlobalChatSearch.tsx:82-114`
  - `apps/web/src/components/GlobalChatSearch.tsx:116-147`

`GlobalSearchResultItem` and `RecentChatItem` repeat the same
`ListItemButton` accessibility, keyboard/mouse, selection, spacing, and
`ListItemText` shell. Extract a small internal `SearchResultRow`; keep each
item’s primary/secondary content as children. This is a presentational
deduplication and was one of the strict clone regions.

### 15. Decompose `WorkspaceSettingsView` by section

- Category: decompose
- Effort: M
- Affected:
  - `apps/web/src/components/WorkspaceSettingsView.tsx:28-48`

The component currently contains general, notification, and provider settings
as several very long JSX expressions in one function, plus the engine mutation
and push-notification state. Extract `GeneralSettingsSection`,
`NotificationSettingsSection`, and `ProviderSettingsSection` while keeping
`WorkspaceSettingsView` as the router/container. This is a local structural
change with no contract change, makes each independent mutation boundary
obvious, and materially improves reviewability.

## Suggested implementation batches

1. **Pure deletions and contract cleanup:** findings 1-4 and 13.
2. **Utility ownership:** findings 7-10 and 12.
3. **Shared UI primitives:** findings 6, 11, and 14.
4. **Larger component cleanup:** findings 5 and 15.

The first batch has the best impact-to-risk ratio and should be easy to review
independently. The `ChatSurface` migration should remain a separate change
because scroll restoration and prepend behavior deserve focused manual
qualification even though the target abstraction already exists.
