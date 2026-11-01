# Branch framework capability inventory

Current integration source: c38b209b395dcf53744702758addf1c74944d0b2. Source navigation,
not an equivalence verdict. Released Python comparator baseline:
[LangGraph 1.0.5](https://pypi.org/project/langgraph/1.0.5/) and
[LangChain 1.0.8](https://pypi.org/project/langchain/1.0.8/).
These are selected released versions, not a claim of latest releases or a resolved
transitive lock. No packages installed or examples executed. Current official docs
may describe newer APIs; the comparator uses the baseline StateGraph/stream API,
not newer event-stream projections. Source compatibility remains unqualified.

| Named capability | Existing implementation | Representative application / limit |
| --- | --- | --- |
| Graphs | core BranchDefinition; agents branch-store; WorkflowCanvas | application.ts deploys real fork/join edges through the public client. |
| State | `BranchDefinition.state`, declared Script/Agent partial writes, immutable revisioned seal projection, sum/append/replace reducers, public shared-state read | `state.ts` demonstrates parallel contributions and a custom aggregate through the existing Script after Join. Settlement-order semantics differ from LangGraph supersteps; message-ID reducers, manual state editing and implicit cross-Call state are not claimed. See branch-finite-contract-dispositions.md. |
| Checkpoints and rewind | branch-unit-saver, script/parallel replay, host-cut and issued destination | inspect lists canonical retained checkpoints; no automatic rewind or disclosure. Reviewed issued destination supports standalone gen0 groups/maps2–32, one-resource serial/local-parallel history1–32, and one manual parent plus one called child with one gen0 serial resource each. Broader families remain outside the delivered bound; see implementation-coverage.md and U4 in phase2-remaining-implementation.md. |
| Human-in-the-loop | human_gate, revisioned BranchGateResolution and public execution actions | Editable final review; resolve requires the current gate and an explicit caller choice. |
| Streaming | BranchesClient.streamAgent, BranchLiveOutput and canonical shared streams | Exact current execution/Agent/Run filter; server example also supplies SSE HTTP forwarding. Reconnect qualification deferred. |
| Tools | native Adapter harness tool routing, Agent access settings, Script/action steps | Research/critic request existing permitted tools; no fake tool outputs or new grants. Tool availability/parity is not established by an instruction. |
| Memory | unified memory catalog/search, portable memory and Branch bindings | Research/critic request currently permitted memory search; no new memory implementation or implicit global/private access. Memory backend behavior remains separately qualified. |
| Subgraphs | branch_call, branch refs, child execution lineage and limits | Child research workflow deployed first, parent binds its exact ID. No shadow scheduler. |
| Multi-agent | canonical managed Agents, persistent/ephemeral targets, fork/join/map | Two explicitly supplied existing identities execute independently; existing issued destination handles one freshly imported organization. No provider-native substitute. |

Representative source lives in `examples/branches-capabilities/application.ts` and
its README, alongside `examples/branches-client` and `examples/branches-engine-app`.
Deploying this example performs real work only when explicitly invoked by its
caller; writing the source did not deploy it. All execution, fresh-instance,
crash/lost-response, upgrade and comparator qualification remains deferred.

## Matched comparator definition

`examples/branches-capabilities/comparator.py` mirrors the public Branch app:
question → parallel research subgraph and independent critic → ordered review
payload → explicit editable approve/reject → retained approved answer. Caller
provides actual chat models and authorized evidence search. No fabricated tool
response or backend identity equivalence. Its requirements file pins only the two
top-level framework releases; provider packages/model versions remain caller input.

| Capability | Comparator operation and official definition |
| --- | --- |
| Graphs | StateGraph nodes/edges and parallel fan-in: [workflows](https://docs.langchain.com/oss/python/langgraph/workflows-agents). |
| State | TypedDict question/research/critique/answer; distinct parallel output keys: [graph API](https://docs.langchain.com/oss/python/langgraph/graph-api). |
| Checkpoints and rewind | InMemorySaver, get_state_history and explicit selected checkpoint config: [persistence](https://docs.langchain.com/oss/python/langgraph/persistence). Replay can repeat model/tool calls; Branch issued admission instead imports retained custody under current review. |
| Human-in-the-loop | interrupt plus Command(resume), caller decision/edit: [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts). |
| Streaming | stream_mode=updates in start/resume/rewind: [stream modes](https://docs.langchain.com/oss/python/langgraph/streaming). This streams state updates; Branch example streams canonical Agent output. |
| Tools | create_agent with caller-backed evidence_search: [tools](https://docs.langchain.com/oss/python/langchain/tools). Branch uses configured native tools, with separate permission semantics. |
| Memory | InMemoryStore retrieves earlier approved answers across threads within this process: [memory](https://docs.langchain.com/oss/python/langgraph/add-memory). Branch example requests permitted catalog search; durable parity is unproven. |
| Subgraphs | Compiled research graph installed as parent node: [subgraphs](https://docs.langchain.com/oss/python/langgraph/use-subgraphs). |
| Multi-agent | Two independently supplied model-backed create_agent instances: [multi-agent](https://docs.langchain.com/oss/python/langchain/multi-agent). Branch uses canonical managed Agent identities; lifecycles differ. |

In-memory comparator checkpoints/store do not survive process loss. Approved memory
publication follows the interrupt in a separate node. Neither example establishes
crash durability, model quality, native effect safety, or framework parity.

## Finite contract successor

U2/U4/U6 and M4 source dispositions are detailed in
[branch-finite-contract-dispositions.md](branch-finite-contract-dispositions.md).
Pinned release source establishes the state gap; the new public state application
is additional source, not an executed replacement for the existing comparator.
Shared-state results use the existing selected checkpoint/replay/remap; original
consumed retry allowance may be up to100 even when retained history is at most32.
