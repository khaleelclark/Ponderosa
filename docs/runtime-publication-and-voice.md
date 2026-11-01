# Explicit publication and early voice receipts

Source implementation only. No tests, builds, type checks, native/browser runs,
runner preparation or execution were performed for this change.

## Selected final generation

`ponderosa_reply_stream` arms one final response item, after other work. With no
arguments it retains the sole canonical default reply behavior. A document input
is now eligible; document metadata is not a reason to reject an otherwise accepted
source. The host still reads canonical intake, current Chat ownership, current
Run/capability and the steering fence. Provider memory or prose selects no route.

For a coalesced turn with different routes, supply an exact selection:

```json
{"publication":{"kind":"message","intent":"direct_to_user","documentTitle":"Inspection report"}}
```

The selected message route must match an actual accepted input on this Run. A
collaboration return requires exactly one explicit original sender. Human private
inputs cannot become Broadcast by changing an argument. A managed Agent cannot
stream a Broadcast. Already satisfied sources cannot reopen final delivery.
`taskDelivery: "final" | "blocked"` uses the existing task-origin delivery rules.
Finish other route obligations using their ordinary explicit tools before arming
the final stream. One generated item does not fan out to several audiences.

An attached correlated report uses an exact Request selection:

```json
{"publication":{"kind":"request_update","requestId":"exact-attached-request","updateKind":"completed"}}
```

Only the current recipient of an attached nonterminal Request can arm its stream;
its Project and Chat must match. `blocked` and `failed` are also supported. Questions,
answers, historical outbound controls and arbitrary Requests use the ordinary
explicit update tool. The provisional snapshot's messageId is the Request ID and
publication.kind is request_update. Consumers must display it only on that exact
private Request, never as a reply to an unrelated human message.

Successful native completion sends the exact canonicalized final body through
`/api/agent-messages` or `/api/agent-request-updates`, with the same current Run
capability. These remain the only publication authorities: ordinary actor, route,
artifact, lifetime, suspension, idempotency and delivery rules are preserved.
Documents use the existing managed Markdown staging path, with their title as the
message summary; long Request reports use the existing artifact-backed update
path. The Request path additionally checks live stream memory and steering at
commit, including after asynchronous artifact staging. No new grant or actor is
minted. Receipt failure never becomes a successful final snapshot. Exact normal
publication idempotency owns lost-response inspection; this change does not retry
an ambiguous mutation.

The existing bounded transport remains: at most 10,000 provisional characters and
255 updates. Overflow stops provisional streaming; an otherwise qualified complete
body can still publish through the ordinary long-text limits (8 MiB). Unknown native
phases use the completed item fallback. Tools/work after final authorization,
multiple response items, revoked context, cancellation or failed native completion
invalidate that answer. These are not guarantees of provider latency or a passed
end-to-end report flow.

## Early voice acknowledgement

For an eligible sole queued voice Direct Message, the native Agent may call:

```json
{"acknowledgement":"I will inspect the requested file and report what I find."}
```

This is an argument to `ponderosa_voice_reply`, not browser-authored speech. The
server checks the exact voice input, Run/fence, live memory authority and tool
capabilities. Text is canonicalized and limited to 500 Unicode code points. The
HTTP authorization response alone exposes no acknowledgement bytes in a playable
snapshot. Only the observed normalized native tool-result receipt matching BOTH
the authorizing operation and host stream identity releases the supplied bytes.
Codex and Claude use their existing receipt normalizers. Arbitrary tool prose,
foreign receipts and errors cannot authorize it. The snapshot records purpose
`acknowledgement`, exact source message/Chat/Agent/Run and the host receipt clock.

The acknowledgement is provisional execution evidence. It creates no Communication,
Request update, final reply obligation satisfaction or scheduler work. The already
accepted canonical workflow continues with its actual native tools/Requests; their
work events do not invalidate this short acknowledgement. Memory/steering changes,
errors or cancellation still revoke speech. Later native prose cannot replace its
bytes. After work the Agent calls the voice tool without acknowledgement, which
creates a separately scoped answer stream only after the acknowledgement receipt
was accepted; ordinary canonical publication also remains available. Ending after
only an acknowledgement does not synthesize a final answer.

UI consumer contract: use a separate acknowledgement phrase buffer; deduplicate
by exact stream and sequence, check current memory/Run as for final speech, and
never compare the final answer to the acknowledgement as a spoken answer prefix.
An acknowledgement must not settle the call. Final-answer stream replacement is
expected only for this transition. Runtime owns the additive shared DTO and tool
schemas; the UI owner owns browser presentation/playback. Existing consumers that
lack this distinction must be updated before early voice is considered complete.

## Authentication #7 / #20 disposition

The inspected base already has no dedicated operator login/token gate to remove.
`apps/server/src/app.ts` and `packages/core/src/config.ts` report
`authenticationRequired: false`. `server-request-hooks.ts` admits ordinary
non-browser callers without a token; it retains cross-site/origin mutation checks
and rejects a known Agent capability on operator-only routes. Capacity admission
is independent of network identity. `operator-auth-proxy.ts` is an optional socket
HTTP bridge; it strips caller-supplied operator identity and Tailscale identity
headers instead of treating them as authentication. Its filename is not a login.
`security.ts` retains stable action keys and constant-time internal secret comparison,
not an operator credential store. Webhook source normalization already removes
network timestamp freshness, and the inspected Branch webhook intake has no
mandatory HMAC/operator login gate. No auth code deletion was warranted here.

Retain native harness account login, scoped Agent capability/fence checks, internal
scheduler dispatch keys, browser-session/desktop tickets, artifact audiences and
current human access/disclosure review. Those enforce different domain authorities;
removing them would let native Agents impersonate operator actions or cross private
scope. `local-operator` remains a host-owned identity, not a request-provided actor.
Network admission remains the user's deployment responsibility. Boundary and
secure-environment qualification are deferred, not inferred from this disposition.

## Native external-contract limits

This change introduces no native result-query, source-turn reconciliation, or
Claude compaction method. Unknown native outcomes remain held without blind replay.
Claude still has no mapped structured compaction operation; Codex's mapped resume
response does not establish the original lost turn's terminal outcome. The exact
external-contract requirements remain in `runtime-native-completion.md`; no provider
call, parity verdict or recovery result is invented.

Deferred regression source: `tests/speech/explicit-publication.test.mjs` covers
mixed-route/document audience selection, attached Request recipient refusal and
canonical commit targets, exact native acknowledgement receipts with continued
work, and argument authority boundaries. It has not run. Existing native fixture
coverage, live cancellation/revocation, long artifacts, reconnect, UI speech and
real provider behavior remain to be executed only when authorized.
