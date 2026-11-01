# Branch framework capability inventory

Inventory base: 3a999571db29491060603ff587a0f11b8f9b695e. This is source navigation
and an implementation disposition, not an equivalence verdict. Repository search
found no pinned LangGraph or LangChain comparator versions, dependency locks or
matched comparator applications. Those pins remain **missing**; no external
research or dependency installation was performed. Naming nine capabilities does
not establish framework equivalence or broader API/state semantics.

| Named capability | Existing implementation | Representative application / limit |
| --- | --- | --- |
| Graphs | core BranchDefinition; agents branch-store; WorkflowCanvas | application.ts deploys real fork/join edges through the public client. |
| State | execution input, parameters, immutable step results and ordered result bundles | Child topic parameter and parent input/result flow; arbitrary shared mutable/reducer state is not supplied by this example. |
| Checkpoints and rewind | branch-unit-saver, script/parallel replay, host-cut and issued destination | inspect lists canonical retained checkpoints; no automatic rewind or disclosure. Issued destination adds one generation-zero organization with local parallel state; multi-resource/tree/later-generation consumers remain missing. |
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
