# Mobile audit regressions

Scope: the actual shared Composer and mobile audit surfaces. Android retains
Enter-to-send; mobile Shift+Enter is corrected. Desktop interaction/layout stays unchanged.
The fixture has no real conversation ID,
intercepts API calls and does not start provider work.

From `apps/web`, run `pnpm exec rsbuild dev --config test/mobile-ios-composition/rsbuild.config.ts`.
From the repository root, run `node apps/web/test/mobile-ios-composition/browser.mjs`.
Also run `node apps/web/test/mobile-ios-composition/audit-browser.mjs` for the
320/390/412/1200 px light/dark layout, contrast, navigation, and push-state matrix.
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
No viewport arithmetic, automatic scrolling, routing, or recipient semantics were
changed. Plain Android/desktop Enter-to-send remains. Desktop Shift+Enter is
intentionally unchanged; the duplicate-newline fix is mobile-scoped.

Physical iPhone 17 verification remains required in both Safari and the installed
PWA: record iOS version; focus/dismiss/reopen repeatedly; use long drafts; rotate
with keyboard open/closed; check caret and Send visibility, actual dictation,
attachments, recipient controls, native Return, and pinch zoom. Also verify an
Android phone. Emulated viewport changes are not actual soft keyboards, native
pickers, dictation or installed-PWA certification. If displacement remains,
capture VisualViewport height/offsetTop/scale and document scroll during focus
before changing the existing viewport algorithm. No deployment is authorized by these checks.

## Finding coverage in PR #485

| Finding | Implemented change | Verification boundary |
| --- | --- | --- |
| F01 | Native/Lexical owns mobile Shift+Enter; iOS Return inserts a line break | Chromium/WebKit exact outgoing strings; hardware keyboard/IME remains physical coverage |
| F02 | Mobile table cell width floor, horizontal scrolling, visible hint and keyboard focus | Narrow table geometry and scrolling in both engines |
| F03 | Mobile caption is a constrained block, reserving badge space | Long automation Project/Agent text at 320/390/412 px, both palettes/engines |
| F04 | Multiline textbox/autocomplete semantics, English HTML language, darker mobile placeholder | DOM assertions and computed contrast >=4.5; VoiceOver/TalkBack still required |
| F05 | iPhone Home Screen installation guidance, installed-app prerequisites and denied-permission recovery | State classification; no delivered push or OS permission claim |
| F06 | Mobile Project chat enables the existing dictation control | Shared control/unsupported reason visible; actual microphone and final transcription still device checks |
| F07 | Existing compact header is the mobile default, expandable without changing desktop preference | Expand/tab/collapse checks; reduced-height Composer/Send geometry |
| F08 | Mobile section is accurately named Recent Assigned Work with current-status description | Running work no longer presented as necessarily finished; underlying query/state untouched |
| F09 | Mobile reading scale restored to 16 px, larger Markdown text, 44 px message-action targets | Computed dimensions; physical long-press/selection still required |
| F10 | Remove obsolete drawer padding, wrap Project name, readable narrow navigation rows | Narrow labels fit; wider mobile layouts retain compact columns |
| Addendum | iOS 16 px editor, Return-to-newline, manifest allows rotation | Focus zoom/displacement remains a physical iPhone browser/PWA acceptance gate |

Shared semantic metadata (textbox role and document language) is corrected globally;
visual changes are mobile-scoped. There are no runtime, routing or durability changes.

Validation: 12 composition profile/mention executions and 16 audit width/palette
executions across Chromium/WebKit; 12 existing reply and four lifecycle browser
checks; 181 web tests; typecheck and production build. Fixtures intercept all APIs.
Screenshots were inspected with the real theme, fonts and CssBaseline.

Platform references: [WebKit Home Screen push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
and [WAI-ARIA textbox/autocomplete semantics](https://www.w3.org/TR/wai-aria/).
