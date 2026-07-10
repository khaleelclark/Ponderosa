# @ponderosa/threads

The append-only **event log** (canonical source of truth) + **rebuildable SQLite
projections** (SPEC §4/§7). A library consumed by `apps/server`; exposes no HTTP.

## Layout

| File | Role |
|---|---|
| `eventlog.ts` | Append-only per-thread `events.jsonl` — monotonic `seq`, fsync per append, `readSince(seq)` for SSE replay. No update/delete. |
| `projectors.ts` | **Pure** reducer: `LogEvent` → projection ops. Deterministic (ids from `seq`, timestamps from the event's `ts`). |
| `schema.ts` + `migrations/` | Drizzle schema for the six SPEC §7 tables + the init migration. |
| `db.ts` | `openDb()` — better-sqlite3 + Drizzle, applies migrations idempotently. |
| `store.ts` | `ThreadStore` — ties disk + DB + projectors; `appendEvent`, `getThreadDetail`, `rebuildProjections`, project/thread CRUD. |

## Two design decisions (recorded)

### 1. The log stores a superset of `AgentEvent`

SPEC §4's log includes **user turns**, but core's `AgentEvent` is the *engine*
stream only. So this package defines `LogEvent = UserMessageEvent | AgentEvent` — an
**additive superset**. `AgentEvent` is a strict subset, so core is untouched (no
redefinition, no SPEC edit needed). The `messages` projection gets user turns from
`user_message`; everything else routes per SPEC §5.

### 2. `reasoning` is not projected into Chat

SPEC §5 lists `reasoning` alongside `text` as "→ Chat", but AGENTS.md invariant 3
says **Chat holds intent/conversation only**. We resolve the tension by projecting
only `text` into the durable `messages` (Chat) table; `reasoning` stays in the
queryable `events` index and can be rendered live/secondary by the UI. This keeps
Chat clean even after months (SPEC §12) without losing the reasoning data.

## SQLite is never a source of truth

Everything in SQLite derives from the on-disk logs + `*.json` files.
`rebuildProjections()` wipes every projection table and replays from disk; the test
suite asserts the result is **byte-identical** to the incremental projection, and
that a total SQLite loss fully recovers. If a projection is wrong, fix the
projector — never write SQLite as a second source (AGENTS.md).

## Routing summary (SPEC §5)

| Event | Projection |
|---|---|
| `user_message` | `messages` (role user) — Chat |
| `text` | `messages` (role assistant) — Chat |
| `reasoning` | `events` index only (not Chat) |
| `command` | opens/updates a `tasks` row (timeline in `events`) |
| `file_change` | `tasks` + a `diff` `artifacts` row |
| `test_result` | `tasks` + a `test_report` `artifacts` row |
| `task_update` | explicit `tasks` upsert (if an engine emits it) |
| `session` | thread's engine-agnostic `active_session_id` |
| `turn_done` | closes the run's task as `done` |
| *(all)* | one `events` index row (searchable log) |

## Tests

```bash
pnpm --filter @ponderosa/threads test
```

`projectors.test.ts` — pure routing + determinism. `store.test.ts` — full-run
projection, monotonic seq / append-only, and the **rebuild-is-byte-identical**
property (write N events → snapshot → wipe SQLite → rebuild → identical).
