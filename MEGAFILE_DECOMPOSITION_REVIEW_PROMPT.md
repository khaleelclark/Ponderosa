# Independent Review — Ponderosa Mega-File Decomposition

You are the **independent reviewer** for a branch in the Ponderosa repository. You have no prior context on this work; this document is self-contained.

**You are read-only.** Do not edit, commit, push, rebase, merge, or run destructive commands. Do not fix anything you find — report it. Do not start Runs against production data. Do not alter Projects, Agents, Chats, Triggers, artifacts, or workspace preferences.

**Your job is to falsify, not to confirm.** The author has made specific factual claims. Treat every one as unproven until you check it. A review that repeats the author's summary back has produced nothing. Findings you cannot substantiate with a file and line are not findings — drop them.

---

## 1. What Ponderosa is (minimum context)

Ponderosa is a self-hosted web workbench where a human operator runs organizations of AI agents through subscription-backed provider CLIs (`codex`, `claude`). It never uses provider API keys.

| Path | Role |
|---|---|
| `packages/core` | Shared types and DTOs. |
| `packages/engines` | Provider adapters. |
| `packages/agents` | SQLite runtime state, event-log projections. |
| `apps/server` | Fastify daemon. `src/app.ts` is the largest file in the repo. |
| `apps/web` | React + MUI client. |

Read `AGENTS.md` at the repo root. It links to several deleted governing documents — note it once; pre-existing, not this branch's fault.

## 2. The branch under review

- **Branch:** `codex/test-recovery-megafile`
- **Worktree:** `/Users/patmi/Desktop/Ponderosa-test-recovery-megafile`
- **Base:** `998ae0b0293adb0391bdc56cc421a55c66208625` (master, the PR #323 merge)
- **Head:** `d423928`
- **Size:** 83 files, +9,868 / −5,846, across 74 commits
- **Split:** 70 source files (+7,452 / −5,822) and 13 test/config files

Review the net diff `998ae0b..HEAD` as the thing being merged.

### What it claims to do

Decompose eight oversized files, with a small test net built first. Two rounds of work plus a cleanup commit:

| File | Before | After |
|---|---|---|
| `apps/server/src/app.ts` | 15,376 | 13,977 |
| `packages/agents/src/coordination-v3-store.ts` | 7,009 | 6,781 |
| `packages/agents/src/store.ts` | 5,403 | 5,215 |
| `packages/core/src/dto.ts` | 2,031 | 14 |
| `apps/web/src/components/AgentDetail.tsx` | 2,492 | 2,153 |
| `apps/web/src/components/ConversationView.tsx` | 2,231 | 1,607 |
| `apps/web/src/components/chat/Composer.tsx` | 1,770 | 1,474 |
| `apps/web/src/components/WorkspaceSidebar.tsx` | 1,666 | 1,410 |

**The core claim is that all of this is behavior-preserving.** Module-scope extraction and the DTO split are asserted to be byte-identical code motion. React hook extraction and route extraction are not byte-identical and are asserted safe on the strength of the test net.

---

## 3. Part A — mechanical verification (do this first, it is fast)

Most of this diff is verifiable by command, not by reading. Run these before spending attention anywhere else. **Any failure here is a finding; report it and stop.**

```bash
# Gate
pnpm --filter @ponderosa/core build && pnpm --filter @ponderosa/agents build && \
pnpm --filter @ponderosa/engines build && pnpm --filter @ponderosa/server build && \
pnpm --filter @ponderosa/web build
pnpm typecheck
pnpm test
git diff --check

# Line counts match the table in §2
wc -l apps/server/src/app.ts packages/agents/src/coordination-v3-store.ts \
      packages/agents/src/store.ts packages/core/src/dto.ts \
      apps/web/src/components/AgentDetail.tsx apps/web/src/components/ConversationView.tsx \
      apps/web/src/components/chat/Composer.tsx apps/web/src/components/WorkspaceSidebar.tsx

# dto.ts barrel preserves every export (claimed: 200 before, 200 after, none missing)
git show 998ae0b:packages/core/src/dto.ts | grep -oE "^export (interface|type|enum|const|function) [A-Za-z0-9_]+" | awk '{print $3}' | sort -u > /tmp/dto-before.txt
cat packages/core/src/dto/*.ts | grep -oE "^export (interface|type|enum|const|function) [A-Za-z0-9_]+" | awk '{print $3}' | sort -u > /tmp/dto-after.txt
diff /tmp/dto-before.txt /tmp/dto-after.txt && wc -l < /tmp/dto-after.txt
```

Then verify independently, by whatever method you trust:

1. **Every consumer import path still resolves.** No file outside the eight targets should have needed editing to accommodate the splits. Check the diff for edits to unrelated consumers — any such edit contradicts the barrel/re-export claim and is a finding.
2. **Exported surfaces unchanged** for all eight targets. For the four React components, the named exports and props types. Use an AST tool, not grep — grep undercounts `export { }` re-export blocks.
3. **Pure-motion claim for `prompts.ts` and the module-scope extractions.** The author claims AST declaration slices are exact including comments. Spot-check at least five moved declarations against `git show 998ae0b:<original>` yourself. Confirm bodies, signatures, defaults, and attached comments are unchanged.
4. **`secretEqual`** — claimed moved verbatim to `apps/server/src/security.ts`. This is a timing-safe comparison guarding a credential check. Confirm the body is unchanged and was not "simplified."

## 4. Part B — where to actually spend your attention

Four areas carry essentially all the risk. Everything else in this diff is mechanical.

### B.1 React hook extraction (highest risk)

All four components had custom hooks extracted into `use*.ts` siblings. **This is the only place in the branch where a silent behavior change could hide**, because React identifies hook state by call order and nothing about a reordered hook fails to compile.

The author claims: hook sequences preserved exactly — 74 hooks in `ConversationView`, 50 hooks and 9 effects in `Composer`. Verify by counting yourself in the diff, then check:

- **Call order.** Do hooks execute in the same sequence after extraction, including hooks *inside* the extracted custom hook relative to those remaining in the component?
- **Conditional calls.** Is any hook now behind a condition, an early return, or a branch that did not exist before?
- **Dependency arrays.** Compare every one before and after. The author claims none were changed and that none were "fixed" despite looking wrong. A silently corrected dependency array changes when effects fire and no test in this branch would catch it.
- **Cleanup functions.** Still attached to the same effect, still doing the same teardown.
- **`key` props and list identity.** Preserved exactly? A changed key changes remount behavior.

### B.2 `ServerContext` and the seven extracted route domains

Seven domains covering 20 registrations were moved: limits, operator profile images, usage, agent audit, search/all-chat, legacy workspace reads, communication documents. All are claimed read-only.

- **Did anything mutable leak into a context advertised as read-only?** Inspect `apps/server/src/server-context.ts`. The author claims it carries only `opts`, `documentationReferences`, read-only `limits`, read-only `agentDetail`, a narrow `Pick<AgentStore, ...>` of read methods, and read-only `tokenUsage`. Verify the `Pick` genuinely contains only reads — a single mutating method in there undermines the whole safety argument.
- **`SearchRoutesContext`** is a second, separate context added to avoid reordering initialization. Confirm that is what it does and that initialization order is genuinely unchanged.
- **Registration order.** Fastify route matching and hooks can be order-sensitive. Confirm the extracted routes register at their original positions relative to hooks and catch-alls.

### B.3 The declined route domains

~155 registrations were *not* extracted, on the stated grounds that they capture and mutate authorities owned elsewhere (`activeRuns`, `coordinationV3`, `coordinationV3Scheduler`, deletion fences, SSE subscriber sets, shutdown drains, transfer counters).

**Spot-check two or three of these declines.** Is the capture analysis honest, or was a genuinely extractable domain declined as cover? Conversely — and more importantly — **is any *extracted* domain actually entangled in a way the author missed?** The second question matters more than the first.

### B.4 Is the test net adequate for what shipped?

This branch deliberately removed a recovered legacy suite and kept five files: `apps/server/test/app.test.ts` (11 cases, `app.inject()`) and four `@testing-library` characterization suites (15 cases). **26 tests total.**

Assess honestly:

- Do those 26 cases actually cover the four React components' extracted hooks — effects firing, cleanup on unmount, dependency-array behavior, state surviving re-render? Or do they cover initial render and little else?
- The extracted route domains are covered by 11 server cases. Is that meaningful coverage of those 20 registrations?
- **What shipped in this branch that nothing verifies?** Name it specifically.

This is not a request to demand more tests — the operator's position is that broad coverage waits for stabilization, and that is settled. It is a request to state plainly what the net does and does not protect, so the merge decision is informed.

## 5. Known limitations — do not re-litigate

- **Neither store class was split.** `CoordinationV3Store` has two private fields shared across 156 methods with 43 transaction openers; `AgentStore` has `dataDir`/`db`/`client` spanning nearly every domain. The analysis was done and the verdict stands. Do not propose a split.
- **~155 routes remain in `createServer`.** Extracting them requires a lifecycle-ownership design that is deliberately out of scope.
- **Minimal test coverage is deliberate.** `packages/agents`, `packages/engines`, and `apps/launcher` have zero tests and `--passWithNoTests` on their scripts. This is the operator's stated policy, not an oversight.
- **Seven known bugs were deliberately left unfixed** and are getting a separate change. Do not report them as new findings; do flag if any of them was made worse:
  - `WorkspaceSidebar` leaks active resize listeners on unmount
  - `AgentStore.commitProjectDeletion` does not clear `communicationRevisionCache`
  - `applyAuthorizedAgentReorganization` appends JSONL inside a non-rollbackable SQLite transaction
  - `CoordinationV3Store.maxPendingTriggerOccurrencesPerAgent` has no reader
  - `resetExpiredTriggerBudgets` lacks a surrounding transaction
  - Web SSR emits `useLayoutEffect` warnings
  - `jsdom` is pinned at 26.1 rather than 29 for the Node >=20 engine floor
- **Four UI behavior drifts** were recorded during test recovery — Home action `New` → `All Messages`, `Sort resources`/`Recent Activity` removed, project artifacts split into Overview and Files & Results tabs, `Close Projects` → `Close All Projects`. These predate this branch. Confirm they were pre-existing drift and not caused by this refactor, then move on.

## 6. Deliverable

Report, in this order:

1. **Verdict:** approve / approve-with-changes / request-changes.
2. **Part A results** — each mechanical check, pass or fail, with the command output.
3. **Findings**, severity-ranked. For each: file and line, what is wrong, the concrete failure path, and the smallest correction. No finding without evidence.
4. **Hook-extraction assessment** — your independent count of hook order and dependency arrays per component, and whether you can confirm behavior preservation or only that it compiles.
5. **`ServerContext` assessment** — whether anything mutable is reachable through it.
6. **Coverage statement** — what this branch changed that no test verifies.
7. **What you could not check** and why.

Do not approve on the strength of the author's summary. If you did not verify a claim, say so rather than marking it verified.
