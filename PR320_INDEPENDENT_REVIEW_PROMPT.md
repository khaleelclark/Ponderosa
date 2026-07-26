# Independent Review — Ponderosa PR #320

You are the **independent reviewer** for a pull request in the Ponderosa repository. You have no prior context on this work; this document is self-contained.

**You are read-only.** Do not edit, commit, push, rebase, merge, or run destructive commands. Do not fix anything you find — report it. Do not start Runs against production data.

**Your job is to falsify, not to confirm.** The author has made specific factual claims about what they changed and what they verified. Treat every one as unproven until you check it yourself in the diff. A review that repeats the author's summary back has produced nothing. Findings you cannot substantiate with a file and line are not findings — drop them.

---

## 1. What Ponderosa is (minimum context)

Ponderosa is a self-hosted web workbench where a human operator runs organizations of AI agents through **subscription-backed provider CLIs** (`codex`, `claude`). It never uses provider API keys.

| Path | Role |
|---|---|
| `packages/core` | Shared types — `Adapter`, `RuntimeSession`, `AgentEvent`, DTOs. |
| `packages/engines` | Provider adapters: `codex-app-server.ts` (JSON-RPC), `claude-stream-session.ts` (stream-json over stdio), `capabilities.ts`. |
| `packages/agents` | SQLite runtime state, event-log projections, `workspace-store.ts` (operator preferences). |
| `apps/server` | Fastify daemon. `src/app.ts` is ~14k lines — navigate by grep, never linearly. |
| `apps/web` | React + MUI client. |

Vocabulary: a **Run** is one scheduled provider execution for one **Agent**. A **provider session** is the CLI process/thread the Run talks to; it accumulates context across Runs until replaced. **Rollover** = retiring the current provider session and starting a fresh one, carrying a bounded text **handoff** forward.

Read `AGENTS.md` at the repo root before reviewing. Note: it links to several governing documents that no longer exist in the tree — read their last committed versions from git history if you need them, and mention the broken links in your report.

## 2. The PR under review

- **Branch:** `codex/context-rollover-native-commands-claude-models`
- **Base:** `afa2b11cc91381ac1fd4b49ff95372a88bc4073e`
- **Head:** `2c020f5ff0e249ed2a840d09b5a62d6d8967a950`
- **Size:** 21 files, +720 / −55
- **Commits (12, including two revert/reapply pairs):**

```
2c020f5 Avoid idle provider capability probes
10a8d0c Reapply "Scope agent capability discovery"
5310e07 Reapply "Refresh live agent model capabilities"
0f76c94 Revert "Refresh live agent model capabilities"
6cc9a50 Revert "Scope agent capability discovery"
2929738 Scope agent capability discovery
4f2c924 Refresh live agent model capabilities
e305cbc Preserve completed rollover outcomes
9ec37fc Clarify cached input token usage
d3148b4 Expose Claude model versions in the UI
187a310 Add Ponderosa native runtime commands
b2fb12c Add proactive provider context rollover
```

Review the **net diff** `afa2b11..2c020f5` as the thing being merged. Use the individual commits only to understand intent.

It implements three features:

1. **Proactive context rollover** — when a provider session's context grows past a configurable threshold, Ponderosa asks the Agent to author a bounded handoff, then the existing rollover machinery starts a fresh session.
2. **Ponderosa-native `/status`, `/usage`, `/context`** — slash commands dispatched by Ponderosa rather than the provider.
3. **Claude model version exposure** — surfacing environment-pinned and workspace-configured Claude model options, and the resolved model id, in the UI.

## 3. Design constraints the author was given

These were binding requirements. Verify each is actually honored in the diff — several are the whole point of the review.

**Rollover (feature 1):**
- The trigger must **only mark and instruct**. It must never switch sessions, advance fences, terminate a runtime, or create a scheduler Run. All session switching happens in pre-existing Run-boundary code.
- It uses a **two-Run** shape by design: Run N measures occupancy and marks the Agent; Run N+1 carries an instruction in its prompt and the Agent authors a handoff via the pre-existing `ponderosa_rollover` tool; Run N+2 starts fresh.
- The instruction must appear **only in the resumed-session prompt tail** (grep `promptTail`) and **never** in `freshPromptTail` — a fresh session has nothing to hand off.
- The stream loop's termination behavior on `turn_done` must be **unchanged**.
- Trigger fires when **either** an absolute token threshold is met **or** — only when the provider reports a window size — a fraction-of-window threshold is met.
- `packages/engines/src/claude-events.ts` must be **completely unmodified**.
- No provider API keys, no new network calls, no hardcoded context-window constants.

**Native commands (feature 2):**
- Native commands merge **ahead of** provider-discovered commands, but a provider that genuinely advertises the same name still wins.
- `CodexAppServerSession.invokeCommand`'s existing advertisement guard must be **unmodified**; provider-advertised commands (Codex skills) behave exactly as before.
- No new network calls. Rate limits only where the adapter already fetches them over its existing session; Claude must **omit** the rate-limit line rather than error.

**Claude models (feature 3):**
- **No hardcoded versioned Claude model IDs anywhere.** Aliases (`""`, `opus`, `sonnet`, `haiku`) remain the default list; versions come from environment variables or operator-managed workspace preferences only.
- Environment-configured entries take precedence over workspace-configured entries on id collision.
- Existing environment-variable configuration keeps working unchanged.

**Global:** do not change run scheduling, fencing, cancellation semantics, communication routing, or canonical storage.

## 4. Author's claims — verify or refute each

The author states the following. **Check each against the diff and the code.** Where a claim is about runtime behavior you cannot reproduce, say so explicitly rather than assuming it true or false.

1. `packages/engines/src/claude-events.ts` is completely unmodified.
2. The stream loop's `turn_done` termination is untouched.
3. The rollover instruction appears in `promptTail` only, never `freshPromptTail`.
4. The trigger only marks; no scheduler, lease, fencing, cancellation, or stream-termination behavior changed.
5. `CodexAppServerSession.invokeCommand`'s advertisement guard is preserved and an existing Codex skill still runs.
6. No versioned Claude model IDs are hardcoded.
7. Commit `e305cbc` ("Preserve completed rollover outcomes") sets `activeRun.persistentRuntimeIdentity = undefined` before a rollover teardown so the root-exit callback cannot reinterpret an intentional provider retirement as a runtime failure. The author claims: pre-terminal provider crashes still fail the Run; post-terminal rollover exits cannot rewrite a completed Run; exits before detachment are handled via `matchedReusable`; exits after detachment are handled by retained closing authority that logs, fences, retries, and raises an operational notification if termination cannot be confirmed.
8. The revert/reapply churn was caused by an unscoped-query race, not by probe behavior; the reapplied commits are identical to the originals.
9. Live Pine verification: Run N at 26,246 tokens marked the Agent; Run N+1 at 126,322 delivered the instruction and authored a handoff; Run N+2 at 88,013 was a fresh session carrying the handoff; `/status` and `/context` rendered a 33,617-token occupancy with no Claude rate-limit line and no error; a live alias resolved as `Sonnet → claude-sonnet-5`; preferences were restored to `false / 150,000 / 0.7`.

For claim 8 specifically: diff `2929738` against `10a8d0c` and `4f2c924` against `5310e07` and state whether the reapplied changes are in fact identical.

## 5. What to scrutinize hardest

Rank your attention here — these are where a defect would actually hurt:

- **Run-boundary and failure attribution.** Commit `e305cbc` modifies how a provider exit is attributed. Trace `persistentRootExited` and satisfy yourself that a *genuine* provider crash during the rollover teardown window is still observed somewhere, and that a *deliberate* teardown cannot corrupt an already-terminal Run. This is the single highest-risk change in the PR.
- **Trigger idempotency.** Can the rollover instruction be delivered twice for the same Run, or a second handoff authored? Trace the pending-mark map, the gate conditions, and where the mark is cleared. Consider the daemon restarting between mark and instruction.
- **Prompt-tail placement.** Confirm by reading both tail constructions, not by grepping one symbol.
- **The new SSE/DTO event.** The PR adds a typed context-rollover event to the wire contract. Check that older clients degrade safely and that the event carries nothing sensitive.
- **Native command dispatch order.** Confirm the collision rule (provider wins) is actually implemented and not just asserted, and that both server call sites behave the same.
- **Capability query scoping.** `apps/web/src/components/ProjectShell.tsx` changed how engine capabilities are fetched (per-Agent key). Confirm this cannot spawn a provider discovery probe for an Agent that has no live session — that was an explicit late fix and is the kind of thing that regresses quietly.
- **Preference plumbing.** Three new workspace preferences. Check defaults, clamping, event replay in `workspace-store.ts`, and that a workspace with no stored value behaves as if the feature is off.

## 6. Known limitations you do not need to re-litigate

- The repository currently contains **no test files** (deleted deliberately on 2026-07-24). `pnpm test` failing for that reason is pre-existing. Do not ask for tests to be added in this PR, and do not treat their absence as a finding.
- The feature ships **disabled by default**; the tuning of the 150,000-token default is an open question to be answered from production data later, not in this review.
- `AGENTS.md` links to deleted governing documents. Note it once; it is not this PR's fault.

## 7. Deliverable

Report, in this order:

1. **Verdict:** approve / approve-with-changes / request-changes.
2. **Claim-by-claim table** for the nine claims in §4: verified / refuted / not verifiable, each with the file and line (or command output) that supports your call.
3. **Findings**, severity-ranked. For each: file and line, what is wrong, the concrete failure path, and the smallest correction. No finding without evidence.
4. **Constraint compliance:** for each constraint in §3, state honored / violated / unclear.
5. **What you could not check** and why.

Verification commands available to you (read-only):

```
git diff afa2b11..2c020f5
git diff --exit-code afa2b11 -- packages/engines/src/claude-events.ts
pnpm --filter @ponderosa/core build && pnpm --filter @ponderosa/agents build && pnpm --filter @ponderosa/engines build && pnpm --filter @ponderosa/server build && pnpm --filter @ponderosa/web build
pnpm typecheck
```

Do not approve on the strength of the author's summary. If you did not verify a claim, say so in the table rather than marking it verified.
