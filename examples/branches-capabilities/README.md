# Research and human review application

`application.ts` exports `createReviewApplication(client, input)`. Supply the
existing local HTTP `BranchesClient`, two existing Branches and their expected version IDs,
a persistent researcher in the research Branch, a persistent critic in the parent Branch,
and a stable deployment command key. Create fresh, dedicated Branches and their Agents
explicitly first; this example does not create or grant access to Agents. Deployment replaces
each supplied Branch definition and bindings, and the manual trigger can disable or remove an
existing trigger. The two deployments are separate: if the parent deployment fails, the
research Branch may already have changed. Do not use existing work Branches for this example.
Call `start(question, occurrenceKey)` and retain
that occurrence key on an uncertain response. `inspect(executionId)` returns the
canonical state, human actions and available checkpoints. `resolve` submits an
explicit current gate choice; it does not choose for the human. `stream` requires
an exact current execution/Agent/Run and forwards only matching authored output.
No provider, worker, permission, memory store or second execution engine is added.

The application deploys a research subgraph and a parent fork/join workflow that
combines independent research and criticism before an editable human gate. Its
bound Agents retain their existing tool and memory permissions. Instructions to
use tools or memory are requests, not proof they are configured or accessible.
Configure those integrations through the existing Agent settings first. Optional
`rememberApproved: true` asks the critic to search its current Chat memory and,
after approval only, save the approved answer to that same Chat. It grants no
permissions. This Chat-scoped persistent memory differs from the comparator's
process-local `InMemoryStore`. Tool availability and whether an Agent follows
the instruction must be checked; a completed Agent turn alone is not proof of a
memory write.

A disposable synthetic HTTP fixture exercises deployment, two controlled Agents,
the called subgraph, and human approval. This does not establish live-provider or
framework parity. The example does not expose arbitrary rewind: issued cuts require the existing separate host review
and reconciliation flow; the listed checkpoint's support flag remains authoritative.
The existing `branches-engine-app/server.mjs` supplies a standalone HTTP process;
this module supplies the previously missing concrete multi-capability workflow.
See `docs/branches-framework-capabilities.md` for all nine dispositions and the
released external comparator baseline. A separate synthetic comparator run uses
deterministic models and search, and does not establish live-provider parity.

The matched Python source is `comparator.py`, with released framework pins in
`comparator-requirements.txt`, including the tested prebuilt dependency. Other
transitives are not locked. `create_review_application` requires two configured
tool-capable chat models and an authorized search callable. Nothing
installs, deploys or invokes on import. `start`, `resume`, `checkpoints`, and `rewind`
are explicit caller operations. A rewind may repeat external model/tool effects;
it is not equivalent to reviewed Branch custody admission. Comparator memory and
checkpoints live only in the process. The nine-capability inventory links official
source documentation and distinguishes these semantics from the Branch example.


`state.ts` adds a public-client shared-state application: two Script contributions
use append/sum channels; a Script after Join computes a custom aggregate into a
replace channel. Caller supplies a working directory and explicitly invokes it.
Read using `BranchesClient.sharedState`. A disposable synthetic HTTP fixture
exercises the example; this does not establish provider-backed or framework parity.
Settlement ordering differs from LangGraph supersteps. See `docs/branch-finite-contract-dispositions.md` for exact semantics.
