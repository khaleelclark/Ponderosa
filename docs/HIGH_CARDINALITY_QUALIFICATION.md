# High-cardinality performance qualification

## Scope

This qualification exercises Ponderosa with a deliberately provider-free dataset:

- 250 Projects;
- 1,002 Chats in the target Project (1,251 total because every other Project has its default Chat);
- 1,000 idle Agents;
- 1,000 disabled Triggers;
- 1,250 passive communication messages;
- no Agent Runs.

The checked-in generator and benchmark live in `tools/high-cardinality/`. The benchmark copies the immutable fixture before every run, starts a private server on a loopback port, performs the workload, records authoritative activation and Run counts, and terminates the server. It never points at production data.

Qualification host:

- AMD Ryzen 5 5500, 12 logical CPUs;
- 32 GB RAM;
- Linux host `pine`.

## Root causes

The audit found four multiplicative paths:

1. Projection recovery committed each replayed row independently. At 250 Projects and thousands of projected records, synchronous SQLite commit overhead dominated cold startup.
2. Trigger CRUD refreshed every Trigger source in the Project. Mutating one disabled Trigger therefore revalidated and rebuilt approximately 1,000 unrelated definitions.
3. Passive message intake performed full historical idempotency lookup even when the canonical append was not a replay.
4. Project, Chat, Agent, membership, and Trigger lists hydrated entire collections before slicing. Their JSON payloads and object allocation grew linearly with total cardinality.

A fifth issue was client-side: collapsed long messages still mounted their complete Markdown tree.

## Implemented behavior

### Startup and readiness

Projection recovery remains deterministic and authoritative, but executes in one SQLite transaction. The server records Store open, component construction, projection recovery, lifecycle phase, and total readiness durations. Runtime communication projection reconciliation remains exact and runs after readiness while yielding between records so ordinary requests can proceed.

`GET /api/ready` is a bounded operational check. `GET /api/diagnostics/ready` exposes the deeper diagnostic state. Startup no longer waits for an all-Project orphan-asset scan; the existing periodic maintenance path performs that work.

### Mutation paths

Trigger create, update, enable, disable, and delete apply an incremental source change. A disabled webhook or schedule Trigger does not rebuild unrelated source state. Filesystem source refreshes remain serialized per Project because watcher replacement is stateful.

Passive messages perform historical replay lookup only when the canonical intake reports an idempotent replay. New passive messages preserve the append-only communication path and create no activation or Run.

### Bounded reads

Collection endpoints query SQLite for total count and page IDs before hydrating records. Cursor tokens are scoped to the collection and search input. Limits are capped at 100.

Bounded behavior covers:

- Projects;
- Project Chats;
- Project Agents;
- Agent memberships;
- team directory membership;
- Triggers;
- workspace directory Project, Chat, Agent, and Trigger resources.

Server-side search and incremental loading remain available to the existing workspace resource views. The lightweight Chat detail contains only its first membership page and advertises the count/cursor for further retrieval.

### Long messages

Collapsed long messages mount a bounded 3,200-code-point, 36-line preview. Expansion mounts the full Markdown tree. Unicode truncation operates on code points rather than splitting surrogate pairs.

## Before and after

The mutation tests issue 20 concurrent operations. The mixed test issues 30 concurrent readiness, Agent-directory, and Chat-detail reads. Durations are milliseconds.

| Measurement | Before p50 | Before p95 | Before max | After p50 | After p95 | After max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Health | 0 | 10 | 10 | 244.68 | 260.17 | 403.37 |
| Readiness | 6 | 104 | 104 | 3.59 | 404.70 | 964.61 |
| Trigger mutation | 2,785 | 5,075 | 5,075 | 124.42 | 135.95 | 137.27 |
| Passive message | 1,806 | 3,174 | 3,174 | 81.24 | 142.13 | 148.88 |
| Mixed workload | 508 | 1,876 | 1,876 | 1,009.45 | 1,456.62 | 1,555.11 |

Cold health availability was 4.815 seconds. Store recovery took 3.302 seconds and the remaining lifecycle readiness phases took 0.300 seconds. Two additional cold restarts took 3.336 and 3.313 seconds for Store recovery. After each restart, authoritative counts remained exactly:

```text
250 Projects | 1,251 Chats | 1,000 Agents | 1,050 Triggers | 0 Activations | 0 Runs
```

The Trigger count is 1,050 after the benchmark because the disposable work copy contains the fixture's 1,000 disabled Triggers plus two 20-mutation qualification passes and a prior 10-definition calibration run. Every measured mutation returned its expected success status.

The mixed p50 is higher than the earlier baseline while its tail improved. This is recorded rather than normalized away: the mixed workload deliberately creates 10 concurrent detailed reads of the same 1,002-member Chat while exact background projection recovery is still yielding. It is not a release target in this pass; the bounded readiness and ordinary health requests remain below the one-second target.

### Payload size

| Collection | Before | After (25 rows) |
| --- | ---: | ---: |
| Projects | 80,251 B | 8,026 B |
| Target Project Chats | 530,329 B | 6,051 B |
| Target Project Agents | 482,001 B | 12,051 B |
| Target Project Triggers | 535,811 B | 13,956 B |
| Agent workspace directory | not bounded | 22,330 B |
| Trigger workspace directory | not bounded | 21,498 B |

All bounded payloads are below the 150 KB acceptance ceiling.

Resident memory after the full workload was 183,517,184 bytes (175 MiB), down from the 197,529,600-byte baseline observation. Memory numbers include server caches and should be treated as comparative process snapshots rather than a heap-only measure.

## Storage audit

Baseline fixture storage:

| Category | Logical bytes | Allocated observation |
| --- | ---: | ---: |
| Entire data directory | 11,477,628 | 41 MiB |
| SQLite databases | 7,790,592 | approximately 7.5 MiB |
| All JSONL files | 2,727,192 | included below |
| Canonical communication/dispatch JSONL | 1,371,444 | — |
| Rebuildable projection JSONL | 900,188 | — |
| Target Project Agent directories | 535,000 | 16 MiB |
| Target Project Chat directories | 271,535 | 7.9 MiB |
| WAL files at rest | 0 | 0 |

The primary `ponderosa.db` was 6,774,784 bytes with 626,688 free bytes (9.25%). `ponderosa.sqlite` was 897,024 bytes with no free pages, and `asset-authority.sqlite` was 118,784 bytes with no free pages.

The important growth signal is filesystem allocation for many tiny per-Agent and per-Chat files/directories, not runaway SQLite or WAL growth. Automatic aggressive vacuuming would add latency and write amplification for little benefit, so this change does not add it. A future storage pass should measure longer-lived real installations before deciding whether to consolidate empty per-entity files, compact rebuildable projections, or introduce explicit retention controls for execution/audit evidence.

## Correctness and qualification notes

- The benchmark and restart checks created no Activations and no Runs.
- Trigger and passive-message operations returned their expected success codes.
- Exact collection counts survive repeated cold rebuilds.
- The generator refuses to overwrite an existing fixture unless `--force` is explicit.
- Benchmark work occurs in a disposable copy and the child server is terminated on normal completion or interruption.
- No clean-start marker, stale projection shortcut, or automatic data deletion was introduced.
- Three pre-existing `packages/agents/test/store.test.ts` assertions fail identically on `origin/master`; the branch adds no new failure in that package.
