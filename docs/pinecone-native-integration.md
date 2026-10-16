# Pinecone native integration checkpoint

The sole product writer composes the authenticated Pinecone baseline
`2f051cf1458ce4579dc8e0754182dfd383ed85d0`, standalone checkpoint `4e463d52`,
shared voice runtime from `191111a8..29c16fff`, and bounded native memory changes
from `648d9f9`, `2678327`, `1029627` and `c188dd35`. Donor worktrees stay read-only.
The evolved Pinecone `createClientId()` and request publication
`communicationEventId` contract are preserved.

Memory lives in reusable core/agents/server paths. Ordinary Projects and Branches
use the same canonical SQLite revisions, CAS, tombstones, provenance, command
receipts and scoped host authority. The Pinecone menu only binds the existing
operator panel to the loaded persistent owner Project. There is no new Pinecone
memory store or duplicate conversation history.

Shared turn preparation selects at most six lexical memories and 6,000 UTF-16
characters from live authorized scopes. The exact ID, revision, text hash,
record generation and scope enter the submitted provider-input manifest. Scope
generations and hydrated records are rechecked synchronously immediately before
provider submission, including after asynchronous runtime opening. A changed
memory, grant, expiry, policy, lease/fence or owner fails closed. Memory-enabled
turns use the existing fresh-session teardown/reseed path on every turn. This
bounded implementation costs provider cache reuse; it avoids retaining memory
read through tools during an earlier turn. Context rollover/handoff recovery
with memory enabled is explicitly unqualified and rejected, rather than replaying
an old frozen packet. Canonical past messages remain history and are not erased.

The semantic worker, model bytes and semantic graph/lifecycle stack are not
composed or enabled here. Lexical controls and inert fixtures are not semantic
acceptance. Source-backed saves still fail closed because the imported host
layer has no bound exact-content declassification Decision. Self-authored
operator memories are previewed and confirmed; source-backed records cannot be
corrected through the panel. Text-based source-backed Remember/correction and
memory chips remain open work, not inferred from assistant prose.

Voice remains the existing subscription/native speech path. Accepted queued
inline human input is checked against canonical intake and the current Run.
Only the exact successful unnamespaced normalized authorization acknowledgement
can arm candidate speech; bytes arriving before that acknowledgement invalidate
the stream. Native work invalidates it irreversibly. Current successful provider
completion publishes one canonical reply through existing communication authority.
End stops local capture/audio while accepted work continues. Cancel targets an
observed exact Run. Browser onset is `SpeechSynthesisUtterance.onstart`, not
queue time, text receipt, paint or proof of heard audio.

## Proxy integration for review; not deployed

`preview-policy.mjs` exposes `authorizeCandidateMutation` for the existing private
wrapper. The wrapper must pass ordinary authenticated backend reads and the
canonical `memoryCommand` validator imported from built server routes. Only a
reviewed installation may opt into the new routes. For V4 its binding is:

```js
{
  branchId: '0356095a-8d73-4249-b39d-883b978ae119',
  projectId: 'bc94178c-d588-5d5b-a0f6-d409fe773606',
  conversationId: '1982c3cc-702b-5f2b-aab9-76abe3f5c277',
  spokespersonId: 'f1e52ee0-6966-471c-bfe4-c9d04233a39a',
  triggerId: '31ecb11b-7afd-4e2b-a6f3-ee18f46f8f49',
  deliveryMode: 'user-ui', supported: true,
  voiceEnabled: true, memoryEnabled: true
}
```

Before forwarding, call:

```js
const permitted = await authorizeCandidateMutation(
  req.method, url.pathname, parsedBody, reviewedInstallations,
  { readJson: path => ordinaryOperatorGet(path), memoryCommand }
);
```

The server-side GET callback must reject failed reads and use the existing
operator boundary. It must not accept client-supplied decision/Run observations.
Cancellation checks current Agent detail, then the host checks the exact fence.
Decision response checks the exact spokesperson, Project and conversation.
Memory POST reads and writes use the canonical strict command validator, with
only the exact reviewed Project and no global promotion/grant mutation.
Direct messages admit only one exact spokesperson, queued inline text, optional
`voiceReply:true`, and no attachments/model/effort/engine overrides. Saved Agent
selection remains authoritative. V3/V5 policy, schedules and prompts are intact.
Origin checks remain required; `mutationOriginAllowed` defaults to the current
HTTP tailnet origin. An explicit reviewed origin list supports a later deployment
choice but creates no TLS or other exposure itself.

The operational wrapper is outside this repository and was not edited. `experiments/pinecone-shadow/pine-tailnet-integration.patch` contains the exact review-only wrapper delta; applying or restarting it is a separate deployment action. Merely
copying this policy file leaves new routes denied until its exact bindings and
trusted adapter are wired. Memory defaults off. The present wrapper also lacks
the single protected-operator binding required by native operator memory;
enabling an environment flag alone does not qualify it. Do not weaken that
boundary or invent credentials to make a test pass. A deployment/security owner
must resolve the existing operator binding before live controls can work.

## Acceptance still open

No service restart/deploy, listener/Serve/certificate change, live database write,
real provider turn, microphone capture or audio claim accompanies this checkpoint.
Actual source tests use disposable canonical stores and inert adapters, including authenticated Branch-owned socket SSE replay/reconnect and exact-final receipt checks. Browser
checks use loopback fixtures and mocked native speech; they cannot qualify a
physical keyboard or heard audio. Real provider call counts must be reserved by
the manager, and prior outcome-unknown occurrences must not be replayed.

Pinecone launch remains blocked on semantic qualification, source-backed exact
Decision integration, retained-context rollover qualification, live protected
memory binding/enablement, reviewed runtime proxy deployment, actual provider
calls, approved secure origin and physical device/microphone/heard-audio checks.
Recent checks accurately expose old waiting work; diagnosis of those scheduled
agent dependencies remains with operations. Heads-up identification/feedback and
memory chips require canonical provenance, not message-text inference.

A draft PR cannot be published to the configured public origin under the current
no-public-publication instruction. The supplied master has unrelated ancestry.
The manager must provide an approved private target/base. Local patch, bundle,
commit and validation evidence are reviewable while that decision remains open.
