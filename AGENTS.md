# AGENTS.md — Ponderosa

Rules for any AI agent (or human) working on **this repository**. Read this
before editing. [VISION.md](./VISION.md) defines the current product direction;
this file translates that vision into working invariants and repository rules.

---

## Mission

Ponderosa is a self-hosted web interface for AI agents running on the user's own
computer. A casual user should be able to open a Master Chat and interact with it
like a familiar AI conversation. Ponderosa handles fresh agent runs,
collaboration, and context boundaries behind that simple surface.

Power users can create and inspect organizations of agents and subagents, follow
their collaboration, and understand their execution. Advanced orchestration must
remain available without becoming required knowledge for ordinary use.

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

3. **The event log is canonical; views are projections.** The append-only event
   log is the source of truth and SQLite is rebuildable from it. Master Chat,
   Collaboration Chat, Direct Agent Chat, and output views must project canonical
   events rather than create duplicate conversations or competing state.

4. **Communication scope is explicit and immutable.** A communication is created
   as exactly one of:

   - **Broadcast:** agent to organization; visible in Master Chat and inherited as
     shared context by future agents.
   - **Direct Message:** a private user-agent exchange; visible in Master Chat but
     excluded from shared organizational context.
   - **Collaboration:** agent to one or more explicit agent recipients; visible in
     Collaboration Chat and relevant Direct Agent timelines, but excluded from
     Master Chat and shared organizational context.

   Scope never changes after creation. To share a private finding more broadly,
   create a new communication with the intended scope.

5. **Only Broadcasts are shared knowledge.** Visibility does not imply context
   inheritance. Direct Messages, Collaboration, assignments, tool calls,
   lifecycle events, and outputs do not become future-agent context merely
   because they are stored or displayed. Never rebuild context by indiscriminately
   replaying every recorded interaction.

6. **Master Chat stays human-facing.** It is the user's conversation and the
   project's curated shared timeline. Do not dump collaboration traffic, tool
   calls, terminal output, file changes, or lifecycle noise into it. Different
   responder names may be the only orchestration detail a casual user sees.

7. **Direct Agent Chat is an audit hub, not another conversation.** It projects
   everything inbound and outbound for one agent: user communication, Broadcasts,
   Collaboration, assignments, tools, lifecycle, and outputs. User input from
   this surface creates a Direct Message to that agent; it does not create a
   second canonical message or gain shared scope.

8. **Routing uses stable identities.** Store structured recipient agent IDs and
   let the server own routing. Display names and rendered `@labels` are presentation,
   never routing keys. Agents choose recipients and content; they do not manually
   construct textual mentions.

9. **Full host access is intentional and scoped by design.** Agents run as the
   host user with real fs/shell access (single-operator box). That is by design.
   But: the *file-browser API* is scoped to registered project paths even though
   the *agent* is not. Don't widen the browsing API to arbitrary host paths.

10. **Network-agnostic; never store sensitive credentials.** Don't couple anything
   to Tailscale — it's a v1 reachability convenience, not the architecture (public
   domain/Cloudflare must also work). And never build a password/credential store:
   early deployments may gate via Tailscale while later deployments can delegate
   identity via OAuth over the API.

---

## Architecture (one screen)

```
Master Chat → Agents → ephemeral runtime sessions
Canonical event log → rebuildable SQLite projections
Communication → Broadcast | Direct Message | Collaboration
Agent activity → Direct Agent Chat audit timeline
Agent outputs → user-meaningful deliverables
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

No general transcript-as-memory layer: shared organizational knowledge comes from
intentional Broadcasts, while project instructions and code remain in the managed
repository.
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
- **Everything derives from the log.** If a communication, audit, or deliverable
  projection is wrong, fix the projector—do not write to SQLite as a second
  source of truth.
- **Keep secrets out of the repo and images:** engine auth token files
  (`~/.codex`, Claude profile), OAuth secrets, `.env`. Never commit them.
- **Persist execution events.** Commands, tool calls, file changes, failures, and
  lifecycle events belong in the audit trail even when no dedicated task UI
  presents them.

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

- On the Ponderosa host, run GitHub CLI commands with
  `GH_CONFIG_DIR=/home/phoenix/.config/gh-khaleel`. This is the persisted
  `khaleelclark` repository profile. Check it with
  `GH_CONFIG_DIR=/home/phoenix/.config/gh-khaleel gh auth status` before starting
  a new login flow; do not print or copy tokens from `hosts.yml`.
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
- ❌ Dump Collaboration, tool calls, terminal output, diffs, or lifecycle noise
  into Master Chat.
- ❌ Treat Direct Agent Chat as a separate conversation or source of shared
  context.
- ❌ Route messages by display name or agent-authored textual `@mentions`.
- ❌ Re-send indiscriminate conversation and audit history to every fresh runtime.
- ❌ Treat SQLite as the source of truth (it's a rebuildable projection).
- ❌ Copy JobTracker's Next.js/Docker stack. (Reuse its **OAuth** pattern only.)
- ❌ Introduce SSR / a Next.js app / a WebSocket transport without a strong
  architectural reason.

---

## When guidance disagrees

[VISION.md](./VISION.md) is the current product direction. This file governs
repository work. If code, older documentation, or a proposed plan conflicts with
either, surface the conflict instead of silently preserving stale behavior. A
change to product direction should update `VISION.md`; a change to agent working
rules or architectural invariants should update this file in the same pull
request.
