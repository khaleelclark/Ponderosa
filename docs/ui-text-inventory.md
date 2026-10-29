# UI text review and failure recovery

Settings saves have one owner for failure presentation. Explicit-save forms show the exact rejected-save cause inline, retain dirty drafts and remove the error after a successful save. Immediate-save controls report failure in their shell; retry replaces or clears that failure. Both products use the canonical preference queue. The queue itself does not discard drafts or turn a failed write into success.

Detailed product explanations are in [UI detail reference](ui-detail-reference.md). Short action hints, destructive-action warnings, permission/consent text, exact errors and provider-authored data remain meaningful UI content.

## Rendered callers

| Caller | Shared surfaces | Disposition and evidence |
| --- | --- | --- |
| Core App → WorkspaceSettingsView | General settings, global instructions, notice queue | Oversized rejected-save draft, canceled reload, corrected save, one exact error and error removal qualified in both themes. |
| Branches → BranchGlobalSettings → WorkspaceSettingsView | Same forms and controls, Branches namespace | Form owns explicit-save errors; shell owns immediate-save errors. Both themes use the same failure/retry qualification. |
| Core/Branches Chat → ChatOverflowMenu → rename dialog | Menu handoff, exact failure text, retained title, Enter retry | Failure and successful retry qualified in both themes. |
| BranchesView → BranchSettings → BranchExecutionBudget | Budget policy hints and reset warnings | Both themes rendered in the preceding text-cleanup batch; workflow controls unchanged. |
| BranchesView → BranchRunHistory → BranchTriggerAudit | Trigger Events dialog | Both themes rendered in the preceding text-cleanup batch; accepted/completed distinction remains. |
| Core/Branches AgentDetail → VoiceConversation | Consent, foreground status, unsent words, uncertain-send retry | Source/caller inventory only for conditional audio/permission/failure states. Keep consent, unsent-loss and retained-retry warnings; do not replace exact failures with generic text. No new voice qualification claim. |
| Browser/Agent/profile/package/file dialogs | Consent, destructive effects, credentials exclusions, exact runtime failures | Previous 48-copy disposition applies; source inventory lists conditional callers. Full conditional rendered-state coverage remains pending. |
| Assistant/output apps | Shared Chat and call chain after feature integration | Separate feature branch; qualify real integrated routes after its file-scope correction passes review. |

The evidence inventory records every selected Alert, Typography, DialogContentText, description/helper/title attribute and template expression in all web TS/TSX source files, with direct import callers and source location. This is a source inventory, including non-UI templates; it does not prove every expression is visible or approve every candidate as compliant. Aliased, re-exported and indirect callers require route tracing.

## Remaining review

- Conditional dialog/error/call states need real rendered evidence, especially permission denial, browser replacement, imports with private history, truncated previews and retained audio retry. Preserve their safety/error meaning while judging copy.
- Provider-authored contracts, canonical messages, user-supplied help and exact diagnostics are data; do not shorten or silently truncate them as explanatory product copy.
- Tooltip portals have correct `role="tooltip"` outside page landmarks. Keep existing descriptions and focus behavior. Do not assign artificial landmark roles to silence the moderate axe region finding. This finding remains recorded, not waived.
- Safari/WebKit qualification requires a runnable installed engine. Chromium device emulation does not establish Safari behavior. The host Playwright WebKit launcher is present but cannot start because required libraries are missing. The existing `unified-native-runtime:driver-2.1.0` container launches WebKitGTK MiniBrowser 2.52.6 with its installed WebKitWebDriver; a Unicode input smoke check passes. No browser, image or system packages are downloaded or installed by this review. This establishes an available WebKit path, not Safari/iOS product coverage.

No whole-UI, zero-paragraph, zero-moderate, Safari or screen-reader completion verdict follows from this inventory.

## WebKitGTK rendered-state extension

The [WebKitGTK qualification](ui-webkit-qualification.md) adds both themes and desktop/narrow-window coverage for Core and Branches. Actual caller chain: Core App or BranchesApp → ProjectShell → shared Composer → DictationControls → VoiceConversation. Captured conditional states are unsupported dictation/read-aloud, initial unavailable call, expanded transcript/typing, an unsent local turn and its loss warning, then End call. No speech starts or call turn is sent. Settings exact rejection, immediate-save outage and rename outage are deliberately injected against disposable API fixtures. Raw DOM/text/screenshots and the finite state matrix are retained.

Remaining conditional states are explicit: supported-speech remote-processing consent; microphone permission denial and recording errors; recognition finalization; queued/waiting/streaming/speaking replies; uncertain call-send retention/24-hour expiry/reload; reply cancellation failure; browser sign-in/profile replacement; package import/update conflict and sensitive-history consent; file preview truncation/unavailability; user/provider-authored dynamic content; future integrated Assistant/output routes. Preserve their meaning and exact failures. No source-only candidate is promoted to rendered compliance by this extension.
