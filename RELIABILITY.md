# V1 reliability safety net

The automated safety net is deterministic and offline. Server tests use isolated
temporary event logs/projections and mock adapters; controlled runs advance through
promises and abort signals rather than wall-clock sleeps. SSE tests use sequence
cursors and persisted log replay. No test requires a provider login, network,
Tailscale, or subscription credentials.

## Scenario map

| V1 behavior | Automated coverage |
| --- | --- |
| Create project, master chat, and agent; stream output; queue a second turn; cancel and drain | `apps/server/test/reliability.e2e.test.ts` |
| Collaboration mention delivery, FIFO while busy, cancelled-delivery retry, request idempotency | `apps/server/test/app.test.ts` collaboration delivery cases |
| Delegated child lifecycle, terminal completion delivery, branch cancellation | `apps/server/test/app.test.ts` delegation and completion cases |
| SSE disconnect/reconnect and replay without duplicates | server `streams live SSE...` and web `threadStream.test.ts` |
| Restart recovery of queued/delivered inbox state and delegated state | server restart recovery/reconciliation cases |
| Duplicate delegation, agent-message, and cancellation requests | server idempotency cases |
| Mobile-critical durable project/control-room/agent navigation | `apps/web/test/routing.test.ts` |
| Health versus readiness admission contract | server `separates daemon liveness...` |

The focused safety-net test demonstrates the cancellation/queue boundary: a first
runtime is held at an explicit gate, a second turn is durably queued, cancellation
is observed through its `AbortSignal`, and the queued continuation is started via a
promise latch. This avoids timing assumptions while proving the recovery behavior.

## Health and readiness contract

- `GET /api/health` is unauthenticated liveness. HTTP 200 means the daemon request
  loop is answering; it deliberately remains independent of storage and runtimes.
- `GET /api/ready` is unauthenticated readiness for deploy/load-balancer probes.
  HTTP 200 means work may be accepted. HTTP 503 includes per-check diagnostics when
  the data directory is not readable/writable, projections cannot be queried, or no
  configured runtime is available. Runtime details never contain credentials.

Run `pnpm verify` for the full typecheck, test, and production build gate. See
`deploy/POST_DEPLOY.md` for the short operator smoke pass.
