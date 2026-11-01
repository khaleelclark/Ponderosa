# Native runtime implementation

Both configured subscription and API-key modes use the existing Codex/Claude
harness adapters. Billing-mode selection describes the expected native login;
it does not collect credentials or change Agent identity, history or permissions.

## Exact token counters

Provider token counters must be nonnegative safe integers. Missing, malformed,
negative, fractional or overflowing counters are unknown, never zero. A total
is derived only when input and output are both known. A valid explicit Codex
app-server total, including zero, remains authoritative. Cache/reasoning subsets
are retained without being added twice. Claude input includes its separately
reported uncached, cache-read and cache-creation counts; omitted cache fields
are zero, but missing uncached input or invalid supplied cache fields leave the
combined input unknown. Request aggregates that exceed exact integer precision
are unavailable. This is usage reporting, not a cost estimate.

## Claude execution streaming

Both one-shot and retained Claude sessions request native partial messages.
A per-process mapper accepts only main-session text blocks with a matching
session and native message identity. Native tool and result events still pass
through the existing shared normalizer. Partials enter the existing durable
execution-output/SSE path; they never become authored Chat, shared memory or a
reply authorization. Completed assistant blocks reconcile streamed prefixes:
only the missing suffix is appended. If the provider corrects a prefix, the Work
log explicitly labels and retains the complete corrected text. Missing partials
fall back to complete native text. The partial accumulator uses the existing
canonical text-byte budget; overflow waits for the complete snapshot rather
than claiming a truncated answer is complete.

This supplies execution streaming, including task/Branches readers of that
stream. It does not authorize ordinary native prose as a user reply. Claude
voice uses the explicit host-tool receipt flow described below; incremental
canonical Communication for non-voice replies remains separate implementation
work.

## Diagnostic and voice retention

Persistent Claude stderr uses the same bounded Unicode-safe tail and cumulative
omission notice as the other native transports. Root-exit details retain the
final cause with the existing validated/redacted server projection.

Voice status selects the latest persisted snapshot for the exact Agent, input
message and scheduler Run. It no longer searches only the last 256 unrelated
Agent events. The append-only event log remains canonical; the existing event
index supplies this bounded one-row projection. Live snapshots and all existing
scope, product, memory-exposure and Run checks remain in place.

## Recovery prerequisite and scope

The native adapters still provide no operation that both prevents all native
and host effects under the unchanged normal session contract and returns
trustworthy acknowledged completion plus complete-tail occupancy evidence.
`thread/compact/start`, a prompt asking for no tools, read-only filesystem mode,
and a new ordinary turn do not establish that operation. No diagnostic or
recovery turn is launched by this change, and no unsupported bit is presented
as recovery. The existing durable hold remains honest. Implementing native
recovery requires that concrete native operation before recovery-linked drain,
proof, canonical acceptance and exact-once continuation can be completed.

Browser Event Timing `terminalDelivery` belongs to deferred qualification
instrumentation, not a provider/server terminal-delivery API. It is unchanged.

Regression additions are written in the existing RPC-boundary and native-voice
files for the later combined run. No builds, types, tests, benchmarks, browser
work or runner preparation were performed for this implementation slice.

## Requirement-to-source coverage and unfinished work

| Bible rows | Source in this slice | Remaining implementation |
| --- | --- | --- |
| 1, 2, 6, 13 | Existing identity/session/permission/steering paths are retained; this slice does not write them | Native uncertain-context recovery cannot be completed without the operation above; no context wipe or replacement task is substituted |
| 4, 31 backend | `claude-stream-events.ts`, `claude.ts`, `claude-stream-session.ts` supply native execution partials to existing server/SSE callers | Claude voice receipts and response items now feed the existing host publisher; non-voice canonical user-response streaming still needs implementation; native prose must not be published automatically |
| 5 | Existing text budget reused for partial accumulation, with a visible pause notice | No new limit policy or required third-party service introduced |
| 7, 20 | No network login, token gate, remote dependency or credential store added | Existing implementation is inherited; no fresh audit verdict implied |
| 12, 14, 19 | `claude-stream-session.ts` discloses diagnostic loss; exact voice query reaches store facade/authority/projection and `routes/voice-replies.ts` | Native recovery drain/proof/acceptance and crash reconciliation remain unfinished; diagnostic and voice changes do not prove recovery |
| 25 | `token-count.ts`, both Codex mappers, `claude-events.ts` retain exact counters and unavailable totals | Native billing selection/same-Agent switching remains the inherited implementation; transactional account identity at launch and credential refresh races are not solved by usage normalization |
| 30 | Memory authority and default permissions untouched | No new memory implementation credit; use existing local-memory owner’s changes with this runtime stream |
| 31 browser delivery | No source change | `terminalDelivery` in Event Timing collector is qualification instrumentation, deferred by current direction |

No all-commandment, harness-parity, successful-recovery, whole-UI streaming or
performance-completion claim follows from this source slice. The concrete native
recovery operation and the non-voice publication work above are implementation gaps,
not merely tests waiting to run. Real-account/device checks remain later manual
qualification; they do not block these source changes.


## Claude explicit voice publication

The native MCP bridge forwards its own operation identity to the existing voice
route. A successful host authorization returns that identity with the scoped
stream ID. The Claude normalizer remembers only the current main-session native
`mcp__ponderosa__voice_reply` call, accepts only its successful single-text
receipt, and emits the operation/stream acknowledgement. Unrelated results,
subagent results, prose and failed tools cannot arm candidate output. This
bridges the native tool-use ID and MCP request ID without treating the tool name
alone as publication authority.

After that explicit authorization, the next native text item is marked as a
final candidate, including partial bytes. Native tool starts revoke that phase.
The existing host VoiceReplyStream compares the exact operation and stream,
requires its successful acknowledgement, binds the candidate item and Run,
invalidates on subsequent work or steering/context changes, and publishes only
a successful completed answer through the existing canonical message route.
No separate Chat store, routing inference or provider-native reply is added.
Missing partials use the completed item; multiple answer items, failed receipts
and unknown outcomes retain the existing fail-closed fallback. The existing
memory speech checks remain unchanged.
