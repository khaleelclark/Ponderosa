# Ponderosa V1 Roadmap

Status as of 2026-07-11, grounded in `origin/master` at `b5cf519`. “Current” means
present on `master`; a remote branch or open proposal is not treated as shipped.

## Product promise and principles

Ponderosa lets one operator manage subscription-backed coding agents on a trusted
host from a phone. V1 is credible when the operator can express intent, watch
structured work, recover from interruptions, and safely review the result without
opening a laptop.

Principles:

- Subscription authentication only; never provider API keys.
- The event log is canonical; SQLite and UI state are rebuildable views.
- Keep human conversation separate from commands, diffs, tests, and audit data.
- Agents are durable work records backed by ephemeral runtime sessions.
- Mobile-first means the complete critical journey works on a small touch screen,
  including reconnect after lock/background.
- Full host access is deliberate, but network, file-browser, credential, and
  delegation boundaries remain least-privilege.
- Treat reachability as deployment policy: private Tailscale is the V1 default,
  not an application dependency.

Non-goals for V1 are multi-user tenancy, public unauthenticated exposure, a
provider-key billing path, runtime sandboxing, offline agent execution, native
mobile applications, server-side “memory,” automatic merging, and a general
host-file browser.

## Personas and mobile-first journeys

**Primary: solo operator away from a desk.** From a phone, the operator opens an
HTTPS PWA, selects a project and Master Chat, creates an Agent with engine/model
defaults, sends a task, watches status and structured output, follows a delegated
child, reviews artifacts, replies or cancels, and returns after phone lock without
losing events.

**Secondary: host operator.** On the Ubuntu host, the operator installs Node/pnpm
and engine CLIs, authenticates subscriptions as the service user, installs the
systemd unit, checks health/logs, upgrades, backs up and restores the data
directory, and rolls back a bad release.

**Secondary: integration maintainer.** The maintainer isolates each workstream in
a worktree, detects file overlap, merges dependency contracts before consumers,
and leaves rebases/conflict resolution to the designated owner.

## Evidence-based current state

| Area | Current on `master` | Evidence / boundary |
|---|---|---|
| Engines | Codex and Claude CLI adapters, auth checks, model/effort options, seed/resume, cancellation | `packages/engines`; subscription CLI auth only |
| Persistence | Append-only per-thread JSONL, SQLite projections, rebuild function, project/thread/Master Chat storage | `packages/threads`; event log remains canonical |
| Server | Projects, Agents/threads, Master Chats, main/collaboration/individual messages, tasks, artifacts, scoped files, engines, health, SSE replay, cancel | `apps/server/src/app.ts`; switch-engine and search return 501 |
| Orchestration | Durable delegated runs, server-derived lineage, first-class child threads, capability-separated messaging/delegation, FIFO recovery and completion delivery | `apps/server/src/delegations.ts`, `handoffs.ts`, and tests |
| Web/PWA | React/MUI responsive shell, durable routes, install manifest/service worker, Agents and Master Chat views, SSE hooks, delegation tree | `apps/web`; real and mock API clients |
| Deployment | systemd unit, single-origin static serving, CI verification and Pine deployment, Tailscale/HTTPS guidance | `deploy/`, `.github/workflows/ci.yml` |
| Verification | Unit/integration coverage plus a manual vertical-slice checklist | package tests and `VERIFY.md` |

Important gaps: `/api/health` is liveness only (no dependency/readiness probe),
there is no automated backup/restore tool or recorded restore-drill evidence, no
explicit metrics or alert surface, no automated browser E2E suite on `master`, and
V1 auth is optional bearer auth plus a trusted private network—not multi-user
identity.

## Scope

### Must ship for V1

- Preserve and regression-test the current project → Master Chat → Agent → run →
  structured result loop on a real phone and a real subscription login.
- Merge security hardening and reliability/recovery coverage before feature
  expansion; close any release-blocking findings.
- Complete accessible mobile navigation, composer, touch targets, focus/error
  states, lock/unlock reconnect, and PWA install checks.
- Establish operator-tested backup, restore, update, rollback, logs, and readiness
  procedures. Add a true readiness contract before automated rollout relies on it.
- Keep image uploads safe if attachments enter V1: allowlisted raster formats,
  bounded size/count, content-derived type, randomized storage names, project/thread
  authorization, safe rendering, deletion/retention behavior, and backup coverage.
- Make reply references immutable, renderable after reload, accessible, and safe
  when the referenced message is unavailable.
- Make Agent reassignment explicit and auditable. Current storage supports one
  optional `masterChatId`; proposed “multi-master-chat membership” needs a product
  decision and data migration before it can be called V1.

### Should ship after the release gates are green

- Presets for repeated Agent configuration, scoped to non-secret engine/model/
  effort/instruction metadata with edit/delete and fallback behavior.
- Image attachments and reply references, if their security, persistence, mobile,
  and recovery gates pass without delaying the stable core.
- Agent reassignment between Master Chats. Multi-membership is separate scope and
  should not be smuggled into reassignment.
- Readiness/dependency diagnostics and minimal operational counters for active
  runs, run outcomes, SSE reconnects, queue depth, and recovery actions.

### Later / explicitly deferred

- Multiple simultaneous Master Chat memberships (pending semantics for context,
  permissions, display, notification fan-out, and removal).
- Engine switching and historical event search (currently explicit 501 stubs).
- Public exposure with OAuth, multi-user isolation, approval gates, per-thread
  worktrees/sandboxing, rate limits, native mobile, and smart historical context.

## Parallel proposed workstreams

These workstreams are independently reviewable proposals. They become “current”
only after merge to `master` and deployment verification.

| Workstream | V1 disposition | Dependency / acceptance emphasis |
|---|---|---|
| Security hardening | Must, merge first | Auth boundaries, path confinement, capability secrecy, safe errors, audit; branch `agent/v1-security-hardening` |
| Reliability/recovery/E2E | Must, merge second | Restart reconciliation, FIFO/idempotency, SSE replay, cancellation, deterministic integration tests |
| Mobile/accessibility polish | Must, after foundations | Keyboard/focus, labels, target sizes, reduced motion, small viewport and reconnect; branch `agent/v1-mobile-a11y-polish` |
| Reply references | Should | Core event/DTO and projection before API/UI; stable reference with missing-message fallback; branch `agent/v1-message-replies` |
| Image attachments | Conditional must if exposed | Security policy and storage contract before server/UI; backup/restore and malicious-file tests |
| Agent reassignment / membership | Reassignment should; multi-membership later | Decide one-to-one vs many-to-many first; migration, context and routing semantics; branch `agent/v1-agent-membership` |
| Presets | Should | Stable engine option DTOs; no secrets; mobile create flow; branch `agent/v1-agent-presets` |

## Dependency-aware phases and merge order

1. **Release foundations:** security hardening, then reliability/recovery tests.
   Rebase reliability onto the merged security contract if they overlap.
2. **Experience gate:** mobile/accessibility polish, then documentation/operator
   procedures. Run the full vertical slice here; this is the minimum releasable V1.
3. **Conversation data:** reply-reference contract/projection → server → web.
4. **Attachment data:** upload policy/storage → DTO/projection → server → web.
   Rebase onto reply work if both touch message DTOs, events, projectors, or composer.
5. **Topology:** land the product decision, then reassignment schema/store → API →
   UI. Defer many-to-many unless explicitly approved.
6. **Convenience:** presets after topology and engine-option shapes settle.
7. **Integration agent:** rebase each remaining branch, resolve cross-workstream
   contracts, run all gates, deploy in order, and record rollback SHAs.

Within a feature PR, merge order is shared core/event contracts, migrations and
projectors, server routes, web API/hooks, UI, then tests/docs. Never merge a UI
consumer ahead of its durable storage and API semantics.

## Acceptance criteria and definition of done

A V1 capability is done only when:

- Current/proposed/deferred status is accurate in docs and UI language.
- Canonical event/storage behavior survives restart and projection rebuild.
- API contracts are shared through `packages/core`; engine-specific logic stays in
  `packages/engines`; file access cannot escape registered projects.
- Unit/integration tests cover success, malformed input, cancellation, retry,
  idempotency, and recovery proportional to the change.
- `pnpm typecheck`, `pnpm build`, and `pnpm test` pass from a clean install.
- The mobile journey passes over HTTPS with a real CLI subscription, including
  background/lock reconnect and accessible keyboard/screen-reader use.
- Operator docs include install, update, backup, restore, troubleshooting, and
  rollback; commands and paths have been exercised on the target host.
- The PR states dependencies, migration/rollback impact, verification evidence,
  and remaining product decisions. No secrets or raw delegated prompts leak.

## Release gates

| Gate | Required evidence |
|---|---|
| UX/accessibility | 320px-class viewport, touch and hardware keyboard, visible focus, semantic names, error/loading/empty states, contrast and reduced-motion checks, PWA install and lock/unlock recovery |
| Security | Private-network default; bearer auth behavior documented; no provider keys; project path traversal and symlink tests; upload validation if applicable; delegation capability/ownership tests; dependency audit reviewed |
| Reliability/recovery | Restart during run/delivery, queued and unacknowledged recovery, SSE replay/dedupe, cancellation, idempotent retries, projection rebuild, two concurrent Agents, deterministic E2E |
| Performance | Define and meet targets: cached UI usable within 2s on representative phone/Wi-Fi; API p95 under 500ms excluding engine turns; live events visible within 1s p95; no unbounded list/render growth in the tested workload |
| Observability | Structured service logs with request/run/thread correlation without secrets; active/queued/completed/failed counts; recovery and deploy failures visible; operator can diagnose one failed run from logs |
| Backups | Quiesced snapshot of `PONDEROSA_DATA_DIR`, encrypted/off-host retention, restore drill to a clean directory, projection rebuild, engine credentials backed up separately or re-authenticated |
| Deployment | Clean Node 22/pnpm install, frozen lockfile, CI green, systemd restart, liveness and readiness pass, HTTPS route works, prior deploy SHA recorded |
| Documentation | Roadmap/status, operator runbook, architecture/spec links, multi-agent conventions, release notes and known limitations reviewed |

No gate is waived silently. A waiver names the owner, risk, expiry, mitigation,
and rollback trigger.

## Rollout and rollback

Use one operator/host as the canary. Back up data and record the current production
SHA; deploy security/reliability foundations first, observe a real short run, then
enable user-facing features one PR at a time. Validate create/send/stream/cancel,
restart recovery, mobile reconnect, logs, and backup after each migration-bearing
release. Avoid irreversible migrations; preserve event-log readability across one
rollback version.

Rollback when health/readiness fails, starts/runs regress, event or delivery loss
is suspected, security boundaries fail, or mobile recovery becomes unusable. Stop
the service, preserve a forensic copy of the data directory, restore the prior
application SHA and compatible data snapshot if needed, rebuild, restart, and run
the smoke checks in `deploy/README.md`. Never “fix” canonical history by deleting
events or treating SQLite as authoritative.

## Risks and technical debt

- Full host-user execution makes network/auth boundaries high impact.
- Optional app bearer auth is easy to misconfigure; public exposure is not V1-safe.
- A liveness-only health endpoint can report green while engines/data are unusable.
- JSONL, SQLite, delegation, and delivery files need a documented consistency point
  for backups and a recurring restore drill.
- Engine CLI output/auth behavior is an external compatibility dependency.
- Large histories/artifacts may cause projection, SSE replay, and mobile rendering
  growth; retention/pagination limits are not yet explicit.
- Multi-membership could multiply context and notifications and weaken the simple
  ownership model unless designed deliberately.
- Parallel feature branches overlap shared DTOs, projectors, server routes, API
  clients, composer UI, tests, and docs; integration ownership is mandatory.

## Measurable success criteria

Product: at least 95% of ten consecutive phone-started test tasks reach a terminal
state without laptop intervention; 100% of completed runs retain their chat,
task, artifact, and lineage views after restart; the operator can create, monitor,
cancel, and resume work on a 320px viewport; no execution events are dumped into
human Chat except concise summaries/pointers.

Operations: zero provider API-key use; zero known critical/high security findings;
100% CI pass on the release SHA; restore drill meets RPO ≤24h and RTO ≤60m; p95
live-event display ≤1s after server receipt; service restart/recovery completes
within 60s for the representative dataset; every release records deploy and
rollback SHAs.

## Multi-agent development conventions

Use [`MULTI_AGENT_DEVELOPMENT.md`](./MULTI_AGENT_DEVELOPMENT.md). In short: one
isolated worktree and branch per workstream from `origin/master`; declare file and
contract overlap before editing; use dependency branches only when a consumer
cannot compile independently; the feature owner owns rebases; the integration
agent owns final cross-branch conflict resolution and release-gate evidence.
