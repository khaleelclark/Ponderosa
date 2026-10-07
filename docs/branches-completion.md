# Branches completion and production qualification

Authorized target: the approved full Branches architecture, following the user's request to finish the system on 2026-09-17. No merge or deployment authorization is implied.

Writer: this Codex task. Worktree `/Users/patmi/Desktop/Ponderosa-branches-complete`; branch `codex/branches-complete`; base `a084095bf481e07ad51f1f1ca4e1bb63d4e89e8c`. The full isolated preview runs at http://127.0.0.1:39220/branches. The original Phase 1 preview remains separate.

## Completion checklist

- [x] Durable conditions, structured forks, nested joins, all/any/quorum, selected-path data ordering and losing-path cleanup.
- [x] Human gates: approve, edit, reject, options, conflict detection, idempotent recovery after restart.
- [x] Stop/retry/human/recovery-Agent policies; explicit outcome-unknown reconciliation and operator intervention; merged/skipped outcomes.
- [x] Shared trigger infrastructure routes manual/schedule/webhook/filesystem occurrences exclusively to Branch or Agent authority, pinning accepted versions.
- [x] Template-backed ephemeral Agents/organizations use existing tracked creation and lifecycle receipts, with bounded resource ownership/cleanup.
- [x] Portable definitions/scripts/templates; import validation, export without private runtime/local bindings, deployment preview and stable binding reconciliation.
- [x] First-class Engine Actions with durable receipts and honest side-effect/reconciliation guarantees; no speculative catalog or credential store.
- [x] Workflow-centered authoring, graph inspection, versions, triggers, configuration, executions, approvals, intervention and bounded history UI.
- [x] Crash, duplicate, concurrency, cancellation, migration and artifact/text-boundary regression coverage.
- [x] Subscription-backed end-to-end qualification; independent review of exact final head; platform and operational production-readiness report.

Phase 1 safety invariants remain mandatory. A checked item needs working behavior and verification, not merely reserved types or tables. Unsupported provider permissions must never be represented as enforced. Marketplace/distribution, arbitrary graph cycles, same-Agent parallel provider Runs and new provider authentication models remain outside the approved design.

See [the user guide](branches-guide.md) and [qualification evidence](branches-qualification.md). Independent code review is complete with no remaining blockers at implementation head `85ce5d8e7257c9d93c6758fe87368909d95b5763`. Linux/Codex qualification passed. The documented Claude account and macOS attachment limitations are not claimed as resolved; production merge/deployment remains a separate explicit release decision.
