# Branch-wide working data

Full Branch exports use the existing package engine's `exportAgentSet` to capture
one complete explicitly selected whole-folder set. It is independent of reporting
subtrees: selected Agents in different Chats or called Branches participate in the
same held root map, shared inode inventory and Git association capture. Repeated
identical storage-binding IDs from the shared export form deduplicate. A changed
binding with the same ID or a missing worktree/storage participant refuses before
capture. Shared physical roots must use the same selected metadata/Git families.

`InstalledBranchPackage.workingData` is a hash-bound
`ponderosa.branch-working-data.v1` carrier with a closed ordinary Agent-package
filesystem graph and an `owners` map from each carrier node to an existing logical
Chat/Agent pair. It does not create carrier Agents. It contains only physical
originals, modes/topology, selected native metadata and Git/provider review data;
it contains no conversation, private memory, standing instructions, output role or
access grants. Canonical per-Chat Agent imports retain their separate histories,
memory and receipts. Their staging working-copy mode is Shared; the physical
carrier retains the source mode for the later explicit physical application phase.

One root owns each physical original. Full source captures reuse the existing
whole-folder inventory/export helpers and verify the complete selected inode/root
closure before and after byte capture. Each root's ordinary file/metadata/Git
family choices remain explicit. This is not an independent-writer atomic snapshot.

## Selected nested roots

`AgentPortablePackageDto.workingRootNesting` records immediate selected parent and
child root refs plus the canonical relative directory boundary. The parent's
inventory reports that exact subtree as excluded; the child carries it once. It
is a directory boundary, not a hardlink alias and not a fabricated symlink. This
prevents a normal parent plus nested module Agent from counting one physical file
twice against `nlink=1`. All selected root handles retain their original identities
through capture. Native module/Git recreation still requires its exact native
association evidence in addition to this filesystem ownership graph.

Destination overlap is permitted only when every child path exactly equals its
reviewed parent destination joined with the declared boundary. Undeclared overlap,
aliased destinations, duplicate child declarations, cycles, or duplicated originals
beneath a selected child boundary refuse. Parent roots precede child creation;
metadata finalization follows all file/link/native writes. No existing destination
is adopted or overwritten merely because its path matches the graph.

## Validation and final acceptance

`validateBranchWorkingData` checks the complete ordinary package graph, byte hash,
logical owners, absence of context/grants, and exact physical-original inventory.
The shared `validateWorkingRootNesting` and ordinary package validator also serve
standalone Agent/organization imports. History-only imports never independently
recreate the same physical roots. The canonical Branch installation owns the
separate physical phase and durable completion/partial-result evidence.

Regression source in `tests/organizations/branch-working-data.test.mjs` covers
cross-Chat root aliases and history separation through the actual package engine,
source preservation, nested parent/child inode ownership, typed destination
collision rules, exact global Git-selection deduplication and carrier tampering.
It is registered in the server lane. No tests, builds, typechecks or native
execution were performed during this implementation tranche. Consolidated final
validation must exercise the integrated physical importer, native/module root
layout, receipt recovery, live activation and re-export; source presence is not a
Bible True verdict.


## Export transport

Normal Agent copy/export and Branch export send selections in a JSON POST to the existing export path. Source count, path, family and closure validation remain shared with the legacy GET exporter. The request byte ceiling is the existing 2 GiB package ceiling; selections are never placed in download URLs.

JSON/copy responses and native downloads use the same incremental package serializer and private staging. Staging holds at most 16 prepared or active exports and 4 GiB of serialized bytes. A native download is prepared completely before the UI receives its short same-origin ticket. Preparation failures remain visible in the existing export action. The ticket retries the exact staged bytes for 15 minutes, including after a partial transfer; retrying does not recapture a changed source. Active streams retain their file until close. Expired tickets return 410, and owned temporary files are removed after use/expiry or server shutdown. Tickets do not survive a server restart.

The browser hands downloads directly to its native download manager, avoiding a whole-package Blob or JSON.stringify allocation. Clipboard copies retain their existing bounded streaming reader and switch to complete file download when the clipboard limit is exceeded. Legacy GET links continue to work, using the same staging and serializer.
