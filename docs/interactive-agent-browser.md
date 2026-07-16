# Interactive Agent Browser Transport and Security Boundary

**Status:** Implemented design record.

## Project browser

Ponderosa also provides one operator-owned browser per Project. Unlike the
execution browser below, this browser persists across Agent Runs and keeps the
same isolated profile until the operator closes it, the Project is deleted, or
the server shuts down. It is the in-product destination for ordinary HTTP(S)
links and for an address entered by the authenticated operator.

The operator owns input and navigation by default. They may explicitly lend
control to one Agent's exact active Run. While that grant exists, the same
runtime browser tools operate the Project browser and operator navigation/input
is fenced. Completion, cancellation, failure, lease expiry, Agent deletion, or
Project deletion revokes the grant transactionally and returns control to the
operator without closing the browser. An Agent cannot discover, claim, or keep
the browser without that explicit grant.

This intentionally broadens the former client-navigation restriction for this
one authenticated, Project-scoped surface. URLs remain limited to
non-credentialed HTTP(S), DTOs and diagnostics retain the same redaction rules,
CDP remains on anonymous pipes, and browser data remains in a dedicated
Ponderosa profile. The profile is not reconstructed after a server restart and
is never the operator's normal browser profile.

## Decision

Ponderosa may launch one host-managed Chromium/Chrome session for an exact active
Run. The browser is a shared execution surface: the owning agent can inspect and
operate it through engine-agnostic host tools, while the authenticated operator
can watch and temporarily take input control in Agent Detail.

The server launches Chromium itself and talks to Chrome DevTools Protocol over
anonymous child-process pipes. It does not bind a DevTools TCP port. The browser
uses an isolated, run-session profile below `PONDEROSA_DATA_DIR/browser-sessions`
and deletes that profile when the session closes.

The exact-Run capability is not a general browser proxy, host proxy, or
arbitrary client automation API. Client-selected navigation belongs only to the
separate Project browser above.

## Ownership and authorization

Every session is immutably scoped to:

- project ID;
- agent ID (the durable Agent/agent-chat work boundary);
- authoritative Run ID; and
- the Run's optional Project-chat conversation ID.

Operator routes include the project, agent, and Run IDs. The server revalidates
all of them against current authoritative Run ownership before every status,
frame, control, input, reconnect, and close operation. Normal Ponderosa operator
authentication and same-origin mutation checks apply.

Agent operations use the existing unguessable runtime capability. The server
derives scope from that capability and accepts it only while its Run still owns
the current scheduler fence. Models cannot supply project, agent, conversation,
or Run ownership fields. Browser tools are normalized shared runtime tools; the
web app contains no Codex/Claude branch.

Operator APIs deliberately have no navigate-to-URL operation. They can interact
only with the currently rendered page. Agent navigation accepts only
non-credentialed `http:` and `https:` URLs. Agents already have intentional host
access; this rule prevents turning operator-facing browser endpoints into a file
reader or client-selected general host proxy.

Redirect and current-page URLs are treated as untrusted. Before they enter a
DTO, canonical audit event, snapshot, console record, or displayed failure,
fragments are removed and credential-bearing query values are redacted. A URL
containing an OAuth code/state, token, secret, SAML payload, or signed query is
not retained as a reconnect target.

## Control arbitration

Exactly one principal owns input at a time: `agent` or `operator`. A monotonic
control epoch fences every operator input request. Taking or returning control
increments the epoch, so stale tabs receive `409` rather than continuing to type.
Browser commands and control transfers share one per-session FIFO. Every action
is fenced by both the process lifecycle epoch and control epoch before execution
and before committing its result. An old-owner action queued behind a transfer
therefore fails, while a transfer waits for an already in-flight action. Agent
input fails while the operator owns control; the agent must explicitly take
control back.

The UI always displays the current owner and provides explicit Open, Collapse,
Reconnect, Close, Take control, and Return control actions. Unmounting Agent
Detail during ordinary navigation does not close the host session. Returning to
the active Run reconnects the view to the same session.

## Transport

Lifecycle mutations and operator input remain authenticated REST. Lifecycle,
control, navigation, console, and screenshot audit records use the existing
append-only agent event log and SSE stream. Live view frames are bounded PNG
responses fetched with `private, no-store`; frame polling is ephemeral and does
not create canonical screenshots.

This design intentionally adds no WebSocket or exposed CDP transport. REST is
adequate because page frames are server-to-client snapshots and operator input
is a sequence of bounded mutations; SSE already carries server-initiated status
changes. If continuous bidirectional transport is introduced later, this record
must be updated with upgrade authentication, connection limits, backpressure,
and teardown behavior before implementation.

## Audit and artifacts

Browser lifecycle, control transfers, navigation, input summaries, and bounded
console output are canonical execution activity. Filled or typed values are
never copied into activity summaries. Explicit agent screenshot requests write a
PNG inside the owning agent's artifacts directory and append a
`browser_screenshot` event; the rebuildable projector recreates its Files &
results metadata. Polling frames are not durable artifacts.

None of these records creates a Message or appears in Project chat, Team chat,
or Agent chat. They remain in Activity and Files & results.

## Limits and teardown

- one browser session per Agent, and only for the current active Run;
- fixed 1280×720 viewport, a 16 MiB frame ceiling, and bounded
  console/snapshot/tool inputs;
- no client-selected executable, DevTools endpoint, host, or profile path;
- session close on Run completion, failure, cancellation, lease expiry, Agent or
  Project deletion, explicit close, or server shutdown;
- reconnect creates a new browser process for the same immutable scope and
  restores only a fragment-free URL with no credential-bearing query; otherwise
  it opens a blank page;
- no provider API key, browser credential store, or reusable login profile.

The first implementation is headless and screenshot-driven. It does not provide
audio, browser chrome, extension UI, native file pickers, or retained browser
login state. Those are deliberate limitations of the narrow security boundary.
