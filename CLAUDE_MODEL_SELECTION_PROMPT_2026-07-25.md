# Ponderosa — Claude Model Selection

You are a coding agent working in the Ponderosa repository. You have no prior context; this document is self-contained.

Read `AGENTS.md` at the repo root and follow it: branch, PR, independent reviewer, never commit to `master`. It links to several governing documents that no longer exist — ignore the dead links, they are pre-existing.

Build order: `core → agents → engines → server → web`.

**There is no test suite.** It was deleted deliberately on 2026-07-24. `pnpm test` failing for that reason is pre-existing. Do not add a test framework and do not treat its absence as a problem to solve.

---

## 0. Sequencing precondition

This work touches `apps/server/src/app.ts`. A separate task — `app.ts` decomposition Phase 1 — rewrites the top 1,760 lines of that file as pure code motion. **The two cannot run concurrently.** Before you start, confirm with the operator which is running. If Phase 1 is in flight, stop and report rather than starting.

## 1. Context

Ponderosa is a self-hosted web workbench where a human operator runs organizations of AI agents through **subscription-backed provider CLIs** (`claude`, `codex`). It wraps the CLIs. It never uses provider API keys.

| Path | Role |
|---|---|
| `packages/core` | Shared types and DTOs. |
| `packages/engines` | Provider adapters. `claude.ts` holds model option construction. |
| `packages/agents` | SQLite runtime state, `workspace-store.ts` holds operator preferences. |
| `apps/server` | Fastify daemon. `src/app.ts` is ~14k lines — navigate by grep, never linearly. |
| `apps/web` | React + MUI client. |

## 2. The problem

An operator choosing a Claude model for an Agent sees only four aliases: `""` (Claude default), `opus`, `sonnet`, `haiku`. These are `DEFAULT_MODELS` at `packages/engines/src/claude.ts:47`.

`configuredClaudeModels()` (same file, ~line 79) **appends** two further sources onto that list: operator-entered models (via `setOperatorModelOptions`, fed from Workspace Settings and wired at `apps/server/src/app.ts:2017`) and environment-variable models (`ANTHROPIC_DEFAULT_OPUS_MODEL` and friends). It does not replace the aliases. Both `AgentDetail.tsx` and `WorkspaceSettingsView.tsx` render the same resulting `engine.models` list.

Two gaps:

1. **No discovery.** Nothing tells the operator which exact version IDs exist, or what an alias currently resolves to. They type an ID blind into a field whose only validation is a duplicate check.
2. **No pinning semantics.** The UI does not distinguish "follow the provider's latest" from "stay on this exact version." An operator who wants to stay on a specific model has no way to express or verify that.

## 3. Established evidence — do not re-derive

These were verified on live subscription-backed sessions. Treat them as given.

- The Claude Agent SDK exposes `supportedModels()` and `initializationResult().models`. A structured initialization probe against the operator's authenticated `claude` binary returned the model list in **1.9 seconds with no model turn** — no prompt, no inference, no tokens.
- That probe returned exactly five entries: `default → claude-sonnet-5`, `sonnet → claude-sonnet-5`, `opus → claude-opus-4-8`, `haiku → claude-haiku-4-5-20251001`, `claude-fable-5[1m] → claude-fable-5`.
- **`claude-opus-5` was NOT in that list, and `claude-opus-5` works.** It was passed via `--model` on a live Pine session, accepted, and reported back by Claude as "Opus 5". It also appears in the CLI's own internal model registry alongside `claude-opus-4-8`.
- Claude accepts both aliases and exact version IDs via `--model`. Validating a candidate ID is therefore already solved.
- Anthropic's own CLI validates a typed model ID with **a one-token server probe, not a local catalog lookup**. It ships no local catalog gate for typed IDs. Its only local gate is an enterprise `settings.availableModels` policy allowlist, which returns true when unset.
- The `system/init` stream-json event carries `model` as a single resolved string. There is **no catalog in `system/init`** — do not look for one there.
- When Claude renders a human display name ("Opus 4.8") rather than echoing the raw string, that name comes from the CLI's internal registry. It is a signal the ID is real and known to the installed CLI.

## 4. The design

**Two sources, neither exclusive.**

### Source A — the provider probe

Add a `ClaudeModelCatalogProbe` in `packages/engines`. It:

1. Launches the operator's existing authenticated `claude` binary — the same binary and auth the adapter already uses. No credentials are read, handled, or passed by Ponderosa.
2. Uses stream JSON, no session persistence, no tools.
3. Sends the structured initialization control request and reads the returned model list.
4. Closes, supervised through Ponderosa's existing process-lifecycle machinery.

This yields aliases, their **current resolutions**, and account-specific extras. The resolution map is what makes Latest-vs-Pinned expressible: it is how you know `opus` means `claude-opus-4-8` today.

### Source B — operator-entered, live-validated

The existing Workspace Settings flow, hardened. The operator types a candidate ID; Ponderosa validates it by launching a short headless session with `--model <candidate>` and reading `system/init`. On success, store it and **auto-fill the label from the display name Claude reported**. On failure, show why.

## 5. The trap — read this twice

**Do not restrict selection to what the probe returns.** A previous design proposal recommended "provider-catalog-only selection," reasoning that Ponderosa should not offer a model merely because an arbitrary ID is syntactically accepted.

That reasoning is wrong here, and shipping it would be a serious regression. The probe returns the **model picker list** — aliases plus account extras. It is not a version catalog. `claude-opus-5` is absent from it and works. The `opus` alias currently resolves to `claude-opus-4-8`, so under catalog-only selection Opus 5 would be unreachable through Ponderosa entirely: no alias points at it and no pin would be permitted. The selector would be unable to select the newest model.

The correct rule: **the probe is authoritative about what aliases mean, and about nothing else.** Absence from the probe is not evidence of unavailability. Live validation is the authority on whether a specific ID works.

## 6. Normalized DTO

```ts
{
  id: string;                      // exactly what is passed to --model
  resolvedModel?: string;          // what the provider resolved it to
  label: string;
  description?: string;
  kind: "alias" | "exact";
  supportedEffortLevels?: string[];
  source: "provider-probe" | "operator" | "environment";
  validatedAt?: string;            // ISO timestamp, source: "operator" only
  availability?: "available" | "unavailable";
  unavailableReason?: string;
}
```

`source` must distinguish provenance honestly. A prior PR in this repository shipped an evidence document claiming a Ponderosa-synthesized command was provider-advertised, because the enum had no value that could express the difference. Do not repeat that.

## 7. Selector UX

Group the list:

**Latest** — aliases, annotated with their current resolution.
> **Opus** — Latest · currently resolves to Opus 4.8 · stores `opus`

**Pinned** — exact version IDs, from the probe or operator-entered.
> **Opus 4.8** — Pinned · stores `claude-opus-4-8`

Choosing an alias follows future provider upgrades. Choosing an exact ID stays put. Label this explicitly in the UI; do not rely on the operator inferring it.

Environment-configured entries continue to take precedence over workspace-configured entries on ID collision. That is existing behavior — preserve it.

## 8. Caching

- Prefer a model list already obtained from a live Claude session over spawning a probe.
- Cache per Project, effective Claude configuration, and CLI version — managed and project `availableModels` policies can change what the picker returns.
- Deduplicate concurrent probes.
- Render cached choices immediately, refresh in the background.
- **Never probe once per Agent page.** A previous change regressed capability discovery this way; the per-Agent capability key in `apps/web/src/components/ProjectShell.tsx` is the relevant precedent.
- Show "Refreshing Claude models…" only when there is no cache to show.

## 9. Failure modes — handle each explicitly

**Never silently substitute a different model.** If a pinned model becomes unavailable, keep it visible in the selector marked unavailable with a reason.

**A retired pin fails at Run time, not at configuration time** — mid-Agent-turn, surfacing as a generic provider failure. Map the provider's `invalid_model` (400) and `model_not_found` (404) responses to a distinct, actionable Agent-level error: *"pinned model X is no longer available — update it in Workspace Settings."* Mark the stored option unavailable so settings reflects it. Refresh the probe after a model-start rejection.

**Do not collapse validation failures into "invalid model."** Invalid ID, expired OAuth, org `availableModels` policy, and plan entitlement are four different problems with one symptom. An operator shown the wrong one chases the wrong fix. Anthropic's own client distinguishes not-found from auth and network failures for exactly this reason.

**`[1m]` suffix handling.** The CLI strips a trailing `[1m]` for entitlement and cost purposes, but the ID passed to `--model` must retain the suffix. If you surface these variants, the effective base ID and the invocation ID differ. Leave a comment near `configuredClaudeModels()` noting this.

**Validation cost.** Budget validation as a user-initiated action on the settings form. Never on page load, never per-Agent-render. Persist the verdict and timestamp; re-validate lazily.

## 10. Out of scope

- Any direct HTTP call to `api.anthropic.com`. Ponderosa does not extract or use provider credentials. The subscription CLI is the only provider surface.
- Any hardcoded list of versioned Claude model IDs, including as a fallback registry. Aliases are not versioned IDs and are fine.
- Scraping the interactive TUI model picker, or extracting the model registry from the CLI binary.
- Reading `~/.claude.json` internal caches as a dependency. If you want the account-specific extras it holds, get them from the probe, which returns them properly.
- The Provider Usage Center, `/status` progress feedback, and rollover presentation. Separate work.

If you believe one of these is necessary, **stop and report** instead of doing it.

## 11. Verification

```bash
pnpm --filter @ponderosa/core build && \
pnpm --filter @ponderosa/agents build && \
pnpm --filter @ponderosa/engines build && \
pnpm --filter @ponderosa/server build && \
pnpm --filter @ponderosa/web build
pnpm typecheck
git diff --check
```

**Evidence standard — this is not optional.** A previous round of this work was reported as verified on the strength of adapter-level and session-level checks, and the feature was broken through the UI. Session-level evidence proves nothing about UI dispatch.

Every claim in your report must be demonstrated **through the running UI**, with screenshots:

1. Agent Settings selector showing Latest and Pinned groups, with an alias annotated by its current resolution.
2. Adding a model ID that the probe does **not** return — use `claude-opus-5` — validating successfully, and appearing as a pinned choice.
3. Adding a deliberately invalid ID and getting a specific, correct error.
4. An Agent completing a live Run on a pinned exact version.
5. An Agent completing a live Run on an alias.

Do not restore or alter unrelated Projects, Agents, Chats, Triggers, or artifacts. Do not fire existing Triggers. Do not change global runtime configuration or provider availability. Restore any preference you change for testing, and say in your report what you changed and what you restored.

## 12. Report

1. Branch, base commit, head commit, `git status` clean.
2. The probe's actual returned list on the test host, verbatim.
3. Per-item evidence for §11, with screenshots.
4. Anything you found that looked wrong but deliberately did not change.
5. Verification command output.

Do not open the PR until you have reported and been told to proceed.
