# Original uncertain work: inspect and reconcile host receipts

An interrupted Run can publish a message, update a Request, queue information or
import an artifact before the provider loses its acknowledgement. Context
compaction cannot establish what those operations did. The operator API below
reads durable host records for the **original Run and fence**, without sending a
provider turn or repeating an action (Bible 12, 13 and 17).

## Operator API

Use the Agent ID, original scheduler Run ID and its original positive
`fencing_token`, available in the retained Run evidence. They are not the IDs of
a later recovery/compaction Run. Existing operator REST/origin behavior applies;
this is not an Agent tool or a new authentication boundary.

1. `GET /api/agents/:agentId/source-runs/:originalRunId/effects?sourceFence=7`
   returns the exact inventory and `inventoryHash`. The Run must still have
   `outcome_unknown` status, match the Agent/fence and have no retained provider
   process custody row. Missing/mismatched/live-source evidence returns 409;
   database read failures return 503, not an empty or successful inventory.
2. `POST /api/agents/:agentId/source-runs/:originalRunId/effects/reconcile`
   records a reconciliation snapshot in the existing canonical coordination
   idempotency table. Body:

   ```json
   {
     "sourceFence": 7,
     "expectedInventoryHash": "<exact inventoryHash from the GET>",
     "idempotencyKey": "review-original-run-effects-1"
   }
   ```

   Caller-supplied success/failure dispositions and extra fields are rejected.
   A fresh inventory is derived atomically with the write; any changed evidence
   requires another read. A reused key with different input conflicts. An exact
   key replay returns the original receipt, without rerunning reconciliation or
   any original action. New evidence can be inspected/reconciled with a new key.
3. After any lost/503 HTTP response, read
   `GET /api/agents/:agentId/source-runs/:originalRunId/effects/reconciliations/:key?sourceFence=7`.
   This returns the originally committed snapshot, even if later evidence has
   arrived. A 404 means no receipt was found for that exact boundary/key at the
   time of the read; 503 means absence was not established. Do not infer that an
   original effect failed or replay it from either response.

The read returns only source identities, receipt identifiers/hashes, supported
outcomes and relevant Request version/Call IDs. It does not echo tool inputs,
outputs, message text or attachment bytes into another API response. Full
original evidence remains available through its existing scoped audit surfaces.

## What is proven

| Inventory family | Exact original binding | Proven outcome |
| --- | --- | --- |
| Communication | canonical sender Agent and execution ID, same Project | Communication committed; recipient processing is not implied |
| Request update | canonical actor, payload execution ID and same Project | update committed at its recorded resulting version, not the Request's future state |
| Coordination | canonical `coordinate` receipt actor scope containing original Agent/Run | Request/Join creation transaction committed, not delegated task completion |
| Artifact import | import receipt Run and matching artifact authority origin Agent/execution | managed import committed, not continued existence of the original host path or external publication |
| Queued information | canonical publisher Agent and source Run | information committed for next Run, not consumed by its recipients |
| Tool call/result, command, file change | canonical event joined to existing host execution projection | provider telemetry retained; external effect remains **unknown**, even for exit0 or non-error output |

Every inventory hash covers the original Run/fence/project/scope/session and
complete enumerated supported records. Each effect has a hash of its actual
record; no client-provided evidence is accepted. Artifact import receipts retain
original tool-call correlation. Canonical Request versions and tool-call IDs are
returned where available. Agent event body bytes are hashed rather than parsed
as new authority. A tool result saying “sent” does not manufacture a canonical
Communication receipt.

## Limits and unchanged authority

`host_committed` resolves that precise host record. The reconciliation receipt's
`disposition` is `host_receipts_reconciled_external_unknown`, `nativeTail` remains
`unknown`, `sourceWork` remains `held_unknown`, and `replayAuthorized` is false.
This is deliberately **not** a successful terminal result for the source Run.
Neither the original scheduler Run, Request state, reply obligations, context
recovery progress, provider session nor fence is changed. No scheduler input,
wake, process launch, message/publication or external effect is repeated.

The inventory is a complete read of the supported host families for this source,
not a guarantee that every possible shell/native/browser/connector effect left
a host receipt. Missing telemetry, lost native acknowledgement, arbitrary file
writes, unreceipted external operations and missing historical evidence cannot
be promoted to success or failure. Such outcomes require the external system's
exact result/operation contract or a separately scoped evidence-aware recovery
operation; this API accepts no arbitrary operator “success” assertion. A later
context completion/dismissal does not settle these unknowns. Consequently this
implements M3's canonical host reconciliation portion; its unproven external
contract boundary remains explicit rather than being reported as completed.

## Deferred regression source

`tests/context-recovery/source-effects.test.mjs` covers exact Run isolation,
stale fence/inventory rejection, custody holds, caller-outcome rejection,
idempotent persistence/readback across reopen, no source-status mutation, and
successful-looking tool output remaining unknown. It is written for later
whole-implementation execution. No tests, checks, builds, typechecks, Node/native
or runtime probes were executed during this implementation lane.
