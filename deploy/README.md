# Deploying Ponderosa

For production Linux x64, first install the exact qualified `.deb`, then
install the service as the normal login user that owns the engine subscriptions:

```sh
sudo dpkg --install Ponderosa-<qualified-version>-linux-x64.deb
sudo cp deploy/ponderosa.service /etc/systemd/system/ponderosa.service
sudo systemctl daemon-reload
```

Before installing the unit, update its `User`, data directory, and provider
`PATH` for the host. The unit executes the installed bundled Node and server
from `/opt/ponderosa-engine/resources/Ponderosa`; it must not be pointed at a
source checkout. Write the exact installed release identity before starting it:

```sh
install -d -m 700 ~/.config/ponderosa
printf 'PONDEROSA_BUILD_VERSION=%s\nPONDEROSA_BUILD_SHA=%s\n' "$release" "$commit" \
  >~/.config/ponderosa/release.env.next
mv ~/.config/ponderosa/release.env.next ~/.config/ponderosa/release.env
sudo systemctl enable --now ponderosa
```

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

When TLS terminates at a reverse proxy, set every browser-facing origin
explicitly so Host and Origin validation cannot be widened by an incoming Host
header:

```ini
Environment=PONDEROSA_OPERATOR_ORIGINS=https://ponderosa.example.com
```

The proxy must authenticate the operator and inject the backend bearer token.
Keep the backend loopback-only and deny direct access to it. `/api/health` and
the redacted `/api/ready` are the only unauthenticated probes; detailed readiness
is available at authenticated `/api/diagnostics/ready`.

For an identity-aware front proxy that **cannot** inject the bearer itself,
Ponderosa includes an optional, local Unix-socket bridge at
`apps/server/dist/operator-auth-proxy.js`. This does not add an app sign-in or
send a credential to the browser. The front proxy must overwrite a verified
identity header and connect only to the bridge's mode-0600 socket; the bridge
checks an exact identity allowlist, replaces any browser-supplied Authorization
header with the backend bearer, and forwards to Ponderosa on loopback. The
socket directory must be private to the service user. Do not expose the bridge
on TCP or use a front proxy that merely preserves caller-supplied identity
headers. This pattern is optional: a proxy that authenticates and injects the
bearer itself needs no bridge.

For example, with Tailscale Serve on Linux, use its documented identity header
and Unix-socket target. `tailscale serve` removes caller-supplied identity
headers before setting its own. Keep the exact Tailscale login allowlisted in
both the bridge and Ponderosa, and apply matching tailnet grants. Set the
Ponderosa backend to `127.0.0.1` with a high-entropy
`PONDEROSA_AUTH_TOKEN`, `PONDEROSA_TRUSTED_REVERSE_PROXY=true`, the exact
`PONDEROSA_OPERATOR_ORIGINS`, and `PONDEROSA_OPERATOR_IDENTITIES` as described
above. The bridge may load the same restricted environment file as Ponderosa
for `PONDEROSA_AUTH_TOKEN` and `PONDEROSA_OPERATOR_IDENTITIES`; set only:

```ini
PONDEROSA_PROXY_BACKEND_PORT=8787
PONDEROSA_PROXY_PUBLIC_ORIGIN=https://ponderosa.example.ts.net
PONDEROSA_PROXY_IDENTITY_HEADER=Tailscale-User-Login
```

Alternatively, supply `PONDEROSA_PROXY_BACKEND_TOKEN` and
`PONDEROSA_PROXY_ALLOWED_IDENTITIES` from a separate mode-0600 service file.

Run the bridge with a private socket path (the example
`deploy/ponderosa-operator-auth-proxy.service` uses
`/run/ponderosa-operator-proxy/operator.sock`), then point only the selected
Serve HTTPS port at `unix:/run/ponderosa-operator-proxy/operator.sock`. The
browser's normal bookmark now works after cookie expiration or clearing because
every verified request receives backend authorization server-side. Local
launcher installations need no bridge. Other self-hosted identity proxies can
use their own verified header name; with bearer injection and exact origin
configured, Ponderosa does not require Tailscale.
The bridge restores the configured public Host before forwarding: some Unix
socket front proxies change Host to `localhost`, which otherwise makes
browser-originated writes fail Ponderosa's Host/Origin check. If the front
proxy supplies `X-Forwarded-Host`, it must match the configured public origin.

To require a second exact identity check inside Ponderosa, configure the
trusted reverse-proxy identity allowlist as well as the backend bearer:

```ini
Environment=PONDEROSA_TRUSTED_REVERSE_PROXY=true
Environment=PONDEROSA_OPERATOR_IDENTITIES=operator@example.com
```

The proxy must overwrite (not append or preserve) `Tailscale-User-Login`, and
the configured identities are compared exactly after case normalization.
Current production configuration requires a high-entropy
`PONDEROSA_AUTH_TOKEN` alongside this identity declaration; the identity header
alone is never sufficient. Readiness reports `reverse_proxy` rather than
incorrectly claiming the effective deployment is loopback-only. Apply the least-privilege grant in
`deploy/tailscale-grants.example.hujson` so only the named operator can reach
the published port.

Ponderosa is a **single-operator system**. A proxy, VPN, or shared bearer token
admits the caller as that one operator; it does not create tenant or Project
isolation. Do not grant mutually untrusted users access to the same deployment.

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

## Take and rehearse a pre-migration backup

After the deployment drain reaches `readyForRestart: true`, stop the application
and create an offline, checksummed snapshot before starting a revision that may
run schema migrations:

```sh
sudo systemctl stop ponderosa.service
install_root=/opt/ponderosa-engine/resources/Ponderosa
runtime="$install_root/runtime/node"
data_tool="$install_root/app/server/tools/data-directory.mjs"
# Replace this sample with PONDEROSA_DATA_DIR from the installed system unit.
data_dir=/home/khaleel/.ponderosa
backup_id="$(date -u +%Y%m%dT%H%M%SZ)"
"$runtime" "$data_tool" backup \
  --data-dir "$data_dir" \
  --output "$HOME/.local/state/ponderosa-backups/$backup_id" \
  --external-projects copy
```

The command acquires the same kernel-held data-directory lease as the daemon,
so it refuses to overlap a live writer. It copies SQLite, WAL state, JSONL,
artifacts, host secrets, persistent application state, and every configured
external Project working directory; it fsyncs the snapshot and records file
sizes and SHA-256 checksums. Transient browser sessions are not backed up. The
CLI requires an explicit `copy` or `exclude` policy so an incomplete snapshot
cannot be mistaken for complete coverage.

Rehearse restore to a new, nonexistent path and verify the restored service
before treating a backup as usable:

```sh
"$runtime" "$data_tool" restore \
  --backup "$HOME/.local/state/ponderosa-backups/$backup_id" \
  --data-dir "$HOME/.ponderosa-restore-rehearsal"
```

Restore never overlays an existing data directory and rejects changed or
escaping files. Do not start an older binary against a data directory after a
newer binary has migrated it; restore the pre-migration snapshot to a new path,
switch configuration atomically, and retain the failed directory for diagnosis.
Encrypt backup storage, restrict it to the operator, and set retention/RPO/RTO
according to the deployment. For the single-host private deployment, the
recommended minimum is one snapshot before every migration and a quarterly
restore rehearsal.

For disaster recovery after an external Project root is lost, add
`--restore-external-projects`. Every original destination must be an absent
absolute path; restore never overlays a surviving working directory. Routine
restore rehearsals should omit the flag and verify the included external
checksums without replacing live repositories.

Qualification sandboxes should start with `PONDEROSA_START_DRAINED=1`. Resume
leasing explicitly only for a live Run qualification, drain again immediately
afterward, and stop the sandbox when review is complete. This prevents an old
PR sandbox from silently leasing durable work while it remains reachable.

### Pine development service

Pine's development channel uses the checked-in user unit so a disconnected SSH
scope cannot orphan the daemon:

```sh
mkdir -p ~/.config/systemd/user ~/.config/ponderosa
cp deploy/ponderosa-agent-workloads.slice ~/.config/systemd/user/ponderosa-agent-workloads.slice
cp deploy/ponderosa-browser-dev.service ~/.config/systemd/user/ponderosa-browser-dev.service
cp deploy/ponderosa-dev.service ~/.config/systemd/user/ponderosa-dev.service
printf 'PONDEROSA_BUILD_VERSION=%s\nPONDEROSA_BUILD_SHA=%s\n' "$release" "$commit" \
  >~/.config/ponderosa/dev.env.next
mv ~/.config/ponderosa/dev.env.next ~/.config/ponderosa/dev.env
systemctl --user daemon-reload
systemctl --user enable --now ponderosa-browser-dev.service ponderosa-dev.service
```

Install and reload the Agent slice **before** starting a revision with
`PONDEROSA_AGENT_SCOPE_MODE=systemd`. The dev unit enables this mode: each
provider CLI and its shell/tool descendants enter a separate systemd user
scope under the shared `ponderosa-agent-workloads.slice`. Those scopes have
`PartOf=ponderosa-dev.service`, so a unit stop/restart also stops stranded
work if an Agent's provider root has crashed. The slice's aggregate
`MemoryHigh=50%` and `MemoryMax=60%` leave memory for the app, browser, and
other host services. Adjust those values in a slice drop-in after measuring
the host's normal workload; they are not a per-Agent or security boundary.
`OOMPolicy=continue` also prevents a killed tool from automatically stopping
the app service. An Agent Run can still fail if its workload exceeds the
slice budget, and a host-wide OOM remains possible if unrelated workloads
consume the reserved headroom.

The systemd scope mode is Linux-only and explicit. It requires a working
systemd user manager and `systemd-run` on `PATH`; a missing manager or slice
must be corrected before enabling it. Other Linux installations, macOS, and
Windows retain their existing provider process launch and cleanup behavior.
The checked-in system-level `ponderosa.service` uses `OOMPolicy=continue` but
does not enable user scopes automatically because a system service running as
`User=` is not guaranteed to have a usable user manager. Operators who move
to a user service may install the slice and opt in after qualification.

The deploy operation must still drain the currently running revision and wait
for `deploymentDrain.readyForRestart`. Update the `current` symlink and the
environment file atomically, restart the user unit, then verify `/api/ready`
reports the exact commit. Do not start an additional SSH-owned daemon beside
the unit. If startup verification fails, restore both the previous symlink and
environment file before restarting the unit.

### Resource admission and runtime evidence

Linux admission supplements (not replaces) workspace concurrency, provider
backoff/disable settings and durable cleanup fences. One shared sample reads
bounded kernel counters at most once per two seconds: host `MemAvailable`,
memory/I/O PSI `full avg10`, current cgroup ancestors and the configured Agent
workload slice's ancestors. Finite `memory.high` and `memory.max` headroom are
combined with host headroom; unrelated host demand therefore still counts.
No diagnostic CLI is spawned to obtain resource samples.

Defaults: `PONDEROSA_RESOURCE_RESERVE_MIB=2048` and
`PONDEROSA_RESOURCE_STARTUP_MIB=256`. Both must be positive MiB values
(maximum 1 TiB). A hold begins below reserve plus one startup allowance, at
memory-full PSI 5%, or at I/O-full PSI 10%. Recovery needs two consecutive
samples with at least 125% of that minimum, memory-full PSI at most 1%, and
I/O-full PSI at most 2%. Available startup allowances also bound admission:
each active scheduler claim reserves one allowance *in addition to* measured
usage. This deliberately conservative policy needs calibration for large
builds and hosts with small effective cgroup limits; it is not an OOM guarantee.

Samples have a 500 ms reader budget and are stale after ten seconds. A late
sampler retains its slot until actual settlement. Missing, invalid or stale
measurements explicitly advertise unavailable protection and fail open to
the existing admission safeguards; they cannot strand work permanently.
`PONDEROSA_RESOURCE_ADMISSION=off` explicitly disables this protection. macOS,
Windows and Linux without usable PSI/cgroup observations report unsupported
or unavailable protection; their existing containment remains unchanged.

A confirmed resource hold keeps accepted Activations pending, without failed
delivery attempts or cancellation of existing Runs. The scheduler resumes
automatically after recovery. A second check can defer an uninjected claim if
pressure develops during preparation. Unknown startup failures keep their
existing uncertainty/retry authority; they are not relabeled as pressure.

Systemd provider scopes now have random exact unit and ownership identities,
persisted in the existing process ledger. Scope population is observed even
after the launcher exits. Cleanup checks ownership, stops only that scope and
awaits its empty cgroup; failures retain durable authority. Persistent sessions
and shared browser ownership are not made Run-scoped. Scope observations are
asynchronous, coalesced and serialized; status reads retain unknown authority
rather than block the event loop or invent completed cleanup. Each systemctl
observation has a 500 ms/8 KiB bound. A scope stop has a two-second systemd grace
and four-second observation budget. Non-systemd POSIX installations cannot
prove ownership of descendants that deliberately escape their process group;
Ponderosa does not kill guessed processes in that case.

`PONDEROSA_AGENT_WORKLOAD_SLICE` can override the default workload slice for
an explicitly isolated qualification environment or operator configuration.
It is host-owned, stripped from provider tool environments, and does not grant
a security sandbox. Never point a qualification at live application units.

Provider status separates authentication, reachability and resource holds.
Probe timeout, spawn, malformed-output and cleanup failures mean "could not
verify," not logout. A completed explicit CLI logout remains unauthenticated.
Authentication reasons, source and observation time appear in status details;
raw provider output is not displayed. A successful older operation cannot
erase a newer access denial or enable an operator-disabled provider. Rechecks
share their actual diagnostic/cleanup slot even after an HTTP deadline.

Canonical provider-status changes and ordinary stream reconnect refresh engine
status promptly, bounded to one refresh per five seconds. Tool events do not
refresh authentication. Active execution is shown as "working"; focus/hover
details show the age of meaningful execution evidence. Heartbeats, timers and
polls do not update that age, quiet output is not failure, and neither public
progress nor a running session grants completion/authentication authority.
Existing stale usage, delivery receipts and uncertain-submission recovery
remain authoritative.

The browser supervisor is a separate user unit so a shared Project browser can
survive an application restart. The application waits for its owner-only Unix
socket before starting. Do not restart the browser supervisor during an ordinary
application-only deployment. When a release changes the browser-service protocol
or implementation, first explicitly close all shared Project browsers, verify
the drain reports zero browser authorities, update `current`, restart
`ponderosa-browser-dev.service`, and only then restart `ponderosa-dev.service`.
This ordering prevents a new application from talking to a stale broker without
silently discarding open tabs or unsaved forms.

### Initial upgrade from a daemon without deployment drain

Older daemons cannot expose the drain endpoint retroactively. For that one
upgrade, wait until the old daemon has zero active Runs, stop it, install the new
revision, and start it. Pending durable work remains queued. Provider sessions
without the current persisted tool-contract hash are intentionally reseeded on
first use; do not edit SQLite or clear Agent history manually.

## Browser push notifications

On first startup, Ponderosa creates a stable VAPID keypair under
`$PONDEROSA_DATA_DIR/host-secrets/`. The directory and identity are protected with
owner-only permissions on POSIX hosts. Creation is atomic and refuses replacement,
so concurrent starts, reconnects, and upgrades cannot rotate the public key or
invalidate active browser subscriptions. The private key is never exposed by an
API and must not be logged, copied into the repository, or edited.

Existing installations may continue supplying both `PONDEROSA_VAPID_PUBLIC_KEY`
and `PONDEROSA_VAPID_PRIVATE_KEY` through the optional systemd environment file.
Explicit environment keys take precedence and are never replaced. An incomplete
or invalid override fails closed instead of silently generating a different
identity. The automatic contact subject is a stable public project-owner URL so
Apple Push receives a valid HTTPS identity rather than a rejected localhost
address. `PONDEROSA_VAPID_SUBJECT` remains an optional runtime contact override.
It is validated before key generation and is not persisted with the keypair, so
correcting or removing a bad subject recovers on restart without rotating keys.

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

Restart Ponderosa after changing the unit. By default, each exact-Run execution
browser receives a fresh disposable profile below
`PONDEROSA_DATA_DIR/browser-sessions`, removed when the session closes. An
operator can instead create a Project-owned trusted profile below
`PONDEROSA_DATA_DIR/browser-profiles` and assign it to an Agent; that profile
intentionally retains cookies, login state, and site storage until the operator
deletes it, and only one browser leases it at a time. Neither mode reuses the
operator's normal browser profile. Keep the executable choice in host
configuration rather than the repository.
