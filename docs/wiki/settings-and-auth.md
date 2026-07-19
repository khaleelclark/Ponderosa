---
id: settings-and-auth
title: Runtime settings and subscription access
summary: Configure engine defaults and concurrency separately from provider login and durable availability.
section: Operations
order: 70
related: getting-started,runs-and-results,troubleshooting
code: Engine adapter contract|packages/core/src/adapter.ts;Engine availability|apps/server/src/engine-availability-store.ts
---

Ponderosa drives already-authenticated provider runtimes. Use `codex login` or the provider's supported subscription login flow on the host. Never place `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, session tokens, or login-store contents in Ponderosa settings, Projects, images, or the wiki.

## Layer runtime choices

Workspace defaults, Project defaults, Agent settings, and a per-send selection can choose engine, model, and effort. Ponderosa resolves those layers into the concrete Run configuration and records it with usage so historical work remains attributable after settings change.

## Separate configuration from availability

An installed adapter, an authentication file, and a provider-confirmed entitlement are different facts. A real subscription denial keeps queued work durable but unleased for that engine. Renewing the subscription does not clear the denial by elapsed time; the operator explicitly tests access, or a successful provider Run restores availability.

## Bound concurrency centrally

Configurable workspace and engine limits shape how many Runs may lease at once. Technical process, browser, payload, and safety caps remain system-owned and cannot be raised through ordinary settings. Lower user limits should hold queued work fairly without rewriting communication or Activation history.
