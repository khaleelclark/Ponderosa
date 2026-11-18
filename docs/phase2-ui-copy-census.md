# Phase 2 UI copy census — inventory M5 / Bible 29

## Product-Wide Title Case

Ponderosa-authored headings, navigation, field labels, buttons, menu items,
compact status summaries, notification titles and error summaries use Title Case.
Capitalize the authored words in short labels, including short words, consistently
with existing controls such as “Insert Before The First Step.” Preserve product
names and acronyms such as Ponderosa, Chat, Agent, Run, Request, Git, JSON and API.
Use “Work Unconfirmed,” “Delivery Unconfirmed,” “Reply Unavailable” and
“Request Rate Limit Exceeded.” Future UI specifications should follow this rule.

Supporting prose, consequential consent sentences, quoted provider/user output,
raw diagnostics, model/provider names, paths, technical identifiers and retained
historical evidence keep their exact casing. Change authored copy at its source;
do not use CSS capitalization or transform arbitrary strings at runtime. Known
HTTP summaries come from structured status; keep the original diagnostic in
Details. A failed background read never establishes delivery failure or grants
permission to retry work. Each message/recipient keeps its canonical work status
and exact recovery actions; independent user-action failures remain distinguishable.

UI009 audits static semantic headings, control/field labels and shared status/error
boundaries across the product, plus literal notification producers. Historical
notification records and user-authored titles remain verbatim. These guidance
rules supersede the older source-only census's copy convention; the historical
qualification statements below describe their original snapshots.


Source-only successor to `ad0f26bd4a95abc378e49497e82980ebd70eca6d`.
Request basis: `docs/phase2-remaining-implementation.md`, snapshot
`391d682c0cf4c209d3d7a0040716708b6a99e0f5`, M5.
Writer: Phase 2 — UI and accessibility fixes. Branch:
`phase2/web-feature-completion`. Worktree:
`/path/to/worktrees/phase2-web-feature-completion`.

## Source disposition

The generation-history eligibility paragraph, group directory/eligibility/discovery
paragraphs, owner-tree contract-limit paragraph and historical audit explanation
are replaced by labelled evidence rows. Consent stays beside the relevant action:
shared existing directory/no separate working copy, private capture, disclosure to
exact recipients, unchanged consumed attempts, revoked choices, permanent package
release/retirement, repeated retry effects and unresolved source effects.

The census also covered all TSX surfaces in `components/branches/` and
`components/lifecycle/`, including the older package, budget, editor and execution
controls touched by these new flows. Multi-sentence instructions became concise
hints or labelled rows. Long JSON evidence, full original fact metadata, hashes,
actors, audiences, complete resource/owner/Agent maps and policies remain intact.
No tutorial paragraph was moved into a collapsed panel or tooltip.

Additional new/reused surfaces inspected: ContextRecoveryPanel,
GlobalMemoryTransfer, ImportAgentDialog, RequestLifecycleCard, TriggerSourceFields,
TriggerOccurrenceAudit, PostImportAccessReview, OutputAgentApp, AssistantEntry,
AssistantSettings, OutputAgentDesignation, PackageExportDisclosure and
AgentPackageDialogs; shared Chat/voice/reply-preview/attachment/size/usage controls
were included in the recent UI source census. Context recovery, memory transfer,
import, retry and voice hold hints were shortened where needed. Output/Assistant
settings and their existing controls already use short labels; no new explanatory
shell was introduced. Brief existing load-error messages in reused host shells are
not a new instructional surface.

Authored messages, workflow proposals, historical facts, original evidence,
server-supplied blockers/errors and policy content remain verbatim. These are
content/evidence, not UI tutorial copy. The existing canonical full-package export
warning remains explicit consequential consent; its shared core constant is not
rewritten or suppressed. No arbitrary sentence splitting is applied to canonical
content. Existing all-facts acknowledgements and separate confirmations remain.

All changes are display copy/layout only, including two UI-owned helper return
messages. No predicate, request body, route, key, hash, retry behavior, command
storage, evidence projection, approval gate or server eligibility changes.
No backend/core/SDK/DTO writes; the prior minimal tree client is unchanged.

## Changed source and fixture inventory

- `apps/web/src/components/BranchesView.tsx`
- `apps/web/src/components/ContextRecoveryPanel.tsx`
- `apps/web/src/components/GlobalMemoryTransfer.tsx`
- `apps/web/src/components/ImportAgentDialog.tsx`
- `apps/web/src/components/RequestLifecycleCard.tsx`
- `apps/web/src/components/TriggerSourceFields.tsx`
- `apps/web/src/components/branches/BranchDisclosureReview.tsx`
- `apps/web/src/components/branches/BranchExecutionBudget.tsx`
- `apps/web/src/components/branches/BranchGenerationOne.tsx`
- `apps/web/src/components/branches/BranchGroupReview.tsx`
- `apps/web/src/components/branches/BranchHistoryReview.tsx`
- `apps/web/src/components/branches/BranchHome.tsx`
- `apps/web/src/components/branches/BranchImportFiles.tsx`
- `apps/web/src/components/branches/BranchPackageDialog.tsx`
- `apps/web/src/components/branches/BranchPackageExportDialog.tsx`
- `apps/web/src/components/branches/BranchResourceReview.tsx`
- `apps/web/src/components/branches/BranchSettings.tsx`
- `apps/web/src/components/branches/ExecutionPanel.tsx`
- `apps/web/src/components/branches/GroupJournalAudit.tsx`
- `apps/web/src/components/branches/NodeEditor.tsx`
- `apps/web/src/components/branches/branchGenerationOne.ts`
- `apps/web/src/components/branches/branchGroupReview.ts`
- `apps/web/src/components/chat/ChatMessages.tsx`
- `apps/web/src/components/lifecycle/BranchLifecycleReview.tsx`
- `apps/web/src/components/lifecycle/GroupCaptureAbandonmentReview.tsx`
- `apps/web/src/components/lifecycle/LifecycleDiscovery.tsx`
- `apps/web/src/components/lifecycle/LifecyclePanel.tsx`
- `apps/web/src/components/lifecycle/LifecycleReview.tsx`
- `apps/web/src/components/speech/VoiceConversation.tsx`
- `tests/chats/branch-generation-one-mounted.tsx`
- `tests/chats/branch-group-review-mounted.tsx`
- `tests/chats/group-capture-abandonment-mounted.tsx`
- `tests/chats/phase2-ui-copy.test.mjs` (new deferred source guard)
- `docs/phase2-ui-copy-census.md` (this census)
- `docs/web-feature-completion.md` (coverage pointer)

## Deferred qualification and concrete remainder

`phase2-ui-copy.test.mjs` guards short UI-owned static JSX text and retained warning
fragments; it intentionally does not parse arbitrary user/server content as UI
copy. Existing mounted generation-history/group fixtures now assert labelled
eligibility/budget/per-owner requirements and directory reuse; abandonment fixture
asserts both original member counts after remount. Existing lost-response, exact
GET recovery, no-replay, stale409, policy and full evidence fixtures remain.

No tests, checks, typechecks, builds, Node/native/browser runs, runner preparation,
installs, push, merge, deployment or workers were performed. Fixtures are authored
and unexecuted. Source reading and Git/file inventory are the only verification.

Integration: this successor and required backend/core equivalents are assembled.
Remaining: separately authorized deferred fixtures and rendered
copy/accessibility/mobile/font-size/keyboard/reader qualification. Short source
hints can still wrap on narrow displays; no visual or whole-Bible-29 acceptance
follows from this census. The existing owner-tree DTO limitation remains: Call
attempt IDs, original Branch counters and numeric fresh acceptance budgets are
unavailable; this copy cleanup adds no evidence or inference. Prior runtime,
provider/native/filesystem and other Phase 2 qualification gates remain deferred.


## Additional browser and runtime surfaces

The later source census found instructional blocks in browser controls, local
browser pause, unavailable browser, workflow deletion, imported runtime review
and package binding. Those surfaces now use concise status and action labels.
Browser access is granted by choosing an Agent; closing a browser panel leaves its
tabs open. A private sign-in pauses Agent access until the user selects Done
signing in; native sign-in controls require Linux. A paused paired browser may be
used directly before resuming access in the extension without re-pairing. An
Agent with no browser may open a temporary one in its next Run or receive
permission to use the saved browser.

Consequential decisions retain their facts beside the action: reopening replaces
the failed session, closes its remaining window, reuses the saved profile when
available, may require fresh website sign-ins and may not restore unsaved forms
or tabs. Saved-browser promotion tells the user who can access the browser, that
Agent access requires permission, and whether app restarts close tabs. Deleting a
trusted profile permanently deletes its cookies, logins and site storage and
returns assigned Agents to disposable browser profiles. Deleting a workflow may
remove its other Chats and Agents. Imported runtime owner state and the limits of
reserved frontier identifiers remain visible during review.

This source-only census is not exhaustive or a visual verification. Errors and
user-authored content retain their causes and context. Desktop/mobile rendering,
accessibility and the full copy audit still require qualification.


A second static text scan surfaced additional candidates beyond the earlier
inventory. Whole-folder export and import activation, differing Chat
instructions, temporary workflow surfaces and native stop are now shorter
labels. Bulk Chat deletion still shows each permanent deletion, cancellation,
retained file and active-Agent outcome beside the confirmation. The scan also
found remaining multi-sentence errors, status messages and previews. Those
require individual review and rendered checking; this scan does not establish
zero informational blocks.

## Further source review

A follow-up reviewed 34 static multi-sentence JSX text candidates and additional
literal status, helper and warning candidates. Errors, recovery guidance, preview
limitations, user content and consequential confirmation text retain their
specific facts; their presence does not by itself establish an informational
tutorial block. Additional Map setup and import binding instructions now use
short labelled hints. Cron format, notification retention, sensitive-file
selection and saved-browser reopening retain their conditions in concise copy.

This is a static source review, not evidence that all dynamic text has been
enumerated or that the desktop and mobile renderings are free of wrapping,
overlap or informational blocks. The remaining rendered audit is still required.
