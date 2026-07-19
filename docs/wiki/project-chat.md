---
id: project-chat
title: Project chat
summary: Use the approachable shared conversation while keeping execution detail and private coordination in their proper views.
section: Conversations
order: 20
related: communication-scopes,agents-and-organization,runs-and-results
code: Conversation surface|apps/web/src/components/ConversationView.tsx;Communication policy|packages/core/src/communication.ts
assets: Communication surfaces screenshot|docs/wiki/assets/communication-surfaces.png
---

Project chat is the human-facing conversation and the Project's curated shared timeline. It should read like the story of the work, not like terminal output. Different responder names may be the only orchestration detail a casual user sees.

## Plain requests

A plain user message is a shared organizational message plus a separate scheduler Activation for one responsible Agent. The message stays passive after creation; the Activation is what authorizes execution. This distinction prevents a replayed chat projection from starting duplicate work.

The responsible Agent's ordinary provider response appears in **Work log**, not Project chat. An Agent must deliberately send a communication when another participant needs the result. That keeps transient output, tool calls, and command logs out of the shared conversation.

## Direct messages

Addressing an exact Agent creates a private Direct Message. It remains visible once in Project chat for the operator, but future Agents do not inherit it as organizational knowledge. A user message written from an Agent's Chat view is the same canonical Direct Message, not a second conversation.

## Team Chat

Team Chat shows explicit Agent-to-Agent Collaboration associated with this Project chat. It is a projection of the canonical communication ledger. Collaboration never appears in Project chat automatically; publish a new intentional shared message when a private finding becomes durable Project knowledge.
