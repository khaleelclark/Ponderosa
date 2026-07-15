# Communication V3 qualification — 2026-07-15

## Decision

Communication V3 is ready for review behind its existing feature gate. In the
matched real-agent feature trial it preserved implementation quality while
reducing provider runs, tokens, and projected API cost. It did not reduce wall
time in this sample, so the result supports a cost/reliability improvement, not
a universal latency claim.

Production remains on V2. The isolated V3 service used a separate data
directory and port; no production project, service, or data was reset.

## Controlled setup

- Machine: Pine, so both conditions shared provider latency and host load.
- V2: deployed Ponderosa at `127.0.0.1:8787`.
- V3: isolated worktree/service at `127.0.0.1:19818` with
  `PONDEROSA_COMMUNICATION_VERSION=3`.
- Repository: byte-identical Campaign Ledger base tree
  `b5464eaa5c3d333dd7e44ebbeae900ede61198bc`.
- Task: implement Budget Amendment Requests from the same prompt.
- Organization: three-agent flat star — Delivery Lead, Backend Domain Owner,
  and UI Quality Owner.
- Runtime: Codex `gpt-5.6-luna`, medium effort for every agent.
- Ownership: disjoint backend and UI file surfaces; the lead integrated,
  verified, and committed.
- Grader: deterministic Feature 01 grader, 50 points.
- Cost: request-granular projected list-price proxy from Ponderosa's usage API.

The V2 and initial V3 conditions were launched together. After that run exposed
a V3 lease failure, the fixed V3 condition was rerun from the identical base
tree and compared with the preserved live V2 control.

## Fault discovered by the first full trial

The first V3 run was intentionally retained as evidence rather than treated as
a benchmark win:

- both worker scheduler leases expired after 30 seconds while their provider
  turns were still healthy;
- the requests became `outcome_unknown`, the join became `impossible`, and the
  lead woke prematurely;
- provider runs existed in memory while the scheduler considered those agents
  idle, producing 396 retry-run records from repeated 409 responses;
- recovery expanded the run to 10 provider turns, 2,049,929 tokens, and
  $0.529903 while still reaching 42/50.

Two missing invariants caused it:

1. The runtime execution lease was renewed, but the SQLite scheduler lease was
   not.
2. User-started provider runs used the legacy execution path and were not
   registered in the SQLite scheduler, so activations could race them.

The corrected implementation now:

- defaults scheduler leases to the provider execution lease instead of 30
  seconds;
- renews the scheduler lease and fence whenever runtime execution ownership is
  renewed;
- registers user/control-plane runs and their source activations in SQLite;
- attaches those activations to the run and consumes them at the terminal
  transition;
- blocks queued activations behind every registered run for that agent;
- includes joined request payloads and terminal update text in the resume
  activation;
- materializes complete V3 audit projections without copying the same handoff
  into provider history;
- tells requesters to consume outbound results rather than attempting an
  unauthorized duplicate update.

## Matched result

| Metric | Live V2 | Fixed V3 | Change |
| --- | ---: | ---: | ---: |
| Grader quality | 42/50 | 42/50 | equal |
| Provider runs | 5 | 4 | 20.0% fewer |
| Total tokens | 2,054,364 | 1,421,700 | 30.8% fewer |
| Uncached input tokens | 249,557 | 149,887 | 39.9% fewer |
| Cached input tokens | 1,787,392 | 1,252,608 | 29.9% fewer |
| Output tokens | 17,415 | 19,205 | 10.3% more |
| Projected API cost | $0.532786 | $0.390378 | 26.7% lower |
| Wall time | 280.790 s | 298.862 s | 6.4% slower |
| Scheduler retry runs | n/a | 0 | clean |
| Scheduler unknown outcomes | n/a | 0 | clean |
| Canonical communication reconciliation | 3 metadata gaps | clean | improved |

Both implementations missed the same grader section: the amendment list
response shape did not match the grader's expected array. That shared defect is
useful control evidence—the communication version changed cost and execution
shape without changing the delivered feature score.

V2 performed an extra eight-second Delivery Lead provider turn after its final
integration run. Fixed V3 completed with exactly the initial lead turn, two
parallel worker turns, and one joined integration turn. Its scheduler recorded
four completed runs, three scheduler-claimed activation runs, zero rejected
dispatches, zero failed runs, and zero unknown outcomes. Dispatch acceptance
latencies were 21, 22, and 26 milliseconds.

## Real-agent reliability observations

- A worker held a live scheduler lease for more than three minutes without
  premature expiry.
- The lead remained waiting after the first worker completed and resumed only
  after the second terminal update satisfied the `all` join.
- The resumed lead received the actual bounded backend/UI reports in the join
  activation; no report lookup or prose classification was required.
- The final V3 project had no missing, duplicate, orphaned, unclassified, or
  metadata-incomplete canonical communication projections.
- The organization finished with no pending activations, active runs, failed
  scheduler runs, or unknown outcomes.

## Final durable-activation smoke

After the matched trial, the final build was deployed to a second fresh V3
data directory and port for a two-agent real-provider smoke. A human message
started the lead, the lead created one indefinite request and `all` join, the
worker changed the repository and completed the request, and the joined result
resumed the lead for verification and commit.

The run confirmed the scheduler state that was added after the matched trial:

- the initial human-message activation was attached to the direct run in
  SQLite, then consumed when that run completed;
- while the join was open, the lead had no active run or actionable activation
  and was reported as waiting;
- the worker's request activation and the lead's satisfied-join activation were
  each claimed exactly once and consumed;
- all three provider runs completed with zero rejected, failed, or
  `outcome_unknown` scheduler runs;
- dispatch acceptance latencies were 21 and 17 milliseconds;
- canonical reconciliation was clean across three events and eight linked
  projections; and
- the lead produced clean commit `b7f5581` with the worker-owned file and no
  duplicate completion update.

## Qualification coverage

Automated tests cover reducer transitions, authorization, independent request
and join deadlines, idempotency, immutable membership, deletion invariants,
outbox reclaim/restart, 409 retry, pre/post-injection crash disposition,
fencing, cancellation, activation coalescing, concurrency, long-running lease
renewal, registered direct-run exclusion, joined outcome payloads, exact V3 tool
surface, API flow, MCP flow, live SSE projections, and canonical audit
reconciliation.

The real-agent result is one matched application-change task, not evidence that
V3 always improves latency or every domain. Additional shapes and non-software
domains should be qualified after review. The feature gate should remain in
place until the reset/cutover procedure is explicitly authorized.

## Preserved evidence

- V2 repo: `/home/phoenix/.ponderosa/workspaces/communication-v2-qualification-20260715`
- Failed V3 repo: `/home/phoenix/khaleel/benchmarks/communication-v3-qualification-20260715/paired/v3/repo`
- Fixed V3 repo: `/home/phoenix/khaleel/benchmarks/communication-v3-qualification-20260715/rerun-v3/repo`
- Final V3 smoke repo: `/home/phoenix/khaleel/benchmarks/communication-v3-qualification-20260715/final-smoke/repo`
- Failed V3 data: `/home/phoenix/.ponderosa-v3-qualification-20260715-r2`
- Fixed V3 data: `/home/phoenix/.ponderosa-v3-qualification-20260715-r3`
- Final V3 smoke data: `/home/phoenix/.ponderosa-v3-final-smoke-20260715`

These artifacts are intentionally retained for review; cleanup requires
separate authorization.
