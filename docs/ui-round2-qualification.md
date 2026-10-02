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

## Folder and general-file follow-up

- General file selection no longer filters out fonts, source/configuration,
  spreadsheets/slides, media, archives or unknown binary formats. Original bytes
  are admitted as `application/octet-stream` when they are not an existing
  validated format. This is attachment support, not a promise of decoding,
  semantic validation, malware scanning, execution or inline preview.
- TTF/OTF/TTC/WOFF/WOFF2 cards say **Font file** and offer download, not automatic
  browser loading or font installation. Runtime copies preserve the original
  name/extension and hash; Agent tools can inspect the explicitly supplied file.
- Folder drop and the **Folder** picker prepare one stored ZIP per root,
  preserving relative file paths and original file bytes. No server-side folder
  traversal or automatic extraction is introduced. Browser enumeration is
  captured during drop and consumes all directory-reader batches, following
  [the directory-entry API](https://developer.mozilla.org/en-US/docs/Web/API/DataTransferItem/webkitGetAsEntry).
  Picker paths come from [webkitdirectory](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory).
- Preparation is bounded to 2,048 enumerated entries, 16 path components, 1,024
  UTF-8 bytes per path, 30 seconds total and the existing 80 MiB message/file
  budgets (including ZIP overhead). Duplicate/unsafe paths and unreadable or
  oversized folders fail without attaching a partial folder. Empty directories
  are not separately archived. No compression or new dependency is introduced;
  the archive uses the stored method/CRC32/UTF-8 records in
  [the ZIP specification](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT).
- Hidden entries, `node_modules`, common credential/secret filenames and key
  extensions are excluded, with a visible skipped-item count. This is not a
  secret-content scanner; review selected contents before sending. An explicit
  individual file or prebuilt archive is not silently filtered by this policy.
- Preparation shows progress, blocks Send until complete, and is cancelled if
  the composer/destination becomes unavailable. It does not follow the user to
  a different Chat. Finished ZIPs use the existing durable upload path.
- Existing protected image/PDF/DOCX/text/JSON/ZIP suffix validation, image
  resource limits, quotas, scoped access, exact-byte hashes and download
  `attachment`/`nosniff` headers remain intact. Opaque admission cannot downgrade
  a malformed protected-format file or spoof an image/document preview MIME.

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
node --test apps/server/test/opaque-attachments.test.mjs
```

Browser scripts use the existing `PONDEROSA_PLAYWRIGHT_PATH` and
`PONDEROSA_CHROMIUM_PATH` configuration. Use `PONDEROSA_TEST_BROWSER=webkit`
for the optimistic, mobile layout, link and draft-navigation checks. The chip
checker instead uses `PONDEROSA_BROWSER_ENGINE=webkit`. No new dependency is
added. Fixtures use disposable data and real components/HTTP-store paths where
the existing check provides them; they do not establish live multi-Agent behavior.

## Initial UI verification (before the folder follow-up)

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

## Folder follow-up verification

On the final source with macOS / Node 24.21.0:

| Check | Result |
| --- | --- |
| Full `pnpm verify` | 1,002 passed, 7 platform/opt-in skips, zero failures; all typechecks and production builds passed |
| Folder collection and ZIP regressions | Four tests passed: paginated enumeration, original bytes/CRC/UTF-8 records, picker paths, limits, cancellation and guarded formats |
| Opaque upload HTTP/store regressions | Three tests passed: fonts/general formats, draft promotion/reopening/runtime bytes, protected-format and size rejection |
| Composer folder/font selection | Chromium and WebKit passed, including a real disposable directory input, synthetic drop entries, exclusions and cancellation on Chat switch |
| Font card and download links | Chromium and WebKit passed; fonts remain download-only and are not fetched for active preview |
| Independent ZIP interoperability | macOS `unzip -t` passed CRC/data checks; libarchive `tar` listed the exact Japanese path and extracted the original bytes |
| `git diff --check` | Passed |

The old macOS Info-ZIP build lacks Unicode support; its listing was not treated
as Unicode qualification. Browser checks do not qualify physical-device native
picker dialogs. The final full-suite log is
`/tmp/ponderosa-folder-verify-complete.log`; focused browser logs are
`/tmp/ponderosa-folder-{chromium,webkit,font-card-chromium,font-card-webkit}.log`.
These are implementer results, not independent approval.

## Python rejection follow-up

Read-only HTTP checks on October 2 found that both the earlier sandbox on port
37443 and dev on port 10443 still returned the old `/api/asset-limits` list,
without `application/octet-stream`. Replaying that list in the composer
reproduces the reported Python rejection. The screenshot does not establish
which endpoint was used; neither checked endpoint has the new admission list.
No service or live data was changed by these checks.

The current product code already accepts `.py` with Python-specific MIME,
plain-text, generic binary and empty MIME values. A test-only follow-up adds
explicit Python original-byte HTTP/runtime/reopening coverage and mixed
Python/Rust/CSS/extensionless/YAML/archive drops in the actual composer.
Fresh web tests passed 299/299, focused server tests passed 3/3, and the
Chromium/WebKit desktop/mobile composer checks passed. Evidence is retained
in `/tmp/ponderosa-python-{web-tests,server-tests,chromium,webkit}.log`.
The preceding 1,002-pass full suite is evidence at `efa188376942ece808e1f927cdc9ff0232feff13`;
this follow-up changes tests and qualification documentation only.

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
- [ ] Attach TTF/OTF/WOFF/WOFF2 and other files; exact downloads work and fonts are not installed/previewed.
- [ ] Drop/select a nested folder: one ZIP, preserved paths, visible exclusions; navigate during preparation without leaking it to another Chat.

Physical Samsung/iPhone keyboards, native microphone services, installed Safari,
screen readers and a live managed-provider workload remain separate qualification.
Store reopening and isolated browser fixtures are not full application restart
or production-release approval.
