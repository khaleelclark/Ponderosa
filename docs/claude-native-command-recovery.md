# Claude retained-session native command recovery

Source implementation only. No provider, Node, tests, build, types, installation
or preparation was executed. Native/provider compatibility remains unqualified.

## Existing usable path

`ClaudeAdapter.contextRecoverySupport` now advertises managed_compaction with
crashReconciliation hold_without_native_query. The existing exact-key
`POST /api/agents/:id/context-recoveries` uses its existing `openSession` and
`invokeCommand('compact')` calls; no new endpoint, engine branch or authority
callback was added. Existing canonical Agent/Project/source Run/session/contract/
scope/fence validation, policy checks, pre-command native_started commit and
observed process drain before durable context acceptance remain unchanged.
Original source work stays held_unknown. Context recovery never replays it.

The existing provider-commands route can also invoke the runtime-classified
compact command on an accepted retained normal contract. Cold-session capability
reads wait at most five seconds for initialization; command invocation has one
45-second total budget. Unknown/unsupported initialization sends no command and
still returns a conservative unknown outcome to the already fenced caller.

## Native proof

ClaudeStreamSession owns one stdout reader, including when an idle recovery has
no ordinary event consumer. A standard bounded stream preserves normal-event
backpressure; ending one ordinary iterator does not destroy the reusable stream.
Native command frames are consumed internally and do not become normal Agent
turn completion, authored text, publication, usage telemetry or future Run input.

Before dispatch, a matching initialize control response must actually advertise
compact. A retained session or a previously initialized current session is
required. The adapter sends exactly the documented `/compact` command with a
new submission UUID on that owned CLI transport. This bypasses startTurn/steer,
normal history seeding and source-work dispatch. It never sends instructions
asking the model to report success.

Completion requires all of:

- Actual system/init for the exact provider session and model.
- Exact current UUID acknowledgement from replay-user-messages.
- One non-replayed manual compact_boundary after that acknowledgement.
- Non-error success result with local_command compact and the exact submitted
  user_message_uuid. Any supplied UUID collection must contain that UUID alone;
  merged work, custom commands and ordinary success prose refuse.

Only then does the adapter send a new correlated control_request with documented
subtype get_context_usage. A successful matching control response must report
nonnegative safe totalTokens, positive rawMaxTokens and the unchanged exact
model. The control is requested after native completion, uses full provider
counting by default and cannot be replaced by earlier context getters, boundary
pre_tokens, result aggregates, model text, session resume or process exit.
Returned RuntimeCommandResult has outcome completed and contextUsage bound to the
provider session. Every other result is unknown and prevents another native
command or ordinary turn in that session. Stop/close/transport loss cancels the
pending proof; no late response can revive cancelled acceptance.

The host then performs its existing same-owner/fence/access checks and drains
recovery process authority before writing its exact invocation-bound occupancy
event and accepting context. A crash after that durable event can use existing
reconcileRecordedCompletion. A crash before the event remains held; the adapter's
live submission UUID is not a provider-owned durable idempotency key.

## Provider sources and remaining limits

[Official Claude command documentation](https://code.claude.com/docs/en/agent-sdk/skills#compact-history-with-compact)
documents native command input and the compaction boundary. The
[official TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
describes local_command and submitted-message correlation plus getContextUsage.
The verified official Python SDK
[control implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/query.py)
uses subtype get_context_usage, and its
[response contract](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/types.py)
provides totalTokens/rawMaxTokens/model. No compact control subtype was invented.
Installed Claude Code manifest observed 2.1.301; compatibility with these exact
wire receipts has not been executed or otherwise qualified. Older/missing receipt
fields refuse conservatively instead of inferring success from result prose.

Lost native outcomes without provider-owned durable key/result lookup remain
unreconciled. Source-turn completion and canonical effects remain separate. No
provider HTTP integration, SDK install, session-file parser, historical log replay,
new scheduler activation or Request/Join settlement was introduced. Codex stored
completion fallback from parent 0dc8e232d is preserved unchanged. Whole work and
whole testing remain incomplete.

Deferred claude-native-compaction fixture source covers exact receipts, no-op and
ordinary-text refusal, foreign/merged/replayed/automatic/duplicate evidence,
invalid/stale occupancy, actual idle stream consumption without an event reader,
no native output leakage and reusable subsequent ordinary event readers. Existing
provider-recovery fixtures now expect the Claude managed support descriptor;
canonical recovery/fence/drain/refusal coverage remains in that existing suite.
The controlled fixtures are not real Claude/native qualification.
