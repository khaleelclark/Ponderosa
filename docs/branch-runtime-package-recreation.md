# Full Branch runtime data packages

Source implementation only. No fixture, build, provider/native work or fresh-machine qualification has been executed.

`branch-package.v1` remains a definition-only template. The existing installation
export `GET /api/branches/:id/package?mode=full` now also includes
`runtimeData: ponderosa.branch-runtime-data.v1` when the workflow has executions.
Template export never includes runtime data. An execution-free full export has no
runtime manifest. Existing full Agent-only packages remain accepted, without a
claim that their absent runtime data was recreated.

## Actual recreation inventory

| Data | Export | Fresh import and readback |
| --- | --- | --- |
| Current workflow and installed Agent data | Existing definition/parameter/limit and full Agent package exporter, including current portable file fields | Existing publisher, composer, Agent import receipts, file/access/output-role review; no competing writer |
| Standalone manual and automatic execution owners | Every owner of the selected Branch, bounded at 1,000; original input/hash/output/state, path/Step/attempt/fork/join/map/loop/sealed-result inventories through the shared selector | Fresh canonical execution identity with explicit `runtimeData` provenance and `waiting` hold; no acceptance, automatic execution-budget debit or admission |
| Nonsecret original pins, counters and application state | Exact definition/binding JSON, provenance and original nonsecret configuration; required secret refs are named | Original facts remain immutable data. For an exact current-definition, nonsecret, effect-free shared-codec frontier, the existing remapper/inserter recreates fresh paths/Steps/attempts/seals/control rows and original counters/configuration; receipt supplies its actual idMap. Other cuts explicitly report `evidence_only` |
| Private saved checkpoints | Every initial and selected snapshot's original JSON bytes and hash, with source identity | Exact retained facts in the private Branch command manifest, not executable foreign checkpoint rows; no old invocation/lease adopted |
| Transition and command journals | All owner transition evidence and command JSON bytes, original keys, input hashes and timestamps | Exact private facts; original command keys are not installed as action authority |
| Current host and previous restoration facts | Existing host-cut/provenance codec captures Requests, updates, joins, original audiences and resource facts | Evidence remains original. No foreign Request, Join, activation, Run, grant, communication or process is created |
| Execution-owned Chats | Full export includes current execution-owned Chats and their full Agent packages, with exact source Chat/Agent logical identity inventory | Existing fresh Chat/Agent composer; final transaction assigns each execution Chat to its mapped fresh execution owner. Receipt has source-to-fresh execution/Chat/Agent maps |
| Retained private resource packages | Known resource/issued/group/generation-exit journal receipts are read through the existing custody reader; source receipt and separately hashed validated portable package are included | Package bytes remain reviewed private data; they do not become a current custody receipt or grant. Unavailable/released originals are named `unavailable_held`, not dropped or reconstructed |
| Unknown/native effects | Source selected attempt states and host evidence remain present | Receipt remains `held`, with `currentAuthority:false`, `dispatched:false`, `nativeState:not_adopted`. Leases/process identities are excluded by the shared selection and never copied into native rows |

The manifest hashes each exact fact byte string, each exhaustive owner inventory
and the complete manifest/identity maps. Original source IDs remain in evidence;
fresh IDs are native destination owners, never invented historical actors.
The supplied package hash establishes data integrity, not origin authentication
or permission to execute a foreign cut. Even rehashed caller-authored packages
cannot enable imported execution.

## Review, atomicity and recovery

The existing installation preview returns every runtime fact in its operations
and `runtimeDataReview` with the exact manifest hash, owner/fact counts and held
disposition. Confirmation requires both the existing full-context acknowledgement
and `acknowledgeRuntimeDataSha256` copied from that review. Runtime-data packages
require a **new** workflow; they cannot overwrite an existing installation.
Existing per-Agent current access, working-root and output-role reviews still apply.
Known secret bindings are excluded and required secret refs are retained. A saved
checkpoint that contains known secret bindings refuses export rather than silently
changing its bytes. `includeValues` controls current installation parameter defaults;
original nonsecret execution configuration remains required runtime evidence.

Capture uses the existing canonical owner transaction and selected/host codecs.
It compares source cuts around awaited Agent/package reads and refuses a moving
cut, including newly added execution Chats. No broad filesystem or database copy
is used. Custody package reads preserve source-private evidence; no public artifact
or cross-audience Communication is published.

The final existing installation transaction publishes the definition, disables the
new workflow, imports all data owners/frontiers, binds their Chats and commits one
hash-bound manifest/receipt together. A final owner/manifest write failure rolls
back that entire publication. Native frontiers stay nondispatchable even if the
workflow is later enabled. The scheduler hold precedes reduction, and ordinary
intervention or initial-checkpoint promotion refuses imported owners. No imported
human gate notification is emitted. Current credentials must be reentered.

`GET /api/branches/installations/:id/runtime-data?branchId=<fresh Branch>` and
`BranchesClient.installationRuntimeData` return the exact saved data and receipt
without repeating imports. Installation status/confirmation expose the held receipt.
Readback verifies the stored manifest, exhaustive native owner maps, execution Chat
custody and each recreated frontier through the same remapper. The journal remains
in the private Branch namespace and normal Branch deletion removes it; this does
not create an undeletable host archive or weaken deletion/precleanup guards.

## Exact remaining implementation

This is bounded standalone data recreation, not full Bible #8 or a fresh-machine
resume claim. Called owners/cross-Branch trees
currently refuse complete runtime export, so they cannot disappear from a nominally
successful full export. Larger owner trees and their fresh per-Branch installations,
Call ancestry/attempt allocation, and atomic dependency publication remain.

Cuts with issued Requests/resources, unknown or active native effects, changed
historical definitions, required secrets or unsupported codec shapes preserve all
facts as `evidence_only`; they do not recreate live host coordination or resource
membership rows. Applying a selected foreign checkpoint as a *runnable* current
continuation still needs a separate current-authority/package-custody consumer and
human reconciliation. No such continuation or retry authority is granted here.

Prior external restoration/private-artifact references not owned by the selected
Branch are retained as references, not expanded into foreign Chats or grants.
Erased/unavailable custody bytes cannot be fabricated. Git/config,
external-link/special-node/extended-metadata coverage remains Reliability-owned;
its exact portability inventory still applies. Web review/rendering is UI-owned.
All new fixture source is deferred, including ASYNC/SYNC held frontier recreation,
exact manifest review, unknown lease evidence, execution Chat remapping, lost-response
readback/restart, corruption/omission/alias/credential refusal and final-write rollback.

## Standalone automatic-source and held re-export successor

Standalone automatic-source owners now use the same reviewed held publication as
manual owners. Trigger-origin owners retain the exact original occurrence payload,
provenance, trigger snapshot, media type, activation configuration and input hash
when the occurrence still exists. Missing original occurrence bytes are explicitly
`unavailable_held`; no current trigger, schedule, occurrence or native activation is
created. Trigger-origin manual admission likewise retains its original trigger hash
rather than requiring the unrelated ordinary-manual-input hash. The existing runnable
frontier codec still requires manual/called admission, so original automatic-source
frontiers are retained as `evidence_only`; their fresh held execution owner and Chat
ownership are recreated, but their native path/Step frontier is not. Unknown source
families still refuse. This is data preservation, not trigger lifetime recreation.

An imported held owner can be exported again. A private `import` fact retains the
complete original manifest and receipt, including private checkpoint/custody facts
that were never installed as executable rows. Validation follows nested original
manifests, verifies hash/owner/input/installation identity and preserves absence of
acceptance. Capture refuses a held owner that acquired admission or lost its original
manifest. Existing nesting and byte bounds still apply; re-export can reach those
bounds and refuses instead of dropping earlier generations. The original source
facts remain under their original IDs in private evidence; fresh owner IDs describe
the actual installation. No current custody or origin authentication is inferred.

Deferred source fixtures cover an actual composer re-export/re-import/restart,
no acceptance, exact original manifest preservation, and automatic occurrence input
identity/refusal. The automatic fixture is a contract fixture, not provider or trigger
qualification. All execution remains forbidden/unrun in this slice.

**Incomplete requested work:** called/cross-Branch owner tree export and recreation
still need per-Branch publisher/composer plans, dependency pin maps, actual remapped
parent Call attempts and atomic publication across the complete tree. No tree guard
was removed. Supported selected foreign-checkpoint continuation also remains
unimplemented: import data alone cannot satisfy existing current custody, fresh
acceptance, budget and human-review consumer requirements. These are implementation
gaps, not approved exclusions or an assertion that all permutations are required.

The exact scalar-plan/ownership obstacle and smallest existing-writer resolution are
recorded in `branch-runtime-tree-publication-contract.md`. That report adds no tree
runtime support and is not an external blocker or an approved #8 exclusion.

Execution-free multi-Branch definition/dependency/template-Chat publication now has
an additive full-package caller contract; see
[definition tree publication](branch-definition-tree-publication.md). This does not
close runtime-owner-tree ancestry or foreign-checkpoint continuation.
