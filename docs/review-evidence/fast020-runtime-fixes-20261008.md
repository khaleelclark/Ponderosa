# FAST0.2 runtime repair qualification

Three reproduced P2 integration defects are repaired on the released CI repair
base `e7592314eeaa16a9af9e50df91d64b2cb088bdf0`, a descendant of independently
reviewed `821760573bb94cad70e86e827d4084883dea1f30`. PR623 remains draft. This is
writer qualification evidence; independent runtime and UX review of the final
commit and final required CI are still required.

Script claims now select frozen Script Steps and rotate bounded 100-row batches
past capacity-ineligible executions. A snapshot ceiling keeps arrivals from
extending a scan indefinitely. Reopening restarts the finite scan; subsequent
claims continue progress. The existing frozen capacity check and lease, cancel,
terminal and result fences remain. An immediate SQLite transaction acquires write
authority before selection, preventing read-to-write upgrade contention between
claiming processes. No batch/queue ceiling or concurrency limit was increased.

Refresh handoff compatibility reconstructs the exact pre-capability-policy tool
hash for recognized current/previous prompt and tool contracts only while the
current policy is unrestricted. It still requires the accepted session hash,
exact frozen system hash and matching original session. Restricted sessions do
not get the unrestricted alternative; unknown hashes and changed policy fail
before provider dispatch. Original accepted input, manifest and session remain
immutable; only a verified replacement adopts the current packet.

Retiring installed resources remain unavailable to ordinary reads and intake.
Authenticated scheduler dispatch and runtime capabilities can access the exact
owner Agent, Chat and Project only when the live Run/fence is attached to the
canonical Request of an uncanceled accepted Branch execution whose snapshot pins
that Chat. Staging/deleted resources, other retiring Agents, canceled Requests,
expired leases and fenced Runs receive no retirement exception. The ordinary
product predicates remain unchanged. Response projections use the same exact
retained ownership predicate. Cleanup retains the existing ordinary product
namespace without granting fenced Runs retained-resource access.

New checked-in behavioral regressions:

- `packages/agents/test/branch-script-claims.test.mjs` and its worker: 120 disabled
  Calls before unrelated Script work; 120 capacity-ineligible Scripts before an
  independent Branch; reopen, bounded progress, cancellation/terminal stale
  results and competing SQLite processes claiming exactly once.
- `apps/server/test/branch-retained-runtime.test.mjs`: real package import/update,
  durable reopen, actual production scheduler dispatch and runtime capabilities,
  old gate and budget-held child continuation after Chat/Agent removal, own Agent
  projection and Team directory, unrelated retiring Agent and new intake denial,
  staging and Run-fence denial, Request cancellation, terminal capability expiry
  and eventual retirement deletion. Uses an inert adapter; no provider/account.
- Existing cross-build `context-rollover-upgrade.check.mjs` and its inert CLI
  process fixture now also reject changed capability restrictions. Its hash-change
  assertion applies only to different source roots; a same-build Refresh may
  retain the same exact contract. Replacement session identity, frozen packet,
  actual adapter and MCP tools/list assertions remain.

Focused results: 134/134 storage/Branches/Calls/budget/Script tests and 111/111
server/runtime/product/resource/contract tests, no skips or failures. All eight
new behavioral regressions pass. Expected-behavior baseline checks against the
immutable 821 product build fail for both Script starvation and retiring dispatch.
A genuine master pending Refresh fails against that original build with the
retained incompatible-contract diagnostic; master-to-master controls succeed.

Genuine accepted-session matrix: master and Dev pending/newly requested Refresh,
Branches and budget pending/newly requested Refresh, and current pending/newly
requested Refresh succeed. Master, Dev and current reject unknown hashes, changed
operator policy and newly restricted filesystem policy before opening a provider.
Nineteen target cases plus two master controls pass. Each success verifies exact
old system/tools/MCP advertisement and immutable original provider packet/manifest,
then the replacement's current packet and a new accepted session. No success
case fabricates a contract hash or resets accepted context.

Archived exact source roots M/D/B/F were independently extracted into writer-owned
scratch and transpiled with frozen TypeScript. Their dependencies resolve to each
root's own core/engines/agents/server modules using the existing frozen cache;
unchanged native-host output is reused. This compares source runtimes, not old
installed ABI or whole historical build qualification. Separate worker processes
exit after app.close; disposable data is removed.

Reproduction and harness failures are retained in the external evidence directory:
initial concurrent Script claim SQLITE_BUSY, initial missing validated trigger
setup, expanded-test duplicate variable, a cancellation assertion that assumed
Request cancellation immediately ended its Run, and a same-build assertion that
incorrectly required a changed hash. The corrected cancellation oracle asserts
immediate denial of retained resources followed by actual Run exit and deletion.
These do not waive failures. Complete commands, exits, raw cross-build packets,
source archives and successful receipts accompany the standalone handoff.

Final pnpm verify passes: 1,596 total / 1,588 passed / eight existing skips /
zero failures; types, production builds and bundle budgets pass. Recovery passes
28/28 runtime tests without skips plus both speech/voice browser suites.
One final unchanged storm run fails its strict API p95 <250 ms criterion at exactly
250 ms (1,600 samples, queue p95 223.8 ms, wire p95 3.6 ms). The overlap oracle
passes. This is retained as a qualification blocker; no rerun, waiver, threshold
change or product-performance conclusion. Further latency investigation requires
separate tracked ownership beyond these three runtime fixes. Exact-head CI receipts
are recorded in the standalone handoff. The inherited repaired recovery recipes and
250 ms storm criterion are preserved. No schema, dependency, lockfile, workflow,
version or optional memory/Wildfire/Grok change is included. No live/native/PWA,
physical voice/keyboard, installed ABI, full backup rollback or production-scale
qualification is claimed. Version/notes, native platforms/artifacts/provider
proof and independent final source/release approval remain separate gates.
