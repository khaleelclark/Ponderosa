# Portability implementation status

Implementation increment from the unified f64 source. No tests, builds, types, browser checks, suites, runners or prerequisite preparation were executed. These changes do not establish a passing Bible verdict.

| Requirement | Implementation |
| --- | --- |
| #8 portable Agent setup | `packages/core/src/dto/agents.ts`, `apps/server/src/portable-agent-package-validation.ts`, `apps/server/src/routes/agent-packages.ts`: role, speed and preset snapshot retained; preset guidance/role artifact refs rebound; target processing tier validated before writes. Existing Agent/organization/workflow callers use the same package engine. |
| #8 export warning backend | Shared `FULL_PACKAGE_EXPORT_WARNING` and full/context Agent HTTP warning header. Branches/UI owners were asked to use the shared value on their owned surfaces. |
| #9 remove duplicate/dead upgrade paths | Replaced three ad-hoc schema subtraction paths with one exact ordered-prefix reconstruction. No unsupported schema is auto-repaired. |
| #15 preserve user files | `apps/server/src/empty-tombstone.ts`, `apps/server/src/routes/projects.ts`: replaced recursive deletion of a creation tombstone with marker-only unlink and nonrecursive rmdir. Unexpected/concurrently added files survive and cleanup stays pending. |
| #17 populated additive upgrades | `packages/agents/src/db.ts`, `packages/agents/src/state-admission.ts`: exact 0027–0033 schema prefix matching and existing leased transactional upgrade. No runtime legacy initializer; predecessor construction is private empty-memory only. |
| #23 docs | `docs/combined-migration-contract.md`, `docs/additive-upgrades-and-cleanup.md` document settings, API warning, upgrade boundary, preserved cleanup content and remaining gaps. |

Deferred regressions: existing organization portability test gains reopen/setup/warning/refusal cases; new additive-upgrade test copies populated canonical rows into exact predecessor schemas then reopens through AgentStore; new tombstone test compares retained user bytes. The prior Assistant workspace test's synthetic predecessor leaves later tables behind; its Branches owner has been notified to reconstruct a true prefix rather than treating that hybrid as a published predecessor.

Continuation beyond b003ae28 adds #8 transport in `portable-communication.ts`, `portable-working-files.ts`, the shared DTO/parser, Agent route/codec and imported-history store. Canonical authored scope/metadata and revisions remain attached to historical rows; uploaded originals and document references bind to staged managed artifacts, including collision remapping and repeated exports. Source Chat IDs are retained without granting destination authority. Shared/Separate Git intent recreates fresh local ownership through the existing working-copy service. Effective capability restrictions require explicit hash-bound human review and audited application on fresh Agents. Selected external file paths and bytes can be exported and restored into an exclusively new folder, retaining files and a durable destination receipt on failure. Copy and raw/JSON staged-import metadata carry the same choices. Application routes supply the existing working-copy service.

Regression source was updated in `tests/organizations/portability.test.mjs`; `tests/organizations/portable-working-files.test.mjs` covers path/credential/link refusal and non-overwriting selected-byte transfer. No regression, Node/module invocation, suite, comparator, build, typecheck, browser, benchmark, runner or prerequisite preparation was executed.

Current continuation adds staged access preview, owning-Agent provenance API, whole root-folder inventory/metadata, nonsecret memory/browser suggestions with exact destination Agent mappings, and canonical audio original types. See the detailed contracts in `combined-migration-contract.md`.

| Requirement | Concrete continuation files |
| --- | --- |
| #8 review before async queue | `routes/agent-packages.ts`, core `dto/agents.ts`: staged `agent-access-preview`, shared digest, raw metadata allowlist, `AgentAccessImportReviewDto`. |
| #8 retained Communication UI contract | `routes/agent-packages.ts`, core `dto/agents.ts`: bounded/product-fenced `imported-communications`, authorized remapped artifact URLs, version-aware pagination. |
| #8 whole root working folder | `portable-working-files.ts`, package validator/routes, core Agent DTO, Agent archive store/facade: opt-in inventory, empty directories, ordinary modes/mtime, new-folder restore, retained re-export intent, explicit exclusions. |
| #8 nonsecret access mapping | package routes + application context + core DTO/parser: memory-read/browser preference suggestions; import result maps them to new Agent IDs/Chat. Existing human Settings APIs remain sole grant application paths. |
| Build voice-message original transport | `audio-container.ts`, `assets.ts`, `asset-contracts.ts`, core `dto/artifacts.ts`: canonical webm/ogg/mp4 audio types, container/extension/type admission, existing immutable original persistence. |
| #23 + deferred regression source | This document, `combined-migration-contract.md`, organization portability/whole-folder regression source, `tests/files-results/audio-container.test.mjs`. |

Remaining #8 implementation boundaries:

- Valid current organization export is exactly one within-Chat reporting subtree, not multiple independent Chat roots. Manager directed preserving that invariant. Separate Chat roots need separate package operations and human-created destination Chats; source historical references retain their original identities. No cross-Chat reporting feature or ownership-model change is needed or implemented.
- Web owner must consume the new staged access-preview/provenance contracts, offer whole-root opt-in, perform explicit memory/browser Settings review/calls using returned destination mappings, and offer Chat creation/working-root selection through existing human flows. Backend does not silently replace an existing registered Chat root. Existing selected-file/new-folder controls are already owner-committed; source web integration remains owner-dependent.
- Branches owner must forward an explicit reviewed capability restriction choice through workflow installation. Workflow execution/checkpoint transport remains Branches-owned.
- Whole-folder transport covers the explicitly selected root Agent's folder, preserving regular files and directories where supported. Symlink/special/hardlink topology refuses; native ownership/Git history and known credential paths are excluded with listed paths. Multiple distinct organization working-copy roots are not recursively combined or silently rebound. Arbitrary opaque files can contain secrets not recognizable by known-field/path inspection; full export warning still applies.
- Backend transports and maps nonsecret memory/browser suggestions but never applies them automatically. Actual human reviewed destination grants require the web owner to call existing Settings APIs. Source browser profile names cannot identify a destination profile and need explicit destination selection. No credentials, saved profile/session bytes or foreign grant ownership is adopted.

Selected global memory stays in the separate operator-chosen transfer model. Branches owns workflow execution/checkpoint preservation and warning; UI owns warning presentation. Full #8 remains incomplete across these concrete boundaries and all execution remains deferred.

Installer recipes and user-folder deletion paths otherwise retain accepted baseline behavior. No arbitrary dead-code claim, installer qualification, whole-suite pass, upgrade acceptance or production readiness is made.

Shared-engine follow-up: `routes/agent-packages.ts` now owns and exports the
`BranchPackageEngine`/`BranchPackageImportOptions`/`BranchPackageImportError`
contract. Its `reviewAccess` and HTTP preview/import share one helper; import
forwards explicit reviewed choices and preserves structured review on 409.
Organization regression source covers refusal payload, explicit forwarding and
stale package hash. Branches-owned caller routes/service remain unchanged and must
adopt the exported contract and persist human review. No tests/checks executed.

### Organization folder continuation (source only)

Implemented per-Agent `workingRootRef`, distinct-root deduplicated opt-in full
organization export, exact explicit `workingRootDestinations` import mapping,
new-only folder restoration, durable mapping/error retention and response mappings
of restored roots to fresh Agent IDs. Shared roots carry one inventory/originals
owner; child Separate Git roots are inventoried independently. Existing selected
and root-only formats remain accepted. Files: core `dto/agents.ts`, server
`routes/agent-packages.ts`, `portable-agent-package-validation.ts`,
`agent-package-codec-worker.ts`; regression source
`tests/organizations/portable-working-roots.test.mjs`; contract above in
`combined-migration-contract.md`. UI owner has the exact controls/DTO contract.

Remaining backend implementation: these restored NEW paths are content destinations,
not live Agent roots. `packages/agents/src/working-copy.ts` requires Shared roots
match Project.hostPath exactly and Separate Git roots have managed branch/ownership
receipts. `agent-working-copy-service.ts` creates fresh destination-snapshot worktrees,
which omit source uncommitted/ignored child files. No foreign ownership is adopted.
A reviewed service to create destination Projects or safely populate fresh native
worktrees is still needed to make restored folders live while retaining shared-root
relationships. This increment does not claim full #8 completion. No tests, checks,
build, types, runner preparation or execution were performed.

Branch wrapper continuation: `BranchPackageExportOptions` now forwards explicit
selected/root/organization-folder and subtree intent to the same builder.
`BranchPackageImportOptions` forwards selected-folder/per-root NEW destination
choices and returns the full existing retained-root/access-review result DTO.
Retained-location error text is preserved. No Branch installation/routes or core
Branches files were changed. Regression source extends organizations/portability;
no execution. Live destination-root assignment remains unimplemented as above.

### Live working-root continuation (source only)

The former content-only backend gap now has an opt-in implementation:
`workingFilesActivation` forwards through JSON/staged/copy/Branch wrappers and
canonical hashing. Shared activation requires explicit exact `sharedRoot` for an
unused managed NEW Chat created through existing Chat creation. New store catalog
admission checks managed creation identity; service checks canonical empty folder,
then initializes local empty Git. Separate Git imports create their normal fresh
owned worktrees. The importer populates actual resolved roots only after creation,
under the existing mode-change fence, preserving shared membership and refusing
incompatible root-mode collapse/split. Durable `liveWorkingRoots` records actual
Agent paths before writes. Baseline displacement retains bytes plus original-path
sidecars in excluded native recovery folders; existing Shared roots never qualify.
Original recovery destinations continue to retain all package bytes on failures.

Files: core dto/agents.ts; agents store-workspace-catalog-authority.ts and store.ts;
server agent-working-copy-service.ts, portable-working-files.ts, package route and
codec worker. Contract above supersedes earlier content-only backend limitation.
Regression source portable-working-files.test.mjs covers preserved displaced bytes,
path sidecars, restored ordinary paths and native recovery exclusion. Caller UI and
Branches explicit activation/new-Chat selection remain owner work. No tests/checks,
Node/build/types/browser/runner preparation or execution; no passing or full #8 claim.

Additional deferred regression in organizations/portability.test.mjs constructs a
managed new Chat destination through the store creation contract and asserts that
normal Agent workingCopy.rootPath reads restored bytes, reports liveWorkingRoots,
and refuses activation on existing Shared roots. The fixture now supplies the real
working-copy service. Still no execution or passing claim.
The deferred live regression also imports a Separate Git Agent into that fresh
repository and asserts locally owned branch receipt, distinct normal working path
and restored bytes there. No source runtime was invoked.
