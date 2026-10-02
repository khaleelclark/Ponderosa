# UI refinements — Round 2

One PR based on `c22bbcb29c651061a9bab72e63c093b800058cab`. No merge,
deployment, shared sandbox refresh, provider Run, or live-data repair is included.

## Changes

- Submitted text/attachments leave the visible composer immediately. The exact
  durable draft remains recoverable internally until confirmation; failed sends
  restore it. Rendering an empty editor cannot rewrite that draft or erase its
  failure message.
- New-Agent creation reconciles the local echo using the accepted stable Agent
  ID and the exact `agent-opening:<id>` Communication. It never matches prose.
  Pending `#new-agent` is a chip; canonical mention projection replaces it with
  the current clickable handle. Stored opening text and delivery authority are
  unchanged. Implicit openings also expose their recipient; missing/deleted
  identities do not gain a synthetic navigation target.
- Autocomplete commits the edit/caret together. Delayed callbacks no longer
  reposition a caret over newly typed text. Lone special chips receive the same
  after-chip focus handling as Agent chips.
- Agent-provided file/download links use highlighted, underlined styling and a
  visible keyboard-focus outline. Existing routes and permissions are unchanged.
- Touch model selection retains editor focus. Mouse/keyboard selection remains
  operable, Escape restores focus, and the toolbar no longer remounts its runtime
  picker/dictation controls at a responsive breakpoint. Popper follows the
  existing app/visual viewport size.
- Mobile Chat/Agent titles truncate to preserve controls. Chat controls stay
  beside the title in both header states. Agent status/Stop stay in the identity
  row; the expanded header places its overflow menu beside the tabs. The status
  dot has a descriptive accessible label and opens textual details. Stop targets
  and meaning are unchanged.
- Follow-up controls stay compact and say **Dismiss**, not **Dismiss Follow-Up**.
  Existing retry confirmation and dismissal behavior are unchanged; wrapping
  remains a safe fallback for enlarged text or additional actions.
- Modified & Created Files already sorts by recorded artifact creation time,
  newest first. No product ordering change was needed. Pagination/reload are
  covered by a runnable regression, not claimed as live filesystem-mtime sorting.
- Dictation requests final results only. Unused Android interim callbacks can be
  promoted to final results in continuous mode, producing growing repeated
  phrases. Final-result indices and recognition generations remain fenced;
  rapid final insertions commit synchronously. No phrase deduplication is used.

The compact header/follow-up requests come from the six-page Round 2 PDF.
Touch targets and explicit status details are retained instead of using color
as the sole status explanation.

## Reproduction and checks

The dictation callback fixture models the Android Chromium bridge documented in
[Chromium's Android recognizer source](https://chromium.googlesource.com/chromium/src/+/27c7fe6e7a57093e09bcdb675cc6cfedac716110/content/public/android/java/src/org/chromium/content/browser/SpeechRecognitionImpl.java).
It is not a recording from the user's phone. Restoring the previous interim
setting makes the growing-phrase regression fail. Restoring the old visible-draft
binding makes the immediate-clear regression fail. The caret probe reproduced
`hi after#new-agent` before the atomic insertion fix.

```sh
pnpm verify
node --test packages/agents/test/opening-mention-presentation.test.mjs
node apps/web/test/optimistic-send-browser.check.mjs
node apps/web/test/mobile-workspace-layout-browser.check.mjs
node apps/web/test/message-receipt-layout.check.mjs
node apps/web/test/file-preview-links-browser.check.mjs
node apps/web/test/sent-draft-navigation.check.mjs
node apps/web/test/composer-chip-accessibility.check.mjs
```

Browser scripts use the existing `PONDEROSA_PLAYWRIGHT_PATH` and
`PONDEROSA_CHROMIUM_PATH` configuration. Use `PONDEROSA_TEST_BROWSER=webkit`
for the optimistic, mobile layout, link and draft-navigation checks. The chip
checker instead uses `PONDEROSA_BROWSER_ENGINE=webkit`. No new dependency is
added. Fixtures use disposable data and real components/HTTP-store paths where
the existing check provides them; they do not establish live multi-Agent behavior.

## Implementer verification

On macOS with Node 24.21.0:

| Check | Result |
| --- | --- |
| Final quiet `pnpm verify` | 995 passed, 7 platform/opt-in skips, zero failures; all typechecks and production builds passed |
| Optimistic send/creation | Chromium and WebKit passed at 390/1440px, including delayed creation commit and failure restoration |
| Mobile layout, picker, dictation and caret | Chromium and WebKit passed, including 320/390px and desktop, orientation-sized changes and first typing after send |
| File/download link presentation | Chromium and WebKit passed |
| Sent-draft navigation | All 15 Chromium and 15 WebKit scenarios passed |
| Compact receipts and guarded retry | Chromium passed at mobile/desktop widths |
| Composer chips, accessibility targets and file/drop behavior | Chromium passed |
| Opening identity projection | New focused regression passed within the full suite |
| `git diff --check` | Passed |

An earlier full run overlapped browser checks and failed the unchanged
proxy-restart test (HTTP 502 instead of 200). Its focused rerun passed 6/6;
the final full run without concurrent browser checks also passed it. No proxy
code or assertion was changed to obtain that result.

Logs are retained locally at `/tmp/ponderosa-ui-round2-*.log`, including
`ponderosa-ui-round2-verify-quiet-final.log`. These are implementer results,
not independent approval. The skipped checks are not passing qualification.

## Manual checklist

- [ ] Send, navigate away/back, and fail a send: no duplicate draft; failure recoverable.
- [ ] Create an Agent: one message, pending chip becomes the correct clickable handle.
- [ ] Autocomplete and send a reply: subsequent typing follows the chip.
- [ ] File/download links look clickable and show keyboard focus.
- [ ] Open/select the model with the phone keyboard up; rotate without losing the picker/draft.
- [ ] Mobile headers: long title, usage, menu/browser, status details and Stop are usable.
- [ ] Follow-up controls: compact **Dismiss** and guarded retry behave as before.
- [ ] Files: newest first after refresh and loading older files.
- [ ] Ponderosa microphone: no growing duplicates; typed text, repeated words, pause/resume preserved.

Physical Samsung/iPhone keyboards, native microphone services, installed Safari,
screen readers and a live managed-provider workload remain separate qualification.
Store reopening and isolated browser fixtures are not full application restart
or production-release approval.
