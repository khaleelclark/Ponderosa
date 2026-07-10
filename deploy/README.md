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

## 6. Updating

```bash
cd /home/khaleel/ponderosa
git pull
pnpm install
pnpm build
sudo systemctl restart ponderosa
```

---

## Notes

- **Docker is deferred** (SPEC §10). The systemd-on-host path needs no container and
  keeps engine host-access simple. Not ruled out for the future product story.
- **Auth (v1):** with Tailscale as the gate, app-level auth is minimal and nothing
  sensitive is stored (SPEC §9). Public exposure (Option B) is a v2 concern gated by
  real OAuth — don't expose the box publicly without it.
