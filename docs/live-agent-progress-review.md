# Review: temporary public Agent progress in Chat

Follow-up to PR #605, based on previous follow-ups at `5ab1bbeedc17692498a52c92ddadeb5418d665bf`.
This follow-up itself requires independent review. Do not merge or deploy.

## Behavior

- Project Chat, Agent Chat and All Messages share one inline renderer.
- Only explicit provider public commentary is eligible. Codex app-server
  completed Agent-message items with phase `commentary` are annotated by the
  adapter; missing/unknown phase, reasoning, tool output and final text stay
  Work-log-only. Adapters without this signal do not guess.
- The exact provider execution and currently acknowledged injection are recorded
  with the fenced event. This identifies when an update was received relative to
  an acknowledged instruction, not proof the Agent understood that instruction.
- Receipt projection checks current Project/Agent authority, live Run lease,
  canonical human cause and latest injection. A pending newer injection suppresses
  old commentary. Coalesced causes show one update under the newest cause.
- The latest update replaces earlier text; SQL limits text to 1,201 code points
  before JS, returning at most 1,200. UI initially shows four lines and offers
  expansion whenever the rendered text overflows, including after resizing.
  The renderer is plain text, never HTML/markdown.
- A scoped canonical reply since acknowledgement or a terminal/expired Run hides
  progress. Existing failure, cancellation and uncertain receipts remain.
- A confirmed steering delivery gets a visible “Instructions delivered to …”
  receipt instead of only a tiny success icon. It proves delivery, not completion.
- No Communication, routing, activation, reply obligation, provider input, future
  context, notification or work settlement is written by these projections.
- New partial telemetry and scoped publication indexes are additive, rebuildable
  read support. Full output remains in the original Work log.
- Workspace envelopes contain IDs only. Public progress query reconciliation is
  coalesced; hidden pages mark queries stale without refetching. No polling,
  provider requests or new roster-wide collectors are added.

## Runnable checks

```sh
pnpm verify
node --test packages/engines/test/public-progress.test.mjs packages/agents/test/public-progress.test.mjs apps/server/test/public-progress.test.mjs apps/server/test/public-progress-routes.test.mjs
PONDEROSA_PLAYWRIGHT_PATH=/absolute/path/to/playwright-core/index.mjs PONDEROSA_CHROMIUM_PATH=/absolute/path/to/chrome node apps/web/test/live-agent-progress-browser.check.mjs
PONDEROSA_TEST_BROWSER=webkit PONDEROSA_PLAYWRIGHT_PATH=/absolute/path/to/playwright-core/index.mjs node apps/web/test/live-agent-progress-browser.check.mjs
PONDEROSA_PLAYWRIGHT_PATH=/absolute/path/to/playwright-core/index.mjs PONDEROSA_CHROMIUM_PATH=/absolute/path/to/chrome node apps/web/test/request-storm-browser.check.mjs
```

The browser fixture renders actual timeline components with controlled read
responses; the server check reads the actual HTTP/store routes. Neither establishes
a live managed-provider steering workload. Store reopening is not a full application
crash/restart. Physical Galaxy, installed Safari and screen-reader qualification
remain separate. No shared sandbox or live data is touched by these checks.

Provider phase contract: [official Codex app-server documentation](https://developers.openai.com/codex/app-server).

## Implementer qualification

- Final Node 24 `pnpm verify`: 933 passed, 7 platform/opt-in skips, zero
  failures; typechecks and production builds passed.
- Focused provider, projection, workspace-envelope and real HTTP/store checks:
  8 passed, zero failures.
- Fresh Chromium and WebKit timeline checks: Project Chat, Agent Chat and All
  Messages at 320, 390 and 1440px; pending/acknowledged delivery, latest replacement,
  mention navigation, inert text, expansion, scoped reply retirement and retained
  failure status passed. Compact All Messages receipts do not gain retry commands.
- The synthetic 12-Agent/three-tab request check passed with coalesced public
  progress refreshes and no added requests from the hidden tab. This is not a live
  managed-Agent workload.
- These are implementer results, not independent review or release approval.

## Wrapped-preview review correction

The independent review at `feeebce92b2e906bef7dd3f5b63b2af861b27dd2`
found a short wrapped update could exceed four lines without an expansion
control. The new browser regression failed against that implementation at
320px. The correction replaces character/newline heuristics with rendered
`scrollHeight`/`clientHeight` measurement and a scoped, cleaned-up
`ResizeObserver`. It does not change provider events, receipt authority,
stored output or refresh behavior.

Fresh Chromium and WebKit checks cover sub-240-character updates in Project
Chat, Agent Chat and All Messages at 320/390px, complete keyboard expansion,
resizing to 1440px while expanded and collapsing, narrow/wide resize detection,
and replacement with short text. The correction requires independent re-review;
no merge, deployment, sandbox refresh or live-data repair is authorized.
