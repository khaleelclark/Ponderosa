# iOS composition regression

Scope: the actual shared Composer, iOS Return policy and font size; Android and
desktop retain their existing policy. The fixture has no real conversation ID,
intercepts API calls and does not start provider work.

From `apps/web`, run `pnpm exec rsbuild dev --config test/mobile-ios-composition/rsbuild.config.ts`.
From the repository root, run `node apps/web/test/mobile-ios-composition/browser.mjs`.
Set `PLAYWRIGHT_PACKAGE` to a package.json with Playwright available if external,
and optionally `CHROMIUM_PATH` or `BROWSER=webkit` / `WEBKIT_PATH` for the browser.
Use the browser runtime's required libraries; do not install host packages just
for this fixture. `BASELINE=1` skips the new font assertion to reproduce the old
iOS Return-to-send failure separately.

Checks cover both mention/no-mention drafts in Chromium and WebKit:

- iOS editor is 16 px; Android/desktop editor remains 15 px.
- iOS Return, consecutive Returns and Shift+Return serialize exact line breaks.
- An insertParagraph beforeinput event inserts one newline without submitting.
- Simulated IME Enter cannot submit; the explicit Send action submits once.
- Android and desktop Enter-to-send are unchanged.
- Long drafts remain bounded; attachment menu opens; repeated focus/dismissal
  and reduced-height/portrait/landscape geometry keep Composer and Send in bounds.

## Evidence and limits

Base: `15561648fdd48e6a85b3add9d4a45cfe7c27e53f` (PR #484).
Before the change, Chromium with the iPhone profile failed independently on
15 px editor text and Return submitting `first`. After the change both engines
pass all six profile/mention combinations. Existing 12 reply-destination checks,
181 web checks, web typecheck and the full production build also pass.

The prior viewport hook drops to layout height while scale differs from 1.
The iOS-only 16 px change avoids small editable text without disabling pinch
zoom. This is a focus-zoom mitigation, **not a reproduced physical-device fix**.
No viewport arithmetic, automatic scrolling, Android policy, desktop behavior,
routing, or recipient semantics were changed. The separate Chromium desktop
Shift+Enter audit finding is intentionally not changed in this mobile-only patch.

Physical iPhone 17 verification remains required in both Safari and the installed
PWA: record iOS version; focus/dismiss/reopen repeatedly; use long drafts; rotate
with keyboard open/closed; check caret and Send visibility, actual dictation,
attachments, recipient controls, native Return, and pinch zoom. Also verify an
Android phone. Emulated viewport changes are not actual soft keyboards, native
pickers, dictation or installed-PWA certification. If displacement remains,
capture VisualViewport height/offsetTop/scale and document scroll during focus
before changing the existing viewport algorithm. Other audit findings remain
separate follow-up work. No deployment is authorized by these checks.
