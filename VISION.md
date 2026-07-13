# Ponderosa Product Vision

## What Ponderosa is

Ponderosa is a web interface for working with AI agents running on your own
computer. It should remain useful when you are away from that computer,
especially from a phone.

The default experience should feel as approachable as ChatGPT: open a Master
Chat, describe what you want, and receive a useful response. Behind that simple
conversation, Ponderosa can start fresh agent runs, preserve the right context,
delegate work, and coordinate multiple agents.

The same product must also serve power users who want to create organizations of
models in whatever structure suits their work. They can create agents and
subagents, inspect collaboration, and understand how work moves through the
organization. This complexity stays behind the scenes until a user chooses to
engage with it.

## Product principles

1. **Simple by default, powerful by choice.** A new user should only need to
   understand Master Chat. Advanced organization and orchestration are optional.
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

## Interaction and execution state

When an agent is already responding, a new direct message steers its active turn
by default. Queue is an explicit alternative shown only while the manager is
drafting to that running agent. This keeps conversation fluid without removing
the ability to schedule a follow-up at a safe turn boundary.

Typing/responding indicators and elapsed-time stopwatches reflect canonical
execution ownership. Drafts, selected chat/detail tabs, and reading position are
restored across navigation and refresh so inspecting another agent does not
discard the manager's place.

Agent Detail separates durable views of the same execution domain: Chat for
explicit communication, Thinking for ordinary runtime output, Activity for the
chronological command/test/tool/file feed, Changed Files for the canonical
agent-attributed file set, Review for the current Git working tree and safe
diff/file inspection, Tasks for structured work state, and Artifacts for durable outputs.
Sources remain attached to their message in a compact footer. Generated PDFs are
previewable and downloadable as project-scoped artifacts.

Engine processes may stay warm briefly for responsive steering and follow-up,
but idle agents must not retain an unbounded process and MCP stack. Canonical
provider session identity survives process teardown so a later turn can resume
without making runtime residency part of the product's memory model.

## Projects and agent organization

Selecting an existing working folder when creating a project is optional. A
manager may choose a registered folder, create a new empty managed folder, or
accept Ponderosa's managed default. Projects can be renamed or permanently
deleted; deletion removes Ponderosa-owned chats, agents, executions, artifacts,
and projections without deleting the selected source folder.

Delegation history and organization are different facts. Delegation provenance
records how work originated and never changes. Organizational parentage controls
where an agent appears now and can be promoted, demoted, or re-parented without
rewriting execution history.

Delegated work always settles. An explicit completed or blocked outcome is
preferred. If a delegated runtime ends cleanly without declaring one, Ponderosa
uses its durable completed response as the terminal result; if there is no
result, it marks the objective blocked. The parent is notified in either case.

## The communication model

Ponderosa has three communication surfaces. Each has one purpose.

### Master Chat

Master Chat is the primary interface between the user and the AI organization.
It is both the user's conversation and the project's shared timeline. It should
read like the story of the project, not a dump of execution logs.

Different agents may respond over the course of a Master Chat. For a casual
user, the changing responder name can be the only visible indication that an
organization is working behind the conversation.

Two message scopes appear in Master Chat:

- **Broadcast:** The user or an agent tells the organization something durable.
  Broadcasts become shared knowledge available to future agents.
- **Direct Message:** The user and one or more explicitly addressed agents
  communicate privately. The message is visible once in Master Chat but does
  not become shared context for future agents.

A plain user message in Master Chat is a Broadcast and starts a fresh agent to
handle it. This is the familiar default chat workflow: the request remains part
of the shared project story while Ponderosa handles assignment behind the
scenes. It is rendered exactly as the user typed it, without an automatic scope
prefix. Starting a message with `#broadcast` records shared informational
context without starting an agent and retains that visible prefix. Starting with
one or more agent `#names` creates one Direct Message with that immutable
audience and one delivery per addressed agent. Only an explicit `#everyone`
action may wake every agent. Broadcast context is supplied from the current
Master Chat at a turn boundary; it is not copied into private agent history.

Agent `#names` in rendered message history are links to the corresponding Direct
Agent Chat, making the visible recipient or referenced agent directly
inspectable. Scope labels such as `#user`, `#broadcast`, and `#everyone` retain
the same visual treatment but are not links because they identify an audience,
not an agent.

Important collaboration results do not automatically become Broadcasts. An agent
must deliberately publish durable knowledge or deliberately tell the user. This
keeps Master Chat useful and prevents coordination traffic from overwhelming the
project narrative.

An agent's ordinary runtime response is not a fourth communication scope. It is
execution data shown in that agent's Thinking tab. Only an explicit Broadcast,
Direct Message, or Collaboration event may appear on a communication surface.
Ponderosa never guesses scope from response text, mentions, or the room that
started the turn.

### Collaboration Chat

Collaboration Chat is exclusively for agent-to-agent communication. An agent
chooses one or more explicit recipients and supplies the message. Ponderosa owns
routing and renders recipient labels; agents do not manually construct textual
mentions.

Collaboration messages do not appear in Master Chat and do not become shared
context for future agents. If a finding matters to the organization, an agent
creates a new Broadcast. If it matters only to the user, the agent creates a
Direct Message.

### Direct Agent Chat

Direct Agent Chat is an agent's complete inbound and outbound audit timeline. It
is a hub over existing communication and activity, not a separate conversation
or an additional message scope.

The Chat tab can show:

- user messages;
- Direct Messages;
- Broadcasts;
- collaboration messages;
- assignments;
- explicit communication to or from that agent.

The adjacent Thinking tab shows ordinary response text and transient reasoning,
chronologically and associated with the originating execution. Completed
response text is durable canonical execution data. Thinking never becomes
future-agent context and never creates or triggers a delivery.

When a user writes from this surface, the result is a Direct Message addressed to
that agent. It remains visible in Master Chat without creating a duplicate
canonical message.

Broadcasts remain in their originating Master Chat and may be supplied as that
room's shared context. They are never retroactively copied into a new agent's
Direct Agent Chat. An agent's own explicit Broadcast remains visible in its audit
timeline, but another agent's Broadcast never masquerades as local authorship.

Direct Agent Chat exists for debugging, transparency, and understanding an
individual agent. Its contents do not become shared knowledge merely because
they are visible there.

Emoji reactions are a lightweight user shortcut for sending feedback to the
specific agent who wrote a message. Only users can react, and only to
agent-authored messages. Picking any emoji displays it on that canonical message
without adding a new chat entry. The author receives a private notification with
the original message attached as reply context. Agents cannot create reactions,
and reaction notifications never become organizational context.

For ordinary conversation, a plain Master Chat request creates shared work. The
responsible agent can Direct Message the user with a question, private progress,
or useful information, and explicitly Broadcast its completed answer or task
result. An ordinary final response that does not invoke one of those intents
stays in Thinking. Completed Broadcasts give the next fresh responder coherent
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

Casual users talk to Master Chats as if they were familiar AI conversation
threads. Ponderosa handles fresh agent runs, delegation, responder changes, and
context boundaries for them.

Power users can inspect and shape organizations of agents and subagents. They can
follow collaboration, audit individual agents, and choose structures appropriate
to their work.

These are not separate product modes. They are two levels of engagement with the
same architecture. The measure of a good design is whether it expands power-user
control without making the default conversation harder to understand.

## Review test for proposed changes

A proposal fits the vision when it can answer yes to these questions:

1. Does the ordinary Master Chat workflow remain understandable without learning
   orchestration concepts?
2. Does each communication have exactly one explicit, immutable purpose and
   audience?
3. Do only intentional Broadcasts enter future-agent shared context?
4. Can power users still inspect and organize agents, subagents, and their work?
5. Are routing identities structured and stable rather than inferred from
   display names or textual mentions?
6. Does audit visibility remain separate from context inheritance?
7. Does the change improve reliability or capability without turning Master Chat
   into an execution log?
