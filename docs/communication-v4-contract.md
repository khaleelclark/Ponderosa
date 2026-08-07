# Communication V4 production contract

## Retrieval schema and authorization decision

Communication V4 uses one stable maximal provider-visible tool schema for each
provider-session generation. Codex binds dynamic tool definitions when its
thread starts, and Claude binds MCP definitions when its provider process
starts. Ponderosa therefore does not claim that `ponderosa_context` or
`ponderosa_result` schemas are hidden on Runs where retrieval is unavailable.

Retrieval is instead conditionally authorized and prompt-guided per Run:

- the bounded Run compiler derives context authorization from actual omitted
  scoped input;
- result authorization comes from final reachable artifact manifests and
  structured scheduler provenance for omitted Activation payloads;
- the renewed Run capability contains the exact authorized route names; and
- every context or result call fails closed when the current authoritative Run
  lacks that authorization, even if a reused provider session remembers the
  stable schema.

The provider-session contract hash uses the maximal schema. Changes from no
retrieval reference, to a result reference, and back do not force a provider
session rollover. This is an explicit production tradeoff: the ordinary exact
route allowlist serializes to 18,182 bytes, while the stable maximal schema is
20,427 bytes, a bounded difference of 2,245 bytes. Recreating a provider
session can resend or reconstruct tens of thousands of input tokens and can
lose useful provider continuity. The qualified ordinary → result → ordinary
Codex sequence reused one provider session, performed no unnecessary retrieval
call, and kept exact fail-closed authorization on every Run.

Future adapter support may permit safe per-turn schema replacement inside one
provider session. Until both supported adapters provide and qualify that
contract, V4 must not reintroduce availability-driven session hashes or
false → true → false reseeds merely to hide the two retrieval schemas.

## Provider guidance

Provider instructions mention retrieval only as authorized by the current
bounded input. A Run with omitted scoped history receives an **OLDER SCOPED
CONTEXT** reference and authorization for `ponderosa_context`. A Run with a
reachable artifact or omitted Activation payload receives result guidance and
authorization for `ponderosa_result`. Schema presence alone is never authority.

PR descriptions and qualification reports must use the terms **conditionally
authorized** and **prompt-guided**. They must not claim conditional
provider-visible exposure, per-Run schema hiding, or the schema-token savings
measured by research configurations that recreated provider sessions.

## Automatic rollover continuity

An automatic rollover may reach `completed` after its source Run already
committed the visible reply, because no extra continuation Run is owed for that
reply. Its durable handoff is still mandatory session-bridge state: until one
compatible fresh Run consumes it, the oldest unconsumed completed-rollover
handoff takes precedence over ordinary recent-history reconstruction. That Run
submits the handoff and its current Activation together, records the handoff in
the exact provider-input manifest, and consumes it idempotently under its own
execution ID only after provider prompt acknowledgement. A stale or competing
execution cannot replace the recorded consumer, and later Runs cannot receive
the handoff again.
