# Incremental voice checkpoint

Preserve the existing advanced Branch call and complete-response fallback.
Patrick's roughly fifteen-second observation is a user baseline, not a measured
breakdown. This patch fixes a reproduced short-sentence buffering case and adds
context-change fences; it does not claim a measured production speedup or launch.

## Existing path and bounded change

CodexResponseText normalizes item/started, item/agentMessage/delta and
item/completed for an exact thread/turn/item. Only known final_answer deltas may
stream. Commentary, reasoning, tool bytes and unknown-phase deltas stay outside
speech. The exact successful unnamespaced ponderosa_voice_reply tool receipt
arms the host. Native work irreversibly invalidates that authority. Claude and
adapters without this qualified response protocol retain canonical fallback.

VoiceReplyStream emits cumulative snapshots through the existing authenticated
Agent SSE and status route. Previously, splitting `A short` and ` sentence.`
withholding the next token withheld the finished sentence: the host's coalescing
rule and the browser's phrase delimiter both required following whitespace.
The host now emits terminal punctuation without that whitespace. The existing
900ms browser timer may flush a terminal sentence after its text has been stable
for at least 900ms. Immediate whitespace-delimited phrases remain unchanged.
Abbreviations, Markdown/code, Unicode normalization, bounded transport and
canonical prefix reconciliation retain their existing rules. Timer alignment
can add another interval; suspended/background event loops have no latency bound.

Memory preparation and pre-submission validation remain the shared Ponderosa
engine capability. No Pinecone store or retrieval algorithm is added. While a
voice stream exists, a 250ms host watchdog revalidates its frozen memory packet
through the existing canonical authority. Candidates, final selection and the
actual durable direct-message publication additionally validate synchronously.
Correction, Forget, scope/grant/policy changes, expiry or lost memory authority
produce an irreversible `failed` snapshot with `failureReason: context_changed`.
Completion and a delayed HTTP success acknowledgement cannot resurrect an
invalidated stream. A canonical commit that preceded a correction remains
historical Communication; its speech stays fenced.
The browser removes the provisional candidate, cancels current/queued speech,
and closes automatic fallback for that attempt. Late status, SSE, saved native
callbacks and canonical observations cannot reopen it. Audio already heard
cannot be retracted; changes cross the SSE network asynchronously. Ordinary
transport failure still reconciles only the canonical unspoken tail. The next
memory-enabled turn uses the existing fresh-session teardown/reseed behavior.

Additive ephemeral contracts: VoiceReplySnapshot adds optional submittedAt,
firstModelTextAt and failureReason; ActiveRun adds voiceReplyTiming and the
host-only synchronous validateVoiceReplyContext callback. No database/schema,
communication identity, storage authority or portability DTO is changed.

## Timing truth

Host UTC: acceptance, lease, Run start, submission boundary, first normalized
model text receipt (which can include Work log), first qualified backend text,
canonical completion. The submission marker precedes startStream; persistent
runtime opening/preparation is earlier. It is a host boundary, not proof of
provider acceptance or internal inference start.

Browser performance clock: finalized recognition when used, HTTP submission and
acceptance observations, first reply receipt, visible DOM commit, first speakable
phrase, successful software queue request, SpeechSynthesisUtterance.onstart.
Host and browser clocks are never subtracted. A queue request is not audio-ready;
onstart is software onset, not physical heard audio. Native TTS preparation,
audio-ready and physical hearing are UNAVAILABLE without actual device evidence.

## Focused reproducible checks

Use cached dependencies and direct Node/compiler paths; never run these fixtures
against a product checkout, live database or provider by accident.

- `node --test --test-name-pattern='^(short split|memory )' apps/server/test/voice-reply-stream.test.mjs`
  proves punctuation emission, paused correction/Forget/grant/expiry invalidation,
  fresh input reseeding and a correction inside injected publication dispatch.
- `node apps/server/test/voice-incremental-browser.check.mjs` builds the shared
  call component, uses real canonical Branch HTTP/SSE and delayed inert normalized
  model chunks, and replaces native speech/microphone APIs. It tests ordinary
  Branch and standalone Pinecone namespace consumers, early UI/queue/mock onstart,
  actual reconnect without repetition, split-surrogate Unicode order, sole final,
  correction and late callbacks. It does not mount the complete product shells.
- `node apps/web/test/voice-reply-stream.check.mjs` checks phrase, identity,
  Unicode, reconciliation and timing behavior.
- Set `VOICE_SCENARIO_PATTERN` on `voice-conversation-browser.check.mjs` to select
  changed-boundary browser cases instead of rerunning the whole donor baseline.

The browser fixture requires PONDEROSA_PLAYWRIGHT_PATH and PONDEROSA_CHROMIUM_PATH
pointing to cached installations. VOICE_FIXTURE_DATA_ROOT selects owned database/
build scratch independently from Chromium's short TMPDIR. VOICE_TIMING_REPORT
optionally writes separate host/browser timing receipts. No native mic/voices
probe occurs. Fixture speech receipts must retain their mock labels.

One new installed-provider qualification on this checkpoint used the existing
subscription, a private disposable Branch/store and one harmless two-sentence
input. It observed exact voice authorization, final_answer deltas and one final
canonical reply. Exact input/hash/manifest, requested model, Run, process receipts
and monotonic timings are in the external evidence directory. This was neither
a replay of the historical unknown Run nor a matched latency comparison. No real
browser speech accompanied that provider sample.

The product integrator alone composes this patch. Its separate createClientId
cancellation fix, independent composed-head review, private target/base decision,
reviewed proxy deployment, secure microphone origin and physical heard-audio
acceptance remain separate. No public push, deployment, listener/TLS/Serve,
credentials or production data change accompanies this checkpoint.

## Q2: exposure lasts through actual speech drain

Canonical completion no longer closes automatic playback observation. The call
keeps its exact-turn SSE/status observer until its current and queued utterances
drain, stop, invalidate or unmount. This includes canonical-only fallback.
`beforePhrase` serializes queue pumping and awaits authenticated status before
each native utterance. Stop/replacement/reset defeats a delayed valid response;
failed validation cannot invoke canonical fallback. Each invalidated turn has an
irreversible tombstone. Historical canonical messages remain visible in Chat.

The existing status route validates the actual durable `provider_inputs` packet
and submitted turn marker after ActiveRun release. Its V3 manifest now carries
`memorySessionResetSeq` (explicit zero means known no reset) and `memoryScopes`
(including empty authorized collections). Unknown/legacy/malformed evidence is
never affirmative automatic-playback permission. Fresh/reseeded packet factories
capture their epoch once; exact recovery/fallback manifests retain their own
epoch, never a newer reset stamped on old prompt bytes. Canonical reset lookup
covers the complete indexed event projection, not a recent 256-event window.

Host-only `MemoryAuthority.forPlayback` checks exact owner/product/Chat/Agent/
Project/Run/fence, current policy/grants, source authorization and expiry. It
reads existing installation ownership, never initializes it, and forces both
write capabilities false. Completed exposure relaxes only the expired running
lease; ordinary preparation/tool checks retain live-lease rules. Failed,
cancelled, unknown, fenced, deleted, reset and unavailable identities deny.

Grant enabled-state transitions increment the existing Project generation in
the same transaction on revoke and regrant. Same-state, failed revision and
idempotent replay do not increment it; existing grant revision semantics stay
unchanged. Successful memory-route commits emit scoped no-content hints, also
to a Project losing its grant. Independent Project/global counters compare only
to their original bindings. Hints invalidate; they never confer authority.
Durable status and phrase checks cover missed notifications, direct-store writes
and expiry. The 250ms browser timer is a nominal backstop, with no maximum stop
latency or mutation-to-physical-onset atomicity guarantee. Already heard audio
cannot be retracted.

`node --test apps/server/test/voice-memory-exposure.test.mjs` exercises the durable
status/authority seam with canonical stores and reduced host ports. Set
`VOICE_LIFETIME_ONLY=1` on the real HTTP/SSE browser fixture for post-final current
and queued speech, correction/Forget/revoke/expiry/reset, canonical-only fallback,
missed-SSE revoke→regrant, phrase denial with polling suppressed, delayed valid
status after stop/reset/invalidation, saved callbacks/reconnect, and a draining
control followed by deliberate fresh empty-memory reseeding. The fixture also
checks serialized async guards after owner stop/replacement, captures tested
source and build hashes before cleanup, and keeps host/browser clocks separate.
These are inert-provider and mocked-speech checks, not physical audio evidence.

Native speech errors and external queue stops also fence the automatic turn and
release its SSE, status timer and conversation observer, including after model
and canonical completion. Saved callbacks cannot restart that queue. Deliberate
Play reply and new turns remain available. An intentional stream-failure stop
still waits for its exact canonical fallback rather than disposing that wait.
Select `VOICE_LIFETIME_ONLY=1` and
`VOICE_SCENARIOS=post-final-native-error,post-final-external-stop,post-final-control`
on the HTTP/SSE fixture for the focused native-stop cleanup/replay controls.
