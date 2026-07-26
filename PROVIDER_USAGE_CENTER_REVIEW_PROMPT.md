# Independent Review — Ponderosa Provider Usage Center

You are the **independent reviewer** for a pull request in the Ponderosa repository. You have no prior context on this work; this document is self-contained.

**You are read-only.** Do not edit, commit, push, rebase, merge, or run destructive commands. Do not fix anything you find — report it. Do not start Runs against production data. Do not alter Projects, Agents, Chats, Triggers, artifacts, or workspace preferences.

**Your job is to falsify, not to confirm.** The author has made specific factual claims about what they built and what they verified. Treat every one as unproven until you check it in the diff yourself. A review that repeats the author's summary back has produced nothing. Findings you cannot substantiate with a file and line are not findings — drop them.

---

## 1. What Ponderosa is (minimum context)

Ponderosa is a self-hosted web workbench where a human operator runs organizations of AI agents through **subscription-backed provider CLIs** (`codex`, `claude`). It never uses provider API keys.

| Path | Role |
|---|---|
| `packages/core` | Shared types and DTOs. |
| `packages/engines` | Provider adapters: `codex-app-server.ts` (JSON-RPC), `claude-stream-session.ts` (stream-json over stdio), `capabilities.ts` (command catalogs). |
| `packages/agents` | SQLite runtime state, event-log projections. |
| `apps/server` | Fastify daemon. `src/app.ts` is ~15k lines — navigate by grep, never linearly. |
| `apps/web` | React + MUI client. |

A **Run** is one scheduled provider execution for one Agent. A **provider session** is the CLI process a Run talks to.

Read `AGENTS.md` at the repo root. It links to several governing documents that no longer exist — note it once; it is pre-existing and not this PR's fault.

## 2. The PR under review

- **Branch:** `codex/provider-usage-center`
- **Worktree:** `/Users/patmi/Desktop/Ponderosa-provider-usage-center`
- **Base:** `3de2688e800c2795f4e9d4f1a3e6a14e09e742dd` (the PR #322 merge)
- **Head:** `cc7b373b5d1e6814ff12dce27ca63f7514e6639b`
- **Size:** 19 files, +1177 / −41, one commit

Review the net diff `3de2688..cc7b373` as the thing being merged.

### The defect it fixes

`/usage` was broken through the UI. The server matched the leading `/word`, looked it up in the live capability catalog, 409'd if unadvertised, 409'd if `invocation !== "prompt"` — then **fell through and did nothing else with it**. The text proceeded into the ordinary message path, where `individualChatPrompt` wrapped it in a `[CONVERSATION CONTRACT | AUTHORITATIVE]` block. Claude received prose, not a command, and correctly replied that it had no `/usage` command. The validation gate disguised this: it rejected *unknown* commands with a real error, so the path looked implemented when there was no transport behind it.

Separately, `/status` on a cold Codex session took 30+ seconds with no UI feedback at all.

### The binding constraint

Reading quota **must not create a Run, must not send prompt text to a model, and must not consume model tokens.** That is the entire point. Verify it structurally, not by reading the author's assertion.

## 3. Author's claims — verify or refute each

Where a claim is about runtime behavior you cannot reproduce, say so explicitly rather than assuming it true or false.

1. Claude runs an exact isolated `/usage` through the authenticated CLI with **no conversation contract and no persistent session**.
2. Results are accepted only with zero tokens, zero turns, zero API duration, zero cost, and "synthetic command evidence."
3. Codex uses a lightweight provider-scoped app-server connection with `account/read` and `account/rateLimits/read`.
4. **Neither path creates an Agent session or Run.**
5. The cache is provider/account scoped, deduplicates concurrent refreshes, retains successful readings after failures, and enforces a five-minute automatic floor.
6. Refreshes occur after Run completion, on opening a stale popover, and on manual request — **there is no idle quota polling**.
7. Command provenance is now explicitly `provider-advertised` or `adapter-implemented`, replacing the ambiguous `built-in` value.
8. Codex's partial data stays partial: only reported seven-day windows appear, and no session figure is invented.
9. API verification after exercising both commands showed `runCount: 0`, `finalizedRuns: 0`, `totalTokens: null` for both providers.

## 4. What to scrutinize hardest

Rank your attention here — these are where a defect would actually hurt.

- **Process lifecycle.** This spawns `claude` child processes outside the Run machinery. Trace every exit path: normal completion, timeout, abort signal, non-zero exit, daemon shutdown. Can a hung or orphaned process leak, or block the daemon's drain? `ProviderUsageCache.pendingCount()` is wired into an existing pending-work counter and `shutdown()` into the close path — confirm both are correct and that a stuck read cannot wedge shutdown indefinitely.

- **The zero-cost guard's failure mode.** The Claude reader requires `model: "<synthetic>"` plus zeroed `num_turns` / `duration_api_ms` / `total_cost_usd` / token counters, and throws `"Claude /usage did not provide zero-token command evidence"` otherwise. Failing closed is correct for a billing guarantee. But verify: if Claude changes its output shape in a CLI update, does the operator get an actionable error, or a blank card with a cryptic message? Is a legitimate reading ever rejected?

- **Can `/usage` still reach the prompt path?** The client intercepts the command in `onCommand` before submission, and the server would 409 it as `invocation: "runtime"`. Enumerate every other route into the message path — queued messages, Triggers, internal V3 dispatch, retries, replayed drafts, the `internalV3Dispatch` branch that skips the slash gate entirely — and confirm none of them can wrap `/usage` in a conversation contract and bill it as a turn.

- **Account-key derivation.** `providerUsageTarget` parses a human-readable auth string with `/^logged in as (.+?)(?:\s+\(subscription\))?$/iu` to derive `accountLabel`, and falls back to the raw detail string for `accountKey`. Check what happens when the auth string changes format or is empty: can two different accounts collide onto one cache key (serving one operator's quota for another's), or one account split across keys? This is a regex against provider-authored text — treat it as the fragile seam it is.

- **Concurrency.** Two Agents on the same provider refreshing simultaneously; a manual refresh landing during a post-Run refresh; a refresh in flight when the daemon closes. Confirm the dedup is on the right key and that a rejected promise cannot poison the cached entry.

- **Codex connection lifecycle.** Confirm the "lightweight provider-scoped app-server connection" is actually torn down, and that it is genuinely not an Agent session.

- **The provenance split.** `capabilities.ts` now emits `"provider-advertised" | "adapter-implemented" | "skill" | "plugin"`. Note that Claude's `usage` is *advertised by Claude* but labeled `adapter-implemented` because Ponderosa dispatches it. Confirm that is applied consistently for both providers and that no catalog entry now misrepresents its origin — a prior PR shipped an evidence document falsely claiming Codex advertises `status`, and the root cause was exactly this enum's ambiguity.

- **DTO and wire contract.** New DTOs cross the SSE/API boundary. Check older clients degrade safely and that nothing sensitive — account identifiers, auth strings, tokens — is exposed where it should not be.

## 5. Known limitations you do not need to re-litigate

- The repository contains **no test files** (deleted deliberately on 2026-07-24). `pnpm test` failing for that reason is pre-existing. Do not ask for tests in this PR and do not treat their absence as a finding.
- **Provider coverage is asymmetric and cannot be fixed from Ponderosa's side.** Claude reports session and weekly percentages; Codex reports only 7-day rate windows with no per-session figure. Codex showing fewer windows is correct behavior, not a gap.
- Codex `/status` being adapter-implemented over `account/rateLimits/read` is by design — the Codex app-server protocol exposes no invokable slash-command surface for status. The data is genuinely Codex's; the dispatch and rendering are Ponderosa's. That is the correct architecture.
- `AGENTS.md` links to deleted governing documents.

## 6. Deliverable

Report, in this order:

1. **Verdict:** approve / approve-with-changes / request-changes.
2. **Claim-by-claim table** for the nine claims in §3: verified / refuted / not verifiable, each with the file and line (or command output) that supports your call.
3. **Findings**, severity-ranked. For each: file and line, what is wrong, the concrete failure path, and the smallest correction. No finding without evidence.
4. **Constraint compliance:** state honored / violated / unclear for each — no Run created, no prompt text sent to a model, no tokens consumed, no provider API keys, no TUI scraping, no idle polling.
5. **What you could not check** and why.

Verification commands available to you (read-only):

```
git diff 3de2688..cc7b373
pnpm --filter @ponderosa/core build && pnpm --filter @ponderosa/agents build && pnpm --filter @ponderosa/engines build && pnpm --filter @ponderosa/server build && pnpm --filter @ponderosa/web build
pnpm typecheck
```

Do not approve on the strength of the author's summary. If you did not verify a claim, say so in the table rather than marking it verified.
