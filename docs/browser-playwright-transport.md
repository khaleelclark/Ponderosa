# Hosted Playwright mechanics: transport decision

Experimental only, September 16, 2026. Playwright Core is pinned to 1.63.0.

## Decision

Use Playwright for hosted navigation, locator click/fill (including its readiness
checks), keyboard/pointer input, scrolling and history navigation. Live screenshots
use the existing CDP capture path, avoiding stability waits on background/loading
pages while preserving page-targeted capture.
Keep the existing process-group authority, profile leases, sandboxed Chrome
launch, Xvfb ownership, selected-tab identity, bounded/redacted observation and
authorized managed-file upload validation. This changes interaction mechanics,
not the user's browser identity or OAuth trust status.

Playwright's public `connectOverCDP` accepts a WebSocket endpoint, not the existing
owned CDP pipe. A one-client loopback bridge adapts that pipe: random private path,
no Origin-bearing requests, binds only 127.0.0.1, stops listening immediately
after the connection, never exposes or persists its endpoint. It closes on pipe
failure, session close or setup failure. No browser debugging TCP port is opened
by Chrome. Product clients still use REST/SSE; there is no client-facing socket or
unauthorized browser-control endpoint. Target attachment events are deduplicated
for Playwright because the separate lifecycle observer also attaches to targets.

This is the demonstrated need for an internal WebSocket transport; replacing
process ownership with Playwright launch internals would weaken the existing
synchronous spawn publication and exact teardown contract. The bridge uses the
already-present ws dependency, not private Playwright APIs.

Playwright's documented CDP connection is lower-fidelity than its own launch
protocol. Qualification therefore tests the actual adapter, not standalone
Playwright. Chrome BFCache is disabled as in Playwright's standard launch so
back/forward lifecycle waits complete. No stealth plugins, fingerprint spoofing,
sandbox disabling or CAPTCHA handling are added.

The hosted viewer also disables background/occluded renderer throttles (as normal
Playwright launches do). Frame capture presents its page's surface without
changing the separately maintained Agent action target. This is necessary for
Chrome tabs that have not painted before becoming background tabs.

## Boundaries

- The browser process remains hosted on Pine with its existing profile, network
  and permissions. This does not create a local connector or synchronize cookies.
- Local Chrome/Edge access remains a separate future paired/tab-scoped connector.
- Semantic observation and managed-file transfer still use existing bounded CDP
  code; this is not a claim that every browser operation was rewritten.
- Google OAuth and iCIMS challenges require actual user qualification. Successful
  fixture tests do not prove either site's acceptance.

## Verification

`browser-navigation-input.test.mjs` runs against both old and Playwright mechanics.
`playwright-browser.test.mjs` runs headed and headless delayed-input, shadow-field,
popup/tab selection, managed-file chooser/upload, screenshot and observed process
teardown checks. Existing authority/profile/cleanup tests remain in the full suite.
