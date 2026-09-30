# UI audit remediation: implementation and evidence

Scope: the approved [one-PR specification](ui-audit-remediation-spec.md), based on `96445032a84d11de8c45cdb9354430dc873fedd5`. This document maps each finding to its implementation and runnable evidence; it does not claim every original incident was reproduced.

## Finding checklist

| Finding | Implementation | Evidence |
| --- | --- | --- |
| F01 Downloads | Shared download preparation/handoff, delayed object-URL cleanup, three-second “Download started”, no success on request failure; transcripts preserve authors and references; encoded Agent-package envelope remains 96 MiB rather than the separate 80 MiB file cap. | `ui-audit-browser.check.mjs`: real downloaded transcript/report bytes and injected 404 at desktop/390px; package/file limit unit regression. |
| F02 Contrast | Theme-aware selected rows and readable +/- diff lines. | UI audit browser: light/dark computed selected-row primary/secondary and added/deleted contrast >=4.5:1. |
| F03 Mobile review | Files/content switching rather than placing the full list above the diff; selection survives refresh. | UI audit browser: first/middle/last of 75 files at 390px, desktop split view, long-line scrolling. |
| F04 File search | Server-side bounded catalog filtering before pagination, scoped working-folder matches, safe path/provenance labels. | `file-search-and-response-review.test.mjs`: older hits, pagination, literal wildcard and Chat isolation. |
| F05 Return routes | Validated origin context in Review, files and Automation navigation; stable deep-link fallbacks. | Routing unit tests, file-preview links browser, UI audit browser Back action. |
| F06 Exact diagnostics | Exact record ID and kind take precedence over related successful reference records. | UI audit browser: failed Request focus/expanded evidence despite an earlier related Wakeup. |
| F07 Empty states | Separate loading, saved/stale, failed and successful-empty search/notification states; disabled-only Automations distinguished from no configurations. | Sidebar failure/loading browser checks plus source/typecheck coverage for Home/Notifications/global Search. |
| F08 Profile validation | Field-local empty-name, handle syntax and reserved-handle errors. | UI audit browser validation at desktop/390px in both themes. |
| F09 Review scope | Canonical response execution context, This response versus Working folder, truthful accumulated-history labels and counts. | Response file-activity unit tests and UI audit browser recorded-review fixture. |
| F10 Shared previews | Live workspace modal reuses safe image/PDF/Markdown/text preview and unsupported-file download fallback. | Real scoped preview-route browser check with rendered image and PDF. |
| F11 Browser names | Current Chat context, duplicate-name Project context, metadata queries limited to open/requested browser Projects. | Browser-panel regression checks rename without identity change and no naming-query fan-out to unopened Projects. |
| F12 Provider attention | Reason and controls link, distinct from pending user decisions. | Shared provider-state presentation/source checks and package tests. |
| F13 Usage explanation | Per-Run telemetry distinguished from account-limit readings. | Provider usage unit tests/source review. |
| F14 Defaults | Source-aware defaults using the existing runtime-compatible precedence. | `ui-audit-wording.test.mjs`: explicit, Chat, saved and provider fallback cases. |
| F15 Rejected access | Access-check rejection takes precedence over a misleading signed-in success state. | Shared provider-state presentation/source checks and package tests. |
| F16 Save feedback | Pending/saved/error near Profile and rollover controls; submitted-snapshot fencing keeps a newer draft unsaved. | Typecheck/package tests and source review; no new live account-setting mutation. |
| F17 Handles | Sidebar uses dynamic `#handle`; mention explanation confined to Profile. | Source/UI checks; composer and message-action spacing unchanged. |
| F18 Activity scope | Searchable contextual grouping backed by two workspace-wide paginated directories, explicit pagination, loading/error/Retry feedback and shared rate-limit cooldown; no per-Project collectors. Agent searches include displayed title, handle with/without `#`, and canonical owning Chat. Chat usage is based on canonical message scope. | Real-route identity/pagination/scope tests; Activity browser with 250 fixture Projects plus real-store/Fastify identity searches at 390/1440px; canonical usage unit test across changed Agent membership. |
| F19 Pending provider reads | Pending is loading, not fabricated `unknown_failure`; actual failures retain diagnostics. | `provider-usage-pending-state.test.mjs` pending-to-actual-failure lifecycle. |
| F20 Automation overview | Human-readable cron and localized timezone/date, one destination and Runs-as location, raw JSON under details. | Package tests/typecheck and source review. |
| F21 Cron validation | Field-local five-field/minimum-frequency and timezone errors without discarding draft. | Existing cron/scheduler tests, typecheck and source review. |
| F22 Stop wording | Exact cancellation teardown outbox distinguishes stopping, confirmed stopped and unconfirmed; acknowledgement retained. | Coordination stop test covers pending/claimed/failed/completed/pruned evidence; scheduler completion/failure notification test; UI wording browser. |
| F23 Empty send | Empty-draft disabled reason requests a message, not a provider change. | Composer wording unit tests and source review. |
| F24 Consistency | Grammar/reasoning labels, pinned-model metadata and plain-text Markdown notification excerpts. | UI wording unit tests. |
| F25 Work destination | Obsolete Activity references replaced by current Work log/Technical details links. | Route/source checks and package tests. |
| F26 Top Level | Empty parent value is visibly Top Level, without changing relationship semantics. | Component/typecheck coverage and source review. |
| F27 Import completion | Successful import is informational “Import complete”, not a blocked decision. | Operational notification tests/source review. |
| F28 Duplicate Agents | Unique #handles and Chat context where names collide, stable IDs unchanged. | Selector/sidebar browser fixture and package tests; source review of Agent grids. |
| F29 Decision response | Recorded type selects You answered/You chose/approval wording; original text preserved. | UI wording and existing decision tests. |
| F30 Git correctness | HEAD→index and index→captured working file, safe rename/unborn/binary/truncation handling. | `workspace-review-patches.test.mjs`: ordinary/linked repositories, changed root, staged+unstaged, deletion, newline and binary cases. |
| F31 PDF embedding | Same-origin exception only on verified scoped PDF preview responses. | Actual Chrome PDF renderer inspected, valid response policy, wrong-Chat 404. |
| F32 Markdown images | Document-relative scoped media URLs; unsafe/missing paths have honest fallbacks. | Preview browser checks natural dimensions, escaped path rejection and absent image; link browser regression. |
| F33 Capability names | Visible label, identifier and description searchable; exact command insertion retained. | UI wording/capability unit tests. |
| F34 Fresh session | Pending/success/error beside Settings action, duplicate-pending guard and Agent-scoped mutation key. | UI audit browser tests the production controller with deferred success/failure, disabled pending action, and cleared feedback after Agent switch; no live provider replacement. |
| A01 Attachment retention | Verified Chat-owned copy before Agent storage cleanup, retryable cleanup receipt, complete-message reconciliation, honest absence and offline repair. | `chat-attachment-retention.test.mjs`: deletion/restart/fault injection, private/draft exclusions, scoped routes and disposable repair. |
| S01 Sidebar messages | Five distinct Chats, safe highlighted excerpts/exact older-message focus, seeded global search, visibility/debounce/cancel/429 gating; no polling. Title-directory pagination and Retry remain visible when message results match; only the misleading empty state is suppressed. | Real-store-backed sidebar browser check at 390/1440px, mixed title/message hits across title pages, initial/pagination errors, cooldown and three tabs; bounded search unit tests. |
| Outage observation | Saved-data notice only with usable cache; navigation remains available; readable Details/Retry. | Existing connection/recovery tests and source review; no original host outage induced. |
| Browser observation | Serial history/reload/resize/close investigation plus existing panel regression. | Disposable real-owned-Chrome test and browser-panel UI check. This does not establish the cause of the original tool-transport incident. |

## Reproducible checks

Run Node 24 and the repository's pinned pnpm:

```sh
pnpm verify
git diff --check
node --test apps/server/test/chat-attachment-retention.test.mjs \
  apps/server/test/workspace-review-patches.test.mjs \
  apps/server/test/provider-usage-pending-state.test.mjs \
  apps/server/test/browser-history-reload-teardown.test.mjs \
  apps/server/test/coordination-outbox-permanent.test.mjs \
  apps/server/test/workspace-directory-agent-owner.test.mjs \
  apps/server/test/workspace-directory-performance.test.mjs
```

Browser scripts use the installed Playwright and Chrome paths supplied through `PONDEROSA_PLAYWRIGHT_PATH` and `PONDEROSA_CHROMIUM_PATH` (no new test dependency):

```sh
node apps/web/test/ui-audit-browser.check.mjs
node apps/web/test/ui-audit-preview-browser.check.mjs
node apps/web/test/sidebar-message-search-browser.check.mjs
node apps/web/test/activity-scope-browser.check.mjs
node apps/web/test/file-preview-links-browser.check.mjs
node apps/web/test/browser-panel.check.mjs
node apps/web/test/request-storm-browser.check.mjs
```

The browser fixtures exercise shared production components and actual scoped preview/store routes where stated; they are not full live managed-provider workloads. The final three-tab sidebar measurement was 4.8 ms server query p95 over eight queries, with two visible-tab requests and no hidden-tab polling (an earlier run measured 17.2 ms). Synthetic request-storm evidence is not a live twelve-managed-Agent test.

## Initial verification results — September 29, 2026, head `d4068d65`

- Full `pnpm verify`: macOS arm64 Node 24.19.0, 863 passed / 7 platform-dependent skips / 0 failed; isolated Pine Linux x64 Node 24.16.0, 864 passed / 6 skips / 0 failed. Typechecks, production builds and bundle budgets passed on both.
- Focused attachment/Git/provider-pending/real-Chrome checks: 13/13 passed on macOS. The provider-operation receipt publication and permanent-outbox tests passed 2/2 and are included in full verification.
- UI audit browser: 390/1440px, both themes; 75-file navigation, selected/diff contrast, long lines, 695-Agent selector, exact failure focus, profile validation, stop wording, fresh-session feedback, actual downloads and failed-download feedback passed.
- Real-route preview browser: nested image pixels, honest unavailable images, rendered Chrome PDF, restrictive scoped policies and wrong-Chat rejection passed at both widths. The PDF was also visually inspected.
- Real-store sidebar browser: five distinct Chats, highlighted snippets, exact older-history focus, archive exclusion, retained title results, seeded full search, failure/cooldown cancellation and three-tab visibility behavior passed.
- Existing Markdown link and browser-panel regressions passed. The synthetic twelve-Agent/three-tab request regression passed: API p95 10.6 ms, event-loop p95 12.1 ms, bounded refresh, live delivery, hidden-tab reconciliation and failed-fetch recovery.
- No paid GitHub Actions were run. Verify and Release recovery workflows remain disabled; native packaging workflows were not invoked or changed.

An initial Linux snapshot test was invalidated by AppleDouble `._*` metadata left by an earlier macOS archive transfer. Those transfer artifacts were removed only from the disposable verification directory; the clean Linux rerun passed. This was not a product-code defect.

## Independent-review follow-up

Both reported code-review gaps at `d4068d65` were valid and are addressed in the follow-up commit:

- Shared collection feedback can suppress only its empty state. Initial failures, refresh failures and pagination failures retain their Retry actions, and title pagination remains reachable alongside message matches. The expanded sidebar browser fixture covers 30 matching Chat titles plus message hits, an initial directory failure, and a failed continuation followed by successful Retry.
- Provider Activity no longer calls per-Project Agent or Chat collectors. It uses one 25-item workspace directory page for each kind, with debounced server search and explicit continuation rather than automatic collection. Its isolated one-page cache cannot inherit or automatically refetch a complete management collection; moving to the next page replaces the previous page. The selected scope retains its exact identity across searches/pages. Loading and failed reads are visible instead of silently omitting scopes.
- A new browser regression uses the real HTTP API client and directory hook with 250 fixture Projects and pre-populated twenty-page management caches: opening Activity makes exactly two initial scope-directory requests, with no per-Project collector requests, inherited management-cache refetches or automatic continuation. At 390/1440px, explicit continuation, initial/refresh/pagination Retry, later-page Agent/Chat search and a real HTTP 429 with shared `Retry-After` cooldown all passed. The directory responses are fixtures, not a live managed-provider workload.
- Follow-up verification: full macOS arm64 Node 24 `pnpm verify` passed (864 passed, 7 platform-dependent skips, zero failures; typechecks, builds and bundle budgets passed). Expanded sidebar search and existing UI audit browser checks passed. The synthetic twelve-Agent/three-tab regression passed (API p95 11.0 ms; event-loop p95 12.1 ms). `git diff --check` passed. The Linux full-suite evidence above belongs to the initial head, not a new Linux rerun of this follow-up.

## Activity identity-search rereview

The new finding at `7e37f63b` was reproduced through the real Fastify route: a later-page Agent's unique handle returned zero results although its display title matched. The shared Agent directory now searches the displayed title, handle (bare or `#`-prefixed), and canonical owning Chat title, while preserving engine/Project/path search and escaped SQL wildcard handling. The owning Chat is joined within the same Project; Agent archival/deletion and Project filters remain unchanged.

The filtered directory's cursor generation now includes Chat changes, so a renamed owning Chat makes old search continuations stale rather than continuing a changed result set. Visible non-summary Agent directories reconcile metadata updates through the existing Project-scoped, rate-limited invalidator; ordinary message and command-output events do not gain Agent-directory refetches.

Evidence for this correction:

- Focused real-route directory tests: 5/5 passed on macOS, including duplicate Agent titles, an Agent beyond the first 25 rows, mixed-case bare/`#` handles, owning Chat search, literal `%`, `_` and backslash characters, Project fencing, archived-Agent exclusion, bounded health work and stale cursors after Chat rename.
- The Activity browser check now has a real AgentStore/Fastify-route phase, not serialized-row mock search: title, unique handle, `#handle` and owning Chat each find the later-page Agent at 390/1440px and select its exact ID. The separate 250-Project fixture still confirms two initial requests, explicit paging, cache isolation and cooldown/error feedback.
- Expanded synthetic twelve-Agent/three-tab check passed: a burst of 50 Chat metadata updates reconciles Activity scopes through at most two bounded refreshes without touching unrelated Project directories or health summaries; ordinary Chat-message traffic adds no scope refetches. API p95 was 24.3 ms and event-loop p95 12.1 ms. This is not a live twelve-managed-provider workload.
- Sidebar search and existing UI audit browser checks passed on macOS. Full isolated Pine/Linux Node 24.16.0 `pnpm verify` passed: 866 passed, 6 platform-dependent skips, zero failures, with typechecks, builds and bundle budgets successful. `git diff --check` passed.
- The attempted full macOS run stalled in the unchanged Playwright Chrome integration test after its headless case passed. Only that disposable test's Chrome process group and stalled test child were terminated; that full Mac attempt is **not** counted as passing. The focused real-route and browser checks above completed independently.

No live repair, merge, deployment, paid Actions run, or dev/production service/data change accompanied this correction.

## Boundaries

- No Branches implementation changes, new dependencies, GitHub Actions runs, merge, deployment or historical dev repair are part of this work.
- No live provider session, saved browser, dev database or production service is mutated by these disposable checks.
- Native Windows, installed-package qualification, physical iPhone/VoiceOver, longer memory-pressure soak and unexplained historical browser incidents remain separately unverified.
- [Historical repair instructions](chat-attachment-repair.md) require separate approval and an offline target. Missing historical evidence cannot be invented.
- Code review approval, dev promotion and production release are separate gates.
