# How Ponderosa works

This document describes the behavior implemented in the current repository.
The final section separates proposed Ponderosa Next work from current behavior.

## The durable execution chain

Ponderosa is organized around one causal chain:

```text
human or external action
  -> durable cause
  -> Activation
  -> scheduler
  -> leased Run
  -> provider session
  -> durable output
```

1. A human action, Agent capability call, Automation occurrence, or system
   recovery first commits a durable cause. Examples include an authored
   Communication, a correlated Request update, a Decision response, and a
   Trigger occurrence.
2. If that cause requires Agent work, Ponderosa creates an Activation. An
   Activation records why an Agent is runnable, its priority, delivery policy,
   payload provenance, and idempotency. Triggers and messages do not create Runs
   directly.
3. The scheduler is the only component allowed to create and lease a Run. It
   may coalesce compatible Activations, but it preserves their identities. A
   lease has a fence so cancelled, expired, or replaced work cannot commit late
   output as though it were still current.
4. Before dispatch, Ponderosa compiles bounded context, records the exact
   provider input and source manifest, and moves the prompt through durable
   submission and acknowledgement states.
5. The executor opens or resumes a provider session through the selected Engine
   adapter. Provider events are normalized into one shared event model before
   the server or UI sees them.
6. Work-log text, commands, file changes, usage, browser activity, artifacts,
   errors, and terminal Run state are persisted. A provider's ordinary response
   is Work log; only an explicit Ponderosa messaging or Request capability
   creates authored Communication or a correlated handoff.

Not every durable cause wakes an Agent. A passive Broadcast and `next_run`
delivery are deliberate examples. Likewise, completing a Run does not by itself
promise future work; a later turn needs a still-durable Activation, Request,
Join, Decision, Automation occurrence, or human action.

## Agent, Run, and provider session

These identities have different lifetimes:

| Concept | Meaning | Lifetime |
| --- | --- | --- |
| Agent | Stable, addressable worker identity with an Engine, settings, organization position, and audit history | Until archived or deleted |
| Activation | Durable reason that an Agent is runnable | Until leased and terminally handled, cancelled, or expired |
| Run | One scheduler-owned attempt to handle one or more compatible Activations | One leased turn |
| Provider session | Codex or Claude context that may be resumed across compatible Runs | A reusable cache; replaceable after policy, tool-contract, provider, or context changes |
| Provider process | OS process hosting a CLI session or one-shot turn | Evictable runtime machinery |

An Agent can be idle, runnable, running, waiting, or blocked without changing
identity. Waiting is durable state, usually because the Agent owns an unresolved
Join, has suspended correlated work, or needs a Decision. Reporting lines define
accountability and visible organization; they do not prevent direct contact
between Agents in the same Project.

## Chats and Project ownership

Every live Agent belongs to one Chat within its Project. Agent creation requires
that Chat identity. Automations belong to the Project and name an explicit
destination Chat and target Agent; dependent Automations must be handled before
deletion or reassignment can proceed.

## Messages, Requests, and `next_run`

A **message** is authored Communication. It has one immutable scope and a
canonical audience resolved to stable IDs. A message can be displayed on more
than one surface, but those views are projections of the same event. Rendered
text, `#labels`, and the chat in which a copy appears are not routing authority.

A **Request** is a correlated coordination obligation from one Agent to another.
It has a requester, recipient, lifetime, state machine, ordered updates, and
optional membership in a Join. Progress and blocking questions update the same
Request. A terminal update is the canonical handoff and can automatically
reactivate the requester; sending a second chat message is neither required nor
equivalent. Joins provide `all`, `any`, or `quorum` completion and either
per-result or final-only wake behavior.

Use a message when information should be communicated. Use a Request when the
sender needs tracked work, a reply, a deadline, or aggregate completion.

`next_run` is different from both. It is a passive, one-way delivery to explicit
Agent IDs. It creates no chat message, Activation, Run, Request, Join, reply
obligation, or acknowledgement. Ponderosa injects it into the recipient's next
compatible Run if one happens before optional expiry. It is useful for context
the recipient should see later, not for work that must happen.

## Broadcast, `#broadcast`, and `#everyone`

A **Broadcast** is a Communication scope: organizationally shared knowledge.
Broadcasts can become bounded context for Agents across the Project. A Project
Chat task may both author a Broadcast and activate responsible Agents, but scope
and wake behavior are separate decisions. An informational `#broadcast` can be
persisted without starting a Run.

`#everyone` is a routing affordance, not a scope and not a durable group
identity. The client resolves it to the stable IDs of the currently eligible
Agents and sends a multi-recipient Direct Message or Collaboration, depending
on the surface. It can wake those recipients, but it does not turn the content
into organizational context for future Agents.

Similarly, `#Agent-name` is a display handle that the client binds to one stable
Agent ID. Renames do not rewrite the canonical audience. `@` is reserved for
Project file and folder references.

## Automations

The product calls scheduled, webhook, and filesystem Triggers **Automations**.
An Automation stores operator-authored instructions separately from each
untrusted occurrence payload. Every accepted occurrence is a durable occurrence
row with identity, a definition snapshot, provenance, payload media type, and
an input hash. That row advances to an Activation; its bounded payload and
retrieval path are authorized only for an active Run to which the occurrence's
Activation is attached. The occurrence is not a managed artifact.

Automations run with the same host authority as their Agent; they are not a
sandbox. Filesystem contents and webhook bodies are data, not instructions, and
Ponderosa does not automatically inject watched-file contents. Optional budgets
limit automatic root Runs, not downstream coordination. At a budget limit, new
occurrences remain durable and queued instead of disappearing.

## Decisions

A Decision is a durable Agent question for the operator. It can request
approval, present choices, or accept text. Approval and choice include a
"Something else" path. A blocking Decision means the Agent has no safe
independent work left; a non-blocking Decision lets unrelated work continue.

An ordinary Agent Decision response is stored with the question and resumes
dependent work through normal Activation scheduling.

Live provider connection and form elicitations are different. Ponderosa keeps
the waiting provider call in memory and persists only an operator-facing
Decision shell; sensitive URLs, form definitions, and submitted values are not
part of that durable record. A confirmation, decline, or form submission returns
directly to the waiting provider call without scheduling another Agent
Activation. If the operator instead uses the free-form "Something else" path,
Ponderosa declines the live provider request, records the text as the Decision
response, and schedules new Agent work to handle it.

## Context, compaction, and history

Canonical history and provider context are not the same thing. Ponderosa keeps
authored Communication and execution evidence durably, while every provider
turn receives a bounded selection relevant to that Run. It does not replay the
entire Project, roster, audit trail, or every prior message on each turn.

Provider sessions can be resumed while their policy, Engine, model, tool
contract, and context remain compatible. Under context pressure, Ponderosa can
schedule a dedicated bounded handoff on the old provider session. After a
usable handoff commits, Ponderosa tears down the old runtime process before the
replacement Run opens a fresh provider process, but retains the old
accepted-session snapshot as the durable fallback. Only after the replacement
reports occupancy below the required low-water mark does one canonical
acceptance event switch that snapshot and consume the handoff. An unverified
replacement is discarded without changing the accepted snapshot. A handoff is
a continuity bridge, not a new authority or organizational memory.

`ponderosa_history` is a conditional continuity aid, not a universal history
API. It is added only to a replacement session after a Ponderosa-managed
context rollover has frozen a durable boundary and eligible authored messages
exist before that boundary. Search is bounded lexical retrieval over that
authorized omitted set; `read` then returns one exact canonical message and a
small same-conversation neighborhood. Current-context messages, arbitrary audit
events, and broad dumps of all history are excluded.

There is no `ponderosa_docs` provider tool. The former bundled product wiki and
its tool-backed `ponderosa://docs/...` references were removed. Repository
documentation is for operators and contributors; it is not automatically added
to Agent context.

## Project files, attachments, and artifacts

Agents can share the Project's selected host folder or use a separate Git
working copy. A working-copy identity records its mode, state, and root path.
Separate copies are retained after Agent or Chat deletion until explicit cleanup.
For a Project registered from an existing folder, that folder can live outside
Ponderosa's data directory. When Ponderosa creates a new Project folder, it
lives under `PONDEROSA_DATA_DIR/workspaces`. In either case, those **Project
files** remain ordinary user-owned source files. File-change events record what
a Run changed; the projection is an audit view, not a second working tree or a
backup of the Project folder.

**Attachments** are validated copies staged for or associated with messages.
They are addressed by opaque IDs, not arbitrary browser-supplied host paths.

**Artifacts** are durable results with stable metadata and, for managed
generated or imported files, immutable Project-owned bytes. Files & Results
combines generated files, documents, screenshots, diffs, and other Run evidence
for browsing and preview. Generated Project artifacts can outlive their
originating Agent. Pinning or publishing changes their Project presentation and
visibility; it does not move or rewrite the user's source file.

An Agent can import a regular file from the Project folder or an
operator-configured import root into managed storage. Import validates the path
and stable bytes and fails closed on links, changing files, unsupported scope,
or size limits. Browser upload accepts one of these authorized managed
artifacts, never an arbitrary host path.

Deleting a Project removes Ponderosa-owned state only after runtime authority is
fenced and drained. It does not delete the registered Project folder, including
a Ponderosa-created folder under `PONDEROSA_DATA_DIR/workspaces`.

## Browser capability

Ponderosa has two browser ownership modes:

- A private execution browser belongs to one exact active Run. Its profile is
  isolated from the operator's normal browser profile. It uses a disposable
  profile by default. An operator can instead assign an Agent a Project-owned
  trusted profile whose cookies and site storage persist and whose use is
  leased FIFO to one browser at a time; the browser authority itself remains
  bound to the exact Run.
- A Project browser is operator-owned and persists across Runs. The operator
  must explicitly lend its control to one exact Agent Run; returning control
  does not close the Project browser.

Browser tools are host-owned capabilities, not general client automation APIs.
They expose bounded semantic inspection, admitted pages, explicit control
transfer, audited actions, screenshots, and managed-artifact upload. Ponderosa
records external-side-effect declarations and retry identities for actions such
as purchases, submissions, account changes, or messages. Live frames are not
durable artifacts unless a screenshot is explicitly captured.

See [Interactive Agent browser](interactive-agent-browser.md) for the detailed
authority and lifecycle contract.

## Notifications

In-app notifications project Communication, provider failures, coordination
problems, Automation limits, and Decisions into an operator feed. They have
severity, open/resolved/dismissed state, deduplication for operational issues,
and optional actions. They are projections of canonical state, not synthetic
messages and not scheduler authority.

Browser push is optional. It requires a secure origin or localhost, browser
permission, a device subscription, and a valid Engine-side VAPID identity.
In-app notifications remain available when push is unsupported or disabled.
The current push payload links to its best available Project, Agent,
conversation, and authored-message destination; it does not preserve every
in-app Decision or technical-focus action exactly.

## Provider authentication and Engines

Ponderosa drives installed Codex and Claude CLIs through one shared Adapter
contract. Engine-specific events are normalized inside `packages/engines`.
The server, scheduler, persistence, and web client do not branch on raw Codex or
Claude event formats.

Authentication belongs to the provider CLI. Sign in on the host with
subscription-backed Codex or Claude before starting work. Ponderosa probes
whether the CLI is installed, signed in, enabled by the operator, and currently
available; it does not read or store the provider's OAuth token and cannot
report provider billing or guarantee remaining quota. API-key or billed-token
provider modes are rejected because they violate the subscription-backed
Engine contract.

The **Ponderosa Engine** is the local service boundary: REST and SSE APIs,
durable stores, scheduler, provider supervision, browser supervision, and
notification delivery. The desktop Engine application starts, stops, and
reports on that service. The `ponderosa` launcher commands provide the same
host-management role. Neither is an additional provider or a second source of
Agent state.

## Clients and network boundary

The React web application is the primary operator client and can be installed
as a PWA. Desktop and mobile browsers use the same server-owned state and REST
plus SSE contracts. There is no separate native mobile Agent runtime.

Ponderosa listens on loopback by default. A non-loopback listener requires an
operator bearer-token boundary or an explicitly trusted single Tailscale
address. Browser clients must not store the shared operator bearer token; use an
authenticated reverse proxy when a browser needs that deployment mode.

## Persistence and upgrades

Authority is domain-specific:

- Append-only Project Communication and Agent event logs own authored messages
  and execution telemetry.
- SQLite owns Requests, Joins, Activations, scheduler Runs, leases, fences,
  prompt injections, terminal outcomes, idempotency, and activation outbox
  state. Those rows are not rebuilt from JSONL.
- UI timelines, Files & Results, Agent status, and notification summaries are
  projections of canonical state.
- Managed artifact storage owns immutable generated/imported bytes. Project
  working folders remain ordinary user-owned source content and are not deleted
  with their Project records.

The Ponderosa data directory contains Ponderosa-owned state and any
Ponderosa-created Project folders under its `workspaces` directory. Existing
folders registered as Projects can live elsewhere. A complete backup must
therefore cover the entire data directory plus every registered Project folder
outside it; Project source content cannot be reconstructed from file-change
events. A coherent service upgrade pauses new leasing, waits for active provider
and browser authority to drain, then replaces and restarts the Engine. Durable
intake can remain queued during the drain.

Database changes use a verified launch baseline and ordered transactional schema
extensions. During SQLite open, an existing database outside the supported
launch baseline, including a damaged legacy schema, fails closed instead of
being guessed into compatibility. Data-directory ownership is acquired before
layout checks. An unsupported marker, or a nonempty directory with no marker,
fails closed without deleting its contents. Only an empty owned directory gets
a new layout marker. A changed provider
tool or prompt contract also invalidates the persisted session contract, so the
next compatible Run starts with a fresh/reseeded provider session rather than
resuming stale tools.

See [Deployment](../deploy/README.md) for the drain and recovery procedure.

## Dictation and read-aloud

Dictation inserts recognized speech into the message composer; it is separate
from sending the message. Read-aloud plays message text through browser/system
speech only. No server-side synthesis, model download, or custom voice package is used.
Talk remains a turn-based conversation: listen, review, send, and hear the completed
reply. Browser/device support determines recognition and playback availability.
There is no continuous, phone-like Agent conversation mode.

## Current limits and proposed Next behavior

The following are product directions, not contracts implemented by the current
repository state:

- The current PWA has server-persisted drafts but no dedicated durable mobile
  outgoing-message outbox. Do not assume an offline send will recover after a
  page or network failure.
- Browser push does not yet guarantee that every notification action reopens
  the exact in-app subview across clients.
- Continuous voice conversation, automatic turn-taking, and conversational
  interruption are not implemented by dictation and message read-aloud.
- Large provider-executor checkpointing and full session reconstruction remain
  outside the current design.

A durable mobile outbox, exact notification routing, and continuous voice
conversation remain separate product directions. The current message and
scheduler contracts remain authoritative for any future voice client.
