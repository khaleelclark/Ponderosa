# Post-deploy smoke check

Run the CI/release gate before deployment:

```bash
pnpm verify
```

It is hermetic: tests use temporary data directories and mock subscription-backed
adapters, and require no network, engine credentials, or Tailscale.

After deployment, set `BASE_URL` to the server's local or HTTPS origin and check:

- [ ] `systemctl is-active ponderosa` reports `active`.
- [ ] `curl -fsS "$BASE_URL/api/health"` returns `status: ok` (the daemon can answer HTTP).
- [ ] `curl -fsS "$BASE_URL/api/ready"` returns `status: ready`, all four checks are
      `ok`, and at least one configured runtime is authenticated.
- [ ] Open an existing agent URL directly on a phone; refresh and browser Back restore
      the same project/control-room/agent selection.
- [ ] Send a harmless message, confirm live output appears, background/restore the
      browser, and confirm replay catches up without duplicate messages.
- [ ] Queue a second harmless message while the first is active; confirm it starts next.
- [ ] Cancel a run and confirm the agent accepts a subsequent message.
- [ ] Restart the service, then confirm existing chat/task state is present and
      `/api/ready` returns ready again.

`/api/health` is a liveness probe and intentionally does not inspect storage or
runtimes. `/api/ready` is the traffic/work admission probe: it returns HTTP 503
unless the daemon is running, the data directory is readable/writable, projections
are queryable, and at least one configured runtime reports available.
