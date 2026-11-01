# Finite Branch contracts: U2, U4, U6 and M4

Source-only successor of assembled `595681b750776c5f3c765de1f040f0931f6d8750`.
Bible #5/#6/#8/#32 were read in full. These are implementation dispositions, not
Patrick-approved exceptions, runtime equivalence, or whole-commandment verdicts.
No test, build, type check, Node/native/provider/browser or preparation ran.

## U2: limits and access have different purposes

| Exact bound / anchor | Classification and purpose | Disposition / human control |
| --- | --- | --- |
| 32 prior generations; `branch-resource-generation-one.ts`, Runtime `coordination-v3-historical-partition.ts` | Stability of synchronous exhaustive proof validation, retained envelope byte expansion and one-transaction admission; not a permission grant | Retained. Current generation 1–32 needs every earlier seal/retirement, and fits 32 historical selections. This does not cap the original future retry allowance. |
| Former maxAttempts<=33 in generation validator and serial codec | Unjustified capability restriction: an original policy of100 with only2 retired generations costs the same proof as policy3 | **Removed.** The actual pinned maxAttempts accepted by the existing definition validator (1–100) survives capture, saved budget status/discovery and admission. Consumed attempt remains3, subsequent retry4, never reset1. Original generation-zero attempt offset remains required. |
| Group resource inventory2–32; `branch-issued-group-capture.ts`, issued frontier and Runtime group reader | Stability of a single atomic collection/import/disclosure/receipt composition, each member has separate custody and current authority checks | Retained. One-resource uses singular path. Tree eligibility is a proof codec boundary (two owners, one gen0 resource each), not an Agent access revocation. Broader exact combinations are not claimed. |
| Historical partition32MiB; async pending snapshots32MiB | Memory/transaction stability and checkpoint backpressure | Retained. Evidence is refused/held explicitly, never truncated; queued snapshot backpressure delays dispatch without changing access. A low member count does not guarantee bytes fit. |
| Definition512000 bytes/depth32/nodes10000; graph100 Steps/100 controls/500 edges/5000 structural contexts | Publication parsing and graph-closure traversal stability | Retained. Protects synchronous publication and complete ownership validation; no host or provider access change. |
| Human configuration: traversal/loop/depth1–1000000; concurrency1–1000; path/Step/Agent policy1–100000; Map items1–100000/concurrency1–1000; retry/recovery attempts1–100 | Human-selected execution/resource ceilings within finite scheduler storage/work bounds | Retained. User settings/published definition select budgets; execution holds do not rewrite settings or permissions. Values are validated, not secretly lowered after acceptance. |
| Discovery page1–100, saved tree/history inventories100; bounded scheduler batches | Read/CPU stability, not permission | Pagination uses canonical cursors where provided; over-bound exact inventories refuse visibly rather than silently hide evidence. No proof of a wider inventory is claimed. |
| New shared-state1MiB, depth32/nodes100000 | Stability of repeated synchronous canonical fold/snapshot/dispatch; does not bound ordinary result history | Retained with explicit errors before a state write commits. No truncation or implicit overflow reset. |
| Original scope/pins, current human disclosure, policy restrictions, custody/fence/drain proof | Ownership/effect correctness and existing human access, not quota | Keep. Missing original proof is not deletion evidence; a retained journal grants no execution/import permission. Automatic backoff/capacity delay never changes human capability settings. |

This classifies the finite Branch limits named in U2 and the connected validators;
it is not a scan claiming every rule in core has been justified.

## U4: exact recreation/checkpoint contract against the nine named capabilities

#8 requires portable definitions and nonsecret data. `exportBranchPackage` and the
installation export plus shared Agent package composer transport definitions (now
including state channels), templates, optional nonsecret parameters/limits and
installed Agent data. The lightweight `branch-package.v1` exports only the
definition. Full `branch-installation.v1` now includes bounded standalone manual runtime
execution/private checkpoint journals and execution-owned Chats as hash-bound
held data. Supported effect-free native frontiers use the existing remapper;
there is no runnable foreign-cut admission. Called/automatic trees and external
proof expansion remain U3/#8 boundaries. See `branch-runtime-package-recreation.md`. Known secret fields are deliberately omitted;
users must rebind credentials. A runtime checkpoint is an additional selected
continuation contract, not a promise to replay unknown native side effects.

#32 requires the following named operations. Their supported scope is explicit:

| Named capability | Required operation / present path | Exact boundary, not an invented feature requirement |
| --- | --- | --- |
| Graphs | Publish nodes/edges/loops/fork/join/maps and execute through BranchStore/public client | Current selected inventory/counters must be exhaustive; no ad-hoc graph reconstruction from absent rows. |
| State | Preserve selected accumulated application values and continue later updates | New immutable seal projection, revisioned partial writes, sum/append/replace reducers; prefixes survive same replay/remap. Detailed state contract below. |
| Checkpoints and rewind | Name/list/select a retained checkpoint; fork a fresh continuation from a proven cut with saved data/counters | Existing initial and Script/Request/parallel/tree codecs; standalone gen0 resource groups/maps2–32; one-resource history1–32; exact manual parent/called child gen0. No rerun of completed prefix. A selection is not current authority; importing original private facts requires the existing current human review. |
| Human-in-the-loop | Retain waiting gate and accept explicit current decision/edit; revocable all-facts import consent | Existing gate/version/review authority. Changed/secret bindings need current rebinding/consent, not silently reused old credentials. |
| Streaming | Current Agent output and durable state observation | Existing canonical stream, new public shared-state GET; state GET is a snapshot, not a new state-update SSE equivalence claim. |
| Tools | Use ordinary Script/native harness tools | Runtime process/effect drain and exact receipts remain required. Missing M2/M3 native receipts cannot be inferred from exit or replayed to manufacture proof. |
| Memory | Existing permitted chat/global memory, portable package memory | Package recreation uses shared composer; checkpoint consumers currently refuse richer memory/artifact/working-root/restriction combinations. This is a real composition limit; no new automatic permission or arbitrary topology transport is invented here. |
| Subgraphs | Retain Call ancestry, map parent execution/attempt, create accepted child through canonical scheduler | Exact parent+child gen0 issued consumer exists; broader called cuts/retry histories have no delivered codec. Missing ancestry cannot be substituted with the root. |
| Multi-agent | Retain exact original member/import custody; import fresh identities and compose one canonical owner/group admission | Current groups/maps and two-owner tree supported; multi-resource retry chains and called retries remain genuine unimplemented combinations, not proof that the named basic capability is absent. |

Refusal classes must remain distinct:

* **Absent or uncertain proof:** preupgrade/missing/erased seals, native unknowns,
  unknown external effects and unproved source scope. Refuse, retain visible holds;
  neither #8 nor #32 permits inventing results, actors, custody or replay safety.
* **Current policy or secrets:** require current human rebind/disclosure/policy;
  no automatic grant expansion. A changed binding is not historical authority.
* **Existing codec/composition boundaries:** cancellation/recovery/budget-held
  cuts, forwarded bundles, rich package checkpoint imports, multi-resource/called
  histories, broader tree/EXIT variants and restored attempt offsets. These remain
  visible source gaps where that particular combination is desired. The nine-name
  baseline does not by itself mandate every permutation. This disposition does
  not approve an exception or call those combinations implemented.

No new checkpoint engine is needed to establish the nine basic named operations.
Original proof safety remains prerequisite to extending a specific consumer. U3
(package topology/recreation data completeness), M2/M3 (unknown native effects),
and whole capability equivalence remain with their existing owners and unqualified.

## U6: pinned state comparison and implemented contract

Pinned primary source, rather than newer docs, supplies the comparison:
[StateGraph1.0.5](https://github.com/langchain-ai/langgraph/blob/1.0.5/libs/langgraph/langgraph/graph/state.py)
provides nodes with shared state and accepts partial updates using per-key binary
reducers. Its runtime context is a separate immutable input.
[BinaryOperatorAggregate](https://github.com/langchain-ai/langgraph/blob/1.0.5/libs/langgraph/langgraph/channels/binop.py)
folds contributions; [LastValue](https://github.com/langchain-ai/langgraph/blob/1.0.5/libs/langgraph/langgraph/channels/last_value.py)
rejects multiple writes in one superstep. LangChain1.0.8
[AgentState](https://github.com/langchain-ai/langchain/blob/langchain%3D%3D1.0.8/libs/langchain_v1/langchain/agents/middleware/types.py)
uses message state; its [agent factory](https://github.com/langchain-ai/langchain/blob/langchain%3D%3D1.0.8/libs/langchain_v1/langchain/agents/factory.py)
composes StateGraph. Therefore input/parameters/results alone did **not** resolve U6.

`BranchDefinition.state` now declares JSON initial values and per-key reducers
`replace`, `append` (arrays) or `sum` (finite numbers). Script/Agent Steps opt in
with `stateWrites`, listing channels they can update. A successful output must be a
JSON partial object containing only those keys. Missing keys retain their values;
failed/retried attempts never contribute. The existing canonical `finish` attaches
`stateUpdate:{revision,updates}` before settlement/sealing, within its owner
transaction. Caller-authored revisions are not authority. The immutable successful
sealed results are the sole state store; no migration, mutable table, second
scheduler or replay engine is introduced.

`branchSharedState` validates result hashes, declared keys, exact output/update
bytes, contiguous nonaliased revisions and reducer types, then derives values and
`evidenceHash`. Shared serial/parallel codecs validate every seal's revision against
its actual preceding seals; remapping preserves metadata and values. A restored
prefix starts at its consumed revision, without reapplying its writes. Script
lease audit stores exact revision/hash and dispatch supplies `globalThis.ponderosaState` as
`{revision,values,evidenceHash}` through the existing authorized source control pipe
(avoiding OS environment-string size limits); Agent Request payloads carry `sharedState`.
Replay checks the exact state at original dispatch, not the later mutable cut.
GET `/api/branch-executions/:executionId/shared-state` and
`BranchesClient.sharedState` expose the same projection via existing operator
access. Values have the same visibility as existing execution results, not secret
storage. Malformed output refuses settlement and remains a visible process/Request
reconciliation error; it is not silently accepted or retried by this state layer.

Parallel contributions fold in committed settlement order; this differs from
LangGraph's superstep barrier/conflict rules. State readers see the snapshot at
Script lease or Request issuance. `replace` is explicit last committed write;
use sum/append for independent contributions. A custom aggregate is composed with
the **existing** Script node after Join, reading accumulated contributions and
writing a replace channel. `examples/branches-capabilities/state.ts` demonstrates
that public composition. Arbitrary Python reducer callbacks, LangGraph message-ID
replacement/deletion, Command(update)/manual edit history, shared implicit state
across Call owners, and superstep scheduling equivalence are not claimed. These
are explicit finer-grained comparator gaps beyond the supplied minimal shared/
reducer capability; they are not hidden behind immutable-results equivalence.

## M4: exact group owner review output

Existing prepare/inspect/admit responses add `reviewEvidence`, exposed by the
shared `BranchIssuedGroupDestinationDto` used by BranchGroupClient. New plans
save original-to-fresh `idMap`, `ownerMap`, and each owner's original/fresh parent
execution and parent attempt IDs, global/path/loop/invocation counters, pinned
limits/policy, fresh acceptance kind/time/source, actual numeric execution
budget receipt, resolved path/Step/Agent/concurrency capacity and exact selected
usage (not estimated remaining allowance). Budget `policy:null` explicitly means unlimited, not zero.

`BranchExecutionBudgetAuthority.admit` retains that budget snapshot in the existing
`admission_json`, in the same debit transaction. Later quota/configuration changes
do not supply the displayed historical numbers. Review evidence has an immutable
hash in the saved plan, bound by final canonical owner receipts' existing plan
hash. Reader compares maps/counters/pins to the exact saved capture and acceptance
to each actual destination admission. `ancestry:'prospective'` identifies reserved
mapped child attempt IDs before final parent frontier creation;
`ancestry:'committed'` also checks actual parent FKs. No fabricated placeholder
Steps/Requests or private snapshot export. Legacy plans missing evidence return
`unavailable/legacy_missing_saved_evidence`; malformed present evidence refuses.
Current integrated UI successor `6706540420065f45711e508205f4b872d4de3ab2` validates and renders the saved evidence, labels prospective versus committed ancestry and unavailable legacy proof, and accepts published retry policies through100 independently of generation32. M4 source gap is resolved; rendered/runtime qualification remains open.

Deferred source regression now covers actual ASYNC/SYNC serial and fork scheduler
writes, two leases observing the same revision, reverse-order completion, malformed
partial rollback, checkpoint fork without prefix contribution duplication, restart,
and rehashed revision alias refusal. Agent fixtures retain the exact dispatched
state and exercise successful writes plus visible malformed-output holds. The existing real generation-history fixture
adds original policy100 at generation2 and asserts consumed3 then next4. Existing
called-owner consumer fixture asserts saved M4 ancestry/budgets, quota-change
independence, tamper refusal and restart evidence equality. Process/package adapters
remain inert; none was executed.
