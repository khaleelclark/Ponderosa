# Search accessibility qualification

Search remembers the actual invoking element. After its exit transition, Core and Branches share the same connected, visible, non-hidden trigger restoration; an unavailable trigger falls back to visible workspace navigation (or Branches search). Search result routing remains independent of cancellation. SearchSnippet retains highlighted segments and chooses foreground contrast against the active theme's warning-light background.

Build development assets, then run this bounded real-API/browser regression:

```sh
PONDEROSA_SEARCH_EVIDENCE=/tmp/search-evidence \
PONDEROSA_AXE_SCRIPT=/absolute/path/to/installed/axe.min.js \
node tests/workspace-navigation/search-accessibility.mjs
```

Requires installed Chrome, Xvfb, xdotool, workspace build dependencies and axe-core; installs nothing. Optional `PONDEROSA_XWD_CAPTURE` names the existing Xvfb-frame capture script for native screenshots. The default evidence directory is unique under the system temporary directory. Fixture data is disposable, loopback only, and uses controlled providers. This entry point needs built server/packages and web assets. It does not run automatically as a unit test.

The regression checks Core/Branches × light/dark: keyboard Tab/Enter toolbar invocation and exact Escape restoration at native 100%; actual native browser 200% zoom with measured physical text doubling; canonical populated query, scoped axe scan, every rendered highlight contrast ≥4.5:1, ArrowDown/Enter navigation to a different owned Chat and exact message; keyboard-only editor invocation and exact Escape restoration. Errors and complete action outcomes are retained, and any failed cell makes the process fail. No test calls focus to manufacture restoration.

## Governing acceptance standard

The pinned October 29 Bible-2 attachment (`ee894c01`, SHA256 `ac314d93732e631bb042b8d3d2dc802ba08446812f99ba931023d2e02b14ab58`) supersedes the earlier workspace text. Physical mobile hardware is not an acceptance blocker: emulator/simulator evidence qualifies for phone/iOS/mobile checks. Existing historical evidence remains unchanged and must be interpreted under this correction. This desktop search regression does not supply missing mobile/IME/screen-reader/comparator evidence or close whole #27/EVERY-input acceptance.

#21 is a separate, unexecuted qualification: Core/Branches × desktop/emulated phone; at least eight fresh sessions per product/device; one shared Chat with 10,000 messages and 20 actively working controlled/fake-provider Agents throughout; in-page Event Timing rather than automation durations. Predeclare n, interaction script, exclusions and nearest-rank p75 across **all interactions per surface** (sorted rank ceil(.75*N)); retain every session/result and all raw interaction observations. Group raw EventTiming records by interaction ID before selecting each interaction duration, record observer limitations and incomplete observations explicitly. Mobile uses Lighthouse standard mobile profile with 4× CPU slowdown and a pinned mid-range phone viewport. Compare p75 ≤200ms and LCP ≤2.5s, retaining per-session LCP and stated aggregation. Idle rosters never substitute for active work. This batch runs no Phase1/performance measurement.

Other corrected standard boundaries: #22 starts after installer download and provider sign-in; exceptions require Patrick's approval plus recorded scope/reason/test; justified resource admission is not access revocation; known secrets remain redacted; #32 uses the pinned finite LangGraph/LangChain capability set. Truly human-only checks go on Patrick's final checklist and do not block agent progress. Missing matched comparator versions/tasks and independent blind judge provenance remain evidence gaps, not invented passes.
