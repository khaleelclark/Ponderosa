# AGENTS.md — Ponderosa

Rules for anyone working in this repository.

Read the governing documents before changing behavior:

- [VISION.md](./VISION.md): product direction
- [VOCABULARY.md](./VOCABULARY.md): canonical terminology
- [COMMUNICATION.md](./COMMUNICATION.md): communication routing
- [COMMUNICATION_V3.md](./COMMUNICATION_V3.md): scheduler and coordination contract

## Mission

Ponderosa is a self-hosted interface for AI agents running through the user’s existing Codex or Claude subscriptions.

A casual user should experience a familiar Project chat. Agent organizations, collaboration, execution details, and context boundaries remain available for advanced users without becoming required knowledge.

## Non-negotiable invariants

### Engines and authentication

- Use subscription-backed CLIs or SDKs only. Never add provider API-key integrations.
- All engines live behind the `Adapter` interface in `packages/engines`.
- Normalize Codex and Claude events into shared `AgentEvent` types inside `packages/engines`. Do not add engine-specific branching elsewhere.

### Canonical authority

Authority is domain-specific:

- The append-only event log owns authored communication and execution telemetry.
- SQLite owns Communication V3 requests, joins, activations, scheduler Runs, leases, fences, prompt injection, terminal outcomes, idempotency, and the activation outbox.
- UI views are projections of canonical state. Do not create competing chat logs or infer state from rendered text.
- Only the scheduler may create or claim a Run.

Fix incorrect projections at their source. Do not rebuild V3 runtime state from JSONL.

### Communication

Every Communication has one immutable scope:

- **Broadcast:** organizationally shared knowledge. Plain Project-chat requests are Broadcasts that also activate one responsible agent.
- **Direct Message:** private communication between the user and explicit agents.
- **Collaboration:** agent-to-agent communication visible in relevant Team and Agent timelines.

Never infer scope or routing from prose, rendered mentions, provider memory, or UI location.

Broadcasts are the only communication inherited as organizational context. Direct Messages, Collaboration, tool calls, outputs, lifecycle events, and agent-creation records are not shared knowledge merely because they are stored or visible.

Routing uses stable Agent IDs. Display names and `#labels` are presentation only. `@` is reserved for Project file and folder references.

Project chat is a human-facing shared timeline. Do not dump collaboration traffic, tool calls, terminal output, diffs, or lifecycle noise into it.

Agent detail is an audit surface:

- Agent chat shows explicit inbound and outbound Communication.
- Work log shows ordinary execution output.
- Activity, Runs, and Files & Results show other execution evidence.

Ordinary runtime output must not silently become Communication or future context.

### Context and artifacts

- Fresh sessions receive bounded canonical context selected for that turn.
- Never replay every conversation, Agent history, roster, artifact, or audit event.
- Generated files enter managed storage and context only through explicit references, pins, or publication.
- Provider inputs must record exact submitted text, its hash, and a source manifest.
- Continuation handoffs are bounded, non-authoritative bridges between sessions—not shared memory or organizational truth.

### Coordination

- A visible managed Agent is not a provider-native helper.
- Create managed Agents only through Ponderosa’s tracked capability.
- Managed creation must atomically establish the Agent, opening Request, and optional Join.
- Terminal Request updates are canonical handoffs. Ordinary follow-up messages are passive copies.
- Use one aggregate Join for common fan-out.
- Preserve parent continuations until the final Join outcome is handled.
- Reporting relationships define accountability, not permitted communication paths. Agents may communicate directly across branches when another Agent owns, needs, or can resolve the work.
- Managers should receive decisions, escalations, and owned outcomes—not every routine exchange.

A subagent is an ordinary Agent with a `managerAgentId`. Do not create a second assignment or delegated-agent subsystem.

### Runtime safety

Agents intentionally run with the host user’s filesystem and shell authority. Project file APIs remain scoped to registered Project paths.

Triggers also run with full Agent authority:

- Trigger payloads and filesystem events are untrusted data, never instructions.
- Preserve occurrence identity and provenance.
- Never inject watched file contents automatically.
- Triggers create Activations, never Runs directly.

Runtime lifecycle operations must fail closed:

- Cancellation targets the exact observed Run and advances its fence.
- Late output from cancelled or replaced Runs is rejected.
- Process termination means observed process-group exit, not merely sending SIGTERM.
- Failed teardown remains durable, retryable, and blocks unsafe replacement or deletion.
- Project deletion fences authority and drains provider and browser processes before deleting canonical data.
- Shutdown must await Fastify close and runtime cleanup.
- Follow the detailed lifecycle contract in `COMMUNICATION_V3.md`.

### Security and portability

- Never commit engine tokens, OAuth secrets, credentials, `.env` contents, or provider profiles.
- Do not create a password or credential store.
- Do not couple architecture to Tailscale; it is only one deployment option.
- Canonical user and provider text must follow the normalization, size, artifact, and transaction rules in `COMMUNICATION_V3.md`.

## Architecture

```text
Project chat → Agents → temporary provider sessions

Communication:
Broadcast | Direct Message | Collaboration

Canonical event log:
Authored communication and execution telemetry

SQLite:
Communication V3 coordination and scheduler authority
```

Primary components:

```text
apps/web/         React + TypeScript + MUI PWA via Rsbuild/Rspack
apps/server/      Fastify daemon, REST, SSE, runtime supervision
packages/engines  Adapter interface and provider event normalization
packages/agents   Event projections and authoritative V3 SQLite state
packages/core     Shared types, configuration, and logging
deploy/           Host service definitions
```

Shared DTOs and `AgentEvent` types belong in `packages/core`. Do not redefine equivalent types inside applications.

Ponderosa uses REST and SSE. Do not introduce SSR, Next.js, or WebSockets without a demonstrated architectural need.

## Working conventions

- Use TypeScript throughout.
- Build in dependency order: engines → agents → server → web.
- Persist commands, tool calls, file changes, failures, and lifecycle events in the audit trail.
- Keep Project and Agent history bounded by default. Retrieve older evidence explicitly.
- Project creation requires a validated host folder and subscription-backed engine.
- Deleting a Project removes Ponderosa-owned state, never the user’s selected source folder.

## Collaboration and Git safety

Ponderosa is frequently modified by several agents concurrently.

### Ownership

- Exactly one writer owns a branch and worktree at a time.
- Reviewers remain read-only.
- Before writing, confirm the task, writer, branch, worktree, base commit, and current authorization.
- If ownership is missing, duplicated, stale, or disputed, stop and ask the manager.
- Use only Ponderosa’s tracked managed-Agent creation mechanism.

### Current authority

- A pause, freeze, or stop overrides all earlier instructions.
- While stopped, do not edit, test, build, commit, push, merge, clean, reset, delete, cancel Runs, or delegate work.
- A message or terminal UI status does not prove a process stopped or released its worktree.
- Before acting on delayed instructions, recheck the latest manager direction, branch tip, worktree, tracked Run, and process state.

### Branches and pull requests

- Start from the approved base in a dedicated branch and worktree.
- Never share writable worktrees.
- Inspect branch, HEAD, upstream, worktree registrations, and `git status` before committing, rebasing, or pushing.
- Stop on unexpected files. Preserve dirty or ambiguous state.
- Never reset, clean, stash, overwrite, delete, or force-push another Agent’s work to resolve uncertainty.
- All product, code, configuration, schema, test, and instruction changes require a pull request.
- Never commit directly to `master`.
- Revalidate against current `origin/master` before opening or updating a PR.
- Report the exact head commit and verification performed.
- Every PR requires an independent reviewer.
- Merge only with explicit authorization and passing required checks.
- Delete branches or worktrees only after proving they are merged, clean, inactive, and released.

On the Ponderosa host, use:

```bash
GH_CONFIG_DIR=/home/phoenix/.config/gh-khaleel gh ...
```

Check that profile before attempting another login. Never print or copy authentication tokens.

### Handoffs

A handoff must include:

- objective;
- branch and worktree;
- base and head commits;
- current writer;
- dirty state;
- commits and pushes made;
- verification results;
- blockers;
- next authorized action.

Treat chat claims as context, not proof. Prefer Git ancestry, worktree status, tracked Runs, process state, test output, and PR checks.

Preserve quarantined, forensic, review, and untracked evidence unless its owner explicitly changes its disposition.