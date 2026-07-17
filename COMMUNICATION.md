# Communication Scope Contract

Correlated work, joins, activation, and run scheduling are specified separately
in [COMMUNICATION_V3.md](./COMMUNICATION_V3.md).

Communication scope is structural. Message text, `#tags`, the initiating view,
and rendered labels never grant visibility or trigger work.

The executable source of this matrix is `deriveCommunicationBehavior` in
`packages/core/src/communication.ts`.

| Canonical intent | Project chat | Team chat | Agent chat audit | Activation / recipient | Future-agent context |
| --- | --- | --- | --- | --- | --- |
| `broadcast` | yes, when conversation-associated | no | author only | none | organizational |
| user `user_dm` | yes, when conversation-associated | no | explicit agent recipients | explicit agents | local only |
| agent `user_dm` (`direct_to_user`) | yes, when conversation-associated | no | author | user only; no agent run | local only |
| `collaboration` | no | yes, when conversation-associated | author and recipients | explicit agent recipients | local only |
| ordinary runtime output | no | no | no | none | never |

## Invariants

- A broadcast never starts, steers, or queues an agent.
- Only explicit agent recipients may receive a message-derived Activation.
- Correlated agent work is a Request, waiting is an optional Join over immutable
  request IDs, and a reason to run is an Activation. A human or urgent activation
  never implicitly cancels an existing Join. Behavior is never inferred from
  message text.
- The common provider reply may omit routing fields only when the owning Run has
  one canonical incoming Communication. The server inherits its audience,
  Project-chat scope, and visibility from that Activation. It never infers them
  from prose, rendered handles, provider memory, or the initiating UI surface;
  absent or conflicting authority fails closed and requires an explicit intent.
- Sent collaboration is auditable in the author's Agent chat as well as each
  recipient's Agent chat.
- Completed ordinary output belongs to the originating Run and appears in Work
  log. It is not communication.
- Transient reasoning belongs only to the live Run stream.
- `#broadcast`, `#user`, and agent handles are presentation. Routing never
  reparses them.
- V1 `direct_to_user` records remain replayable, but all new bidirectional user
  communication is represented by `user_dm`.
- A plain Project request is represented by both an organizational Broadcast and
  a deduplicated SQLite `Activation` for its one responsible agent. The Broadcast
  itself stays passive; the separate Activation authorizes scheduler action
  without parsing arbitrary tags.
