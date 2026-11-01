# Called runtime package publication: exact missing contract

Source analysis against c0cc3743373d8400960fde17f0e52c4ade421a42. This is a
concrete implementation design, not implemented tree support, external blockage,
permission request, or a full Bible #8 conclusion. No execution was performed.

## Why the current composer cannot publish a tree

`BranchInstallationService.apply` receives one `plan.branch_id`. Its `bind` and
`get` closures key every staged resource by that Branch. Chat creation passes that
same owner into the existing managed Chat composer. Access review, stopped-plan
cleanup and retirement are likewise scoped to the one installation Branch. Its
final SQLite transaction promotes resources and invokes `publish` once. Calling
`confirm` recursively for child packages would commit child workflows before the
root transaction and violate all-owner atomicity. Moving resource ownership while
an awaited import is in flight would break the existing recovery lookup.

`BranchPortableRuntimeData` has one `sourceBranchId`, no Branch inventory, and a
validator requiring every execution owner to belong to that Branch. Its Chat and
Agent maps describe identities but do not declare each Chat's source Branch.
`BranchStore.importRuntimeData` resolves one destination definition/configuration,
requires all fresh Chats to belong to it, and allocates execution identities while
inserting owners. `runtimeData` verifies all owners against that same destination.
Removing only the export guard would therefore either omit children or incorrectly
rehome them under the root definition and current policy.

The frontier codec already remaps local path/Step/attempt/control identities, and
`insertBranchFrontier` inserts those canonical rows inside a caller-owned transaction.
It does not publish workflow definitions, allocate a Branch dependency graph or
establish cross-owner parent ancestry. Existing canonical tree continuation has
those responsibilities in its caller. Its accepted-owner creation cannot be reused
unchanged for data import, because it calls fresh acceptance and execution-budget
admission. Import must never acquire either authority.

## Smallest implementable resolution inside the existing writer

1. Extend the current runtime manifest, not the Agent package composer, with an
   exhaustive source Branch inventory. Each Branch needs its exact selected current
   definition/binding pins, nonsecret configuration, package identity, all template
   and execution Chat references, and dependency ref-to-source-Branch map. Historical
   owner pins remain separate exact facts. Preserve unavailable bytes explicitly.
   Include every execution owner and selected parent edge, including terminal children.
   Require closure for owned children and called dependency targets; cycle detection
   must use visited sets and must not silently truncate a recursive workflow graph.
2. During ordinary package preview, flatten the included Chats into the existing
   reviewed package composer with unambiguous logical identities. Add a required
   per-source-Branch destination binding map. Validate directories, engines, triggers,
   secret references and Agent roles against EACH Branch's own definition. Bind the
   entire map to the same manifest acknowledgment; do not reuse root bindings for
   child definitions. All current per-Agent access/files/output-role review remains.
3. Store an exhaustive source-to-fresh Branch map and logical Chat final-owner map
   in the existing plan's private JSON. Allocate fresh identities once under the
   plan transaction; exact replay must reuse them. Keep staging resources under the
   root staging plan until final publication, so existing async importer recovery
   and cancellation still have one owner. This needs no new table or migration.
4. After every awaited Agent import/current review has settled, enter the ONE
   existing final transaction. Reserve all fresh disabled Branch rows, assign final
   Chat/Agent ownership, publish each Branch through the existing publisher with
   mapped dependency targets, and promote each installation resource to its final
   Branch. Resolve resource handles before changing their lookup keys. A failure
   must roll back every Branch/version/binding/dependency/ownership promotion.
   Source triggers must remain disabled; enabled source configuration is evidence.
5. Allocate ALL execution IDs and ALL local frontier IDs before insertion. For each
   child, resolve its ORIGINAL parent owner and parent attempt in the captured
   parent's selected Step inventory, require that Step's definition to be a Branch
   Call, resolve its original binding to the child's Branch, and verify the actual
   canonical child ancestry/input hash. No root substitution and no fake Request.
6. Insert supported parent frontiers first through the shared remapper/inserter,
   then fresh held execution owners with `parent_execution_id` and the real newly
   inserted parent attempt. Recompute native child occurrence/input identities from
   the FRESH parent attempt using existing Call hash semantics; preserve original
   input hash in private source facts. Preserve call depth/counters/state values.
   Every owner retains explicit portable-data/no-acceptance provenance. Unsupported
   parent frontier families cannot receive invented attempts: retain exact evidence
   and either explicitly classify the linked subtree evidence-only or refuse the
   whole native-tree recreation contract. Do not claim ancestry was recreated.
7. Save one exhaustive receipt with Branch/version/binding/dependency/execution/
   frontier/Chat/Agent maps. Readback must verify actual per-Branch ownership,
   dependency targets, canonical parent FKs/Call step/attempt/input hash, complete
   maps and each recreated frontier, plus absence of admission/leases/dispatch.
   Extend held re-export validation to follow these per-Branch maps and preserve
   original no-acceptance/source-private manifests across generations.

## Required deferred fixture inventory

Use the actual exporter, existing preview/composer/current reviews and final
writer, not direct foreign SQL inserts. A minimal tree has a root Call, a called
Branch with its OWN distinct Script definition/configuration/directory, two children
at distinct parent attempts, and execution-owned Chats with real Agent imports.
Assert distinct fresh Branch IDs and definition/binding/dependency maps, real parent
Call ancestry, original private facts, correct fresh Call input hashes, exact
frontier rows/counters, disabled workflows, no acceptance/admission/leases/dispatch,
no prefix execution, and restart/lost-response readback. Force the last owner or
receipt write to fail and assert no child Branch publication or Chat reassignment
survives. Preserve an active unknown child as explicitly held evidence. Re-export
must retain the original private source tree and prove fresh owner mapping rather
than manufacture historical acceptance. A cyclic dependency graph must terminate
inventory traversal without silently discarding a target; execution ancestry cycles
must refuse.

Foreign selected-checkpoint continuation is separate. After this data publication,
a runnable consumer still requires existing current human review, real fresh
acceptance, execution budgets and current custody reconciliation. The data receipt
must never satisfy those requirements on its own.

## Current disposition

No runtime tree code was implemented in this analysis successor. The scalar plan
and manifest contracts above are the precise missing seam, not an external blocker.
The source graph can be implemented by extending existing private plan/package JSON
and the existing final writer; no new service, provider call, migration, new worker
or UI edit is necessary. Until that change is complete, tree export refusal remains
correct. Automatic standalone evidence preservation and held re-export from c0cc
remain unchanged. This document does not designate tree support as optional.

## Definition-only successor

The subsequent [execution-free publication slice](branch-definition-tree-publication.md)
implements the existing-plan/final-writer extension for ZERO execution owners.
The earlier missing scalar seam remains accurate for execution-bearing trees;
all-owner frontier allocation and real parent Call ancestry are still required.
