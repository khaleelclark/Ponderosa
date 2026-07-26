# Ponderosa — Provider Usage Center (`/status` and `/usage`)

You are a coding agent working in the Ponderosa repository. You have no prior context; this document is self-contained.

Read `AGENTS.md` at the repo root and follow it: branch, PR, independent reviewer, never commit to `master`. It links to several governing documents that no longer exist — ignore the dead links, they are pre-existing.

Build order: `core → agents → engines → server → web`.

**There is no test suite.** It was deleted deliberately on 2026-07-24. `pnpm test` failing for that reason is pre-existing. Do not add a test framework and do not treat its absence as a problem to solve.

---

## 0. Sequencing precondition

This work touches `apps/server/src/app.ts`. A separate task — `app.ts` decomposition Phase 1 — rewrites the top 1,760 lines of that file as pure code motion, and PR #322 recently added ~470 lines to it. **These cannot run concurrently.** Confirm with the operator which is running before you start. If Phase 1 is in flight, stop and report rather than starting. Do not decide this yourself.

## 1. Context

Ponderosa is a self-hosted web workbench where a human operator runs organizations of AI agents through **subscription-backed provider CLIs** (`claude`, `codex`). It wraps the CLIs. It never uses provider API keys.

| Path | Role |
|---|---|
| `packages/core` | Shared types and DTOs. |
| `packages/engines` | Provider adapters. `codex-app-server.ts` (JSON-RPC), `claude-stream-session.ts` (stream-json over stdio), `capabilities.ts` (command catalogs). |
| `packages/agents` | SQLite runtime state and event-log projections. |
| `apps/server` | Fastify daemon. `src/app.ts` is ~15k lines — navigate by grep, never linearly. |
| `apps/web` | React + MUI client. |

A **Run** is one scheduled provider execution for one Agent. A **provider session** is the CLI process the Run talks to.

## 2. The defect

**`/usage` is broken through the UI.** It appears in Claude's live command catalog and the server accepts it, but the operator gets back Claude saying it has no `/usage` command.

Here is exactly why, and you must understand this before writing any code:

`apps/server/src/app.ts` (~line 11402) matches a leading `/word` on the composer text, looks the name up in the live capability catalog, returns 409 if the provider does not advertise it, and returns 409 if `command.invocation !== "prompt"`. Then it **falls through and does nothing else with it.** The text proceeds into the ordinary message path, where `individualChatPrompt` (~line 1391) wraps it:

```
[CONVERSATION CONTRACT | AUTHORITATIVE]
You are replying in your individual Ponderosa Agent chat.
...
[CURRENT REQUEST | ACTION REQUIRED]
/usage
```

Claude only treats a slash command as a command when it *is* the input. Here it arrives as the last line of a contract prompt, so it is prose, and Claude answers accordingly. **The validation gate is what disguises this** — it rejects unknown commands with a real error, so the path looks implemented when there is no transport behind it.

**`/status` on Codex works but is unusable.** A cold Codex session takes 30+ seconds to answer and the UI shows nothing at all during that time — no spinner, no pending state, no timeout handling.

## 3. Established evidence — do not re-derive

Verified on live subscription-backed sessions. Treat as given.

- **Exact headless Claude `/usage` returns real subscription data in ~1.4 seconds** — structured stream output, no TUI scraping, no model request, no token spend. This is the transport that works.
- Claude genuinely advertises `usage`, `context`, `compact`, `mcp`, `insights`, `recap`, `doctor` in its `system/init.slash_commands`. `CLAUDE_HEADLESS_BUILT_IN_COMMANDS` in `packages/engines/src/capabilities.ts` (~line 281) is an **allow-list** filtering that advertised set — not a deny-list, despite its commit title.
- **Codex `/status` is adapter-implemented, not provider-advertised.** Ponderosa synthesizes the catalog entry itself in `normalizeCodexProviderDiscovery` (`capabilities.ts`, ~line 390), so the advertisement guard at the top of `CodexAppServerSession.invokeCommand` is validating Ponderosa's own catalog. The *data* is genuinely Codex's — `account/rateLimits/read` over the existing JSON-RPC session, plus `latestContextUsage` accumulated from app-server notifications (`codex-app-server.ts`, ~line 624). The rendering is `formatCodexStatus` / `formatCodexRateLimits`. The Codex app-server protocol exposes no invokable slash-command surface for status, which is why the adapter reimplements it over the underlying RPC. **This design is correct.** Only the previous documentation of it was wrong.
- Provider coverage is **asymmetric and cannot be fixed from Ponderosa's side**: Claude reports session and weekly percentages; Codex reports only 7-day rate windows with no per-session figure, and returns "Context usage not yet reported" on a fresh thread.

## 4. What to build

A provider-level usage surface that is **completely decoupled from Runs**.

### The core rule

Reading quota **must not create a Run, must not send prompt text to a model, and must not consume model tokens.** This is the whole fix. A `/usage` that goes through the Run prompt path is the bug.

### Readers

**Claude** — launch an isolated, non-persistent stream session against the operator's existing authenticated `claude` binary and send the exact command `/usage` as the entire input, with no contract wrapper and no context section. Read the structured stream output. Close the session. No credentials are read, handled, or passed by Ponderosa — this is the same binary and auth the adapter already uses.

**Codex** — use the existing `account/rateLimits/read` RPC through a lightweight provider-scoped app-server connection. Do **not** stand up a temporary Agent session to get it.

### Normalized DTO

```ts
{
  provider: string;
  windows: Array<{
    id: string;             // e.g. "session", "week", "7d"
    label: string;
    usedPercent?: number;
    resetsAt?: string;      // ISO
  }>;
  accountLabel?: string;
  source: "provider-command" | "provider-rpc";
  fetchedAt: string;        // ISO
  stale?: boolean;
}
```

`windows` is deliberately open — do not force Codex's 7-day windows into a session/week shape that Codex does not report. **Any UI must be provider-conditional and must not imply a figure the provider did not return.**

### Caching

Cache per provider and account. Deduplicate concurrent refreshes. Render cached values immediately and refresh in the background. Show a loading state only when there is no cached reading.

**Refresh cadence — do not poll on a short timer.** Refresh after a Run completes, on popover open when the reading is stale, and on manual click, with an idle floor of five minutes. A 60-second poll of a *weekly* quota window buys nothing and spawns a `claude` process every minute per provider.

### Surfaces

**Top bar** — a quota indicator showing the most constrained authenticated provider at a glance (e.g. `Claude · 60%`), opening a popover with every window the provider returned, percentage used, reset time, account identity, "updated Ns ago", a manual refresh button, a visible refreshing state, and the last successful reading retained during transient failures. Inside an Agent, that Agent's provider sorts first; other authenticated providers stay selectable.

**Slash commands** — `/status` on a Codex Agent and `/usage` on a Claude Agent insert the cached card immediately and refresh asynchronously, drawing on the same cache as the top bar. They appear only when appropriate for the selected provider. If no cached reading exists, show an immediate loading card — never a silent 30-second wait. Disable duplicate submission while one is in flight, and handle timeout and error states explicitly.

## 5. Provenance labeling — read this carefully

A `/usage` that renders a cached card without forwarding anything to the provider **is Ponderosa-dispatched**, structurally identical to Codex `/status`. That is the correct architecture. Do not describe it as provider-owned, and do not claim there is no Ponderosa-dispatched command in the catalog.

The command catalog's `source` enum currently uses `"built-in"` to mean *provider-advertised* on Claude and *adapter-implemented* on Codex — one value, two meanings. **Split it as part of this work**, the way PR #322 split the model-source enum into `"provider-probe" | "operator" | "environment"`. Commands need the equivalent: a value that says provider-advertised and a value that says adapter-implemented-over-provider-data.

This matters because a prior PR shipped an evidence document asserting that Codex advertises `status` and that it is provider-owned. That was false, it was preserved for future readers, and the root cause was an enum that could not express the difference. Do not repeat it.

## 6. Out of scope

- Any direct HTTP call to `api.anthropic.com` or any provider API. Ponderosa does not extract or use provider credentials; the subscription CLI is the only provider surface.
- Any Ponderosa-owned slash command that is not backed by real provider data.
- TUI scraping of any kind.
- Claude model selection and the Latest/Pinned selector — shipped in PR #322.
- Context-rollover presentation. Separate work, still unassigned.

If you believe one of these is necessary, **stop and report** instead of doing it.

## 7. Verification

```bash
pnpm --filter @ponderosa/core build && \
pnpm --filter @ponderosa/agents build && \
pnpm --filter @ponderosa/engines build && \
pnpm --filter @ponderosa/server build && \
pnpm --filter @ponderosa/web build
pnpm typecheck
git diff --check
```

**Evidence standard — this is not optional.** A previous round reported `/usage` as verified on the strength of adapter-level and session-level checks. It was broken through the UI the whole time, because those checks ran below the layer where it breaks. Session-level evidence proves nothing about UI dispatch.

Every claim in your report must be demonstrated **through the running UI**, with screenshots:

1. `/usage` typed into a live Claude Agent composer, returning real subscription percentages — with proof no Run was created and no tokens were consumed.
2. `/status` typed into a live Codex Agent composer against a **cold** session, showing an immediate loading state, then the rendered card.
3. The top-bar indicator and its popover, showing every window the provider actually returned.
4. The same popover on a provider whose data is partial — show that a figure the provider did not report is absent rather than invented or zero-filled.
5. A manual refresh, showing the refreshing state and an updated timestamp.
6. A failure case — provider unreachable or command rejected — showing the last good reading retained with a clear error, not a blank card.

Do not restore or alter unrelated Projects, Agents, Chats, Triggers, or artifacts. Do not fire existing Triggers. Do not change global runtime configuration or provider availability. Restore any preference you change for testing, and say in your report what you changed and what you restored.

## 8. Report

1. Branch, base commit, head commit, `git status` clean.
2. The exact transport used for each provider, and evidence that no Run was created for either.
3. Per-item evidence for §7, with screenshots.
4. The refresh cadence you implemented and where it is triggered from.
5. Anything you found that looked wrong but deliberately did not change.
6. Verification command output.

Do not open the PR until you have reported and been told to proceed.
