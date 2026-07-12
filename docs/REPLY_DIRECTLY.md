# Reply Directly

Master chat has two intentionally different reply actions:

- **Reply** keeps the existing behavior: it quotes the selected message. The
  message is routed only when its text contains a valid agent `@mention`;
  otherwise a plain main-chat message spawns a new agent.
- **Reply Directly** is shown only on messages authored by an agent. It quotes
  that message and routes the next send to that existing author, even without an
  `@mention`. It never spawns an agent.

The composer identifies the locked target as `Replying directly to @handle`.
Canceling the reply removes both the quote and the routing lock. Switching chats
also clears the lock.

The client sends one command to `POST /api/master-chats/:id/direct-replies` with
a stable idempotency key. The server verifies that the referenced message was
authored by that active agent in the same main chat, then records both the
manager-visible message and its immutable delivery intent in canonical JSONL.
The durable delivery ledger dispatches or queues the existing agent turn. A
retry returns the original message receipt; a restart repairs the crash window
between canonical append and inbox append without duplicating either effect.

Manager-authored messages, collaboration messages, archived agents, cross-room
agents, mismatched targets, and reuse of a key for a different payload are
rejected. The legacy master-message endpoint rejects direct-routing fields so an
unkeyed split delivery cannot bypass the command.

Direct-reply image uploads retain their successful staged IDs across a transport
retry. Partial upload failures clean up every successful staged object before
surfacing the error; cancel also cleans up unsent staged objects.
