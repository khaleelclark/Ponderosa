# Permission history and protocol delivery

Tool permission changes use `CapabilityPolicyStore.put`. The policy revision and
its history row commit in one SQLite transaction: if either write fails, neither
commits. Each row records scope, revision, previous/new restricted capability IDs,
timestamp, actor boundary and reason. Operator Settings/API calls are labeled
`operator`; internal store calls default to `system`. There is no person-level
identity or authentication claim. Settings show **Permission change history**
using the same shared editor in regular Ponderosa and Branches.

Each capability endpoint has a matching `GET <endpoint>/history`, with the same
product/resource owner checks. It returns newest first, 50 changes per page;
`nextBeforeRevision` supplies the next `?beforeRevision=` cursor. Failed validation
and revision conflicts do not create history. Current state remains in
`capability_policies`; the new history is not a second permission authority.
Existing installations start recording at upgrade. No older actors or changes
are invented; the first new mutation captures the actual existing before state.

Stable communication instructions live in `communicationV3SessionPrompt`, sent
through the provider system channel. `communicationV3Prompt` carries only the
current Run reply route on initial dispatch and steering. Restoring a single
canonical authored input previously discarded the scheduler wrapper; preparation
now preserves its current reply route. Raw/coalesced Activation packets retain
the route already in their scheduler wrapper. Required authority, fencing,
request lifecycle, question routing, artifact publication, voice and managed-Agent
rules are retained in the session contract. Tool descriptions remain available.

The measurement evidence compares exact stable and injected text at base
`eec1e7952` with the changed protocol using ordinary-text `o200k_base` BPE and the
official rank table (SHA-256
`446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d`).
The evidence script records exact prompt bytes, hashes and algorithm. Stable
session: 598 tokens before and after. No-default-route injection: 640 → 69 tokens.
Session plus first injection: 1,238 → 667 tokens. This measures only the named
protocol strings, not complete provider requests, billing or Claude tokens. The
single restored human-input path previously omitted the route; its added authority
is a correctness fix, not a token saving. A representative real core/Branches log
sample and independent blind judge panel remain required for commandment 11.

Existing canonical databases from the immediately preceding schema (through
0027, before capability history) have one explicit online transition. Admission
first verifies their exact schema and migration receipts, integrity, generation
and physical directory authority using the existing private snapshot. Under the
same lease it rechecks the live predecessor, then adds history and its receipt
in one transaction and validates the result before commit. Current policies and
Chat authority are retained; historical events are not invented. A failed
migration rolls back; unknown, incomplete and mismatched-generation stores are
still refused without rewriting them. This is not a generic legacy-state path.

Genuine base-build regression command (base build must be the frozen eec1e7952
runtime-access checkout, with built dependencies):

```sh
PONDEROSA_UPGRADE_BASE_AGENTS=/path/to/frozen-base/packages/agents/dist/index.js node --import ./tests/shared/workspace-resolution.mjs --test tests/branches/capability-history.test.mjs
```

The optional base-build tests cover a populated normal upgrade/reopen, rollback
following executed DDL, unknown/incomplete schema, false/missing migration
receipts and generation mismatch, including source-byte preservation on refusal.
