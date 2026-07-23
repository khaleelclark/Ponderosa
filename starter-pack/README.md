# Ponderosa private-beta starter pack

These resources exercise ordinary product workflows without changing Ponderosa's
architecture. They contain no credentials, absolute paths, enabled Triggers,
provider tokens, external outreach, or elevated management permissions.

Organization files use the same portable package schema as the application's
normal import/export surface. Import always requires a destination Project chat
and an explicit mapping from the template's provider name to an available local
provider.

Suggested order:

1. `scenarios/first-agent.md`
2. `scenarios/communication.md`
3. `scenarios/pause-resume.md`
4. `scenarios/trigger.md`
5. `scenarios/deletion-recovery.md`

The disposable Project folder is intentionally plain text and portable. A
successful verification should exercise provider invocation, streaming, a tool,
one temporary file, cancellation, restart persistence, and cleanup. Delete the
Project afterward unless support asks you to retain it.

All expected observations are summarized in `expected-results.json`. They are
user-facing behavior checks, not substitutes for automated tests.
