# Research and human review application

`application.ts` exports `createReviewApplication(client, input)`. Supply the
existing local HTTP `BranchesClient`, a Chat, two existing authorized Agents and
a stable deployment command key. Call `start(question, occurrenceKey)` and retain
that occurrence key on an uncertain response. `inspect(executionId)` returns the
canonical state, human actions and available checkpoints. `resolve` submits an
explicit current gate choice; it does not choose for the human. `stream` requires
an exact current execution/Agent/Run and forwards only matching authored output.
No provider, worker, permission, memory store or second execution engine is added.

The application deploys a research subgraph and a parent fork/join workflow that
combines independent research and criticism before an editable human gate. Its
bound Agents retain their existing tool and memory permissions. Instructions to
use tools or memory are requests, not proof they are configured or accessible.
Configure those integrations through the existing Agent settings first.

This is representative source, not executed evidence or framework parity. It does
not expose arbitrary rewind: issued cuts require the existing separate host review
and reconciliation flow; the listed checkpoint's support flag remains authoritative.
The existing `branches-engine-app/server.mjs` supplies a standalone HTTP process;
this module supplies the previously missing concrete multi-capability workflow.
See `docs/branches-framework-capabilities.md` for all nine dispositions and the
released external comparator baseline. No build, typecheck or execution was performed.

The matched Python source is `comparator.py`, with released framework pins in
`comparator-requirements.txt`. `create_review_application` requires two actual
configured tool-capable chat models and an authorized search callable. Nothing
installs, deploys or invokes on import. `start`, `resume`, `checkpoints`, and `rewind`
are explicit caller operations. A rewind may repeat external model/tool effects;
it is not equivalent to reviewed Branch custody admission. Comparator memory and
checkpoints live only in the process. The nine-capability inventory links official
source documentation and distinguishes these semantics from the Branch example.
