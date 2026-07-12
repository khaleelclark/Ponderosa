# Deploying Ponderosa

Zero → running service on a fresh Ubuntu Server box. Ponderosa is **network-agnostic**:
it just serves HTTP. How you reach it from your phone is a deployment choice, not
part of the architecture (SPEC §10, AGENTS.md invariant 7). Tailscale is the easy v1
default documented here, but **nothing requires it** — any HTTPS-fronting method works.

---

## 1. Prerequisites (on the box)

Install **Node 22 LTS** and pnpm. (Use 20 or 22 — **not** Node 26+: the SQLite
native module `better-sqlite3` has no prebuilt binary for it yet and its source
build fails against current V8 headers. 22 LTS is what this project is validated on
and ships prebuilt binaries for Linux x64/arm64, so no compiler is needed.)

```bash
# Node 22 LTS (nodesource, or your preferred method)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version                  # should be v22.x
sudo corepack enable            # provides pnpm (pinned to 11.x via packageManager)
pnpm --version
```

Install the **engine CLIs** and log in **as the service user** — subscription auth
is what makes Ponderosa cheap (SPEC §9, AGENTS.md invariant 1; never an API key):

```bash
# Codex (ChatGPT subscription)
npm install -g @openai/codex     # or the documented Codex install method
codex login                      # browser OAuth → token under ~/.codex
codex login status               # should print: Logged in using ChatGPT

# Claude (Claude Pro/Max subscription) — the second engine
npm install -g @anthropic-ai/claude-code   # provides the `claude` CLI
claude                           # run once, use /login to sign in to Pro/Max
                                 # → OAuth account stored in ~/.claude.json
# Do NOT set ANTHROPIC_API_KEY — that would route Claude to billed API auth.
```

> Both tokens live under the **same user** the service runs as (`~/.codex`,
> `~/.claude*`). Keep them off any image and out of git (already gitignored).
> Only the engine(s) you actually log into need to work — the other just shows
> "not signed in" in the UI.

## 2. Clone & build

```bash
cd /home/khaleel
git clone <your-ponderosa-remote> ponderosa
cd ponderosa
pnpm install
pnpm build            # builds all packages + apps/web static bundle + server
```

`pnpm build` runs `pnpm -r build`: it compiles `packages/*` and `apps/server`, and
produces the `apps/web` static bundle that the server serves from the same origin
(SPEC §10 — single origin, no CORS).

## 3. Data directory

Ponderosa stores everything (event logs + SQLite projections) under
`PONDEROSA_DATA_DIR`. Default: `~/.ponderosa`. This whole dir is your backup unit
(SPEC §7). Create it (or let the server create it on first run):

```bash
mkdir -p /home/khaleel/.ponderosa
```

Set ownership and permissions so only the service user can read canonical history:

```bash
sudo chown -R khaleel:khaleel /home/khaleel/.ponderosa
chmod 700 /home/khaleel/.ponderosa
```

During the communication-infrastructure migration, four restart-scoped rollout
controls are available:

- `PONDEROSA_COMMUNICATION_MODE=off` keeps legacy chat/audit writes active and
  disables canonical communication shadow writes.
- `PONDEROSA_COMMUNICATION_READ_MODE=legacy|shadow|authoritative` controls room
  timeline reads independently. `authoritative` makes readiness fail closed if
  reconciliation finds an unlinked legacy row, incomplete projection metadata,
  or DTO parity drift; revert to `shadow` for an immediate read rollback.
- `PONDEROSA_LEGACY_ROUTING=reject` (the default) disables mention-parsed
  Collaboration and the old agent `channel` wire. Set `accept` only for a
  time-bounded rollback cohort whose existing sessions have not rolled over.
- `PONDEROSA_CURATED_CONTEXT=off` disables promoted-summary injection while
  leaving communication capture unchanged.

Capture and reads default to `shadow`, legacy routing defaults to rejected, and
curated context defaults on. Verify the effective state
in `/api/ready` before expanding a rollout cohort.
Authoritative reads cannot be combined with `PONDEROSA_COMMUNICATION_MODE=off`;
the configuration loader rejects that pairing and readiness also fails closed for
programmatic embedders that bypass environment loading.

Before selecting authoritative reads, call the project communication-backfill
endpoint with `{ "dryRun": true }`. Apply only after every blocked historical
Collaboration row has an operator-supplied `collaborationRecipientsByMessageId`
mapping. Re-run reconciliation and require HTTP 200; HTTP 409 or not-ready status
is a cutover stop. Backfill is deterministic and safe to retry after interruption.

## 4. Install the systemd service

```bash
sudo cp deploy/ponderosa.service /etc/systemd/system/ponderosa.service
sudoedit /etc/systemd/system/ponderosa.service   # set User=, WorkingDirectory=,
                                                 # PONDEROSA_DATA_DIR to match host
sudo systemctl daemon-reload
sudo systemctl enable --now ponderosa
systemctl status ponderosa                        # active (running)?
curl -s http://127.0.0.1:8787/api/health          # {"status":"ok",...}
```

`/api/health` is currently a **liveness** check only. It does not prove the data
directory is writable or an engine is authenticated. Until a distinct readiness
endpoint ships, use this operator readiness check:

```bash
test -w /home/khaleel/.ponderosa
curl -fsS http://127.0.0.1:8787/api/engines
sudo -u khaleel codex login status
```

If `PONDEROSA_AUTH_TOKEN` is configured, all API calls except `/api/health` need
`Authorization: Bearer $PONDEROSA_AUTH_TOKEN`. V1 otherwise assumes a single
operator behind a private network gate. Do not expose an unauthenticated install
to the public internet. Engine authentication is separate and must be performed
as the systemd `User=`; never set provider API keys.

Logs: `journalctl -u ponderosa -f`. The unit runs as your login user (not root) so
spawned engines inherit your access and subscription tokens (SPEC §11). It restarts
on failure.

> **If runs fail with "failed to spawn codex"/"failed to spawn claude":** the
> service can't find the engine binary on its `PATH`. systemd's default PATH is
> minimal and excludes npm-global / nvm / fnm bin dirs. Check where they resolve
> for the service user (`sudo -u khaleel which codex claude`) and add that dir to
> the `Environment=PATH=…` line in the unit, then `daemon-reload` + `restart`.
> A quick sanity check that the engines work under the service account:
> `sudo -u khaleel bash -lc 'cd /home/khaleel/ponderosa && pnpm engines:try --cwd . "say hello and stop"'`

## 5. Reach it from your phone

You need HTTPS for the PWA (service worker + install prompt). Pick **one** — the app
doesn't care which:

### Option A (v1 default): Tailscale + Tailscale Serve

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Front the local server with HTTPS on your tailnet:
sudo tailscale serve --bg 8787
# → https://<host>.<tailnet>.ts.net  (reachable from any device on your tailnet,
#   including cellular in bed)
```

Any device with Tailscale on your tailnet now reaches the box from anywhere. This is
a **convenience, not a requirement** — see Option B.

### Option B (productization path): public domain / Cloudflare Tunnel

Front the same `http://127.0.0.1:8787` with a real HTTPS domain — e.g. a Cloudflare
Tunnel, or a reverse proxy (Caddy/nginx) terminating TLS for a domain you own. The
secure context (HTTPS) then comes from the domain instead of Tailscale Serve. Pair
this with the v2 OAuth auth (SPEC §9) before exposing publicly.

> **Do not** build anything that only works over Tailscale. If you later move to a
> public domain, only this step changes — the app is unchanged.

For any public HTTPS front end, require `PONDEROSA_AUTH_TOKEN`, restrict origin
access at the proxy/tunnel, and apply its access-control product. This bearer token
is still single-operator protection, not the deferred multi-user OAuth design.

## 6. Updating

```bash
cd /home/khaleel/ponderosa
git fetch origin master
git checkout master
git pull --ff-only origin master
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart ponderosa
curl -fsS http://127.0.0.1:8787/api/health
```

Record the pre-update revision first: `git rev-parse HEAD`. Back up the data
directory before any release that changes persistence.

## 7. Backup and restore

The canonical backup unit is the entire `PONDEROSA_DATA_DIR`, not SQLite alone.
Engine login directories are credentials and are deliberately separate; normally
re-authenticate them instead of placing them in the application backup.

For a consistent snapshot, briefly stop writes:

```bash
sudo systemctl stop ponderosa
sudo tar --xattrs --acls -C /home/khaleel -czf /secure/off-host/ponderosa-$(date -u +%Y%m%dT%H%M%SZ).tar.gz .ponderosa
sudo systemctl start ponderosa
curl -fsS http://127.0.0.1:8787/api/health
```

Encrypt backups, copy them off-host, define retention, and test restores. Restore
to a new directory first so the existing data remains recoverable:

```bash
sudo systemctl stop ponderosa
sudo mkdir -p /home/khaleel/.ponderosa-restore
sudo tar -xzf /secure/off-host/ponderosa-YYYYMMDDTHHMMSSZ.tar.gz -C /home/khaleel/.ponderosa-restore --strip-components=1
sudo chown -R khaleel:khaleel /home/khaleel/.ponderosa-restore
```

Point a temporary service/process at `.ponderosa-restore`, start it on a different
port, and verify projects, threads, messages, artifacts, delegation lineage, and a
projection rebuild. Only then replace the active directory while the service is
stopped. Never restore only `ponderosa.sqlite` or delete canonical JSONL to repair
a projection.

## 8. Logs and troubleshooting

```bash
journalctl -u ponderosa --since '30 minutes ago' --no-pager
journalctl -u ponderosa -f
systemctl status ponderosa --no-pager
ss -ltnp | grep ':8787'
curl -v http://127.0.0.1:8787/api/health
```

- **401 from API:** provide the configured bearer token; health intentionally
  remains unauthenticated.
- **Engine unavailable:** check `/api/engines`, CLI location on systemd `PATH`,
  login as the service user, and ensure provider API-key variables are absent.
- **Service restart loop:** inspect the journal, verify Node 22, rebuild, and check
  data-directory ownership/free space.
- **Phone cannot connect:** prove loopback health first, then inspect Tailscale
  Serve or the HTTPS proxy. A PWA requires a secure HTTPS context.
- **Missing/stale views:** preserve the data directory and investigate projection
  rebuild; the event logs are authoritative.
- **Run stuck:** use the UI/API cancel action, inspect correlated service logs,
  and restart only after preserving evidence if cancellation fails.

## 9. Rollback

Keep the previous application SHA and a compatible pre-update data snapshot.

```bash
sudo systemctl stop ponderosa
cd /home/khaleel/ponderosa
git fetch origin
git checkout --detach PREVIOUS_GOOD_SHA
pnpm install --frozen-lockfile
pnpm build
sudo systemctl start ponderosa
curl -fsS http://127.0.0.1:8787/api/health
```

If the release changed persisted formats incompatibly, preserve the failed data
directory and restore the matching snapshot before starting the old binary. After
the smoke check, validate `/api/engines`, open an existing Agent, run a safe short
turn, and confirm SSE reconnect. Return the production checkout to `master` only
after the regression is fixed and reviewed.

---

## Notes

- **Docker is deferred** (SPEC §10). The systemd-on-host path needs no container and
  keeps engine host-access simple. Not ruled out for the future product story.
- **Auth (v1):** use a private network gate and configure the optional bearer token.
  Public multi-user exposure remains deferred to real OAuth (SPEC §9).
