# Branches release qualification

Status: implementation complete and independently code-approved for release review. Linux/Codex is qualified by the evidence below. Successful Claude execution and the pre-existing macOS attachment portability limitation remain explicitly unqualified; no production deployment or merge has occurred.

## Scope and ownership

The full approved Branches design is implemented on `codex/branches-complete`, based on reviewed Phase 1 commit `a084095bf481e07ad51f1f1ca4e1bb63d4e89e8c` and the approved `experiment/chat-first` product base. The only writer is the current Codex task in `/Users/patmi/Desktop/Ponderosa-branches-complete`. Independent reviewers use Ponderosa tracked Agents and remain read-only.

Current `origin/master` was rechecked at `e1c88eab3c923be4c6dfb300282e3cccb75c3a7f`; the approved experimental base remains `f3e44b8f94d2fa106c4e4c0c51119e2fb18301f5`. Master’s newer Pine voice deployment change is outside this workflow implementation. The PR targets the approved experimental base, not an implicit replacement of master.

## Implemented qualification areas

- Structured acyclic graphs: conditional exclusion, nested fork instances, all/any/quorum joins, deterministic selection ordering, finish/cancel remainders, and resource budgets.
- Human gates and recovery: edits/options/rejection, stale revision and duplicate command behavior, bounded known-failure retry, recovery-Agent Requests, explicit unknown-outcome reconciliation, skip/merge.
- Native triggers: scheduled/webhook/filesystem intake, atomic occurrence/execution acceptance, version/binding pinning, duplicate suppression, old-source detachment, one-time webhook secrets, and bounded payload references.
- Temporary resources: tracked creation and rollback, canonical opening Request, owned descendant budgets, retry identity reuse, delegated cancellation, observed cleanup, fair scans, retry-vs-archive revalidation, and projection rebuild of active/archived members.
- Scripts and notification Actions: immutable source, exact stdin, process identity/fences, actual daemon death, no automatic replay of submitted Scripts, durable notification dedupe, expired lease rejection, and persistent delivery diagnostics.
- Product UI: authoring, deployment preview, configuration, templates, versions, execution graph/history, approvals, intervention, late-response selection guards, and bounded retrieval.

## Automated and interactive evidence

Linux qualification uses an isolated checkout and data directory under `/home/phoenix/khaleel/ponderosa-branches-qualification-20260917`, Node 24.16.0, and pnpm 11.10.0. It does not modify production checkouts or services. At checkpoint `21b63070`, all 76 focused Branches/database tests and all 252 server tests passed; dependency-ordered builds including web passed.

macOS uses Node 24.15.0 and pnpm 11.10.0. The Agent suite passed 136 tests before the last projection-replay regression; web passed 210 tests. Focused suites and builds are repeated for changed boundaries. The broad server run exposed a pre-existing Linux-only `/proc/self/fd` attachment assumption in the HEIC draft test. Its unrelated import rollback test passed all 11 tests when rerun independently; Linux’s full server suite passes. macOS attachment portability is not represented as qualified by the Branches feature tests.

Browser qualification created and deployed a Script → editable approval → notification workflow, submitted input, edited the approval result, and observed completed output. The UI used the pinned version and retained the prior deployment in version history.

A real Codex subscription qualification on macOS used a signed webhook, replayed its event without duplication, tracked a temporary two-Agent organization, delegated one canonical Request/Join to its worker, received `CHECKED-42`, completed the root Request with `TEAM-CHECKED-42`, approved the result, delivered the notification, and archived both Agents after observed process cleanup. The corrected execution completed with `TEAM-CHECKED-42-APPROVED`; provider process authority count was zero. The first exploratory execution exposed cleanup and projection-replay defects, which were fixed and given regressions; its forensic history is retained rather than rewritten.

Claude on Pine reports an authenticated first-party OAuth session. Its live workflow attempt was rejected by the provider with `organization_policy` before completing the task. Ponderosa retained an explicit outcome-unknown Request and did not automatically replay it. Successful Claude end-to-end execution remains dependent on a usable account/profile; it is not claimed as passed.

## Review and release gates

Independent exact-commit review has covered graph semantics, native triggers, resource lifecycle, Actions, history, and the UI across successive checkpoints. Reported defects were fixed with focused regression coverage. Final implementation head `85ce5d8e7257c9d93c6758fe87368909d95b5763` received an independent cumulative code-review approval with **no remaining code blockers**. The reviewer was a Ponderosa tracked Agent, read-only, and reviewed each exact committed delta. This is a static code-review approval, not an independent rerun of qualification or deployment authorization. [PR #518](https://github.com/khaleelclark/Ponderosa/pull/518) contains the cumulative implementation on `experiment/chat-first`. GitHub reports no configured status checks for this PR; local and isolated-host results are the verification evidence.

No merge or production rollout is authorized by implementation alone. A deployment requires an explicit release decision after reviewing this evidence, backing up canonical state, and observing normal process-draining shutdown. No credential or provider profile is included in the package or repository.

### Final browser concurrency regression

The actual Branches React UI was tested with its import-preview response deliberately held by an isolated preview-server hook. An advanced definition named `STALE RESPONSE MUST NOT WIN` was submitted, an older version of the same workflow was restored, and the held response was then released. The restored workflow name and its two-node graph remained intact. Two overlapping file imports were also held and released; the newer requested import remained the draft. No test definition was deployed. The temporary delay flag was removed after the checks.

The final server/Agent implementation checkpoint `9401d0b793b5503d02b136209892ccf96796a549` passed Linux builds plus 136 Agent, 252 server, and 210 web tests. The subsequent change is confined to UI draft supersession; its web typecheck/build and the controlled browser regression passed. The corrected Codex execution and archived organization also survived a graceful daemon restart at this checkpoint.


## Release handoff

- Objective: complete the approved Branches workflow system and qualify a release candidate.
- Writer: current Codex task; branch `codex/branches-complete`; worktree `/Users/patmi/Desktop/Ponderosa-branches-complete`.
- Base: `a084095bf481e07ad51f1f1ca4e1bb63d4e89e8c`; approved implementation head: `85ce5d8e7257c9d93c6758fe87368909d95b5763`. A documentation-only commit records this disposition.
- Implementation checkpoints pushed: graph/gates `a7614957`, native triggers `538d16f0`, tracked resources/packages `fa1e30d6`, UI/Actions `a4add742`, history/restart fixes `21b63070`, release diagnostics `9401d0b7`, final editor fencing `85ce5d8e`.
- No unresolved code-review finding. No GitHub check is configured; no green CI status is invented. The unrelated macOS HEIC assumption and external Claude account rejection are retained as qualification limitations.
- No production checkout, service, credential, or subscription profile was changed. Linux tests used a detached isolated checkout. The Claude test server was gracefully stopped, owned resources archived, and remaining test process records reconciled through the existing observed process authority.
- Next authorized action: use the isolated preview and review PR #518. Merge and production rollout require explicit authorization under AGENTS.md. Successful Claude qualification requires an account/profile accepted by the provider.
