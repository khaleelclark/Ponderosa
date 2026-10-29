# UI text qualification extensions

## WebKitGTK rendered-state extension

The [WebKitGTK qualification](ui-webkit-qualification.md) adds both themes and desktop/narrow-window coverage for Core and Branches. Actual caller chain: Core App or BranchesApp → ProjectShell → shared Composer → DictationControls → VoiceConversation. Captured conditional states are unsupported dictation/read-aloud, initial unavailable call, expanded transcript/typing, an unsent local turn and its loss warning, then End call. No speech starts or call turn is sent. Settings exact rejection, immediate-save outage and rename outage are deliberately injected against disposable API fixtures. Raw DOM/text/screenshots and the finite state matrix are retained.

Remaining conditional states are explicit: supported-speech remote-processing consent; microphone permission denial and recording errors; recognition finalization; queued/waiting/streaming/speaking replies; uncertain call-send retention/24-hour expiry/reload; reply cancellation failure; browser sign-in/profile replacement; package import/update conflict and sensitive-history consent; file preview truncation/unavailability; user/provider-authored dynamic content; future integrated Assistant/output routes. Preserve their meaning and exact failures. No source-only candidate is promoted to rendered compliance by this extension.
