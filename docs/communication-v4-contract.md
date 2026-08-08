# Communication V4 production contract

## Provider communication surface

Communication V4 exposes no Board, Wake, `ponderosa_context`, or
`ponderosa_result` capability. The provider-session contract contains the same
small communication surface for every Run in that session generation; ordinary
coordination and result integration never reseed a provider merely to change a
retrieval schema.

The canonical event log and SQLite projections continue to retain authored
history, request updates, artifacts, source manifests, and scheduler provenance.
Removing provider retrieval tools does not delete or weaken that durable data.
It deliberately means that history outside the bounded seed/continuation input
is temporarily unavailable to providers until a separately designed scoped RAG
replacement exists. This PR does not build or imply that replacement.

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
