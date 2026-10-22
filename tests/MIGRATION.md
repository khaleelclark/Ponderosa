# Regression test consolidation

This reconciles the authorized suite in [PR #676](https://github.com/khaleelclark/Ponderosa/pull/676) with the six-file migration in [PR #693](https://github.com/khaleelclark/Ponderosa/pull/693). It does not import unrelated unmerged, removed or historical suites. No product behavior or test assertion changes are included.

## Revisions and preservation

- Final upstream refresh: `65f8dd704cbf5b72930d01d41a2cfc960cba78f5` adds the already merged #694 filename test and #689 notice packaging changes. Normal synchronization head: `22e99b4165357fc0fd79715880c47f605a5fcbf6`. That new test is separately checked at its original path on both hosts before relocation; all original 28-case-file preservation baselines remain retained.
- Original approved regression head: `8d0deeb01edbeaaff90a20a32f5b444270d7431d`.
- Refreshed upstream master: `a6812ea6814e2526e3afd833b69931b0012e3211` (includes #690). Its product/test tree matches the accepted #693 base `15d0e6ff62ce92c61b86cc594787e719733faa69`.
- Combined before-migration baseline: `d12fcb42d5e92ac4b01668293669ab7bf4650f9c`.
- Authorized #693 head integrated: `43372a05f211917051f877bce2ed12cea373e03b`.
- Initial 28-file relocation verification revision: `3b8e4ca5`. The final 29-file verification head and logs are recorded in the external task handoff and PR description.

All 29 test bodies from the first Node test call through EOF are byte-identical before/after. Every assertion-bearing source line is unchanged, including assertions in preludes. Each inventory entry records before/after file hashes and the unchanged body hash. Options, skips, TODOs, fixture cleanup and platform/provider gates are preserved. Changes outside test bodies are relocation imports/paths, scoped loader extraction from #693, workspace module resolution and commands. The 110-check manifest is identical after reversing path translations: no statuses, intended behavior or coverage limits changed.

## Every maintained automated test

| Before | After | Feature | Lane / requirements |
| --- | --- | --- | --- |
| `apps/server/test/delegation.test.mjs` | `tests/agents/delegation.test.mjs` | agents | Node test runner, server; Node 24, built server workspaces; disposable POSIX provider fixture (Windows gate unchanged) |
| `apps/server/test/real-codex.test.mjs` | `tests/agents/real-codex.test.mjs` | agents | Node test runner, server; Opt-in PONDEROSA_REGRESSION_REAL_CODEX=1; existing permitted Codex CLI/SDK access; disposable POSIX fixture; default skip and Windows gate unchanged |
| `apps/server/test/runtime-boundaries.test.mjs` | `tests/agents/runtime-boundaries.test.mjs` | agents | Node test runner, server; Node 24, built server workspaces; disposable POSIX provider fixture (Windows gate unchanged) |
| `apps/server/test/browser-control.test.mjs` | `tests/browser/browser-control.test.mjs` | browser | Node test runner, server; Built server; owned Unix broker socket; original Windows transport skip unchanged; controlled browser driver |
| `apps/server/test/local-browser-transport.test.mjs` | `tests/browser/local-browser-transport.test.mjs` | browser | Node test runner, server; Built server; controlled local transport; no extension/profile/account |
| `apps/server/test/native-browser.test.mjs` | `tests/browser/native-browser.test.mjs` | browser | Node test runner, server; Opt-in PONDEROSA_REGRESSION_NATIVE_BROWSER=1; existing host Chrome, fresh owned profile; default skip and Windows gate unchanged |
| `apps/web/src/components/chat/attachmentsAndRouting.test.mjs` | `tests/chats/attachmentsAndRouting.test.mjs` | chats | Node test runner, web; Node 24 TypeScript transform and existing web dependencies; no account/browser; Python 3 standard ZIP reader (PYTHON override unchanged) |
| `apps/web/src/components/chat/draftTextRecovery.test.mjs` | `tests/chats/draftTextRecovery.test.mjs` | chats | Node test runner, web; Node 24 TypeScript transform and existing web dependencies; no account/browser |
| `apps/server/test/messaging.test.mjs` | `tests/chats/messaging.test.mjs` | chats | Node test runner, server; Node 24, built server workspaces; disposable POSIX provider fixture (Windows gate unchanged) |
| `apps/web/src/api/uploadRetry.test.mjs` | `tests/chats/uploadRetry.test.mjs` | chats | Node test runner, web; Node 24 TypeScript transform and existing web dependencies; no account/browser |
| `apps/server/test/workflows.test.mjs` | `tests/chats/workflows.test.mjs` | chats | Node test runner, server; Node 24, built server workspaces; disposable POSIX provider fixture (Windows gate unchanged) |
| `apps/server/test/compaction-recovery.test.mjs` | `tests/context-recovery/compaction-recovery.test.mjs` | context-recovery | Node test runner, server; Node 24, built server workspaces; disposable POSIX provider fixture (Windows gate unchanged) |
| `apps/server/test/compaction.test.mjs` | `tests/context-recovery/compaction.test.mjs` | context-recovery | Node test runner, server; Built server/engines; controlled events; no provider process/account |
| `apps/server/test/context-pressure.test.mjs` | `tests/context-recovery/context-pressure.test.mjs` | context-recovery | Node test runner, server; Node 24, built server workspaces; disposable POSIX provider fixture (Windows gate unchanged) |
| `apps/server/test/attachment-filename.test.mjs` | `tests/files-results/attachment-filename.test.mjs` | files-results | Node test runner, server; built Fastify, synthetic uploads; no provider/browser |
| `apps/server/test/artifact-provider-path.test.mjs` | `tests/files-results/artifact-provider-path.test.mjs` | files-results | Node test runner, server; Built server/core/native-host; native filesystem authority; no provider account |
| `apps/web/src/components/filePreview/artifactDiff.test.mjs` | `tests/files-results/artifactDiff.test.mjs` | files-results | Node test runner, web; Node 24 TypeScript transform and existing web dependencies; no account/browser |
| `apps/server/test/files.test.mjs` | `tests/files-results/files.test.mjs` | files-results | Node test runner, server; Node 24, built server workspaces; disposable POSIX provider fixture (Windows gate unchanged) |
| `apps/web/src/components/filePreview/readTextPreview.test.mjs` | `tests/files-results/readTextPreview.test.mjs` | files-results | Node test runner, web; Node 24 native TypeScript stripping; synthetic fetch/streams |
| `packaging/qualification/chat-deletion-restart.test.mjs` | `tests/installation-release/chat-deletion-restart.test.mjs` | installation-release | Node test runner, tooling; Node 24, built server/native SQLite; disposable roots; original platform conditions |
| `packaging/qualification/cli-arguments.test.mjs` | `tests/installation-release/cli-arguments.test.mjs` | installation-release | Node test runner, tooling; Built launcher; malformed CLI inputs/disposable paths; no installer execution |
| `packaging/qualification/retire-doctor.test.mjs` | `tests/installation-release/retire-doctor.test.mjs` | installation-release | Node test runner, tooling; Built launcher/server; disposable install/data fixtures; original platform condition preserved |
| `packaging/qualification/verify-release-action-pins.test.mjs` | `tests/installation-release/verify-release-action-pins.test.mjs` | installation-release | Node test runner, tooling; Synthetic commit resolver; no GH_TOKEN/network |
| `apps/server/test/organization.test.mjs` | `tests/organizations/organization.test.mjs` | organizations | Node test runner, server; Node 24, built server workspaces; disposable POSIX provider fixture (Windows gate unchanged) |
| `apps/server/test/capabilities.test.mjs` | `tests/providers/capabilities.test.mjs` | providers | Node test runner, server; Built engines; pure controlled MCP input; known failing TODO unchanged |
| `apps/server/test/provider-access.test.mjs` | `tests/providers/provider-access.test.mjs` | providers | Node test runner, server; Node 24, built server workspaces; disposable POSIX provider fixture (Windows gate unchanged) |
| `apps/web/test/home-refresh.test.mjs` | `tests/workspace-navigation/home-refresh.test.mjs` | workspace-navigation | Node test runner, web; Existing React/Query/TypeScript dependencies; synthetic query cache/API |
| `apps/web/src/api/resilientEventSource.test.mjs` | `tests/workspace-navigation/resilientEventSource.test.mjs` | workspace-navigation | Node test runner, web; Node 24 TypeScript transform and existing web dependencies; no account/browser |
| `apps/server/test/workspace.test.mjs` | `tests/workspace-navigation/workspace.test.mjs` | workspace-navigation | Node test runner, server; Node 24, built server workspaces; disposable POSIX provider fixture (Windows gate unchanged) |

## Helpers, fixtures and documents

| Before | After | Classification |
| --- | --- | --- |
| `apps/server/test/fixture.mjs` | `tests/shared/fixture.mjs` | shared-fixture-or-loader; original workspace dependencies |
| `apps/server/test/ui-qualification.mjs` | `tests/workspace-navigation/ui-qualification.mjs` | manual-qualification-entrypoint; original workspace dependencies |
| `apps/web/test/resolve-typescript.mjs` | `tests/shared/resolve-typescript.mjs` | shared-fixture-or-loader; original workspace dependencies |
| `apps/server/test/README.md` | `tests/APPROVED_REGRESSIONS.md` | Historical qualification notes retained; commands and links relocated |

`tests/shared/run-tests.mjs`, `workspace-resolution.mjs`, `inventory.json` and `web-typescript-loader.mjs` originate in #693. The last extracts the original Home loader prelude. The central runner also preserves #676’s web transform/preload. CommonJS dependency lookup for context-pressure is explicitly anchored to its original server package. Inventory/discovery mismatches now fail rather than silently assigning a file to an unregistered lane.

No maintained test implementations remain in old source/package test directories. No duplicate test copies are added. Feature-specific manual support stays with its primary feature; reusable fixtures/loaders stay in `shared`.

## Shipping release implementations

These 16 release entrypoints/helpers remain in place, byte-identical to the final synchronized upstream baseline (notice changes came from merged #689, not this migration):

- `packaging/qualification/canonical-path.mjs`
- `packaging/qualification/enforce-release-policy.mjs`
- `packaging/qualification/http-response.mjs`
- `packaging/qualification/launcher-safety.mjs`
- `packaging/qualification/macos-bundle-metadata.mjs`
- `packaging/qualification/macos-deployment-target.mjs`
- `packaging/qualification/macos-provider-evidence.mjs`
- `packaging/qualification/persistent-pwa-upgrade.mjs`
- `packaging/qualification/process-state.mjs`
- `packaging/qualification/provider-reachability.mjs`
- `packaging/qualification/qualify-installer.mjs`
- `packaging/qualification/qualify-launcher-lifecycle.mjs`
- `packaging/qualification/qualify-macos-gui-launch.mjs`
- `packaging/qualification/symlink-portability.mjs`
- `packaging/qualification/verify-installed-bundle.mjs`
- `packaging/qualification/verify-release-action-pins.mjs`

The existing bundle builder copies `packaging/qualification/` verbatim. Previously it also copied the four test-only implementations there; those now live outside the shipping payload. The 16 actual release files and their consumers remain unchanged. This is the specified test relocation, with no replacement packaging implementation or weakened gate. The migration changes no lockfile, application source, packaging implementation or workflow gates relative to final upstream master.

## Pre-existing unresolved references (historical migration baseline)

- `.github/workflows/native-beta.yml:Verify native voice storage recovery` references absent `apps/server/test/gui-qualification-pid.test.mjs`. Gate preserved verbatim; no replacement/import/removal.
- `.github/workflows/native-beta.yml:Verify native voice storage recovery` references absent `apps/server/test/speech-sandbox.test.mjs`. Gate preserved verbatim; no replacement/import/removal.
- `.github/workflows/native-beta.yml:Verify native voice storage recovery` references absent `apps/server/test/speech-cleanup-race.test.mjs`. Gate preserved verbatim; no replacement/import/removal.
- `.github/workflows/native-beta.yml:Verify native voice storage recovery` references absent `apps/server/test/speech-recovery.test.mjs`. Gate preserved verbatim; no replacement/import/removal.
- `.github/workflows/native-beta.yml:Install native speech sandbox dependencies` references absent `.github/scripts/prepare-linux-speech-tests.sh`. Gate preserved verbatim; no replacement/import/removal.
- `apps/browser-extension/README.md:Tests` references absent `pnpm --filter @ponderosa/browser-extension test:built`. Existing documentation refers to an absent package script; no suite imported or command invented.
- `apps/browser-extension/README.md:Tests` references absent `apps/browser-extension/test/extension-load.check.mjs`. Existing documentation preserved; no historical suite imported.

The five native-beta references above are reconciled in the subsequent workflow change documented in `../packaging/README.md`. The bullets retain their original migration-baseline meaning; extension documentation discrepancies remain unresolved.

These were unresolved CI/documentation dependencies, not tests dropped during migration. No replacement tests or launcher requirements were invented, and no missing gate was removed. A green local suite does not certify the affected native-beta workflow.

## Verification

Fresh Mac/Linux baseline, post-migration results, case identity comparison, discovery coverage, and native bundle checks are recorded in the task evidence and final handoff. Opt-in provider/browser/installer lanes are retained but not executed by this organization change; Windows is unavailable here. See the PR description for commands actually run and any result differences.


### Recorded results (verification source `1ccd92413ac37219b68fa262174b79c0435a6f4a`)

| Host | Before (combined baseline replay) | After | Case identity |
| --- | --- | --- | --- |
| Linux x64 | 110 passed, 11 skipped, 1 failing TODO | 110 passed, 11 skipped, 1 failing TODO | Same 122 names and statuses |
| macOS arm64 | 108 passed, 2 failed, 11 skipped, 1 failing TODO | 110 passed, 11 skipped, 1 failing TODO | Same 122 names; two import cases now pass |

The initial full baseline ran at `d12fcb42`; the newly merged filename case was then replayed at its original path after synchronization at `22e99b41`. On Mac the baseline root command failed on the existing 3 GiB import admission guard, so its packaging lane was explicitly run separately. The two refused cases keep identical assertions and subsequently pass; no skip or memory predicate was changed. Both failed roots and logs are retained. Initial relocation attempts exposed CommonJS module resolution; that path-only repair is recorded at `3b8e4ca5`, with failed attempt logs preserved.

Actually executed on both hosts: offline frozen dependency installation where needed; `pnpm test` before migration; `pnpm verify` after migration; `pnpm build` plus `pnpm --filter @ponderosa/server exec node --test test/attachment-filename.test.mjs` before moving the new upstream case; `pnpm test:feature files-results` (10 passes); native `node packaging/build-beta-bundle.mjs` and `node packaging/verify-beta-bundle.mjs`. Mac exercised all nine `pnpm test:feature <group> --list` selections plus root and compatibility lane listings; Linux also exercised all three compatibility listings. Root/feature/lane discovery has the same 29-file union and no duplicates.

Native bundle verification passes on both hosts. Each qualification payload contains exactly the same 16 release implementations as current source, byte for byte, with no maintained test implementations or root `tests/` directory shipped. The first bundle attempts used earlier runtime metadata lacking the license required by merged #689; those refusal logs are retained. Using the already qualified matching Node 24 runtime, LICENSE and SOURCE.json satisfies the existing requirement; no packaging assertion or implementation was changed.

Windows and opt-in real-provider/browser/installer lanes were not executed during this migration. Their gates and historical results remain intact. Native-beta voice CI and extension documentation references listed above remain unresolved. No merge, deployment, account change or publication was performed.


## Subsequent authorized fixture portability and merged upstream repair

The earlier body/hash statements above describe the original relocation baseline. Later human-approved portability at tested head `fef3d74e97a8169bd0a829c5abbcefcf3140a9a8` changes controlled fixture setup, imports/path discovery and Windows guards while retaining original assertions/identities/timeouts. All35 original files and132 case names remain. Already merged upstream `cd9254433f3ca6b46633717e11959e8e5e30228f` supplies extended MCP cases and the new root-level chats/prompt-fences implementation, adding17 cases and one file. All36 implementations remain single copies under tests/, and all149 cases are discovered without duplicate execution. Current requirements are in shared/inventory.json; historical relocation hashes remain preserved.

| New merged source | Canonical home | Feature | Runner/requirements |
| --- | --- | --- | --- |
| master tests/chats/prompt-fences.test.mjs | tests/chats/prompt-fences.test.mjs | chats, with agents/organization coverage | Node server lane; built SQLite/agents/server; native inert POSIX groups or Windows Jobs for2 route cases; no provider account |

Qualification results, retained failures and manual limits are recorded in APPROVED_REGRESSIONS.md and the private-windows-fixtures-20261013 handoff.

### Further Windows opt-in fixtures (2026-10-13)

All36 maintained `.test.mjs` files stay in their existing feature homes with149 identities and identical assertion-bearing lines. No suite is imported or duplicated. New test-only `tests/shared/windows-pwa-browser.mjs` is a native Job/CDP launch adapter for the existing installation-release PWA test. It is registered as a shared helper and is excluded from application payloads. `packaging/qualification/persistent-pwa-upgrade.mjs` stays in packaging because installed-release and macOS qualification consume it: an optional browser factory supports the test adapter while its existing entrypoints keep their default process path. Those consumers were inspected, and unchanged default PWA assertions pass on Linux/macOS. This explicit qualification-helper change is separate from the original relocation; no release entrypoint is moved under tests. Two active manifest `manual_fixture` paths were stale and now reference the canonical root; historical old-path mappings remain intact.


## Managed-browser Windows UI continuation

Fresh managed in-app browser creation works in the authorized Windows chat. The earlier absent-tab access conclusion is superseded; its original receipt remains historical. Maintained fixture `tests/workspace-navigation/ui-qualification.mjs` at `17b9484ce9935b7cfcf6908e0eacbb1f699d1249` uses Windows native Job-controlled test doubles and application/web source equivalent to `12e4673e00a0d0da6be9b1ca851ae3507b182a45`. Renderer OS is not independently established; this is not native desktop GUI acceptance or an actual provider test.

Scoped Stop/partial child refusal/same-child Retry/unrelated survivor and lazy-route warning/Try Again/Unicode draft preservation pass. Available working/captured Unicode previews, name/Agent attribution filters and exact synthetic receipt/patch download bytes pass within their partial scope. Home retains cached activity and its draft, renders refresh warnings and Retry controls, and recovers automatically. Explicit Home Retry-button recovery remains unverified because automatic recovery preceded the attempted click.

Known seeded Agent `UI roster 120` exists, but its roster search returns HTTP 400 and the UI incorrectly renders “No Agents Yet.” Review preparation records `file_change` sequence 12 with `event_projection_failed`; changedFiles is empty and no test_report is created. The underlying projection cause is unproved. Captured-content immutability after working-file drift, the recorded diff renderer, report-type filtering and authored Team/main transcript comparison remain unverified. Available captures do not prove those journeys. No substitute seeding, assertion weakening, product change or temporary runtime probe is used. Actual Claude stays deferred; the diagnostic engine bearing its name is inert.

The task's `private-windows-optins-20261013/QUALIFICATION.json` and `HANDOFF.json` distinguish this manual continuation from the 149 automated identities and preserve historical receipts. These partial UI outcomes do not change suite totals or declare full beta acceptance.


## Integration #701 reconciliation

The complete #693 migration is retained in #676 ancestry. Integration from master `77b84212644565500f5e979a364f59817ccfd510` preserves all 36 maintained test files from #676 byte-for-byte and includes these already-authored additions once:

| Original source | Canonical location | Feature | Runner and requirements |
| --- | --- | --- | --- |
| Current master #700 | `tests/chats/decision-skip.test.mjs` | chats; Agents and notifications | Native Node server lane; disposable canonical store on every host; two existing controlled route cases retain their Windows gates |
| #699 `c6ebbf64` | `tests/files-results/artifact-storage.test.mjs` | files-results | Native Node server lane; disposable artifact bytes, workers and restart reads on Linux/macOS/Windows; no provider account |

The union contains 38 implementations and 159 test identities: the complete 149-case #676 suite, three current Decision cases and seven storage cases. Root inventory and recursive test discovery match exactly, with no duplicate paths. The only merge conflict was inventory metadata; existing repaired MCP/Windows-fixture requirements and every current entry were retained. No test body, assertion, identity, timeout, opt-in or platform gate changed during integration. Packaging implementations from #676/#699 remain reviewed changes in their original histories; the earlier migration-only comparison remains historical.
