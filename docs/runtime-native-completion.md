# Native runtime implementation

Both configured subscription and API-key modes use the existing Codex/Claude
harness adapters and their already configured native authentication, with no
separate billing selector. Ponderosa does not collect credentials or change Agent
identity, history or permissions.

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

## Retained contracts and managed recovery

Future provider-input V3 manifests retain `normalRuntimeContract`: exact engine,
working-copy identity/path, model, effort, speed, tool
schemas and native restriction configuration. The exact system text already lives
in the same provider-input record. The existing accepted-session event selects
that record; later rejected packets cannot become its contract. Capability tokens,
credential environments and old callback closures are excluded. Speed is now part
of the session hash. Legacy sessions without the full contract remain held.

Cold native commands can reopen the accepted session with that retained normal
configuration instead of reconstructing a small model hash. Commands have no
scheduler Run and cannot borrow an expired Run's host-tool or elicitation authority.
Current human restrictions must still match. Normal native
capabilities are retained; no permission change or fresh task is used as recovery.

Codex advertises `managed_compaction`, with `hold_without_native_query` crash
reconciliation. The explicit recovery POST reserves its exact unknown source in
SQLite, observes old process-group exit, reopens the same native thread with the
retained contract, durably records `native_started`, invokes the existing structured
`thread/compact/start` mapping, and requires matching compaction completion and
fresh occupancy. It observes command-process exit before accepting those context
measurements. The phases are `reserved`, `drained`, `native_started`,
`context_accepted`, or `held`; every transition rechecks source Run/session/fence.
The original storage hold state remains `unsupported_fenced` for the scheduler's
existing admission check; `progress` and the response code describe executable
recovery instead of treating the storage label as a success verdict.

No native input is repeated after a crash or lost reply. The same key returns its
saved phase; another key cannot repeat an uncertain native compaction of that same
session. Cleanup retains working-folder use and admission barriers until observed
exit, with visible diagnostic logs. Explicit Stop targets the exact recovery ID
and aborts/drains its process; status is read through the existing GET. Shutdown
and deletion fence the command before native input or acceptance. No startup worker
replays a recovery. Unknown legacy sessions retain the refusal path. Claude uses its native command,
exact UUID/local-command/manual-boundary receipts and a separate fresh usage
control; see [the current recovery contract](runtime-native-recovery-contract.md).

`context_accepted` means that exact compaction completion and occupancy were
persisted after process drain. It is not evidence that the original uncertain
Run completed or had no effects, and is not a low-water/dispatch authorization.
Original Runs, Requests, Joins, injections and authored history remain unchanged.
The response explicitly reports `sourceWork: held_unknown`. The active hold remains until explicit dismissal. The acceptance references one
canonical context-usage event, not a second telemetry store. After dismissal,
independent new work may use that exact retained-session measurement if no newer
injected Run or unmetered work invalidated it. Original unknown work is never
requeued. Missing acceptance still leaves the original uncertainty guard intact.
This supplies work-once custody by refusing blind reissue, rather than pretending
to finish unknown original work.

The exact remaining native seam is source-turn reconciliation: the mapped
`ThreadResponse` from Codex `thread/resume` contains only `thread.id` and model,
not a complete original turn/transcript/outcome boundary. `thread/compact/start`
returns an empty acknowledgement and accepts only `threadId`; it has no mapped
client operation key or lookup for a lost result. Thus the host cannot decide
whether an original unknown turn or a crashed compaction completed, recover a
complete unseen native tail, or resume original work exactly once from that fact.
Known-ID stored completion readback is now implemented for Codex, and exact
host-effect receipt inspection is implemented separately. A durable caller-key
compaction lookup and evidence for unreceipted original effects are still needed
for the remaining crash gaps. This is
separate from the host retention/reservation/drain/acceptance plumbing now present.
No new provider call/schema is invented to fill that seam. A host replacement
would need the immutable complete native transcript as input; authored Chat alone
cannot reconstruct unseen native work without losing history.

The recovery GET remains read-only and returns source custody, saved input/system
hashes, durable event position, attached Request IDs and saved progress. Native-tail
completeness and prior effects remain explicitly unknown. It never probes a provider.

Browser Event Timing `terminalDelivery` belongs to deferred qualification
instrumentation, not a provider/server terminal-delivery API. It is unchanged.

Regression additions are written in the existing RPC-boundary and native-voice
files for the later combined run. No builds, types, tests, benchmarks, browser
work or runner preparation were performed for this implementation slice.

## Requirement-to-source coverage and unfinished work

| Bible rows | Source in this slice | Remaining implementation |
| --- | --- | --- |
| 1, 2, 6, 13 | Existing identity/session/permission/steering paths are retained | Exact normal contracts and both providers' managed compaction are implemented; lost native identities and unreceipted original effects remain held |
| 4, 31 backend | `claude-stream-events.ts`, `claude.ts`, `claude-stream-session.ts` supply native execution partials to existing server/SSE callers | Claude voice receipts and response items now feed the existing host publisher; explicit text publication now reuses the scoped host receipt path; mixed/absent routes and correlated reports retain their ordinary publisher |
| 5 | Existing text budget reused for partial accumulation, with a visible pause notice | No new limit policy or required third-party service introduced |
| 7, 20 | No network login, token gate, remote dependency or credential store added | Existing implementation is inherited; no fresh audit verdict implied |
| 12, 14, 19 | `claude-stream-session.ts` discloses diagnostic loss; exact voice query reaches store facade/authority/projection and `routes/voice-replies.ts` | Durable reservation/drain/native-mutation/context-acceptance phases are implemented; unknown source effects remain held |
| 25 | `token-count.ts`, both Codex mappers, `claude-events.ts` retain exact counters and unavailable totals | Both configured native harness modes retained without a separate selector; exact legacy session digests preserve unchanged context. External/native refresh races are a limitation, not a Bible prerequisite |
| 30 | Memory authority and default permissions untouched | No new memory implementation credit; use existing local-memory owner’s changes with this runtime stream |
| 31 browser delivery | No source change | `terminalDelivery` in Event Timing collector is qualification instrumentation, deferred by current direction |

No all-commandment, harness-parity, successful-recovery, whole-UI streaming or
performance-completion claim follows from this source slice. Native compaction
without retained identities and unreceipted original effects remain separate
recovery limits; see [current reconciliation](native-harness-reconciliation.md).
Atomic billed-account locking against external account changes is not a Bible 25
requirement and does not block the implemented human mode switch. Real-account/device checks remain later manual
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

## Native authentication and retained sessions

Ponderosa uses the authentication already configured in Codex or Claude Code,
without a separate billing page, login flow or expected-mode preference. The
existing native-auth probes, credential exclusion and ambiguous-credential holds
remain. Launches pass the configured environment through the shared harness.

Observed authentication mode remains part of session compatibility. A retained
digest from the removed selector is accepted only when recomputing the complete
old contract with the currently observed mode produces that exact digest. New
sessions omit the selector. Changes to native mode, provider/model, tools,
permissions, instructions or scope still invalidate compatibility; unknown-outcome
and cleanup holds are unchanged. No provider history is reseeded solely because
the selector field disappeared.

Saved selector preferences have no execution authority. Obsolete clients receive
HTTP 400 when writing `providerBillingModes` and must reload/update. Existing
unrelated preferences remain; this correction changes no native credentials.
Native authentication observation is not an atomic account lock against external
credential changes, and Ponderosa does not invent one.

Regression source extends native voice/publication, RPC boundaries and recovery
fixtures. All execution, builds, typechecks, browser work and test preparation
remain deferred under the implementation-first direction. UI consumer work is
owned by the web lane; it was coordinated and is not changed in this worktree.


## Recorded audio attachment backend

The existing asset pipeline now preserves `audio/webm`, `audio/ogg` and `audio/mp4`
for recorded voice attachments. Admission checks the extension, declared MIME
(with codec parameters normalized), container signature and audio codec/handler.
Integration reuses the single `audio-container.ts` recording validator from
portability: complete Opus Ogg pages, WebM Opus identity without video markers,
and bounded MP4 metadata/audio-codec plus media boxes. The duplicate Runtime
detector was removed; one extension map admits .webm/.ogg/.m4a/.mp4. This is
container admission, not full codec decoding or browser playback qualification.
Original bytes and MIME follow existing
staging, association, persistence and download authority. No transcoder, transcriber,
provider HTTP path or new credential store is introduced. Tests are written in
`tests/files-results/audio-attachments.test.mjs` and remain unexecuted.

## Continuation source coverage

| Requirement | Files | Behavior and remaining scope |
| --- | --- | --- |
| 1, 2, 12, 19 | `dto/provider-engine.ts`, `agent-run-preparation.ts`, `agent-message-run.ts` | Future exact non-secret normal contract retention; existing exact system record reused; legacy unknown packets remain held |
| 1, 6, 12, 13, 14, 19 | `context-recovery.ts`, `coordination-v3-context-recovery-authority.ts`, migration `0035_provider_context_recovery_progress.sql`, `routes/context-recovery.ts`, `routes/provider-commands.ts`, `app-contracts.ts`, `codex.ts` | Durable one-shot mutation reservation, exact old/new process drain, explicit Stop, current-human-policy checks and measured context acceptance; unknown original source work remains held |
| 4, 25 | `routes/provider-commands.ts`, inherited billing admission callers | Same native harness for both configured modes; cold commands retain normal model/system/tools/speed/restrictions. No atomic external-account-lock requirement added |
| Build voice messages | `dto/artifacts.ts`, `assets.ts` | Durable audio MIME and container/extension agreement for existing browser recording/upload/playback callers; web is owned separately |
| Deferred regressions | `provider-recovery.test.mjs`, `fixture.mjs`, `audio-attachments.test.mjs` | Source for exact reservation/restart/no replay/compaction/source-work hold and audio admission; no execution |

All tests, builds, types, native execution, account/device checks, benchmarks and
verification preparation remain deferred. No push, production merge or deployment.

An explicit Stop also reconciles an interrupted reservation after restart by
observing exact Agent process-group exit and recording `held`, without opening a
provider. A saved `nativeInvoked` marker remains: clearing process custody cannot
turn an unknown native compaction into permission to repeat it.

Accepted context measurements reference their canonical `context_usage` event by
sequence. Admission rechecks native session/contract, source fence, absence of a
newer injected Run, and absence of subsequent unmetered work; later text is accounted
for as a conservative tail estimate. The measurement is usable for an independent
new instruction after explicit hold dismissal. It never marks the old Run completed
or retries its original Activation/Request. This separation permits useful ongoing
work without inventing certainty about past effects.

Retained native commands and managed recovery require the accepted contract's
nonsecret observed authentication mode to match a current, unexpired native-auth
observation. Missing, unknown, stale or mismatched evidence holds the operation
before reopening or mutation; recheck native sign-in to renew an expired
observation. Old accepted packets are never rewritten, and their former selector
or a bare hash is not evidence of observed authentication. Historical packets
without this evidence cannot authorize retained commands or recovery; this does
not replace their session, replay work or authorize Context Refresh. Ordinary
turn compatibility and pause recovery keep their existing separate rules.
Fresh read-only commands without a retained session keep their existing path.
This observation is not an atomic lock against external credential changes.
