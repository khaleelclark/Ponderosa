# Bounded host memory restoration slice

`LocalMemoryService.exportPackageMemory(chatId, agentIds)` and
`restorePackageMemory(snapshot, chatId, sourceToDestinationAgents, operationId)`
are trusted host methods, not Agent tools or public endpoints. The owning host
caller must perform human export/import admission before invoking them. They
check canonical active Chat/Agent ownership throughout storage access and track
in-flight calls for shutdown. They use the existing `AuthorityStorage` and
Chroma collections, not a second memory database or authority system.

The `ponderosa.chat-memory.v1` snapshot records the embedding signature, source
Chat and included Agent inventory, chunks, conflicts, original source stamps,
text, metadata and actual 384-dimensional embeddings. It explicitly declares
`excludedScopes: ["global"]`. Export includes the selected Chat's team audience
and only the listed Agents' private audiences. Deprecated ancestors and conflict
references must form a complete, acyclic graph within one audience. Foreign or
unclassified source stamps cause an explicit error. This operation never sweeps
installation-global memory or source policy/grant databases.

Restore validates the schema, allowed structural fields, embedding signature,
finite vectors, provenance, lineage, conflict references and exact Agent mapping
before writing. Both directions enforce a 16 MiB serialized snapshot bound and
10,000 total selected rows; export also bounds the inspected inventory. Known
credential-named metadata fields are rejected. Arbitrary memory text remains
user data and can be sensitive; the existing full-export warning remains
required. Generic encoded metadata needs the independently reviewed shared
known-secret validator before this format is exposed in product packages.

Destination principal, Chat ownership and private Agent audiences are rebound.
Original stamps remain inert `package_source_stamp` metadata; original lineage
origins remain historical provenance. New source provenance names a historical
package import, never a source Run capability. The destination's policy and
readGlobal grants stay unchanged. No scheduler Runs, activations or outbox work
are created. Chroma stores vectors as float32; exported Chroma vector values
survive exactly, and hand-authored inputs use Chroma's float32 representation.

IDs derive from destination principal/Chat, operation ID, source Chat, row kind
and original ID. Repeating an identical operation accepts only identical
existing rows. Any differing content causes a collision error without
replacement. A failed write compensates only IDs absent at preflight and
attempted by that call. If ownership is revoked or compensation fails, an
explicit incomplete-installation error is raised. Chroma is not transactional:
this helper does not claim crash recovery or a durable import receipt. The
caller must keep its existing durable creation-operation fence until commit.

## Verification

Run after building dependencies and server:

```sh
TMPDIR=/tmp PONDEROSA_TEST_CHROMA_BIN=/path/to/existing/chroma PONDEROSA_TEST_MEMORY_MODEL_DIR=/path/to/existing/models node --import ./tests/shared/workspace-resolution.mjs --test --test-concurrency=1 tests/memory/portability.test.mjs tests/memory/deletion-lifecycle.test.mjs tests/memory/startup-config.test.mjs
```

The portability fixture starts its own Chroma process and creates separate
source/destination service policy directories, canonical stores and collection
prefixes using existing local models. Core and Branches checks compare text,
vectors, deprecated lineage and remapped conflicts, source/destination
principals and private/team visibility; they reopen/re-export, preserve denied
read authority and destination global grants, and assert empty scheduler
Runs/activations/outbox. Other checks refuse malformed/oversized/incompatible
snapshots before writes and simulate a partial write failure with unrelated
pre-existing rows preserved.

## Unfinished product integration

These host methods are not yet called by Agent, organization or Branches package
routes. Existing user exports still omit memory. The next slice must add a
shared package DTO/parser and size accounting, human inventory admission,
Chat-level deduplication, Branch logical-reference mapping and explicit handling
of required global data. Its durable creation-operation integration must support
its own pending Agents, stage/commit/recover/rollback the package namespace and
handle process death, cancellation and destination deletion. The present active
ownership guard intentionally cannot authorize pending creation-operation Agents.

The execution archive's independent known-secret P1 correction must be reviewed
and integrated separately; this branch does not modify that archive or its
tests. Provider-native transcripts, exact provider inputs, historical Branch
execution Chats and full workflow equality remain open. Full portability (#8)
is still False; no upgrade, whole-suite pass or 20-run streak is claimed.
