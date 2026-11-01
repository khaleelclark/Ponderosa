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

Remaining implementation: complete structured authored communication plus uploaded attachment transport; separate working-copy and cross-Chat organization bindings; human-reviewed transport of nonsecret access settings; external working-folder transport where selected. Existing operator-selected global-memory transfer stays separate. Workflow execution/checkpoint preservation and workflow package warning are owned by Branches. UI warning integration is owned by UI. Native sessions/credentials/live scheduler authority must not be imported as active ownership. These gaps mean full #8 is still incomplete; setup fields and an evidence artifact are not a full organization roundtrip.

Installer recipes and user-folder deletion paths otherwise retain accepted baseline behavior. No arbitrary dead-code claim, installer qualification, whole-suite pass, upgrade acceptance or production readiness is made.
