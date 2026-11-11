# Lossless large Agent package qualification — 2026-11-02

Source base: `b1fd75be85cd14b0037259b50a207684d5088ff3`.
Writer: Codex task-3, branch `fix/lossless-large-agent-packages-20261102`,
worktree `/path/to/worktrees/lossless-large-agent-packages-20261102`.
This is isolated source qualification, not a deployment or complete Bible verdict.
No push, PR, merge, live Agent mutation, provider request or service restart occurred.

## Actual full-data measurement

The corrected exporter produced one full Agent package from a disposable copy of
source project files and query-only production SQLite readers matching deployed
`236a5a0707b0546830a9c3045dbd096f17fbaf9b`. Production predates phase-2 access
policy tables; the measurement adapter verifies absence/emptiness before retaining
its existing unrestricted default. No policy records are discarded. Optional new
working-folder/global-memory selections were not requested. This measurement is
not an import into production or a claim of canonical scheduler restoration.

| Measurement | Result |
| --- | ---: |
| Serialized package bytes | 1550518493 |
| Decoded original artifact bytes | 1736631820 |
| History messages | 5980 |
| Included artifact records | 4916 |
| Selected catalog originals checked against source SHA-256/size | 4849 |
| Execution archive parts | 62 |
| Decoded execution archive bytes | 512743138 |
| Source / archived execution events | 35303 / 35303 |
| Source / archived historical Runs | 1287 / 1287 |
| Gzip-encoded originals | 429 |
| Measurement process peak RSS (including worker) | 4329906176 |

Package SHA-256: `76381670d3c18c82664357aec4575f80757cdf644f1952fd7d70d9dd5c61483d`.
Every selected catalog original matches its source size and SHA-256 after
streaming parse and decompression. Ordered execution rows and historical Run rows
match the complete source after the unchanged required secret exclusions.
The package remains in the private fixture at
`/tmp/ponderosa-cliff-measure-izm5ls/cliff-full.agent-package.json`;
metrics are `measurement.json` beside it. The read-only measurement harness is
`/tmp/ponderosa-measure-large-package.mjs`. These are qualification evidence, not
a replacement Agent or a complete canonical backup/restore receipt.

The earlier raw Agent-directory preservation archive remains unchanged:
SHA-256 `a81ef2c6f6ee4866bbabfcf41cbd5bd73c6751de5a3b3eda465d98c880e74fe6`.
Its 519014400-byte tar size does not predict portable composition: the package
also needs referenced originals owned by other Agents. The source project catalog
has 1436306762 decoded bytes; many are existing zip/binary files and cannot be
made arbitrarily small by lossless compression.

## Focused checks

Node 24.16.0, existing installed dependencies and exact-base native addon; no
installation, provider session or full suite. Core/native-host/engines/agents/server
builds, web typecheck and web production build passed. Final server typecheck and
`git diff --check` passed.

46 distinct focused cases pass across the consolidated run and targeted reruns:

- `tests/files-results/portable-artifact-count.test.mjs`: exact UTF-8/base64,
  malformed strings, 10000-Agent topology, decoded aggregate bound, gzip
  corruption/expansion/size refusal, canonical identity, memory admission,
  differential streaming JSON grammar/Unicode/prototype checks and a full 2 GiB
  file parse/reserialize with matching SHA-256.
- `tests/organizations/execution-portability.test.mjs`: private/organization
  boundaries, credential exclusions, complete archive splitting beyond 64 MiB,
  large HTTP export, JSON and binary imports, cross-Chat copy, cancellation,
  failed-import source preservation and native HTTP success beyond a 25 ms idle
  timeout.
- `tests/organizations/compose-agent-packages.test.mjs`: exact Shared originals
  across gzip/plain representations, topology and private/team memory boundaries.
- `tests/organizations/portable-working-files.test.mjs`: paths, credentials,
  modes/topology, preserved displaced files and incompressible wire refusal whole.
- `tests/organizations/package-upload-ownership.test.mjs`: staged-path ownership,
  product fences and durable binary-import replay.
- `tests/installation-release/offline-content-restore.test.mjs`: existing restore
  contracts and encoded-input refusal before destination creation.

At the exact 2 GiB wire ceiling the worker used 2161375456 heap bytes and 3740498
external bytes; process RSS including its parent was 4765884416 bytes, within the
3 GiB worker heap cap and 6 GiB admission. No whole-document JSON string or input
buffer was allocated. The final targeted canonical test is 1/1 and HTTP/import
rerun is 12/12. The injected-socket guard and accidental legacy fixture count edit
found during qualification were corrected; only affected checks were repeated.

Logs: `/tmp/ponderosa-large-package-qualified.log`,
`/tmp/ponderosa-large-package-canonical-final.log`,
`/tmp/ponderosa-large-package-http-final.log`,
`/tmp/ponderosa-large-package-web-build.log` and
`/tmp/ponderosa-cliff-measure.log`.

A broader portability run exposed four pre-existing failures, reproduced on an
untouched detached worktree at the exact source base: guidance/artifact selection
in full organization round trips, preset guidance versus changed initial
instructions, long guidance remapping, and NEW Shared root activation. These were
not folded into the resource/transport correction. Baseline evidence:
`/tmp/ponderosa-large-package-baseline.log`; worktree
`/path/to/worktrees/large-package-baseline-20261102`.
The 10000-Agent live import qualification remains opt-in/not run. No full-suite,
real-provider, native browser end-to-end or production-import claim is made.

## Review and rollout boundary

Production still runs system service `ponderosa.service`, PID 2397072 at inspection,
from `prod101-session-admission-236a5a0707b0-reserve-v2-20261028/Ponderosa`.
Development still runs `c581d406604d9cec7fee69cb5e118ce024285d95`.
The integration base has substantial schema/portability work absent in production;
this branch is not a safe minimal production release merely because these checks
pass. A separately reviewed production-compatible backport/release revision is
required before retrying supported live copy. Do not deploy the entire integration
candidate to solve this one defect.

The minimal runtime cutover, once a compatible revision is qualified and explicitly
approved, is matching core/server and web assets plus controlled cutover/restart
of `ponderosa.service`. This patch does not require auth proxy, LAN proxy, local
memory or unrelated services to restart. Active/unknown Run custody and rollback
must be accounted for before that restart. No rollout approval is inferred here;
no rollout revision has been qualified against the older production schema.

Separate auth `bed4f8a9d4e1d99818b79178c5f0877ee192aa83` and Output control
`9f7b21fdc9fe0fbf4a3474c5decb32506f42ed6d` remain untouched. No Cliff copy,
reparenting or deletion was attempted. The unknown Run/fence was not replayed,
erased or relabeled. The parent task owns subsequent replacement and any required
action-time deletion confirmation.
