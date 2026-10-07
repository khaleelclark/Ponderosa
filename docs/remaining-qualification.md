# Remaining qualification fixes

This focused follow-up fixes the reproduced Workspace Files PDF preview loop
and replaces host-dependent and obsolete qualification assumptions. It is
stacked on PR #618, not a blanket production-readiness approval. No composer,
attachment authority, canonical work, routing, or live data changes are included.

## Revision and deployment boundaries

- Implementation baseline and PR #618 head:
  `0336878fd3b480d1e9fb8ca42c7483b25e56864e`.
- Baseline tree: `fdced5a6cf87594a325100156b278248bd720137`.
- Original reported build: `682909ae958f6a2e045269739fe0b1bf97d14200`.
- Master and read-only confirmed dev revision at the start:
  `5da30ba3d89eb650aed1c5e524aae38e087f4d9a`, version
  `dev-pr617-5da30ba3d89e`, healthy on port 8789.
- Candidate branch: `fix/remaining-qualification-20261006`. Exact frozen
  candidate SHAs accompany the independent review and PR handoff; a branch name
  or an earlier passing build is not qualification of a later head.

Neither the baseline PR nor this follow-up was merged or deployed by this task.
Existing services, Projects, Agents, browsers and qualification data remain
untouched. Checks use new disposable roots and browser profiles. Existing test
entry fixtures are unchanged; new test-only wrappers record asynchronous
boundaries and work-changing callbacks.

## Confirmed PDF defect and correction

WebKit reproduced the feedback loop in the actual Workspace Files modal using
a valid portrait PDF and a classic scrollbar. Over two seconds the preview
repeatedly alternated between widths 834 and 817 pixels, hiding and briefly
showing the canvas. Chromium on macOS used overlay scrollbars and was a passing
control, not an independent reproduction of that loop. The source removed the
canvas from layout and zeroed its dimensions on each render replacement, and
each replacement renewed its thirty-second timeout.

The canvas now retains its footprint while rendering; a hidden canvas and an
overlaid loading indicator do not repeatedly change scrollable height. Pending
resize replacements share an absolute deadline. Initial document loading and
painting share one thirty-second budget. A deliberate page change, explicit
retry, or resize after a completed paint can begin a new bounded attempt.
Terminal errors do not restart automatically on resize.

Page selection remains available during rendering. Cancelled operations cannot
publish late page text or pixels, and retry, Close and Escape remain available
through failure/loading. At a first/last page boundary, focus moves to the stable
page-controls group before the clicked navigation button becomes disabled.
This prevents the observed WebKit focus drop to body from bypassing the modal's
Escape handler. Render tasks, document tasks, text readers, resize observers and
timers retain explicit cancellation/cleanup paths.

The 80 MiB read bound, four-million-pixel canvas/image bounds, inert scoped
fetches, redirect rejection, decoding options, 2,048 text-item and 64,000
character limits are unchanged. This is not qualification of every PDF codec or
all possible documents.

## Resource admission diagnosis

The HTTP fixture assumed that lowering memory reserve guaranteed provider
startup within its existing five-second wait. Production admission also gates on
memory and I/O pressure and requires two healthy samples at two-second intervals
to recover. The relevant fixture/monitor/scheduler source was unchanged from the
reported build to this PR's baseline.

On Linux at the baseline, twenty original isolated runs, one instrumented run
and six related-suite runs passed: 171 observed test passes, no failures or
skips. Those passing reruns did not close the original intermittency. Controlled
observations then reproduced three expected fixture timeouts, including a
related-suite run: with I/O pressure until 2.2 seconds, the four-second healthy
sample was only recovery sample one. At the five-second wait deadline the exact
activation was pending, delivery failures were zero, and no Run, lease,
preparation or provider startup had occurred. A 1.8-second release recovered
after the two permitted samples and started exactly once. The controlled checks
are separate from the 171 observed passes: 51 passes and three expected failures.

This confirms a fixture defect, not a production-admission defect. The cause of
the original uninstrumented whole-suite timeout remains unproven; neither nearby
pressure nor a later passing rerun establishes that historical cause. The
related-suite workload was not a reconstruction of the original full-suite
ordering/environment.

The repaired fixture passes explicit sample, clock and platform inputs through
the existing monitor constructor. The seam is programmatic-only, with no HTTP
or environment exposure. The production reader remains the default; thresholds,
capacity, timeouts, recovery hysteresis and change notifications remain
server-owned. It deterministically demonstrates that low reserve cannot bypass
an I/O hold, then requires two healthy observations before the same exact
activation produces one completed Run at fence 1. The fifteen-second test limit
and original 100-by-50-millisecond transition wait are unchanged.

A bounded chronological record includes raw observations and thresholds,
admission reasons, readiness/authentication, preparation/start/failure counters,
exact activation/Run/injection identities, leases/fences, provider operations,
cleanup blockers and shutdown. It excludes full prompts. Real Linux counter
coverage remains separate from controlled admission and synthetic-provider
checks; no real host pressure was generated.

## Browser check corrections

The old receipt check passed on this macOS Chromium baseline; no new receipt UI
defect is claimed. Its single-row requirement was nonetheless inconsistent with
the supported wrapping fallback. The check now permits narrow wrapping while
requiring containment, readable unclipped labels, nonoverlap, named reachable
controls and adequate targets. It retains hover/focus, keyboard order, clipboard,
exact Agent navigation, truthful stop details, touch tooltips and retry-warning
checks, and verifies one exact scoped Dismiss operation with no retry.

The old stream check failed in both Chromium and WebKit at 390 pixels while
waiting for desktop-only inline text. The updated check exercises the mobile
accessible status button and keyboard-operated textual popover, with desktop
inline status still checked separately. Oversized replay/live snapshot handling,
no extra reconnect, exact resume cursor 149, grace period, stale/recovery state,
Stop reachability and overflow containment remain asserted. Opening/closing
status details cannot invoke Stop; the independent Stop control still does.

## Fresh candidate evidence

Writer verification is recorded separately from the frozen-head independent
review. macOS arm64 used Node 24.21.0 and pnpm 11.10.0 with a fresh
`pnpm install --frozen-lockfile --offline`.

| Check | Fresh writer result | Evidence |
| --- | --- | --- |
| `pnpm verify` | 1,158 passed, nine skipped, zero failures; all typechecks and production builds passed | `/tmp/ponderosa-remaining-verify-macos.log` |
| Eight focused server files | 28 passed, no skips | `/tmp/ponderosa-remaining-focused-server-final.log` |
| PDF read and extraction regressions | Four passed, no skips | `/tmp/ponderosa-remaining-pdf-read-focused.log` |
| Actual PDF modal and same-byte standalone | Chromium 153.0.8010.53 and macOS WebKit 26.6 passed at 390, 768 and 1440 pixels; height 640, repeated widths 390/430/768/844/1440 | `/tmp/ponderosa-remaining-final-pdf-modal-browser-{chromium,webkit}.log` |
| Receipt layout and interactions | Both engines passed at 320/390/430/600/976/1440 pixels | `/tmp/ponderosa-remaining-final-message-receipt-layout-{chromium,webkit}.log` |
| Stream recovery and status | Both engines passed at 390/1440 pixels, height 900 | `/tmp/ponderosa-remaining-final-agent-stream-recovery-{chromium,webkit}.log` |
| Diff hygiene | `git diff --check` passed | Recorded again at the frozen review head |

Focused server command: `node --test --test-concurrency=1` with
`resource-admission-http`, `resource-admission`, `queued-admission-health`,
`disabled-creation-admission`, `prelaunch-disabled-admission`,
`steering-admission`, `auth-uncertainty` and `oversized-stream-recovery` under
`apps/server/test`, each with the `.test.mjs` suffix. The PDF unit command compiles
`readPdfPreview.ts` and `backgroundCooldown.ts` into a disposable output root,
copies the existing `pdf-preview-read.test.mjs` unchanged, then uses
`node --test` against that compiled root, as the repository's web test runner
requires. A direct uncompiled invocation failed module resolution; that is
retained in the initial focused log and is not a passing qualification run.

Browser commands run the three `.check.mjs` files named in the table using
`PONDEROSA_PLAYWRIGHT_PATH=$PWD/apps/server/node_modules/playwright-core/index.mjs`
and `PONDEROSA_TEST_BROWSER=chromium` or `webkit`. Chromium explicitly uses the
installed Google Chrome executable in a new disposable profile, not the user's
existing browser. `PONDEROSA_RECEIPT_SCREENSHOTS=1` and
`PONDEROSA_QUALIFICATION_SCREENSHOTS=1` retain visual evidence. Representative
390/1440-pixel PDF paint/error screenshots and 320-pixel receipt geometry were
visually inspected.

The nine full-suite skips are three engine platform/unit-scope checks, two
native store-boundary checks, three manual/owned-Chrome/scope server checks and
one extension local-window connector check. Their exact names remain in the
verification log; none is a pass. The earlier baseline's full-suite and provider
evidence is not substituted for these fresh candidate results.

The PDF check uses actual scoped Workspace Files HTTP routes and the real modal,
and the same valid bytes in the standalone shared viewer. Parsing and painting
use real PDF.js. New test-only gates delay/reject document, page, render or text
completion; virtual time advances the unchanged deadlines. These controlled
gates do not qualify every real-world timeout, provider or device.

Evidence paths on macOS begin `/tmp/ponderosa-remaining-`; PDF visual evidence
begins `/tmp/remaining-pdf-`. The corrected baseline reproduction is
`/tmp/ponderosa-remaining-pdf-before-webkit-confirmed.log`. Initial missing
Chromium-cache launch failures, intermediate harness failures and later product
reproductions remain retained; only completed final checks count as passes.

Linux baseline ordered observations and controls are retained under
`/tmp/ponderosa-resource-admission-diag-0336878f` on Pine. The isolated macOS
HTTP/scheduler controlled reproduction is
`/tmp/remaining-qualification-resource-audit-pass.log`. These are baseline
diagnostic evidence, not fresh candidate qualification.

## Remaining qualification gates

- The historical uninstrumented admission timeout's precise causal chain is
  unresolved, despite the confirmed and repaired fixture assumption.
- Chromium and macOS WebKit viewport/touch emulation are not physical Galaxy,
  iPhone or installed Safari qualification. Tablet/orientation checks change
  viewport dimensions, not a physical device's orientation or software keyboard.
- Accessible names, focus and keyboard assertions are not VoiceOver/TalkBack
  qualification. WebKit clipboard checks use a clipboard API stub; Chromium
  separately exercises the real browser clipboard.
- Orderly app/store reopening in disposable tests is not installed-service
  restart, crash/power-loss recovery or live multi-Agent reliability.
- Claude subscription-backed live qualification remains pending; the earlier
  organization-disabled observation is historical, not a new provider probe.
  This task does not qualify live Codex/Claude workloads or performance.
- Capability-search completeness/scale and the broader migration/import,
  legacy ownership and production-data upgrade matrix are not completed here.
  Project-domain removal remains a separate preparation-only effort.
- Windows/native installed-artifact lifecycle, rollback and filesystem boundaries,
  physical-device voice behavior, maximum-size concurrent-import memory,
  production-scale startup/shutdown, dirty-state PWA upgrade, and operational
  metrics/alert routing retain their separate release gates. See
  [production release gates](review-evidence/production-release-gates.md),
  [Beta 11 readiness](beta11-readiness.md) and
  [cross engine qualification](cross-engine-rollover-qualification.md).
- GitHub Actions are not authorized for this task. The candidate uses
  [documented head commit skip metadata](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs);
  required CI checks and mergeability are not claimed
  green. A merge still requires exact-head independent approval and the
  repository's required check/merge fence.

Code merge and controlled Linux dev promotion require the frozen-head independent
review and final passing evidence. Production readiness remains unapproved;
completion of this focused task does not clear the gates above or authorize any
deployment.
