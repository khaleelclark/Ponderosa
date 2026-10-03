# Cross engine rollover qualification

This report accompanies the correctness fix for Claude context observations and
explicit human refresh. It separates controlled regressions, disposable live
qualification, and pending performance evidence. It is writer-produced evidence,
not independent approval. Nothing in this task is authorized to merge or deploy.

## Revisions and ownership

- Base: `5622c62733d5c5967de5d5f81cdb566cb9fa6f7d`, revalidated current master.
- Correctness commit: `a35691219b0cb3c8a544f00f75c92cc305378dd8`.
- Qualification harness commit: `0cb0ce1469be54f73e70c1ed1c11f79eccc7a45b`.
- Branch: `fix/cross-engine-context-rollover-20261002`.
- Writer worktree: `/Users/khaleel/Projects/Ponderosa-worktrees/cross-engine-context-rollover`.
- One writer owns this branch. The dependency-finalization work is already
  included in the base; no overlapping active context writer was identified.

The supplied reference `060348ddb28cf7d0dae31cbd8ff6bd338f567855` is an ancestor,
not the implementation base. Correctness and qualification are separate commits.

## Baseline reproductions

Both defects were reproduced before editing the base, using private storage and
the real Claude stream adapter with a disposable transport fixture:

- A current main-session request reported 150,001 input tokens, including cache
  read/creation input. The normalized events were `session`, `text`, `turn_done`:
  no `context_usage` reached generic rollover handling.
- A human refresh detected 10,000 tokens. A later old-session observation of
  11,000 tokens completed it with historical reason `native_compaction`, without
  creating or verifying a replacement.

Local evidence: `/tmp/ponderosa-rollover-baseline-{install,build,evidence}.log`.
These are controlled transport reproductions, not successful Claude subscription
requests. Their private stores and processes were removed.

## Correctness changes

Claude emits occupancy only after its exact current input echo is accepted, from
a valid main-session assistant request. The observation includes the exact
provider session/generation and uncached plus cache-read plus cache-creation
input, using [Anthropic's input-token semantics](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
Historical replay, subagent output, duplicate request IDs, synthetic zeros,
aggregate results and invalid counters cannot replace occupancy. Unknown window
size remains unknown. Request tracking is bounded and fails closed at its limit.

Human refresh cannot be retired by an old low-usage observation. Missing initial
occupancy is SQL `NULL`, not a manufactured measurement. Human/automatic overlap
returns a structured conflict without changing the frozen boundary. Automatic
same-generation recovery requires valid decreased occupancy and records
`headroom_restored`; that is not proof of native compaction.

Two integration defects discovered by the production-route regressions are also
fixed. Fresh replacement validation accepts exactly the hash-bound environment
facts already produced by current master, without changing historical packet
hashes. Run-specific reply guidance stays in the existing exact-Run injection,
not the immutable session policy. This avoids replacing the retained session
before its handoff solely because a handoff has no convenience reply route.
Tool-enforced routing and permissions are unchanged.

The new schema migration only makes initial occupancy nullable and admits the
new completion reason. It preserves historical rows, rowids, packets, hashes,
indexes, triggers and historical `native_compaction` values.

## Controlled verification

| Check | Result |
| --- | --- |
| macOS Node 24.21.0 `pnpm verify` | 1,041 passed, 7 platform/opt-in skips, zero failures; typechecks and production builds passed |
| Pine Node 24.16.0 `pnpm verify` | 1,043 passed, 6 platform/opt-in skips, zero failures; typechecks and production builds passed |
| Claude normalization tests | 3 passed |
| Human refresh and migration tests | 4 passed |
| Real HTTP/store/scheduler Claude transport regressions | 17 passed |
| Session prompt and canonical tool contract checks | 5 passed |
| Final focused engine, authority, scope, steering and dependency set | 51 passed, zero skips/failures |
| `git diff --check` | Passed |

The full-route checks cover automatic pressure, warm and cold human refresh,
missing initial occupancy, exact replacement verification, invalid/missing/stale/
subagent/replayed/high replacement telemetry, exact-Run cancellation, failed
observed teardown, and environment hash/path/reference rejection. They assert
that the old accepted durable snapshot remains until verification and the old
process is closed before a fresh process opens.

Existing rollover-cycle, manual-scope, steering, authorized-history and dependency
finalization regressions pass within the full suite, including dependency result
→ progress → rollover/completion → exact wakeup. These store tests are not a
live concurrent managed-Agent qualification or a full application crash test.

Local final log: `/tmp/ponderosa-rollover-final-verify.log`. Pine final log:
`/tmp/rollover-a3569121-node24-verify.log`. Earlier Pine attempts used the wrong
Node path or a stale native SQLite ABI and failed; they are not passing evidence.
The final private installation rebuilt SQLite with Node 24.
The subsequent harness commit also passed a fresh local `pnpm verify` in
`/tmp/ponderosa-rollover-candidate-verify.log`; the remaining commit adds only
this report and its measurements.

## Disposable Codex comparison

The opt-in harness is `apps/server/test/context-rollover-live.check.mjs`. It uses
the existing authenticated subscription, private stores and loopback HTTP. It
creates no API-key integration and copies no profile or credentials.

Pairs use the same private path and stable fixture identities, exact model and
effort, identical initial instruction/tool hashes, and equivalent authored
context. Two workloads retain seven facts/constraints/completed and unfinished
items: a short fact set and the same facts with 100 inert ledger records.
Both seeds remain inline rather than comparing different artifact-reading paths.
Three repetitions alternate managed/native order. Caches are not reset; measured
input/cache counters and host conditions are retained. One benchmark sample runs
at a time, but unrelated host work is uncontrolled.

Ponderosa samples call the production human refresh route and require
`replacement_verified` for a fresh accepted session. Native samples call the
provider's `thread/compact/start` and require matching actual
`contextCompaction` start/completion events, as described by the
[Codex app-server protocol](https://learn.chatgpt.com/docs/app-server).
Low usage alone is not native completion evidence. Both methods must then
publish exactly one new canonical reply containing every original fact, with
processed/provider-acknowledged receipts on the original exact Run and no
substitute recovery Run. Only disposable owned threads are archived.

Native total interruption includes the availability/catalog check before the
provider RPC. The actual item start-to-completion duration is recorded separately;
catalog preparation is not provider compaction time. This qualification does not
use that overhead to claim a managed speed advantage.

The initial calibration produced one successful Ponderosa replacement and one
failed native-wrapper check: the existing adapter's separate ten-second
post-command telemetry wait expired. Instruction hashes also differed because
the initial fixture used fresh identities/paths. Those attempts remain in
`/tmp/rollover-a3569121-live.log` but are excluded from comparable timing claims.
The corrected harness observes native start/completion directly and enforces
exact paired instruction/tool hashes; it does not change product code.

A second calibration completed three matched short-context pairs. Its first
350-record ledger seed completed, but the harness incorrectly searched its
preview-backed message by full text when checking the receipt. That failed test
is preserved in `/tmp/rollover-a3569121-paired-live.log`; it is not a product
delivery failure. The final harness uses the canonical intake ID and an inline
100-record ledger workload. Calibration samples are not mixed into final timing
aggregates.

### Final paired results

All 12 final samples passed: six verified Ponderosa replacements and six native
compactions, with three pairs per workload and no failures. Every sample retained
the seven facts, constraints, unfinished work and next action, produced the
expected exact canonical reply and receipts, and used no substitute recovery Run.
All processes were observed closed, private data removed, and all 18 owned
provider threads archived. Final evidence is
`/tmp/rollover-a3569121-final-live.log` and the committed
[raw measurements](performance/cross-engine-rollover-20261002.json).

The run used Codex CLI 0.159.2, configured/observed task model `gpt-6.1-sol`, low
effort, and Node 24.16.0 on Pine. Starting occupancy ranged from 19,000 to 21,735
tokens; one-minute host load ranged from 0.92 to 2.63. Per-sample memory, cache
counters, model and instruction/tool hashes are in the measurements. Native
compaction's internal implementation/model selection is provider-controlled and
not separately reported.

| Measurement in milliseconds | Ponderosa median / maximum | Native median / maximum |
| --- | --- | --- |
| Manual request to safe scheduler boundary | 38 / 62 | Not applicable |
| Handoff generation | 7,570.5 / 7,955 | Not applicable |
| Old runtime teardown | 32 / 40 | Not applicable |
| Replacement startup | 347.5 / 362 | Not applicable |
| Replacement submission to verification | 6,404.5 / 7,074 | Not applicable |
| Actual native compaction item | Not applicable | 14,065 / 18,905 |
| Total refresh interruption | 13,989 / 14,951 | 20,057.5 / 24,553 |
| Refresh start to first correct resumed result | 19,012 / 19,354 | 25,535 / 30,394 |

No speed advantage is claimed. In these small low-pressure samples, managed
refresh and the actual native compaction item both took about 14 seconds at the
median. Native total interruption additionally includes catalog preparation;
that difference is not evidence of faster compaction. Six samples per method do
not support a tail-percentile claim.

These are explicit below-pressure warm refresh samples. Pressure detection to
safe boundary, high-pressure automatic performance, large-context tails, and
multi-Agent concurrency are not qualified by these timings. Automatic retirement
and `no_continuation_required` are not full replacements and are excluded.

## Pending Claude live qualification

Pine's existing authenticated Claude subscription rejects disposable requests
because the organization has disabled Claude Code subscription access. Actual
current input echoes were observed with `isReplay: true`; only an exact current
submission echo can unlock observations. No successful Claude request,
subscription replacement or native timing is claimed. The operator explicitly
left Claude live qualification pending. No alternate profile, API key or copied
credential file was used.

## Safety and remaining review

Controlled fixture stores/processes were removed. Live-test cleanup records
process closure, private-data removal and owned-thread archival in each sample.
Existing services, Agents, provider authentication/configuration, browsers,
sandbox `:38443`, and live user data were not modified by this task. Only owned
disposable provider threads were created/archived. Thresholds were not lowered.

Independent code review and independent performance qualification remain pending.
Use the companion review prompt against the final candidate head. This report
does not approve merge, controlled promotion or production release.
