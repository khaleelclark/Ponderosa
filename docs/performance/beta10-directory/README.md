# Beta 10 directory performance qualification

## Scope and release status

Base: `c129f1f9962b289c6d56ee603bd26eb28fa2c0f8`, the current Beta 10 reference on Pine. Branch: `perf/beta10-directory-refresh`. Writer: this Codex task. Worktree: `/home/phoenix/ponderosa-project-rail-runtime/worktrees/beta10-directory-refresh`.

Deployment and merge remain pending approval. This is a stacked PR against `fix/beta10-attachment-preview`, which is the exact approved base. At review preparation, `origin/master` was an ancestor of the base (107 commits behind it); unrelated pending Beta 10 work is not included in this patch.

## Root causes and changes

1. Ordinary Agent-directory requests calculated detailed health for every visible workspace Agent before selecting a page. They now select/count/filter/page first, then calculate health for returned rows, including independently returned stars. Lightweight Project roster identities preserve off-page parent/child relationships.
2. Health loaded complete coordination snapshots merely to obtain active Runs. A narrow `activeAgentRun` read is shared with the existing snapshot implementation, avoiding request/join/activation hydration and duplicate availability calculations. No cross-request health cache was added.
3. Workspace events immediately refetched all Agent directories, then phase reconciliation fetched them again. The post-boundary freshness reconciler now owns those refetches, coalesces bursts in its existing 250 ms window, and limits them to affected Project/global queries. Pending boundaries survive overlapping events; removed queries cannot keep reconciliation pending. Cancellation, commands, failures, and decisions still require fresh canonical evidence.
4. Notification read/acknowledgement changes no longer invalidate Agent health. Decision events carry authoritative Project IDs; older Decision envelopes without that field safely fall back to global reconciliation. Other directory mutations use a scoped, fixed-window batch rather than per-event global refetches.
5. Inactive sidebar collections now request `summary=true`: counts without row DTOs. The active Project count uses Project-scoped operational health without historical Run hydration. The visible section still requests ordinary rows. Summary and full-list query identities/placeholder scopes are separate.

Canonical active/outcome list views retain workspace-wide filtering, ordering, active counts, the global top-100 outcome selection, cursor freshness, and pagination. Ordinary list responses no longer calculate the optional workspace-wide `activeCount`; its UI consumer uses the canonical active view. Project summaries use their scoped `total`. No UI layout, composer implementation, routing, authored communication, delivery, authorization, or attachment durability code changed.

## Measurement method

All measurements used disposable loopback-only servers on port 21843, Node 24.16.0, production-built assets, and no provider registrations or real Agent execution. Live reference/dev services were not restarted or used as benchmark targets.

Both builds used the same small fixture recipe: **3 Projects, 36 Agents, 12 Chats** (9 explicitly seeded Chats plus 3 automatically created default Chats), initially idle and empty. IDs and storage roots were freshly generated for each run. The original baseline JSON's `chats: 9` field counts only explicitly seeded Chats; this metadata omission is noted here rather than altering the captured results.

HTTP distributions: 30 sequential requests per view, including the first request. Browser workload: two independent Chromium contexts at 1440×1000, displaying Chats in different Projects; ten one-second cycles of three Project A coordination events plus one notification-read event, followed by two seconds to settle. Events in this measurement are synthetic browser-side SSE envelopes; all resulting queries hit the real sandbox server. Separate live qualification used a real canonical Decision response and real SSE.

Navigation milestone is **sidebar `All Chats` visible**, not complete composer readiness. Browser main-thread figures are CDP metric deltas across the event workload. These small samples demonstrate this bottleneck; they are not production-scale benchmarks or statistical guarantees.

## Results

| Measurement | Baseline | Candidate |
|---|---:|---:|
| Agent-directory requests, both clients | 202 | 20 |
| Project B Agent-directory requests caused by Project A workload | 100 | 0 |
| Ordinary scoped 5-row request p50 / p95 / max, ms | 21.98 / 26.46 / 39.70 | 4.81 / 8.70 / 28.58 |
| Global active request p50 / p95, ms | 19.01 / 19.95 | 13.67 / 19.22 |
| Global outcomes request p50 / p95, ms | 19.22 / 25.88 | 13.59 / 19.05 |
| Conversation request p50, ms | 1.13 | 1.09 |
| Browser A ordinary Agent request p50 / p95, ms | 189.96 / 362.13 | 7.44 / 13.36 (count summary) |
| Browser A active Agent request p50 / p95, ms | 124.52 / 313.96 | 9.97 / 18.17 (count summary) |
| Combined browser main-thread TaskDuration, seconds | 2.94 | 1.91 |
| Combined browser ScriptDuration, seconds | 2.61 | 1.78 |
| Initial sidebar navigation A / B, ms | 284 / 236 | 259 / 250 |
| Repeat sidebar navigation A / B, ms | 154 / 160 | 163 / 171 |

Approximately **90% fewer Agent-directory requests**, **78% lower ordinary-request median**, and **35% less combined main-thread task time** in this workload. Two baseline requests were settling requests in addition to the 200 burst-driven requests. Neither run recorded layout/style work in the sampled steady-state CDP deltas. Buffered long-task observations included one initial-load task per client: baseline 114/91 ms, candidate 96/94 ms. There is **no demonstrated initial/repeat navigation improvement**.

Full request distributions and counts are in the adjacent baseline/candidate JSON files.

## Send/upload investigation — no path changes

Matched fresh-fixture samples used 12 passive 2 KiB Broadcast sends and 12 approximately 264 KiB text uploads per condition. Uploads were deleted through the normal endpoint after completion. The loaded condition used two continuous global active-directory request loops. No Agents were activated and no provider requests were made.

| Condition / operation | Baseline p50 / p95, ms | Candidate p50 / p95, ms |
|---|---:|---:|
| Idle send | 9.55 / 46.43 | 8.64 / 44.68 |
| Idle upload | 3.19 / 6.47 | 3.61 / 6.84 |
| Loaded send | 46.79 / 71.71 | 41.96 / 54.99 |
| Loaded upload | 359.99 / 388.29 | 255.11 / 298.51 |

The 1–3 second production symptom was **not reproduced**. An additional baseline profiling pass captured the existing `Server-Timing` phases: canonical append/projection dominated handler time, while client-observed loaded latency was appreciably larger than handler time. That extra pass had accumulated additional disposable messages and is diagnostic, not a matched comparison. Directory contention contributes to latency, but these observations do not establish the full cause of the reported slow requests. Durability, authorization, validation, and delivery guarantees were not weakened.

## Verification

- Full workspace typecheck and production build passed using Node 24.16.0. Final web typecheck/build repeated after the last reconciliation changes.
- 71 focused server checks passed: directory ownership, scoped/global counts, canonical active/outcome paging and stale cursors, bounded page health, stars, off-page hierarchy, summary freshness, stopping/stalled/expired-lease states, failed outcomes, Decisions, draft behavior, and communication delivery scope.
- 173 web regression checks passed, including Project query isolation and summary/full-page placeholder separation.
- Real-browser qualification passed: Agent search/clear, Project switching with a rendered composer, sidebar count-only fetches while Chats is visible, real Decision-response SSE reconciliation, and an unrelated open client making no Agent-directory request for that Decision. Screenshot inspected with the expected Chats/Agents/Automation counts and unchanged composer layout.
- The first added server fixture omitted a required Chat and was corrected; the first live script used an ambiguous `Search chats` locator and was corrected. Both were harness failures, not suppressed product failures.
- Initial dependency installation selected the shell's Node 22 native SQLite build. The sandbox's native dependencies were rebuilt for the required Node 24 before any successful baseline measurement.

Not established: typing-specific lag, authenticated real-provider execution under load, production-sized behavior, or a complete explanation for 1–3 second send/upload outliers. Global canonical health views still scale with workspace size by design to preserve their existing semantics; future optimization must retain those guarantees.

## Reproduction

Use a separate worktree at the base or candidate, Node 24, and existing repository dependencies. Do not point the harness at live data. The sandbox always creates a new temporary data root; it binds only loopback. Ensure port 21843 and `/tmp/ponderosa-perf-sandbox.json` are reserved for your disposable run.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
node apps/server/test/performance-sandbox.mjs
```

In another terminal, run the browser and send/upload scripts. For baseline, use these same harness scripts with base production assets/code. Playwright is diagnostic tooling, not a new application dependency: `PLAYWRIGHT_PACKAGE` can point to the package.json of an existing installation; `CHROMIUM_PATH` can select an existing browser executable.

```sh
node apps/server/test/performance-browser.mjs candidate
node apps/server/test/performance-send-upload.mjs candidate
```

For the separate live check, stop only that sandbox, start a fresh one with `PERF_QUALIFY=1`, and run `performance-live-qualification.mjs`. Preserve evidence before cleanup. Terminate the exact sandbox PID recorded in its manifest and remove only its newly created data root. Do not delete the branch/worktree until merged and released.
