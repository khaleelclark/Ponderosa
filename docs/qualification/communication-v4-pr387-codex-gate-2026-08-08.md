# Communication V4 PR #387 — Codex merge-gate qualification

Date: 2026-08-08

Provider: Codex, `gpt-5.6-sol`, effort `high` for every created Agent in every arm

Verdict: **PASS, with the sample-size and Run-count qualifications below**

## Decision

The simplified final V4 meets the merge gate on the valid Codex evidence:

- Common-workload quality was 8/8 for V3, early V4, and final V4. There were no provider failures, `outcome_unknown` Runs, or duplicate wakes in any valid common trial.
- Against V3, final V4 used 8.3% fewer provider requests, 11.7% fewer total tokens, 10.3% less summed elapsed time, and 11.9% less summed batch makespan.
- Against early V4, final V4 used 0.9% fewer provider requests, 3.2% fewer total tokens, 14.4% less summed elapsed time, and 16.5% less summed batch makespan.
- All three variants used 30 scheduler Runs/wake-ups for the eight common trials. This qualification therefore demonstrates materially lower provider traffic and tokens than V3, **not fewer Runs**. No unsupported Run-reduction claim is made.
- Final V4 was the only arm to pass the strict rollover-continuity proof. The extra dedicated handoff Run is an explicit reliability cost, not an efficiency win.

The ordinary peer/passive/integration subsets are small and mixed individually. The recommendation rests on equal deterministic quality and reliability, the aggregate common-workload improvement, the large-result transport improvement, the strict rollover fix, and the smaller provider contract. This evidence does not establish statistical significance.

## Exact code points

| Arm | Commit | Meaning |
|---|---|---|
| V3 | `ece5e91a21320f2dfc41413b7738a21cdc5d4a4f` | exact `origin/master` comparator |
| Early V4 | `e502f1388593549989cf0d21c5ccad84d54f2fb3` | prior V4 comparator |
| Final V4 common matrix | `21cacaf138f7d13722ef795c01a179f0d67b041b` | simplified provider surface and automatic result transport |
| Final V4 strict rollover | `45af7ac3091185e1efb16e2dcc38baff03dc5a67` | same final arm plus the affected-only safe-boundary handoff correction |

The final rollover correction was rerun only for the affected rollover arm. It does not change ordinary coordination or result transport.

## Method

The retained three-arm harness was adapted only for commit/transport compatibility. It ran arms sequentially, rotated arm order between repetitions, and used identical prompts, roles, organization shapes, ordering, model, and effort. The valid matrix contains:

- three peer/fan-in repetitions;
- two realistic code-integration/Join repetitions, including execution of the produced JavaScript behavior;
- two passive targeted `next_run` repetitions, with the predeclared normalized immediate V3 control;
- one 17 KB correlated child-result integration per arm, checking beginning/middle/end sentinels and SHA-256;
- one strict rollover-continuity probe per arm.

Quality predicates were arm-independent and did not use the variant identity. They checked exact required facts, executable behavior, content sentinels/digest, or durable rollover state rather than style. Telemetry comes from the authoritative scheduler database and provider request-usage records. `provider requests` is the number of entries in `runs.provider_request_usage_json`; `wake-ups` is scheduler Runs; duplicate wakes means an Activation attached to more than one distinct scheduler Run. Batch makespan is latest completion minus earliest start for a trial.

## Common-workload aggregate

These totals include peer (3), passive (2), integration (2), and large-result (1): eight trials per variant.

| Variant | Quality | Runs / wakes | Provider requests | Input | Cached input | Output | Reasoning | Total tokens | Elapsed sum | Makespan sum | Fail / unknown / dup |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| V3 | 8/8 | 30 / 30 | 121 | 2,562,200 | 1,983,488 | 26,358 | 11,362 | 2,588,558 | 930,122 ms | 818,413 ms | 0 / 0 / 0 |
| Early V4 | 8/8 | 30 / 30 | 112 | 2,338,464 | 1,749,504 | 22,951 | 8,777 | 2,361,415 | 975,404 ms | 863,372 ms | 0 / 0 / 0 |
| Final V4 | 8/8 | 30 / 30 | 111 | 2,267,010 | 1,838,080 | 19,336 | 7,044 | 2,286,346 | 834,463 ms | 721,110 ms | 0 / 0 / 0 |

Token columns retain the provider's reporting semantics: cached input and reasoning are reported subcategories, while the recorded total is input plus output.

## Scenario totals and variance warning

| Scenario (repetitions) | Variant | Runs | Requests | Total tokens | Elapsed sum | Makespan sum | Quality |
|---|---|---:|---:|---:|---:|---:|---:|
| Peer (3) | V3 | 15 | 50 | 1,048,904 | 361,608 ms | 323,107 ms | 3/3 |
|  | Early V4 | 15 | 40 | 800,431 | 324,814 ms | 286,740 ms | 3/3 |
|  | Final V4 | 15 | 42 | 840,393 | 307,486 ms | 268,285 ms | 3/3 |
| Passive (2) | V3 normalized control | 4 | 18 | 366,718 | 149,538 ms | 124,213 ms | 2/2 |
|  | Early V4 | 4 | 16 | 306,366 | 191,875 ms | 166,149 ms | 2/2 |
|  | Final V4 | 4 | 18 | 347,400 | 171,763 ms | 145,560 ms | 2/2 |
| Code integration (2) | V3 | 8 | 37 | 794,767 | 257,120 ms | 225,482 ms | 2/2 |
|  | Early V4 | 8 | 38 | 788,042 | 283,535 ms | 251,612 ms | 2/2 |
|  | Final V4 | 8 | 39 | 803,730 | 243,933 ms | 211,574 ms | 2/2 |
| Large result (1) | V3 | 3 | 16 | 378,169 | 161,856 ms | 145,611 ms | 1/1 |
|  | Early V4 | 3 | 18 | 466,576 | 175,180 ms | 158,871 ms | 1/1 |
|  | Final V4 | 3 | 12 | 294,823 | 111,281 ms | 95,691 ms | 1/1 |

The peer/passive/integration differences are directional observations only. For example, final V4 used 5.0% more peer tokens than early V4 and 2.0% more integration tokens, but completed those subsets 5.3% and 14.0% faster respectively. Two or three repetitions cannot distinguish normal provider variance from a stable per-scenario effect.

Passive V4 is added capability: delivery remained dormant until the next ordinary trigger, whereas the V3 control delivered immediately by design. It is not credited as a V3 efficiency defect. The large-result result is both capability and transport evidence: final V4 automatically injected the complete correlated result without a retrieval tool, preserved all checked content, and used 22.0% fewer tokens than V3 and 36.8% fewer than early V4 in this single trial.

## Strict rollover-continuity proof

| Variant | Strict quality | Runs | Requests | Total tokens | Elapsed | Run failures | Durable result |
|---|---:|---:|---:|---:|---:|---:|---|
| V3 | 0/1 | 8 | 26 | 1,154,341 | 302,917 ms | 0 | rollover row completed, but no session-generation change, handoff consumption, or handoff manifest |
| Early V4 | 0/1 | 6 | 24 | 1,209,300 | 228,486 ms | 1 | same-Run handoff was rejected and never committed |
| Final V4 | 1/1 | 9 | 32 | 1,371,628 | 336,569 ms | 0 | completed rollover, one consumption, new provider session, manifest source, reduced context, fact retained, no stale replay |

Final V4's proof observed:

- old provider session `019fdfd4-a764-7941-968f-8eb70182e687`, peak recorded occupancy 83,417 tokens;
- one completed durable rollover and continuation handoff;
- handoff consumed exactly once by execution `55035c8a...`;
- new provider session `019fdfd8-7a8a-7fa0-a62f-e3e426e50e86`;
- first post-rollover occupancy 19,560 tokens, a 63,857-token reduction from the observed peak;
- exact provider-input manifest containing `continuation_handoff`;
- retained verification fact on the fresh session and no stale handoff on the subsequent ordinary Run.

The initial final probe that merely retained a fact while context grew to about 85K was rejected as insufficient. Development probes r1–r4 are excluded. The corrected implementation uses a dedicated handoff-only Run at a safe boundary on the retained old session, validates required semantic sections with a bounded 150–500-word envelope, commits the handoff, retires the session, and consumes the handoff idempotently on the first compatible fresh Run. The one-Run rollover cost is accepted because it converts an unproven/broken lifecycle into a durable transition.

## Provider surface and product tradeoffs

| Variant | Provider tools | Tool-schema bytes | Communication prompt bytes |
|---|---:|---:|---:|
| V3 | 18 | 20,919 | 3,001 |
| Early V4 | 16 | 20,427 | 3,089 |
| Final V4 | 14 | 18,182 | 2,710 |

Final V4 exposes only the intended communication tools: `ponderosa_coordinate`, `ponderosa_update_request`, and `ponderosa_message`. It has no Board, Wake, provider `ponderosa_context`, provider `ponderosa_result`, provider docs, or provider-callable rollover surface. Full correlated results are injected automatically. Results beyond the hard 256 KiB prompt packet are retained losslessly through a validated Run-scoped local artifact path that existing provider file access can inspect; missing or changed artifacts fail closed rather than truncating semantic content.

This intentionally removes deep-history provider retrieval for this PR. Canonical historical messages remain durable for a future scoped RAG replacement, but no replacement is claimed or built here.

## Exclusions

- The original concurrent Codex triplet is invalid external-quota evidence and is excluded in full. Its retained logs show `Codex usage limit until 2026-08-08 03:35 UTC` under `data/early`, `data/final`, and `data/v3`.
- All `claude-*` evidence is retained but excluded by the operator's Codex-only override.
- Rollover probes r1–r4 are development evidence only: they used insufficient pressure or pre-correction behavior and are not averaged.
- No valid current Codex block had a quota or provider-boundary error.

## Reproducibility and raw evidence

The retained harness, raw logs, isolated SQLite stores, per-trial JSON, and aggregate are under:

`/home/phoenix/qualifications/ponderosa-v4-pr387-gate-20260807`

Key files:

- `harness/communication-v4-merge-gate.mjs`
- `run-isolated-arm.mjs`
- `reconcile-rollover-evidence.mjs`
- `aggregate-codex-evidence.mjs`
- `evidence/codex-valid-matrix-aggregate.json`
- `evidence/codex-rollover-r5-final-strict.json`
- `evidence/codex-rollover-r5-v3-strict.json`
- `raw/` and `data/`

The aggregate JSON preserves per-trial provider dispositions, usage categories, latency, makespan, outcomes, quality predicates, project IDs, and evidence paths. The early V4 rollover failure is preserved in its raw log and SQLite store even though the harness stopped immediately after the terminal failure.

## Release validation

- `origin/master` remained exactly `ece5e91a21320f2dfc41413b7738a21cdc5d4a4f` on 2026-08-08 and is an ancestor of the final branch.
- `pnpm --filter @ponderosa/server typecheck` passed.
- `pnpm build` passed for all workspace packages.
- Root `pnpm typecheck` passed every package reached except the unchanged web error at `apps/web/src/components/decisions/RuntimeElicitationActions.tsx:77` (`string` versus the `FormField` literal union). That file has no diff from `origin/master`; the error is outside this PR.
- The seven retained packaging qualification files ran 25 tests: 24 passed and one unchanged symlink-portability fixture failed because its synthetic bundle lacks `app/engine-desktop`. The same failure reproduced on the exact V3/master snapshot, and the guard plus `packaging/package-beta.mjs` have no diff from `origin/master`.
- `git diff --check` passed.
- Source searches found no provider registration or prompt residue for `ponderosa_context`, `ponderosa_result`, `ponderosa_docs`, or `ponderosa_rollover` in server/core/engine source.

Per operator direction, the intentional product-test deletion at branch commit `5226583c` was preserved. No product tests were restored, recreated, or added, and the seven release-engineering guards were not modified.

## Merge-gate conclusion

Recommend merging PR #387 after the remaining repository release checks and independent review complete. The measured claim is bounded: final V4 preserves common-workload quality and reliability, materially lowers provider requests/tokens versus V3, is aggregate-equal-or-better than early V4, improves full-result transport, and uniquely proves durable rollover continuity. It does not reduce common-workload scheduler Run count in this matrix, and no result here should be presented as statistically significant.
