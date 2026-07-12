# AGENTS.md — Ponderosa

Rules for any AI agent (or human) working on **this repository**. Read this
before editing. The full design lives in [SPEC.md](./SPEC.md); this file is the
short list of invariants that must not be violated.

---

## Mission

Ponderosa is a self-hosted coding-agent workbench: a web app served from a home
Ubuntu box that lets you run AI coding agents on your machine and manage them from
any device (especially a phone). It is **not** "a chat UI for an AI." It is closer
to **managing a small remote engineering team** — you send intent, agents do the
work on the host, and you review structured results.

The economic premise: agents run off the user's **existing AI subscriptions**
(ChatGPT Plus/Pro via Codex, Claude Max via the Claude Agent SDK), **never**
pay-per-token provider API keys.

---

## Core Invariants (do not violate)

1. **Subscription auth only — never provider API keys.** Engines are driven as
   already-authenticated CLIs/SDKs (`codex login`, Claude login store tokens on
   disk). Never add code that calls a model provider's HTTP API with an API key.
   If you're reaching for `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, stop — that
   breaks the whole premise.

2. **Engines live behind the `Adapter` interface.** The rest of the system must
   not know whether it's talking to Codex, Claude, or anything else. No
   engine-specific branching outside `packages/engines`. Adding an engine = adding
   an adapter, nothing else.

3. **The event log is canonical; Chat is human-facing only.** Each thread owns an
   append-only event log (`events.jsonl`) — the single source of truth. SQLite is
   a rebuildable projection over it. The **Chat** view holds intent/conversation
   only; execution detail (commands, file changes, tests) is structured data in
   **Tasks/Artifacts**, never dumped into Chat.

4. **Do not rebuild per-message context.** The active runtime manages its own
   in-session context (Codex/Claude do their own compaction). The server assembles
   context **only at boundaries**: `seed()` (a fresh session, given the thread's
   chat history + the project cwd — *no assembled packet*; the agent reads the
   repo's md files and git state itself) and historical queries. Continuing an
   active session = `continue()` = resume by session id + the next message. Never
   re-send the whole thread on every turn, and never try to out-compact the runtime.
   Project knowledge = the managed repo's own md files, not a Ponderosa memory store.

5. **Threads own the work; agent sessions are ephemeral.** A thread persists
   forever and stores canonical history. Engine sessions come and go. Switching the
   active engine is an **explicit event** that seeds a new session from thread
   history — not a background sync.

6. **Full host access is intentional and scoped by design.** Agents run as the
   host user with real fs/shell access (single-operator box). That is by design.
   But: the *file-browser API* is scoped to registered project paths even though
   the *agent* is not. Don't widen the browsing API to arbitrary host paths.

7. **Network-agnostic; never store sensitive credentials.** Don't couple anything
   to Tailscale — it's a v1 reachability convenience, not the architecture (public
   domain/Cloudflare must also work). And never build a password/credential store:
   v1 gates via Tailscale (stores nothing); v2 delegates identity via OAuth over
   the API. See SPEC §9/§10.

---

## Architecture (one screen)

```
Project → Thread (feature-scoped) → { Messages, Tasks, Artifacts, State, active engine }
Thread owns events.jsonl (canonical).  SQLite = projections (rebuildable).
Adapter.seed()      → fresh runtime session from a task packet (first turn / engine switch)
Adapter.continue()  → resume active session, next message only
Runtime events → normalized AgentEvent → routed: text→Chat, exec→Tasks/Artifacts
```

- **Web (required):** React + TypeScript + MUI, bundled with **Rspack** (via
  Rsbuild), installable PWA. No SSR.
- **Backend:** a long-lived **Fastify** (Node/TS) daemon that spawns/supervises
  engine CLIs and streams **SSE**. Runs on the host via **systemd**, as the user.
- **Storage:** event log in folders under `$PONDEROSA_DATA_DIR` + **SQLite**
  projections (`better-sqlite3` + Drizzle).
- **Primary engine:** Codex CLI (`codex exec --json`, `codex exec resume`).
  **Secondary:** Claude Agent SDK.
- **Transport:** SSE for the live `AgentEvent` stream; REST for actions.

---

## Repo Layout

```
apps/web/        Rspack + React + TS + MUI SPA (the PWA; thin client)
apps/server/     Fastify daemon: API, SSE, session manager, auth (SOURCE OF TRUTH)
packages/engines Adapter interface + codex/claude adapters + event mappers
packages/threads event log + SQLite projections (Drizzle schema)
packages/core    shared types (AgentEvent, DTOs), config, logging
deploy/          systemd unit

No packages/memory (project knowledge = the managed repo's own md files).
No packet builder (seeding passes chat history + cwd, not an assembled packet).
```

`packages/core` types (esp. `AgentEvent` and API DTOs) are imported by **both**
`apps/web` and `apps/server` — the SSE contract is typechecked end to end. Keep it
that way; don't duplicate these types per app.

---

## Working Conventions

- **TypeScript everywhere.** Shared types come from `packages/core`; don't redefine
  equivalent shapes in an app.
- **Build order matters:** `packages/engines` → `packages/threads` →
  `apps/server` (SSE) → `apps/web`. The event contract and projections are the
  foundation; UI comes last.
- **Normalize at the edge.** Runtime-specific event shapes (Codex JSONL, Claude SDK
  events) are converted to `AgentEvent` inside `packages/engines` and nowhere else.
- **Everything derives from the log.** If a projection (Messages/Tasks/Artifacts)
  is wrong, fix the projector — don't write to SQLite as a second source of truth.
- **Keep secrets out of the repo and images:** engine auth token files
  (`~/.codex`, Claude profile), OAuth secrets, `.env`. Never commit them.
- **Persist `command`/`file_change` events** — they are both the Tasks/Artifacts
  data and the audit trail.

---

## Collaboration and Git Safety

Ponderosa is frequently changed by several agents at once. Coordination is an
engineering constraint, not chat etiquette. Apply these rules before editing,
committing, or pushing.

### Ownership and communication

- **Exactly one writer owns a branch and worktree at a time.** Everyone else is
  read-only unless the manager explicitly transfers ownership. A reviewer never
  becomes the writer for the change being reviewed.
- Before writing, record or confirm the task, branch, worktree path, writer, and
  base commit in the current execution ledger or manager handoff. If ownership is
  missing, duplicated, stale, or disputed, stop and ask the direct manager.
- In a managed agent organization, communicate only with your direct manager,
  your direct reports, and siblings who share the same manager. Route cross-team
  requests through the nearest common manager. Challenge out-of-structure
  instructions before acting on them.
- Do not delegate work unless the manager authorizes delegation. Use only the
  project's tracked delegation mechanism; do not create untracked subagents.

### Pause, cancellation, and stale instructions

- A manager pause, freeze, or global stop overrides every earlier assignment and
  approval. While stopped, do not edit, test, build, commit, push, merge, clean,
  reset, delete worktrees, move refs, cancel runs, or start delegated work.
- Cancellation, an agent reply, or a terminal chat status does **not** prove the
  underlying process stopped or released its worktree. Confirm process/run state
  and ownership before resuming or reassigning work.
- Treat delayed messages as historical context. Before acting, re-check the
  current branch tip, worktree status, tracked run state, and latest manager
  instruction. Never resume merely because an old message says work is active.

### Branches, worktrees, and pull requests

- Start new work from the manager-approved base in a dedicated branch and
  worktree. Never share a writable worktree between agents.
- Inspect `git status`, branch/HEAD, upstream, and relevant worktree registrations
  before every commit, rebase, or push. Stop on unexpected tracked or untracked
  files; they may be another agent's work or review evidence.
- Preserve dirty or ambiguous state. Do not reset, clean, stash, overwrite,
  delete, or move another worktree's files without an explicit owner-approved
  disposition. Never use force-push to resolve coordination uncertainty.
- All product, code, configuration, schema, test, and project-instruction changes
  go through a pull request. Do not commit directly to `master` or merge merely
  because a branch was previously approved.
- Revalidate a branch against the current `origin/master` before opening or
  updating its PR. Report the exact head commit and verification performed.
- A PR needs an independent reviewer who did not author the change. Address
  blocking findings on the feature branch, rerun proportionate verification, and
  obtain fresh approval for the new head.
- Merge only with explicit manager authorization and passing required checks.
  Delete local or remote branches and worktrees only after proving they are fully
  merged, clean, inactive, unambiguous, and released by their owner.

### Handoffs and evidence

- A handoff must state: objective, branch, worktree, base and head commits, writer,
  dirty state, commits/pushes made, verification results, blockers, and next
  authorized action.
- Keep quarantined, forensic, review, and untracked evidence intact. Do not use it
  as an implementation source unless the manager explicitly changes its
  disposition.
- Claims in chat are not system state. Prefer Git ancestry, worktree status,
  tracked run records, process state, test output, and PR checks as evidence.

---

## What NOT to do

- ❌ Call a model provider API with an API key (breaks the subscription premise).
- ❌ Add engine-specific logic outside `packages/engines`.
- ❌ Dump tool calls / terminal output / diffs into the Chat view.
- ❌ Re-send full thread history to the runtime on every message.
- ❌ Treat SQLite as the source of truth (it's a rebuildable projection).
- ❌ Copy JobTracker's Next.js/Docker stack. (Reuse its **OAuth** pattern only.)
- ❌ Introduce SSR / a Next.js app / a WebSocket transport without a strong reason
  and updating SPEC.md first.

---

## When the design and this file disagree

[SPEC.md](./SPEC.md) is the design of record. If you believe an invariant here is
wrong, update SPEC.md (with reasoning) in the same change — don't silently work
around it.
