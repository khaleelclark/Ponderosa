# Ponderosa — Decomposition Round 2

You are a coding agent working in the Ponderosa repository. You have no prior context; this document is self-contained.

This continues work started in `TEST_RECOVERY_AND_DECOMPOSITION_PROMPT.md`. That round is finished and its results are given below as facts — do not redo it, and do not relitigate its settled decisions.

---

## 1. Where things stand

**Branch to build on:** `codex/test-recovery-megafile`, head `b96793d1f87b0e17e9b1878aac8d487d40d4a0c5`, worktree `/Users/patmi/Desktop/Ponderosa-test-recovery-megafile`. Clean, unpushed, no PR.

Round 1 rebuilt the test suite and did part of the decomposition:

| Target | Before | Now | Round 1 outcome |
|---|---|---|---|
| `apps/server/src/app.ts` | 15,376 | 14,514 | 15 modules extracted; **prompt-builder cluster not moved**; 5 of 175 routes extracted |
| `packages/agents/src/coordination-v3-store.ts` | 7,009 | 6,781 | Module scope done; **class split declined — settled** |
| `packages/agents/src/store.ts` | 5,403 | 5,215 | Module scope done; **class split declined — settled** |
| `packages/core/src/dto.ts` | 2,031 | 14 | **Complete.** Barrel over 10 domains, 200 exports verified identical |
| `apps/web/src/components/AgentDetail.tsx` | 2,492 | 2,339 | Pass 1 only |
| `apps/web/src/components/ConversationView.tsx` | 2,231 | 2,139 | Pass 1 only |
| `apps/web/src/components/chat/Composer.tsx` | 1,770 | 1,720 | Pass 1 only |
| `apps/web/src/components/WorkspaceSidebar.tsx` | 1,666 | 1,449 | Pass 2 reached |

The test suite is green: launcher 10, engines 135, agents 211 (+29 skipped), web 117, server 116 (+43 skipped).

### Settled — do not reopen

- **Neither store class gets split.** `CoordinationV3Store` has two private fields shared across 156 methods with 43 direct transaction openers; `AgentStore` has `dataDir`/`db`/`client` spanning nearly every domain. The state and transaction analysis was done and the verdict stands. Do not re-derive it and do not attempt a split.
- The dto barrel is complete and verified. Leave it alone.
- The 15 zero-consumer exports from `app.ts` stay. They are flagged for a separate operator decision.

### Known bugs — do not fix here

Round 1 found these and correctly left them. They are getting their own change. If you touch these code paths, work around them; do not repair them:

- `AgentStore.commitProjectDeletion` does not clear `communicationRevisionCache`.
- `applyAuthorizedAgentReorganization` appends canonical JSONL inside a SQLite transaction that cannot roll that append back.
- `CoordinationV3Store.maxPendingTriggerOccurrencesPerAgent` has no reader.
- `resetExpiredTriggerBudgets` performs multiple row updates with no surrounding transaction.
- Web SSR emits `useLayoutEffect` warnings.

## 2. Why Round 1 stopped where it did

Three of four React files stopped after Pass 1 and Pass 3 was never attempted anywhere. The reason was not caution about the components — it was that **no net exists that can observe them.**

`apps/web` has **no `jsdom`, no `happy-dom`, no `@testing-library/react`, and no vitest config file.** Web tests run in a Node environment with no DOM, so the only React coverage possible is `renderToString` — initial SSR markup. Nothing there executes an effect, fires an event, or exercises hydration. Round 1 also had to drop 34 recovered web tests because `react-test-renderer` is absent.

So one missing piece of test infrastructure gated ~8,100 lines of component work. **Fixing that is Phase 1 of this round, and everything else depends on it.**

---

## PHASE 1 — build a web net that can see behavior

### 1.1 Infrastructure

Add to `apps/web` as devDependencies and wire a vitest config with a DOM environment:

- **`jsdom`** (or `happy-dom`) plus a `vitest.config.ts` setting `environment: "jsdom"`. Prefer `jsdom` for fidelity unless startup cost proves prohibitive.
- **`@testing-library/react`** and **`@testing-library/user-event`** — for the new interaction tests you will write in 1.3. This is the path that survives the React 19 upgrade.
- **`react-test-renderer`** and `@types/react-test-renderer` — solely to recover the 34 existing tests written against it. React is on 18.3.1, so it works today.

⚠️ **`react-test-renderer` is deprecated as of React 19.** You are adding it to recover existing tests cheaply, not as the going-forward choice. Write **no new tests** against it — new work uses `@testing-library/react`. Note this migration debt in your report.

Keep the Node-environment tests working. If some existing web tests depend on the absence of a DOM, scope the environment per-file with vitest's `// @vitest-environment` docblock rather than forcing one global choice.

### 1.2 Recover the 34 blocked tests

These were dropped in Round 1 only because the dependency was missing: `agentDeletionDialog`, `agentWorkInspector`, `allChat`, `assets`, `attentionSurface`, `browserSurfaces`, `browserViewport`, `collaborationQuery`, `commandCopy`, `composerClipboard`, `confirmationDialogs`, `decisionResponseDialog`, `filePreview`, `globalSearch`, `headerRelationshipLinks`, `importAgentDialog`, `messageDeliveryRetry`, `messageTags`, `mobileFeedback`, `presetManagerDialog`, `projectArtifacts`, `providerStatusDialog`, `resourceContextMenu`, `runtimeSettings`, `sharedChatContracts`, `sharedSidebarLayout`, `shellDialogFlows`, `triggersPane`, `userMessageLabel`, `workLogPane`, `workspaceErrorBoundary`, `workspaceOverviewAccessibility`, `workspaceReview`, `workspaceTabsView`.

Recover from `71ec201a042ce8ea159b71a9abb0aaba83c916d3` with `git show 71ec201:<path> > <path>`, then triage exactly as Round 1 did: passes / cheap fix / behavior changed / stale. **Fix the test, never the source.** Record every behavior change with old assertion, new assertion, and the commit you believe caused it.

Apply the same cap Round 1 used: these must drive public component APIs. Do not restore anything that reaches into module internals, and do not rebuild an implementation mirror.

### 1.3 Write the characterization tests Pass 2 and 3 actually need

Recovering old tests is not sufficient. For each of the four target components, write **new** `@testing-library/react` tests that pin the behavior a subcomponent or hook extraction would break. These are characterization tests: they pin what the code does **today**, not what it should do. If current behavior looks wrong, pin it and report it.

Per component, cover:

- **Effects actually running** — mount the component and assert the observable consequences of its effects, not just its markup.
- **Hook-order sensitivity** — state that survives re-render, and state that resets. This is what catches a reordered or conditionally-called hook.
- **Effect cleanup** — unmount and assert teardown happened (subscriptions closed, timers cleared, listeners removed).
- **Dependency-array behavior** — change one prop, assert which effects re-fire and which do not. This is the single most valuable class of test here, because a "tidied" dependency array is invisible to every other check.
- **Reconciliation identity** — for list rendering, assert that reordering preserves component state where it does today (the `key` contract).
- **Interaction** — for `Composer` especially (34 hook calls, 9 effects): typing, submitting, clearing, and any queued-state transitions.

Keep it **small and targeted.** This exists to make a specific refactor safe, not to reach a coverage number. If a behavior cannot be observed through the public component API, say so — **that is the finding**, and it means the corresponding extraction should not be attempted.

### 1.4 Gate

Phase 1 ends when `pnpm test` is green across all five packages, and each of the four target components has characterization tests covering effects, cleanup, and dependency-array behavior.

**Commit discipline:** Phase 1 commits contain test and test-config changes only. The one permitted exception is `apps/web/package.json` for the new devDependencies. No source file changes.

---

## PHASE 2 — finish the decomposition

### 2.1 Universal rules

1. **Pure motion for §2.2.** No renames, no signature changes, no reordered parameters, no changed defaults or return types, no edited bodies. No cleanup, simplification, modernization, or added JSDoc. If tempted to improve something, don't — note it in the report.
2. **Preserve every `export` and every import path.** No file outside the targets may need editing.
3. **Preserve comments verbatim**, including `SPEC §` references.
4. **One module or one pass per commit**, with the affected package's build, `pnpm typecheck`, and `pnpm test` green before moving on.
5. **Two kinds of red.** If a green test goes red: if it asserts *behavior* (a value, a rendered result, an effect consequence, a database row), you broke something — revert, never edit the test. If it asserts *structure* (an import path you moved, a module-internal spy), fix the seam, keep the assertion byte-identical, and list the edit in your report. When unsure, treat it as behavioral.

### 2.2 `app.ts` — the prompt-builder cluster

Round 1 extracted 15 modules but left the largest group in place, correctly noting it is valid pure motion that simply did not get done. Finish it.

Move to `apps/server/src/prompts.ts`: `boundedSeedHistory`, `boundedContinuationHistory`, `runtimeIdentityPrompt`, `communicationV3Prompt`, `conversationPrompt`, `individualChatPrompt`, `continuationPrompt`, `contextSection`, `messageContextPrompt`, `sharedRequestCompletionPrompt`, `directUserRequestCompletionPrompt`, `teamDirectoryPrompt`, `olderContextPrompt`, `sharedBroadcastContextPrompt`, `managerRelationshipPrompt`, `mergeScopedContextSources`, `byteBoundScopedContext`, `boundedHistoryOmitted`.

Verify closure-freedom for each before moving; leave and report any that captures. Prove motion the way Round 1 did — AST declaration slices compared against the base, including attached comments, normalizing only exports and leading indentation.

Then sweep the remaining module scope for anything else still extractable and report what is left and why.

### 2.3 React Passes 2 and 3

With the Phase 1 net in place, take all four components through the remaining passes. `WorkspaceSidebar` is already at Pass 2 and needs only Pass 3.

**Pass 2 — presentational subcomponents.** JSX chunks rendering from props, calling no hooks (or only `useMemo`/`useCallback` over their own props). Props passed explicitly — **do not introduce context to avoid prop threading**, which changes update semantics. Preserve `key` props and list identity exactly. A chunk inside a `useMemo` stays inside one.

**Pass 3 — custom hooks.** Extract stateful logic groups to `use*.ts` siblings.
- **Hook call order must be identical.** React identifies state by call order. Grouping several `useState` calls into one custom hook is fine only if the resulting order matches exactly.
- Never place a hook call behind a condition or early return.
- **Preserve every dependency array verbatim.** If one looks wrong, leave it and report it.
- Keep cleanup functions attached to the same effect.

Round 1 noted `ConversationView` needs message-level characterization before `ConversationMessageComponent` can move — write that in Phase 1.

**If a pass cannot be completed without a behavior change, stop at the previous pass for that file and report precisely what would have been required.** Three components fully decomposed and one stopped is a good outcome; four with a subtly changed render path is not.

### 2.4 Routes — expand `ServerContext`

Round 1 extracted 5 of 175 registrations and left `ServerContext` carrying only `opts` and `documentationReferences`, on the grounds that expanding it into a bag of mutable runtime authority without behavioral coverage was the risky part. That judgment was sound. **Push it as far as the net honestly allows, and no further.**

Work domain by domain, ordered by capture count, lowest first. For each domain, before moving anything: list the `createServer`-scope identifiers it reads and which it mutates. A domain that only *reads* closure state is a strong candidate. A domain that mutates state also mutated elsewhere is not — leave it.

One domain per commit, full suite green after each. Stop when the remaining domains genuinely require carrying mutable lifecycle authority — a partial extraction that keeps the suite green beats a complete one that does not. Report the capture analysis for every domain you declined, so the boundary is documented rather than asserted.

Hazards: shared mutable state written from more than one domain, ordering dependencies between registrations, Fastify hooks that must run before or after specific routes, closure variables captured by both routes and the run executor, anything wired into the pending-work counter or shutdown drain.

### 2.5 Out of scope

- Splitting either store class. Settled.
- Fixing the five known bugs above.
- Behavior changes, performance changes, dependency changes beyond the Phase 1 test infrastructure.
- Renaming exports or changing any public surface.
- Restyling or restructuring JSX while extracting.

If you believe one is necessary, **stop and report** instead of doing it.

---

## Delegating

**One file, one agent.** Never two agents in the same file, in a wave or across waves. Partition by file, never by task type. Every agent gets §2.1 verbatim. Each wave lands green on the integration branch before the next starts.

- **Wave 0 — Phase 1.** Infrastructure and config first, by you, since everything depends on it. Then one agent per component for its characterization tests, plus one agent on the 34-test recovery.
- **Wave 1 — parallel:** one agent on `app.ts` §2.2 (prompt cluster), four agents on React Pass 2, one per component.
- **Wave 2 — React Pass 3**, four agents, one per component. Riskiest work in the round; full suite green per file.
- **Wave 3 — routes. Serial, single agent, no delegation.** One `ServerContext`, one file; parallelizing guarantees conflicts.

Keep the judgment calls: whether a red test is structural or behavioral, whether a component survives Pass 3, whether a route domain's captures permit extraction. Those come back to you with evidence and you decide.

## Verification

```bash
pnpm --filter @ponderosa/core build && \
pnpm --filter @ponderosa/agents build && \
pnpm --filter @ponderosa/engines build && \
pnpm --filter @ponderosa/server build && \
pnpm --filter @ponderosa/web build
pnpm typecheck
pnpm test
git diff --check
```

All must pass. Confirm the exported surface of every target is unchanged — for the React components, the default export and its props type.

## Report

**Phase 1**
1. Test infrastructure added, and how you scoped DOM vs Node environments per file.
2. Triage of the 34 recovered tests: passed / cheap-fixed / behavior-changed / still stale, with every behavior change recorded as old assertion → new assertion → suspected commit.
3. The characterization tests written per component: what each pins, and any behavior you could not observe through the public API (which means the matching extraction should not be attempted).
4. Final `pnpm test` output per package.

**Phase 2**
5. Before/after line counts for all five remaining targets.
6. `prompts.ts`: what moved, motion evidence, anything declined for closure capture, and what remains in `app.ts` module scope with the reason.
7. Per React component: which pass it reached; if it stopped early, the specific behavior change that would have been required. Every dependency array or `key` you left alone despite thinking it wrong.
8. Routes: every domain extracted, and for every domain declined, its capture analysis — which identifiers it reads, which it mutates, and which of those are mutated elsewhere.
9. The final `ServerContext` shape.
10. Every structurally-coupled test you edited, showing the assertion unchanged.
11. Anything declined and why. Anything that looked wrong and was deliberately left. `react-test-renderer` migration debt.

**Delegation**
12. Agents dispatched per wave and the file each owned. Confirm no file had two writers.
13. Any wave that did not land green first try, and what failed.

**Git hygiene:** branch, base, head, `git status` clean. Phase 1 commits contain no source changes beyond `apps/web/package.json`.

Do not open the PR until you have reported and been told to proceed.
