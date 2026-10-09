# Grok internal ACP candidate

This package contains an **unregistered protocol foundation**, not a Grok
Adapter. Grok cannot be selected or opened by Ponderosa. The operator has no
subscription; no login, profile access, API-key fallback, purchase or live model
call is authorized. Branches release qualification does not depend on Grok.

The official [Grok Build launch](https://x.ai/news/grok-build-cli) describes an
early beta subscription CLI and ACP orchestration. Official API SDKs do not meet
Ponderosa's subscription-only invariant. This candidate uses no SDK dependency
and performs no install or automatic binary discovery.

## Pinned evidence and local setup

Stage-0 evidence was captured on 2026-10-08 with official
`@xai-official/grok` / `@xai-official/grok-linux-x64` **1.0.46**,
`grok 1.0.46 (2765805b9442)`. Package metadata declares Apache-2.0;
the Linux distribution carries third-party notices. Native Linux x64 binary
SHA256: `41626a53292324140b92556b9d42ff5542e3dcd04aff85eafb8689dd4adb44fc`.
The release commit could not be resolved in the public repository; public source
snapshots are not proof of binary parity. Other platforms remain untested.

[Pinned package metadata](https://registry.npmjs.org/@xai-official/grok/1.0.46)
and [headless/ACP documentation](https://docs.x.ai/build/cli/headless-scripting)
describe the candidate surface. Newer documentation is not evidence that a
different version or contract is qualified.

Use Node 24 and pnpm 11, the frozen lockfile and existing local dependency store:

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm --filter @ponderosa/core build
pnpm --filter @ponderosa/native-host build
pnpm --filter @ponderosa/engines build
pnpm --filter @ponderosa/engines typecheck
node --test packages/engines/test/grok-acp-protocol.test.mjs
node --test packages/engines/test/*.test.mjs
```

The tests spawn inert Node fixtures only. They never launch Grok or a model.
`test/fixtures/grok-acp-1.0.46.json` records the original evidence ZIP/member
hashes, selected captured frames and exact sanitization: private scratch paths
and local identity/hostname metadata are replaced. Initialization, method-not-
found and nonresident close replies were captured; reverse requests, malformed
frames and teardown failures in tests are synthetic host regression cases.
The original full reports and immutable evidence bundle remain separate Project
artifacts; the fixture does not reproduce every qualification step.

## Implemented boundary

`src/grok-acp-protocol.ts` uses `JsonRpcProcess.request` for the captured
protocol-1 initialize exchange. It intentionally sends neither a Codex
`initialized` notification nor unqualified system metadata. The decoder retains
only advertised protocol/version/auth-method IDs. These are untrusted
advertisements, not authentication or entitlement evidence. The native
`_x.ai/mcp/servers_updated` decoder retains configured names only, discarding
command/argv data. Empty inventory does not prove restrictions: the stage-0 MCP
stub never launched in either case.

The shared transport already supports the observed numeric response IDs,
omitted outgoing `jsonrpc` envelope and NDJSON framing. It now rejects malformed
envelopes safely, ignores duplicate responses and duplicate reverse requests
while in flight, and suppresses reverse-handler writes after revocation.
Optional `maxPendingRequests` bounds each request direction independently;
`maxQueuedNotifications` bounds retained notices. The existing 4 MiB record
limit and optional aggregate output limit remain in use. Existing runtime callers
retain their previous caps unless they opt in. Qualification callers must supply
an abort deadline, output/pending/queue budgets and synchronous
`onRuntimeSpawned` ownership, and await that same handle's `close()` on every
exit path. Close rejects outstanding RPC work even when teardown fails; the host
keeps the live process authority and can retry cleanup. No cleanup wrapper,
alternate process launcher, JSON-RPC framework or Grok session lifecycle exists.

Numeric and string synthetic reverse requests exercise the generic transport's
existing denial/correlation path only; string IDs are now typed explicitly.
No Grok reverse-request method or ID contract was observed. Null IDs and
unqualified native extensions are not supported here. Duplicate detection is
limited to active reverse requests; there is no replay/idempotency guarantee for
completed provider calls. No AgentEvent, usage, model catalog, successful-turn,
tool-outcome, resume or steering mapping is inferred from these frames.

## Gates before a real Adapter

A new tracked qualification assignment and operator-approved subscription account
are required before any live work. Credentials must remain provider-owned through
official operator-managed login; no credential copy, API integration or mixed/
custom endpoint fallback is allowed. Use disposable harmless content and pin the
binary; never submit Project context during unauthorized qualification.

Required live gates remain untested:

- Subscription-only effective model route and safe entitlement evidence.
- A real trusted system channel across fresh and resumed sessions. Parsing
  `--rules`/`--tools`, or receiving metadata, does not prove effective ACP policy.
- Enforced filesystem/connector/tool restrictions, including native tools,
  project config, hooks, plugins and resumed config precedence.
- Exact current-Run managed MCP inventory/calls, revocation, and stale-call denial.
- Actual streams, refusals/errors/terminal outcomes and any claimed usage fields.
- Fresh/resume isolation and cancel during initialization, tools and model work;
  observed whole-tree exit and retained cleanup authority on failure.
- Suppression of native questions, subagents, goals, leaders, workflows,
  background work, provider memory/history and unwanted telemetry/updates.
- Each claimed platform's native packaging and lifecycle behavior.

Missing trusted-system, restriction or stop guarantees block integration even for
a reduced-capability Adapter. Linux mock/group tests do not qualify Grok daemon
escape, systemd scopes, Windows Jobs, macOS, live tools or account behavior.

After mandatory gates pass, a newly authorized sole writer can add `src/grok.ts`
and a qualified `src/grok-acp-session.ts`, reusing contained-spawn,
runtime-environment, process-termination and the existing Ponderosa MCP bridge.
Only then may `src/index.ts` register the Adapter and launcher provider discovery
be adapted. Trusted provider policy and all wire/event translation stay inside
engines. Scheduler authority, Run fences, Branches cwd/budgets and bounded scoped
Project/global memory retain their existing owners. Provider memory must not
become canonical Ponderosa context; Grok's sandbox is not proof of Wildfire
enforcement. Independent engine/security review and current-baseline validation
precede any merge decision. This foundation authorizes none of those later steps.
