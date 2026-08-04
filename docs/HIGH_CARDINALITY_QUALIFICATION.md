# High-cardinality performance qualification

## Scope

This qualification exercises Ponderosa with a deliberately provider-free dataset:

- 250 Projects;
- 1,251 Chats in the target Project and 1,500 Chats total;
- 1,000 idle Agents;
- 1,000 disabled Triggers;
- 1,250 passive communication messages;
- no Agent Runs or Activations.

The checked-in generator and benchmark live in `tools/high-cardinality/`. Every benchmark run validates an immutable fixture sentinel, creates an owned workspace beneath the operating system temporary directory, starts a private loopback server, performs the workload, validates exact authority counts, restarts the server, validates the same counts again, records raw evidence, and safely removes only its sentinel-owned workspace. It never points at production data.

Qualification host:

- AMD Ryzen 5 5500, 12 logical CPUs;
- 32 GB RAM;
- Linux host `pine`.

Raw evidence: [high-cardinality-2026-08-04.json](qualification/high-cardinality-2026-08-04.json).

To reproduce the qualified default workload from a clean checkout:

```sh
pnpm build
node tools/high-cardinality/generate-fixture.mjs
node tools/high-cardinality/run-benchmark.mjs --output=docs/qualification/high-cardinality-local.json
```

The generator refuses to overwrite an existing fixture unless `--force` is supplied and the directory carries its valid fixture sentinel.

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

`GET /api/ready` now performs a constant-work SQLite probe and an indexed `COUNT(*)` over Projects. It does not hydrate Project records or synchronously read Project instruction files. `GET /api/diagnostics/ready` retains deeper diagnostic state. Startup no longer waits for an all-Project orphan-asset scan; the existing periodic maintenance path performs that work.

### Mutation paths

Trigger create, update, enable, disable, and delete apply an incremental source change. A disabled webhook or schedule Trigger does not rebuild unrelated source state. Filesystem source refreshes remain serialized per Project because watcher replacement is stateful.

Passive messages perform historical replay lookup only when the canonical intake reports an idempotent replay. New passive messages preserve the append-only communication path and create no Activation or Run.

### Stable bounded reads

Collection endpoints query SQLite for total count and page IDs before hydrating records. Cursor tokens are scoped to the collection and search input. Limits are capped at 100.

Continuation uses deterministic keyset cursors containing the full ordering tuple and stable ID. Cursors also bind to a lightweight collection generation and fail explicitly when concurrent mutation makes continuation stale; they do not silently skip or duplicate records.

Bounded behavior covers:

- Projects;
- Project Chats;
- Project Agents;
- Chat members;
- Agent memberships;
- team directory membership;
- Triggers;
- workspace directory Project, Chat, Agent, and Trigger resources.

The web client consumes pagination metadata, merges records by stable ID, supports later-page server search, and loads Chat members and Triggers incrementally. A separate first-100 query is no longer treated as the complete collection.

### Long messages

Collapsed long messages mount a bounded 3,200-code-point, 36-line preview. Expansion mounts the full Markdown tree. Unicode truncation operates on code points rather than splitting surrogate pairs.

## Verified qualification

The harness starts from the immutable 1,000-Trigger fixture on every invocation. It creates exactly 20 disabled Triggers and 20 passive messages, verifies exact replay returns 200, verifies a changed idempotency payload returns 409, and fails immediately on any unexpected status or count.

The mixed test issues 30 concurrent readiness, Agent-directory, and Chat-detail reads. Durations are milliseconds.

| Measurement | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| Health | 0.66 | 2.37 | 4.10 |
| Readiness | 0.98 | 1.22 | 1.29 |
| Trigger mutation | 21.84 | 29.81 | 30.60 |
| Passive message | 38.92 | 66.94 | 69.54 |
| Mixed workload | 982.09 | 1,422.03 | 1,513.64 |

Initial health availability was 2.674 seconds. Store recovery took 1.300 seconds and the remaining lifecycle readiness phases took 0.299 seconds. The cold restart reached health in 2.724 seconds; Store recovery took 1.354 seconds and lifecycle readiness took 0.310 seconds.

Authoritative counts were validated before the workload, after the workload, and after a cold restart:

```text
Initial:  250 Projects | 1,500 Chats | 1,000 Agents | 1,000 Triggers | 1,250 Messages | 0 Activations | 0 Runs
Final:    250 Projects | 1,500 Chats | 1,000 Agents | 1,020 Triggers | 1,270 Messages | 0 Activations | 0 Runs
Restart:  250 Projects | 1,500 Chats | 1,000 Agents | 1,020 Triggers | 1,270 Messages | 0 Activations | 0 Runs
```

Every Trigger mutation returned 201. Every passive message and mixed request returned 200. The exact idempotent replay returned 200 and the changed-payload replay returned 409.

The mixed p50 remains near one second because the workload deliberately creates concurrent detailed reads of the 1,251-member Chat. It is recorded rather than normalized away; health and bounded readiness remain low-millisecond operations.

### Payload size

| Collection | 25-row payload |
| --- | ---: |
| Projects | 8,826 B |
| Target Project Chats | 5,976 B |
| Target Project Agents | 11,976 B |
| Target Project Triggers | 12,501 B |
| Agent workspace directory | 23,055 B |
| Trigger workspace directory | 20,740 B |

All bounded collection payloads are below the 150 KB acceptance ceiling.

Resident memory after the full workload was 191,803,392 bytes (approximately 183 MiB). Memory numbers include server caches and should be treated as comparative process snapshots rather than a heap-only measure.

## Storage audit

Baseline fixture storage:

| Category | Logical bytes | Allocated observation |
| --- | ---: | ---: |
| Entire data directory | 11,477,628 | 41 MiB |
| SQLite databases | 7,790,592 | approximately 7.5 MiB |
| All JSONL files | 2,727,192 | included below |
| Canonical communication/dispatch JSONL | 1,371,444 | - |
| Rebuildable projection JSONL | 900,188 | - |
| Target Project Agent directories | 535,000 | 16 MiB |
| Target Project Chat directories | 271,535 | 7.9 MiB |
| WAL files at rest | 0 | 0 |

The primary `ponderosa.db` was 6,774,784 bytes with 626,688 free bytes (9.25%). `ponderosa.sqlite` was 897,024 bytes with no free pages, and `asset-authority.sqlite` was 118,784 bytes with no free pages.

The important growth signal is filesystem allocation for many tiny per-Agent and per-Chat files/directories, not runaway SQLite or WAL growth. Automatic aggressive vacuuming would add latency and write amplification for little benefit, so this change does not add it. A future storage pass should measure longer-lived real installations before deciding whether to consolidate empty per-entity files, compact rebuildable projections, or introduce explicit retention controls for execution/audit evidence.

## Correctness and safety notes

- The benchmark and restart checks created no Activations and no Runs.
- Trigger, passive-message, replay, conflict, and mixed operations returned their exact expected statuses.
- Exact collection and communication-ledger counts survive a cold restart.
- Generator replacement requires an explicit `--force` plus a matching fixture sentinel.
- Benchmark work directories are created with `mkdtemp` beneath the OS temporary directory.
- Cleanup requires a matching run-specific ownership sentinel and refuses protected, fixture, repository, home, and production data paths.
- The benchmark does not accept an arbitrary `--work-dir`.
- The benchmark child server is terminated on success, failure, or interruption.
- No clean-start marker, stale projection shortcut, or automatic production-data deletion was introduced.
- Three pre-existing `packages/agents/test/store.test.ts` assertions fail identically on `origin/master`; the branch adds no new failure in that package.
