# Deploying Ponderosa

Install the service as the normal login user that owns the engine subscriptions:

```sh
pnpm install --frozen-lockfile
pnpm build
sudo cp deploy/ponderosa.service /etc/systemd/system/ponderosa.service
sudo systemctl daemon-reload
sudo systemctl enable --now ponderosa
```

Before installing the unit, update its `User`, `WorkingDirectory`, data directory,
and `PATH` for the host. Reachability is a separate choice; the service does not
depend on Tailscale.

## Required Linux procfs capability

Ponderosa's managed artifacts and workspace-derived generated files require
Linux with a visible, functional `/proc/self/fd`. The daemon uses retained file
descriptors and component-by-component `O_DIRECTORY`/`O_NOFOLLOW` opens to keep
artifact publication and reads inside their owning Project when paths are
renamed or replaced concurrently. There is intentionally no pathname-only or
cross-platform fallback.

On a host, keep procfs mounted normally. In a container, mount procfs and do not
mask or make `/proc/self/fd` inaccessible with the container runtime, a seccomp
profile, or systemd path restrictions. Validate the service user in the same
mount namespace used by Ponderosa:

```sh
exec 9</dev/null
test "$(readlink -f /proc/self/fd/9)" = "/dev/null" || exit 1
```

Ponderosa preflights this capability at startup. When it is absent, liveness
remains available at `/api/health`, but `/api/ready` returns HTTP 503 with
`checks.artifactFilesystem.ok=false`, durable work intake and Run leasing remain
disabled, Trigger sources do not start, and an urgent operational notification
is recorded. Restore procfs visibility and restart the daemon; do not bypass the
check or add an unsafe filesystem fallback.

## Drain provider Runs before an upgrade

Tool schemas and their prompt contract cut over atomically; active provider Runs
are not expected to survive a contract change. Before replacing the daemon,
pause new Run leasing while leaving durable messages, Trigger occurrences, and
other intake available:

```sh
curl -sS -X POST -H "Authorization: Bearer $PONDEROSA_TOKEN" \
  http://127.0.0.1:8787/api/deployment/drain
curl -sS http://127.0.0.1:8787/api/ready
```

The readiness response distinguishes `acceptingDurableIntake` from
`leasingRuns`. Wait until `deploymentDrain.readyForRestart` is true; the
response separately exposes scheduler/local Runs, provider/browser authorities,
pending cleanup, and retained teardown failures so a false zero is visible.
Then replace and restart the service. If the deployment is aborted, explicitly
restore leasing:

```sh
curl -sS -X POST -H "Authorization: Bearer $PONDEROSA_TOKEN" \
  http://127.0.0.1:8787/api/deployment/resume
```

Do not leave a healthy old daemon in the drained state after an aborted deploy.

### Initial upgrade from a daemon without deployment drain

Older daemons cannot expose the drain endpoint retroactively. For that one
upgrade, wait until the old daemon has zero active Runs, stop it, install the new
revision, and start it. Pending durable work remains queued. Provider sessions
without the current persisted tool-contract hash are intentionally reseeded on
first use; do not edit SQLite or clear Agent history manually.

## Enable browser push notifications

After the build, initialize VAPID and restart the service with one command as
the same login user that runs Ponderosa:

```sh
pnpm --filter @ponderosa/server push:configure && sudo systemctl restart ponderosa
```

The command creates `~/.config/ponderosa/push.env` with mode `0600`. The systemd
unit loads that file, while the leading `-` on `EnvironmentFile` keeps Web Push
optional. The private key stays outside the repository and must not be logged or
committed. Its parent directory is forced to mode `0700`; the initializer refuses
to overwrite an existing keypair so reconnects and upgrades cannot silently
invalidate active browser subscriptions.

The default VAPID subject is `mailto:admin@localhost`. To identify a real operator
contact, pass an output path and subject explicitly:

```sh
pnpm --filter @ponderosa/server push:configure -- \
  "$HOME/.config/ponderosa/push.env" "mailto:operator@example.com"
```

Do not replace an existing VAPID keypair while browser subscriptions are active:
subscriptions are bound to its public key. The generator refuses to overwrite the
file for this reason. After restarting, verify configuration without exposing the
private key:

```sh
curl -sS http://127.0.0.1:8787/api/push/status
```

The response should contain `"configured":true`, `"configuration":"active"`,
and the public key. `missing` includes the safe setup command; `invalid` means the
host file is incomplete or contains unusable VAPID material. The browser settings
screen separately reports unsupported browsers, insecure origins, default or
denied permission, subscription failure, and an active device subscription.

## Enable interactive agent browsers

Install Chromium or Google Chrome on the host. Ponderosa checks common system
paths automatically. If the browser lives elsewhere, set its absolute executable
path in the systemd environment:

```ini
Environment=PONDEROSA_BROWSER_EXECUTABLE=/opt/google/chrome/chrome
```

Restart Ponderosa after changing the unit. Each active browser receives a fresh
temporary profile below `PONDEROSA_DATA_DIR`; Ponderosa never reuses the
operator's normal browser profile or stores browser credentials. Keep the
executable choice in host configuration rather than the repository.
