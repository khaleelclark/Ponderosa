---
id: settings-and-auth
title: Runtime settings and subscription access
summary: Configure the network boundary, engine defaults, and subscription-backed runtime access.
section: Operations
order: 70
related: getting-started,runs-and-results,troubleshooting
code: Engine adapter contract|packages/core/src/adapter.ts;Engine availability|apps/server/src/engine-availability-store.ts
---

Ponderosa drives already-authenticated provider runtimes. Use `codex login` or the provider's supported subscription login flow on the host. Never place `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, session tokens, or login-store contents in Ponderosa settings, Projects, images, or the wiki.

## Keep the operator boundary explicit

The daemon listens on `127.0.0.1` by default. A non-loopback listener refuses to
start unless bearer authentication is configured with `PONDEROSA_AUTH_TOKEN`, or
`PONDEROSA_TRUSTED_TAILNET=true` is paired with one literal address in Tailscale's
`100.64.0.0/10` or `fd7a:115c:a1e0::/48` ranges. Trusted-tailnet mode rejects
wildcards, DNS names, ordinary LAN addresses, and public addresses.

Do not store an operator bearer token in browser code or `localStorage`; place a
browser deployment behind an authenticated proxy that injects it. Trusted-tailnet
mode is intentionally passwordless: every tailnet peer that can reach the bound
address has full operator access, including the authority to start Agents that run
as the host user. The AI provider status dialog and `/api/ready` show the active
network posture.

## Layer runtime choices

Workspace defaults, Project defaults, Agent settings, and a per-send selection can choose engine, model, and effort. Ponderosa resolves those layers into the concrete Run configuration and records it with usage so historical work remains attributable after settings change.

## Separate configuration from availability

An installed adapter, an authentication file, and a provider-confirmed entitlement are different facts. A real subscription denial keeps queued work durable but unleased for that engine. Renewing the subscription does not clear the denial by elapsed time; the operator explicitly tests access, or a successful provider Run restores availability.

## Bound concurrency centrally

Configurable workspace and engine limits shape how many Runs may lease at once. Technical process, browser, payload, and safety caps remain system-owned and cannot be raised through ordinary settings. Lower user limits should hold queued work fairly without rewriting communication or Activation history.
