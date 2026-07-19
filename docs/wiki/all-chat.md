---
id: all-chat
title: All Chat
summary: Review communication across Projects in one aggregate timeline while keeping new messages exact and private.
section: Conversations
order: 35
related: communication-scopes,project-chat,agents-and-organization
code: Canonical communication model|packages/core/src/communication.ts;Workspace navigation|apps/web/src/components/WorkspaceSidebar.tsx
---

All Chat is an aggregate inspection surface over canonical communication. It does not create a fourth message scope or a new room-message store. Project chat, Team Chat, Agent Chat, and All Chat continue to project the same authored communication ledger.

## Read across Projects

Use filters and bounded history loading to find a conversation without hydrating every Project or Agent timeline. Each row retains its Project chat, author, audience, and stable message identity so opening the source view cannot change what the message means.

## Send only to an exact Agent

The aggregate composer is intentionally constrained. A new message from All Chat must be a Direct Message to one exact stable Agent ID. Broadcast is forbidden because an aggregate view does not supply one unambiguous organizational audience. Collaboration remains Agent-authored and belongs in Team Chat.

## Treat it as an audit view

All Chat is effectively view-only for every other operation. Replying, editing, reacting, steering, or queueing should send the user to the exact Project or Agent surface where the scope and current execution state are explicit. This prevents an attractive convenience view from becoming a competing conversation authority.
