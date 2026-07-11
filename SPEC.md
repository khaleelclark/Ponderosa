# Ponderosa — Self-Hosted Coding-Agent Workbench

> A web app served from your own machine that lets you run AI coding agents on
> that machine and manage them from any device (starting with a phone in bed) —
> less "chat with an AI," more "manage a small remote engineering team."

**Status:** Spec / pre-implementation. Written to be handed to Claude Code as the
implementation brief. Captures decisions made, the reasoning behind them, and the
concrete build plan.

---

## 1. Mission & Goals

Turn the old gaming PC (Ubuntu Server) into a personal coding-agent server. You
interact through a custom web app (React/TS/MUI — your specialty) from any device,
and agents do real work on the box: read/edit code, run commands, run tests, open
PRs — using your *existing AI subscriptions* (not pay-per-token API keys) for
maximum savings.

**Primary goal:** code from anywhere, especially from bed on a phone.

**v1 working principle:** **get one thing working end-to-end before polishing
anything.** v1 is mostly testing. The target is a thin *vertical slice* through
every layer (phone → thread → an agent runs on the box → results come back), not a
refined version of each feature. Prefer "it works" over "it's tuned."

**The UX thesis:** a coding agent doing real work produces a flood of tool calls,
terminal output, diffs, test results, logs, decisions, approvals. If all of that
goes into one chat stream, the interface becomes unusable. So Ponderosa
**separates conversation from execution**:

| Layer      | Question it answers      | Who it's for |
|------------|--------------------------|--------------|
| **Chat**   | "I need this done."      | Humans — intent, kept clean & readable |
| **Tasks**  | "Here's what's happening." | Execution timeline per unit of work |
| **Agents** | "Who's doing it."        | The workers (engine sessions) |
| **Artifacts** | "What changed."       | Diffs, test reports, PR summaries |

The mental model is a **richer GitHub pull request**: the conversation isn't the
whole story; the PR also has commits, checks, files changed, approvals, history.
Ponderosa creates that "AI pull request" object. When agents collaborate (a
reviewer finds a race condition, the coder fixes it, a test agent confirms),
that happens in the task timeline — your main chat just gets the summary:
"Auth refactor complete. Review passed. Ready to merge."

**v1 success criterion:** From a phone, reach the box (Tailscale in v1), open a
project, start a feature thread, kick off a task, watch it execute (as structured
task/artifact data, not a wall of chat), and get a clean human-readable result —
without touching a laptop.

### Product vision (north star, not a v1 requirement)
Someday this could be a product: a **hosted web UI** plus a **server you install
on your own machine**, linked together, so you interface with your box through our
website. The one design implication we honor now, cheaply: keep the **UI↔server
boundary a clean, documented API** so the UI can later run anywhere and point at a
user's self-hosted server. v1 stays single-operator and does not over-build for
this — it just avoids painting us into a corner. This also means we avoid coupling
the architecture to any one vendor (see network-agnostic, §10).

### Non-goals (for now)
- Multi-user. Single-operator. "We are the only ones with access" is an explicit
  v1 assumption that simplifies auth and sandboxing (revisited for productization).
- Public exposure of the box — v1 reaches it privately (Tailscale). Public/
  productized access is a v2 concern handled by real auth (§9), not v1.

---

## 2. Core Concepts & Mental Model

```
Project  (e.g. "Mobile App")           ── a codebase / repo on the host; a UI tab
  └── Thread  (e.g. "Auth Refactor")   ── a feature/unit of work; owns canonical history
        ├── Messages   (conversation — intent, for humans)
        ├── Tasks      (execution units: running / waiting-approval / done)
        ├── Artifacts  (diffs, test reports, PR summaries, logs)
        ├── State      (current branch, commit, open issues)
        └── Active agent  ── an ephemeral engine session bound to this thread
```

The load-bearing separations:

- **Server is the source of truth; the UI is a thin client.** The server persists
  every object (projects, threads, chat, tasks, agents, artifacts). The UI holds
  nothing durable — it loads objects from the server wherever the UI happens to be
  running (a phone browser, a laptop, or, someday, a hosted site pointed at your
  box).
- **Threads own the work; agents own temporary execution sessions.** A thread
  persists forever; engine sessions come and go. Switching the active engine is an
  explicit event, not a hidden sync problem.
- **Threads are feature-scoped, not project-lifetime.** "Auth Refactor" holds days
  or weeks of work, not your entire engineering history. This scoping keeps context
  manageable and is why we don't need a heavy context-assembly layer.
- **The thread doesn't know about any specific engine.** It stores canonical
  history. Adapters know how to start/continue *their* runtime's session from it.
- **Two kinds of context inside a thread:** conversation (Messages — intent,
  human-facing) vs. execution (Tasks/Artifacts/State — structured data, not chat).

### UI vocabulary: Agents & Master Chats (replaces Projects → Threads navigation)
The user-facing product presents **Agents** and **Master Chats**, not "Threads."
The data model is unchanged — an **Agent is a `Thread`** (same event log, sessions,
tasks, artifacts). This is a naming/navigation layer, not a migration.

```
Project
├── Master Chats          ── project-level control rooms (a shared context pool)
│   ├── Master Chat 1
│   └── Master Chat 2
└── Agents                ── every thread in the project, presented as an agent
    ├── API Agent  (assigned to a master chat)
    └── Test Agent (unassigned)
```

- **A Master Chat is a model-agnostic control room** (`master_chats` table). It is
  **not** bound to any provider and is **never locked by a running agent** — you can
  spawn many agents from one master chat concurrently. Its messages are a history
  pool that new agents inherit as context; its optional default engine/model/effort
  just prefill the spawn dialog and can be changed per agent at any time.
- **An Agent is a `Thread`.** Threads with no `masterChatId` appear as **Unassigned**
  agents — old threads need no migration. Threads with a `masterChatId` appear both
  under their master chat and in the project-wide **Agents** tab.
- **Where work happens:** an Agent's detail view (Chat · Live Log · Tasks · Artifacts)
  drives the existing thread runtime; the Agents tab is where you cancel a run or
  give an agent direct context. Sending a Master Chat message **only records** the
  message today — it does not interpret it or launch an agent. A later orchestration
  phase (needing master-chat runtime/streaming) would let a coordinator agent act on
  those messages; the v1 UI must not imply that already works.
- **Durable URLs** back navigation: `/projects/:projectId/master-chats/:masterChatId`,
  `/projects/:projectId/agents`, `/projects/:projectId/agents/:agentId`. Only a
  lightweight preference (last selected project) is persisted client-side.

### Project context = the project's own md files
A project is a real repo on the host. When an agent works in a thread, its working
directory is that project's path, so it **reads the project's own context files
directly off disk** — `AGENTS.md`, `CLAUDE.md`, READMEs, config. We do **not**
build a separate "memory store" (see §4); the agents already do this natively.

> ⚠️ **Two unrelated `AGENTS.md` files — don't confuse them.**
> (a) *This repo's* `AGENTS.md` = rules for agents building **Ponderosa itself**.
> (b) *A managed project's own* `AGENTS.md` = context an agent reads when working
>     **inside that project** via its cwd. They have nothing to do with each other.

---

## 3. Core Architecture

### Delegation trust boundary and audit guarantee

Delegation is a Ponderosa server operation, not an engine feature. Each active
runtime receives an opaque, short-lived delegation capability. The agent-facing
bridge accepts only task data (safe display label, private prompt, runtime/model,
and idempotency key); the server derives the parent run, thread, master chat, and
root lineage from the capability. Model-supplied ownership or registration fields
are rejected.

The bridge routes creation through the canonical delegation store, then consumes
the existing one-time registration proof internally before launching the selected
adapter. The proof and raw prompt never appear in public DTOs, logs, or UI
responses. Public records contain lineage, runtime, safe summary, lifecycle
status, and timestamps. Queued, running, output, terminal failure/completion, and
cancellation events are appended to the delegation audit log and streamed to the
lineage UI. Limits for depth, descendants, concurrency, authorization,
idempotency, cancellation, and replay remain enforced by that store.

Delegated children receive a newly bound capability so recursive work follows the
same path. Capabilities are revoked when their owning run ends or is cancelled.
Runtimes are explicitly instructed that built-in `spawn_agent`, `Task`, or similar
subagent mechanisms are forbidden under Ponderosa; they must report bridge
failures and must never silently fall back to an untracked child.

Each delegated child is also backed by a canonical Ponderosa thread. “Subagent”
describes its server-recorded origin and lineage, not a reduced feature tier. The
child therefore has the normal Agent detail surface, persistent event log,
messages, tasks, artifacts, resumable runtime session, direct follow-up queue, and
thread cancellation. Its thread is linked to the same master chat, so the child
and parent participate in Collaboration under their own thread identities and can
hand work back and forth with ordinary `@mentions`. The delegation audit remains
the authority for parent/child/root lineage and the initial delegated lifecycle;
the thread event log remains canonical for the child agent's work and subsequent
turns. The raw delegation prompt is not copied into the public thread history.

The central engineering decision: **the app is an orchestrator over
subscription-backed agent runtimes, not a chat client over provider API keys.**

"Use my subscription" means driving an already-authenticated agent CLI on the box.
"Switch providers" means *swapping the active engine session behind a thread* —
an explicit event that starts a new runtime session from the thread's canonical
history. One abstraction (the **Adapter**) covers both.

```
┌───────────────────────────────────────────────────────────────┐
│  Client (PWA)  — phone / laptop / tablet (thin; loads from srv) │
│  React + TS + MUI (Rspack SPA). Project tabs; per-thread panes: │
│  Chat · Tasks · Agents · Artifacts. Live stream rendering.      │
└───────────────┬───────────────────────────────────────────────┘
                │ HTTPS — REST for actions, SSE for streaming
┌───────────────▼───────────────────────────────────────────────┐
│  Ponderosa Server (Fastify daemon — Node/TS, on the host)       │
│  SOURCE OF TRUTH for all objects.                               │
│                                                                 │
│  Auth │ Thread store (event log + projection) │                 │
│                          │                                      │
│                 ┌────────▼────────┐                             │
│                 │ Session manager │  active engine per thread   │
│                 │ seed / continue │  spawn · stream · resume ·  │
│                 │ / switch / kill │  cancel                     │
│                 └────────┬────────┘                             │
│              ┌───────────┼───────────┐                          │
│              ▼           ▼           ▼                          │
│      ┌────────────┐ ┌──────────┐ (future: Claude, Gemini…)      │
│      │Codex adapter│ │ …        │  each: canonical history →     │
│      │(starting;   │ │          │  runtime session; events →     │
│      │ not locked) │ │          │  normalized AgentEvent         │
│      └──────┬──────┘ └──────────┘                                │
└─────────────┼──────────────────────────────────────────────────┘
              ▼
     Real filesystem + shell on the host (full access — §11).
     Agent's cwd = the thread's project dir → reads its md files directly.
```

### Decisions locked in
- **Starting engine: Codex CLI** — best fit for headless orchestration today, but
  **not locked in.** The `Adapter` interface exists precisely so the engine is
  swappable; nothing outside `packages/engines` assumes Codex. Claude is the
  planned second engine.
- **Execution: direct on host.** Backend runs as your user (systemd); the agents
  it spawns inherit real fs/shell access and the on-disk subscription tokens, and
  read each project's own md files from its cwd. No Docker bind-mount gymnastics
  (§10, §11).
- **Interface: web app (PWA) for v1**; native mobile is a possible future, not
  committed.
- **Transport: SSE** for the live stream — maps 1:1 onto the engines' JSONL output.
- **Reachability is a deployment choice, not architecture** (§10). v1 uses
  Tailscale for convenience; the app is not coupled to it.
- **Web stack (required): React + TypeScript + MUI**, bundled with **Rspack** (via
  **Rsbuild**), installable PWA. Backend: dedicated **Fastify** daemon, the source
  of truth. TypeScript monorepo (pnpm). SQLite for the index. Reuse JobTracker's
  **OAuth** pattern for the v2 auth work — not its Next.js/deploy stack.

---

## 4. Thread Model & Context Strategy  ⭐ (v1 foundation)

The architectural decision for the whole project: **who assembles the history that
reaches the model, and when.** This whole strategy ships in v1.

### The event log (canonical source of truth)
Each thread owns an **append-only event log** — everything that happened, in order:

```
Event 1  user.message      "Refactor authentication"
Event 2  agent.started      Codex session sX
Event 3  agent.text         "I'll handle this…"
Event 4  exec.command       `pnpm test`
Event 5  exec.file_change   auth.ts (edit, +diff)
Event 6  exec.test_result   pass
Event 7  user.message       "Actually mobile login is broken."
```

The log is never sent to a model wholesale. It is the durable record from which
everything else is derived (Messages, Tasks, Artifacts, State) and from which
sessions are seeded.

### The resolved context philosophy
- ❌ **Let the agent read the whole thread by default.** Wastes tokens, confuses
  the model, and old history is ~irrelevant to "fix this login bug."
- ❌ **Build a heavy server-side context builder that reassembles context on every
  message.** This fights the tool — the runtimes already do their own
  long-conversation compaction. Rebuilding under them causes cache misses and
  incoherence.
- ✅ **Threads own canonical history; the active runtime manages its own in-session
  context; the server assembles context only at boundaries.**

The server does context work at exactly two moments:

1. **Session seeding (`seed()`)** — when a fresh engine session starts for a
   thread: the thread's first turn, or (v2) an engine switch. The adapter starts
   the runtime with the thread's **chat history** and points it at the project dir;
   the agent reads repo context (its `AGENTS.md`, `git diff`/`git log`, files)
   itself. **No pre-assembled "packet" — just the chat + the working directory.**
2. **Historical / cross-thread queries (v2)** — e.g. "Why did we move to Clerk?"
   The server *searches* the event log and injects only the relevant slice. This
   is a query against the log, not a replay of it.

Continuing an active session is `continue()`: resume by session id + the next
message. The runtime handles its own context from there.

**Why no packet (decided):** in v1 there's a single engine and no switching, so
`seed()` only ever fires on a thread's very first message — there is no accumulated
history to assemble; it's just "first message + project dir." Even in v2, "just
give it the chat" suffices, because the work product lives on disk (changed files,
`git log`) and the project's context files are right there for the agent to read.
Feature-scoped threads keep the chat itself clean and small.

**This strategy is a v1 foundation, not a later feature.** The event log, `seed()`,
and `continue()` all ship in v1. The two *boundaries* that arrive later aren't more
strategy — they're the same methods firing on triggers that don't exist yet:
engine-switch seeding needs a second engine (v2), and historical search is a
separate UI surface (v2, though the queryable log it needs is v1).

### Project context (no separate memory store)
There is **no Ponderosa-owned memory database.** Slow-changing project knowledge —
stack, style, decisions — lives in the project repo's own **md files** (`AGENTS.md`,
`CLAUDE.md`, etc.), which the agents read natively via their cwd. You (or an agent,
with your confirmation) maintain those files like any other file in the repo. This
is simpler and reuses what the runtimes already do.

> The "context builder as the project's differentiator" idea is deliberately
> deferred to a v3 research track — a real opportunity (given long history, produce
> the minimal highest-value context) but not a v1 dependency. Keeping the event log
> clean and queryable leaves the door open without betting the MVP on it.

---

## 5. The Adapter (Engine) Abstraction

Every engine implements one interface. The thread stores canonical history; the
adapter translates it into a runtime session.

```ts
interface Adapter {
  id: string;                 // "codex" | "claude"
  displayName: string;
  listModels(): ModelOption[];
  listEfforts(): EffortOption[];

  // Continue the thread's ACTIVE session with the next user message.
  // Resume by session id; let the runtime manage its own context.
  continue(opts: {
    threadId: string;
    cwd: string;
    prompt: string;
    resumeSessionId: string;
    model?: string; effort?: string;
    signal: AbortSignal;
  }): AsyncIterable<AgentEvent>;

  // Start a FRESH session for the thread (first turn, or v2 engine switch).
  // Seed it with the thread's chat history + the project dir — no packet.
  // The agent reads repo context (md files, git state) itself.
  seed(opts: {
    threadId: string;
    cwd: string;
    prompt: string;
    history: ChatMessage[];    // thread conversation so far (often just the first msg in v1)
    model?: string; effort?: string;
    signal: AbortSignal;
  }): AsyncIterable<AgentEvent>;
}
```

### Normalized event model
Both runtimes emit rich event streams; normalize them so the frontend renders
uniformly and Tasks/Artifacts/State can be derived:

```ts
type AgentEvent =
  | { type: "session";     sessionId: string }            // persist for resume
  | { type: "text";        delta: string }                 // human-facing message
  | { type: "reasoning";   delta: string }                 // thinking/summary
  | { type: "tool_call";   id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError?: boolean }
  | { type: "command";     command: string; cwd: string }  // → Task/Artifact
  | { type: "file_change"; path: string; kind: "create"|"edit"|"delete"; diff?: string } // → Artifact
  | { type: "test_result"; passed: boolean; summary: string }  // → Artifact
  | { type: "task_update"; taskId: string; status: TaskStatus; title?: string }
  | { type: "turn_done";   usage?: TokenUsage }
  | { type: "error";       message: string };
```

The server routes these: `text`/`reasoning` → Chat; `command`/`file_change`/
`test_result` → Tasks & Artifacts; `session` → thread's active session id.

### Codex adapter (starting engine — not locked in)
- **Invocation:** `codex exec --json "<prompt>"` (or `@openai/codex` TS SDK, which
  spawns `codex exec --json` and parses JSONL into typed `ThreadEvent`s — prefer
  the SDK if stable; the `Adapter` hides the choice).
- **Stream:** stdout = JSON Lines. Events: `thread.started`, `turn.started`,
  `turn.completed`, `turn.failed`, `item.*` (agent message, reasoning, command
  exec, file change, MCP tool call, web search, plan update), `error`. Map to
  `AgentEvent`.
- **Session id:** from `thread.started`; persist on the thread. **`continue()`:**
  `codex exec resume <SESSION_ID>` (or `--last`). **`seed()`:** a fresh
  `codex exec` whose prompt includes the thread's chat history; the agent reads the
  project's `AGENTS.md` and git state from the cwd itself.
- **Auth:** ChatGPT subscription. `codex login` (browser OAuth) stores a token
  under `~/.codex/`. **This is the savings path.** Config: `~/.codex/config.toml`,
  `AGENTS.md` in project roots, sandbox + MCP settings.

### Claude adapter (planned second engine)
- **Library:** Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) — Claude Code as
  a library: built-in Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch, full loop,
  sessions, hooks, MCP. `query(prompt, options)` with streaming; options carry
  model, effort (`low|medium|high|xhigh|max`), cwd, permission mode, session/resume.
- **Auth:** Claude Pro/Max via on-disk profile. Same subscription-not-API-key
  savings. Resume by session id. Reads `CLAUDE.md`/`AGENTS.md` from cwd natively.
- **Note:** the Agent SDK (harness + built-in tools) — *not* the Anthropic API
  Tool Runner.

### Adding engines later
Any runtime with "run to completion, stream events, resume by id" implements
`Adapter`. No UI change beyond the engine picker + multi-agent wiring (v3).

---

## 6. Tech Stack

| Concern            | Choice                                    | Why |
|--------------------|-------------------------------------------|-----|
| Language           | TypeScript everywhere                     | Shared types across client/server; engine SDKs are TS-native. |
| Monorepo           | pnpm workspaces                           | `apps/` + `packages/`, shared `core` types package. |
| **Web (required)** | **React + TS + MUI**, bundled with **Rspack** (via **Rsbuild**) | Hard requirement; Rspack is the chosen bundler (Rust-fast, webpack-compatible); Rsbuild is the ergonomic app layer. SPA, no SSR. |
| Web extras         | Emotion; TanStack Query; react-markdown + remark-gfm + syntax highlighter | Query for data/cache; md/code for agent output & diffs. |
| Backend            | **Node + TS daemon, Fastify** (source of truth) | Long-lived process spawning/supervising agent CLIs + holding SSE streams — a daemon workload. |
| Streaming          | Server-Sent Events                        | 1:1 with engine JSONL; trivial reconnect. |
| DB                 | SQLite (index/projection only)            | Local single-node; the on-disk event log is the source of truth. |
| DB access/migrate  | `better-sqlite3` + Drizzle ORM            | Synchronous SQLite (ideal for a single-node daemon) + type-safe queries/migrations. |
| Starting engine    | Codex CLI (`codex exec --json`) — not locked | Subscription-backed, purpose-built for headless orchestration. |
| Second engine      | Claude Agent SDK                          | Subscription-backed, batteries-included. |
| Deploy             | Backend as a **host systemd service**; static frontend served by it. Reachability is a deployment choice (§10). Docker deferred. | Backend needs real host access (§11); host process makes that natural. |
| PWA                | Rsbuild PWA/service-worker plugin (Workbox) + web manifest | Installable, phone-native, no app store. Native mobile is a possible future. |

### Monorepo layout (proposed)
```
ponderosa/
  apps/
    web/                      # Rspack + React + TS + MUI SPA (the PWA)
    server/                   # Fastify daemon: API, SSE, session manager, auth
  packages/
    engines/                  # Adapter interface + codex/claude adapters + event mappers
      src/adapter.ts
      src/codex.ts
      src/claude.ts
      src/events.ts           # normalized AgentEvent + per-runtime mappers
    threads/                  # event log + SQLite projections (Drizzle schema)
    core/                     # shared types (AgentEvent, DTOs), config, logging
  deploy/
    ponderosa.service         # systemd unit for the backend
  AGENTS.md                   # rules for agents editing THIS repo
  SPEC.md                     # this file
  .env.example
```
No `packages/memory` — project knowledge lives in the managed repos' own md files
(§4). No `packet.ts` — seeding passes chat history, not an assembled packet (§5).

`core`'s shared types (esp. `AgentEvent` and API DTOs) are imported by both
`apps/web` and `apps/server`, so the SSE contract is typechecked end to end — and
keeps the UI↔server boundary clean for the hosted-UI future (§1).

---

## 7. Data Model — Event Log + Projections, on disk + SQLite

Folders are the source of truth; SQLite is a fast index/projection over them.

### On disk
```
$PONDEROSA_DATA_DIR/
  projects/
    <project-id>/
      project.json        # label, host path (cwd root), createdAt
      threads/
        <thread-id>/
          thread.json     # title, active engine, state, timestamps
          events.jsonl     # ⭐ append-only canonical event log (§4)
          artifacts/       # diffs, test reports, PR summaries, logs
          attachments/     # optional uploads
```
- No `memory.*` file — project knowledge is the managed repo's own md files (§4).
- `PONDEROSA_DATA_DIR` env with an auto-detected default. The whole dir is your
  backup unit; it's greppable and portable without the app.

### SQLite (projections — rebuildable from the log)
```
projects(id, label, host_path, created_at, last_used_at)
threads(id, project_id, title, active_engine,
        active_session_id,
        state_branch, state_commit, created_at, updated_at, archived)
messages(id, thread_id, seq, role, text, created_at)          -- Chat pane
tasks(id, thread_id, title, status, engine, created_at, updated_at)  -- Tasks pane
artifacts(id, thread_id, task_id, kind, path, summary, created_at)   -- Artifacts pane
events(id, thread_id, seq, type, payload_json, created_at)    -- searchable log index
```
All projections derive from `events.jsonl`. If SQLite is lost, replay the logs.

---

## 8. API Surface

REST for actions, SSE for the live stream. The UI is a thin client that loads all
objects from these endpoints (§2, §1 hosted-UI future). Structured around
Projects → Threads → (Messages · Tasks · Artifacts).

```
GET    /api/projects
POST   /api/projects                       # { label, hostPath }
GET    /api/projects/:id
GET    /api/projects/:id/threads
POST   /api/projects/:id/threads           # { title, engine, model, effort }

GET    /api/threads/:id                    # thread + messages + tasks + artifacts + state
PATCH  /api/threads/:id                    # rename / archive
POST   /api/threads/:id/switch-engine      # (v2) { engine } -> explicit event; new seeded session

POST   /api/threads/:id/messages           # send a user turn -> continue() or seed()
GET    /api/threads/:id/stream             # SSE: normalized AgentEvent stream
POST   /api/threads/:id/cancel             # abort active run (AbortSignal -> kill)

GET    /api/threads/:id/tasks
GET    /api/threads/:id/artifacts
GET    /api/threads/:id/artifacts/:aid     # diff/report/log content

GET    /api/threads/:id/search?q=...       # (v2) query the event log (historical Q&A)
GET    /api/files?projectId=&path=...      # scoped file/dir read for the file tree
                                           #   (project md files are just files here)

GET    /api/engines                        # available engines + models/efforts + auth status
GET    /api/health
```

Project knowledge (`AGENTS.md` etc.) is not a special endpoint — it's ordinary
files in the project repo, reachable via `/api/files` and read directly by agents
via their cwd. No memory API.

### Streaming contract
- `POST /messages` starts the run (`continue()` if the thread has an active
  session, else `seed()`), returns a run id.
- Client opens `GET /stream` (SSE). Server relays normalized `AgentEvent`s.
- **Reconnect:** replay missed events from `events.jsonl` by last-seen seq, then
  tail live, deduping by id (important for phones locking/unlocking).
- One active run per thread (v1); multiple threads run concurrently.
- **Engine switch (v2)** is first-class: `switch-engine` logs the change; the next
  message uses `seed()` (fresh session from chat history) rather than `continue()`.

---

## 9. Auth & Access

**Guiding principle: never store user passwords or per-user sensitive credentials
ourselves.** Either gate access at the network (Tailscale) or delegate identity
(OAuth). This keeps us out of the business of holding sensitive data we'd be liable
for — which matters for the productization goal (§1).

Two independent axes; every deployment answers both:

- **Reachability (how the device reaches the box)** — a deployment choice, not
  architecture (§10). v1 default: **Tailscale** (private mesh; you store nothing).
  Later: public domain / Cloudflare.
- **Authentication (proving it's you, once reachable)** — v1: with Tailscale as the
  gate, little-to-no app auth is needed and, critically, **nothing sensitive is
  stored.** v2: **OAuth over the API** for public/productized reachability —
  delegated identity, tokens not passwords, no credential store we're liable for.

Explicitly **not** doing: rolling our own password storage. Tailscale (v1) stores
nothing; OAuth (v2) delegates. The only app-managed secret in the OAuth path is a
single one-time OAuth *client* registration — not a per-user data store.

**Engine auth is separate and handled by the CLIs:** `codex login` (and the Claude
login) store subscription tokens on disk under the server user. Ponderosa never
handles provider credentials directly. Keep those token files off any image and out
of git. Surface each engine's auth status via `/api/engines`.

Accepted v1 tradeoff: leaning on Tailscale as the gate means v1 app-level auth is
minimal — fine for single-operator personal use, and replaced by real auth in v2.

---

## 10. Deployment & Reachability

**Backend runs directly on the host as a systemd service**, as your user, so the
engine CLIs it spawns inherit access to your projects, the on-disk subscription
tokens, and each project's md files — with no bind mounts.

```ini
# deploy/ponderosa.service (sketch)
[Unit]
Description=Ponderosa coding-agent workbench
After=network-online.target

[Service]
Type=simple
User=khaleel
WorkingDirectory=/home/khaleel/ponderosa
Environment=NODE_ENV=production
Environment=PONDEROSA_DATA_DIR=/home/khaleel/.ponderosa
ExecStart=/usr/bin/node apps/server/dist/main.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

- **Frontend:** `apps/web` builds to static assets; Fastify serves them (single
  origin → no CORS, simplest auth). The UI is a thin client (§2).
- **Reachability is a deployment choice — the app is network-agnostic.** It just
  serves HTTP; how you reach it is up to deployment. The architecture must not be
  coupled to any one method (productization, §1):
  - **v1 default: Tailscale.** Easiest, private, already set up. Any device with
    Tailscale on your tailnet reaches the box from anywhere — home, cellular in
    bed, another city. Tailscale Serve gives HTTPS (`https://<host>.<tailnet>.ts.net`),
    which the PWA service worker/install prompt need.
    Tailscale is a **convenience, not a requirement** — don't build anything that
    can only work over Tailscale.
  - **Future: public domain / Cloudflare Tunnel**, paired with the v2 OAuth auth
    (§9). This is the productization path; a secure context (HTTPS) comes from the
    domain/Cloudflare instead of Tailscale Serve.
- **Docker: decision deferred.** The systemd-on-host path doesn't need it. May be
  adopted later (esp. for the "install the server" product story). Not ruled out,
  not required for v1.

---

## 11. Security & the "full access" decision

The user wants agents to have full system access; the box is private and
single-operator. Legitimate here — just make it explicit.

**Execution model: direct on host.** The backend runs as your user (systemd, §10);
spawned engine CLIs inherit real fs/shell access and the on-disk subscription
tokens. Because we don't run the app in Docker, the "app in a container but agent
needs host files" tension never arises.

**Guardrails worth having even on a solo box:**
- Access control per §9 — v1 leans on Tailscale as the gate (stores nothing); v2
  adds real OAuth for public reachability. The security boundary is auth/network,
  not a stored password.
- Scope the *file-browser* endpoint to registered project paths (the agent has full
  access; the browsing API shouldn't read arbitrary host paths).
- Cancel/kill for runaway runs (AbortSignal → process kill).
- Keep engine auth token files off any image and out of git.
- Persist `command`/`file_change` events — they are the Tasks/Artifacts data and a
  built-in audit trail.

**Deferred hardening (v3):** per-thread git worktrees to contain blast radius,
rate limits, read-only vs read-write thread modes, approval gates surfaced in the
Tasks pane, and (only if ever productized) multi-user isolation.

---

## 12. Frontend (PWA) — projects, then the four-pane thread

React + TS + MUI, mobile-first (headline use case: phone in bed), thin client that
loads everything from the server (§2). PWA now; native mobile a possible future.

### Navigation
- **Projects are tabs.** Threads (features) live under the selected project.
- A dashboard answering "what are we working on?": active tasks across threads
  (e.g. "4 active: 2 running, 1 waiting for approval, 1 done").

### Thread view (the core screen) — four panes
1. **Chat** — intent only. User turns + concise agent messages, with collapsed
   pointers ("[See task details →]") instead of inlining execution noise. Stays
   readable even after months.
2. **Tasks** — execution units with status (running / waiting-approval / done),
   assigned engine, and a per-task timeline (commands, file changes, tests).
3. **Agents** — the workers: which engine sessions are active, what each is doing,
   health. Header controls to pick the **active engine / model / effort**;
   switching engine is an explicit action (v2). (In v1, with one engine, this can
   fold into the thread header rather than a full pane.)
4. **Artifacts** — diffs, test reports, PR summaries, logs. The "what changed."

### Mobile-first specifics
- Panes as tabs/segments on phone, side-by-side on wider screens.
- Bottom-anchored composer; sticky engine/model/effort controls; big touch targets.
- Live "agent is working" state; SSE reconnect tuned for lock/unlock/backgrounding.
- Installable PWA (manifest, icons, theme color, Workbox service worker for shell
  caching + reconnect resilience — not offline agent runs).

---

## 13. Roadmap

**Overall v1 stance:** thin vertical slice through every layer, working end-to-end;
mostly testing; polish nothing until the loop works (§1).

### v1 — "manage tasks from bed" (single engine)
- Codex adapter only (`codex exec --json` + `continue()`/resume + `seed()`, ChatGPT-
  sub auth). Engine not locked in — just the only one wired up.
- Projects (tabs) → feature threads; event-log store + SQLite projections.
- Chat / Tasks / Artifacts panes (Agents folded into the header for a single engine).
- Model + effort pickers (Codex's set); per-thread cwd from its project; agent reads
  the project's own md files from disk.
- **Full context strategy (§4):** event log + `seed()` (chat history on first turn)
  + `continue()` (resume, runtime manages its own context). No packet, no memory
  store. Complete strategy — only switch/search *triggers* arrive later.
- Reachability: Tailscale (network-agnostic underneath). Minimal auth, nothing
  sensitive stored (§9). PWA over HTTPS. Cancel + command audit.
- Read-only artifact/diff viewer.

### v2 — second engine, explicit switching, public access
- Claude adapter (Agent SDK). Engine picker becomes real; `switch-engine` starts a
  fresh session seeded from thread chat history. Full Agents pane.
- **OAuth over the API** + public reachability (domain/Cloudflare) — the
  productization auth step (§9). Tailscale becomes optional, not the only path.
- Historical search over the event log ("why did we move to Clerk?").
- Richer artifacts; maybe in-app apply/reject of diffs; approval gates in Tasks.
- Agents may update a project's md files at end-of-task (with your confirmation).

### v3 — multi-agent collaboration + hardening + product
- Multiple agents per thread collaborating in the task timeline (coder → reviewer →
  test agent) without spamming Chat; Chat gets the rolled-up summary.
- Per-thread git worktrees / sandboxing; concurrency + rate limits; read-only mode.
- Product direction (§1): hosted web UI + installable self-hosted server, linked;
  clean UI↔server API makes this incremental rather than a rewrite.
- (Research track) a smarter context builder for very long histories — deferred,
  not a dependency.

---

## 14. Open Questions / Decisions Log

**Decided**
- Engine strategy: orchestrate subscription CLIs; provider switch = swap active
  engine session (explicit event, seeded from thread chat history). ✅
- **Starting engine Codex — not locked in;** the Adapter keeps it swappable. ✅
- Separate conversation (Chat) from execution (Tasks/Agents/Artifacts). ✅
- Projects (UI tabs) contain feature-scoped threads; agents read each project's own
  md files from cwd. ✅
- **Context strategy (v1 foundation):** canonical event log; runtime manages its own
  in-session context (`continue()`); server assembles context only at boundaries
  (`seed()` with chat history + historical queries). **No task packet. No separate
  memory store** — project knowledge is the repo's md files. ✅
- Execution: direct on host (systemd), full access, single operator. ✅
- Interface: PWA (v1); native mobile possible later. Transport: SSE. ✅
- **Reachability is network-agnostic:** Tailscale is the easy v1 convenience, not a
  requirement or part of the architecture. ✅
- **Auth: never store sensitive credentials.** v1 gates via Tailscale (stores
  nothing); v2 uses OAuth over the API (delegated identity) for public access. ✅
- Web: React + TS + MUI, Rspack/Rsbuild. Backend: Fastify daemon = source of truth;
  UI is a thin client. ✅
- Server persists all objects; UI loads them wherever it runs (enables hosted-UI
  product future). ✅
- Storage: event log (folders) + SQLite projections (better-sqlite3 + Drizzle). ✅
- Docker: deferred; systemd-on-host for v1. ✅
- Product north star: hosted UI + installable server, linked; keep UI↔server API
  clean now. ✅

**To confirm during build**
- Codex integration: official `@openai/codex` TS SDK vs spawning `codex exec
  --json`. Start with whichever is more stable; `Adapter` hides it.
- How the thread's chat history is rendered into a `seed()` prompt (tune
  empirically; keep it minimal).
- Exact v2 OAuth mechanism (reuse JobTracker's OAuth machinery).
- Whether v1 needs an Agents pane at all with one engine (leaning: fold into header).

---

## 15. Implementation Notes for Whoever Builds This

- **Build `packages/engines` first — Adapter + Codex + a CLI test harness.** Get
  `codex exec --json` spawning, JSONL→`AgentEvent` mapping, session capture,
  `continue()` (resume) and `seed()` (fresh session from chat history) working
  standalone before any UI. Riskiest part; de-risk first.
- **Then `packages/threads`** — event log (`events.jsonl`) + SQLite projections +
  the projectors that turn `AgentEvent`s into Messages/Tasks/Artifacts/State. This
  is where Chat-vs-execution separation is implemented.
- **Then the Fastify SSE plumbing**, then the four-pane UI. UI last — the event
  contract and projections are what matter.
- **Verify the savings assumption early:** confirm `codex exec` draws on the ChatGPT
  subscription (not an API key) with the logged-in token. Same later for Claude vs
  Max. This is the whole economic premise.
- **Keep the UI↔server boundary clean and API-first** even in v1 — it's what makes
  the hosted-UI product future incremental (§1). The UI stores nothing durable.
- **No memory subsystem, no packet builder.** Seeding = chat history + cwd; project
  knowledge = the repo's md files. Don't reintroduce these.
- **Reuse from JobTracker:** the OAuth implementation (for v2 auth, §9) and the
  data-dir-detection idea. Do *not* copy its Next.js/Docker stack.
- **Honor this repo's AGENTS.md** — subscription auth only; engines behind the
  `Adapter`; event log canonical; Chat is human-facing only; don't rebuild
  per-message context; network-agnostic; never store sensitive credentials.

---

## Sources (engine integration grounding)
- Codex non-interactive mode: https://developers.openai.com/codex/noninteractive
- Codex CLI reference: https://developers.openai.com/codex/cli/reference
- Codex authentication: https://developers.openai.com/codex/auth
- Codex features (JSON events, MCP): https://developers.openai.com/codex/cli/features
- Claude Agent SDK: https://code.claude.com/docs/en/agent-sdk
