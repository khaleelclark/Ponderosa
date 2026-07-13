# V1 Communication Contract

Communication scope is structural. Message text, `#tags`, the initiating view,
and rendered labels never grant visibility or trigger work.

The executable source of this matrix is `deriveCommunicationBehavior` in
`packages/core/src/communication.ts`.

| Canonical intent | Project chat | Team chat | Agent chat audit | Delivery / run | Future-agent context |
| --- | --- | --- | --- | --- | --- |
| `broadcast` | yes, when conversation-associated | no | author only | none | organizational |
| user `user_dm` | yes, when conversation-associated | no | explicit agent recipients | explicit agents | local only |
| agent `user_dm` (`direct_to_user`) | yes, when conversation-associated | no | author | user only; no agent run | local only |
| `collaboration` | no | yes, when conversation-associated | author and recipients | explicit agent recipients | local only |
| ordinary runtime output | no | no | no | none | never |

## Invariants

- A broadcast never starts, steers, or queues an agent.
- Only explicit agent recipients may receive a delivery or run trigger.
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
  a canonical `RunTrigger` linking that request to its one responsible agent.
  The Broadcast itself still creates no delivery. The separate trigger authorizes
  the responsible agent's run and local audit without parsing arbitrary tags.
