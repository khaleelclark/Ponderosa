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
