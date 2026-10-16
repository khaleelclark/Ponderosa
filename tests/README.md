# Maintained regression tests

All 43 maintained automated implementations live once under root `tests/`, grouped by user feature: chats, agents, organizations, files-results, workspace-navigation, browser, context-recovery, providers and installation-release. Cross-feature cases have one primary home. The 110-check approved manifest records intended behavior and manual limits; `shared/inventory.json` records runners and requirements. Integration #701 preserved all 149 cases from #676, the three Decision cases from #700, and the seven artifact-storage cases from #699. Two approved Decision-response guards bring the integration total to 161: an answered question cannot be skipped or resumed again, and Skip with supplied empty answer fields cannot change a pending question or activate its Agent. All 36 files from #676 and the existing assertions remain unchanged; the new guards use the existing native controlled fixture without adding platform gates.

The Windows Job liveness regression adds six deterministic authority cases and one native Windows root/descendant case. Closing a verified empty assigned Job must remain terminal while Node exit callbacks are pending; active/unassigned Jobs, assignment failures and accounting failures must not claim unobserved exit. The native case requires Windows Job Objects; none of these cases uses a provider account.

The Windows retained-root startup regression covers root listings/iterators across independent cursors, nested and transferred directory handles, no-follow/read-only/closed authority, pathname replacement, and existing current-state launcher admission and the production engine IPC/child-transfer/quit/reopen path using disposable data. It adds three Windows-only cases without changing existing gates or assertions.

The schema line-ending regression uses synthetic real SQLite declarations to admit equivalent LF/CRLF current state without rewriting its stored declarations or generation. Quoted string/identifier line breaks, trigger/index expression literals, bare CR and other whitespace remain exact; meaningful index changes still refuse. No normal-profile data becomes a fixture.

## Current integration and human disposition

Integration #701 starts from master `77b84212644565500f5e979a364f59817ccfd510` and includes #676 at `fac0373980c7ae834a89fdf18d8d2d88b2dba82b` and #699 at `c6ebbf64ebc06194332c54bb73a410c2a2b6b464`. The exact #693 head `43372a05f211917051f877bce2ed12cea373e03b` is already an ancestor of #676, so its migration is included without duplicate replay. The sole textual conflict was the inventory; its resolution retains all current entries and adds the original storage-test entry. The identical cleanup-health repair appears once.

On October 13, 2026, the human accepted the Windows actual attachment and captured-text reading findings as provisional passes, with actual verification deferred until the final build. This is an acceptance decision, not a measured test pass. Earlier failed and unverified receipts below retain their original revision and meaning. Remaining qualification gaps were declared nonblocking by the human; no new release gates are introduced. Claude stays deferred. Local browser connection/extension is post-beta, while the internal browser remains in beta scope. Wiki and Automations are excluded.

Integration #701 preserved the then-stale native-beta speech/GUI references. Their later explicit retirement and the remaining GUI PID unit-coverage gap are documented in `../packaging/README.md`; no maintained regression case is removed by that reconciliation. Applicable default test lanes, discovery and native bundle verification retain their actual results in the integration PR and task handoff; provider/browser/PWA opt-ins are not enabled for this integration check.

## Commands

Use native Node 24 and repository-pinned pnpm 11.10.0. Build native dependencies for the host.

```sh
pnpm install --frozen-lockfile
pnpm verify                      # Build, typechecks, all maintained lanes once
pnpm test                        # Same as verify
pnpm test:list                   # List all implementations
pnpm test:list chats             # List one feature
pnpm build
pnpm test:feature chats           # Execute one feature; substitute any group
pnpm test:tooling                 # Compatibility tooling lane
pnpm test:regressions             # Focused merged MCP/prompt-fence repair cases
node tests/shared/run-tests.mjs --lane server
node tests/shared/run-tests.mjs --lane web
```

Server files retain serial execution; web/tooling retain their existing isolated Node processes. Root discovery rejects missing, extra or duplicate inventory entries. Feature commands use the same inventory. Existing package `test:built` commands remain compatibility entrypoints. Root verification does not execute those entrypoints a second time. If a server failure stops root verification, separate existing web/tooling lane commands may complete evidence; they do not turn the failed root command into a pass.

The URL-fragment regression runs server alias resolution and the real Markdown/React renderer in the web lane. Its optional native-browser case exercises actual rendered links, the Open link dialog, whole-message/code copy, and the clipboard fallback with external navigation intercepted locally. It builds only a disposable component fixture and uses a fresh browser profile; no provider account or installed Ponderosa data is used.

```sh
PONDEROSA_REGRESSION_MENTION_BROWSER=1 node --experimental-transform-types --import ./tests/shared/resolve-typescript.mjs --import ./tests/shared/workspace-resolution.mjs --test tests/chats/mentionPresentation.test.mjs
```

The browser case defaults to installed macOS Chrome; set `PONDEROSA_BROWSER_EXECUTABLE` to an existing native Chromium executable on another host. Other platforms have not been qualified by this Mac run.

## Fixtures and isolation

Feature-specific data stays beside its tests; reusable helpers and loaders are in `shared/`. The controlled fixture uses fresh data/working roots, tracked managed-Agent creation and real inert child processes. POSIX roots retain detached process groups. Windows roots belong to exact kill-on-close Jobs before publication, expose no POSIX process identity, and close only after observed child exit and zero active Job processes. The optional close-refusal hook defaults off; pending opens and unrelated roots remain protected. Successful roots are removed only after shutdown; failed roots are retained.

Attachment fixtures discover paths only from actual submitted input/history, decoding JSON and preserving Windows drive letters, backslashes and spaces. Their exact-byte, recipient privacy, blind-input and canonical-reply assertions remain unchanged. The Git fixture sets `core.autocrlf=false` only in its fresh owned repository so setup and the app's Git process share a byte policy; user/system Git settings remain unchanged.

The controlled diagnostic engine labeled Claude is inert and uses no provider account. Actual provider opt-ins use Codex only. Neither synthetic fixtures nor successful automated slices establish all-platform installation/UI acceptance. The maintained manual UI fixture and its explicit controls remain in workspace-navigation; they do not become default automated tests.

## Opt-in lanes

After build, use an existing permitted subscription-backed Codex CLI/SDK. These tests do not log in or install providers.

```sh
PONDEROSA_REGRESSION_REAL_CODEX=1 node --import ./tests/shared/workspace-resolution.mjs --test --test-concurrency=1 tests/agents/real-codex.test.mjs tests/agents/real-joins.test.mjs tests/files-results/real-artifact.test.mjs
PONDEROSA_REGRESSION_NATIVE_BROWSER=1 PONDEROSA_BROWSER_MULTI_PAGE=1 PONDEROSA_BROWSER_FILE_UPLOAD=1 node --import ./tests/shared/workspace-resolution.mjs --test tests/browser/native-browser.test.mjs
PONDEROSA_REGRESSION_INSTALLED_PWA=1 PONDEROSA_REGRESSION_BUNDLE=/absolute/owned/Ponderosa node --test tests/installation-release/installed-pwa.test.mjs
```

`PONDEROSA_CODEX_BIN` may select an existing compatible native CLI. Native Chrome uses a fresh profile and owned local HTTP fixture. The PWA lane requires a clean exact-source native bundle; its fresh instance disables both providers before browser use. Never select a personal database, output directory, credential/profile directory or browser profile. The three opt-in gates account for 14 actual Codex cases, one Chrome case and one PWA case. Default skips mean those lanes were not requested by that command; separately executed lanes retain their own results.

Windows actual provider/browser/PWA opt-in gates remain separate. The Unix broker/client test retains its existing Windows gate because that transport is Unix-specific; Windows browsers use CDP pipes. Sixty original controlled provider cases and two merged controlled prompt-fence route cases now execute on native Windows rather than skip.

## Evidence and remaining checks

`MIGRATION.md` retains the original before/after map and historical byte-identical relocation evidence. Later native-fixture plumbing preserves original assertions, identities and timeouts while intentionally removing the qualified controlled-fixture Windows gates. The original check25 assertion remains; its TODO is removed by the merged product parser repair. No unmerged suites, private historical fixtures or removed tests are imported.

Exact revisions, commands, per-host results, retained failures and observed cleanup are recorded in the task handoff and `APPROVED_REGRESSIONS.md`. Manual checks still include native GUI/installation journeys, accessibility/audio, local browser connection/extension pairing and other limits in the approved feature manifest. Wiki and Automations remain excluded. Claude remains deferred by the human. Missing native-beta CI voice/extension references remain reported; no replacement gate or new release requirement is invented.

At authorized cleanup-health fix `de3f406d7459d826922df1218a21ff4691362573`, full default `pnpm verify` passes on Linux/macOS (133 pass,16 opt-in skips) and Windows (132 pass,17 skips:16 opt-ins plus the Unix transport case), with zero failures/TODOs. All36 test bodies remain byte-identical to the prior combined head. The actual Codex/browser/PWA opt-ins passed with all149 cases enabled on Linux/macOS at `fef3d74e97a8169bd0a829c5abbcefcf3140a9a8`; Claude remains deferred. See APPROVED_REGRESSIONS.md and task HANDOFF.json for exact revisions and preserved initial failures.

## Further Windows opt-in qualification

Continuation `84f5870bf4a468c5c7633872d841b50c1157a400` removes the old Windows-only qualification guards from the existing actual Codex and headless Chrome fixtures and the portable controlled manual UI fixture. Explicit opt-in gates, assertions, timeouts, isolation and serialization stay intact. On Windows, the production native Job authority supplies the same observed-owned-shutdown assertion; no POSIX identity is fabricated. Actual worker questions, all three Decision responses, private collaboration, rollover, managed creation, fan-out outcomes, any/quorum and each-result integration pass (12 actual Codex cases). The blind attachment read fails after an explicit human-approved retry because its command is rejected before execution with “blocked by policy”; the dependent captured-artifact read remains not run. Do not classify either as a passing/intentional platform skip or change permissions to hide the rejection. The error names no specific rule. Headless Chrome’s navigation/upload/capture/exact-shutdown case passes. Native desktop manual-view/resume remains a separate check.

Continuation `12e4673e00a0d0da6be9b1ca851ae3507b182a45` adds `shared/windows-pwa-browser.mjs`, using existing native Job containment and CDP protocol for the maintained installed-PWA assertions. The shipped qualification helper accepts an optional browser factory; existing launcher/macOS qualification entrypoints retain their default factory and behavior. Windows test code is not a shipping application dependency. The current PWA/default/native-bundle/lifecycle evidence is recorded separately in task `private-windows-optins-20261013/QUALIFICATION.json` and `HANDOFF.json`; exact per-lane source and bundle revisions matter. Mac/Linux `pnpm verify` passes149 cases (133 pass,16 opt-in skips), and their changed default PWA helper passes against the previously qualified fef3 native bundles. Windows `pnpm verify` at12e passes149 cases (132 pass,17 skips). Default skips are14 Codex,1 Chrome,1 PWA and, on Windows,1 Unix-only transport case; separately executed opt-ins retain their actual pass/failure/blocker results. Claude stays deferred.

The two active coverage-manifest `manual_fixture` references now use `tests/workspace-navigation/ui-qualification.mjs`. All110 approved intended behaviors/approvals and every automated assertion stay unchanged; historical old paths in the migration map remain historical.

Windows current12e native bundle verification passes10 checks and its Codex-only installed launcher lifecycle passes20. Initial12e PWA restart assertion failed after the new Windows adapter immediately terminated its Job; the retained failure remains. Corrected test-only helper17b9484ce waits up to5 seconds for natural Chrome/Job exit before escalation, matching existing POSIX cleanup, and the unchanged PWA test passes using the exact12e bundle in a new disposable profile. Test source17b differs12e only in that unshipped helper; all application/qualification payload source bytes stay identical. This is a scoped test fixture correction and restart qualification, not a product cache/authentication repair or current-installer/complete beta sign-off.


## Managed-browser Windows UI continuation

Fresh managed in-app browser creation works in the authorized Windows chat. The earlier absent-tab access conclusion is superseded; its original receipt remains historical. Maintained fixture `tests/workspace-navigation/ui-qualification.mjs` at `17b9484ce9935b7cfcf6908e0eacbb1f699d1249` uses Windows native Job-controlled test doubles and application/web source equivalent to `12e4673e00a0d0da6be9b1ca851ae3507b182a45`. Renderer OS is not independently established; this is not native desktop GUI acceptance or an actual provider test.

Scoped Stop/partial child refusal/same-child Retry/unrelated survivor and lazy-route warning/Try Again/Unicode draft preservation pass. Available working/captured Unicode previews, name/Agent attribution filters and exact synthetic receipt/patch download bytes pass within their partial scope. Home retains cached activity and its draft, renders refresh warnings and Retry controls, and recovers automatically. Explicit Home Retry-button recovery remains unverified because automatic recovery preceded the attempted click.

Known seeded Agent `UI roster 120` exists, but its roster search returns HTTP 400 and the UI incorrectly renders “No Agents Yet.” Review preparation records `file_change` sequence 12 with `event_projection_failed`; changedFiles is empty and no test_report is created. The underlying projection cause is unproved. Captured-content immutability after working-file drift, the recorded diff renderer, report-type filtering and authored Team/main transcript comparison remain unverified. Available captures do not prove those journeys. No substitute seeding, assertion weakening, product change or temporary runtime probe is used. Actual Claude stays deferred; the diagnostic engine bearing its name is inert.

The task's `private-windows-optins-20261013/QUALIFICATION.json` and `HANDOFF.json` distinguish this manual continuation from the 149 automated identities and preserve historical receipts. These partial UI outcomes do not change suite totals or declare full beta acceptance.


## Beta scope correction: local browser deferred

The human clarified that local browser connection and its extension are deferred until after beta. At `a4d16a9d518c465a16f3337772ca075dc44d8abd`, new pairing is deliberately refused with HTTP409 `browser_profile_isolation_required` in `apps/server/src/routes/local-browsers.ts`; the beta UI has no reachable local setup entrypoint. The earlier disabled menu placeholder/help suggestion was removed by merged `b29d8a44df194908ada0163346f638eb9252541d`. Dormant setup/transport/extension implementation and maintained tests remain. Their pending live qualification is post-beta work, not a current beta blocker. The internal browser stays in beta scope. This corrects the outdated remaining-work classification without changing the accepted110 test behaviors or removing assertions. Roster search is a known nonblocking beta bug; failed check43 stays tracked.
