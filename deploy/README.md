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
and `PATH` for the host.

## Choose the network boundary explicitly

Ponderosa defaults to `127.0.0.1:8787`. This is the recommended direct-host and
authenticated-reverse-proxy boundary. A non-loopback listener fails startup
unless one of these protections is configured:

- Set `PONDEROSA_AUTH_TOKEN` to require `Authorization: Bearer …` on operator API
  and application requests. Browser clients cannot safely store this shared
  secret; use an authenticated reverse proxy that injects it, or use the token
  only with a non-browser client. Never put it in SPA code or `localStorage`.
- For an intentionally passwordless tailnet deployment, set
  `PONDEROSA_TRUSTED_TAILNET=true` and bind `PONDEROSA_HOST` to one literal
  Tailscale IPv4 address in `100.64.0.0/10` or IPv6 address in
  `fd7a:115c:a1e0::/48`:

  ```ini
  Environment=PONDEROSA_HOST=100.100.101.102
  Environment=PONDEROSA_TRUSTED_TAILNET=true
  ```

  Wildcard, DNS, ordinary LAN, and public addresses are rejected in this mode.
  Every tailnet peer allowed to reach that address has full operator access,
  including the ability to start host-authority Agents. Enforce Tailscale ACLs
  accordingly.

`GET /api/ready` reports the active `networkSecurity` posture without exposing
credentials. The provider-status dialog shows the same posture and highlights
the trusted-tailnet operator-access warning.

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

## Browser push notifications

On first startup, Ponderosa creates a stable VAPID identity under
`$PONDEROSA_DATA_DIR/host-secrets/`. The directory and identity are protected with
owner-only permissions on POSIX hosts. Creation is atomic and refuses replacement,
so concurrent starts, reconnects, and upgrades cannot rotate the public key or
invalidate active browser subscriptions. The private key is never exposed by an
API and must not be logged, copied into the repository, or edited.

Existing installations may continue supplying both `PONDEROSA_VAPID_PUBLIC_KEY`
and `PONDEROSA_VAPID_PRIVATE_KEY` through the optional systemd environment file.
Explicit environment keys take precedence and are never replaced. An incomplete
or invalid override fails closed instead of silently generating a different
identity. `PONDEROSA_VAPID_SUBJECT` remains an optional contact override.

After startup, verify configuration without exposing the private key:

```sh
curl -sS http://127.0.0.1:8787/api/push/status
```

The response should contain `"configured":true`, `"configuration":"active"`,
and the public key. `invalid` means automatic identity generation/storage failed
or an operator override is incomplete or unusable. The browser settings screen
separately reports unsupported browsers, insecure origins, default or denied
permission, subscription failure, and an active device subscription.

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
