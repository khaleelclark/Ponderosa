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

Remaining #8 implementation boundaries:

- The current canonical reporting model explicitly forbids a parent or ancestor in another Chat (`store-agent-catalog-authority.ts`, `store-agent-management-authority.ts`). The package engine refuses multiple source Chat bindings before writes. A live cross-Chat reporting tree requires an ownership-model decision covering organization, deletion and context authority; it cannot be completed safely as a packaging-only edit.
- UI owner must expose selected-file/new-folder and access-review choices and render retained structured provenance/attachment bindings. Branches owner must forward its explicit human-reviewed access choice through workflow installation. Their shared files remain exclusively theirs; they were notified of the exact DTO/API contract.
- Selected external transport carries selected root-Agent regular-file paths/original bytes. It does not replace an existing registered Chat root, transport Git history, preserve mode/timestamps/symlinks or recursively back up every organization working folder. Choosing a new root/Chat and copying a complete working tree requires the corresponding UI/destination-binding workflow, not implicit mutation of existing user folders.
- Explicit destination memory-read grants and saved-browser grants stay local; this continuation transports capability restrictions, not browser profiles/sessions, foreign permission ownership or credentials. Existing human Settings APIs can recreate local grants. No claim is made that every nonsecret access setting has a portable reviewed mapping.

Selected global memory stays in the separate operator-chosen transfer model. Branches owns workflow execution/checkpoint preservation and warning; UI owns warning presentation. Full #8 remains incomplete across these concrete boundaries and all execution remains deferred.

Installer recipes and user-folder deletion paths otherwise retain accepted baseline behavior. No arbitrary dead-code claim, installer qualification, whole-suite pass, upgrade acceptance or production readiness is made.
