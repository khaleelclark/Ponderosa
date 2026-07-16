# Communication V3 qualification — 2026-07-15

## Decision

Communication V3 is deployed, and V3.1 removes the remaining executable V2
scheduler compatibility layer. V3 consistently removes unnecessary execution
turns and closes the scheduler crash windows exercised here. The expanded reruns
do **not** prove a stable total-cost or wall-time advantage: provider behavior
inside the same four-run execution shape varied enough to reverse those metrics.
The evidence supports reliability and execution-shape improvements; cost and
latency remain workload- and provider-dependent hypotheses.

The comparisons below are retained historical qualification evidence. Their
isolated data directories, ports, feature flags, and V2 service descriptions do
not describe the current executable product.

## Controlled setup

- Machine: Pine, so both conditions shared provider latency and host load.
- V2: deployed Ponderosa at `127.0.0.1:8787`.
- V3: isolated historical worktree/service at `127.0.0.1:19818`; at the time,
  the now-removed `PONDEROSA_COMMUNICATION_VERSION=3` flag selected it.
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

## Universal-model reruns and final refinements

After the original matched result, the scheduler was made authoritative for
every actionable cause and the same repository tree, prompt, organization, model,
effort, grader, and Pine host were rerun repeatedly. These later trials were
failure-finding runs rather than independent statistical samples; each run
informed the next implementation.

| Trial | Quality | Runs | Tokens | Cost | Wall time | Observation |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Live V2 control | 42/50 | 5 | 2,054,364 | $0.532786 | 280.790 s | preserved baseline |
| V3 R5 | 42/50 | 4 | 2,541,966 | $0.576428 | 345.714 s | redundant equivalent join was coalesced into one run but duplicated prompt material |
| V3 R6 | 42/50 | 4 | 1,718,564 | $0.478014 | 292.403 s | one canonical join; 16.4% fewer tokens and 10.3% lower cost than V2 |
| V3 R7 | 42/50 | 6 | 2,395,772 | $0.539321 | 320.493 s | no-join consultation was answered with the wrong update kind, adding two runs and one request-level `outcome_unknown` |
| V3 R8 | 42/50 | 4 | 2,083,469 | $0.558968 | 376.541 s | clean protocol shape; a long integration turn dominated cost and latency |

R5 exposed that a provider can create the same immutable join twice under
different idempotency keys. Open joins now have a canonical definition hash over
owner, mode, outcomes, deadline, and sorted membership, so equivalent conditions
return the existing join. Same-call recipient IDs accidentally supplied as join
request IDs are normalized only when they unambiguously name the new recipients;
all other foreign or unknown IDs still fail closed.

R7 exercised a legitimate asynchronous consultation: an agent created a request
without a join and continued working. The recipient then mistook the inbound
request for an `answer` update instead of completing the consultation. Tool and
activation contracts now say explicitly that a recipient replies to the request
itself with `completed`; `question` is a recipient's blocking follow-up and
`answer` is only the original requester's correlated response to that question.

R8 restored the ideal four-run shape with one human activation, two parallel
request activations, and one satisfied-join activation. It had one join, zero
failed or unknown scheduler runs, zero pending activations, and no duplicate join
wake. Its cost regression despite the cleanest protocol trace is important:
removing coordination waste does not bound the amount of application inspection
and integration a provider chooses to perform. The final generic prompt asks for
targeted, bounded artifact reads and one verification pass, but further
application-specific prompt tuning would overfit this benchmark.

Across these reruns, scheduler dispatch acceptance remained 16–39 ms and the
protocol-correct trials always used four runs instead of V2's five. End-to-end
tokens, cost, and time did not move monotonically. A larger preregistered sample
is required before claiming average savings.

## No-join consultation smoke

The final build was also exercised in a focused two-agent real-provider test.
The requester created an indefinite consultation without a join, inspected an
unrelated artifact, and ended its turn. The consultant received the request and
completed it with `ALPINE`; that terminal no-join outcome activated the requester,
which wrote `consultation.txt` with exactly `ALPINE\n` and committed `e1f1a4d`.

The smoke completed in exactly three scheduler runs with one consumed human
activation, one consumed request activation, one consumed outcome activation,
zero failed/unknown runs, and request state `completed`. This directly validates
correlated work that continues without waiting and the corrected consultation
update contract.

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

## V3.1 nested-organization qualification

A later matched trial compared deployed V3 at `127.0.0.1:19860` with an
isolated V3.1 candidate at `127.0.0.1:19861`. Both used separate data and
repository roots on Pine. The organization was deliberately nested:
Organization Architect → Portfolio Delivery Owner → parallel Quantitative
Modeler and Risk & Strategy Reviewer. The follow-up changed the portfolio's
budget and six constraints while requiring new artifacts and preservation of
the original result.

The trial exposed the source of the apparent V3 organization regression. When
the Delivery Owner created its specialist join and ended its current Run, V3
marked the still-open inbound delivery request `outcome_unknown`. That made the
architect's outer join impossible and woke it before delivery integration was
finished. Completion of the specialist join later resumed delivery, and its
late result caused another architect Run. V3 therefore executed seven provider
turns and ran two logically dependent stages concurrently.

V3.1 records the inbound delivery request as a durable continuation of the
specialist join. Join creation moved the request to `waiting_dependency`; the
first delivery Run ended without an unknown outcome; the satisfied inner join
reattached the request to the resumed delivery Run; and only its terminal
update resolved the architect's outer join. Exact equivalent joins were also
deduplicated after satisfaction or impossibility, preventing a second wake for
an immutable condition.

| Follow-up metric | Deployed V3 | V3.1 candidate | Change |
| --- | ---: | ---: | ---: |
| Deterministic artifact quality | 100/100 | 100/100 | equal |
| Provider turns | 7 | 6 | 14.3% fewer |
| Provider requests | 30 | 28 | 6.7% fewer |
| Total tokens | 1,371,375 | 675,037 | 50.8% fewer |
| Input tokens | 1,351,263 | 656,637 | 51.4% fewer |
| Cached input tokens | 1,243,136 | 556,800 | 55.2% fewer |
| Output tokens | 20,112 | 18,400 | 8.5% fewer |
| Projected API cost | $0.526102 | $0.451275 | 14.2% lower |
| First start to last completion | 314.745 s | 340.450 s | 8.2% slower |
| Request-level unknown outcomes | 1 | 0 | eliminated |

V3.1 rolled the provider cache at the three new recipient-request boundaries
(Delivery Owner and two specialists), while the architect's human continuation
and both join resumptions retained their causal sessions. Fresh-task request
Activations are now incompatible with continuity Activations for coalescing,
so a simultaneous human message cannot make that cache decision ambiguous.

The wall-time regression is real but is not an execution-quality win for V3:
its architect woke and finished once before delivery, then woke again after the
late result. V3.1 preserved the required dependency order, so its final
architect turn necessarily followed delivery. This sample supports a strong
token/cost and reliability improvement, not a universal latency claim.

Both provider sandboxes produced the requested artifacts but could not create
`.git/index.lock`. V3.1 accurately reported its delivery request as `failed`;
V3 lost the parent request before that report could be correlated. The grader
measures the repository artifacts and awarded both 100/100. This shared host
constraint is retained in the evidence rather than counted as a communication
success.

The same candidate also fixed a V3 intake defect reproduced by the control:
an actionable organization-shared human message was committed and scheduled,
then returned HTTP 500 while projecting its audit copy. V3.1 records the
canonical run-trigger edge before projection and returns the committed result
normally, preventing clients from retrying already accepted work.

Preserved evidence:

- Trial root: `/home/phoenix/khaleel/benchmarks/v31-context-20260715`
- V3 data: `/home/phoenix/.ponderosa-v31-compare-v3-20260715`
- V3.1 data: `/home/phoenix/.ponderosa-v31-compare-v31-20260715`
- Matched metrics: `followup-metrics.json` under the trial root

## Matched V2 versus V3.1 application-change trial

A clean two-phase trial then compared V2 with the corrected V3.1 branch on
Pine. Both conditions used byte-identical repositories, four-agent nested
organizations, models, efforts, task contracts, grader, host, and launch
window. The common user prompt described delegation and waiting behavior but
did not name either protocol's tools. The initial phase built the portfolio;
the follow-up changed the budget and six constraints while preserving the
initial artifacts.

The first comparison attempt found one additional V3.1 failure boundary. A
resumed delivery Run sent its acceptance evidence as an ordinary message
instead of terminally updating its suspended parent request. The continuation
therefore remained `waiting_dependency` with no Run or actionable Activation.
V3.1 now includes the complete continuation request and explicit update
obligation in the join Activation. If a resumed Run still ends without a
terminal update, the supervisor transitions the continuation to
`outcome_unknown` and reevaluates its outer join; it can no longer deadlock.
Automated coverage exercises both successful completion and this fail-closed
path.

A second attempt correctly stopped in `waiting_dependency` because the task
required a Git commit while both provider sandboxes mounted `.git` read-only.
The final matched task removed only that impossible host operation; all
portfolio constraints, artifacts, agent roles, and grading remained unchanged.

### Initial build

| Metric | V2 | V3.1 | V3.1 change |
| --- | ---: | ---: | ---: |
| Deterministic quality | 100/100 | 100/100 | equal |
| Provider turns | 8 | 6 | 25.0% fewer |
| Provider requests | 44 | 33 | 25.0% fewer |
| Total tokens | 895,956 | 652,098 | 27.2% fewer |
| Projected API cost | $0.475951 | $0.547787 | 15.1% higher |
| First start to last completion | 352.684 s | 320.334 s | 9.2% faster |

### Follow-up application change

| Metric | V2 | V3.1 | V3.1 change |
| --- | ---: | ---: | ---: |
| Deterministic quality | 100/100 | 100/100 | equal |
| Provider turns | 8 | 6 | 25.0% fewer |
| Provider requests | 33 | 33 | equal |
| Total tokens | 1,153,525 | 772,404 | 33.0% fewer |
| Projected API cost | $0.444705 | $0.435213 | 2.1% lower |
| First start to last completion | 375.900 s | 322.786 s | 14.1% faster |

Across both phases, V3.1 used 12 turns instead of 16, 66 provider requests
instead of 77, and 1,424,502 tokens instead of 2,049,481. It finished each
phase faster and used 30.5% fewer total tokens. Cumulative projected cost was
$0.983000 versus V2's $0.920656, or 6.8% higher: request-boundary session resets
reduced accumulated context but also reduced discounted cache reuse. The
follow-up alone crossed into a small cost advantage. These results support a
repeatable execution-shape, token, and latency improvement; they do not support
a universal cost-savings claim.

V2's two extra turns in each phase were duplicate report wakes: delivery and
the architect each ran once for `wait_satisfied` and again when the same result
arrived as ordinary collaboration. V3.1 represented every dependency with one
correlated request and join, producing the intended six-turn shape. Its six
requests completed, four joins satisfied, and no request, join, or scheduler
Run ended unknown. V2 recorded four recoverable tool errors; V3.1 recorded one
recoverable malformed join attempt. Neither condition had an engine failure.

Preserved evidence:

- Final matched trial: `/home/phoenix/khaleel/benchmarks/v2-v31-r3-20260715`
- V2 data: `/home/phoenix/.ponderosa-v2-v31-r3-v2-20260715`
- V3.1 data: `/home/phoenix/.ponderosa-v2-v31-r3-v31-20260715`
- Failure-finding trials: `/home/phoenix/khaleel/benchmarks/v2-v31-20260715`
  and `/home/phoenix/khaleel/benchmarks/v2-v31-r2-20260715`

## Post-outcome duplicate-wake optimization

The eight-pair preregistered comparison subsequently found three avoidable
V3.1 turns. In those traces, a recipient terminally updated its correlated
Request and then sent the same requester an ordinary Collaboration message.
The Request or Join had already created the authoritative wake, so the message
created a second `ordinary_message` Activation after the intended continuation.

V3.1 now recognizes this case by durable causality rather than prose: the
message sender must be the recipient of a Request attached to the current Run,
and that exact provider execution must already have authored a terminal update.
The complete communication and projections remain durable, but an ordinary
copy to that requester is passive. Suppression is recipient-specific, so other
recipients remain actionable. Explicit `urgency: "urgent"` remains actionable
for a genuinely material correction.

A fresh matched two-phase real-agent run exercised the rule directly. During
the follow-up, the Quantitative Modeler completed its Request and then sent a
correction/clarification to the Delivery Owner. SQLite recorded the complete
message with `actionable = 0`; it created no `ordinary_message` Activation.
V3.1 completed in the intended six-turn shape in both phases, with exactly two
human, six request, and four satisfied-join Activations across the run.

| Cumulative two-phase metric | V2 | Patched V3.1 | Change |
| --- | ---: | ---: | ---: |
| Deterministic quality | 200/200 | 198/200 | one memo evidence signal missed |
| Provider turns | 15 | 12 | 20.0% fewer |
| Total tokens | 1,969,319 | 1,825,347 | 7.3% fewer |
| Projected API cost | $0.946369 | $0.987895 | 4.4% higher |
| Failed scheduler Runs | n/a | 0 | clean |
| Unknown scheduler outcomes | n/a | 0 | clean |

The initial phase was 667.322 seconds for V3.1 versus 454.881 seconds for V2;
the follow-up was 289.012 seconds versus 369.036 seconds. This reinforces the
earlier conclusion: execution shape and reliability improved, while total cost
and latency remain provider-dependent. The V3.1 follow-up allocation was
feasible and exactly optimal; its two-point grading miss was confined to one of
six memo evidence signals.

This post-fix pair is regression evidence for the mechanism, not a new
significance claim. The preceding eight matched pairs remain the statistical
result: V3.1 used 99 turns versus 128 for V2 (22.7% fewer, exact paired
`p = 0.03125`) and 37.3% fewer tokens (`p = 0.03125`), while cost and wall-time
differences were not significant. Removing the three diagnosed duplicate wakes
should improve the execution shape, but that adjusted effect must not be called
statistical until another preregistered sample is run.

Preserved post-fix evidence:

- Trial and metrics: `/home/phoenix/khaleel/benchmarks/v2-v31-post-outcome-20260715`
- V3.1 SQLite authority: `data/replicate-01/v31/ponderosa.db` under that root

## Qualification coverage

Automated tests cover reducer transitions, authorization, independent request
and join deadlines, idempotency, immutable membership, deletion invariants,
outbox reclaim/restart, 409 retry, pre/post-injection crash disposition,
fencing, cancellation, activation coalescing, concurrency, long-running lease
renewal, registered direct-run exclusion, joined outcome payloads, exact V3 tool
surface, same-execution passive outcome copies, API flow, MCP flow, live SSE
projections, and canonical audit reconciliation.

The real-agent result is one matched application-change task, not evidence that
V3 always improves latency or every domain. Additional shapes and non-software
domains should be qualified after review. The later cutover made V3
unconditional and removed the feature gate; new qualification must use isolated
fresh data rather than legacy scheduler replay.

## Preserved evidence

- V2 repo: `/home/phoenix/.ponderosa/workspaces/communication-v2-qualification-20260715`
- Failed V3 repo: `/home/phoenix/khaleel/benchmarks/communication-v3-qualification-20260715/paired/v3/repo`
- Fixed V3 repo: `/home/phoenix/khaleel/benchmarks/communication-v3-qualification-20260715/rerun-v3/repo`
- Final V3 smoke repo: `/home/phoenix/khaleel/benchmarks/communication-v3-qualification-20260715/final-smoke/repo`
- V3 R5–R8 repos: `/home/phoenix/khaleel/benchmarks/communication-v3-qualification-20260715/final-v3-r5/repo` through `final-v3-r8/repo`
- No-join consultation repo: `/home/phoenix/khaleel/benchmarks/communication-v3-qualification-20260715/no-join-consultation-smoke/repo`
- Failed V3 data: `/home/phoenix/.ponderosa-v3-qualification-20260715-r2`
- Fixed V3 data: `/home/phoenix/.ponderosa-v3-qualification-20260715-r3`
- Final V3 smoke data: `/home/phoenix/.ponderosa-v3-final-smoke-20260715`
- V3 R5–R8 data: `/home/phoenix/.ponderosa-v3-final-r5-qualification-20260715` through `/home/phoenix/.ponderosa-v3-final-r8-qualification-20260715`
- No-join consultation data: `/home/phoenix/.ponderosa-v3-no-join-consultation-smoke-20260715`

These artifacts are intentionally retained for review; cleanup requires
separate authorization.
