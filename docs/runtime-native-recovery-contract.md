# Native recovery implementation boundary

Source-only disposition; no provider or test execution.

The existing exact-key `POST /api/agents/:id/context-recoveries` now invokes canonical `contextRecovery.reconcileRecordedCompletion(agentId,id)` on an idle replay. The synchronous owner transaction accepts only an active `native_started` recovery, unchanged original Agent/session/contract/Project/source Run/scope/fence and no surviving provider process authority. Exactly one durable `context_usage` event must bind both provider session fields and `providerCommand` name compact, invocation recovery ID, original execution and fence. Its nonnegative exact usage, optional positive window and event sequence pass the existing acceptance validator. Missing evidence returns false; ambiguous or invalid evidence refuses. This never calls a provider, clears source uncertainty, dismisses a hold or schedules/replays source work. GET is unchanged and read-only.

The event is written by `AgentStore.recordProviderRecoveryContextUsage` only after `routes/provider-commands.ts` has observed a completed native compact with fresh matching-session occupancy and drained the recovery process. The append-only event writer owns filesystem durability separately from the SQLite phase. A crash after the event and before phase advancement can now complete that local phase on exact-key replay. A crash before durable event publication still remains held. No attempt is made to infer a native result from a partial log or resume.

## Actual integrated provider interfaces

- `packages/core/src/adapter.ts`, `RuntimeSession`: startTurn/steer/interrupt/close, optional capabilities/contextUsage/invokeCommand. No native operation status query, query key or idempotency receipt interface exists.
- `packages/engines/src/codex-app-server.ts`, `invokeCommand('compact')`: `thread/compact/start` sends only threadId; its response is an empty acknowledgement. Matching live turn and contextCompaction item completion plus matching usage are the current completion proof. `ThreadResponse` used for open/resume contains thread ID and optional model, not an exact compaction operation receipt. The successor below integrates bounded stored completion readback for exact already observed IDs. It does not provide operation-key lookup across crashes.
- `packages/engines/src/claude-stream-session.ts`: now implements documented native command dispatch plus exact UUID/local-command/manual-boundary completion and subsequent get_context_usage. See claude-native-command-recovery.md. Ordinary startTurn/steer remain separate; interrupt closes the owned process.
- `packages/engines/src/claude.ts`: now advertises managed_compaction with hold_without_native_query. The updated assignment permits documented native command input, while ordinary model prose remains unusable as proof.
- `packages/core/src/context-recovery.ts`: managed recovery explicitly retains hold_without_native_query; context recovery never settles prior uncertain source effects.

The previous no-command-input constraint has been superseded by explicit authorization of the documented command/result protocol. The successor implements Claude completion/occupancy correlation. Native lost-outcome recovery still requires a supported durable native operation identity/result query or provider idempotency guarantee tied to the original session and operation. This source inspection establishes those missing integrations, not universal vendor capability absence. No new provider protocol, session-file parser, HTTP integration, authority callback or automatic mutation retry was invented.

Deferred `tests/providers/provider-recovery.test.mjs` covers recorded completion after phase loss/reopen, absent evidence, repeat idempotency and unchanged unknown source Run/no native commands. Existing unknown-result/refusal fixtures remain. No execution qualification is claimed.


## Official protocol research and bounded integration (2026-11-01)

Read-only research inspected installed package manifests first: Claude Code 2.1.301
(native executable, no installed Agent SDK implementation) and Codex 0.159.2
(launcher/native executable). No provider executable, SDK, schema generator or
installation was run. Current official documentation and upstream protocol source
were then read. No claim of installed-version protocol qualification follows.

### Implemented Codex completion readback

The existing `CodexAppServerSession.invokeCommand('compact')` now reserves five
seconds of its existing 45-second deadline for stored completion readback when live
notifications lost a completion. It requires accepted acknowledgement and BOTH
already observed exact turn/item IDs. It calls `thread/read` to bind the session,
then `thread/turns/list` with `itemsView:'full'`, at most four 100-turn pages. Only
one matching completed/error-free turn with one matching contextCompaction item
confirms completion. Invalid, missing, repeated-cursor, unsupported or timed-out
history stays unknown. No mutating RPC is retried. Readback does not manufacture
occupancy, accept a context recovery or settle original Run/Request effects; the
existing fresh telemetry, fence, policy and observed-drain requirements remain.
There is no new public authority endpoint or second reconciliation engine.

[Official Codex app-server documentation](https://developers.openai.com/codex/app-server)
documents stored-history reads and asynchronous compaction. The upstream
[compact request](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ThreadCompactStartParams.ts)
contains threadId only. Its
[turn-history request](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTurnsListParams.ts)
and [turn receipt](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/Turn.ts)
support exact known-ID readback. A lost start acknowledgement with no captured
turn/item identity still cannot be matched by selecting the newest historical
compaction. Neither a JSON-RPC request ID nor clientUserMessageId is treated as a
provider idempotency guarantee.

Minimal upstream contract for the remaining Codex crash gap: a caller-selected
compaction operation key durably bound before execution, repeat-safe lookup by
that key scoped to the original thread, and terminal receipt plus post-compaction
occupancy (or a read-only occupancy query). For source-turn reconciliation,
provider turn completion alone cannot prove canonical tool/publication effects;
those still need exact host receipts and original Run/fence custody. No endpoint
implementing those stronger guarantees was established by the sources inspected.

### Prior constraint disposition, superseded by native command authorization

Claude DOES document retained-session compaction through native command input:
[official SDK command guide](https://code.claude.com/docs/en/agent-sdk/skills#compact-history-with-compact).
This corrects any suggestion that Claude has no supported compaction at all.
Its compact_boundary reports that compaction ran; a successful result without a
boundary can mean no compaction occurred. The
[official SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)
provides local_command result discrimination, submitted-message correlation and a
separate getContextUsage control. These are useful existing provider surfaces,
not a dedicated structured compact control or a durable compact operation query.

The official Python SDK
[control implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/query.py)
sends get_context_usage through the existing control protocol. Its enumerated
[control request types](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/types.py)
do not define a compact operation. A structured occupancy query cannot perform
compaction. The previous assignment was interpreted as excluding command-input recovery;
therefore no /compact user frame, invented compact subtype or direct Messages API
compaction request was added. ClaudeAdapter was unsupported under that earlier
constraint; the implemented successor below supersedes that disposition. This is a constraint-specific limitation, not universal provider
capability absence.

Minimal upstream contract under that constraint: a documented structured compact
control for the retained exact session, correlated terminal receipt and fresh
occupancy; durable operation-key lookup is additionally needed across lost
outcomes. The subsequent explicit scope change authorizes the documented native command
transport; local-command/boundary verification plus get_context_usage are now
implemented, while lost outcomes stay held.
No permission question or invented protocol is substituted for this distinction.

Deferred `tests/providers/capabilities.test.mjs` adds exact stored turn/item,
foreign session, substitution, duplicate, pagination, unsupported-method and
missing-identity refusal cases. These fixtures have not run. All implementation,
provider compatibility and native behavior remain unqualified until the separately
requested whole testing phase.


## Claude command successor

The documented native command transport is now explicitly authorized and
implemented. See [Claude native command recovery](claude-native-command-recovery.md)
for the exact usable API, proof sequence, canonical fence/drain connection and
deferred fixtures. Earlier structured-control-only disposition above records the
prior constraint, not a current missing Claude implementation. The implementation
does not invent a compact control subtype or infer completion from model text.
Cross-crash lost outcomes without durable provider key/query remain held.
