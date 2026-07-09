# PLAN.md — Breaking SPEC.md into Model-Assigned Work Chunks

> **This is a plan, not an execution.** It defines how to split the Ponderosa spec
> into sub-agent tasks, which Claude model runs each, why, in what order, and the
> exact prompt each sub-agent receives. Every sub-agent must read `SPEC.md` and
> `AGENTS.md` before writing code — the prompts enforce that.

## How to execute this plan (instructions for the orchestrating agent)

If you are a Claude instance handed this file: your job is to execute it.

1. Read `SPEC.md` and `AGENTS.md` in this directory first.
2. Work through chunks **A → I in phase order** (§1 graph, §3 table). For each
   chunk, use its **Sub-agent prompt** verbatim as the task definition — either
   spawn a subagent on the assigned model, or perform the chunk yourself in
   sequence if subagents aren't available.
3. **Do not start the next phase until the current chunk's Acceptance criteria
   pass.** Run the Chunk I review after each phase merge.
4. **Stop and report to the user at these human gates:**
   - Before Chunk C's live run: `codex login` must be completed by the user
     (browser OAuth). C can be written and fixture-tested without it, but not
     live-verified.
   - After Chunk C's harness runs: report the subscription-billing verification
     result. **If Codex streaming/resume/subscription auth doesn't work as
     specced, STOP — do not proceed to E–G** (SPEC §5 needs revisiting).
   - Chunk H's phone-based checks are the user's to perform; hand over `VERIFY.md`.
5. Machine prerequisites (user or you, where possible): Node 20+, pnpm, Codex CLI
   installed; `codex login` done by the user; git initialized.
6. The user is the approval gate for anything ambiguous. When SPEC and reality
   conflict, ask — don't improvise architecture.

---

## 0. Model-Assignment Philosophy

| Model | Use for | Why |
|---|---|---|
| **Claude Opus 4.8** (`claude-opus-4-8`, effort `high`/`xhigh`) | The critical path & anything with ambiguity: engine adapter, contract design, integration, final review | Strongest long-horizon agentic coding; the Codex adapter is the project's riskiest, most judgment-heavy piece |
| **Claude Sonnet 5** (`claude-sonnet-5`, effort `high`; `xhigh` for the hardest coding) | Well-specified implementation: event-log store, Fastify server, React UI | Near-Opus coding quality at Sonnet cost; these chunks have crisp contracts and few unknowns |
| **Claude Haiku 4.5** (`claude-haiku-4-5`) | Mechanical/boilerplate: repo skeleton, config files, systemd unit, `.env.example` | Fast + cheap; zero design judgment required |

**Rules applied throughout:**
- Contracts (types) are designed once by the lead, early — every downstream chunk codes *against* them, which is what makes parallelism safe.
- The riskiest chunk (Codex adapter) goes first and gets the strongest model.
- Every chunk has explicit inputs (files it may touch), outputs, and acceptance criteria.
- A separate **review agent** (Opus) checks each merged chunk against the AGENTS.md invariants — the builder never reviews its own work.

---

## 1. Dependency Graph & Phases

```
Phase 0 ── A. Repo skeleton (Haiku)          ─┐  sequential, fast
           B. packages/core contracts (Opus) ─┘  (B blocks everything)

Phase 1 ── C. packages/engines: Codex adapter + CLI harness (Opus, xhigh)   ← critical path
      └─── D. deploy/ + env plumbing (Haiku)                                 ← parallel with C

Phase 2 ── E. packages/threads: event log + projections (Sonnet 5)          ← needs B (+C's event shapes stable)

Phase 3 ── F. apps/server: Fastify API + SSE + session manager (Sonnet 5, xhigh)  ← needs B, C, E

Phase 4 ── G. apps/web: React/MUI PWA (Sonnet 5, xhigh)   ← needs B (DTOs); shell can start after B,
                                                             wiring finishes after F

Phase 5 ── H. Integration + E2E vertical slice (Opus, high)
           I. Invariant review pass (Opus, high)  ← runs after every phase, final gate here
```

Parallelism windows: **C∥D**, and **G's UI shell ∥ E/F** (G codes against `core` DTOs
with a mocked API until F lands). Everything else is sequential on purpose — the
contract is the product.

---

## 2. The Chunks

---

### Chunk A — Monorepo skeleton
**Model:** `claude-haiku-4-5` · **Phase 0** · depends on: nothing
**Deliverables:** pnpm workspace (`pnpm-workspace.yaml`, root `package.json`,
`tsconfig.base.json`), empty-but-compiling `apps/web`, `apps/server`,
`packages/{engines,threads,core}`, `.gitignore`, `.env.example`, git init.
**Acceptance:** `pnpm install && pnpm -r build` succeeds on a clean checkout; layout
matches SPEC §6 exactly (no `packages/memory`, no `packet.ts`).

**Sub-agent prompt:**
> Read `SPEC.md` §6 (Tech Stack + Monorepo layout) and `AGENTS.md` in full. Create
> the pnpm monorepo skeleton exactly as laid out in SPEC §6: `apps/web` (Rsbuild +
> React + TS + MUI placeholder that renders "Ponderosa"), `apps/server` (Fastify
> hello-world with `/api/health`), `packages/engines`, `packages/threads`,
> `packages/core` (each with `package.json`, `tsconfig.json`, an empty `src/index.ts`
> that exports nothing, wired into the workspace). Add root configs, `.gitignore`
> (must exclude `.env`, engine token dirs, `dist/`), and `.env.example` with
> `PONDEROSA_DATA_DIR`. Do NOT create `packages/memory` or any packet-related file.
> Do NOT implement any logic — stubs only. Done when `pnpm install && pnpm -r build`
> passes. Do not deviate from the layout; if something seems missing, leave a TODO
> comment rather than inventing structure.

---

### Chunk B — `packages/core`: the contracts ⭐
**Model:** `claude-opus-4-8`, effort `high` · **Phase 0** · depends on: A
**Why Opus:** these ~300 lines are the most leveraged in the repo — `AgentEvent`,
`Adapter`, DTOs. Every other chunk codes against them; a design mistake here is a
multi-chunk rework.
**Deliverables:** `AgentEvent` union (SPEC §5), `Adapter` interface (`seed()` with
`history: ChatMessage[]`, `continue()` with `resumeSessionId`), `ChatMessage`,
`TaskStatus`, `ModelOption`/`EffortOption`, all REST DTOs for the SPEC §8 API,
SSE wire-frame types, config loader (`PONDEROSA_DATA_DIR` with auto-detected
default), logger.
**Acceptance:** typechecks; exports everything §5/§8 name; zero runtime deps beyond
config/logging needs; a short `CONTRACTS.md` in the package explaining each type's
role and what must never change without a SPEC edit.

**Sub-agent prompt:**
> Read `SPEC.md` in full — especially §4 (context strategy), §5 (Adapter +
> AgentEvent), §8 (API surface) — and `AGENTS.md` in full. In `packages/core`,
> implement the shared contracts: the normalized `AgentEvent` discriminated union
> exactly as written in SPEC §5; the `Adapter` interface exactly as written
> (note: `seed()` takes `history: ChatMessage[]` + cwd — there is NO TaskPacket
> type; do not create one); `ChatMessage`, `TaskStatus`, model/effort option types;
> request/response DTOs for every endpoint in SPEC §8; and the SSE event envelope.
> Add the config loader (env `PONDEROSA_DATA_DIR` with a sensible per-OS default)
> and a minimal logger. These types will be imported by both the server and the
> web app — design them to be JSON-serializable and free of Node-only types in the
> DTO layer. Write `CONTRACTS.md` documenting each exported type in one or two
> lines. Change nothing outside `packages/core`. If SPEC §5/§8 is ambiguous on a
> field, choose the simplest JSON-serializable shape and record the decision in
> CONTRACTS.md rather than expanding scope.

---

### Chunk C — `packages/engines`: Codex adapter + CLI harness ⭐⭐ (critical path)
**Model:** `claude-opus-4-8`, effort `xhigh` · **Phase 1** · depends on: B
**Why Opus/xhigh:** riskiest chunk in the project. Live child-process management,
JSONL parsing of an external tool's event stream, session capture/resume, partial
failure, cancellation. This is exactly the "long-horizon agentic coding" case.
**Deliverables:** `codex.ts` implementing `Adapter` (spawn `codex exec --json`;
map `thread.started`/`turn.*`/`item.*`/`error` → `AgentEvent`; capture session id;
`continue()` via `codex exec resume <id>`; `seed()` renders chat history into the
first prompt; AbortSignal → process kill), robust JSONL stream parser (partial
lines, interleaved stderr, nonzero exits), and a **CLI harness**
(`pnpm engines:try --cwd <dir> "<prompt>"`) that streams pretty-printed
`AgentEvent`s and prints the captured session id + a resume command.
**Acceptance:** unit tests for the JSONL→AgentEvent mapper against recorded
fixtures; harness runs a real turn on a machine with `codex login` done; a
documented manual check that usage drew on the ChatGPT subscription (the economic
premise); kill/cancel verified.

**Sub-agent prompt:**
> Read `SPEC.md` §3–§5 and §15, and `AGENTS.md` in full — invariants 1, 2, and 4
> govern this chunk. In `packages/engines`, implement the Codex adapter against
> the `Adapter` interface from `packages/core`. Spawn `codex exec --json` as a
> child process; parse its stdout as JSONL (handle partial lines, stderr noise,
> nonzero exit codes); map its events (`thread.started`, `turn.started`,
> `turn.completed`, `turn.failed`, `item.*` for agent messages / reasoning /
> command executions / file changes / MCP calls, `error`) into the normalized
> `AgentEvent` union — this mapping table is the heart of the chunk; keep it in
> one file (`events.ts`) with a unit test per event type using recorded JSONL
> fixtures. Capture the session id from `thread.started` and emit it as a
> `session` event. Implement `continue()` with `codex exec resume <SESSION_ID>`
> and `seed()` by rendering the provided chat history into the initial prompt
> (keep the rendering minimal — the agent reads the repo's own md files and git
> state from cwd; do NOT build a context assembler). Wire AbortSignal to SIGTERM
> with a SIGKILL fallback. Build a CLI harness script that runs one turn against
> a given cwd, pretty-prints the streamed events, and prints the session id plus
> the exact resume command. Consider the official `@openai/codex` TS SDK first;
> if it cleanly wraps exec+resume, use it — otherwise spawn directly. Either way
> the choice must be invisible outside this package. NEVER call any provider HTTP
> API or read an API key — subscription CLI auth only (AGENTS.md invariant 1).
> Document in the package README the manual verification step for confirming
> usage bills the ChatGPT subscription. No UI, no server, no database in this
> chunk.

---

### Chunk D — Deploy plumbing
**Model:** `claude-haiku-4-5` · **Phase 1 (parallel with C)** · depends on: A
**Deliverables:** `deploy/ponderosa.service` (systemd unit per SPEC §10),
`deploy/README.md` (install steps: node, pnpm, `codex login`, enable service,
Tailscale Serve HTTPS note), production build scripts in root `package.json`.
**Acceptance:** unit file matches SPEC §10; README walks a fresh Ubuntu box from
zero to running service; nothing Tailscale-*required* (network-agnostic —
Tailscale documented as the easy default only).

**Sub-agent prompt:**
> Read `SPEC.md` §9–§11 and `AGENTS.md` invariant 7. Create `deploy/
> ponderosa.service` matching the sketch in SPEC §10 (runs as the login user, env
> `PONDEROSA_DATA_DIR`, restart on failure) and a `deploy/README.md` that takes a
> fresh Ubuntu Server box from zero to a running service: install node/pnpm,
> clone, build, `codex login` as the service user, install + enable the unit,
> then reachability options — Tailscale (+ Tailscale Serve for HTTPS) as the
> documented easy default, with an explicit note that any HTTPS-fronting method
> works (domain/Cloudflare later). Add `build` and `start:prod` scripts to the
> root package.json. Do not make anything functionally depend on Tailscale.
> Documentation and config only — no application code.

---

### Chunk E — `packages/threads`: event log + projections
**Model:** `claude-sonnet-5`, effort `high` · **Phase 2** · depends on: B (C's event
shapes should be stable, i.e. C merged)
**Why Sonnet:** well-specified from SPEC §4/§7 — append-only JSONL log, Drizzle
schema, deterministic projectors. Crisp contract, low ambiguity.
**Deliverables:** on-disk layout per SPEC §7 (`projects/<id>/threads/<id>/
{thread.json,events.jsonl,artifacts/,attachments/}`); append/read/tail APIs with
per-thread seq numbers; Drizzle schema for the six projection tables; projectors
routing `AgentEvent`s → messages/tasks/artifacts/state rows; a `rebuild` function
that reconstructs SQLite from the logs; migrations.
**Acceptance:** property test — write N events, project, wipe SQLite, `rebuild`,
identical rows. Projectors are pure functions with unit tests (esp. text→Chat vs
command/file_change→Tasks/Artifacts routing). Log is append-only in the API
surface (no update/delete of events).

**Sub-agent prompt:**
> Read `SPEC.md` §2, §4, §7 and `AGENTS.md` invariants 3–5. In `packages/threads`,
> implement the thread store: the on-disk layout exactly as in SPEC §7 under
> `PONDEROSA_DATA_DIR` (from `packages/core` config); an append-only event log
> per thread (`events.jsonl`, monotonic per-thread `seq`, fsync-conscious append,
> a tail/read-since-seq API for SSE replay); the SQLite projection schema from
> SPEC §7 using better-sqlite3 + Drizzle with migrations; and pure projector
> functions that consume `AgentEvent`s and produce projection rows — routing per
> SPEC §5: `text`/`reasoning` → messages (Chat), `command`/`file_change`/
> `test_result`/`task_update` → tasks & artifacts, `session` → the thread's
> active-session column. Implement `rebuildProjections()` that wipes and replays
> from the logs, and test that projections are byte-identical after rebuild.
> SQLite is NEVER a source of truth — anything not derivable from the log is a
> design error; flag it rather than adding a write path. Expose no HTTP; this is
> a library consumed by `apps/server`. Do not import from `packages/engines`
> except types re-exported through `core`.

---

### Chunk F — `apps/server`: Fastify API + SSE + session manager
**Model:** `claude-sonnet-5`, effort `xhigh` · **Phase 3** · depends on: B, C, E
**Why Sonnet/xhigh:** substantial but well-bounded glue: every REST route from SPEC
§8, the SSE replay-then-tail contract, and the session-manager state machine
(seed vs continue, one active run per thread, cancel).
**Deliverables:** all SPEC §8 routes (v2-marked routes as 501 stubs); SSE endpoint
implementing replay-from-seq + live tail with heartbeats; session manager (per
thread: idle → running → idle; `seed()` on first turn, `continue()` thereafter;
reject concurrent runs per thread; AbortSignal on cancel; persist session ids);
event fan-out (adapter stream → append to log → project → broadcast to SSE
subscribers); static serving of `apps/web` build; `/api/files` scoped to
registered project paths; `/api/engines` with auth-status detection.
**Acceptance:** integration tests with a **mock Adapter** (scripted AgentEvents)
covering: first message seeds, second continues with the captured session id,
cancel kills, SSE client reconnecting mid-run receives replay+live with no gaps or
dupes (dedupe by seq), concurrent-run rejection, file API path-escape attempts
rejected.

**Sub-agent prompt:**
> Read `SPEC.md` §3, §5, §8–§11 and `AGENTS.md` in full. In `apps/server`, build
> the Fastify daemon. Implement every route in SPEC §8 (mark the v2 routes —
> `switch-engine`, `search` — as 501 with a TODO). Implement the streaming
> contract exactly: `POST /api/threads/:id/messages` starts a run — `seed()` (with
> the thread's chat history from the store) if the thread has no active engine
> session, else `continue()` with the stored session id — and returns a run id;
> `GET /api/threads/:id/stream` is SSE that first replays events after the
> client's `Last-Event-ID`/last-seen seq from the event log, then tails live,
> using seq as the SSE event id so reconnect dedupe works. Build the session
> manager: one active run per thread (409 on concurrent), multiple threads
> concurrent, cancel via AbortSignal, engine session ids persisted through
> `packages/threads`. Fan-out pipeline: adapter's AsyncIterable → append to event
> log → run projectors → broadcast to SSE subscribers — the log write happens
> before the broadcast so replay is always complete. Serve `apps/web`'s static
> build from the same origin. Scope `/api/files` strictly to registered project
> paths (canonicalize and reject traversal). `/api/engines` reports each
> adapter's model/effort options and whether its CLI is authenticated. Write
> integration tests against a mock Adapter — do not require a real Codex login in
> CI. No per-message context assembly anywhere (AGENTS.md invariant 4). Minimal
> v1 auth per SPEC §9: a simple shared-token middleware stub that is OFF by
> default behind Tailscale and clearly marked where v2 OAuth slots in — do not
> build a password store.

---

### Chunk G — `apps/web`: the PWA
**Model:** `claude-sonnet-5`, effort `xhigh` · **Phase 4** · depends on: B (start),
F (finish) — build the shell against `core` DTOs with a mocked API, wire to the
real server once F merges.
**Why Sonnet/xhigh:** the largest volume of code; UI-heavy agentic coding is
Sonnet 5's sweet spot. Design judgment is pre-made by SPEC §12.
**Deliverables:** Rsbuild + React + TS + MUI SPA per SPEC §12 — project tabs;
thread list; thread view with Chat / Tasks / Artifacts panes (Agents folded into
the header for v1: engine label + model/effort pickers); composer with send +
cancel; live SSE consumption with reconnect (last-seen seq, resume via
Last-Event-ID); dashboard ("N active: X running, Y waiting, Z done"); read-only
artifact/diff viewer (md + syntax highlighting); PWA (manifest, icons, Workbox);
mobile-first layout (panes as tabs on phone, side-by-side wide).
**Acceptance:** streams a live run end-to-end against the real server; phone-width
layout usable one-handed; lock/unlock the phone mid-run and the stream resumes
without gaps or duplicates; Chat pane shows only text/intent (execution renders in
Tasks/Artifacts); PWA installs over HTTPS.

**Sub-agent prompt:**
> Read `SPEC.md` §1–§2, §5, §8, §12 and `AGENTS.md` invariants 3 and 5. In
> `apps/web`, build the Ponderosa PWA with React + TypeScript + MUI, bundled with
> Rspack via Rsbuild (no Next.js, no SSR). Import ALL API/event types from
> `packages/core` — define no local duplicates. Navigation: projects as tabs;
> threads listed under the active project; a small dashboard summarizing active
> tasks across threads. Thread view: three panes (phone: swipeable tabs; wide:
> side-by-side) — Chat (user turns + agent `text` only, with "[See task details →]"
> links; never render commands/diffs/tool output here), Tasks (execution units
> with status and a per-task timeline of command/file_change/test events),
> Artifacts (diff/report/log viewer, read-only, markdown + syntax highlighting).
> Engine/model/effort live in the thread header (no Agents pane in v1). Composer:
> bottom-anchored, send + cancel, disabled-with-spinner while a run is active.
> Consume the SSE stream with an EventSource wrapper that tracks last-seen seq
> and resumes via Last-Event-ID on reconnect (test the phone lock/unlock path);
> use TanStack Query for REST data. PWA: manifest, icons, theme color, Workbox
> service worker for shell caching only. Until the server chunk lands, develop
> against a mock API module that replays a recorded event stream; keep the mock
> behind one interface so switching to the real API is a one-line change. The UI
> stores nothing durable — server is the source of truth.

---

### Chunk H — Integration: the vertical slice
**Model:** `claude-opus-4-8`, effort `high` · **Phase 5** · depends on: all
**Deliverables:** everything wired on the real box: real Codex run from the UI
through server, engines, log, projections, SSE, back to the phone; fixes for the
seams the mocks hid; a `VERIFY.md` script of manual checks (incl. the
subscription-billing check from Chunk C, cancel, reconnect, restart-resume).
**Acceptance:** SPEC §1's v1 success criterion executed literally, from a phone.

**Sub-agent prompt:**
> Read `SPEC.md` §1 (v1 success criterion, v1 working principle) and `AGENTS.md`.
> All packages are merged; your job is the thin vertical slice working
> end-to-end on the real machine. Run the full loop: create a project pointing
> at a real repo, create a thread, send a message, watch Codex execute via the
> live stream, confirm events landed in `events.jsonl`, projections populated,
> artifacts viewable, cancel works, and a second message resumes the same Codex
> session. Then break it on purpose: kill the server mid-run and verify restart
> behavior; disconnect the SSE client mid-run and verify replay; run two threads
> concurrently. Fix integration bugs where they belong (respect package
> boundaries — an engines bug gets fixed in engines). Write `VERIFY.md`: the
> ordered manual checklist for a release sanity pass, including the
> ChatGPT-subscription billing verification. Do not add features; do not polish;
> SPEC §1 says working slice over tuning.

---

### Chunk I — Invariant review (recurring gate)
**Model:** `claude-opus-4-8`, effort `high` · runs after **each** phase merge; final
gate after H.
**Deliverables:** review findings per merge, filed as issues or inline fixes-required.
**Acceptance:** zero violations of AGENTS.md invariants at final gate.

**Sub-agent prompt:**
> You are reviewing, not building. Read `AGENTS.md` (the invariants and the
> "What NOT to do" list) and `SPEC.md` §4–§5, §9. Audit the newly merged code
> for violations, in priority order: (1) any provider API key usage or direct
> provider HTTP calls; (2) engine-specific logic outside `packages/engines`;
> (3) execution noise rendered into the Chat surface; (4) full-history re-sends
> per message or any context reassembly outside `seed()`; (5) SQLite writes that
> aren't derivable from the event log; (6) Tailscale coupling or any stored user
> credential; (7) type duplication that bypasses `packages/core`. For each
> finding: file, line, the invariant violated, a one-line concrete failure
> scenario, and the minimal fix. Report every finding including low-confidence
> ones, with confidence noted — a human filters. Do not refactor style;
> invariants only.

---

## 3. Sequencing Summary (what runs when)

| Order | Chunk | Model | Effort | Parallel with |
|---|---|---|---|---|
| 1 | A — skeleton | Haiku 4.5 | — | — |
| 2 | B — core contracts | Opus 4.8 | high | — |
| 3 | C — Codex adapter ⭐ | Opus 4.8 | xhigh | D |
| 3 | D — deploy plumbing | Haiku 4.5 | — | C |
| 4 | E — thread store | Sonnet 5 | high | G-shell may start |
| 5 | F — server | Sonnet 5 | xhigh | G-shell continues |
| 6 | G — web PWA (wire-up) | Sonnet 5 | xhigh | — |
| 7 | H — integration | Opus 4.8 | high | — |
| gate | I — invariant review | Opus 4.8 | high | after every phase |

**Critical path:** A → B → C → (E → F) → G-wireup → H. If anything slips, protect
C — it validates the project's core bet (Codex streaming/resume on subscription
auth). If C's harness disproves the bet, stop and revisit SPEC §5 before spending
anything on E–G.

## 4. Cross-Cutting Rules Baked into Every Prompt
1. Read `SPEC.md` + `AGENTS.md` before writing code (each prompt names its sections).
2. Stay inside the chunk's package boundary; contract changes go through `core` + a SPEC edit.
3. No provider API keys, ever. No TaskPacket. No memory store. No Tailscale coupling.
4. Tests accompany the chunk (mapper fixtures, projector rebuild test, mock-adapter
   integration tests) — the integration chunk should find seams, not basics.
