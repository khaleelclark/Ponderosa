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
