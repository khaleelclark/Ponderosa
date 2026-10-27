# Ponderosa production runbook

Ponderosa is a single-operator system. Every admitted proxy identity has the
same authority over all Projects, Agents, files, providers, and retained
browsers. Never expose one deployment to mutually untrusted operators.

## Service objectives

- Operator API availability: 99.5% over 30 days.
- Successful non-stream API requests: 99% below 2 seconds over 5 minutes.
- Startup recovery: below 30 seconds for the qualified long-lived dataset.
- Durability: no acknowledged canonical Communication, Run, or Project loss.
- Recovery point: a verified snapshot immediately before every migration and
  at least daily while the service changes.
- Recovery time: restore rehearsal completes within 30 minutes.

Scrape authenticated `GET /api/metrics`; never publish it anonymously. Import
`deploy/observability/ponderosa-alerts.yml` into Prometheus. Request logs carry
the same `X-Request-Id` returned to the caller.

## Identity and network boundary

For Tailscale Serve, configure the exact HTTPS origin, enable the trusted proxy,
and list the only allowed Tailscale login identities:

```ini
PONDEROSA_OPERATOR_ORIGINS=https://ponderosa.example.ts.net
PONDEROSA_TRUSTED_REVERSE_PROXY=true
PONDEROSA_OPERATOR_IDENTITIES=operator@example.com
PONDEROSA_AUTH_TOKEN=<at-least-32-random-characters>
```

Ponderosa requires both the verified `x-ponderosa-operator-identity` identity
and the backend bearer (or the secure browser
session obtained by opening `/__ponderosa_bootstrap#TOKEN`). An identity header
alone never grants authority, including on loopback. Restrict the Serve port to
the same identities with tailnet grants; the application allowlist is defense
in depth, not a substitute for tailnet policy. Production origins must be HTTPS.
When Serve cannot inject a backend bearer, use the private Unix-socket
identity bridge documented in `deploy/README.md`; do not rely on expiring
browser cookies for a bookmarked hosted deployment.
The bridge validates its configured upstream header (for example,
`Tailscale-User-Login`) and replaces any caller-supplied internal identity.
Deploy the bridge and backend from the same qualified artifact when this
internal contract changes; direct authenticated probes must use the internal
header, not the upstream one.

Production support is Linux x64 only. The unit must load a mandatory
`%h/.config/ponderosa/release.env` containing the exact installed identity:

```ini
PONDEROSA_BUILD_VERSION=1.2.3
PONDEROSA_BUILD_SHA=<40-character-installed-commit>
```

Startup compares these values with the installed `build-manifest.json` and
fails closed on absence or mismatch. `deploy/ponderosa.service` runs the
installed Linux package at `/opt/ponderosa-engine/resources/Ponderosa`; it does
not use a source checkout or a release symlink. Stop the service before
replacing those bytes with `dpkg`, and retain the previous exact `.deb` and
pre-migration snapshot for rollback.

## Timed encrypted restore rehearsal

Run this before each migration and at least quarterly against the currently
installed exact artifact. The daemon must be stopped so the data-directory
lease is authoritative. Keep the terminal transcript and the encrypted archive
in the restricted operations evidence store; never commit either artifact.

```bash
set -euo pipefail
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
work="$(mktemp -d "${TMPDIR:-/tmp}/ponderosa-rehearsal.XXXXXX")"
encrypted_tmp=""
cleanup() {
  result=$?
  if test "$result" -eq 0; then
    rm -rf -- "$work"
    test -z "$encrypted_tmp" || rm -f -- "$encrypted_tmp"
  else
    printf 'Backup verification failed; retain private diagnostic work=%s encrypted_tmp=%s\n' \
      "$work" "$encrypted_tmp" >&2
  fi
  exit "$result"
}
trap cleanup EXIT
install_root=/opt/ponderosa-engine/resources/Ponderosa
node="$install_root/runtime/node"
data_tool="$install_root/app/server/tools/data-directory.mjs"
started="$(date +%s)"
"$node" "$data_tool" backup \
  --data-dir "$PONDEROSA_DATA_DIR" \
  --output "$work/snapshot" \
  --external-projects copy
encrypted_tmp="$(mktemp "$PONDEROSA_BACKUP_EVIDENCE_DIR/.ponderosa-$stamp.XXXXXX")"
tar -C "$work" -czf - snapshot | age -r "$PONDEROSA_BACKUP_AGE_RECIPIENT" \
  > "$encrypted_tmp"
mv -- "$encrypted_tmp" "$PONDEROSA_BACKUP_EVIDENCE_DIR/ponderosa-$stamp.tar.gz.age"
encrypted_tmp=""
rm -rf "$work/snapshot"
age -d -i "$PONDEROSA_BACKUP_AGE_IDENTITY" \
  "$PONDEROSA_BACKUP_EVIDENCE_DIR/ponderosa-$stamp.tar.gz.age" \
  | tar -C "$work" -xzf -
"$node" "$data_tool" restore \
  --backup "$work/snapshot" \
  --data-dir "$work/restored" \
  --restore-external-projects \
  --external-project-root "$work/external-projects"
sha256sum "$PONDEROSA_BACKUP_EVIDENCE_DIR/ponderosa-$stamp.tar.gz.age" \
  > "$PONDEROSA_BACKUP_EVIDENCE_DIR/ponderosa-$stamp.sha256"
elapsed="$(( $(date +%s) - started ))"
test "$elapsed" -lt 1800
printf 'revision=%s started=%s elapsed_seconds=%s\n' \
  "$PONDEROSA_BUILD_SHA" "$stamp" "$elapsed" \
  > "$PONDEROSA_BACKUP_EVIDENCE_DIR/ponderosa-$stamp.txt"
# If node_exporter's textfile collector is configured, publish only after
# encrypted archive creation and disposable restore both succeeded.
if test -n "${PONDEROSA_BACKUP_METRICS_DIR:-}"; then
  metric_tmp="$(mktemp "$PONDEROSA_BACKUP_METRICS_DIR/.ponderosa-backup.XXXXXX")"
  printf 'ponderosa_backup_last_verified_timestamp_seconds %s\n' "$(date +%s)" > "$metric_tmp"
  mv -- "$metric_tmp" "$PONDEROSA_BACKUP_METRICS_DIR/ponderosa-backup.prom"
fi
```

Configure a readiness Blackbox Exporter probe named `ponderosa-readiness` and
node_exporter's textfile collector at `PONDEROSA_BACKUP_METRICS_DIR` before
enabling `deploy/observability/ponderosa-alerts.yml`. The availability and
backup-age alerts intentionally fire if either probe is absent.

Use disposable external Project destinations for rehearsals; never overwrite a
live root. Restore is journaled across the data directory and external roots.
An interrupted or late-failing multi-root restore removes all roots it
published before a subsequent attempt proceeds.

### Retention of deployment and rehearsal evidence

Use a private evidence directory (mode 0700). The successful command above
removes only its own temporary decrypted/rehearsal tree. A failed run retains
its private tree and incomplete archive for diagnosis; do not classify either
as an expired restore point. Receipts and checksums are small and stay with the
operations evidence. Historical archives without these receipts require a new
verified restore before they count as recovery points.

For routine encrypted restore points, retain the newest three successfully
verified archives and every archive less than seven days old. Before expiring
an older archive, verify its exact checksum, and verify that at least three
newer archives have successful restore receipts and matching checksums. Keep
any archive explicitly pinned for an incident, active test owner, migration or
rollback window regardless of age. Never remove the last verified recovery
point. These are operator-reviewed operations on named archives, not a daemon
sweep over a data directory.

Deployment raw snapshots have a separate purpose: retain them until the
rollout is accepted and its documented rollback window closes (at least seven
days), and a newer encrypted restore point has passed verification. Expanded
restore rehearsals expire once their test owner has finished successfully;
keep their receipt rather than three expanded copies indefinitely. Failed or
active diagnostic/rehearsal trees are protected until their owner releases
them. Record the exact paths, verification receipts and retirement decision
before removing any owned intermediate. Do not apply this policy to live
SQLite/WAL files, provider sessions, user working folders, or managed assets.

Configure a separate-device/host destination for encrypted recovery copies and
verify the transferred archive's checksum before counting that copy. A copy on
the same filesystem protects rollback, not host loss. No existing backup or
live data is pruned merely by deploying this policy.

## Deploy and rollback

1. Confirm the exact source and signed/attested installed artifact qualification.
2. Drain the old daemon and wait until readiness reports zero blockers.
3. Stop it; an offline data-directory lock must be obtainable.
4. Create a pre-migration backup including external Project roots.
5. Rehearse restore into a new disposable destination and compare the manifest.
6. Install the qualified `.deb` while stopped, update `release.env` to its
   exact manifest identity, and start the installed-artifact unit.
7. Require matching revision in both `/api/health` and `/api/ready`.
8. Run authenticated provider probes, then resume leasing.

Never point an older binary at a directory migrated by a newer binary. Rollback
means stopping the new unit, restoring the pre-migration snapshot to a new
path with the retained installed offline CLI, reinstalling the prior exact
`.deb`, updating `release.env`, and retaining the failed directory.

### Bounded fast path for web-only updates

The full procedure above remains mandatory for engine, runtime, schema, storage
or unknown changes. A qualified web-only artifact can use the existing offline
backup tool's narrower scope. This is an application-state preservation snapshot,
**not a portable backup or disaster-recovery restore point**. It retains SQLite
and its WAL cohort, layout identity, canonical journals, managed artifacts,
credentials and other application-owned files. Managed and external working
folders remain at their exact existing physical locations; their identities and
canonical Project/Chat ownership are recorded. Unknown or inconsistent ownership
refuses this fast path. Do not delete or relocate the retained working folders.

First build and qualify the complete candidate while the old daemon is available.
Retain the previous exact installed artifact and environment/systemd configuration.
Then use the qualified candidate's bundled tool to check both installed artifacts:

```sh
candidate_root=/path/to/qualified/Ponderosa
current_root=/path/to/current/Ponderosa
runtime="$candidate_root/runtime/node"
data_tool="$candidate_root/app/server/tools/data-directory.mjs"
"$runtime" "$data_tool" check-web-deployment --data-dir "$PONDEROSA_DATA_DIR" \
  --current-install "$current_root" --candidate-install "$candidate_root"
```

Eligibility checks the actual complete server, launcher and optional desktop
payloads and their dependencies, runtime and schema files, plus the existing
build manifests. Node and both native host images must match their declared
hashes and sizes. Only the web payload and release metadata may differ. A changed
backend tool description also conservatively requires the full path. This first
rung deliberately avoids inventing a second storage-version authority. The first
release introducing these tools or changing startup recovery therefore requires
the full path; later identical-engine web updates can qualify.

Keep the same proxy gate, canonical drain, zero cleanup blockers, observed process
exit and exact configuration checks as the full procedure. After stop:

```sh
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
"$runtime" "$data_tool" backup-web-deployment --data-dir "$PONDEROSA_DATA_DIR" \
  --output "$PONDEROSA_BACKUP_EVIDENCE_DIR/web-deployment-$stamp" \
  --current-install "$current_root" --candidate-install "$candidate_root"
```

The native offline lease excludes a daemon writer. Creation verifies every copied
path/checksum and rechecks retained working-folder identities and installed
payloads before publishing its separate `ponderosa-web-deployment-backup.json`.
Portable `restore` explicitly refuses this scope. Ordinary full backups retain
their complete-coverage and absolute/escaping-symlink refusal rules; an absolute
link inside a preserved working folder is never traversed by the scoped snapshot.
Do not weaken portable validation to make a same-host snapshot look portable.

Start the exact candidate drained, require full readiness and the normal public
API/assets/provider smoke, then resume supported intake. If eligibility or any
creation check fails, do not cut over: use the full path or safely resume the old
daemon. Rollback of a web-only update restores the previous exact code and
configuration **against current compatible data**, preserving every subsequently
accepted write and Decision. Never apply the scoped snapshot over current data.
Keep full encrypted disaster-recovery backups and restore rehearsals under the
existing RPO/RTO policy; this optimization does not replace them.

## Agent workload boundary

A release code update does not replace a stale installed systemd unit. Before
resuming a rollout, compare **effective installed settings**, including drop-ins;
seeing `OOMPolicy=continue` in a source tree is insufficient. Keep the existing
service `User`, paths, credentials, admission/refusal safeguards and stop timeout.

For a system-managed daemon, first qualify the existing aggregate slice, then
install the production child slice and oneshot owner in that service user's manager.
Preserve operator-tuned aggregate settings and drop-ins; do not replace its base
unit with release defaults during this targeted correction. If not configured,
install and qualify the aggregate slice using the deployment README first.
Provider scopes use `PartOf=ponderosa-production-workloads.service`; the system
service's start/stop hooks control that exact user owner. This also cleans up
scopes after a daemon crash without stopping DEV or the shared slice. The owner
is a native systemd lifetime anchor, with no extra process, scheduler or watchdog.

Use the qualified source and preserve any previous boundary drop-in with the
rollout's configuration backup. After proxy gating, drain confirmation, observed
stop and a cold canonical backup, perform this step **while the daemon is stopped**:

```bash
set -euo pipefail
qualified_source=/path/to/qualified/source
workload_unit=ponderosa.service
test "$(systemctl show "$workload_unit" --property=ActiveState --value)" = inactive
workload_user=$(systemctl show "$workload_unit" --property=User --value)
test -n "$workload_user" && test "$workload_user" != root
workload_uid=$(id -u -- "$workload_user")
workload_home=$(getent passwd "$workload_user" | cut -d: -f6)
test -d "$workload_home" && test -S "/run/user/$workload_uid/bus"
test "$(systemd --version | head -1 | awk '{print $2}')" -ge 253
sudo install -d -o "$workload_user" -m 0755 "$workload_home/.config/systemd/user"
for unit in ponderosa-agent-workloads-production.slice ponderosa-production-workloads.service; do
  sudo install -o "$workload_user" -m 0644 "$qualified_source/deploy/$unit" "$workload_home/.config/systemd/user/$unit"
done
sudo -u "$workload_user" env XDG_RUNTIME_DIR="/run/user/$workload_uid" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$workload_uid/bus" systemctl --user daemon-reload
sudo install -d -m 0755 "/etc/systemd/system/$workload_unit.d"
sed "s/@UID@/$workload_uid/g" "$qualified_source/deploy/ponderosa-system-workloads.conf.in" \
  | sudo install -m 0644 /dev/stdin "/etc/systemd/system/$workload_unit.d/50-workload-isolation.conf"
sudo systemctl daemon-reload
test "$(systemctl show "$workload_unit" --property=OOMPolicy --value)" = continue
test "$(systemctl show "$workload_unit" --property=KillMode --value)" = mixed
systemctl show "$workload_unit" --property=ExecStartPre --property=ExecStopPost
```

Compare the effective aggregate `MemoryHigh`/`MemoryMax` before and after; both
must remain finite and unchanged. Verify the effective hooks contain the exact selected owner and numeric UID;
retain existing unrelated hooks. Do not use `%U`, `%h` or `%t` as the target
user's identity in a system-manager unit. Verify the actual daemon environment
at birth matches the selected scope mode, owner, slice and memory budget without
printing credentials. `systemd-run --user` must reach this user's manager. A
rejected scope property must fail the launch; never retry without containment.

Before resume, exercise both providers and inspect each actual scope's
`MemoryHigh`, `MemoryMax`, `MemorySwapMax`, `OOMPolicy`, `PartOf`, `Slice` and
`memory.oom.group`. The provisional Pine policy is 8 GiB hard / no swap per scope,
without an additional per-scope reclaim threshold, beneath the observed 13–18 GiB runaway allocations. The largest
recorded completed scope was 849 MiB across 340 observations; that is not a
promise about every build. Qualify heavy builds and concurrent providers before
changing the host budget. The production child slice inherits the existing
aggregate limit; resource admission and exact process-ledger cleanup remain active.
Never reproduce host-wide OOM on production. Use a uniquely owned, small capped
fixture to prove a scope-local OOM leaves backend health and unrelated work intact.

Orderly application shutdown records verified projection progress through the
existing storage close. Known event, Communication, artifact and Project-recency
writes commit their source receipts with the derived SQLite rows. Healthy
write-active restarts can reuse those views; verified incomplete append suffixes
are repaired before ordinary traffic. The consumed checkpoint also binds exact
source inventory, projection/schema versions and the quiescent database/WAL
cohort. Independently replayed workspace, context and provider journals, host
secrets and physical attachment/browser/working-copy bytes are not history
projection sources; their existing validation and cleanup barriers still run.

Missing/crashed or invalid proof, unknown derived SQL writes, unfinished
creation/deletion, unsupported metadata changes and imports retain full recovery.
A successful stop alone is not a projection certificate. Normal shutdown never
moves full history replay into the stop interval; the explicit full-rebuild
checkpoint option remains for isolated/offline qualification. Measure total
stop-through-ready on a private retained copy, including certification time.
Use a larger **bounded deployment readiness observation** while drained and proxy
gated if necessary; do not bypass admission, shorten the service's 180-second stop
timeout, mint an unverified checkpoint or resume on health alone.
Historical SIGBUS evidence remains a separate investigation.

Rollback restores the backed-up code and exact boundary drop-in while stopped,
then reloads both managers and verifies the restored effective settings. Preserve
newer accepted canonical writes, Decisions and recovery receipts; this change has
no schema migration. Never restore an older database over accepted work merely
to undo a configuration change.

## Failure response

- **Activation outbox dead letter:** do not mark the row processed or delete its
  Activation. Drain and stop the service, preserve an encrypted backup, then
  inspect the exact row with the installed offline CLI:

  ```sh
  install_root=/opt/ponderosa-engine/resources/Ponderosa
  node="$install_root/runtime/node"
  data_tool="$install_root/app/server/tools/data-directory.mjs"
  "$node" "$data_tool" outbox-list --data-dir "$PONDEROSA_DATA_DIR"
  ```

  For a `communication_revision` row, independently reconstruct the intended
  revision from its canonical user Communication and Activation into a private
  mode-0600 JSON file. The target, conversation, and audience must be the
  Activation's own canonical source; another user message is not a valid repair.
  After checking the target and author, requeue only that
  row with its observed Activation ID and exact previous error:

  ```sh
  "$node" "$data_tool" outbox-requeue --data-dir "$PONDEROSA_DATA_DIR" \
    --outbox-id "$OUTBOX_ID" --activation-id "$ACTIVATION_ID" \
    --expected-error "$LAST_ERROR" --payload-file "$CORRECTED_PAYLOAD_FILE" \
    --reason "$OPERATOR_REPAIR_REASON"
  ```

  The previous and replacement payloads are durably recorded in
  `activation_outbox_repair_audit`. Remove the private correction file after
  verification, restart the service, and require the outbox row to settle and
  the blocked Activation to become leaseable. Never automatically revive old
  dead letters merely because their JSON parses.

- **Provider degraded:** drain new leasing, preserve active work, verify the
  provider account independently, inspect provider authority/process metrics,
  and resume only after a successful probe.
- **Disk pressure/WAL growth:** drain, identify retained artifacts and failed
  cleanup receipts, take a backup, and checkpoint only while no writer is live.
- **SSE backpressure:** inspect slow clients and reconnect volume. Ponderosa
  disconnects clients rather than accepting unbounded buffers; clients recover
  through the reset/snapshot protocol.
- **Browser cleanup failure:** do not restart or promote. Keep readiness blocked
  until the broker confirms teardown and no browser authority remains.
- **Migration failure:** do not retry against the partially migrated directory.
  preserve it, restore the verified snapshot to a new path, and run the prior
  exact artifact.
- **Corrupt or incomplete restore:** reject it. Manifest checksum, path, symlink,
  and layout verification are mandatory and fail closed.

Record incident start/end, build revision, request IDs, affected Runs, backup
identity, and recovery decisions. Never paste bearer tokens, proxy headers, or
provider credentials into incident notes.
