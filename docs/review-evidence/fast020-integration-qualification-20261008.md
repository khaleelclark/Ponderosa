# FAST0.2 Branches and Dev integration: local qualification

The composed product source at `6e04cfce0bed2a47b41704185eeb27372ee9206d`
passed local verification on Linux x64 with Node 24.16.0 and pnpm 11.10.0.
This follow-up repairs the existing isolated Branch UI fixture and its runner;
product source, dependency lockfile, migration registration and workflows are
unchanged. Independent approval of the complete integration and exact-head
GitHub checks remain required before merge.

## Scope and source

Master baseline is `5da30ba3d89eb650aed1c5e524aae38e087f4d9a`. The source merge
preserves Branches `d862c5286378f200f9cb7af7ca247c4e0c0ef40e`, budget
`facde55dbde4c1fcc172d15829a5ab260e145d47`, and Dev tip
`638f7c5bf2e7f41b0774200624b5df97e961cbb0` (including PR618 and PR619).
PR623 remains draft, targeting master. This qualification follows the operator's
new approval for local and GitHub tests; prior source preparation restrictions
and original Dev checkout restrictions remain historical and unchanged.
Branches is the release priority. Separate unfinished memory, Wildfire and Grok
work is outside this candidate and does not block this bounded qualification.

## Results and repeatable commands

- `pnpm install --offline --frozen-lockfile`: exit 0, using the existing cache.
- Dependency builds for core, native-host, engines, agents and server: exit 0.
- `pnpm verify`: exit 0; 1,586 tests, 1,578 passed, 8 existing platform/environment
  skips, zero failed or canceled; production builds and web bundle budgets pass.
- Focused Agent tests: 270 passed, zero skipped/failed. Files: `db-launch-baseline`,
  `branch-trigger-migration`, `branch-execution-budget`, `branch-calls`,
  `branch-graph`, `branch-map`, `lead-task-continuity`, `dependency-finalization`
  under `packages/agents/test/`, each with `.test.mjs` suffix. Run with
  `node --test <these files>` after dependency builds.
- Focused server tests: 152 passed, zero skipped/failed. Files: `lead-task-continuity`,
  `resource-admission-http`, `branch-triggers`, `branch-resources`, `branch-product`,
  `branches`, `branch-mixed-restart`, `branch-map-restart`,
  `product-scope-final-regressions`, `agent-import-transaction`,
  `previous-publication-session-contract`, `canonical-tool-contracts`,
  `dependency-process-restart` under `apps/server/test/`, each with `.test.mjs`
  suffix. Run with `node --test --test-concurrency=1 <these files>` using the
  isolated environment documented by `apps/server/test/run-tests.mjs`.
- Four populated disposable upgrades: archived master, Dev, Branches and budget
  Agent sources and exact SQL/registration, using frozen candidate dependencies,
  then candidate `openDb` and two reopenings. All pass. Original task rows and
  terminal ownership, accepted session hash, Branch inputs/paths/checkpoints and
  budget policy/counters/command receipts are preserved; no historical task is
  revived; foreign-key and SQLite integrity checks pass. External fixture and
  complete logs are retained in the qualification handoff. This checks source
  migrations, not old native ABI, live provider sessions or installed rollback.
- Existing Chromium PDF, receipt-layout and Agent-stream recovery runners pass,
  using pinned cached Chromium 153.0.8010.12 and the server's `playwright-core`.
  Commands: `node apps/web/test/pdf-modal-browser.check.mjs`,
  `node apps/web/test/message-receipt-layout.check.mjs`,
  `node apps/web/test/agent-stream-recovery.check.mjs`, with
  `PONDEROSA_PLAYWRIGHT_PATH` pointing at `apps/server/node_modules/playwright-core/index.mjs`
  and `PONDEROSA_CHROMIUM_PATH` pointing at the cached executable.

- Complete Branch convergence browser runner: exit 0, all 15 reported phases
  pass with zero page errors, including eight light/dark width combinations,
  navigation guards, canonical ownership, package races, Chat creation,
  accessibility and For Each authoring. Dedicated fixture typecheck: exit 0.

## Reproduced fixture failures and narrow repairs

The old Branch fixture returned `[]` for operational status. Selecting an
execution crashed with `Cannot read properties of undefined (reading 'mapItems')`.
It also lacked the automatic-budget response. The fixture now supplies both
responses with shared DTO type checks. The server already supplies these shapes;
no product behavior was changed.

The old runner required an external `playwright` package despite the frozen
server dependency being `playwright-core`. It now resolves the server dependency
by default and rejects page errors on every disposable page. The old Project
Agents URL and heading assertion referred to a retired route; its embedded
navigation checks now use the supported Chat Agents route and visible Agents
panel. Background-deployment notification assertions now use the current
visible copy, preserving dirty-draft retention, exact Branch scoping and retry
behavior. Disabled-run, dirty-form, canonical-owner, accessibility, authoring and
navigation assertions are retained. See `apps/web/test/branches-convergence/README.md`
for fixture startup and the runner command. The fixture's dedicated TypeScript
check is `pnpm --filter @ponderosa/web exec tsc -p test/branches-convergence/tsconfig.json --noEmit`.

All early external-fixture setup failures, the reproduced page error, the stale
route failure and the first fixture typecheck failure are retained in the external
handoff logs. Passing receipts identify their final commands explicitly.

## Required remaining evidence

Verify and Release recovery checks are active, but active state is not a passing
check. No native release workflow was dispatched. The inherited recovery and
native-beta recipes reference three absent files: `speech-sandbox.test.mjs`,
`speech-cleanup-race.test.mjs`, `speech-recovery.test.mjs`. A separately assigned
CI/packaging owner must reconcile actual recovery coverage; do not remove safety
checks simply to obtain green CI. Host speech setup was not run.

No live provider/subscription, installed native artifact, physical-device voice,
real mobile keyboard, native toolbar zoom, installed PWA, production-scale startup,
whole-directory rollback or deployed UI qualification is claimed. The eight skips
remain engine/native browser/process-scope/data-lock/extension conditions. Browser
checks use disposable fixtures and CSS viewports. Exact-head independent runtime,
storage and UI/API review must cover all 234 original Branch paths and Dev
composition, not only the historical budget review. Root version remains 0.1.0;
version/notes, native platform evidence and release approval are separate gates.
