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

Ponderosa requires both the exact `Tailscale-User-Login` identity inserted by
the loopback Tailscale proxy and the backend bearer (or the secure browser
session obtained by opening `/__ponderosa_bootstrap#TOKEN`). An identity header
alone never grants authority, including on loopback. Restrict the Serve port to
the same identities with tailnet grants; the application allowlist is defense
in depth, not a substitute for tailnet policy. Production origins must be HTTPS.
When Serve cannot inject a backend bearer, use the private Unix-socket
identity bridge documented in `deploy/README.md`; do not rely on expiring
browser cookies for a bookmarked hosted deployment.

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
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
encrypted_tmp=""
trap 'rm -rf -- "$work"; test -z "$encrypted_tmp" || rm -f -- "$encrypted_tmp"' EXIT
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
  mode-0600 JSON file. After checking the target and author, requeue only that
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
