# Ponderosa Vocabulary

Ponderosa uses friendly chat language in the interface and precise lifecycle
language in its domain model. These names are part of the architecture: two
objects with different identity, audience, or lifetime must not share a noun.

| Concept | UI label | Domain name | Definition |
| --- | --- | --- | --- |
| Top-level work boundary | Project | `Project` | Durable home for agents, project chats, work, outputs, and source-folder configuration. |
| Shared user-facing conversation | Project chat | `Conversation` | One durable project workstream shared by the user and its agent organization. |
| Agent coordination projection | Team chat (Agent-only) | `CollaborationView` | Inspectable view of explicit agent-to-agent messages associated with a project chat. It is not a second message store. |
| One-agent audit projection | Chat with *Agent* | `AgentCommunicationView` | Messages actually involving one agent. It is a projection, not another conversation. |
| Persistent participant | Agent | `Agent` | Stable, addressable identity across many runs and provider sessions. |
| Correlated work or consultation | Request | `CoordinationRequest` | Ephemeral work from one requester to one recipient with its own lifetime and outcome. |
| Durable waiting condition | Waiting for | `CoordinationJoin` | Immutable condition over request outcomes; independent from request deadlines. |
| Actionable reason to wake | Ready | `Activation` | Prioritized, durable scheduler input that may be coalesced into one Run. |
| User-authored automatic action | Trigger | `TriggerDefinition` | Durable schedule, signed webhook, or Project-folder watcher owned by one Agent in one Project chat. |
| One normalized outside event | Trigger occurrence | `TriggerOccurrence` | Immutable, deduplicated payload and provenance that creates exactly one queued Activation. |
| One runtime activation | Run | `AgentRun` / `Execution` | Bounded agent activation ending in completion, failure, cancellation, or suspension. |
| Provider-side continuity | Model session (diagnostics only) | `ProviderSession` | Optional Codex/Claude context continued across runs for exactly one agent. |
| Explicit authored communication | Message | `Communication` / `Message` | Immutable content, author, audience, provenance, and project-chat association. |
| Routing operation | Send; Queued, Delivered, Started | `MessageDispatch` | Durably materializes one message in its authorized views and creates zero or more recipient deliveries. |
| Recipient operation | Delivery | `MessageDelivery` | Durable recipient-specific queue and processing state. |
| Runtime activation request | Start / Steer / Queue | `RunTrigger` | Operational decision that starts, steers, or queues a run; it is not a message. |
| Execution-local prose | Work log | `RunOutput` | Ordinary response text and transient reasoning for one run. It is never implicitly sent. |
| Current or historical operations | Activity | `AgentActivitySnapshot` / `ActivityEvent` | Derived current state or chronological execution telemetry. |
| Durable intended work | Work item | `WorkItem` | Optional tracked outcome that may span runs. An assignment is only its ownership relation. |
| Durable output | Files & results | `Artifact` | Inspectable documents, code, images, reports, patches, or links with provenance. |

## Naming rules

- Use **chat** only in user-facing labels. Use `Conversation` for its durable
  domain object and `CommunicationView` for projections.
- Use **Agent** for identity, **Run** in the UI, `Execution`/`AgentRun` in the
  domain, and `ProviderSession` for engine continuity.
- Use **Request** for correlated work, **Join** for waiting conditions, and
  **Activation** for reasons to run. None is a synonym for a message or Run.
- Use **Trigger** for the durable automation definition and **Trigger
  occurrence** for one source event. Neither is a Run, message, or provider
  session.
- Use **Message** for authored semantic content, **Dispatch** for routing,
  **Delivery** for recipient queue state, and **RunTrigger** for activation.
- Use **Work log** for execution-local output. Do not imply that Ponderosa
  exposes a model's private chain-of-thought.
- Use **Work item** for durable intended work. An `Assignment` is a relationship
  between work and an owner, never a synonym for an agent, run, or prompt.
- Use **Reports to** in the UI for agent hierarchy. `managerAgentId` is valid
  only for that reporting relationship; runtime control belongs to an execution
  supervisor or coordinator.

## Retired ambiguous names

- **Master Chat:** replaced by **Project chat** in the UI and `Conversation` in
  the domain. It implied a control hierarchy and said nothing about scope.
- **Thread:** not a canonical Ponderosa V1 noun. It collided with visible
  conversations, reply chains, provider handles, and executions. Provider
  adapters may still use it when an engine protocol does.
- **Thinking:** replaced by **Work log** in the UI and `RunOutput` in the domain.
  The old name conflated observable runtime output with private reasoning.
- **Task:** never use unqualified. Choose `WorkItem`, `AgentRun`, `Dispatch`, or
  tool call according to the actual lifetime.
- **Broadcast** as a user action: prefer **Share with project**. `broadcast` may
  remain an explicit agent communication intent, while the canonical audience
  is the project organization.
- **Room:** infrastructure terminology only. It is not a competing product or
  domain name.

## Canonical relationships

```text
Project
  ├─ Conversation ── Message ── MessageDispatch ── MessageDelivery
  ├─ Agent ── CoordinationRequest ── CoordinationJoin
  │       ├─ TriggerDefinition ── TriggerOccurrence ── Activation
  │       └─ Activation ── AgentRun ── RunOutput / ActivityEvent
  │            └─ ProviderSession (optional continuity)
  ├─ WorkItem ── advanced by AgentRun
  └─ Artifact ── produced by AgentRun and referenced by Message/WorkItem
```

These relationships describe identity and provenance. They do not require every
object to have a dedicated V1 screen.
