# Emulated-mobile Chat and adjacent human-text qualification

This bounded follow-on uses integrated base `051f5647219550180da6eb2977b9a9c456ad1b53` in the isolated `phase2/ui-mobile-adjacent-input` worktree. Approved desktop extension `7581884c` is locally cherry-picked as `f5d7317e9`; its original checkout stays frozen. Integration and independent review remain required.

## Actual coverage

| Product | Light cells | Dark cells | Complete accepted/canonical or provider values |
|---|---:|---:|---:|
| Core | 22 | 22 | 48 |
| Branches | 21 | 21 | 48 |
| Assistant | 13 | 13 | 30 |
| Designated output | 13 | 13 | 30 |

The 138 cells include 156 complete values. Three-question Decisions and two-field interventions account for extra values. Of these, 140 values have canonical message/Decision/queue/workflow persistence; 16 provider form values are verified at their accepted endpoint and exact controlled provider callback and deliberately are not persisted in Decision content. There are 296 trusted multiline paste events: 148 LF and 148 CRLF. Eight enum cells are constrained selections rather than free-text paste controls. Each selected cell has a screenshot, HTML and text capture; images are evidence of a state, not universal visual approval.

| Actual input/caller | Core | Branches | Assistant/output |
|---|---|---|---|
| Main shared Chat composer | Both themes | Both themes | Not exposed by standalone route |
| Agent private Chat composer | Both themes | Both themes | Both actual standalone URLs, both themes |
| Inbox main reply | Both themes | Global Core surface | Not exposed |
| Queue editor | Agent/shared/Inbox, both themes | Agent/shared, both themes | Agent, both themes |
| Typed call turn | Agent/shared/Inbox, both themes | Agent/shared, both themes | Agent, both themes |
| Decision answer | Agent/shared/Inbox/notification, both themes | Agent/shared/notification/execution, both themes | Agent, both themes |
| Choice/approval alternatives | Both themes | Both themes | Both themes |
| Three-question answer form | All three answers, both themes | All three answers, both themes | All three answers, both themes |
| Runtime form/URL alternatives | Both themes | Both themes | Both themes |
| Initial Agent task | Root create route, both themes | Delegated embedded creation, both themes | Delegated embedded creation, both themes |
| Long-paste editing dialog | Both themes | Both themes | Both themes |
| Structured provider string | Free string and enum selection, both themes | Same | Same |
| Editable gate result | Workflow surface | Both themes | Not exposed |
| Intervention observed output and reason | Workflow surface | Both fields, both themes | Not exposed |

The source census remains 135 declarations: 11 Chat/editor declarations, four explicitly adjacent human-text declarations, and 120 other declarations. InboxView replaces the old filename in the classifier. This is rendered representative-caller coverage, not every attachment, schema, runtime or permission combination.

## Engine and exact text boundaries

Installed Chromium `155.0.8059.79` runs at 390×844 CSS pixels, DPR3, with `isMobile`, `hasTouch` and a recorded mobile user agent. Native pointer actions use touch taps. This is actual browser emulation, not physical Android, iOS, Safari, touch-menu paste or IME qualification. The maintained bridge uses only installed playwright-core and Chromium. It passes real permissioned Clipboard API writes to trusted keyboard paste; no synthetic paste event is dispatched.

Chromium delivers raw LF and CRLF unchanged to the paste listener. Main Lexical drafts and requests retain delivered CRLF. The canonical Communication store then applies the repository's explicit LF/NFC policy. Native textareas normalize line breaks in the field value. The oracle checks complete draft, accepted request and canonical/provider values separately, including Unicode, an internal blank line and exact trailing text. It does not trim, strip prefixes or normalize an accepted request to conceal loss. Conditional forms submit their last CRLF delivery; LF is independently draft-qualified here. This follow-on does not rerun the predecessor's desktop rapid send/second-paste sequence or mobile LF submissions for every conditional owner.

Shared Chat's empty default-destination path legitimately creates a new default Agent. Its returned stable ID, Broadcast scope and complete canonical body are checked. Private, Inbox, queued, typed-call and initial-task routes retain their distinct routing rules. Provider callbacks are recorded by exact Decision ID so a reused Assistant Agent cannot overwrite a previous theme's receipt.

## Corrections and accessibility evidence

A retained native WebKit paste fails on the provider free-string field because its single-line input drops line breaks. Free-string fields now render multiline; enum, number and boolean controls retain their schema-driven behavior. Provider enum choices are checked against actual allowed options and exact endpoint/callback values. No meaningful error, safety or consent copy was removed.

The mounted desktop BrowserWindow separator also lacked its current value. It now exposes actual width, bounds and pixel text. Both desktop WebKit themes expose 400 pixels and change to 368 after the actual keyboard resize action. Focus is explicitly placed on the separator before the key; this is not full Tab traversal proof.

Original #27 targets are checked separately: desktop Core sidebar exposes its numeric current value; mobile Branch views expose four actual named tab buttons, including an actually disabled unpublished Executions button, without the former disabled-wrapper substitute. Full integrated #27 acceptance remains open.

A separate live finding remains: BrowserPageStrip places its `New browser tab` button inside `role=tablist`. Its failing DOM/screenshot and invalid interactive descendant are retained. The browser numeric-value test records that finding separately and does not claim a clean browser-tab audit. No fake landmark, hidden finding, global zero-violation or whole-UI claim is made.

## Verification and provenance

Builds completed before browser qualification. Web typecheck and production build pass. An initial dependency-copy build failed on stale workspace links; the corrected isolated local links and sequential build pass. The original native binding is reused with retained hash; schema assets use the repository copy script. No installs or external providers are used.

Six maintained oracle regressions pass, including complete tails, recipient substitution, raw submitted CRLF versus canonical LF, shared default-Agent Broadcast routing and exact provider receipt ownership. The source census regenerates byte-identically and maintained inventory loads. No whole suite, full performance or panel run was performed.

The 138-cell result is a finite selected corpus, not one clean combined invocation. Retained runs include stopped header/drawer/tooltip selectors, an incorrect single-line label matcher, a falsely required aria-disabled attribute on a native disabled button, and incomplete provider receipt telemetry for a reused Assistant. Native touch taps replace the emulator's mouse-hover mismatch; ordinary readiness/focus checks add no draft settlement delay. All failed/setup/oracle outputs remain. Completed Core/Branches rows are independently verified from partial runs. Two overwritten Assistant string receipts are explicitly excluded from that selection and replaced by focused runs with exact Decision-indexed receipts. A verification view retains unchanged raw requests/state and records the exact selected cases. A separate four-cell shared-composer run passed browser actions but initially failed incorrect oracle routing assumptions; its complete raw evidence passes the corrected Broadcast/default-Agent oracle. Planned keys equal selected keys exactly once.

Full commands, selected run/key provenance, before evidence, source and screenshot hashes, canonical snapshots, trusted event payloads and exact viewport/engine metadata are in the accompanying evidence archive and report. No production/live-dev deployment, integration checkout edits, provider account, paid inference, credentials, installation, push or merge occurred.

## Remaining gates

Independent review and manager-owned integration/final development-candidate proof; the additional BrowserPageStrip defect; broader conditional/schema/attachment/oversized/edge-whitespace/offline/reload/uncertain-send combinations; microphone/audio permissions; physical devices/phone keyboards/IME; screen readers; full performance/panel and release gates. The new mobile cells and original #27 focused targets are bounded evidence, not whole-UI/Bible/release completion.
