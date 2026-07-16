# Ponderosa Design Record

**Status:** Current architecture map and cross-cutting decision record. This is
not a feature-status ledger or a replacement for the domain contracts linked
below. Update it when a change creates a new system boundary or changes one of
the mapped authorities.

## 1. Authority and conflict resolution

Ponderosa deliberately separates design authority by concern:

| Concern | Authority |
| --- | --- |
| Product direction and interaction model | [VISION.md](./VISION.md) |
| Repository, architecture, security, and collaboration invariants | [AGENTS.md](./AGENTS.md) |
| Canonical names | [VOCABULARY.md](./VOCABULARY.md) |
| Communication scope and routing matrix | [COMMUNICATION.md](./COMMUNICATION.md) and `deriveCommunicationBehavior` in `packages/core/src/communication.ts` |
| Requests, joins, activations, runs, leases, fencing, and recovery | [COMMUNICATION_V3.md](./COMMUNICATION_V3.md) and the reducer in `packages/core/src/coordination-v3.ts` |
| Cross-cutting boundaries and architectural exceptions | This file |

The current authority for a concern wins over historical documentation and
implementation accidents. A product-direction change must update `VISION.md`; a
repository invariant must update `AGENTS.md`; a communication or scheduling
change must update its domain contract and executable contract. This record
must be updated in the same change when a new transport, trust, persistence, or
host-capability boundary is introduced.

## 2. Restoration and migration history

The original `SPEC.md` was a 960-line living roadmap. Its last version is
available at
`2027b8afb76a6e984b37e9d3aa64e8c546ed720a^:SPEC.md`. Commit
`2027b8afb76a6e984b37e9d3aa64e8c546ed720a` (`chore: remove markdown
documentation`, 2026-07-12) deleted it together with fifteen other Markdown
files. That commit supplied no design replacement and no architectural
rationale beyond its subject, so the deletion itself is not treated as a design
decision.

The repository then established replacement authorities rather than continuing
the legacy roadmap:

- `VISION.md` was introduced by `d6a1c6789050224e139894013b59ae88eab16386`
  and `AGENTS.md` was aligned to it by
  `f4360c8de16aa49e3351a5c1df80909ea2cfafc6`.
- The current vocabulary and executable communication model followed in
  `7eae2055fd4587f2b7353d4487ce6574f75546a5` and
  `5e497573d7391315520aea7d698ae6e77064f40d`.
- `COMMUNICATION_V3.md` now defines authoritative SQLite scheduling state and
  explicitly supersedes the earlier all-JSONL/projection-only assumption.

Restoring the old file verbatim would therefore reinstate contradictions. In
particular, it described Projects as top tabs, Agents as renamed Threads,
Master Chats and textual `@mentions` as routing concepts, all SQLite data as
rebuildable projections, and runtime `text` as Chat content. The current model
uses Project chat plus stable Agent identities, structured recipient IDs,
domain-specific persistence authority, and execution-scoped Work log output.
The old roadmap also linked documents deleted in the same bulk-removal commit.

This file is the migration/restoration of the design record: it preserves the
still-valid architectural decisions, points each evolving domain at its current
authority, records why stale legacy text is not silently revived, and carries
new cross-cutting decisions forward.

### Preserved decisions from the legacy record

- Ponderosa orchestrates already-authenticated, subscription-backed engine
  runtimes; it never calls providers with user API keys.
- Runtime-specific behavior remains behind `packages/engines` adapters and is
  normalized into shared `packages/core` contracts.
- The React/TypeScript/MUI PWA is a thin client served by a long-lived Fastify
  daemon. There is no SSR.
- Agents intentionally execute as the host user. Public file-browsing remains
  scoped to registered projects and must not become arbitrary host access.
- Conversation stays separate from commands, tool output, diffs, tests, and
  other execution telemetry.
- REST is the mutation protocol, SSE is the ordinary live-event protocol, and
  reachability is deployment-agnostic.
- Provider credentials, operator credentials, OAuth state, and deployment
  secrets stay outside repositories and generated artifacts.

## 3. Current architecture baseline

### 3.1 Product and execution model

A Project owns Project chats, Agents, canonical communication, workspace state,
and execution history. There is one kind of Agent; a subagent is an ordinary
Agent with a direct `managerAgentId`. Stable IDs, not display names or rendered
labels, define ownership and routing. Runtime sessions and OS processes are
ephemeral implementation details; a Run is scheduler-owned execution, and an
Activation is the durable reason it may execute.

The default Project-chat experience stays approachable. Power-user surfaces
expose Agent chat, Work log, Activity, Changed Files, Review, Runs, and Files &
results without pushing those details into the Project conversation.

### 3.2 Canonical state by domain

| Domain | Canonical authority | Derived or cached views |
| --- | --- | --- |
| Authored communication and execution telemetry | Append-only event logs | Project, Team, and Agent chat projections; activity and artifact views |
| Communication V3 coordination and scheduling | Transactional SQLite | Status/read models and rich JSONL telemetry |
| Project/user workspace state | Append-only workspace/user logs | SQLite and browser projections/preferences as defined by `VISION.md` |
| Source code and durable project knowledge | Registered host repository | Review, file-browser, and artifact previews |

SQLite is therefore neither globally canonical nor globally disposable. Its
authority is domain-specific. Never create a second conversation or diff store
to compensate for a projection bug, and never attempt to rebuild V3 scheduler
truth from JSONL telemetry.

### 3.3 Communication and context

Every communication has one immutable scope: Broadcast, Direct Message, or
Collaboration. Only Broadcasts become shared organizational knowledge. Agent
runtime output is execution data, not a fourth communication scope. Public chat
views project the same canonical Communication rather than copying it into room-
specific message stores.

Fresh runtimes receive only the context allowed by the current communication
contracts plus repository instructions from their working directory. Persistent
provider sessions may resume within their durable causal scope. The server does
not resend indiscriminate chat, audit, or tool history on every turn and does not
build a parallel Ponderosa memory store.

### 3.4 Runtime and network boundaries

Engine-specific parsing, model discovery, capabilities, and session mechanics
are normalized in `packages/engines`. Shared API and stream DTOs live in
`packages/core` and are consumed by both server and web.

The Fastify daemon is the host boundary. Ordinary client mutations use
authenticated REST and live delivery uses authenticated, replayable SSE. Static
PWA assets and scoped preview HTTP responses share the server listener. A feature
must not add another listener, general proxy, browser-control API, or unrestricted
filesystem/network surface merely because agents themselves have host access.

## 4. Transport decision: localhost preview development connections

**Decision ID:** ADR-001

**Status:** Accepted for the active-run-scoped localhost preview capability

**Introduced by:** `feat/localhost-preview-dev-connections`, stacked on
`feat/link-previews-localhost`

### 4.1 Context and reason for the exception

Ponderosa can expose an Agent-owned loopback HTTP development server through an
opaque preview registration. Ordinary pages, assets, redirects, and server-sent
events work over the authenticated HTTP preview route. Vite hot-module
replacement adds a full-duplex exchange: both browser and dev server must send
independent WebSocket frames over one long-lived connection.

REST is request/response and cannot carry that exchange. SSE is deliberately
one-way from server to client. A streamed HTTP response is also one-way after
the request body finishes. None can provide Vite's bidirectional HMR protocol,
so a narrowly scoped WebSocket upgrade is justified. This does not replace REST
or SSE elsewhere.

### 4.2 Capability and ownership model

An authenticated `POST /api/link-previews` creates an in-memory, opaque
registration only after validating:

- the exact Project and Agent exist and the Agent belongs to the Project;
- the Agent owns the authoritative active Run and fencing lease;
- `runId` is that Run's execution identity;
- an optional conversation belongs to the Project and includes the Agent; and
- the supplied URL is uncredentialed HTTP on an explicit `localhost`,
  `127.0.0.1`, or `::1` port.

The server normalizes the destination to
`http://127.0.0.1:<registered-port>`, removes the fragment, assigns an opaque
UUID, and gives the registration a bounded expiry. The registration stores the
Project, Agent, Run/execution, optional conversation, exact normalized origin,
and expiry. It is not persisted or recoverable after server restart.

HTTP remains at `/api/link-previews/:registrationId/*`. WebSocket upgrades exist
only below `/api/link-previews/:registrationId/__ws/*`. A normal HTTP request to
that reserved path receives `426 Upgrade Required`; an upgrade outside that
namespace is ignored by this handler.

Upgrades do not traverse Fastify request hooks, and browser WebSocket APIs cannot
attach Ponderosa bearer headers. The server therefore independently validates
the opaque registration, the native WebSocket handshake, and `Origin: null` from
the sandboxed preview document. Knowledge of a registration ID alone is not
sufficient from an ordinary authenticated-origin page.

Ownership is revalidated before upgrade, on every application frame, and during
the connection heartbeat. The socket is closed when any stored identity or
ownership relationship stops matching.

### 4.3 Exact routing and input validation

The client may choose only a bounded relative WebSocket path and, for Vite, zero
or one bounded `token` query parameter. It must supply exactly one supported
subprotocol: `vite-hmr` or `vite-ping`. Malformed handshake keys, absolute-form
targets, URL credentials, fragments, duplicate/unknown query parameters,
backslashes, control characters, oversized paths, multiple or unknown
subprotocols, non-sandbox origins, unknown registrations, and expired/foreign
ownership are rejected before connecting upstream.

The upstream URL is constructed solely by resolving that validated path and
query against the registration's exact normalized origin, then changing only
`http:` to `ws:`. Clients cannot choose a host, port, redirect target, or other
protocol. The upstream WebSocket client follows no redirects and negotiates no
compression.

Ponderosa creates a fresh upstream handshake. It forwards neither browser nor
Ponderosa request headers. In particular, authorization headers, cookies, OAuth
state, operator credentials, `Host`, `Origin`, and forwarded-client headers are
not copied upstream. The only constructed upstream headers are the registered
loopback origin and a non-secret Ponderosa preview user agent.

### 4.4 Limits, backpressure, and teardown

Defaults are intentionally bounded and may be overridden only by trusted server
configuration for tests or deployment tuning:

| Limit | Default |
| --- | ---: |
| Registration lifetime / maximum socket lifetime | 4 hours |
| WebSockets per registration / globally | 8 / 32 |
| Concurrent HTTP responses per registration | 64 |
| Reconnect attempts | 24 per 10 seconds |
| Upstream WebSocket handshake | 10 seconds |
| WebSocket message | 1 MiB |
| Buffered data in either direction | 2 MiB |
| Client frames awaiting upstream open | 64, also within the 2 MiB buffer |
| Path plus query | 4 KiB |
| Heartbeat / idle timeout | 5 seconds / 2 minutes |
| Close-handshake grace | 1 second |
| Buffered HTML rewrite | 5 MiB |
| Other finite HTTP response | 50 MiB with 64 KiB stream buffers |

Frames are forwarded only while the destination is open and its `bufferedAmount`
remains below the configured bound. Pending pre-open frames are copied into the
same bounded budget. Exceeding message, queue, or backpressure limits closes both
legs instead of accumulating memory. `permessage-deflate` is disabled to avoid
compression-amplification and accounting ambiguity.

Heartbeat pings detect dead peers and revalidate registration ownership. Idle
and maximum lifetimes are enforced even while the Run remains active. Run
completion, cancellation, lost fencing ownership, registration expiry, explicit
`DELETE /api/link-previews/:id`, Project/Agent/conversation invalidation, and
daemon shutdown close every WebSocket pair and abort tracked HTTP/SSE responses.
Shutdown removes the upgrade handler, allows one short close-handshake grace
period, and terminates nonresponsive peers before the daemon closes remaining
sockets.

Multiple preview tabs are permitted within the per-registration and global
limits. Reconnects use the same still-valid registration and are bounded by the
rolling reconnect window; no reconnect creates broader or longer-lived
authority.

### 4.5 Minimal page adaptation

HTML receives only the adaptation needed to keep a loopback application inside
the opaque route:

- a `<base>` derived from the requested document directory preserves nested
  relative assets;
- root-relative `src`, `href`, and `action` references receive the registration
  prefix; and
- a small wrapper around the native `WebSocket` constructor rewrites only a
  socket with exactly one recognized Vite subprotocol when its destination is
  either the exact registered loopback origin or the current sandbox origin.

The wrapper preserves native construction and subclass behavior, retains the
original path and optional Vite token, rejects credentialed/fragmented candidates
from rewriting, and does not rewrite an already scoped URL twice. It does not
parse or broadly rewrite arbitrary application JavaScript. Links, favicons,
ordinary assets, streaming responses, and multiple tabs continue through the
existing HTTP preview behavior.

### 4.6 Dependency and security boundary

The server uses `ws` in `noServer` mode. It is the smallest justified dependency
because it supplies standards-compliant handshake and frame parsing, payload
limits, ping/pong lifecycle support, and buffering visibility while allowing the
existing Fastify listener and REST/SSE/HTTP routes to remain authoritative. It
does not register a second port or general upgrade server.

This capability is **not** a general HTTP, TCP, WebSocket, or host-network proxy.
It is **not** an interactive browser, browser-control, console, or filesystem
API. It cannot connect to a client-selected host or port, and it does not widen
the scoped file-browser boundary. Preview frames, HMR messages, console traffic,
and bootstrap internals are transport data and never enter Project chat, Agent
chat, or organizational context. A broader interactive-agent-browser feature
requires a separate design and authorization review.

### 4.7 Required regression evidence

Changes to this boundary must retain focused coverage for successful HMR-style
bidirectional frames; Project/Agent/Run/conversation ownership; malformed,
unauthenticated-capability, expired, external-host, alternate-port, credentialed,
foreign-run, and foreign-registration rejection; credential stripping;
completion/cancellation/expiry/explicit-close/shutdown teardown; message,
connection, reconnect, timeout, and backpressure bounds; multi-tab behavior; and
continued assets, nested/root-relative links, favicons, HTTP streaming, and SSE.

### 4.8 Interactive agent browser transport

Ponderosa may start one engine-agnostic, host-managed Chromium/Chrome session
for an Agent's exact active Project, Agent, Run, and optional Conversation. The
runtime uses a server-issued, run-bound capability to request semantic actions;
the authenticated operator uses REST to observe frames and explicitly transfer
input control. The browser panel is a view over that owned host resource. It is
not a remote provider session and never uses a provider API key.

The server launches the browser with a fresh restrictive profile beneath
`PONDEROSA_DATA_DIR`, a minimal environment, and anonymous CDP pipes. It does not
bind a DevTools port or expose CDP, arbitrary navigation, browser control, or a
general HTTP/TCP proxy to clients. Operator routes must resolve the exact active
run on every request. Runtime browser calls must present the exact ephemeral
capability held by that same authoritative run. Full host access remains an
agent capability; these routes do not widen the scoped file-browser API.

#### Control and lifecycle fencing

Agent actions, operator input, and control transfers share one FIFO for the
session. Each action captures both the browser-process lifecycle epoch and the
control epoch. Both are checked when the action reaches the front of the FIFO
and again before its result can update canonical state or emit audit events.
Consequently, a queued old-owner action cannot execute after a control transfer,
and an in-flight old-process action cannot complete after close or reconnect.
Control transfer waits for an already in-flight action rather than allowing
simultaneous agent/operator input.

Concurrent opens for the same immutable scope share one opening promise and one
process. Close, replacement, or ownership loss fences an opening immediately;
if process creation finishes afterward, the late process is terminated and its
temporary profile removed. Driver close is idempotent. Reconnect replaces the
process only after fencing queued work and never changes the immutable owner
scope.

Normal completion, runtime failure, cancellation, execution-lease expiry,
project deletion, agent deletion, explicit close, reconnect replacement, and
daemon shutdown all close the browser predictably. Shutdown awaits teardown.
Lifecycle, navigation, control, console, and screenshot records remain canonical
Activity/Artifacts events and are not rendered as Chat conversation.

#### URL and credential boundary

Only non-userinfo `http:` and `https:` navigation inputs are accepted. A page's
current URL is untrusted even after an allowed navigation because redirects can
introduce OAuth callbacks, bearer tokens, signed-download parameters, or
credential-bearing fragments or userinfo. Before a URL crosses into a DTO,
canonical event, audit summary, snapshot, console record, or failure display,
Ponderosa strips userinfo and the entire fragment and redacts known
credential-bearing query values. Inspect snapshots are recursively sanitized,
including their title, visible text, and control labels; titles and
console/failure text receive the same credential redaction.

The manager retains a reconnect target only when the sanitized current URL has
no credential-bearing query or userinfo. Fragments are never retained. OAuth
codes and state, access/refresh/ID/session tokens, API/client secrets, SAML
payloads, signatures, and AWS/Google signed query fields are therefore never
restored or replayed after reconnect. If the current URL is non-replayable,
reconnect opens a blank page and requires an explicit fresh navigation.

Frames are bounded screenshots, not an unrestricted interactive stream.
Screenshots are written with restrictive permissions to the owning Agent's
artifact directory. Commands, navigation steps, console messages, and images
remain in Tasks/Artifacts. The design does not introduce WebSocket transport;
any future live browser transport or broader proxy requires a separate design
and authorization review.

## 5. Design-record maintenance

Do not use this file as a duplicate implementation manual. Domain behavior stays
with its current contract and executable source. Add or amend a decision here
when a change crosses protocols, authority domains, trust boundaries, persistence
models, or host-capability exposure. Each decision must state its need, exact
scope, authorization and lifecycle rules, resource bounds, non-goals, and
verification obligations.
