# Communication V4 production contract

## Provider communication surface

Communication V4 exposes no Board, Wake, `ponderosa_context`,
`ponderosa_result`, or `ponderosa_docs` capability. The former bundled product
wiki and its `ponderosa://docs/...` references are not a provider surface.

The ordinary provider-session contract contains the same small communication
surface for every Run in that session generation. One later, narrow exception
is `ponderosa_history`: after a Ponderosa-managed context rollover, a replacement
session generation receives that tool only when a frozen durable boundary has
eligible authored Communication before it. The tool contract then remains
stable for that provider-session generation. Search is bounded lexical
retrieval over the authorized omitted set, and `read` returns one exact
canonical message with a small same-conversation neighborhood. It is not general
audit, current-context, artifact, or product-documentation retrieval.

The canonical event log and SQLite projections continue to retain authored
history, request updates, artifacts, source manifests, and scheduler provenance.
Removing the general retrieval tools did not delete or weaken that durable data.
Outside the conditional omitted-message set above, material excluded from the
bounded seed or continuation input remains unavailable to providers. No scoped
RAG replacement or product-documentation retrieval is implemented or implied.

## Complete correlated-result delivery

Terminal and joined correlated results enter the requester Run automatically.
The scheduler resolves only immutable request-update artifacts reachable from
the exact leased Activation and validates their ledger identity and bytes before
compiling provider input.

- Complete result content is injected inline by default.
- If the complete scheduler packet exceeds the hard 256 KiB provider-input
  envelope, the prompt supplies the exact validated local artifact path, byte
  length, media type, and SHA-256. Providers must read the entire file through
  their ordinary filesystem capability before integrating the result.
- Missing or changed result content fails compilation. No path silently
  truncates, previews, or discards correlated-result semantics.
- The exact Activation and artifact IDs remain recorded in the provider-input
  source manifest. Idempotent scheduler fencing still owns delivery exactly once.

Artifact references in older bounded history remain durable but are not a
provider retrieval mechanism. PR and qualification wording must distinguish
automatic current-Run result delivery from the deliberate temporary loss of
deep-history retrieval.

## Automatic rollover continuity

Crossing the context-pressure threshold queues a dedicated blocker-only
handoff Run at the next scheduler boundary on the retained old provider
session. The pressure source Run first completes its ordinary task and exact
output contract. Any acknowledged, nonempty, meaningful handoff within the
20,000-character hard bound can commit continuity; section headings and
concrete references improve readability but are not validity requirements. An
empty, effectively empty, or oversized handoff leaves the old context intact
and receives at most one corrective retry before automatic rollover stops for
that provider generation. Pending corrective handoff work remains durable
across server restarts. The runtime retires the old session only after a usable
handoff commits. This costs one explicit rollover Run in the ordinary case but
does not depend on a model overriding an arbitrary active task response.

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
