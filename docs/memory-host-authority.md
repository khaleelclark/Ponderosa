# Explicit memory host layer (disabled development feature)

This stage binds canonical storage to trusted host authority. It does not deliver
semantic memory, startup recall or the complete memory MVP. Project Settings
now provides the bounded operator management panel described below.
Local Memory MCP semantic adaptation remains intended; FTS results are explicitly
lexical. Source development is stacked on the foundation at
`648d9f9ba1e6dd870224193e2815b1f8273c6430`, not an approved release baseline.
Branches remains the release priority. No merge or release approval is implied.

## Gate and operator boundary

`PONDEROSA_MEMORY_ENABLED=true` opts into bounded development routes/tools;
anything else defaults off. `CreateServerOptions.memoryEnabled` is the equivalent
embedding option. Off installs additive schema and preserves records, while
exposing no routes/default tools. Project deletion still purges and revokes grants.
There is no UI toggle or production readiness claim.

Existing launcher/bearer/trusted-proxy operator hooks authenticate operator routes.
The layer additionally requires one protected installation operator: launcher or
bearer protection, or exactly one configured proxy identity. Ambiguous proxy
allowlists and unprotected embeddings cannot access operator/global memory.
An Agent bearer never authorizes operator routes. Presentation names, headers and
token hashes never become owners. `0034_memory_host_authority.sql` persists an
opaque UUID installation owner; it is not a credential or per-person account.
Changing who operates the installation does not create private tenancy. Multiple
people sharing a token or launcher session remain the same installation operator.
True multi-operator isolation/membership/Run binding is still absent.

## Runtime authority and scope

`MemoryAuthority.forAgent` supplies the foundation's synchronous resolver. Every
content read/mutation resolves inside the same SQLite transaction. It checks the
exact capability token and active local Run, authoritative scheduler status/fence,
canonical Run Agent/Project, canonical Agent/Chat/Project ownership, archive,
creation quarantine, deletion sets/receipts, product and installation lifecycle.
Cleanup and outcome-unknown authority cannot authorize memory. Existing policy
resolution includes installation, product, Branch, Chat, immutable spawner
lineage, Agent and Run restrictions. `memory.read` and `memory.write_project`
restrict advertised tools and are rechecked live, including cached resolver handles.
No model-supplied identities, grants, raw collection names or worker tools exist.

Project is the only default save scope. Agents in the same durable Project may
read explicit Project memory across Chats/products; original source links keep
narrower audiences. Canonical Project ownership and current product authority,
not a URL namespace or working folder, decide access. Memory author IDs remain
provenance and are exempt from generic recursive resource projection filtering
only on the exact authority-checked memory routes. Other product projections and
communication authority are unchanged.

Temporary execution-owned Branch Projects cannot save/correct/forget durable
Project memory or receive global grants until an explicit durable target exists.
They may read current authorized records in their actual Project. No Branch
memory scope or silent persistent-Project inheritance/mapping exists.

## Routes, tools and grants

All routes below are absent when disabled. Bodies reject unknown fields before
Fastify can strip or coerce them, including nested source fields. Text/results/
source/query bounds and canonical normalization/CAS/idempotency remain in the
common store. No raw upstream MCP tools reach providers.

- `POST /api/agent-memory`: `search/get/save/update/forget`, dispatched by the
  corresponding `ponderosa_memory_*` tools in Codex and `memory_*` MCP tools in
  Claude. Both receive the identical frozen schema/definitions, and share host
  operations. MCP legacy defaults exclude these tools. Source classification
  defaults to `agent_inference`. Agent global save/update/forget is unavailable.
- `POST /api/projects/:id/memories`: authenticated operator
  `search/get/list/history/save/update/forget/promote` for an owned live Project.
- `POST /api/memories`: authenticated installation-owner global operations,
  except promotion uses the source Project route.
- `PUT /api/projects/:id/memory-global-grant`: `{enabled,expectedRevision}`.
  Operator-only CAS grants apply to Project plus product. This deliberately
  narrower restriction is not another memory scope. Grants start absent/denied;
  regrant/revoke advances the revision. Agent readers re-resolve it inside every
  transaction. Project deletion revokes enabled grants in the purge transaction,
  retaining revision receipts even without memory records or with the feature off.

Search returns `{retrieval:"lexical",memories:[...]}`. There is no semantic worker,
readiness/index-state promise or automatic startup query. Memory remains inert
context data, never live host authority. No automatic extraction/capture occurs.

Global promotion requires an explicit authenticated operator command with source
memory ID, expected revision, exact current text SHA-256 and stable commandKey.
It creates a separate global ID, retaining source ID/revision/hash in
`memory_promotions`. Ownership never changes in place. Canonical receipt hashes
include lineage: same-key changed lineage conflicts. Promotion reads and writes
in one immediate transaction, strips restricted source links, and preserves
classification/expiry. Replays require the source to remain current/visible;
forgetting/correcting the source can invalidate a promotion retry. Operator global
captures explicitly author a `user_statement`; an Agent cannot claim one.

## Source limits and remaining authority port

Current communication/artifact sources are Chat- or recipient-scoped. Sharing
that text as Project/global memory expands the audience. This stage refuses all
structured source-backed saves by Agents and operators because no exact-content
source declassification Decision port is bound. It does not implement a parallel
approval service. Self-authored operator text and explicit unsourced Agent
inferences remain available. General paraphrase copying cannot be prevented by
reference checks; no data-loss-prevention guarantee is made.

Historical source links, if present, are independently checked live against the
canonical source Project/product/Chat/audience. Initial immutable inline
communication refs use revision `"1"` and SHA-256 of exact event text. Corrected or
artifact-backed communication refs are suppressed until a revision/document
binding is implemented. Artifact refs use revision `"1"`, canonical artifact
SHA-256 and the existing Agent artifact predicate. Global links without a trusted
source Project binding are suppressed. Access never expands via a reference.
A future explicit Remember UI must preview exact text/destination and bind the
existing operator Decision machinery to audience expansion before enabling
source-backed capture. This is an incomplete functionality gate.

## Validation and next gates

Disposable tests use actual SQLite scheduler leases/cancellation and capability
policies, ordinary operator security hooks/product routing, real Fastify dispatch
and a real child MCP transport (no provider subscription calls). They prove the
bounded operations layer, not real provider startup recall or shared-daemon
multi-user isolation. Run after dependency-order builds:

```sh
node --test apps/server/test/memory-authority.test.mjs
```

The semantic proposal and publisher artifact pins are in
`memory-semantic-worker-proposal.txt` and `memory-semantic-artifacts.json`.
No Python/package/model artifacts were installed or provisioned.
Remaining gates include semantic implementation and packaging, complete transitive
hash lock/licenses, source declassification/revision binding, startup/reseed
recall/exposure generations, source/global UI and end-to-end cross-provider qualification.
Grant/policy/content generations will need joint validation before future provider
submission; this stage does not invalidate already delivered provider context.
Forgetting suppresses subsequent host reads; it is not retroactive provider erasure.
Old canonical SQLite restore still needs a complete newer deletion/grant ledger
before recall can resume; no restore-completeness service is implemented.
Independent review must attack each runtime/operator/direct ID/receipt path and
both bridges at the exact final head. Integration remains a separate writer/task.


## Project Settings controls (isolated development slice)

Open **Project memory** in the existing Project Settings view. The panel uses
only the authenticated, product-aware Project operator route above. Opening,
searching and history do not save anything. Lists, keyword searches and history
are bounded to 20 records/revisions. Text is rendered inertly and scrolling is
bounded; it never changes operator rules or grants.

**Write a memory** accepts deliberately self-authored text (at most 10,000 Unicode
code points). **Review memory** previews the exact text and named Project;
**Remember for this Project** confirms sharing with authorized Agents in that
Project. A successful receipt means canonical save and immediate keyword-search
availability, not semantic indexing, provider delivery or future-Run recall.
No message-source capture, global promotion, configuration, provisioning,
credential, semantic-worker, startup or restore control is provided.

Corrections use the confirmed current revision, retain classification and expiry,
and create a new revision. A 409 keeps the draft and requires a fresh review;
it never automatically overwrites a concurrent correction. Returned source-backed
records are correction-read-only. The canonical `MemoryDto.sourceBacked` marker is computed before source-link
filtering. Manual correction requires explicit `false` from an authorized current
record; `true`, absent or unknown stays read-only. An empty visible source array
never grants correction. The marker reveals no source IDs/counts/kinds/paths/text
or links and does not authorize a source read or save. Records remain readable
and forgettable when correction is unavailable. Existing unsourced records can
be corrected after reload; no mounted-session provenance cache is needed.

**Forget memory** explains that all revisions disappear from normal reads while
permanent erasure is not promised. Audits/backups may retain text. Confirmation
uses the current revision. Current text, lists and history are invalidated, and
late responses cannot restore forgotten content. No upstream restore is exposed.

Read failures and authorization loss hide old text, including cached detail and
history. Project/product changes discard local state and reject late old responses.
404 shows unavailable controls with an explicit read retry, without inferring the
exact configuration flag. 401/403 disables mutations; network/5xx errors never
claim a save or semantic readiness. Default-off retains records and exposes no
routes or mutation controls. Enabled but unprovisioned remains lexical, with no
semantic/provider launches or credentials required by this panel.

An ambiguous confirmed write retains one immutable payload, revision and command
key in mounted memory. **Retry exact attempt** checks that same intent, including
when the original commit succeeded but its response was lost. New writes are
blocked while it is unresolved. No automatic retry, remount write or private-text
browser persistence is added. Reloading or leaving the Project loses client retry
state; do not assume a missing acknowledgment means the save failed.

Focused runnable check, after frozen offline dependencies and own dependency-order
builds (core/native-host, engines, agents, server, then affected web):

```sh
pnpm --filter @ponderosa/web typecheck
pnpm --filter @ponderosa/web build
PONDEROSA_CHROMIUM_PATH=/path/to/existing/pinned/chrome node apps/web/test/memory-project-controls.check.mjs
```

The check uses existing pinned Playwright (server's playwright-core unless
PONDEROSA_PLAYWRIGHT_PATH specifies an existing module), a disposable authenticated
socket server with engines=[] and canonical SQLite. `--before` substitutes the
exact 907ce0c Settings body (only relocated import paths) and must fail the absent
control oracle. No browser/dependency downloads are part of the check. Fixture
close is ordinary disposable-server cleanup, not complete-tree retirement or
native/platform/provider qualification. This branch requires independent review
and explicit donor/composition acceptance before production exposure. The held
6c149d semantic lifecycle and combined/release gates remain unqualified.
