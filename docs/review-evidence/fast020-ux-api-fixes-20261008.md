# FAST0.2 UX/API repair qualification

The five independent UX/API findings at `821760573bb94cad70e86e827d4084883dea1f30`
are repaired on released runtime-fix base `ad3d093ea26f08778b47be402ee997cb4a7b3762`.
PR623 remains draft. This is writer qualification; independent exact-final-head
runtime and UX reviews, completed required CI and release gates remain open.

Shared JSON and collection transport selects productApiPath before fetching and
coalescing, capturing the namespace once per request. Keys include that selected
path, so a pending Branch read cannot satisfy a Dev read after route navigation.
Background POST cooldown classification still uses the original endpoint.
Agent export download links and Agent browser frame reads select the same namespace;
existing text/SSE/Project-frame handling and native Branch endpoints are preserved.
The package-action consumer gets its corrected URL from the shared API.

The convergence fixture rejects unscoped shared requests with 404 before normalization.
Its browser runner asserts that negative oracle. A separate checked-in runner bundles
actual realApi and bridges HTTP to a real disposable canonical server: Branch Project,
Chat and members succeed, foreign Dev fails, concurrent same-resource JSON/collection
reads across products remain distinct, export links and absent-Run frame requests use
the selected namespace. No actual provider browser or package-download session is claimed.

Parameter text/number/boolean fields, execution-limit fields, capability toggles and
capability discard/load-latest controls lock during their save. New input after the
acknowledgment remains editable and dirty. The checked-in delayed-response runner uses
actual BranchSettings and actual Branch/Chat/Agent CapabilityPolicyEditor callers.
It asserts every pending control, failure retaining the submitted draft and dirty guard,
retry with unchanged revision, successful acknowledgment, later local input/dirty
navigation and next save using the acknowledged revision. Fields cannot accept a newer
edit during the pending response, preventing the reproduced loss at its source.

Historical full documents retain canonical author custody after deletion. Reads require
the active original Chat in the selected product and exact event Project, historical
artifact author ownership, exact live/tombstoned author Project/Chat binding and no
inactive author installation. Existing authority still validates event/author/execution,
managed catalog access and immutable artifact bytes. Canonical deleteAgent regressions
preserve metadata/download content in Dev and Branches, reject the foreign product and
wrong Project, and reject staging/retiring author or Chat resources after deletion.

Sidebar search now forwards distinctChats before the store limit. The HTTP handler also
supplies requestProduct: a new negative control exposed its missing argument despite
the store already supporting product filtering. Actual canonical message HTTP writes
prove one older Chat plus a newer busy Chat remain visible as two distinct results;
ordinary search retains its five-message behavior. Branch/Dev controls reject foreign
matches and query-supplied product spoofing. No new search authority or schema is added.

Focused validation: 14/14 related server tests, two expanded canonical regressions,
real-client transport, delayed-save browser checks for all three scopes, and all15
existing strict convergence phases pass without skips or page errors. Web and fixture
typechecks pass. Expected-behavior API and transport probes fail against immutable821
builds; the initial search foreign-product failure is retained and fixed at its handler.
Original independent defect scripts/logs are untouched. Full integration verification
passes exit0: 1598 total / 1590 passed / 8 existing skips / 0 failed or canceled; types, production builds and bundle budgets pass. Exact-head CI receipts are recorded in the standalone handoff.

The earlier unchanged strict APIp95<250ms failure at exactly250ms on runtime head ad3d
remains a qualification blocker. No latency run, threshold/recipe alteration or waiver
is part of this UX stage. Inherited recovery recipes,11required paths, Script/Refresh/
retirement fixes, schema/dependencies/lockfile/version and optional-feature separation
remain intact. Windows recovery loader and sandbox qualification prose are queued for
separate bounded correction. No native/platform/installed-ABI/artifact/live-provider/
physical voice/keyboard/PWA/rollback/production-scale or whole-integration approval.
Version0.2.0/notes and source/release gates remain open; no merge/tag/deploy/release.
