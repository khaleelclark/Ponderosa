# Ponderosa — Context Rollover, Native Commands, and Claude Model Versions

You are a coding agent working in the Ponderosa repository. You have no prior context; this document is self-contained. It defines **three features** to implement, in order. Behavior specifications here are final — do not redesign, do not expand scope, do not "improve" adjacent code.

---

## Part 0 — What Ponderosa is (minimum context)

Ponderosa is a self-hosted web workbench where a human operator runs organizations of AI agents. It drives **subscription-backed provider CLIs** (OpenAI's `codex`, Anthropic's `claude`) — it never uses provider API keys, and you must not add any.

Layout:

| Path | Role |
|---|---|
| `packages/core` | Shared TypeScript types (`Adapter`, `RuntimeSession`, `AgentEvent`, DTOs). |
| `packages/engines` | Provider adapters. `codex-app-server.ts` (Codex, JSON-RPC), `claude-stream-session.ts` + `claude.ts` (Claude, stream-json over stdio), `capabilities.ts` (capability/command normalization). |
| `packages/agents` | SQLite runtime state + event-log projections. `workspace-store.ts` holds operator preferences. |
| `apps/server` | Fastify daemon. `src/app.ts` is very large (~14k lines) — navigate it by **grepping for the symbols named below**, never by reading it top to bottom. |
| `apps/web` | React + MUI client. |

Vocabulary: a **Run** is one scheduled provider execution for one **Agent**. A **provider session** is the underlying CLI process/thread that a Run talks to; it accumulates conversation context across Runs until it is replaced. **Rollover** means retiring the current provider session and starting a fresh one, carrying a bounded text **handoff** forward.

Build order is `core → agents → engines → server → web`.

---

## Part 0.1 — Non-negotiable rules

1. **Read `AGENTS.md` at the repo root first and follow it.** Never commit to `master`; work on a branch; open a PR; report the exact head commit and the verification you ran.
2. **Never add a provider API key integration, HTTP call to `api.anthropic.com`/`api.openai.com`, or any new network dependency.** All provider data must come from the CLI sessions Ponderosa already runs. This rule has no exceptions — if a step seems to require an API call, stop and report instead.
3. **Line numbers below are approximate** (the repo moves). Locate code by the **symbol names** given, using grep. If a named symbol does not exist, **stop and report** — do not invent a replacement.
4. **Do not change** run scheduling, fencing/cancellation semantics, communication routing, or canonical storage. You are adding a trigger, a command registry, and a settings surface — nothing else.
5. **Do not delete or rewrite the existing rollover mechanism.** Part 1 adds a *trigger* to machinery that already exists and already works.
6. Verification baseline for every part: `pnpm --filter @ponderosa/core build && pnpm --filter @ponderosa/agents build && pnpm --filter @ponderosa/engines build && pnpm --filter server build && pnpm --filter web build`, plus typecheck. There is currently **no test suite in this repo** (it was deleted deliberately on 2026-07-24); `pnpm test` failing for that reason is pre-existing and not yours to fix. Do not add a test framework.

---

# PART 1 — Proactive context rollover

## 1.1 Background: what already exists (do not rebuild)

Ponderosa already has a complete, durable, crash-safe rollover mechanism. Today it is triggered **only by the model deciding to call a tool**. Your job is to add a **Ponderosa-owned trigger** in front of it.

Verify each of these exists before you start (grep for the symbol):

| Piece | Where | What it does |
|---|---|---|
| `PONDEROSA_ROLLOVER_TOOL` | `packages/core/src/managed-tools.ts` | Agent-callable tool `ponderosa_rollover`, takes one `handoff` string (max 20,000 code points). |
| `POST /api/agent-session/rollover` | `apps/server/src/app.ts` (grep `"/api/agent-session/rollover"`) | Validates the capability token and authoritative-Run ownership, canonicalizes the handoff, is **idempotent per Run** (reuses the existing handoff id; `409` on a conflicting second handoff), durably appends a `continuation_handoff` event **before** touching the provider session, then sets the in-memory `scheduledSessionRollovers` flag. |
| `continuation_handoffs` table | `packages/agents/src/schema/0000_current_schema.sql` | Columns include `consumed_by_execution_id` / `consumed_at` — single-consumption guarantee. |
| `continuationHandoffForRun`, `pendingContinuationHandoff`, `consumeContinuationHandoff` | `packages/agents/src/store.ts` | Handoff read/consume API. |
| `scheduledSessionRollovers` | `apps/server/src/app.ts` | `Map<agentId, timestamp>`; applied at the **Run boundary**, not mid-Run. |
| Crash recovery | `apps/server/src/app.ts`, grep `pendingContinuationHandoff` | If the daemon dies before the rollover executes, a pending durable handoff forces the rollover on the next turn (clears the resume session, tears down the stale runtime). |

**The design constraint that follows from this:** your trigger must **only cause a handoff to be authored and scheduled**. It must never switch sessions, touch fences, or terminate a runtime itself. All of that already happens correctly at the Run boundary. Violating this will break cancellation and crash recovery.

## 1.2 Desired behavior

When an Agent's provider session has accumulated more context than a configured threshold, Ponderosa asks **the current session, inside the Run it is already executing**, to author a bounded handoff via the existing `ponderosa_rollover` tool. The existing machinery then rolls the session over at the Run boundary.

Rules:

- **Trigger on whichever of two conditions fires first**, because the two providers report very different context windows:
  1. **Absolute token count** — default **150,000 tokens**, configurable. This is the primary rule and the only one that can fire for Claude, which does not report a window size. (150k is also Anthropic's own default compaction trigger; current Claude models have 1M-token windows, so a percentage-only rule would fire far too late.)
  2. **Window-relative fallback** — when, and only when, the provider reports `windowTokens`, also trigger at `usedTokens >= windowTokens × fraction` (default **0.7**, configurable). This exists because Codex reports its own window and is frequently configured with a **much smaller** one (64k is common) — on such a session the 150,000 absolute threshold is unreachable and the feature would silently never fire.

  Evaluate both; fire on the first to be satisfied. Never require both.
- **Fire at most once per Run**, and only while the Run is owned and active.
- **Never fire when the current provider session has already authored a handoff for this Run** (check `continuationHandoffForRun`).
- Ponderosa decides **when**; the model still authors the handoff **content**. Do not synthesize handoff text yourself.
- **Do not create a separate Run** to produce the handoff.
- The feature ships **disabled by default** behind an operator preference.

## 1.3 Getting the context-occupancy number

This is the only genuinely new data plumbing. The two providers differ.

### Codex — already measured, just not exposed

`packages/engines/src/codex-app-server.ts` has:

```ts
interface CodexContextUsage { totalTokens: number; modelContextWindow?: number; }
```

and a **private** field `latestContextUsage` on `CodexAppServerSession`, populated from a provider notification (grep `latestContextUsage` — it is assigned in the notification handler and read only by `formatCodexStatus`).

**Task:** expose it through a new optional method on `RuntimeSession`.

In `packages/core/src/adapter.ts`, add to the `RuntimeSession` interface (which currently declares `engineAgentId`, `events`, `capabilities?`, `invokeCommand?`, `startTurn`, `steer`, `interrupt`):

```ts
  /** Best-effort current context occupancy for this provider session.
   *  `usedTokens` counts everything occupying the provider's context window.
   *  `windowTokens` is present only when the provider reports it. */
  contextUsage?(): { usedTokens: number; windowTokens?: number } | undefined;
```

Implement it on `CodexAppServerSession` by returning `latestContextUsage` mapped to that shape.

### Claude — already correct; just read the right field

> **Correction (2026-07-25).** An earlier draft of this document claimed `claude-events.ts` omits cache tokens and instructed you to fix a bug. **That was wrong — there is no bug here.** `mapUsage` already computes
> `inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
> before assigning it, so `TokenUsage.inputTokens` is already full context occupancy. Do **not** change `mapUsage`, `totalTokens`, or anything else in that file.

Because the entire conversation is re-sent on every turn, the **input side of the most recent turn is the current context occupancy** — and that is exactly what `TokenUsage.inputTokens` already holds.

**Task:**
- Track the latest observed `usage.inputTokens` inside `ClaudeStreamSession` and return it from the new `contextUsage()` as `usedTokens`, with `windowTokens` **omitted**.
- If a turn reports no usage, keep the previous value rather than resetting to zero.
- Change nothing about how `TokenUsage` is produced or stored.

Claude does **not** report a context-window size, and Ponderosa cannot look one up (that would require an API call — forbidden by rule 2). This is exactly why the threshold is absolute. Do not hardcode a window constant.

### Any other adapter

Leave `contextUsage` unimplemented (the method is optional). A session that does not implement it never triggers rollover.

## 1.4 Wiring the trigger

> **Correction (2026-07-25).** An earlier draft told you to inject via `steer()` after `turn_done`. **That is impossible and the instruction is withdrawn.** Both adapters set the turn inactive on `turn_done` (`ClaudeStreamSession` sets `this.active = false` in its event loop; `steer()` then returns `not_active`), and the server's stream loop returns immediately on `turn_done`. Steering is for delivering work *into an already-running turn*, which is not our situation.
>
> **Also rejected: starting a second `startTurn()` inside the same Run.** It would work, but it requires changing the stream loop's termination behavior — the most safety-critical code in the daemon — and it extends a Run's lifetime, which interacts with lease renewal, liveness timers, and the cancellation window. Rule 4 of this document forbids exactly that. Do not do it.

**Measure at the end of a Run; instruct at the start of the next one.** This needs no new delivery mechanism at all.

**Step A — measure and mark (end of Run).** In `apps/server/src/app.ts`, in the code that handles `event.type === "turn_done"` for an owned, active Run:

1. Call `session.contextUsage?.()`.
2. If it returns a value, the preference is enabled, and **either** `usedTokens >= contextRolloverTokens` **or** (`windowTokens` is reported **and** `usedTokens >= windowTokens × contextRolloverWindowFraction`) → record the agent in a module-scope `Map<agentId, { usedTokens: number; at: string }>` named `contextRolloverPending`, alongside the existing `scheduledSessionRollovers` map. **Do nothing else** — no injection, no session change, no Run change.

**Step B — instruct (start of next Run).** In the `/api/agents/:id/messages` handler, where the prompt is assembled, there is already a conditional block that is appended to the prompt tail when a continuation handoff is being carried in: grep `continuationHandoffPrompt` and you will find it interpolated into both `promptTail` and `freshPromptTail`. **Follow that exact pattern.**

3. Build a `rolloverInstructionPrompt` string (empty unless triggered) and interpolate it into **`promptTail` only** — the resumed-session tail. It must never appear in `freshPromptTail`; a fresh session has nothing to hand off.
4. Include it only when **all** hold: `contextRolloverPending` has this agent, the preference is enabled, `resumeSessionId` is set (we are continuing an existing session), and `continuationHandoffForRun` shows no handoff already authored for this Run.
5. Clear the agent's `contextRolloverPending` entry once the instruction has been included in a dispatched prompt. If the agent ignores the instruction, the next `turn_done` will re-measure and re-mark it — the loop is self-correcting, so do not add retry counters.

**Why this ordering is correct, not a compromise:** an Agent that is over threshold but never runs again never needs a rollover, so deferring costs nothing and avoids burning a provider turn on an idle Agent. The Agent authors the handoff during a Run it was going to execute anyway, `ponderosa_rollover` fires as it always has, and the **existing** Run-boundary machinery swaps the session — so the Run *after* the instruction starts fresh. Headroom is adequate by construction: the thresholds sit well below the ceiling (150k of a 1M window; 70% of a reported window), leaving room for one more Run plus a 500-word handoff.

**Handoff instruction text** (use this wording; it encodes quality requirements learned from prior experiments):

> Your provider session is approaching its practical context limit. Before ending this Run, call `ponderosa_rollover` once with a 300–500 word handoff for the fresh session that will replace you. The handoff must explicitly separate: (1) the objective; (2) work completed; (3) unblocked work that should continue now; (4) blocked work and what blocks it; (5) the exact next action; (6) verified facts versus assumptions; (7) references to relevant files and artifacts. Do not summarize the whole conversation — carry only working state the next session needs. Then finish or safely stop your current work as normal.

## 1.5 The preference

Add to `WorkspacePreferencesDto` in `packages/core/src/dto.ts` and to `packages/agents/src/workspace-store.ts` (follow the existing `maxConcurrentAgentRuns` pattern exactly — it shows defaults, event replay, and patching):

```ts
  /** Proactively roll a provider session over once its context grows past these limits. */
  contextRolloverEnabled: boolean;          // default false
  /** Absolute context-token ceiling, counting cached tokens. */
  contextRolloverTokens: number;            // default 150_000; clamp to [20_000, 2_000_000]
  /** Also roll over at this fraction of the window, for providers that report one. */
  contextRolloverWindowFraction: number;    // default 0.7; clamp to [0.3, 0.95]
```

Expose all three in **Settings → General** in `apps/web/src/components/WorkspaceSettingsView.tsx`: a toggle plus two numeric fields.

**Copy requirements — the token count is easy to misread, so be explicit:**

- Label the absolute field something like **"Roll over above (context tokens)"**, with helper text: *"Counts everything occupying the provider's context window, including cached tokens — not just new input. Default 150,000."*
- Label the fraction field **"Or at this share of the provider's context window"**, with helper text: *"Applies only to providers that report a window size (Codex does; Claude does not). Catches sessions configured with a small window, where the token ceiling above would never be reached."*
- Section helper text: *"When a session passes either limit, Ponderosa asks the Agent to write a short handoff, then starts a fresh provider session at the next safe boundary. The provider's own compaction remains the fallback."*

## 1.6 Observability

Emit one existing-style log/event line when the trigger fires, including agentId, runId, `usedTokens`, and threshold, so operators can see it in Activity. Do **not** add a new UI surface, badge, or notification for this.

## 1.7 Invariants to preserve

- The trigger only marks and instructs; the Run-boundary code remains the sole thing that switches sessions.
- **The stream loop's termination on `turn_done` is unchanged.** No second `startTurn`, no extended Run lifetime, no new delivery mechanism.
- The instruction appears in `promptTail` (resumed sessions) and never in `freshPromptTail`.
- Never more than one handoff per Run (rely on `continuationHandoffForRun` plus your in-memory guard).
- Cancellation, fencing, and the `pendingContinuationHandoff` crash-recovery path are untouched.
- With the preference disabled, behavior is byte-identical to today.
- No API keys, no new network calls, no hardcoded context-window constants.

## 1.8 Verification for Part 1

- Builds and typechecks clean.
- With the preference **off**: run an Agent normally; confirm no instruction is injected and no handoff row is created.
- With the preference **on** and `contextRolloverTokens` temporarily set very low (e.g. 2,000) so it fires quickly: send a Codex Agent a few messages and confirm (a) the instruction is injected exactly once, (b) the agent calls `ponderosa_rollover`, (c) a `continuation_handoffs` row appears, (d) the next Run starts a fresh provider session and the handoff is consumed exactly once, (e) the agent retains working continuity.
- **Test the window-relative path separately**: restore `contextRolloverTokens` to 150,000, set `contextRolloverWindowFraction` low (e.g. 0.05), and confirm a Codex Agent still triggers — proving the fallback fires independently of the absolute ceiling. Report the `usedTokens` and `windowTokens` you observed.
- Note the trigger takes **two Runs** to complete by design: Run N crosses the threshold and marks the Agent; Run N+1 carries the instruction and authors the handoff; Run N+2 starts fresh. Verify that exact sequence.
- Repeat with a Claude Agent, reading occupancy from `TokenUsage.inputTokens`. Confirm Claude triggers on the absolute rule only (no `windowTokens` reported). Report the observed numbers.
- Confirm `packages/engines/src/claude-events.ts` is **unmodified**.

---

# PART 2 — Ponderosa-native `/status`, `/usage`, `/context`

## 2.1 The actual defect

Ponderosa **already implements** `/status` for Codex. In `packages/engines/src/codex-app-server.ts`, `CodexAppServerSession.invokeCommand` handles `name === "status"` by reading rate limits and formatting session id, model, and context usage via `formatCodexStatus`.

But the same method **first** does this:

```ts
const command = (await this.capabilities()).commands.find(c => c.name === name);
if (!command || command.status !== "available" || command.invocation !== "runtime") {
  throw new Error(command?.unavailableReason ?? `Codex no longer advertises /${name}`);
}
```

Codex's advertised command list is built from **skills/plugin discovery**, and it does not contain `status`. So Ponderosa refuses to run its own working implementation, and the user sees *"Message not sent. The active provider does not advertise /status."*

**This is a Ponderosa-native capability being gated behind provider advertisement.** Previous attempts to fix it by making discovery surface the command are chasing something the provider never sends. Do not go down that path.

## 2.2 Desired behavior

`/status`, `/usage`, and `/context` become **Ponderosa-provided commands**: always listed in the composer's slash menu when a live session exists, always invocable, dispatched by Ponderosa without consulting the provider's advertised list. They render an operator-facing message in the chat (the same way `/status` output is rendered today for a provider command that succeeds).

Content:

| Command | Renders |
|---|---|
| `/status` | Provider name, engine session id, active model, context occupancy (`usedTokens`, plus `/ windowTokens` and a percentage **only if** the provider reports a window), and provider rate-limit info **when the adapter can supply it without a network call** (Codex can, via its existing `account/rateLimits/read`; Claude cannot — omit that line rather than faking it). |
| `/context` | Context occupancy only, in the same format, plus one sentence explaining that this counts everything occupying the provider's context window including cached content. |
| `/usage` | Ponderosa's own recorded token usage for this Agent, sourced from the **existing** token-usage aggregation Ponderosa already computes for the Provider Activity screen (grep `tokenUsage(` in `apps/server/src/app.ts`). State plainly that these are provider-reported tokens, not subscription quota. |

If the provider cannot supply occupancy (`contextUsage` unimplemented or returns undefined), say so in plain language — do not fabricate a number.

## 2.3 Implementation

1. In `packages/core/src/adapter.ts`, the `EngineCommand` interface has `source: "built-in" | "skill" | "plugin"`. **Add `"ponderosa"`** to that union, and make sure every `switch`/comparison over `source` still compiles (grep `"skill"` in `packages/engines/src/capabilities.ts` and in `apps/web/src`).
2. Create a small module — `apps/server/src/native-commands.ts` — that exports:
   - the three `EngineCommand` descriptors (`source: "ponderosa"`, `invocation: "runtime"`, `acceptsArguments: false`, `insertText: "/status"` etc., `status: "available"`);
   - a dispatcher `invokeNativeCommand(name, ctx)` that builds the message text from data the server already has (the session's `contextUsage()`, the agent/engine records, and the existing token-usage aggregation).
3. Where the server assembles the command list returned to the web client (grep `composerCapabilities` and the `engine-capabilities` route), **merge the native descriptors ahead of provider-discovered commands**, de-duplicating by name so a provider that genuinely advertises `status` still wins.
4. In the two server routes that call `session.invokeCommand` (grep `invokeCommand` in `apps/server/src/app.ts` — there are exactly two call sites), check the native registry **first**: if the requested name is native, dispatch it via `invokeNativeCommand` and return its message; otherwise fall through to the existing provider path unchanged.
5. Do **not** modify `CodexAppServerSession.invokeCommand`'s existing guard. Provider-advertised commands keep working exactly as they do now.

## 2.4 Invariants

- Provider-advertised commands (Codex skills such as `$imagegen`) behave identically to today.
- Native commands never require the provider to advertise anything.
- No new network calls; no API keys. Rate limits only where the adapter already fetches them over its existing session.
- The slash menu visually distinguishes native commands from provider skills (use the new `source` value; a short label is enough — do not redesign the menu).

## 2.5 Verification for Part 2

- In a Codex chat, type `/` and confirm `/status`, `/usage`, `/context` appear alongside the `$skill` entries.
- Run each and paste the rendered output in your report.
- Repeat in a **Claude** chat: all three must work; `/status` must omit rate limits rather than error.
- Confirm an existing Codex skill command still runs correctly.

---

# PART 3 — Claude model versions in the UI

## 3.1 Current state

`packages/engines/src/claude.ts` defines:

```ts
const DEFAULT_MODELS: ModelOption[] = [
  { id: "", label: "Claude default" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];
```

plus `configuredClaudeModels(environment)`, which appends entries from `ANTHROPIC_DEFAULT_FABLE_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_CUSTOM_MODEL_OPTION` (each with an optional `..._NAME` label).

So versioned selection **already works** — it is just environment-variable-only and invisible in the UI. The code comment explains the alias design: *"Aliases resolve to the account's current models via the CLI; an empty id means 'let the authenticated CLI choose' (avoids hardcoding ids that go stale)."*

**That reasoning is correct and must be preserved. Do not hardcode a list of versioned Claude model IDs into the product** — they change, and a stale baked-in list is worse than an alias.

## 3.2 Desired behavior

Three changes, in this order of importance:

1. **Show what is configured.** In Settings → AI Providers, under the Claude card, list the environment-configured model entries as visible rows (id + label), so an operator who set `ANTHROPIC_DEFAULT_SONNET_MODEL` can confirm it took effect. If none are configured, show a short line explaining that specific versions can be pinned and naming the environment variables.
2. **Show what actually resolved.** `normalizeClaudeInitCapabilities` in `packages/engines/src/capabilities.ts` parses Claude's session-init event and already produces `EngineCapabilities` with a `model` field. Surface that resolved value in the UI wherever the active model is displayed for a Claude Agent (composer runtime selector and/or Agent settings), formatted like `Sonnet → <resolved id>` when the resolved id differs from the selected alias. If nothing has resolved yet (no live session), show the alias alone — do not guess.
3. **Let versions be added without an environment variable.** Add an operator-managed list of extra Claude model options to workspace preferences (`WorkspacePreferencesDto` + `workspace-store.ts`, following `maxConcurrentAgentRuns`), each `{ id: string; label?: string }`, and merge it into the Claude adapter's model list the same way `configuredClaudeModels` merges the environment entries — environment entries win on id collision. Provide add/remove UI in the Claude provider card.

## 3.3 Invariants

- The alias entries (`""`, `opus`, `sonnet`, `haiku`) remain, in that order, as the default list.
- No hardcoded versioned model IDs anywhere in the product.
- Existing environment-variable configuration keeps working unchanged and takes precedence.
- Agents already pinned to a model keep their exact selection.

## 3.4 Verification for Part 3

- With no environment variables set: Claude model picker shows exactly the four aliases; Settings explains pinning.
- Set `ANTHROPIC_DEFAULT_SONNET_MODEL` to a versioned id and restart: it appears in Settings and in the picker.
- Add an entry through the new Settings UI: it appears in the picker and survives a reload.
- Start a Claude Agent on `sonnet` and confirm the resolved id is displayed once the session is live.

---

# Reporting requirements

Work the three parts **in order** and commit each separately (Part 1, Part 2, Part 3) on one branch. When finished, reply with:

1. Branch name, base commit, head commit, and `git status` (must be clean).
2. Per part: files changed, and a one-paragraph description of what you actually implemented.
3. **Part 1 evidence:** the observed `usedTokens` (and `windowTokens` where reported) for one Codex Agent and one Claude Agent; confirmation that the Claude number is materially larger than `input_tokens` alone; and separate confirmation that both the absolute rule and the window-fraction rule can each fire on their own. State the test values you used and confirm you reset them to the 150,000 / 0.7 defaults.
4. **Part 2 evidence:** the rendered output of `/status`, `/usage`, and `/context` on both providers, pasted verbatim.
5. **Part 3 evidence:** what the Claude model picker and Settings card show in each of the three configurations above.
6. Exact verification commands you ran and their results.
7. Anything you could not do, or any place where this document contradicted the code — **report it rather than improvising**.

Do not open the PR until you have reported and been told to proceed.
