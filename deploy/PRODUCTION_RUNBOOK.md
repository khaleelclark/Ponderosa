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
fails closed on absence or mismatch. Do not run the production unit from a
source checkout, macOS package, or Windows package.

## Timed encrypted restore rehearsal

Run this before each migration and at least quarterly against the currently
installed exact artifact. The daemon must be stopped so the data-directory
lease is authoritative. Keep the terminal transcript and the encrypted archive
in the restricted operations evidence store; never commit either artifact.

```bash
set -euo pipefail
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
started="$(date +%s)"
node packages/agents/tools/data-directory.mjs backup \
  --data-dir "$PONDEROSA_DATA_DIR" \
  --output "$work/snapshot" \
  --external-projects copy
tar -C "$work" -czf - snapshot | age -r "$PONDEROSA_BACKUP_AGE_RECIPIENT" \
  > "$PONDEROSA_BACKUP_EVIDENCE_DIR/ponderosa-$stamp.tar.gz.age"
rm -rf "$work/snapshot"
age -d -i "$PONDEROSA_BACKUP_AGE_IDENTITY" \
  "$PONDEROSA_BACKUP_EVIDENCE_DIR/ponderosa-$stamp.tar.gz.age" \
  | tar -C "$work" -xzf -
node packages/agents/tools/data-directory.mjs restore \
  --backup "$work/snapshot" \
  --data-dir "$work/restored" \
  --restore-external-projects \
  --external-project-root "$work/external-projects"
elapsed="$(( $(date +%s) - started ))"
test "$elapsed" -lt 1800
printf 'revision=%s started=%s elapsed_seconds=%s\n' \
  "$PONDEROSA_BUILD_SHA" "$stamp" "$elapsed" \
  > "$PONDEROSA_BACKUP_EVIDENCE_DIR/ponderosa-$stamp.txt"
rm -rf "$work"
```

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
6. Atomically switch the release symlink and start the new unit.
7. Require matching revision in both `/api/health` and `/api/ready`.
8. Run authenticated provider probes, then resume leasing.

Never point an older binary at a directory migrated by a newer binary. Rollback
means stopping the new binary, restoring the pre-migration snapshot to a new
path, atomically switching configuration, and retaining the failed directory.

## Failure response

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
