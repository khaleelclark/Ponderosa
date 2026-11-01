# Native compaction after a lost acknowledgment

M2 disposition, researched 2026-11-01 against host source
`595681b750776c5f3c765de1f040f0931f6d8750`. Bible #1/#4/#12 remains
incomplete for a compaction that may have run but whose native operation IDs and
result were never retained. No safe additional mutation or no-ID result lookup
was established in the pinned public contracts below. This is a specific
contract gap, not a claim that either harness lacks compaction or history.

## The host already reserves the operation

`CoordinationV3ContextRecoveryAuthority.request` binds the recovery ID and caller
idempotency key to Agent, Project, source Run, scope, native session, normal
contract and source fence. `reserveOperation` commits before native input;
`advanceOperation` persists `native_started` and `nativeInvoked`. Another key
cannot repeat an unresolved native mutation. Restart never reissues it.

`reconcileRecordedCompletion` closes the separate local event-to-phase commit
gap using the exact durable context-usage event. Codex live command readback
can also confirm stored completion for **already observed** exact turn/item IDs.
Neither path reconstructs an identity that was never recorded. Adding another
host journal or passing the host key in an unsupported native field would not
create that missing provider binding.

## Codex: compact has no caller-key field

Pinned official source: `openai/codex`
`cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2`.

| Surface | Contract and consequence |
| --- | --- |
| [ThreadCompactStartParams](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ThreadCompactStartParams.ts) | Only `threadId`; no caller-selected compaction key. |
| [ThreadCompactStartResponse](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ThreadCompactStartResponse.ts) | Empty response, not a terminal operation receipt. |
| [TurnStartParams](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts) | `clientUserMessageId` exists on ordinary turn input; it does not extend the compact request. |
| [ThreadItem](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts) | A user message has `clientId`; a context-compaction item has its native `id`, without a caller key. |
| [Turn](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/Turn.ts) and [ThreadTurnsListParams](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTurnsListParams.ts) | Stored turn/status/items support known-ID reads, without compact-key selection. |

A JSON-RPC request ID correlates a transport response. These schemas do not
establish durable idempotency or lookup of compact execution by that ID. A new
`turn/start`, a marker prompt or selecting the newest compact would introduce
another native mutation or guess ownership. None is recovery of the exact lost
operation. Ordinary source-turn client IDs may help a separate source-receipt
implementation; they do not settle a compact or canonical host-tool effects.

## Claude: caller UUIDs do not supply a durable compact-result query

Read-only inspection covered published `@anthropic-ai/claude-agent-sdk`
[0.3.301](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.301)
and [0.3.316](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.316),
including each tarball's `package/sdk.d.ts`. The earlier release corresponds to
the reported installed Claude Code 2.1.301 generation; neither SDK was installed
or executed. The official [pinned changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/3a0b748adbb1d31fa66a24a15df7e7c973fe1368/CHANGELOG.md)
records the release/native-version correspondence.

| Type/API in both distributions | What it establishes |
| --- | --- |
| `SDKUserMessage.uuid` | Caller can choose a message UUID. No repeat-safe mutation guarantee follows. |
| `SDKResultSuccess` | Live terminal fields include session/result UUID, optional `user_message_uuid(s)`, `local_command` and `result_index`. Losing this frame does not turn its sequence number into a stored lookup API. |
| `SDKControlRequest.request_id` | Unique among in-flight requests, echoed by the response/cancel. It is transport correlation, without a durable operation-key guarantee. |
| `SDKCompactBoundaryMessage` | Session and boundary UUID, manual/auto trigger and token/timing/preservation metadata. No caller-message UUID, control request ID or host operation key. Its own UUID identifies that boundary only after it is observed. |
| `getSessionMessages` / `SessionMessage` | Can include stored system messages via `includeSystemMessages`; returned roles are user/assistant/system, not terminal result receipts. Finding the submitted user UUID proves a retained message, not completion of its compact. |

SDK declaration byte pins, not runtime qualification:

| Release | `sdk.d.ts` bytes | SHA-256 |
| --- | ---: | --- |
| 0.3.301 | 547578 | `26f9a0c91ad64e2020f0d3734932302e3cc09685bddf2b2f9ef60839ce278773` |
| 0.3.316 | 569668 | `c7b4242562a4501812a86af97d4fb6d9cd3f631798442f692339b8a90a0c0f8a` |

The [official SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)
describes these live correlations, stored-message reads and native command
results. Its [command guide](https://code.claude.com/docs/en/agent-sdk/skills#compact-history-with-compact)
documents `/compact`; implementing that live path is separate M1 work. It does
not establish read-only recovery of its lost result by caller UUID. A stored
manual boundary near a user message is not an explicit command-to-boundary
binding. The Python SDK's pinned [session reader](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/sessions.py)
and [types](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/types.py)
expose a narrower user/assistant history surface; do not infer TypeScript's
system-message option exists on that version.

## Required external contract for the no-ID gap

The missing semantics are specific; no hypothetical RPC is implemented here:

1. Before execution, bind a caller-selected operation key durably to the exact
   native session and compact request. Reject reuse with different inputs.
2. Supply a read-only lookup by that key across process/client restart. Return
   explicit unaccepted/running/terminal/unknown states; absence must not imply
   that a mutation had no effects.
3. Bind the terminal compact boundary/result and any usable post-compaction
   occupancy to that same operation and session. An independent current usage
   read must identify the context generation to which it applies.
4. Document retention/completeness and concurrency behavior. If the only
   available interface repeats submission, the provider must explicitly
   guarantee deduplication; otherwise the host must not repeat it.

With that contract, the existing durable recovery ID can bind the native key
before invocation, and reconciliation can validate exact session/source/fence
and receipts without resubmission. Legacy operations without a native binding
remain unknown. Context acceptance still cannot mark the original source Run,
Requests, tool calls or publication effects successful; M3 owns those receipts.

Until then the usable behavior is the existing visible retained hold, explicit
Stop/drain and already-recorded-event/known-ID reconciliation. M2 is externally
blocked at the no-ID seam, not completed by a second host reservation. This does
not block unrelated implementation. No Bible criterion or recovery guard is
weakened. No tests/checks/builds/types/Node/native/SDK/browser/provider execution,
runner/readiness preparation, dependency installation or credentials were used.
