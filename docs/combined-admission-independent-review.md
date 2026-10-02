# Independent review prompt

Review the combined admission/dependency/tool-contract PR independently. Review
only; do not implement, merge, deploy, trigger Actions, change PR state, or use
live data, Agents, browsers, provider state, dev, experimental or production.
Use one separate read-only detached worktree and disposable synthetic fixtures.
Do not create untracked subagents or live Ponderosa assignments.

The implementer's handoff supplies the PR URL and exact candidate SHA. Verify
both remotely before and after review. Approved base:
`060348ddb28cf7d0dae31cbd8ff6bd338f567855`. Recheck current master and report any
change or overlap. Inspect the aggregate diff, AGENTS.md, and
`docs/combined-admission-dependency-tool-contracts.md`; do not treat implementer
claims or previous-head checks as independent proof.

## Required scope

1. Exact parent Request continuation across request/request-update/join sources,
   progress, open/satisfied/impossible Join wakeups, rollover and restart. Check
   exact stable IDs, owner/scope/lifetime, one wake/terminal result, no replay or
   historical reopen, and unchanged cancellation/provider-loss fences.
2. Structured disabled-provider admission with zero Agent/Communication/
   Request/Join/Activation residue; committed replay first; config-only allowed;
   preset/asynchronous-preparation/prelaunch races; exact uninjected work held
   without failure-retry consumption; accepted Runs not cancelled.
3. Payload-free shared queued blocker DTOs from scheduling authority. Check
   active/preparing/Decision/dependency/backoff/unknown-auth/idle precedence,
   cancellation/preferences/restart, and no polling/probe-per-read.
4. Exact advertised enum, schemas and backend accepted values; conditional bare
   reply capability from canonical metadata, not text; immediate Collaboration
   recipients and separate next_run; correlated results; conflicting inputs,
   managed/Join/Decision/steer/resume/rollover paths; exact submitted instructions
   and immutable hash/source manifests. Inspect the additive injection-ledger
   migration and historical compatibility.
5. Exactly one deadline response for late return/send/exception, admission held
   through actual settlement, streams/reconciliation unchanged; bounded and
   coalesced probes with actual process-tree cleanup, not Promise.race alone.
6. Narrow browser-key validation with actionable 400s; End/Enter/shortcuts/
   Unicode/platform mapping preserved; stale page, control takeover, transport
   failure and attempt/consequence metadata distinct; no automatic action replay.
7. Provider-supplied command exit/signal through engine normalization, strict
   event validation, persistence, shared DTOs and activity. Prove command exit 1
   is not terminal provider failure and a complete same-Run tool-error →
   correction → canonical Communication → successful completion trace.
8. Explicit structured connector throttling before conflicting generic codes,
   bounded finite delay metadata and original audit output; authentication/
   provider/connector budgets distinct; no prose authority or write replay.
9. Bounded actual cwd/platform/executable observations and exact manifest; only
   an existing authorized external reviewer-output root, safe no-root fallback,
   helpful import 403, valid isolated publication and symlink denial. No install,
   automatic copy, widened roots, secrets or shell-history injection.
10. Confirmed logout distinct from unknown/error/timeout, probe coalescing and
    bounded explicitly stale evidence. Exact Run/session/process/observed
    terminal/host-operation diagnostics; only explicit completed is successful;
    immediate authority-loss fencing and observed teardown remain intact.

Richmond's interruption origin is unproven. Do not infer its resolution from
generic errors, artifact warnings or synthetic fixtures. No automatic repair,
historical reopening, blind injected-work retry, or pressure guard is authorized.
Preserve Decision-recipient and public-progress changes from the base.

## Verification

- Run Node 24 `pnpm install --frozen-lockfile` and full `pnpm verify`, including
  typechecks/builds. Inspect failures rather than excluding them. Demonstrate
  any claimed unrelated failure on the exact base; skips are not passes.
- Rebuild the exact base separately and run the retained comparison harness:
  `node apps/server/test/combined-spec.check.mjs <built-checkout-root>` against
  base and head. Add independent probes where the harness is insufficient.
- Run focused files for dependency finalization/deferred admission/injection
  migration; disabled creation/prelaunch/queued status/tool contracts/deadlines;
  auth uncertainty/browser keys/import/environment/runtime observation; engine
  command/terminal/process evidence and connector classification. Include
  `tool-result-projection-run-regression.test.mjs` and the separate application
  process restart test. Assert canonical counts/lineage, not just mocked DTOs.
- Exercise real isolated browser input where supported. Qualify web activity
  and status presentation proportionately, including narrow layout/accessibility.
- Verify `git diff --check`; keep the detached review worktree clean. Clean only
  your own disposable fixture resources, retaining bounded logs/screenshots.

Implementer evidence: base 934 passed/7 skipped; candidate 986 passed/7 skipped;
55 focused tests passed on macOS Node 24.21.0. These are not your independent
results. Real isolated Chrome, clean full-process restart, controlled adapters
and owned RPC/probe processes were used. Actual provider low-water compaction,
concurrent managed-provider reliability, physical phones, installed Safari,
native Windows and Linux deployment were not qualified.

Report actionable findings with severity, precise path/line, reproduction,
impact and smallest fix. Give separate code-merge and controlled-dev-promotion
verdicts at the exact SHA. Explicitly list qualifications not performed and
unresolved investigation gates; inaccessible GitHub checks are not green.
