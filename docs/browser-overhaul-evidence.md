# Browser overhaul: milestone 0 evidence

Date: 2026-09-16. Baseline: `f3e44b8f94d2fa106c4e4c0c51119e2fb18301f5`.
The experimental deployment and clean source branch matched this revision.
Writer: this Codex task; branch `experiment/browser-overhaul`, based on
`experiment/chat-first`. No dev/prod promotion is authorized.

## Corrected starting point

The proposal reviewed an older revision. Current code already has headed Chrome
through a private Xvfb display, trusted retained profiles, profile leases,
multiple pages, managed-artifact uploads, and exact-Run/control fencing. The
Project browser still has a separate lifetime and defaults to disposable state.
Reuse these authority and lifecycle components; do not replace them wholesale.
Experimental is Chat-owned, so the proposal's Project selection/ownership must
be translated to explicit owning Chat context while retaining storage IDs.

## Reproductions

Used disposable profiles and locally owned HTTP fixtures only; no customer
cookies, real login credentials, live application submissions, or challenges.
All spawned browser/display groups were observed stopped during cleanup.

Reproduce after building: `node apps/server/test/browser-overhaul-probe.mjs
/absolute/path/to/checkout /new/path/to/results.json`. This is a diagnostic probe,
not an acceptance pass; reported defects must be read as defects. It intentionally
fails if the source callback changes so an obsolete reproduction is not reused.

| Check | Headed Chrome | Headless Chrome |
|---|---|---|
| Navigate to a form rendered after 1.2 seconds | Returned after 270 ms, form absent | Returned after 263 ms, form absent |
| Later observation of same delayed form | Form present | Form present |
| Cross-origin iframe control in semantic observation | Absent | Absent |
| Open shadow-root control in semantic observation | Absent | Absent |
| 100 visible controls, last control observable | No | No |
| Synthetic password value in semantic observation | Exposed | Exposed |

Executing the actual `sendInput` callback body with a pending transport dispatched
only one of three submitted non-scroll events. Two were silently dropped. This
is a source-extracted callback reproduction, not a physical Safari/IME test.

Baseline server tests: 220 passed. They did not catch these interaction defects.
The password observation issue receives a focused fix and real-Chrome regression
test in this first change. Ordinary text-field readback remains available.
After the fix, the same headed/headless probes report no password disclosure;
the other reproduced limitations remain open rather than being marked fixed.

## Target matrix

| Target | Observed / qualification status |
|---|---|
| Pine Ubuntu 26.04.1 x64 | Chrome 152.0.7977.75 and Xvfb available; headed/headless fixture probes run, Chrome sandbox not disabled |
| Linux x64 package | Advertised packaging target; clean browser provisioning not yet qualified |
| macOS ARM64 package | Advertised packaging target; browser overhaul not yet qualified |
| Windows x64 package | Advertised packaging target; browser overhaul not yet qualified |
| Linux ARM64 / other targets | Not qualified for this release |
| Safari client | No physical-client takeover, touch, paste, or IME qualification yet |
| Connected Chrome/Edge | No paired connector implemented or qualified yet |

## Provisional backend decision

Proceed toward a Playwright-backed **mechanics adapter** under existing server
authority, not an unrestricted MCP bridge. Preserve screenshot/coordinate
interaction and existing exact-Run fencing. Playwright's documented actionability
and frame/locator support match the reproduced failures, but this is not proof
of live ATS compatibility. The upstream extension is a reference/prototype only:
it does not supply Ponderosa pairing, tab grants, revocation, or remote transport.
Keep REST/SSE; do not introduce a new streaming protocol without measurements.

References checked September 16:
- [Playwright actionability](https://playwright.dev/docs/actionability)
- [Playwright browser connections/extension](https://playwright.dev/mcp/configuration/browser-extension)
- [Headed Linux execution](https://playwright.dev/docs/ci#running-headed)
- [Cloudflare browser limitations](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/)

## Open evidence gates

The user supplied an iCIMS campus application login on September 16
(`campus-americas.icims.com/jobs/25813/.../login`) and a screenshot of an extra
human-verification challenge. This establishes the observed symptom, not its
cause. The public fetch tool could not open that URL. No challenge was solved or
bypassed. The four-way manual-local / connected-local /
managed-host / existing-headless comparison is **not completed**. It needs a
representative authorized site and the user's participation on their computer.
No claim is made that headed mode, persistent cookies, or Playwright fixes bot
flags. No production backend decision or release acceptance is certified here.

## First interaction/panel slice

The browser now opens in a right-side expandable dialog from Chat browser actions
and message links, leaving the workspace route intact. Legacy browser deep links
remain supported. The address bar submits on Enter; Back/Forward/Reload use real
Chrome history through the existing fenced input channel. Restart and End Session
are separate, confirmed menu actions, not the panel close action.

Shared operator input now has a bounded FIFO queue, captures the session/control
epoch/selected tab at enqueue, and stops explicitly on errors/context changes or
backpressure. It never retries uncertain input. The page keyboard sink supports
native text/paste/composition, with editing keys forwarded to Chrome. Input
coordinates use the actual aspect-preserving image bounds. Managed file selection
appears only when the website opens its chooser; no selector field is exposed in
the ordinary browser panel. Device-file upload is still not implemented.

Checks: `node apps/web/test/browser-input-queue.check.mjs`,
`node apps/web/test/browser-panel.check.mjs` (Playwright path and Chromium path
configured), and `node --test apps/server/test/browser-navigation-input.test.mjs`.
Rendered checks cover desktop/mobile widths, FIFO typing, Unicode/paste, panel
expansion/close, and image geometry. Physical Safari/IME/touch remains unqualified.

This is not the full overhaul: connected browser pairing,
native local-file transfer, persistent workspace migration,
frame/shadow-aware semantic actions, and full release qualification remain open.
Next: stable tab-targeted backend operations and fixture-based outcome checks.
Ten prepared forms, twenty-tab resource tests, durable restart, uploads/downloads,
connector isolation, installer qualification, and independent review remain gates.

## Playwright hosted switch

The default hosted authority now selects Playwright Core 1.63.0 mechanics for
navigation, locator click/fill, history, keyboard/pointer input and screenshots.
Existing process ownership, bounded observations and verified managed uploads are
retained. See `browser-playwright-transport.md` for the private transport decision.
Both headed and headless real-browser fixtures pass delayed-field actionability,
shadow inputs, popup targeting, file chooser/upload and process cleanup checks.

A fresh headed Playwright profile loaded the supplied iCIMS URL on September 16
and displayed its email/consent landing form. No challenge appeared on that initial
load. No information was entered, consent given, Google OAuth attempted or form
submitted: this does **not** qualify the later sign-in flow or resolve the user's
reported challenge. The disposable profile/process was removed after capture.
Local-browser pairing remains unimplemented; hosted and local will share UI and
interaction semantics, not implicitly share profiles, authentication or networks.

## Resizable browser surface and independent viewing

Chat and Agent browser entry points now open the same non-modal surface without
changing workspace routes. Desktop supports a right dock (reserving app width),
draggable/resizable in-app floating mode, and expanded mode. Mobile uses the full
available viewport. Closing the surface leaves its browser session running.
This is in-app PiP, not an OS-level always-on-top window.

Tabs can be created, selected and closed (the existing eight-tab cap remains).
While an Agent owns control, selecting a tab changes only the viewed page. Follow
Agent returns to the action target; a blue marker identifies that tab. Frame
requests and cache entries are page-targeted without changing the action target.
Live frames use the existing CDP capture path rather than Playwright's screenshot
stability wait, which stalled background blank-page captures under the full test
load. Capture presents the viewed target's Chrome surface (including initially
unpainted blank tabs), but never changes the authority's action target. Actions
remain explicitly page-addressed. Background-rendering throttles are disabled
for this hosted viewer. Navigation, locator and input remain Playwright-backed.

Operator-controlled pages reflow to the container through bounded, debounced
viewport updates. Agent-controlled pages retain their geometry: watching or
resizing the viewer must not move targets underneath an ongoing Agent action.
Input is checked against the expected tab and displayed viewport inside the
serialized authority queue; stale input is rejected, never replayed. Screenshots
published as artifacts now report their actual viewport dimensions.

Agent click-target and filled-field overlays carry only page ID, geometry, kind
and timestamp—never values or selectors. These are brief post-action cues, not a
fabricated continuous mouse animation. Direct fill highlights the field rather
than pretending the Agent typed or moved a mouse. Google OAuth/challenge behavior
is unchanged by these UI additions.

Added real-browser coverage for new tabs, independent frame capture, resized PNG
dimensions, stale-tab/stale-size rejection, control-epoch fencing, and rejection
of viewer-driven resizing during Agent control. Desktop/mobile rendered checks
cover floating movement, keyboard resizing, docked width reservation, new tabs,
Follow Agent, direct input and preserving the workspace. Physical Safari/touch
and external login outcomes remain unqualified.
