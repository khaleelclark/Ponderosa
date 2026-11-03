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
Automatic Call trees beyond the root-only family below, unproven retries (see successors below), bundles, secrets and issued/native/effectful/resource/
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
Script retries; the automatic serial successor below extends proven automatic sources. The automatic parallel successor below extends that family; human-gate retry policies remain refused. Manual serial Call-tree retries use the separate successor below. No import, manifest,
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
The automatic serial successor below extends proven automatic sources. The manual
serial Call-tree successor below has a separate context; issued/Agent/resource
serial eligibility and manual parallel retry behavior are unchanged. Workflow and gate policies still stop.

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


## Proven automatic-source standalone serial retry successor

The existing serial retry continuation now includes original schedule/webhook/
filesystem standalone effect-free Node Script/ordinary approval-gate owners, with
JSON state, condition/route/loop paths, workflow/gate stop policy and per-Script
retry. The parallel successor below separately extends its existing codec; automatic tree retries and called/issued/Agent/resource/native/
effectful/unknown work remain outside this extension; manual behavior is unchanged.

Automatic definition/origin validators require an explicit serial retry opt-in,
defaulting off and incompatible with Calls or parallel controls. Shared frontier/
replay opts in only for an actual parentless standalone or exact terminal context.
Original selected and independent latest automatic cuts retain exact occurrence,
payload/provenance/trigger snapshot, accepted/started/input/hash and admission
proof. Foreign readers use retained facts without source-owner SQL fallback. The
original definition can remain automatic while mapped held/admitted/re-exported/
locally rewound destinations retain their real fresh human/manual acceptance.
Original trigger proof supplies history, never destination scheduling authority.

The same serial replay proves all consecutive failed attempts, per-attempt actual
process exit/settlement, policy ceiling/delay and immutable absolute deadline; no
intermediate failure writes state or seals. Remap/storage keep numbers/results/
`available_at`, seed only the proven prefix and permit actual suffix progress.
Current destination time/readiness/capacity/policy controls claim and future retry
numbers remain `MAX(number)+1`. No delay or consumed-attempt reset occurs.

The necessary store callers explicitly opt into automatic serial origin proof for
held recreation and local rewind. EXIT producer eligibility also recognizes an
automatic standalone owner without parents/Call depth/children, and its existing
owner-chain origin check uses the separate serial opt-in. Current configuration/
pins/authority, real interruption/closure/drain, committed selected sync/async/
default bytes/hash and independent latest proof remain required. No closing
evidence is manufactured. Existing mode-aware saver and destination lifecycle stay
in charge. Unsupported evidence remains held.

Bounded original lineage, fresh review/manual admission/current budgets/choices/
directories/no-secrets, original command/key receipt and pending-gate destination
notifications remain connected. Serial canceled source gates still refuse. Existing
capture/import/readback/re-export, remap/storage/saver and server/SDK/DTO/UI carry
and expose the full proof without format changes. Complete changed files: shared
serial consumer, automatic origin module, necessary store callers and both guides.
See [automatic serial proof](branch-foreign-checkpoint-continuation.md#proven-automatic-source-standalone-serial-script-retries).

No tests/preparation/builds/types/Node/parser/native/runtime/browser/provider/liveDB
actions were performed. Source support does not qualify execution, timing/durability,
notifications, round trips, scheduling, rollback, atomicity or whole-Bible acceptance.


## Proven automatic-source standalone parallel retry successor

The existing parallel retry consumer also accepts proven original schedule/webhook/
filesystem standalone effect-free Node Script/ordinary approval-gate graphs with
fork/Map/Join, condition/route/loop and JSON state/reducers. Workflow/gate failure
policy stays stop; only per-Script retries opt in. Manual serial/parallel and
automatic serial behavior stays unchanged. Automatic tree/Call/issued/Agent/resource/
native/effectful/unknown retry families remain excluded.

Automatic definition/origin validators add a separate parallel retry flag defaulting
off; serial flags remain serial-only. The parallel opt-in cannot combine with Calls
and requires actual fork/Map controls. Structural frontier requires a parentless
standalone owner or exact terminal context. The shared consumer separately validates
original occurrence/payload/provenance/trigger snapshot/input/hash/accepted/started/
admission evidence before parallel replay. Foreign facts never fall back to original
owner SQL. Selected and independent latest must prove the complete graph.

Existing parallel replay/seed logic is unchanged: all consecutive failed attempts,
per-attempt process exit/settlement, ceiling/delay/failure-edge precedence, state
seals/reducers and full fork/Map/Join/gate/cancellation/loop proof remain required.
Remap/storage retain consumed numbers/results/absolute `available_at` and waiting
paths; seed preserves completed prefix work once. Legitimate suffix progress uses
current destination time/readiness/capacity/policy and `MAX(number)+1`.

Held/admitted/re-exported/local-rewind generations keep their actual human/manual
acceptance even with the original automatic definition. Held recreation, local
rewind and the childless EXIT owner-chain origin caller explicitly opt into parallel
proof. The existing portable producer eligibility needs no further change. Current
pins/configuration/authority, actual interruption/closure/drain, committed selected
sync/async/default bytes/hash and authentic closed EXIT/latest whole-graph evidence
stay mandatory. Missing/in-flight/undrained evidence stays held, with no recreated
source scheduler/trigger/lease/response authority.

Fresh review/manual admission/budgets/current choices/directories/no-secrets, bounded
lineage, original-key receipt/purpose/deadline recovery, pending-gate destination
lifecycle/notifications and supported parallel causal cancellation remain connected.
Serial canceled source gates remain refused. Capture/import/readback/re-export,
saver/remap/storage and server/SDK/DTO/UI need no format changes. Complete changed
files: shared consumer, automatic origin, parallel structural consumer, necessary
store callers and both guides. See [parallel automatic proof](branch-foreign-checkpoint-continuation.md#proven-automatic-source-standalone-parallel-script-retries).

Source only: no tests/preparation/builds/types/Node/parser/native/runtime/browser/
provider/liveDB execution. Execution, timing/durability, notifications, round trips,
scheduling, rollback, atomicity and whole-Bible acceptance remain unvalidated.

## Manual serial Call-tree retry successor

Private tree recreation and selected continuation now admit proven manual serial
Node Script/ordinary-approval-gate/branch_call owners with canonical per-Script
retries. Every retained owner must have a manual, effect-free serial definition,
with no parallel controls and stop policies for workflow, gates and Calls.
Existing condition/route, edge loops and JSON state remain supported. Automatic
root trees, parallel-tree retry families and issued/Agent/resource/native/
effectful/unknown retries retain their previous boundaries. Existing standalone
manual/automatic serial/parallel support is unchanged.

The shared consumer adds a default-off serial-tree retry opt-in and a separate
`serialTreeRetries` owner context. Complete-tree validation and runtime-tree
recreation opt in only when the whole owner inventory qualifies; each owner's
actual manual-root or matching Call ancestry/input is checked separately. Local
and foreign selected/latest replay use the existing serial retry engine, not a
second replay implementation. The normal/default definition guard and automatic
origin validators remain unchanged.

Runtime capture already retains every attempt, result, timestamp, transition and
acceptance fact. Recreation uses the existing exact tree validation, parent Call
binding/input/hash/occurrence/depth/ceiling proof and fresh identity maps. Held
owners acquire no acceptance, leases or dispatch authority. Runtime readback and
re-export continue to verify exact remapped rows and original private manifests.
No transport, storage version, schema, DTO or dependency changed.

Serial replay now preserves retry attempt numbers, absolute availability and
waiting paths inside each owner. Each consumed attempt still needs exact input,
purpose/hash/fence/lease/authorization, actual exit/result and settlement proof,
canonical retry event/creation/deadline/delay/ceiling and failure-edge precedence.
Intermediate failures cannot seal or update state. Waiting Calls must match actual
unfinished admitted children; Calls themselves never retry. Existing typed remap
retains consumed prefix attempts/results/deadlines once; future attempts still use
`MAX(number)+1`, with current destination time/readiness/capacity/policy in charge.

Both selected and independent latest complete trees must replay, including
terminal/current supported evidence. Exact selected committed saver bytes/hash,
per-owner invocation/configuration and required child saves remain mandatory.
Sync/async/default async and authentic closed EXIT are preserved without mode
conversion. Missing child bytes cannot qualify through a root save. Actual EXIT
interruption or gate closure/drain/current-authority proof remains necessary;
latest-only terminal observations never become selected executable cuts. The
EXIT structural producer recognizes only qualifying manual/Call serial ancestor
chains, then retains its existing lifecycle and current-owner checks.

Existing bounded held/admitted/re-export/local-rewind generations, terminal
historical child nonadmission, fresh human review, current mapped destinations,
directories, no-secret choices, Script/Call permissions, per-owner budgets and
capacity remain connected. Foreign acceptance creates an actual manual root and
actual Call children; the source supplies proof, never destination authority.
Original-key receipt verification retains immutable prefix attempts/deadlines
after legitimate suffix work. Pending gates use existing destination notification
and response ownership; serial canceled source gates remain refused.

Necessary caller changes are limited to shared serial frontier/replay, complete
tree validation/portable preflight, runtime-tree recreation, current foreign tree
review and the EXIT structural producer. Saver freeze/after-commit/readiness,
remap/insertion, generation/receipt/local rewind, API/SDK/UI, scheduler claim/finish,
Call creation and server process-group/pipe drain use existing code. See the
[full tree retry proof](branch-foreign-checkpoint-continuation.md#manual-serial-call-tree-script-retries).

This is source-only. No tests, builds, typechecks, preparation, Node/parser/native,
runtime/browser/provider/liveDB or integration actions were performed. Execution,
timing/durability, notifications, round trips, scheduling, rollback, atomicity and
whole-Bible/portability acceptance remain unvalidated.
