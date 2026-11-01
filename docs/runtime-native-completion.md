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

Native prose remains execution telemetry. Explicit voice and nonvoice publication
use scoped host-tool receipts as described below; a native text event alone
never authorizes a Communication.

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

The uncertain-context recovery controller still does not execute recovery.
Its refusal means no recovery operation is mapped for that exact uncertain
boundary; it is not evidence that the native provider has no compaction API.
Codex already has a real structured `thread/compact/start` command, whose
adapter waits for matching acknowledgement, compaction item, completed turn and
fresh session occupancy. That command changes context through managed
compaction, which Bible 1 permits; requiring an unchanged-context diagnostic
turn first is not a separate Bible requirement.

The remaining integration must durably reserve the exact source session/Run,
reconcile and observe old process-group drain, reopen the same native session
with its accepted normal tool/system contract, run that structured compaction,
record its native completion and fresh occupancy, drain the command transport,
then transactionally accept the exact recovery and resume the intended pending
work once. An acknowledgement alone, stale usage or a prompt asking for no
tools does not establish completion. Unknown outcomes stay fenced and must be
reconciled, never blindly retried. The current normal command controller requires
a completed source boundary and the cold command path cannot reconstruct the
full accepted normal contract from its small model/effort hash. Simply bypassing
those checks would turn missing source behavior into an unsafe success claim.

The concrete missing adapter/controller contract is a retained-session command
resume that confirms the accepted system/tool configuration without replacing
it, followed by an idempotent or queryable compaction operation identity and
matching complete-tail usage. Claude's mapped streaming-input transport has no
structured equivalent in this checkout. No provider execution or downloaded
schema was used to assume those semantics.

A feasible host replacement is managed compaction over an immutable full native
transcript snapshot, retained alongside the complete canonical authored and
execution journals. It must preserve the original native session/transcript,
expose that compaction and all omitted-context retrieval links, keep uncertain
old effects explicit, durably fence/drain before accepting a candidate and keep
pending Request lineage. Canonical authored messages alone are not the full
native transcript after unknown native work; the missing provider snapshot
interface must return the exact session identity, complete transcript and
completion/occupancy boundary. No bounded fresh prompt, hidden reset or
fabricated successful recovery is substituted here.

The recovery API now returns source custody reconstructed from durable stores:
source Run/status/session, whether that session is still accepted, exact saved
input/system hashes (not their contents), latest durable Agent event position,
and attached Request IDs. Native-tail completeness and prior effects explicitly
remain unknown. This is crash reconciliation and visible loss reporting, not
recovery acceptance or permission to replay work. Exact-key receipt lookup,
uncertain-write handling and the existing hold remain unchanged.

Browser Event Timing `terminalDelivery` belongs to deferred qualification
instrumentation, not a provider/server terminal-delivery API. It is unchanged.

Regression additions are written in the existing RPC-boundary and native-voice
files for the later combined run. No builds, types, tests, benchmarks, browser
work or runner preparation were performed for this implementation slice.

## Requirement-to-source coverage and unfinished work

| Bible rows | Source in this slice | Remaining implementation |
| --- | --- | --- |
| 1, 2, 6, 13 | Existing identity/session/permission/steering paths are retained; this slice does not write them | Native uncertain-context recovery cannot be completed without the operation above; no context wipe or replacement task is substituted |
| 4, 31 backend | `claude-stream-events.ts`, `claude.ts`, `claude-stream-session.ts` supply native execution partials to existing server/SSE callers | Claude voice receipts and response items now feed the existing host publisher; explicit text publication now reuses the scoped host receipt path; mixed/absent routes and correlated reports retain their ordinary publisher |
| 5 | Existing text budget reused for partial accumulation, with a visible pause notice | No new limit policy or required third-party service introduced |
| 7, 20 | No network login, token gate, remote dependency or credential store added | Existing implementation is inherited; no fresh audit verdict implied |
| 12, 14, 19 | `claude-stream-session.ts` discloses diagnostic loss; exact voice query reaches store facade/authority/projection and `routes/voice-replies.ts` | Source custody/crash reporting is implemented; executable recovery drain/compaction/acceptance remains unfinished |
| 25 | `token-count.ts`, both Codex mappers, `claude-events.ts` retain exact counters and unavailable totals | Executing-process mode admission and frozen selection added; native atomic billed-turn/account identity remains unavailable |
| 30 | Memory authority and default permissions untouched | No new memory implementation credit; use existing local-memory owner’s changes with this runtime stream |
| 31 browser delivery | No source change | `terminalDelivery` in Event Timing collector is qualification instrumentation, deferred by current direction |

No all-commandment, harness-parity, successful-recovery, whole-UI streaming or
performance-completion claim follows from this source slice. The concrete native
recovery controller integration and native atomic account binding above are implementation gaps,
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


## Explicit text publication

`ponderosa_reply_stream` arms one final response on the exact canonical default
route. Its host endpoint is `POST /api/agent-reply-stream`. It reuses the voice
receipt, candidate, steering/memory checks and final canonical publisher, rather
than inferring a reply from ordinary output. Eligible sources include inline
human shared Chat, user Direct Messages and same-Chat passive peer messages;
correlated Request results remain on `ponderosa_update_request`. Mixed or absent
routes and document-backed sources fall back to ordinary explicit publication.
Both adapters normalize the exact new tool receipt. Claude's operation identity
also passes the closed AgentEvent projection; an orphan operation identity or
an error receipt is rejected.

The durable SSE envelope remains `voice_reply` to reuse one cumulative reply
state. Snapshots include `presentation: text`, `replyIntent` and exact peer
recipient IDs where applicable. Absent presentation means existing voice data.
Consumers must scope provisional text by project/Chat/Agent/source message/Run
and route it by the host reply intent, never infer a shared Chat from prose.
Text snapshots must never trigger speech. The bounded source status endpoint is
`GET /api/conversations/:id/reply-streams/:messageId/:agentId`; the previous voice
status endpoint remains valid for a text DM as well. The original canonical
publisher commits the complete message once after successful provider completion;
provisional bytes never become a separate authored log or context source.
Interrupted persisted drafts retain their text and derive failed state from the
durable terminal Run outcome. Reading status does not append an event.

## Native billing admission

The human selection is frozen during Run preparation, included in the immutable
session contract and passed through all launch callers. Codex reads `account/read`
over the executing app-server before opening a thread, each start/steer and
host dynamic-tool dispatch. Account-update generation changes during admission
refuse the operation. Explicitly selected-mode one-shot callers use this same
native app-server path rather than a separate cached CLI status probe. Claude
snapshots existing environment selectors at process creation; API mode requires
a sole configured API key, while subscription refuses API/proxy selectors.
No key is collected, persisted, printed, exported or changed by this logic.

These are real admission boundaries, not a native transaction. An external
account change after the read but before native request acceptance, native
credential refresh inside a running turn, subscription profile changes and
provider-managed key helpers still need a native expected-account/mode parameter
on turn/steer/refresh, or a provider-owned immutable account binding for the
session. The current mapped interfaces do not expose that transaction. No
successful atomic account-lock claim follows from these source changes.

Regression source extends native voice/publication, RPC boundaries and recovery
fixtures. All execution, builds, typechecks, browser work and test preparation
remain deferred under the implementation-first direction. UI consumer work is
owned by the web lane; it was coordinated and is not changed in this worktree.
