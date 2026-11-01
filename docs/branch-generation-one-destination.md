# Serial resource generation history destination source

This is source assembly, not executable qualification. The supported source bound
is one manual standalone owner, one serial issued resource, ASYNC/SYNC, current
generation 1–32, and a configured fresh-context retry policy with maxAttempts
between current generation + 1 and the existing definition ceiling100. Every generation starts an actual new
resource import and opening. The current resource attempt number is generation
+ 1; destination remapping preserves that consumed number and the original pinned
maxAttempts. Acceptance does not replenish the retry budget. Existing generation
zero, called-tree producer and standalone group defaults remain unchanged.

`generationOneEvidence` in the existing generation-one module now validates the
complete ordered chain. For EVERY prior generation it reads the actual sealed
`readGenerationExitCapture`, immutable intake fence, provider exit evidence,
retained native exit inventory, package receipt and exact
`resource-generation-retired:<step>:<generation>` journal. It binds original
configuration/pins, complete resource/import/member/context inventories, canonical
failed Request result, exact failed attempt and the next prepared retry's original
identity, number, input hash and availability timestamp. Prior selected cuts must
contain exactly the known failed prefix and that prepared successor. The original
retirement audit must match every owned SQL event through its boundary; shared
serial replay also checks that exact prefix at the actual retirement event.
Changed hashes, omitted/reordered generations, rehashed truncated audit prefixes,
changed failed outcomes, unknown effects, aliasing and missing proof refuse.

Later precleanup capture uses the same history validator in exit mode. The full
original selected cut remains in the seal. Its host capture contains ONLY that
failed generation's executable root, excluding earlier roots and the unissued
prospective successor. All earlier retained contexts must match their exact
retirement records before they are removed from this host cut. The seal binds its
complete earlier selection/retirement-hash prefix. This makes a real gen1 exit
seal possible after gen0 identities have been deleted; no deleted Chat is probed
to rediscover or fabricate its graph. Capture and sealing still use the existing
package engine and synchronous owner transaction callback.

The current issued capture likewise retains full original selected evidence in
`generationRetry.originalSelected`, while its executable selected cut and host
contain only the current resource attempt/Chat/Agent/Request identities. The
existing proof schema retains its singular gen0 field for generation-one captures;
for later generations `history` contains the exhaustive ordered list, also bound
to the exact first singular entry. `generationHistoricalSelections` supplies that
server-owned list to every review and admission caller. The shared serial codec
walks all original openings, failed results, configured retry schedules and
retirement events in order, switching to each exact original resource and then
to the current one. Its retained/current host union is validation-only and never
reaches destination graph writing or imports. Ordinary rewind remains refused.

`GET .../resources/:stepId/generation-history-preview` returns `reviewHash`,
`historicalReviewHash`, actual `generation`, `consumedAttempts`, `maxAttempts`, and
ALL exact server-derived `historicalPartition` selections in generation order.
Each selection discloses its complete original envelope to actual CURRENT package
source refs. The preview CAS includes full selected bytes, current host, original
history, pins and complete replay audit. POST `issued-checkpoint` with a positive
expectedGeneration requires this exact expectedReviewHash. Status and bounded
`generation-history-captures` discovery return the same saved selection list and
hash. BranchesClient exposes previewGenerationHistoryCapture,
listGenerationHistoryCaptures, captureIssuedResource and issuedResourceCaptureStatus.
The existing generation-one preview/discovery remain restricted to generation one;
the existing web flow is not silently widened and no web files are changed.

After source settlement and actual current resource cleanup, existing singular
destination prepare requires the exact saved historicalReviewHash and copies the
whole list into Runtime's historicalPartition. Existing disclosure reads actual
old/current packages, presents every historical-envelope fact plus current facts,
requires original Project and historical Request Project audit-read, current
human all-facts approval and final destination policy. Approval remains revocable.
Existing fresh acceptance/budget/Chat/owner/Step/import/resource/current Request
composition and Runtime admission share ONE outer owner transaction. Its immutable
historical receipt contains complete nondispatchable evidence; owner failure rolls
it back with the current graph/import/checkpoint. Old identities never enter current
maps. Exact existing singular receipt/readiness and restart readback remain reused.
Runtime still enforces its 32-selection AND 32 MiB total evidence bounds; reaching
32 generations does not promise a large package fits that byte bound.

The approved assembled base omitted the already joined Runtime529 source-scope
correction. This slice includes it: original surviving Chat must match sealed
Project/Branch/execution; generation-exit fencing binds Project via resource Chat,
not nonexistent branches.project_id. Fresh destination Project policy is separate.
Historical review/package/final authorization checks every original Request Project
as well as seal Project. No source visibility or audience rewriting is introduced.

Deferred ASYNC/SYNC fixture SOURCE covers real Branch prefix -> resource import/
opening -> failed Request -> retry -> provider registration/observed exit -> seal
-> Agent/Chat cleanup -> retirement for each generation, then current capture ->
source completion/cleanup -> singular prepare -> explicit human all-facts approval
-> atomic rollback -> one admit -> restart readback -> failure with no replenished
retry budget. Cases include generations 2, 3 and the selection boundary 32, each
missing retirement link, stale CAS, omitted/reordered/aliased/rehashed history,
current-only maps and retained consumed attempt numbers. Package bytes and process
handles remain inert adapters. No test/check/typecheck/build/Node/native/browser
execution or preparation was performed; no passing or live qualification is claimed.

Local parallel retry admission, called-owner atomic destination consumption,
generations above 32, EXIT, manual recovery,
unknown/forwarded/secret/artifact families, missing preupgrade proof and web adoption
remain unsupported/refused. Runtime owner-tree work and its existing Join are
untouched. Live provider/native/filesystem custody and restored runtime behavior
remain unqualified.


Saved capture budget recovery: issued-capture status and canonical generation-history discovery return `retryBudget` (`verified` with `consumedAttempts`, `maxAttempts`, and `evidenceHash`, or `unavailable` with `missing_saved_retry_proof`). Verified budgets also populate the top-level optional numeric fields. The SDK's existing typed status/discovery methods receive these shared DTO fields. The hash binds the complete saved snapshot and review hash; retained status additionally verifies the checkpoint seal. Verification replays the saved continuation and original attempt inventory against the pinned, hash-checked version definition, not active Branch policy or a fresh preview. Missing legacy proof supplies no numbers; malformed present proof refuses. Generation-one saved proofs use the same reader. `not_found` has no budget. This is evidence of consumed original attempts, never a replenished retry allowance.

Deferred source regression covers empty-client identity recovery, discovery equality, restart, changed mutable configuration, corrupted original attempt and explicit legacy unavailability. No execution qualification is claimed.


Local-parallel history source extension: the current bounded contract in [branch-local-parallel-history.md](branch-local-parallel-history.md) supersedes the earlier serial-only limit for exactly one resource invocation with settled local siblings. It reuses the same generation-history producer, parallel replay, current-only cut and canonical single-owner admission; it does not enable arbitrary parallel or called-owner consumers. Source fixtures are deferred and unexecuted.
