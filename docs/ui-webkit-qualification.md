# WebKitGTK product qualification

Run the existing WebKitGTK engine against a built disposable Ponderosa fixture:

```sh
QUALIFICATION_DIRECTORY=/absolute/evidence/path node --import ./tests/shared/workspace-resolution.mjs tests/workspace-navigation/webkit-qualification.mjs
```

Build the web assets first; never build while the qualification is serving them. The runner uses the existing controlled-provider fixture and the installed Docker image `unified-native-runtime:driver-2.1.0` with `--pull=never`. It installs nothing. Standard-library Python drives the installed WebKitWebDriver. Existing GTK3 owns the native X clipboard while native WebDriver keyboard actions paste into the real shared composer. Only the owned evidence directory and qualification scripts are mounted. Fixture and driver/container cleanup run when the qualification finishes.

This tests **WebKitGTK MiniBrowser**, with its exact engine version and user agent recorded. The narrow window is a **mobile viewport**, using the same desktop WebKitGTK engine and keyboard; it is not Safari, iOS, an iPhone simulator, or mobile keyboard qualification.

Eight cells cover Core/Branches × light/dark × desktop/narrow window. Requested outer window sizes are 1440×1000 and 390×844. Actual `innerWidth`, `innerHeight`, device-pixel ratio and user agent are recorded rather than inferred from those sizes.

Each cell checks rejected oversized instructions, exact dirty draft and canonical saved text/revision, one meaningful error, corrected save/error removal, immediate Font save rejection/retry, rename Enter failure and retry, and native LF/CRLF clipboard paste with Shift+Enter and explicit send. The host checks one accepted submission and exact whole canonical message per paste, including the known shared scope prefix. The actual default New Agent destination may submit `initialMessage`; regular message sends use `text`. Both are compared without removing body content.

Two browser differences are recorded explicitly:

- WebKit `innerText` adds a block-ending newline to the Lexical paragraph. The qualification serializes the actual plain-text Lexical span/break nodes, preserving every explicit break and rejecting an unexpected tree. It does not trim trailing body text. Raw DOM/innerText are retained.
- WebKit normalizes native CRLF clipboard text to LF before the application listener receives it. Raw payload equality is recorded separately, not claimed to pass for that case. The complete browser-delivered text, resulting draft, submitted body and stored canonical body are compared exactly with the explicitly LF-normalized expectation. Trusted events are required.

The shared Voice options menu and initial unavailable-call dialog are captured. Transcript & typing exposes an unsent local draft, its warning and End call behavior. No microphone, speech playback, call Send turn or real provider inference is started. Speech consent on a supported speech engine, permission denial, recording, retained uncertain-send retry, cancellation and spoken reply states remain separate checks.

PNG screenshots, rendered text, HTML, injected/actual API requests, mounted-page errors and unhandled rejections, native clipboard events, exact canonical bodies and engine/viewport data are retained. Error listeners are installed after each completed navigation; initial-load failures before that point are not covered by that observer. These are finite functional checks, not a whole-UI accessibility, screen-reader, visual-panel, Safari/iOS, performance or release verdict. Prior failed harness/smoke runs remain evidence.

A rapid second paste during post-send destination hydration was also captured: a Branches draft acquired the prior recipient prefix (`#Willow`) before the new body. That run remains a failed finding, not a pass. The settled-flow matrix waits 800 ms after sending before beginning the next separate message, matching the prior clipboard runner’s settled-message check. It does not qualify the rapid send/default-destination race. Follow up at shared composer destination hydration, preserving the exact stored draft and routing evidence.
