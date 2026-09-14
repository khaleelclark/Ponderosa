# Beta 11 development qualification

Beta 11 is being prepared from experimental revision
`e477a1ff776e2110ab091b6eccf4f3a3210590bf`. This is a development candidate,
not a published or cross-platform-qualified release.

## Development promotion

Pine development uses `ponderosa-dev.service`, port 8789, and its own existing
`/home/phoenix/.ponderosa-dev` state. Promote source/build artifacts only; do not
copy experimental Project data, credentials, or provider preferences into dev.
Production (`ponderosa.service`) and experimental remain separate deployments.

The old dev release `6876d905037af0159c07a84fac8d2c8f4effd0e1` uses system Node 22.
The experimental baseline requires Node 24.16.0. The Pine-specific
`deploy/pine-dev-node24.conf` drop-in selects the release's bundled Node runtime
for the daemon and its child tools, preserving the existing provider search path.
Install it only after the candidate release includes that runtime and has passed
verification. Do not replace the host-wide Node installation.

Before switching, acquire dev's deployment lock, drain its scheduler, verify
zero provider/browser authority and pending cleanup, stop the exact dev service,
and observe an empty service control group. Retain the previous release and
configuration. Make a protected, coherent backup of dev-owned state and rehearse
the new store/schema open against a disposable copy without starting providers
or Automations. A failed rehearsal leaves the old release in service.

After switching, require matching revision, ready status, provider availability,
and preservation of existing Project and Chat identities. Perform desktop/mobile
navigation and chat checks on the dev URL. A startup failure must stop the new
service and preserve the failed state for investigation; restore the coherent
pre-upgrade data snapshot with the old release only before accepting new work.
Never point the old binary at newly migrated state as an assumed rollback.

## Baseline evidence

On Pine/Linux with Node 24.16.0 and pnpm 11.10.0, a fresh dedicated worktree at
`e477a1ff` passed frozen dependency installation and `pnpm verify` on 2026-09-14:
461 checks (3 core, 72 agents, 182 web, 204 server), all workspace typechecks,
native-host compilation, and production builds. This evidence does not qualify
Windows/macOS installers or physical mobile audio behavior.

## Remaining release gates

- Independently review and integrate PR #503's interrupted local-voice recovery
  fix, then run its native cleanup/crash checks and the full verification gate.
- Reconcile `docs/system-model.md` with integrated Chat ownership, working copies,
  voice features, and fail-closed data-layout handling. Its current limits section
  contains obsolete claims; do not use it as a release qualification ledger.
- Verify current dev data upgrade, live desktop/mobile interaction, provider Runs,
  Stop/retry, attachments, dictation, browser speech, and optional local speech.
- Investigate the existing experimental readiness report of one quarantined
  Project separately. Preserve its evidence; do not copy or silently repair it
  during dev promotion.
- Select and independently review the exact release head, integrate through a PR
  to master, and run native installed-artifact qualification for each distributed
  platform before publishing Beta 11. Build success alone is not OS qualification.

Continuous voice conversation is follow-on work after Beta 11 stabilization.
It should use existing Chat/Agent/message authority and first prove acceptable
turn latency, interruption, and transcript behavior in a private prototype.
