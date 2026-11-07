# Historical provider context-reconstruction boundary

Current source includes before-admission managed handoffs for supported settings,
workspace guidance/profile and voice transitions. Missing exact saved instructions
and changed or unattributable memory exposure retain their specific queued-work
holds for context review. See [current context
recovery](context-recovery.md#workspace-guidance-and-profile-changes) and
`apps/server/src/context-transition-admission.ts`. This does not claim every
provider, legacy contract or revoked-information reconstruction is supported.

The observations below describe the older source pin and its then-open questions;
they are not a current inventory of reset callers or missing handoff support.

Source reviewed: `6409981942ad2fad5b711b2e8a02a566b9e37042`. The authoritative
Ponderosa Behavior Bible 2 has SHA-256
`ac314d93732e631bb042b8d3d2dc802ba08446812f99ba931023d2e02b14ab58`.
This records behavior and an implementation question at that historical pin;
it does not grant an exception or establish that Bible #1 is satisfied.

## Replacement triggers at the historical pin

`apps/server/src/routes/agent-run-preparation.ts` can clear a retained provider
session and construct a fresh one without taking the ordinary managed-rollover
handoff branch in these cases:

- Local Memory is enabled and the current Run has an eligible, sole canonical
  voice Direct Message (`voiceMemoryBoundary`). The reset is intended to prevent
  an earlier provider context from silently authorizing speech after memory
  sources or grants change. It is not a human-requested history wipe.
- The scheduler requests a fresh provider session for a changed Run scope
  (`runChangesScope` in `coordination-v3-run-context-read-model.ts`); the
  separate reviewed-steering continuation is explicitly operator-authorized.
- A retained session's provider/tool/system-policy contract no longer matches
  the current contract, including a changed tool or system-prompt snapshot.

The code distinguishes an existing accepted managed rollover/recovery from
the direct `requestContextRollover` and `tool_contract_changed` branches.
The latter clear the resume session and retire an idle reusable runtime; they do
not themselves create the durable managed handoff. The same-scope new Request
alone is not a scope-change reset. Other native recovery and explicit user
actions have their own paths and are not shown as these triggers.

## History retained and input supplied

Clearing a provider resume session is not deletion of the canonical Agent
history. A fresh provider input is reconstructed from authorized canonical and
imported history pages under the configured source budget and provider context
ceiling. `boundedHistoryCandidates` may be trimmed, so retained canonical
history is not equivalent to full prior provider context. When content is
omitted, the prompt states that older content was omitted and identifies
`ponderosa_history` retrieval when that tool and source are available; retrieval
can itself be unavailable. The provider-input manifest records the selected
sources and omission state. The required human objective is reconstructed
separately, but that does not prove complete prior context is preserved.

Bible #1 limits context shrinking/replacement to managed auto-compaction or an
explicit human wipe. These direct branches therefore remain an open source-level
conflict with that rule; no approval of an exception is recorded here. The
existing tests for voice-memory exposure, bounded history and objective
reconstruction do not prove full-history parity across these resets.

## Work identified at the historical pin

The existing managed rollover requires a verified original provider session and
source-Run boundary, an exact canonical tail, and measured automatic pressure
or an explicit human refresh. It schedules an isolated handoff at a later
scheduler boundary. The direct reset currently occurs while the next Run is
already being prepared, so merely calling that authority is not a safe
replacement. A complete solution needs a before-admission handoff/continuation
that preserves the original work, handles unavailable or uncertain source
evidence without replay, and proves that any carried memory-derived content is
still authorized for the voice destination and current grants. Contract changes
and revoked access must not be bypassed by reusing a stale provider session.
If those facts cannot be established, the appropriate visible recovery and
product behavior remain unresolved. A blanket hold would also disable affected
voice or changed-contract turns, so it has not been introduced as an assumed
solution.

## Pre-sampling provider failure — current retained-context behavior

A failed pre-sampling compact does not prove that earlier native/tool work exists
in canonical Communication. The executor therefore preserves the accepted session,
its saved input and prior history, reports the original redacted provider failure,
and drains the failed process. It does not reset the session, resubmit a fresh
canonical seed or replay the assignment. A genuinely first turn also has no
automatic retry. Existing scheduler injection/outcome authority owns settlement.

Explicit context recovery is available only when the existing exact source
boundary, retained contract and adapter protocol qualify. A clean failed/completed
source or unsupported adapter does not gain a working recovery button from this
change. Unknown original effects remain unknown, and no recovery operation or
permission is manufactured by a failed provider attempt.
