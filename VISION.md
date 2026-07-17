# Ponderosa Product Vision

## What Ponderosa is

Ponderosa is a web interface for working with AI agents running on your own
computer. It should remain useful when you are away from that computer,
especially from a phone.

The default experience should feel as approachable as ChatGPT: open a Project
chat, describe what you want, and receive a useful response. Behind that simple
conversation, Ponderosa can start fresh agent runs, preserve the right context,
delegate work, and coordinate multiple agents.

The same product must also serve power users who want to create organizations of
models in whatever structure suits their work. They can create agents and
subagents, inspect collaboration, and understand how work moves through the
organization. This complexity stays behind the scenes until a user chooses to
engage with it.

## Product principles

1. **Simple by default, powerful by choice.** A new user should only need to
   understand Project chat. Advanced organization and orchestration are optional.
2. **Fresh execution with intentional continuity.** Agents may spin up for each
   request so usage and runtime context remain manageable. Ponderosa preserves
   the important project knowledge without indiscriminately replaying every
   interaction.
3. **Communication has explicit purpose.** Every message is created for one
   audience and retains that scope permanently.
4. **Shared context is curated.** Only durable organizational knowledge should
   become context for future agents.
5. **The work is inspectable.** Power users can see agent relationships,
   collaboration, execution, and outputs without forcing those details into the
   casual chat experience.
6. **Functionality comes first.** Core workflows must work reliably. Mobile and
   interface polish should improve continuously without blocking foundational
   correctness.
7. **Automation is explicit and inspectable.** Outside events may start work,
   but their payloads remain untrusted data, every occurrence is auditable, and
   the user can disable the source without losing completed results.

## Interaction and execution state

When an agent is already responding, a new direct message steers its active turn
by default. Queue is an explicit alternative shown only while the manager is
drafting to that running agent. This keeps conversation fluid without removing
the ability to schedule a follow-up at a safe turn boundary.

A steer is shown as delivered only after provider acknowledgement. If transport
fails after submission, the message is visibly unconfirmed for ten seconds and
then Ponderosa interrupts only the originating Run and starts linked, audit-first
recovery work. The manager may instead let that Run finish before recovery.
Historical uncertain deliveries remain labeled and are never replayed
automatically.

Typing/responding indicators and elapsed-time stopwatches reflect canonical
execution ownership. One revisioned, server-backed draft belongs to each Project
chat and is never a sent communication event. Draft conflicts resolve by accepted
server revision, and a draft clears only after send confirmation. Selected views
and reading position are restored across navigation and refresh so inspecting
another agent does not discard the manager's place.

Editing a sent Broadcast appends an immutable revision event and projects the
latest text under the original message identity. The original event, its scope,
audience, and sent attachments remain unchanged. An edit is passive: it updates
future shared projections but never redelivers work or rewrites context already
received by an active runtime.

Agent Detail separates durable views of the same execution domain: Chat for
explicit communication, Work log for ordinary runtime output, Activity for the
chronological command/test/tool/file feed, Changed Files for the canonical
agent-attributed file set, Review for the current Git working tree and safe
diff/file inspection, Runs for execution state, Files & results for durable outputs,
and Triggers for Agent-owned automatic work.
Sources remain attached to their message in a compact footer. Generated PDFs are
previewable and downloadable as project-scoped artifacts.

Long-form agent results use a concise chat summary with a titled Markdown
document attached to the same communication. The document is previewable and
downloadable, preserves its original Markdown, and records agent/execution/
creator provenance. Normal future context contains the summary and document
reference, not the entire body; agents retrieve full content only when needed.
Document scope is never independent: Broadcast documents are organizational,
while Direct Message and Collaboration documents remain private to their
immutable audiences.

Engine processes may stay warm briefly for responsive steering and follow-up,
but idle agents must not retain an unbounded process and MCP stack. Canonical
provider session identity survives process teardown so a later turn can resume
without making runtime residency part of the product's memory model.

Runtime configuration, subscription authentication, and current provider
availability are separate facts. A real entitlement denial remains authoritative
across time and restarts, and queued work for that engine remains unleased. The
operator may explicitly test access after renewing a subscription; only a
provider-accepted test or successful Run restores availability.

Context inspection distinguishes exact input submitted for the current Run from
evidence known only to remain in a continued provider session. Unsent queued
messages and unrelated artifacts appear in neither category, and historical
manifest records remain readable after the schema evolves.

Workspace and Project rules have explicit precedence and are stored by
Ponderosa. Global provider switches hold queued work without sacrificing Runs.
Provider denial remains a separate durable availability fact. The operator has
one synced display profile for their name, `#handle`, and catalog avatar.

## Automatic Triggers

Power users may attach schedules, signed webhooks, and Project-folder watchers
to one Agent in one Project chat. A Trigger is part of that Agent's lifecycle,
not a global workflow router: deleting the Agent or removing its chat membership
deletes the Trigger and cancels work that has not started. Completed Runs,
artifacts, and occurrence history remain evidence of what happened.

Trigger work always queues at a turn boundary. Bursts retain every normalized
occurrence but may be executed as one bounded same-Trigger batch; they never
replace the latest event, silently discard intermediate events, steer an active
Run, or mix definitions. Filesystem sources bundle paths and event metadata
without automatically injecting file contents. Missed schedules recover as one
occurrence rather than a Run per interval.
Trigger definitions are authoritative scheduler state and survive ordinary
daemon restarts. A one-time schedule disables itself only after durably creating
its occurrence; that already-authorized occurrence remains eligible to execute.

Each Trigger may optionally limit root outside-activation Runs by day, week,
month, or lifetime. Unlimited is the default. A batch costs one unit; work the
Agent delegates does not. Exhausted occurrences remain queued, and the user can
allow a chosen number of additional Runs for the current period.

Automation is intentionally flexible in V3.2: Trigger Runs have the full access
of their Agent. Ponderosa therefore presents a prominent full-access warning,
requires signed webhook intake, preserves immutable payload/provenance hashes,
and keeps operator instructions structurally separate from untrusted event
data. These boundaries reduce accidental and prompt-injection risk but are not
a restricted-execution sandbox. Reduced authority can be added later if real
usage demonstrates that the flexibility/safety tradeoff requires it.

## Projects and agent organization

Projects and their Project chats live in a collapsible, resizable explorer-style
sidebar rather than top-level tabs. Project sorting is either Last used or
Alphabetical and is a synced server preference. Selecting a project opens its
most recently used active Project chat, with deterministic first-chat fallback.
Semantic navigation preferences—including project sorting, custom project order,
and the last-used Project chat—remain server-synced so navigation is coherent
across devices. Presentation state is deliberately device-local: sidebar width,
sidebar collapse, and Agents-section expansion are stored only in that browser
and are not written through the workspace-preferences API. The phone drawer
always opens as a full list navigator regardless of the desktop sidebar state on
that device.

Creating a project requires a label, a validated host working folder, and a
default subscription-backed engine, and atomically creates an initial “New chat.”
The host folder picker exposes only explicitly configured browse roots and rejects
canonical paths or symlinks that escape them; manual entry is validated by the
same rule. Creating another Project chat is immediate and inherits the project
engine default, while each send may override engine, model, and effort. Projects
can be renamed or permanently deleted; deletion removes Ponderosa-owned chats,
agents, executions, artifacts, and projections without deleting source files.

There is one kind of agent. A subagent is an ordinary agent with a direct manager,
not a separate delegated runtime or rigid Assignment. It has the same Chat,
Work log, Activity, Changed Files, Review, Runs, Files & results, steering, queueing,
and execution audit as a top-level agent.

Users can create a top-level agent or choose any existing active agent as its
manager. Agents use the same creation service through a capability-bound bridge;
the server derives the manager from the spawning agent. A spawning agent may
supply an exact opening message—a task, role, introduction, or anything else—or
create an idle report with no initial work. Creator, execution, and the original
message remain inspectable.

A newly created agent receives the current Project chat's Broadcast context, never
its manager's private messages, Collaboration history, Work log, or provider
session. Managed agents use ordinary Collaboration to send questions, findings,
decisions, and results directly to the agents who need them, including across
reporting branches. The manager relationship defines accountability, escalation,
creation, and lifecycle ownership—not a mandatory communication route. Agents
return requested work to its requester or consumer and involve the manager when
the manager owns the outcome or must resolve priority, scope, ownership, resource,
or unresolved-risk questions. They may Direct Message the user, but only top-level
agents Broadcast durable organizational synthesis.

The reporting chain may be recursive. Runtime crashes wake the direct manager
without manufacturing a chat message. Deleting a manager recursively deletes its
remaining descendants; a user promotes or re-parents any agent they want to keep
before deletion. Changing the organization never rewrites creator, communication,
or execution history.

Parents can inspect and manage only their visible descendant subtree through a
Run-scoped describe/plan/apply capability. Creation, rename, and stop may be
autonomous. Deletion and reporting-line changes require a durable user Decision.
Decisions support approval, Agent-defined choices, and free text, appear in the
relevant chats and Needs attention, and preserve the operator's response.

Agents and descendant organizations can be copied or downloaded as either a
template or full portable JSON. Imports accept a selected file or pasted JSON,
require explicit engine mapping, keep
old messages as private historical context, disable imported Triggers with new
secrets, and treat destination rules as authoritative. Source Project rules are
retained only as package provenance and never enter provider context. Project-owned managed
artifacts survive Agent deletion and travel with full packages within the
documented package-size boundary.

The sidebar includes a compact, collapsible agent hierarchy with live status and
project running counts; Agent Detail remains the complete management surface.
Stop All reports partial cancellation failures. Delete All is unavailable until
every agent is stopped, requires destructive confirmation, and preserves main
Project-chat history by using canonical deletion semantics.

## Live workspace and notifications

REST remains the mutation protocol and authenticated SSE is the server-to-client
live protocol. A typed workspace stream complements detailed agent streams and
carries project/chat mutation signals, communication availability, lifecycle and
running-count changes, draft revisions, preferences, notifications, and read
cursors. Workspace event IDs are monotonic and replayable after Last-Event-ID;
clients deduplicate, detect gaps, refetch affected resources, and reconnect after
mobile backgrounding without maintaining divergent browser truth.

An active Run may own one engine-agnostic host browser that remains alive across
ordinary chat navigation. Agent Detail presents its live page in a collapsible
panel, makes agent/operator control ownership explicit, and fences stale input so
both cannot type simultaneously. Browser lifecycle, navigation, console output,
and explicit screenshots are execution activity/artifacts, never chat. The
operator surface is scoped to the exact project, Agent, conversation, and Run and
must not become a general host/browser proxy. The transport and teardown boundary
is specified in
[`docs/interactive-agent-browser.md`](./docs/interactive-agent-browser.md).

Workspace/user state is recorded in append-only canonical logs with rebuildable
projections, separate from per-agent execution logs and canonical Communication.
SQLite and browser storage remain caches/projections for authored workspace and
user state. Communication V3 scheduler tables are authoritative for requests,
joins, activations, Runs, leasing, fencing, cancellation, injection, and recovery.

In-app notifications are durable. Opening a Project chat clears its unread state
across devices. Notification preferences are synced and cover direct responses,
Project-chat responses, mentions, all messages, #everyone messages, Broadcasts,
or none; matching and device delivery are idempotent so one event produces at
most one notification per device and never notifies its author. Standards-based
Web Push may deliver while the PWA is closed; permission denial or unsupported
browsers keep in-app notifications working, and VAPID/private configuration stays
outside repositories and logs.

Operational Team chat entries are derived from canonical Runs, queued work,
Requests, waiting conditions, Triggers, Decisions, and organization changes.
They use compact human language and never become fake authored messages.
Notifications distinguish informational updates, attention, and urgent broken
states, retain stable deduplication identity, and may link directly to the
required action.

## The communication model

Ponderosa has three communication surfaces. Each has one purpose.

### Project chat

Project chat is the primary interface between the user and the AI organization.
It is both the user's conversation and the project's shared timeline. It should
read like the story of the project, not a dump of execution logs.

Different agents may respond over the course of a Project chat. For a casual
user, the changing responder name can be the only visible indication that an
organization is working behind the conversation.

Two message scopes appear in Project chat:

- **Broadcast:** The user or an agent tells the organization something durable.
  Broadcasts become shared knowledge available to future agents.
- **Direct Message:** The user and one or more explicitly addressed agents
  communicate privately. The message is visible once in Project chat but does
  not become shared context for future agents.

A plain user message in Project chat is a Broadcast and starts a fresh agent to
handle it. This is the familiar default chat workflow: the request remains part
of the shared project story while Ponderosa handles agent creation behind the
scenes. It is rendered exactly as the user typed it, without an automatic scope
prefix. Starting a message with `#broadcast` records shared informational
context without starting an agent and retains that visible prefix. Starting with
one or more agent `#names` creates one Direct Message with that immutable
audience and one delivery per addressed agent. Only an explicit `#everyone`
action may wake every agent. Broadcast context is supplied from the current
Project chat at a turn boundary; it is not copied into private agent history.

Agent `#names` in rendered message history are links to the corresponding Direct
Agent Chat, making the visible recipient or referenced agent directly
inspectable. Scope labels such as `#user`, `#broadcast`, and `#everyone` retain
the same visual treatment but are not links because they identify an audience,
not an agent.

Important collaboration results do not automatically become Broadcasts. An agent
must deliberately publish durable knowledge or deliberately tell the user. This
keeps Project chat useful and prevents coordination traffic from overwhelming the
project narrative.

An agent's ordinary runtime response is not a fourth communication scope. It is
execution data shown in that agent's Work log tab. Only an explicit Broadcast,
Direct Message, or Collaboration event may appear on a communication surface.
Ponderosa never guesses scope from response text, mentions, or the room that
started the turn.

### Team Chat

Team Chat is exclusively for agent-to-agent communication. An agent
chooses one or more explicit recipients and supplies the message. Ponderosa owns
routing and renders recipient labels; agents do not manually construct textual
mentions.

Correlated work is represented by a Request and optional Join rather than by a
behavior flag on a message. An agent may request work and keep running. When it
does wait, the immutable Join describes the outcomes it needs and an Activation
records why it later becomes runnable. Human and urgent activations do not cancel
open joins. Ponderosa never guesses these effects from prose; request progress,
join state, activation sources, and resumed Runs remain inspectable and update
live.

Collaboration messages do not appear in Project chat and do not become shared
context for future agents. If a finding matters to the organization, an agent
creates a new Broadcast. If it matters only to the user, the agent creates a
Direct Message.

### Agent chat

Agent chat is an agent's complete inbound and outbound communication timeline. It
is a hub over existing communication and activity, not a separate conversation
or an additional message scope.

The Chat tab can show:

- user messages;
- Direct Messages;
- Broadcasts;
- collaboration messages;
- the exact agent-creation message and creator when another agent spawned it;
- explicit communication to or from that agent.

The adjacent Work log tab shows ordinary response text and transient reasoning,
chronologically and associated with the originating execution. Completed
response text is durable canonical execution data. Work log never becomes
future-agent context and never creates or triggers a delivery.

When a user writes from this surface, the result is a Direct Message addressed to
that agent. It remains visible in Project chat without creating a duplicate
canonical message.

Broadcasts remain in their originating Project chat and may be supplied as that
room's shared context. They are never retroactively copied into a new agent's
Agent chat. An agent's own explicit Broadcast remains visible in its audit
timeline, but another agent's Broadcast never masquerades as local authorship.

Agent chat exists for debugging, transparency, and understanding an
individual agent. Its contents do not become shared knowledge merely because
they are visible there.

Emoji reactions are a lightweight user shortcut for sending feedback to the
specific agent who wrote a message. Only users can react, and only to
agent-authored messages. Picking any emoji displays it on that canonical message
without adding a new chat entry. The author receives a private notification with
the original message attached as reply context. Agents cannot create reactions,
and reaction notifications never become organizational context.

For ordinary conversation, a plain Project-chat request creates shared work. The
responsible agent can Direct Message the user with a question, private progress,
or useful information, and explicitly Broadcast its completed answer or task
result. An ordinary final response that does not invoke one of those intents
stays in Work log. Completed Broadcasts give the next fresh responder coherent
conversation context and tell other agents what has already been done.

## Shared knowledge and immutable scope

Only Broadcasts become shared organizational knowledge.

Direct Messages remain between the user and the addressed agent. Collaboration
remains between its explicit agent recipients. Audit and execution events remain
local to the relevant timelines and diagnostic surfaces.

Ordinary response text and reasoning are scoped to their originating agent and
execution. They are never communications, recipients, deliveries, or shared
knowledge merely because a runtime emitted them.

Communication scope never changes after creation. A private message is not
promoted or converted into a Broadcast. When private information becomes useful
to the organization, an agent creates a new Broadcast that states the durable
finding intentionally.

In short:

- **Broadcast** means tell the organization.
- **Direct Message** means a private exchange between the user and one or more
  explicitly addressed agents.
- **Collaboration** means tell one or more other agents.

## One architecture, two levels of experience

Casual users talk in Project chats as if they were familiar AI chats.
Ponderosa handles fresh agent runs, managed reports, responder changes, and
context boundaries for them.

Power users can inspect and shape organizations of agents and subagents. They can
follow collaboration, audit individual agents, and choose structures appropriate
to their work.

These are not separate product modes. They are two levels of engagement with the
same architecture. The measure of a good design is whether it expands power-user
control without making the default conversation harder to understand.

## Review test for proposed changes

A proposal fits the vision when it can answer yes to these questions:

1. Does the ordinary Project-chat workflow remain understandable without learning
   orchestration concepts?
2. Does each communication have exactly one explicit, immutable purpose and
   audience?
3. Do only intentional Broadcasts enter future-agent shared context?
4. Can power users still inspect and organize agents, subagents, and their work?
5. Are routing identities structured and stable rather than inferred from
   display names or textual mentions?
6. Does audit visibility remain separate from context inheritance?
7. Does the change improve reliability or capability without turning Project chat
   into an execution log?

The canonical UI and domain terms used by this document are defined in
[VOCABULARY.md](./VOCABULARY.md).
