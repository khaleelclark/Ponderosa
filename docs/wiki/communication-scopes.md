---
id: communication-scopes
title: Communication scopes
summary: Choose Broadcast, Direct Message, or Collaboration by audience; visibility never changes immutable scope.
section: Conversations
order: 30
related: project-chat,agents-and-organization,all-chat
code: Executable scope matrix|packages/core/src/communication.ts
assets: Communication surfaces screenshot|docs/wiki/assets/communication-surfaces.png
---

Every authored message has one immutable purpose and audience. Ponderosa never infers routing from prose, display names, rendered labels, or the view where a turn started.

![Broadcast, Direct Message, and Collaboration screenshot](/api/wiki/assets/communication-surfaces.png)

## Broadcast

A Broadcast tells the Project organization something durable. It appears in Project chat and may become relevant bounded context for future Agents. A plain Project-chat request is a Broadcast that also creates a separate responsible-Agent Activation. An explicit share-only action records context without waking every Agent.

## Direct Message

A Direct Message is a private exchange between the operator and one or more exact Agent IDs. It may be visible in Project chat and each involved Agent's audit timeline, but it is excluded from future organizational context. One user action remains one canonical message even if Ponderosa creates multiple recipient deliveries.

## Collaboration

Collaboration is Agent-to-Agent communication for explicit stable recipients. It appears in Team Chat and the relevant Agent Chat timelines. It never appears in Project chat or shared context. Correlated work additionally uses a Request, and waiting uses a Join; neither is inferred from the wording of the message.

## Scope does not promote

A private message cannot later become shared by changing a flag. The author creates a new Broadcast that deliberately states the durable finding. This preserves the audience and provenance of the original while making the new organizational claim inspectable.
