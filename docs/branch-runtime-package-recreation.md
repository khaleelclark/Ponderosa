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
automatic Call-tree evidence outside the supported root-only and separate manual-leaf families below or recovery-purpose-gate evidence remains `evidence_only`. No acceptance,
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
Automatic Call trees beyond the root-only and separate manual-leaf families below, unproven retries (see successors below), bundles, secrets and issued/native/effectful/resource/
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
retry. The parallel successor below separately extends its existing codec; the separately described automatic parallel tree retries remain outside that standalone codec, as do issued/Agent/resource/native/
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
automatic serial behavior stays unchanged. The automatic parallel tree successor below is separate. Issued/Agent/resource/
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
root trees and parallel-tree retry families use the later successors; issued/Agent/resource/native/
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


## Proven automatic-root serial Call-tree Script retries

The serial-tree codec now also accepts a proven schedule, webhook or filesystem
root with manual-definition, actually Call-admitted descendants. Every owner must
qualify as an effect-free serial Node Script/ordinary approval-gate/branch_call
owner, with no controls or existing condition/route controls, loop counters and
JSON state. Workflow, gate and Call failure policies stay stop; only Script steps
may retry. The parallel/mixed-tree successor below separately extends this initial serial scope.
Manual trees and standalone manual/automatic serial/parallel families retain
their separate eligibility. Issued, Agent, resource, native, effectful, unknown,
bundle, secret and execution-owned Chat families gain no retry support.

`automaticScriptDefinitionSupported` and `automaticScriptOriginSupported` have a
separate default-off serial-tree retry opt-in. The shared consumer exposes an
explicit automatic serial tree structural helper, while whole-tree validation
and runtime-tree recreation enable serial retries only if every owner qualifies
and carries no host/issued/resource/action/bundle evidence. Only the parentless
root may have an automatic definition; children require manual definitions and
actual native Call ownership. Structural eligibility never proves an origin.

Before whole-tree causal replay, an original automatic root must pass the existing
occurrence proof for the selected cut and independently for latest evidence:
exact occurrence, payload/media/provenance, trigger snapshot, input/hash,
activated occurrence, accepted event and workflow-started native admission.
Foreign proof reads retained owner facts and refuses missing evidence without
foreign-owner SQL fallback. Runtime-tree structural recreation checks retained
root origin facts with no database handle; it still grants no dispatch authority.
Existing bounded held/admitted/re-exported/local-rewind manifests, maps, original
commands and causal generations remain required. A fresh destination root retains
the original definition but has real human/manual acceptance; descendants have
real Call acceptance. Original automatic proof supplies history only: no source
trigger advancement, scheduler/lease/response adoption or missed-trigger replay.

The unchanged serial retry replay proves each owner's consecutive consumed attempt
numbers, exact input/purpose/hash/fence, lease/authorization, actual process exit,
settlement/results, ceilings/delays/event times and absolute `available_at`.
Failure-edge precedence and absence of intermediate state writes/seals remain
mandatory. A genuine delayed prepared retry remains distinct from a waiting Call
with its actual unfinished child. Complete owner inventory, parent/attempt/input/
hash, mapped bindings, acceptance/admission, depth/ceiling and descendant counters
remain mandatory. Completed prefixes and historical terminal children seed once;
legitimate suffix children remain possible. Future attempts use `MAX(number)+1`,
with current destination time/readiness/capacity/policy controlling claims.

Selected sync/async/default or closed EXIT cuts still require committed exact
saver bytes/hash/invocation and independent latest whole-tree replay. Every
required child save remains mandatory, including sync children of automatic-root
trees. A root save cannot replace missing or pending child bytes. EXIT requires
authentic interruption or gate closure, actual process-group/pipe drain and
current authority; latest-only terminal observations cannot become selected cuts
or invented closure history. The necessary EXIT producer ancestor and owner-origin
checks and current foreign graph review use the explicit structural family while
retaining their separate current pins/configuration/authority/saver checks.

Existing review/confirm/receipt, per-owner budgets, Script/Call permissions,
capacity, current choices/directories/no-secrets, exact original-key recovery
after legitimate suffix progress and pending-gate destination notifications stay
in their existing paths. Serial canceled-source-gate semantics are unchanged.
Missing, running, unknown, undrained or effectful proof stays held.

This is source implementation and independent source review only. No tests,
builds, typechecks or runtime qualification were performed. Execution, timing,
durability, notification delivery, round trips, scheduling, rollback, atomicity
and whole-Bible/full-portability acceptance remain unvalidated. No schema,
storage-version, DTO, format or dependency changes are introduced.


## Proven automatic-root parallel and mixed Call-tree Script retries

Runtime-tree recreation now recognizes the separately opted-in automatic-root
parallel/mixed tree family. A schedule/webhook/filesystem root may be serial or
parallel; at least one retained owner uses existing fork/Map/Join controls.
Every owner must qualify as effect-free Node Script/ordinary gate/Call with
existing condition/route/loop/JSON state, workflow/gate/Call stop policies and
retry only for Script. Only parentless roots may retain automatic definitions;
descendants have manual definitions and actual native Call ancestry/admission.

The complete inventory must qualify before the new default-off parallel-tree
retry flag is supplied. Recreation rejects host/custody, execution-owned Chats,
required secrets, resource/action/bundle and issued/recovery/runtime-outcome
evidence for this opt-in. It validates original automatic root occurrence facts
through the existing retained-source origin validator with no database handle.
For each owner, validated parent ancestry determines whether that owner's tree
has an automatic root; unrelated manual histories gain no mixed retry context.
Serial owners then use the existing explicit serial-tree context and serial
retry codec; parallel owners use the established parallel frontier/replay codec.
No new scheduler, retry algorithm, manifest or dispatch authority is introduced.

Existing native parent/attempt/input/hash/Call occurrence, exact mapped bindings,
acceptance/admission, depth/ceiling/counters and complete owner inventory proofs
remain. Held/admitted/re-export/local-rewind generations retain their original
manifests/maps/commands. The continuation consumer independently proves selected
and latest whole trees, with original automatic occurrence proof before causal
replay and no foreign-owner SQL fallback. Fresh destination roots are genuinely
human/manual admitted despite retaining automatic definitions; children are
Call-admitted. Source trigger history never becomes current scheduler, lease,
response, trigger-advancement or missed-trigger-replay authority.

Both codecs retain per-attempt input/purpose/hash/fences/leases/authorization,
actual exit/settlement/results, consumed numbers/ceilings/delay/event time and
absolute deadlines; intermediate retry failures cannot seal or write state.
Parallel fork/Map inventory/order/bounds/Join/reducers/state/loop/gate/cancellation
proof is unchanged. Supported cancellation needs full causal drain proof;
admitted Call child cancellation remains refused. Serial canceled source gates
are unchanged. Delayed retries and waiting Calls remain distinct; prefixes and
terminal children restore once, legitimate suffix work can progress, and future
`MAX(number)+1` attempts obey current destination readiness/time/capacity/policy.

Committed selected sync/async/default or proven closed EXIT bytes/hash/invocation,
independent latest whole-tree proof and every required child save remain mandatory,
including sync children of automatic roots. No missing/pending child bytes or
latest-only terminal observations can be promoted by a root save. Authentic EXIT
interruption/gate closure, actual process-group/pipe drain and current authority
remain required. Necessary producer/ancestor/origin/current graph review callers
use the explicit family while separate current pins/configuration/authority/saver
checks remain unchanged. Review/confirm/receipt/original-key recovery, current
choices/directories/no-secrets/permissions/per-owner budgets/capacity and pending
gate destination ownership/notifications stay in their existing paths.

Manual parallel Call trees, all-serial trees and standalone manual/automatic
serial/parallel families retain their existing behavior. Issued/Agent/resource/
native/effectful/unknown/secret/bundle/execution-owned Chat families gain no support.
No schema/storage-version/DTO/format/dependencies changed. No tests/builds/types
or execution were run; timing/durability, notifications, round trips, scheduling,
rollback, native equivalence, atomicity and whole-Bible/full-portability acceptance
remain unvalidated. See the [parallel/mixed-tree continuation proof](branch-foreign-checkpoint-continuation.md#proven-automatic-root-parallel-and-mixed-call-tree-script-retries).


## Proven manual-root mixed Call-tree Script retries

Private runtime-tree recreation now recognizes serial Script retries within a
proven manual-root mixed tree. The owner's validated parent ancestry determines
its own root and complete related owner inventory; unrelated histories do not
supply the required mixture or gain eligibility. That inventory must contain
both serial and fork/Map owners, all with manual, effect-free Node Script/ordinary
approval-gate/Call definitions and workflow/gate/Call stop policies. It excludes
host/custody, execution-owned Chats, secrets, resource/action/bundle and
issued/recovery/runtime-outcome facts. Existing condition/route/loop/JSON state
and fork/Map/Join controls remain supported.

A separate default-off manual mixed eligibility check supplies the existing
serial-tree retry context only to serial owners. Parallel owners keep the
established manual parallel codec; automatic definition/origin flags are not
used for manual roots. Existing all-serial/manual-parallel and automatic-root
families remain unchanged. The EXIT producer's structural ancestor guard admits
these mixed manual definitions while retaining separate current pins,
configuration, permissions, invocation, saver and closure/drain checks. Current
foreign review and portable preflight already admit the per-owner definitions.

Existing native parent/attempt/input/hash/Call occurrence, mapped bindings,
manual root and Call-child acceptance/admission, depth/ceilings/counters and full
inventory remain mandatory. Held remap/insertion/readback/re-export grants no
authority. Continuation independently proves selected and latest whole trees,
exact committed saver bytes/hash/invocation and every required child save.
Authentic EXIT interruption/gate closure and process-group/pipe drain remain;
root bytes cannot bless missing/pending child saves or promote latest-only
terminal observations into selected cuts or invented history.

Serial retry proof keeps consecutive consumed attempts, input/purpose/hash/
fences/leases/authorization, actual exit/settlement/results, ceilings/delay/event
time/absolute availability, failure-edge precedence and no intermediate state or
seals. Parallel causal graph/cancellation proof is unchanged. Calls/gates never
retry, serial canceled source gates remain refused and admitted Call-child
cancellation remains refused. Delayed retries and unfinished Calls stay distinct.
Bounded held/admitted/re-export/local-rewind generations/maps/commands, prefixes
and deadlines seeded once, historical terminal children and legitimate suffix
children remain shared. Fresh human/manual root and actual Call-child destination
admission, per-owner budgets/permissions/capacity/current choices/directories/
no-secrets, original-key receipt recovery and pending-gate ownership/notifications
remain existing paths. Future `MAX(number)+1` attempts still use current
destination time/readiness/capacity/policy.

Issued/Agent/resource/native/effectful/unknown/secret/bundle/owned-Chat families
gain no eligibility; missing/running/undrained proof stays held. No schema,
storage-version, DTO, format or dependencies changed. Source only: no tests,
builds, types or execution were run; timing/durability, notifications, round trips,
scheduling, rollback, native equivalence, atomicity and whole-Bible/full-portability
acceptance remain unvalidated. See the [manual mixed-tree proof](branch-foreign-checkpoint-continuation.md#proven-manual-root-mixed-call-tree-script-retries).


## Runtime recreation eligibility follows each complete root tree

A runtime package may retain multiple original execution roots across its
Branches. Recreation now derives an owner's root and every related owner from
already validated parent links before checking any serial, manual mixed or
automatic parallel tree family. The same complete related inventory supplies
all family checks, original automatic-root occurrence proof and per-owner codec
context. Unrelated histories neither provide a required serial/parallel mixture
nor suppress an otherwise supported tree; unrelated automatic origins are not
used as proof or a prerequisite for that tree. Manual and automatic admission
and definition rules remain distinct. Only the root may retain an automatic
definition, with actual Call descendants and the existing retained-origin proof
without a database handle or foreign-owner SQL fallback.

Whole-package integrity remains global and precedes eligibility: manifest hashes,
versions/object shapes, owner and global identity inventories, all Branch/Call
dependencies, complete parents, cycle checks and bounded lineage are unchanged.
No owners or facts are removed or moved. Planning still allocates and stages
every owner with its existing `recreated_held` or `evidence_only` disposition.
Unsupported unrelated leaves can retain complete evidence without a native
frontier. An unsupported parent with children still refuses before staging when
native Call ancestry cannot be recreated; this does not make every package
importable. Insertion/readback/re-export continue validating the entire package
and original maps, commands, ancestry and held receipts. Recreation grants no
acceptance, scheduler, lease, response or current execution authority.

Existing definition/frontier/serial/parallel/tree codecs and automatic occurrence
proof remain unchanged. Per-root selected and independent latest whole-tree
replay, committed saver bytes/hash/invocation, every required child save and
authentic EXIT interruption/gate closure/process-group and pipe drain/current
authority remain mandatory. No trigger advancement or missed-trigger replay is
introduced. Original manual root/actual Call children and fresh human/manual
root/Call-child destination admission remain the existing paths. Retry attempts,
deadlines, `MAX(number)+1`, full fork/Map/Join/state/gate/cancellation proof,
bounded lineage, original-key receipts, pending-gate lifecycle, current choices,
per-owner budgets/permissions/capacity/directories/no-secrets and scheduler claim
behavior are unchanged. Unsupported issued/Agent/resource/native/effectful/
unknown/secret/bundle/execution-owned Chat families and canceled serial gates
gain no support.

No schema/storage-version/DTO/format/dependency changes. Source only: no tests,
builds, types or execution were run. Execution, timing/durability, notifications,
round trips, scheduling, rollback, native equivalence, atomicity and whole-Bible/
full-portability acceptance remain unvalidated.


## Root-scoped review and disposition-aware held generations

Foreign tree review compares historical definitions, configurations and Call
bindings against the selected root's complete validated ancestry inventory. This
includes latest legitimate suffix children, rather than only owners present in
the selected checkpoint. Unrelated historical roots on the same Branch may retain
older pins as evidence without requiring one current destination to match several
historical definitions. Review and confirmation use this shared source cut; the
review digest and original-key receipt continue binding the exact original
manifest, checkpoint, held maps and current reviewed choices.

Whole-package validation and exhaustive held readback remain global. Every mapped
Branch still undergoes the existing enabled/current definition, configuration,
Call dependency, permission, budget, directory and no-secret review. Narrowing
historical comparisons neither adopts a foreign configuration nor removes any
current destination authority check.

Repeated held export/import follows the original complete manifest and all owner,
Branch, frontier reservation and publication-pin maps. Each owner must retain its
exact import/provenance, unaccepted waiting hold, output, counters, mapped ancestry,
input/hash/configuration and original private command. Map reservations remain
complete, fresh and unique even when no native frontier was recreated. No owner,
private fact, earlier generation or original command is discarded or rewritten.

The resolver validates both existing dispositions. A `recreated_held` owner needs
its exact definition, mapped Call bindings and typed frontier remap. An unrelated
`evidence_only` leaf needs an empty native frontier and empty executable idMap;
its actual destination version/binding pins remain bound to the import receipt.
Its native definition may describe the imported current Branch, while its older
historical definition remains unchanged in the private original manifest. It does
not gain a frontier or admission. Evidence-only parents and any evidence-only
owner in the selected root's complete related tree still refuse. Global
manifest/command/hash, identity/map closure, no-admission and held-authority checks
continue for every owner, with the existing 16-link/cycle/alias bounds.

Original manual or automatic root history and actual Call ancestry remain distinct
from fresh human/manual root and Call-child destination authority. Selected and
independent latest replay, original automatic occurrence proof, exact committed
saver bytes/hash/invocation and every required child save remain mandatory.
Authentic EXIT interruption/gate closure and observed process-group/pipe drain are
still required; root saves never supply missing child proof. Retry deadlines,
fences, consumed attempt numbers, `MAX(number)+1`, fork/Map/Join/state, gates,
causal cancellation and serial canceled-gate refusals retain their existing rules.
Bounded lineage, original-key recovery, pending destination notifications and
current permissions/capacity/budgets/directories/no-secrets are unchanged. No source
trigger, scheduler, lease or response authority is adopted, and no issued, Agent,
resource, native, effectful, unknown, secret, bundle or execution-Chat family gains
support. Held recreation remains nondispatchable.

Source only: no tests, preparation, builds, typechecks, Node/parser/native/runtime,
browser/provider/live database actions or executed reproductions were performed.
Execution, timing/durability, notification delivery, round trips, scheduling,
rollback, native equivalence, atomicity and whole-Bible/full-portability acceptance
remain unvalidated. No schema, storage-version, DTO, format or dependency changes.


## Proven same-owner manual standalone Join bundles

Foreign continuation now accepts authentic same-owner Join result bundles in
manual standalone effect-free parallel Node Script/ordinary approval-gate graphs.
Existing fork/Map/Join, conditions/routes/loops, JSON state and canonical Script
retries remain available under their existing replay rules. Proven automatic
standalone origins use the additional contract below. Call trees,
issued/Agent/resource/native/effectful and cross-owner bundles remain excluded.
Secret, custody, execution-Chat and unknown/in-flight effects retain their existing
exclusions. Definition literals and gate choices that name
bundle references are refused in this family; authored literals are not remapped.

The shared eligibility check requires exact owned bundle rows, unique typed IDs,
one closed producing fork per bundle, exact UTF-8 content/hash, the existing
8,000,000-byte cap and the native beyond-inline condition. Every typed bundle
reference must use the canonical grammar and resolve within this owner. Root
input cannot claim a Join-produced bundle. Missing, dangling, altered, injected,
cross-owner or otherwise unproven bytes refuse; no source SQL fallback supplies
them. Structural ownership never proves execution: selected and independent latest
causal replay reconstruct ordered Join output, labels and partial-result text,
introduce the bundle only at the genuine Join resolution and compare every byte.
Script leases still prove the input bundle ID/hash, input hash, fence, source,
authorization, observed process exit, settlement and immutable result. Retry
numbers, delay/absolute deadlines, failure-edge precedence and state-seal order
remain unchanged.

Standalone held recreation uses the same owned-bundle check and canonical latest
source replay before recreating bundle-bearing native rows. The existing selector,
private manifest, identity map, typed remapper/inserter and readback preserve all
original facts and exact bundle bytes; import remains held without admission.
Held re-export follows the original proof, while admitted/re-exported/local-rewind
lineage replays the original selected/latest cuts and seeds the proven prefix once.
Existing root-scoped review and two-disposition tree-generation behavior is unchanged.

Typed remapping rewrites exact owned references in paths, Step inputs and result
outputs, fork/Join results, Map item inputs and gate proposals/explicit response
outputs. It updates dependent input/result/item inventory hashes and keeps original
bundle content/hash unchanged. Embedded strings, Script source, prompts, choices,
JSON state and arbitrary authored text are not globally substituted. Receipt GET
checks every copied bundle's owner, producer fork, exact content/hash and immutable
prefix references after legitimate suffix progress. Later suffix bundles may be
created normally; receipt recovery never creates replacement acceptance commands.

Current human review/confirmation still binds the exact original checkpoint,
manifest/maps, current matching definition/configuration, directories, policy,
budget and capacity. Fresh manual acceptance/admission creates current authority;
source facts grant none. Only unfinished suffix work runs, resolving copied owned
bundle references through the existing Script claim path. Gates receive fresh
pending identities/notifications and normal destination responses. Calls and gates
gain no retry policy. Causal cancellation and serial canceled-gate boundaries stay
unchanged.

Exact committed sync/async/default selected saver bytes/hash/invocation and
independent latest proof remain required. EXIT still needs authentic saved closure
or interruption and observed process-group/pipe drain; pending writes and latest-only
terminal observations cannot become selected executable cuts. Source implementation
only: no tests, fixtures/preparation, builds, typechecks, Node/parser/native/runtime,
browser/provider/live database execution or executed reproduction. Timing/durability,
notifications, round trips, scheduling, rollback, native equivalence, atomicity and
whole-Bible/full-portability acceptance remain unvalidated. No schema, storage-version,
DTO, format or dependency changes.


## Proven automatic standalone Join bundle origins

The same owned Join bundle consumer also supports original schedule, webhook and
filesystem standalone effect-free parallel Node Script/ordinary approval-gate
workflows when the existing automatic-origin and full causal replay qualify.
The manual family above remains supported. The shared bundle helper only checks
structural eligibility: an automatic definition and admission are not origin proof.
Every executable foreign cut still passes canonical selected and independent latest
replay, and the held planner requires original latest replay before native bundle
recreation. Missing, forged or changed occurrence evidence stays held.

Automatic origin proof requires the retained activated occurrence, exact canonical
payload/provenance/trigger snapshot, original input bytes and hash, and unique
trigger_accepted/workflow_started evidence. The retained occurrence must remain
historical data without current authority. Private facts supply proof without a
source SQL fallback. Existing bundle production, size/hash/ownership/topology,
Script lease/process/settlement, retry/state and selected saver/closed EXIT rules
are unchanged; structural bundle checks never replace authentic Join replay.

Fresh destination acceptance remains manual even when its matching definition
contains an automatic trigger. Current human confirmation, policy, permissions,
matching configuration, budget, readiness and capacity are checked again. No source
schedule grant, timer, occurrence regeneration, trigger replay or redispatch is
inherited. Only the proven unfinished suffix can run. The existing held resolver
unwraps original facts; admitted/re-exported/local-rewind lineage verifies original
selected and latest cuts, the fresh manual acceptance and exact mapped prefix.
Bundle eligibility permits those manual generations of automatic definitions so
retained proof remains usable without relabeling a destination as automatic.

Existing typed remapping, native insertion/readback, immutable prefix receipt and
current Script bundle resolution are reused. Original facts and bundle content/hash
stay immutable; only owned references and dependent hashes change. Calls and Call
ancestry/descendants, issued/Agent/resource/native/effectful/cross-owner bundles,
secrets, execution-Chat/custody dependencies and unknown/in-flight attempts remain
excluded. Authored literals/choices and arbitrary text or JSON state gain no global
substitution. Latest-only terminal observations remain evidence, not executable cuts.

Source implementation only. No tests or preparation, builds, types, Node/parser,
native/runtime/browser/provider/live database execution or executed reproduction.
Execution, timing/durability, notifications, round trips, scheduling, rollback,
native equivalence, atomicity and whole-Bible/full-portability acceptance remain
unvalidated. No new trigger engine, codec, schema, storage-version, DTO, format,
size limit or dependency.


## One-owner standalone Join bundles through runtime-tree packages

The runtime-tree package route now consumes the same supported manual or proven
schedule/webhook/filesystem standalone effect-free parallel Node Script/ordinary
approval-gate family with authentic same-owner Join bundles. This narrow extension
supersedes earlier blanket tree-route bundle refusals only for a related root family
containing exactly one owner. No Call ancestor/descendant, branch_call definition,
Branch target binding, Agent binding, child adoption or cross-owner reference is
allowed. Eligibility remains root-local; another unrelated root gains no authority.
Actual Call/multiowner trees and issued/Agent/resource/native/effectful/cross-owner
bundles retain their exclusions, as do secrets, custody, execution-Chat dependencies
and unknown/in-flight attempts. Existing state/controls/loops/Script retries retain
their exact causal rules; Calls and gates gain no retry policy.

The native saver normally prefers the existing standalone Script checkpoint for
this source graph. The tree consumer verifies those exact committed private bytes
with the standalone snapshot and selected-cut validator before exposing a transient
one-owner view to the existing tree review/admission/receipt flow. It does not save
a replacement tree checkpoint or synthesize invocation metadata. Original selected
and independent latest cuts still require their own authentic replay. Held native
recreation of bundle-bearing owners requires canonical latest proof before frontier
insertion; the installation planner supplies its database handle to shared replay,
whose foreign source reads remain private facts with no source-SQL fallback. Without
that proof context the bundle frontier stays evidence-only. Publication rechecks
proof before inserting. Held re-export unwraps original facts through the existing
root-scoped generation resolver; unsupported unrelated histories stay evidence-only.

After fresh manual tree-route admission, the existing tree saver/lineage validator
can encode the same one-owner family and its subsequent suffix. The shared bundle
validator is structural only: complete owned rows, unique typed identities, exact
UTF-8 content/hash, the native 8,000,000-byte cap and beyond-inline condition, one
legitimate closed producing fork and canonical owned references are mandatory.
Full causal replay separately reconstructs ordered Join labels/partial bytes and
proves Script inputBundleId/hash, lease/fence/source/authorization/observed process
exit/settlement, retry timing/failure precedence and state seals. Missing, altered,
injected, extra, cross-owner or otherwise unproven rows and bytes refuse.

Terminal execution output is remapped only when its entire value is a canonical
owned bundle reference. Held insertion/readback, held-generation checks, fresh
admission, retained generation and receipt comparisons use that same typed rule.
Ordinary output text is preserved byte-for-byte, as are immutable bundle contents,
authored literals/choices, embedded strings and JSON state. Existing typed frontier
remapping changes only owned links and dependent hashes. Receipts verify exact
immutable prefix bundle owner/fork/content/hash while allowing genuine suffix
bundles. Current Script claim resolves the copied native owned bytes normally.

Current matching definition/configuration/directories, human confirmation, policy,
permissions, budget/readiness/capacity and fresh manual root acceptance remain
required. Automatic activated-occurrence/payload/input/hash/snapshot/accepted/started
proof stays historical currentAuthority:false data; no timer, scheduler grant,
occurrence regeneration, trigger replay or source redispatch is inherited. Existing
held/admitted/re-exported/local-rewind lineage remains bounded and replays original
selected/latest proof plus fresh acceptance and mapped prefix. Exact sync/async/
default saver bytes/hash/invocation and authentic closed EXIT/process-group/pipe
drain evidence remain required. Terminal/latest-only observations are evidence and
never become executable selected cuts; missing closure evidence is not fabricated.

Source implementation only. No tests or preparation, builds, typechecks, Node/parser,
native/runtime/browser/provider/live database execution or executed reproduction.
Execution, timing/durability, notifications, round trips, scheduling, rollback,
native equivalence, atomicity and whole-Bible/full-portability acceptance remain
unvalidated. No new execution engine, codec, module, schema/storage-version, DTO,
format, size cap or dependency.


### Manual and original automatic Call roots with owned Join bundles

Runtime-tree packages can recreate and continue the effect-free Call-tree family
when only the related root owns authentic Join result bundles. The root has no
Call parent or ancestor. The existing all-manual family remains supported; a
separately scoped family also accepts an original automatic root using a schedule,
webhook or filesystem definition. Every descendant still has a manual definition
and ordinary Call admission. Both families use the existing Node Script, Branch
Call, ordinary approval gate and graph-control codecs. Existing declared JSON
state, conditions, routes, loops and qualified Script retries keep their normal
replay rules. Automatic roots use the existing parallel/mixed-tree Script-retry
qualification, including serial descendants; Calls and gates gain no retries.

An original automatic root must independently prove its immutable activated
occurrence, trigger snapshot, canonical payload/provenance/input/hash and exact
accepted/started/admission evidence. Missing or unavailable-held occurrence data
refuses continuation. This proof is historical data with currentAuthority:false,
never scheduler or trigger authority. After confirmation, the same automatic
root definition runs under fresh manual destination admission; descendants retain
Call admission. Current-generation family validation accepts this distinction
while original selected/latest replay independently verifies occurrence evidence.
No missed occurrence, timer, trigger, source dispatch or lease is recreated.

A shared root-family validator checks the actual selected owner cuts, definitions
and bindings. It checks complete parent reachability and Call binding/input/hash
links, refuses Agent bindings and effects, and reuses the standalone validator's
owned-bundle checks without widening its public default. Existing canonical tree
replay independently checks complete child coverage, owner pins, acceptance,
Call results, state seals and every causal Script/Join transition.

In this root-only family, only the root can produce or consume a bundle. Every descendant must have no
bundle rows or typed bundle references. Every actual or prepared Call input and
result must be ordinary inline text; exact child input/output and parent-attempt
hashes remain mandatory. Returned references, forwarded bundles, child-owned
bundles, child adoption and cross-owner bundle remapping remain unsupported.
Unrelated execution roots cannot supply eligibility or missing proof.

Owned bundles retain unique typed identities, complete rows, exact UTF-8 content
and hash, the existing 8 MB limit and beyond-inline requirement, and one legitimate
closed producer Fork. Canonical replay reconstructs deterministic Join ordering,
labels and partial-result bytes. Script input bundle ID/hash, lease/fence,
authorization, process exit and drain, settlement, retry timing/failure precedence
and shared-state proof remain required. Extra, altered, unavailable or unrelated
bundles and forged references refuse continuation.

Held recreation resolves the original related root through retained generations
and requires canonical original latest tree proof before inserting any native
frontier for a bundle-bearing family. Publication rechecks the same proof. Missing
proof context cannot grant recreation. Existing frontier insertion/readback and
typed output remapping preserve exact bundle bytes and hashes; authored text,
choices, definition literals and JSON state are not rewritten.

An older committed tree cut before bundle production can be selected while latest
independently proves later root bundles. Selected and latest retain their own
complete historical owner sets; genuine later children need their ordinary Call
proof, not an equal-owner-count shortcut. A bundle-bearing selected cut needs its
own exact committed tree snapshot, hash, invocation metadata and required child
saver coverage. Actual Call trees do not use the one-owner standalone Script-to-tree
adapter. No snapshot or invocation is backfilled. EXIT owners still need their own
exact closed saver evidence and the existing complete-tree latest proof. A
terminal latest-only observation is evidence, never an executable selected cut;
the selected root remains nonterminal.

Held, admitted, re-exported and local-rewind generations use existing retained
manifest/command/receipt and saved-tree lineage. Current generations independently
prove root-only bundle ownership and inline Call boundaries; immutable copied
prefix bundles keep their owner/Fork/content/hash while genuine suffix bundles
must arise through canonical production. Original-key recovery retains exact
source selection, maps, prefix and admission checks.

Continuation requires fresh human confirmation, a fresh manual destination root
and ordinary Call child admission, current matching configuration and bindings,
Script/Branch Call permissions, directories, budget, capacity and readiness.
Historical source acceptance confers no destination authority. The public
standalone bundle validator and all-manual family boundary keep their defaults;
shared tree consumers independently derive the additional automatic-root family
from actual owner cuts, definitions and bindings. A tree or Call flag alone grants
no bundle support. Scheduler/trigger replay, native/effectful, issued/Agent/resource,
secret/custody/execution-Chat and unknown/in-flight families remain excluded.

This is source implementation, not executed qualification. Saver timing,
durability, scheduling, notifications, round trips, rollback, native equivalence,
atomicity and whole-Bible/full-portability acceptance remain unvalidated.


### Manual Call leaves with local Join bundles

A separate all-manual actual Call-tree family permits authentic Join bundles
inside nonroot parallel leaf owners. The root and every nonleaf remain free of
bundle rows and typed references. Each bundle-bearing leaf has a manual definition
with no Branch Call step anywhere, no Branch or Agent bindings, and no actual
descendants in the complete related owner inventory. Multiple qualified leaves
may own independent bundles. The existing manual/automatic root-only families and
public standalone defaults are unchanged; root-plus-leaf bundles, automatic child
bundles and nonleaf child bundles remain excluded.

A leaf consumes only its own authentic Join bundle and returns ordinary inline
output. Every actual or prepared Call input, result and attempt result, child
execution input and terminal output remains inline. Returned, forwarded, adopted
and cross-owner references are unsupported. The shared complete-family proof
checks definitions, bindings, parent reachability and exact Call input/hash links;
canonical replay separately verifies complete child coverage, depth, admission,
owner pins, results and state. Foreign replay identifies the actual root and
independently matches the current owner's selected bytes, definition, bindings
and parent context before deriving this family. A tree/Call flag grants nothing.

Owned row identities, typed references, exact UTF-8 bytes/hash, 8 MB and beyond-inline
bounds, unique closed producers and authored-literal exclusions remain enforced.
Existing per-owner causal replay reconstructs deterministic Join labels/order and
bytes, then requires exact Script input bundle ID/hash, leases/fences, observed
process exit/drain, settlement, Script retries and state seals. Ordinary approval
gates retain their exact codec; Calls and gates gain no retry authority.

Original selected and independent latest each derive their own complete family.
An older selected cut can precede later children or local bundle production, but
needs its own genuine committed TREE bytes/hash/invocation and required child
saver coverage. Later owners or latest-only terminal observations cannot supply
an executable selected cut. Missing child saves, exact closed EXIT evidence or
observed exit/drain remain held; no adapter, backfill or source-SQL fallback is
introduced. Every related planner owner resolves the original root through retained
lineage and requires canonical original latest replay before bundle-bearing held
recreation; publication repeats this check.

Existing typed per-owner remapping, immutable receipt prefix checks, original-key
recovery and bounded held/admitted/re-export/local-rewind lineage are reused.
Current generations independently prove the same family, genuine suffix child
admission and local bundle production. Prefix verification alone is not full
suffix replay. Fresh human confirmation, manual destination root and ordinary
Call child acceptance, current definitions/configuration/bindings, Script/Call
policy, directories, permissions, readiness, budget and capacity remain required.
Historical acceptance grants no current authority; automatic occurrence proof and
root-only automatic support are unchanged. Effect/resource/Agent/secret/host/
custody/execution-Chat and unknown/in-flight families remain excluded.

Source implementation only: no tests, preparation, builds, typechecks or runtime
execution. Timing, durability, scheduling, notifications, round trips, rollback,
native equivalence, atomicity and whole-Bible/full-portability acceptance remain
unqualified. No module, codec, schema, DTO, format, cap or dependency was added.


### Original automatic root with manual Call leaf bundles

A separate complete family extends the manual leaf-local bundle proof to an
original schedule, webhook or filesystem root. The root and every nonleaf remain
bundle/reference-free; only independently qualified manual-definition parallel
Call leaves may own local Join bundles. Each such leaf has no Branch Call anywhere
in its definition, no Branch/Agent bindings and no actual descendants. Multiple
qualified leaves are supported. All actual/prepared Call inputs, results and
attempt results, child inputs and terminal outputs remain inline. Root-plus-leaf,
automatic-child, nonleaf-child, returned, forwarded, adopted and cross-owner
bundles remain unsupported. Public all-manual, root-only and standalone defaults
retain their boundaries; a tree/Call flag does not grant this family.

Canonical replay still requires the original parentless automatic root's exact
activated occurrence, payload/media type, provenance, pins, trigger snapshot,
input/hash and accepted/started admission evidence. Retained occurrence data is
historical evidence with no current authority. Missing or unavailable-held bytes
remain held; no source-SQL fallback, fabricated occurrence or trigger redispatch
is introduced. The destination keeps the same definition but needs fresh human
confirmation and manual root acceptance, ordinary Call child admission and current
Script/Call policy, directories, readiness, budget and capacity.

Original selected, independent latest and current retained generations each derive
the complete family from their own cuts. Selected requires genuine committed TREE
bytes/hash/invocation/membership and each required child's own save, including sync
children under the automatic-tree rule. Earlier selected cuts may precede later
children/bundles; latest cannot lend proof or supply an executable cut. Exact
closed EXIT saver evidence and observed process exit/drain remain mandatory.
Every related planner owner resolves original ROOT lineage and requires canonical
original latest replay before held recreation; publication rechecks that proof.
Foreign leaf replay independently matches current selected bytes, definition,
bindings and exact parent execution/attempt/input context.

Existing same-owner typed remapping, immutable bytes/hash, UTF-8/8 MB/beyond-inline
bounds, unique closed Join producer, authored-literal exclusions, deterministic
Join labels/order/partial output and Script inputBundle ID/hash remain required.
Leases/fences, authorization, process exit and group/pipe drain, settlement,
failure edges, retry delay/availability and state seals are unchanged. Calls and
gates gain no retries. Original-key receipts, prefix validation and full retained
suffix replay remain separate through held/admitted/re-export/local-rewind paths.
No Agent/resource/effect/secret/host/custody/execution-Chat or unknown/in-flight
family is added, and native resolver ancestry does not widen portable authority.

Source implementation only; tests, preparation, builds, typechecks and runtime
execution were not performed. Timing, durability, scheduling, notifications,
round trips, rollback, native equivalence, atomicity and whole-Bible/full-portability
acceptance remain unqualified. No module, schema, codec, DTO, storage version,
format, cap or dependency was added.


### Combined manual root and leaf local Join bundles

A complete all-manual Call tree may contain authentic local Join bundles at its
parallel root and at independently qualified parallel Call leaves simultaneously.
The root follows the existing root-only producer and consumer contract. Each
bundle-bearing leaf has no Call anywhere in its definition, no Branch/Agent
bindings and no actual descendants. All other descendants stay bundle/reference
free. Root and leaves consume only their own bundles. All actual/prepared Call
inputs, results and attempt results, child execution inputs and leaf terminal
outputs remain inline. Forwarding, adoption and cross-owner references are outside
this family. Existing public root-only, leaf-only, automatic and standalone family
helpers retain their narrow contracts.

This uses one complete-family proof, independently derived for selected, latest,
current foreign generations, current root/leaf replay and every related planner
owner. It does not combine unrelated per-owner permissions. Exact parent links,
Call bindings/input/hash, historical child membership, depth, original pins,
accepted/started evidence, owned row identities, unique closed Join producer,
UTF-8/hash/8 MB/beyond-inline bounds and authored-literal exclusions remain
required. Causal replay reconstructs Join labels/order/partial bytes and exact
local Script inputBundle ID/hash. Script leases/fences, process authorization,
observed group/pipe drain, settlement, retries and state seals remain unchanged;
Calls and gates gain no retries.

Selected still needs its own genuine committed root TREE snapshot/hash/invocation
and each child save required by its checkpoint mode. Earlier selected cuts can
precede later children or bundles and use their own supported family; latest
cannot lend proof. Exact closed EXIT saver evidence and observed exit/drain remain
mandatory. Bundle-bearing held planning resolves the original root and requires
canonical original latest replay for every related owner; publication repeats it.
Typed remapping, original-key receipts, immutable prefixes and full suffix replay
remain separate through held/admitted/re-export/local-rewind generations. Fresh
human confirmation, manual destination root and ordinary Call child acceptance,
current pins, policy, directories, readiness, budget and capacity are required.

This completes one item in the finite remaining runtime checklist in
[Runtime continuation requirements](runtime-continuation-requirements.md).
The complete Call value-tree extension below adds automatic-definition children,
nonleaf owners and causal transported values. Issued/resource/effectful and
execution-Chat continuation remain tracked separately. Missing saved bytes or
unknown external outcomes remain explicit evidence limitations. This source change
has no executed tests/builds/typechecks/runtime qualification; timing, durability,
scheduling, round trips, rollback, native equivalence, atomicity and full Bible
acceptance remain unqualified.


### Same-owner local bundles throughout a Call tree

The complete owner-local family also permits a manual-definition parallel
nonleaf Call owner to produce and consume its own authentic Join bundle while
making unrelated inline Calls. The root may be manual or an original supported
automatic root with the existing exact occurrence proof. Root and descendant
owners may independently own bundles in the same cut; a serial root need not
have parallel controls when only its descendants produce bundles. Every actual
or prepared Call input/result/attempt result and every child execution input and
terminal output remains inline. Nonparallel owners remain bundle/reference-free.

This reuses native Join production, local Script claims and the same owned-row
and causal replay contracts. Bundle eligibility is derived from the complete
related tree, independently at every selected/latest/current-generation and
planner/replay consumer. It does not transfer bundle or automatic occurrence
authority between owners. This named local-only helper remains narrower than
the complete Call value-tree extension below, which adds automatic-definition
children and exact transported-value replay. Existing narrow public families retain their defaults.
All durable saver, original-root lineage, current acceptance and process/effect
closure requirements above remain mandatory. No execution qualification is claimed.


### Complete Call value trees and automatic Call definitions

The complete Call family additionally supports schedule, webhook and filesystem
**definitions** as ordinary Call children, including parallel nonleaf local bundle
owners. A Call child's authority is its exact parent execution, attempt, binding,
original Step input hash and ordinary Call acceptance. It has no activated trigger
occurrence and gains no scheduling or redispatch authority. Only an originally
automatically admitted parentless root needs the separate retained activated
occurrence/payload/provenance/pins/hash/accepted-and-started proof. Fresh destination
roots remain manually accepted under the same definition. Standalone and the
named root-only/all-manual/leaf-only helpers retain their narrower defaults.

A separate complete value-tree codec permits whole typed bundle references along
native ancestor/descendant relationships. Sibling reads remain unavailable.
Every bundle retains immutable UTF-8 bytes, hash and the native 8 MB/beyond-inline
contract. A producer is an authentic closed Join whose exact deterministic bytes
are replayed, or an exact native `result_bundle_forwarded` adoption. Adoption must
name the actual Call attempt/child, descendant source owner/bundle, fresh parent
bundle and hash; source content and original producer Fork must agree and precede
forwarding. The child input is then the parent-owned reference, while its input
hash still binds the parent's original Step input. Direct ancestor references use
the existing native resolver and Script lease inputBundle ID/hash evidence; they
do not grant arbitrary ancestry authority.

Serial owners may retain adopted rows without inventing local Forks. Parallel
replay creates a bundle only at its genuine Join or forwarding transition; serial
replay likewise accounts for every adopted row. Cross-owner Script claims require
the exact earlier producer/adoption evidence in this same selected tree. Inherited
rows require independently validated original-root lineage and exact seeded replay;
a prefix marker by itself is never sufficient. Selected and latest derive their
own families and causal inventories. Selected child-own saves are required across
automatic-definition trees, including sync children; EXIT closure/drain and missing
historical evidence rules remain unchanged.

Typed remapping covers execution input/output, native frontier text/output fields,
owned identities and the original global producer Fork. It does not alter bundle
content, arbitrary authored text, graph literals or state. Fresh tree execution IDs
are reserved before accepting any owner so references to later descendants cannot
point at discarded provisional IDs. Foreign confirm/receipts/current seeds, held
publication/readback/re-export and local rewind use the same complete typed map.
Bundle-bearing held planning and publication resolve the original root and require
canonical original latest replay for every related owner.

The new shared source module is `branch-bundle-values.ts`; no DTO, stored schema,
format, cap or dependency changes are needed. Agent/request/resource/execution-Chat
continuation remains held where current destination associations or custody/context
installation proof is absent. Existing local resource restoration reads verified
local custody bytes and performs a fresh policy review; imported historical receipt
facts alone do not install current custody. Unknown effects never gain a guessed
settlement. The finite checklist records the remaining carrier dependency.

This is source implementation pending independent review and combined-product
qualification. Tests, fixtures, builds, typechecks and runtime execution were not
performed. Durability, timing, scheduling, round trips, rollback, native equivalence,
atomicity and whole-Bible acceptance remain unqualified.


Inherited transported Call inputs use exact per-child seed membership. The lineage
composer first proves the original committed selected tree and independently its
latest tree, complete globally unique typed identity map, immutable command and
installation lineage, and exact current child/parent/attempt/input. Only then does
it attach the original child and parent seeds to the in-memory owner proof. The
shared input helper checks both seeds against the same full map and original
owner inventory, maps the original parent Step and child input independently, and
checks the current parent-attempt input hash. A prefix marker or current child
input alone never supplies proof. A new suffix child absent from the original
selected tree has no seed and needs its own ordinary admission-time producer or
native forwarding event.

Selected and latest bundle eligibility are each derived inside their independent
canonical composer invocation, after seed validation; preliminary package checks
cannot lend latest eligibility to selected. Current foreign seeds, complete
family eligibility and Script replay use the same exact child seeds. Replay also
checks that its current owner/seed equals the owner used by the family. Native
checkpoint interruption/resume uses its existing exact-input check first. The
live-tree fallback requires a fresh complete canonical current-tree replay and
reads its in-memory proof, held in a WeakMap rather than serialized authority.
Explicit resume of a queued restored EXIT child uses a separate held proof:
its exact interrupted invocation, hold history and current saver bytes must match;
the original committed selected tree and independent latest must replay; and the
existing rewind command must read back the complete typed owner map, immutable
lineage and mapped original frontier identities under current pins and policy.
Only then do the exact original parent/child seeds check the current parent Step,
attempt, input and hash. A suffix child has no inherited seed. Queued owners are
not accepted by runnable-tree replay, and checkpoint dispatch gains no input guard
from this change. Local rewind independently replays the source latest tree under
the existing 16-generation/128-work bounds.

Transport ancestry checks exact original committed snapshot membership and full
typed mapping as structural data. That structural check grants no runnable
eligibility: every bundle-bearing related owner in the held planner still needs
canonical original-root replay, including independent selected/latest, owner-own
saver observations, closed EXIT invocation and observed drain where required;
publication rechecks it. Existing export, insertion/readback/re-export, current
review/confirm/admission and original-key receipt paths retain immutable bytes and
fresh current policy/capacity/budget/Call acceptance. Original forwarding events
are never copied into a destination journal or invented for later children.

These R5 source changes await exact independent review. Original Join content,
deterministic ordering/partial results, UTF-8/size/hash/unique producer proof,
ancestry-only resolution and Script claim bundle ID/hash remain mandatory.
Unrelated effects, unknown/in-flight state, secrets and issued-resource/Chat
families remain held. No tests or execution checks were run; this is not a full
Runtime or Bible acceptance claim.


Custody carrier successor: newly exported retained custody facts include exact
original UTF-8 package `wireJson`, validated against the original receipt SHA256
and byte length and the separately parsed package hash. Existing bounded runtime
fact validation checks this evidence on import and retained re-export. Missing
wire evidence is not reconstructed from a semantic hash. This is retention only;
inert destination staging, current custody admission and current resource/Chat/
issued-Request associations remain unfinished. No execution authority follows.

## Retained-source storage work in progress

The reserved `0042_destination_retained_sources.sql` draft is a current-format
bootstrap change, not existing-state conversion. It adds separately named retained
source and complete owner associations with genuine local execution, installation
plan and manifest-command foreign keys. Native admissions retain their native
checkpoint foreign key; retained admissions instead require a separate association
through a native/retained XOR constraint. No synthetic saver row or terminal
execution is permitted. Group owner references remain genuine local references.

Before reconstructing any destination table, the draft refuses if admissions,
participant maps, group slots or retirement tombstones contain rows. It preserves
all existing child constraints and immutable triggers. Published predecessor DDL
and the exact online predecessor admission allowlist are unchanged. Populated
0041 stores are not admitted by this new current schema. Existing-state conversion
is unfinished and needs a separately scoped lossless offline converter;
`offline-content-restore.ts` deliberately creates empty runtime state and is not
that converter. This source work does not establish deployability or upgrade
completion; no database has been opened or migrated.

The schema draft alone enables no foreign resource continuation. Complete host
verification of installation/manifest command bytes, every original and local
owner, independent selected/latest proof, resource custody, generation chains,
current review/admission and full tombstone readback is still required. Current
approval, leases, participants and resolved outcomes cannot be supplied by retained
proof. Association cleanup must retain full archived proof before releasing any
unreferenced row and refuse all unproven installation/Branch/capture/restore pins.
The downstream source consumers and independent review remain unfinished.

The current draft additionally refuses direct installation-plan compaction while
an association pins that plan. Automatic plan expiration/compaction and receipt
pruning skip those pinned plans before mutation. Existing retention limits and
other plans retain their ordinary behavior. Manifest anchors and per-owner
`portable-runtime-data` commands have narrow update/delete guards while live
association rows reference them; host authority still must verify their exact
bytes on every use. These pins are released only by proven canonical retirement,
not by elapsed retention time.

The draft shared installation-evidence reader now checks the actual installation
plan, unique existing manifest command and its input hash/result bytes, the
complete runtime receipt/owner map, every held local owner and its immutable
per-owner command, and exact original committed checkpoint bytes. Association
identity hashes include the complete owner set. Tree anchors follow the actual
stored manifest command, not an assumed selected root or map insertion order.
Direct compaction uses this reader before refusing a live pin. It establishes
installation provenance only: it does not prove canonical selected/latest replay,
resource custody or fresh admission, and creates no association rows.

Discovery and destination lifecycle ownership now includes retained/native source
selection, exact mapped local group slots, complete reference inventories and
archived tombstone readback. Their implementation remains pending the complete
source-proof/admission verifier; native source SQL must never resolve an original
foreign identity.
Historical source IDs must continue to report `retained_only`, including when a
genuine local installation owner exists. No original approval becomes current
policy, ownership, participant, lease, exit or outcome authority.


## Retained single-resource replay draft

The issued-envelope validator and canonical Script replay now use shared cores
with an explicit native or retained issued-resource evidence source. The native
wrappers retain their original SQL semantics. The retained arm reads original
owner, definition, binding and full audit bytes from validated runtime facts; its
resource recipient and Chat come from the existing complete host/resource codec.
It never looks up original owner, binding, Branch, Chat or Request IDs in the
current store. Ordinary bound Agent targets remain outside this retained arm
because the runtime inventory has no original Branch-Chat scope fact for them.

This first retained arm is limited to a standalone manual generation-zero
issued-resource owner with sync/async checkpoints. It refuses group/Call-tree,
automatic, retry/generation-chain, EXIT and restored-lineage families. It replays
the exact committed selected issued checkpoint with that checkpoint's host/audit
boundary. Independently, it requires another retained committed issued envelope
matching the original latest frontier, original latest host graph and complete
original audit, and replays those bytes separately. Missing latest envelopes stay
held; a selected envelope or result cannot supply latest proof. Each boundary
also requires matching original custody receipt/wire/package membership bytes.
The native and ordinary effect-free portable validators keep their boundaries.

The internal association writer is drafted with a nested transaction for the
complete immutable source and owner set, full canonical identity hashing and
byte-for-byte same-key readback. It is not connected to current reservation or
admission yet. The single-resource service now selects imported evidence through
the retained reader, then refuses before any new managed identity, import or
current-custody lookup. A source receipt is not passed into the current native
custody namespace. Native source preparation retains its existing path.

Final source/provider closure remains a separate missing proof. Ordinary resource
cleanup records resource retirement and deletion cleanup flags; those facts do
not provide the complete original provider registration/Run/observed-exit bytes.
The existing sealed generation-exit envelope covers retry-draining generations.
The bounded final-exit mechanism adds a separate `final-resource` fence entry
and a `resource-final-exit:<step>:0` owner-local command. The native retry entry
retains its retry-only eligibility and sealed checkpoint/package deletion path;
missing fence purpose means the original retry contract. Unknown or conflicting
purposes refuse. Both entries keep the same permanent intake denial.

For a native standalone manual generation-zero resource with an actual committed
issued-resource checkpoint, cleanup now fences the exact original owner, current
pins, completed local creation and complete Chat membership before invoking the
existing observed provider-start/runtime/process drain. It revalidates current
resource eligibility and idle state after the await, independently replays the
actual committed selected issued checkpoint and encodes the actual capture-time
frontier's canonical issued continuation. It then commits complete host/effect,
context/member/operation, pin/configuration, start/fence/never-started and terminal
Run/registration/observed-exit bytes before Agent or Chat deletion. Native Script
exit observations use the existing closure capture. Same-key readback requires
identical command bytes/hash. Existing pending-capture/custody, resourceCanRetire,
idle, ownership and general deletion checks remain, with final frontier checks
after deletion awaits and inside resource retirement. An existing complete final
command is read back rather than recaptured after partial cleanup. Once an exact
final-purpose fence exists, cleanup failures are stored separately in the existing
`branch_retirement_errors` table under the original Chat identity and surfaced by
`resourceErrors()`. They do not update `branch_resources.error`, advance the selected
frontier, overwrite the fence/command or clear an unknown operation. The original
full resource/fence and selected-frontier comparisons remain exact. A recoverable
drain failure can reach the observed drain again only with unchanged semantic
identity; a postcommit cleanup failure reads the original command without
recapture. Genuine owner/member/pin/effect/frontier changes still hold. Successful
resource retirement clears the separate cleanup diagnostic. Retry and ordinary
unfenced error handling retain their existing semantic writes. A retired issued
resource missing authentic precleanup bytes remains held.

`provider-exit-evidence.ts` and `provider-start-journal.ts` share structural
inventory checks with native capture/readback. Native wrappers retain every live
commit, complete registration, start settlement/unknown/drain and never-started
query/rejection. These checks do not establish pure retained completeness: the
current command/owner/checkpoint/audit carriers do not independently commit the
complete original start/provider/effect census or authoritative absence of
omitted unknown starts, activations or imports. Duplicating nested rows under
recomputable fact/owner/runtime hashes cannot provide that boundary.

The pure retained-final-proof entry therefore unconditionally refuses with an
explicit unsupported-completeness error. Shared runtime validation still visits
every final-command fact, so native runtime export, import, tree validation and
re-export containing such a command are held rather than silently dropping it.
Native owner-local final-command readback/deletion does not call that portable
entry and retains its live authority checks. No destination SQL uses original
IDs, no boolean bypass or new public DTO/fact-kind/cap/schema is added. Pure
authenticated final verification remains incomplete. A subsequent contract must
supply independently authenticated, original-owner/generation/fence-bound complete
inventories and absence boundaries for creation/members/operations, start
coverage/admissions/settlements/unknowns, Runs/registrations/observed exits and
Requests/Joins/activations/imports, tied to exact selected and independently latest
frontiers/pins. No such new commitment contract is implemented in this correction.

This is source implementation awaiting independent review, not execution
qualification. Missing creation-time start coverage, unsettled/unknown starts,
missing observed exits, incomplete original membership/effect/native closure,
missing genuine selected checkpoint or mismatched pins/frontiers remain held.
Group, automatic, Call-tree, retry-chain, EXIT and restored-lineage final commands
remain outside this increment. Retained final-command evidence is currently
refused and cannot make the post-cleanup source frontier executable; the existing
retained source's independent latest-envelope requirement remains. No
historical backfill, recapture, deletion-flag inference or current authority is
granted. Current retained reservation/admission and association archival/lifecycle
completion remain follow-ons; original sourceOwner stays retained_only.
Final-exit commands pin parent Branch deletion until that archival follow-on;
Agent/Chat cleanup uses the final readiness proof. This preserves the command and
its genuine selected checkpoint instead of deleting the only retained proof.
Current admission, lifecycle/archive/reference cleanup and broader families remain
unfinished. These draft readers establish no installed or execution acceptance.


### B1 source correction: exact stored tree frontier map

Typed tree remapping now builds its complete owner map from each owner's exact stored `frontier` fact. Planner validation, insertion, expected-frontier readback and private re-export provenance use this same representation. The recursively restored execution state and wait reason remain a separate eligibility view; original facts and retained generations are unchanged. Identity reservations still cover the same complete typed inventory because that eligibility view substitutes only execution state and wait reason.

The exact whole-owner map guard remains intact, including execution fields. Bundle inputs, outputs and producer links still require exact captured ownership; original parent Step input/hash stays distinct from forwarded child input. Structural retained bundle owners and child/parent seeds keep their separate validation role. `heldTreeSource` already binds raw frontier maps to the same raw remap inputs at every retained generation and is unchanged. Unsupported parents with children still refuse; recreated owners remain held with `currentAuthority:false` and `dispatched:false`.

This removes the source representation mismatch for otherwise supported first, repeated and nested held imports, including inline families. Bundle-bearing eligibility still needs complete original selected and independently latest proof. No repeated import, roundtrip, product execution or installed compatibility was run or qualified. Portable final-command evidence continues to refuse unconditionally: the pure authenticated retained-final objective remains HELD/INCOMPLETE for lack of independent complete original activity/absence inventories and selected plus independently latest proof. Native final cleanup diagnostics, retry/custody checks and all other lifecycle holds remain unchanged.
