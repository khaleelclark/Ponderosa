# Beta 11 development qualification

Beta 11 was integrated through reviewed PRs #503–#507. The final release tree is
`566475063f0004898436c3b022b3f126ca6c9814`; Pine dev runs
`bc96b1ef4e49bb270190d3cf11dfae5b88c823ec` (PR #505). The intervening changes
affect release qualification tooling/tests, not product runtime. These are the
2026-09-14 final-handoff revisions, not a claim that later fixes are deployed.
Beta 11 remains a draft, not a published or cross-platform-qualified release.

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

## Historical baseline evidence

On Pine/Linux with Node 24.16.0 and pnpm 11.10.0, a fresh dedicated worktree at
`e477a1ff` passed frozen dependency installation and `pnpm verify` on 2026-09-14:
461 checks (3 core, 72 agents, 182 web, 204 server), all workspace typechecks,
native-host compilation, and production builds. This evidence does not qualify
Windows/macOS installers or physical mobile audio behavior.

## Upgrade defect found during live qualification

The first dev startup failed before accepting requests because historical lookup
hydrated a deleted, pre-Chat-ownership Agent as a current Agent DTO. The exact
failure was `live Agent ... has no owner Chat`. The schema-only rehearsal passed
and preserved all 67 Projects, 79 Chats, and 470 Agent rows, so row counts and
SQLite integrity alone were insufficient qualification. Dev was restored from
the coherent pre-upgrade snapshot; the failed state remains preserved separately.

The fix makes historical DTO lookup return unavailable for deleted Agents that
have no owner Chat. Existing authored identity remains available to history's
fallback presentation. It does not assign synthetic Chats, alter tombstones,
or relax the missing-owner failure for a live Agent. Modern deleted Agents with
an owner Chat retain their existing DTO behavior. A regression check fails on
the previous release and passes with this fix.

Future upgrade rehearsals must exercise historical Agent/message reads as well
as store/schema open before switching the service.

The system-model documentation now describes integrated Chat ownership,
working copies, voice features, and fail-closed data-layout handling.

## Historical integrated recovery verification

PR #503's exact head `fd0761a0` passed independent tracked Agent review and was
merged. The combined source passed `pnpm verify` on Pine: 467 checks, workspace
typechecks, native compilation, and production builds. This includes the Linux
SIGKILL and filesystem-race recovery checks. Native installer jobs now also run
the voice-storage checks applicable to their platform; Linux-only cases remain
explicitly skipped elsewhere.

## Final handoff evidence — 2026-09-14

At release head `566475063f0004898436c3b022b3f126ca6c9814` (the same tree as
reviewed PR head `8fbbb6a3f57632078c4225eec1ba3326e4092ec3`), full `pnpm verify`
passed 471 tests: 3 core, 73 agents, 182 web, 213 server, plus typechecks, native
compilation and production builds. Earlier counts above describe earlier runs.

- [Exact-head Ubuntu recovery checks](https://github.com/khaleelclark/Ponderosa/actions/runs/34820127129).
- [Final native installer jobs](https://github.com/khaleelclark/Ponderosa/actions/runs/34820441234):
  Linux, macOS and Windows passed; recorded installer metadata and checksum
  sidecars match the exact source/version. Installed qualification reports are
  retained for all three, each with `releaseQualified: false`.
- Final dev upgrade preserved 68 Projects, 81 Chats and 471 Agent identities. All
  historical lookups completed, with eight legacy tombstones deliberately
  unavailable as current DTOs.
- Live reply, cancellation/teardown, reply after cancellation, attachment
  round-trip/ownership checks, desktop/mobile layout and all three local voice
  generations passed. Restart preserved the voice installation and returned
  ready; the post-reload browser error/warning check was empty. These checks do
  not substitute for physical-phone or native target qualification.
- An earlier full run hit the existing asynchronous copy-snapshot cleanup
  assertion in `agent-import-transaction.test.mjs`; its 20-test focused rerun and
  the full 471-test rerun passed. Preserve that timing observation for follow-up.

The final handoff and retained evidence are under
`reviews/beta11-handoff-56647506.md` and `reviews/beta11-final-native-reports/`
in the Pine project workspace (outside the source checkout). The coherent
pre-upgrade backup and earlier failed state remain preserved. Production remains
Beta 9; source qualification is not deployment or distribution approval.

## Remaining release gates

- Complete exact-commit native target filesystem qualification for each
  distributed OS, including the required boundary, rollback, production-route
  and cancellation evidence. Passing installer jobs and dev smoke checks do not
  fulfill those reports. Existing evidence must remain preserved.
- Verify authenticated Codex and Claude discovery/execution on a real macOS
  qualification host.
- Qualify the installed artifact on Windows 11; the hosted Windows Server job
  does not satisfy this gate. Pine Ubuntu 26 is not Ubuntu 24 qualification.
- Physical-phone dictation/read-aloud remains unclaimed. Packages are unsigned
  private candidates. Desktop/mobile browser layout checks do not prove
  microphone permissions, transcript timing, background audio or audio routing.
- Keep the existing experimental quarantined-Project investigation separate;
  preserve its evidence without copying or silently repairing it in dev.
- Product-review fixes require their own verification and independent review;
  the earlier full-suite/native evidence does not qualify a later changed tree.

Continuous voice conversation is follow-on work after Beta 11 stabilization.
It should use existing Chat/Agent/message authority and first prove acceptable
turn latency, interruption, and transcript behavior in a private prototype.
