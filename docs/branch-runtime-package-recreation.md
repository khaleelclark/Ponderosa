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
rather than requiring the unrelated ordinary-manual-input hash. Proven standalone
automatic standalone serial/parallel Script/ordinary-approval-gate/state/control owners can now recreate their native
frontier **held**, through the same shared origin proof used for continuation. It
requires the exact retained activated occurrence, canonical original payload/media/
provenance/trigger snapshot and native envelope or large-input reference, original
input hash and accepted/started audit. Missing/unavailable/changed or unsupported
automatic Call-tree evidence outside the supported root-only family below or recovery-purpose-gate evidence remains `evidence_only`. No acceptance,
trigger lifetime, scheduler lease or occurrence is recreated. Only a separate human
review/confirm can accept an earlier genuine supported checkpoint with a fresh
manual destination input hash/admission; the source automatic hash stays historical.
The selected and latest cuts independently retain canonical replay and sync/async/
closed-EXIT saver/process-drain requirements. Ordinary approval gates retain
exact selected/latest opening, revision, proposal, choices, response and state-seal
proof. Held recreation/remap and nested re-export retain their evidence without
notifications or source response authority. Only explicit continuation acceptance
creates fresh destination gate identities/pending notifications; completed prefix
decisions stay historical. Existing receipt and bounded generation/local-rewind
replay independently prove original automatic input and fresh manual destination
identity, actual later destination resolution, and full current causal cancellation
where supported. Serial canceled source gates remain refused. The shared eligibility
change reaches these existing callers without a new runtime format, saver/remap,
server/SDK/UI route or gate lifecycle. Existing manual behavior is unchanged.
See [the continuation proof and limits](branch-foreign-checkpoint-continuation.md#proven-automatic-source-standalone-scripts).

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

Supported execution-bearing multi-Branch DATA publication now extends the existing
composer; see [held execution-tree publication](branch-execution-tree-publication.md).
This is source-only supported-family implementation, not runnable foreign continuation
or a full portability/runtime qualification claim.

The separate [fresh-reviewed foreign Script continuation consumer](branch-foreign-checkpoint-continuation.md) is an unqualified source tranche. Its independent human review and canonical fresh manual acceptance/admission are required; a held import receipt alone cannot run data. Tree and other unsupported continuation families remain refused.


Proven automatic standalone parallel owners use the existing Fork/Map/Join typed
inventory and remap. The shared structural frontier admits automatic identity only
without parent/child/resource/issued context; executable continuation separately
requires original occurrence proof and full independent selected/latest causal
parallel replay. Ordered Map items, Join choices/cancellation, attempt fences,
state/loop/traversal seals and real process exits are preserved. Canceled parallel
gates require actual causal cancellation; canceled serial source gates still refuse.
Held recreation does not turn a pending save into durable evidence or adopt source
scheduling/response authority. Existing committed selected and closed-EXIT latest
proof, bounded generation/local-rewind composition, fresh manual confirmation,
destination pending notifications and original-key receipt recovery remain unchanged.
Automatic Call trees beyond the root-only family below, retries, bundles, secrets and issued/native/effectful/resource/
Agent/unknown/in-flight families remain unsupported by this continuation subset.
Runtime package/saver/remap/server/SDK/UI formats and paths need no changes because
they already carry this graph evidence through the shared codec and review.
No execution or notification/timing/durability/round-trip/scheduling/rollback
validation was performed for this extension.


## Automatic-root Script/Call tree successor

The held tree planner now structurally recognizes the supported automatic-root
Script/ordinary-approval-gate/Call family. Only the root may keep a schedule,
webhook or filesystem definition; children keep supported manual definitions and
actual native Call ancestry. Standalone automatic eligibility remains separate.
Held recreation preserves original input/hash/trigger facts and typed parallel/Call
maps but creates no acceptance, occurrence, notification, lease or response authority.
Missing original facts cannot become executable proof through structural recreation.

The [foreign tree consumer](branch-foreign-checkpoint-continuation.md#proven-automatic-root-scriptcall-trees)
separately proves original activated occurrence/envelope/hash/provenance/admission
through the same shared validator with explicit Call-family eligibility. It passes
the original private owner for foreign proof and never falls back to destination
SQL. Complete selected/latest tree causal replay and per-owner configuration remain
mandatory, including parallel controls, state/loops, gates, Call results and process
exits. Every selected automatic-family child needs its own exact committed saver
inventory/invocation/mode/closing proof; a complete root save cannot cover a missing
child save. EXIT latest additionally needs each owner's actual closed saved inventory
and observed drain, with root metadata retained in a complete restorable checkpoint
or genuine terminal nonrestorable `latestOnly` observation. Observations are latest
evidence only. No codec or closure is synthesized, and pending saves do not qualify.

Existing bounded held/admitted/re-export/local-rewind generation proof preserves
original automatic and fresh manual destination identities separately. Explicit
all-Branch current review and confirmation are still required. The destination root
retains the same automatic definition but receives a fresh manual execution hash,
key, provenance and admission; descendants retain native Call acceptance. Original-key
receipt checks the fresh manual hash, prefix ownership, exact commands and supported
current cancellation causality. Prefix decisions/children remain historical once;
pending gates get fresh destination notifications, and only suffix work schedules.
Original source occurrence or scheduler authority is never adopted or replayed.

Runtime fact capture/format, saver lanes/modes/readiness, generation links/remap and
server/SDK review/confirm/receipt paths already preserve this evidence and current
configuration. The UI labels confirmation as a fresh manual execution, while the
existing review exposes the actual automatic root definition. No format/storage-version/
DTO/dependency changes are needed. Automatic
children, retries, issued/native/effectful/Agent/resource/custody/bundle/secret/unknown/
in-flight work and unproven source or EXIT closure remain unsupported. Source support
has no execution, timing/durability, notification, round-trip, scheduling or rollback
qualification.


## Manual standalone parallel retry continuation successor

Manual standalone effect-free Script/ordinary-approval-gate graphs with existing
Fork/Map/Join controls can now pass the portable consumer with canonical Script
retry histories. The shared portable definition guard permits retry only on Script
steps in that family; the serial successor below extends manual standalone
Script retries. Automatic-source and human-gate retry policies remain refused. Call-tree eligibility is unchanged. No import, manifest,
DTO, storage-version or scheduler format is added.

Existing capture retains all attempt rows, failed results, retry transition bytes
and private selected checkpoints. Held import already structurally recognizes the
local parallel codec, remaps all attempts, preserves their consecutive numbers,
input hashes and `available_at`, resets native fences under new IDs and verifies
inserted rows. It creates no acceptance, lease, process or notification authority.
Original creation/event timestamps and source fences stay in private evidence;
native creation/update timestamps describe insertion. Re-exported held mappings
retain exact original manifests and commands under the existing depth/work/cycle/
cache/byte limits, without flattening retry history.

Executable continuation separately replays the exact selected and latest source
cuts using the existing local parallel codec: ordered failed attempts, original
process exits/results, max-attempt policy, delay, retry scheduling, terminal seals,
state revisions, gates and full graph causality. Missing/uncertain/in-flight or
undrained proof stays held. Intermediate failed retries do not contribute state
writes. Committed selected sync/async/default or closed EXIT saver evidence and
actual latest EXIT closure/drain proof remain required.

For a proven prepared retry the original absolute `available_at` survives import
and fresh acceptance; destination claim enforces that deadline and existing
readiness/capacity/policy. This neither restarts a delay nor claims time elapsed.
Consumed attempt numbers remain consumed. Original-key receipt recovery now also
verifies prefix attempt purpose/deadline while allowing legitimate suffix progress;
complete current causal replay still governs copied-gate cancellation. Existing
fresh human/manual acceptance, current configuration/budget/directory review,
pending-gate destination ownership, local-rewind/generation replay and transactional
receipt behavior are unchanged.

Runtime-package capture/validation, saver, parallel codec, frontier remap/insertion,
server/SDK/DTO and UI remain unchanged because they already carry and expose the
complete retry evidence and selection. Only the shared portable eligibility and
receipt integrity comparison change. See the
[retry continuation proof](branch-foreign-checkpoint-continuation.md#manual-standalone-parallel-script-retries).
No tests, preparation, builds, types, Node/native/runtime execution or live database
work was performed. This is source support, not timing/durability, notification,
round-trip, scheduling, rollback or whole-Bible acceptance.


## Manual standalone serial retry successor

Manual standalone effect-free serial Node Script/ordinary-approval-gate workflows
can now recreate their supported native frontier held and continue a genuine
selected checkpoint with canonical Script retries. Definitions may omit controls
or use the existing condition/route/loop family. The shared serial definition guard has
an explicit retry opt-in; structural frontier/replay enables it only for actual
parentless manual standalone owners or their exact terminal observation context.
Existing automatic, Call-tree, issued/Agent/resource serial eligibility and manual
parallel retry behavior are unchanged. Workflow and gate policies still stop.

Capture already retains all original attempts, failed results, timestamps and
retry audit events. The serial frontier now validates consecutive attempt numbers,
original hashes/purpose/fences, failure-only intermediate results, final-attempt
seals and a genuine prepared delayed-retry waiting path. Full serial causal replay
separately proves each lease/authorization/process exit/settlement, consecutive
retry event, max-attempt ceiling, unchanged delay and exact event-time/creation/
absolute-deadline relationship. No intermediate failure contributes state; only
the final successful immutable seal supplies a revision. Conditions/routes, loops,
gates and budgets/counters retain their existing proof.

Exact selected and independently replayed latest evidence, committed selected
sync/async/default bytes/hash and actual closed EXIT invocation/drain proof remain
mandatory. The existing EXIT interruption caller now recognizes the same portable
manual standalone definition only without parent/Call depth/children, retaining
all current pins/authority/saver/closure/hold checks. Missing or uncertain evidence
stays held; source interruption never grants destination authority.

Existing remap/insertion preserve consumed attempt numbers, result bytes and the
absolute `available_at`, create new IDs/zero native fences, and read back inserted
fields. Native timestamps describe insertion; original timing/process/fence proof
remains private. Seeded serial replay checks immutable mapped deadlines and prefix
results, then permits actual unfinished suffix progress. Destination claim still
checks current time/readiness/capacity/policy; new retries use the next retained
number. No delay restart, elapsed-time assertion or replay of failed prefix work
occurs. Bounded held/admitted/re-export/local-rewind lineage, exact commands/maps,
fresh human/manual acceptance/current review, pending-gate ownership and original-
key receipt recovery are unchanged. Serial canceled source gates remain refused.

Runtime-package/saver, parallel codec, typed remap/storage, server/SDK/DTO and UI
need no changes: their existing paths carry all attempts and expose exact private
checkpoint/current review evidence. Only the shared serial consumer, its necessary
EXIT capture eligibility caller and both guides change. No schema, storage version
or dependency changes. See the
[serial retry proof](branch-foreign-checkpoint-continuation.md#manual-standalone-serial-script-retries).
No tests/preparation/builds/typechecks/Node/parser/native/runtime/liveDB actions
were performed. Source support does not qualify execution, timing/durability,
notifications, round trips, scheduling, rollback or whole-Bible portability.
