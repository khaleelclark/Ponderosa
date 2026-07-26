# Ponderosa — Test Recovery, then Mega-File Decomposition

You are a coding agent working in the Ponderosa repository. You have no prior context; this document is self-contained.

**This supersedes `MEGA_FILE_DECOMPOSITION_PROMPT.md` and `APP_TS_DECOMPOSITION_PHASE1_PROMPT.md`.**

**Policy note:** other documents in this repository say "there is no test suite, do not add a test framework." That instruction is **withdrawn by the operator as of 2026-07-26.** Restoring a working test suite is Phase A of this task. Do not treat the old instruction as binding, and do not cite it back as a reason to skip Phase A.

---

## 1. Why this task exists

Eight files are too large — roughly 42,000 lines between them:

| File | Lines | Phase B section |
|---|---|---|
| `apps/server/src/app.ts` | 15,376 | B.2, B.4 |
| `packages/agents/src/coordination-v3-store.ts` | 7,009 | B.2, B.4 |
| `packages/agents/src/store.ts` | 5,403 | B.2, B.4 |
| `apps/web/src/components/AgentDetail.tsx` | 2,492 | B.5 |
| `apps/web/src/components/ConversationView.tsx` | 2,231 | B.5 |
| `packages/core/src/dto.ts` | 2,031 | B.3 |
| `apps/web/src/components/chat/Composer.tsx` | 1,770 | B.5 |
| `apps/web/src/components/WorkspaceSidebar.tsx` | 1,666 | B.5 |

**All eight are in scope. Do not narrow it.** If something turns out to be genuinely unsafe to decompose, the answer is to do every other part in full and report precisely what you stopped short of and why — not to quietly reduce the scope.

The parts that are cheap to fix — module-scope functions, the DTO split — are pure code motion and safe without tests. The parts that actually matter — the ~190 routes inside `createServer`, the ~159-method `CoordinationV3Store`, the ~175-method `AgentStore` — move state across SQLite transaction boundaries and closure captures. Doing those without a safety net is the thing that has blocked this work.

**So build the net first, then do the work behind it.** That is Phase A and Phase B below.

## 2. Harvest the old suite — do not restore it

**Read this before touching the old tests.** They were not deleted for being stale. They were deleted because of how they were built, and rebuilding that shape is a failure of this task:

- `apps/server/test/app.test.ts` was 12,903 lines against a 14,603-line `app.ts` — a near 1:1 mirror of the implementation rather than a test of behavior.
- It reached into internals through **15 helpers exported from `app.ts` solely for tests.** Those 15 exports still exist today with **zero consumers.**
- Test files were touched 1,369 times across 580 commits, because they were pinned to behavior that had not stabilized.

**The deliverable is a small suite that drives public APIs**, using the old suite as raw material — 271 already-written behavioral cases someone thought carefully about — not as something to restore.

Concretely:

- **Never write a test that depends on a symbol exported from `app.ts` only for testing.** Drive the server through `app.inject()` and the stores through their public methods. If a behavior is unreachable that way, that is a finding to report, not a reason to add an export.
- **The 15 zero-consumer exports are cleanup candidates, not fixtures.** Identify them and list them in your report. Do not build new tests on them, and do not delete them in this PR either — flag them.
- **Cap the recovery.** If restoring a file means reproducing a large mirror of implementation detail, harvest the handful of behavioral cases worth keeping and drop the rest. A 400-line file of real behavioral assertions beats a recovered 12,903-line one, and is what you should produce.

With that framing, the mechanics:

Commit `b6ec419` ("Deleted all tests and starter pack") removed **145 test files, ~36,948 lines**, on 2026-07-24. Its parent, **`71ec201a042ce8ea159b71a9abb0aaba83c916d3`**, is the last commit with the full suite intact.

The harness was never removed: `vitest@^2.1.8` is still a dependency in five packages, and every package still has a wired `test` script. There is nothing to install and no framework to choose.

Suite composition at `71ec201`:

| Package | Test files | Source files changed since |
|---|---|---|
| `apps/server` | 26 | **2** |
| `packages/engines` | 12 | 9 |
| `packages/agents` | 11 | 50 |
| `apps/web` | 95 | 74 |
| `apps/launcher` | 1 | 0 |

**Read that table before planning your order.** `apps/server` holds the tests that protect `app.ts` and the route layer, and its source has barely moved — those should mostly still pass. `packages/agents` protects the two store classes you will later split, so it is worth real effort even where tests need updating. `apps/web` is 95 files against heavy churn, and web components are **not** part of this decomposition — deprioritize it.

Recover a file with:

```bash
git show 71ec201:<path> > <path>
```

---

## PHASE A — build a working net

### A.1 Triage, in this order

1. `apps/server` (26 files) — highest value, lowest drift.
2. `packages/agents` (11 files) — protects `store.ts` and `coordination-v3-store.ts`.
3. `packages/engines` (12 files) — protects the adapters.
4. `apps/launcher` (1 file).
5. `apps/web` (95 files) — required, because B.5 decomposes four large web components and needs a net. This is the most drifted package (74 source files changed since `71ec201`), so expect the heaviest triage here and apply the §2 cap aggressively: harvest the behavioral cases that cover the four B.5 target components, drop mirrors of implementation detail. **Prioritize tests touching `AgentDetail`, `ConversationView`, `Composer`, and `WorkspaceSidebar`;** everything else in `apps/web` is lower value.

For each file: recover it, run it, and sort it into one of four buckets.

| Bucket | Meaning | Action |
|---|---|---|
| **Passes** | Green as recovered | Keep unchanged. |
| **Cheap fix** | Fails on a renamed import, moved symbol, changed DTO field, or new required argument | Fix the **test**, never the source. Keep. |
| **Behavior changed** | Fails because the product genuinely behaves differently now | Update the assertion to current behavior **and record the before/after in your report.** This is the important bucket — see A.3. |
| **Stale** | Tests a feature that no longer exists | Delete. List it with the reason. |

### A.2 Rules

- **Never change source code to make a test pass in Phase A.** If a test fails because the source has a real bug, that is a finding — report it, quarantine the test with `it.skip` and a comment naming the reason, and move on. Fixing product bugs is not this task.
- **Do not delete a test because it is inconvenient.** "Stale" means the feature is gone, not that the test is hard.
- Four features landed after `71ec201` and have no tests at all: context rollover with native commands (PR #320), Claude model selection (#322), the provider usage center (#323), and the command-provenance enum split. **You are not required to write tests for these**, but note in your report which recovered tests you had to update because of them.

### A.3 The bucket that matters

Every test in "behavior changed" is a place where the product's behavior moved in the last two days and nothing recorded it. Report each one as: file, what the test used to assert, what it asserts now, and which commit or feature you believe changed it. This is the most valuable output of Phase A regardless of what happens in Phase B.

### A.4 Judge the net before you trust it

**A recovered suite being green does not mean it covers the work you are about to do.** Two things were measured at `71ec201` and you should verify both rather than assume them:

*The tests are the right kind.* `apps/server/test/app.test.ts` is 12,903 lines / 271 tests and its assertions are behavioral — names like "requires browser authentication, exact active-run ownership, and tears down after the run." Behavioral assertions survive code motion and go red on real breakage, which is what a refactor net needs.

*The coverage is lopsided against this job.* Across all 11 `packages/agents` test files, references to `transaction|BEGIN|ROLLBACK|COMMIT|savepoint` total **eight** — four in `coordination-v3-deletion.test.ts`, two each in `store.test.ts` and `coordination-v3-store.test.ts`, and **zero in the other eight files.** Transaction boundaries are exactly what breaks when a store class is split.

So: the recovered suite is a strong net for route extraction (B.4 step 2) and a **weak one for the store split (B.4 step 1).** Do not treat a green suite as permission for the latter. See A.5.

### A.5 Fill the gap with characterization tests

Before B.4 step 1, and only for the state and transaction semantics the recovered suite does not cover, write new tests. These are **characterization tests**: they pin what the code does *today*, not what it should do. If current behavior looks wrong, pin it anyway and report it — changing it is not this task.

Cover, against a temporary SQLite database:

- For each method cluster you intend to split out of `CoordinationV3Store` and `AgentStore`: its observable effect on the database, including rows written, rows not written, and returned values.
- **Transaction semantics specifically:** that a failure mid-sequence rolls back what it should and leaves committed what it should; that methods assuming an ambient transaction still behave correctly when composed; that concurrent or interleaved calls produce the same end state they do today.
- Any invariant the class enforces across methods — uniqueness, ordering, cascade deletion, capacity limits.

Keep this **small and targeted**. It exists to make one specific refactor safe, not to achieve coverage. If a cluster turns out to be untestable without restructuring, that is itself the finding: **it means the cluster should not be split**, and you should say so and leave it alone.

### A.6 Gate

Phase A ends when `pnpm test` is green for `apps/server`, `packages/agents`, and `packages/engines`, and the A.5 characterization tests exist and pass for every store cluster you intend to touch in B.4.

**Report the triage table before starting Phase B.** Do not stop and wait for a reply — continue into Phase B — but the report must be written and must precede the Phase B work in your final output, so the two phases can be reviewed independently.

If fewer than half the `apps/server` tests survive, **stop and report instead of continuing.** That would mean the drift is much worse than measured and the plan needs revisiting.

### A.7 Commit discipline

One commit per package. Test recovery commits must contain **no source changes whatsoever** — `git diff --name-only` on each Phase A commit must show only test files and, where genuinely unavoidable, a `package.json` script fix.

---

## Parallelizing with subagents

This task is large enough that you should delegate. Doing so correctly is part of the job; doing it carelessly produces merge conflicts that cost more than the parallelism saved.

**The one inviolable rule: one file, one agent.** Never have two agents editing the same file, in the same wave or across waves. Partition by file, never by task type — "one agent does all the module-scope extraction" puts several agents in different files but "one agent does helpers, another does hooks" puts two in the same file.

Every agent you dispatch must receive the §B.1 universal rules verbatim. They are the contract, and an agent that has not read them will "improve" something.

Run in waves. **Each wave fully lands — build, `pnpm typecheck`, `pnpm test` all green on the integration branch — before the next begins.**

**Wave 0 — Phase A (parallel by package).** Test harvest is naturally parallel: five packages, five independent `test/` directories, and no source changes at all. One agent per package. The `apps/web` triage is the largest; give it the most room.

**Wave 1 — module scope, `dto.ts`, and React Pass 1 (parallel, one agent per file).**

| Agent | File |
|---|---|
| 1 | `apps/server/src/app.ts` — module scope only |
| 2 | `packages/agents/src/coordination-v3-store.ts` — module scope only |
| 3 | `packages/agents/src/store.ts` — module scope only |
| 4 | `packages/core/src/dto.ts` — full domain split |
| 5–8 | One per React file, **Pass 1 (pure helpers) only** |

Agents 2 and 3 both create sibling modules in `packages/agents/src/`. **Assign each a filename prefix up front** so they cannot collide on a new file name.

Agent 4 is the one that can break everyone else: `dto.ts` is in `core`, which all four other packages depend on. The barrel invariant is what makes it safe — if the barrel preserves every export, no consumer notices. **Verify agent 4's barrel by building all five packages before landing it**, and land it first within the wave.

**Wave 2 — React Passes 2 and 3 (parallel, one agent per file).** Four agents, one per component, each doing presentational extraction then hooks. Independent files, so genuinely parallel — but hook extraction is the riskiest work in the task, so require the full suite green per pass per file.

**Wave 3 — store class splits (parallel, one agent per class).** `CoordinationV3Store` and `AgentStore` are independent of each other. Each agent must first produce the private-state and transaction-boundary maps from B.4, and must have the A.5 characterization tests green for its class before moving a single method.

**Wave 4 — route extraction (serial, single agent, no delegation).** Every domain shares one `ServerContext` and one file. Parallelizing this creates guaranteed conflicts in `app.ts` and in the context's shape. One agent, one domain per commit, full suite green after each.

**What you keep for yourself:** designing `ServerContext`, integrating each wave, and adjudicating any agent that reports a behavior change. Do not delegate the judgment calls — "should this class be split," "is this red test structural or behavioral," "can this component survive Pass 3" — those come back to you with evidence, and you decide.

## PHASE B — decompose behind the net

Do not begin until Phase A's gate is met.

### B.1 Universal rules

1. **Pure motion for everything in B.2 and B.3.** Do not rename. Do not change a signature, parameter order, default, return type, or a line of a body. Do not clean up, simplify, modernize, or add JSDoc. If tempted to improve something, don't — note it in your report.
2. **Verify closure-freedom before moving each function.** It qualifies only if it references nothing from the scope you are moving it out of. If it captures, leave it and list it.
3. **Preserve every `export`** and **every existing import path.** No file outside the eight targets may need editing. Where a file is split, re-export from the original path. This includes the 15 test-only exports from §2 — **preserve them, do not build on them, and do not delete them here.** Removing them is a separate decision for the operator, and this PR is already large.
4. **Preserve comments** verbatim, including ones referencing `SPEC §`.
5. **One module per commit**, with the affected package's build, `pnpm typecheck`, and `pnpm test` all green before moving on.
6. **The suite is the contract — but distinguish two kinds of red.** When a green test goes red, decide which it is before touching anything:

   - **It asserts behavior** (a value, a database row, a status code, an emitted event) → your change broke something. **Revert and reconsider. Never edit the test.**
   - **It asserts structure** (it imports a symbol from a path you moved, spies on a module-internal function, or asserts on file layout) → the test was coupled to implementation, and moving the code is not a behavior change. Update the test's import or seam, keep the assertion identical, and **list every such edit individually in your report.**

   The second case is legitimate and expected during pure motion. It is also the easiest place to hide a real break, so the report must show that the assertion itself did not change. If you cannot tell which case you are in, treat it as the first.

### B.2 Module-scope extraction (pure motion)

Move standalone functions out of the three code files into cohesive sibling modules. Group by cohesion, not size — three related functions beat a grab-bag of twelve.

**`apps/server/src/app.ts`** — 76 functions in lines 1–1,797. All 58 below were confirmed present at `998ae0b`:

| New module | Candidate contents |
|---|---|
| `prompts.ts` | `boundedSeedHistory`, `boundedContinuationHistory`, `runtimeIdentityPrompt`, `communicationV3Prompt`, `conversationPrompt`, `individualChatPrompt`, `continuationPrompt`, `contextSection`, `messageContextPrompt`, `sharedRequestCompletionPrompt`, `directUserRequestCompletionPrompt`, `teamDirectoryPrompt`, `olderContextPrompt`, `sharedBroadcastContextPrompt`, `managerRelationshipPrompt`, `mergeScopedContextSources`, `byteBoundScopedContext`, `boundedHistoryOmitted` |
| `cursors.ts` | `encodeTimelineCursor`, `decodeTimelineCursor`, `encodeActivityOutputCursor`, `decodeActivityOutputCursor`, `encodeResultCursor`, `decodeResultCursor`, `parseResultRef` |
| `agent-mentions.ts` | `agentMentionHandle`, `mentionRelayFingerprint`, `advanceMentionTrail`, `mentionedAgents`, `hasEveryoneMention`, `stripLeadingScopeTag`, `renderScopedMessage`, `inboundContext` |
| `git-status.ts` | `runGit`, `parseGitStatus`, `workspaceStatus`, `workspaceFile`, `isWorkspaceReviewPathAllowed` |
| `artifact-refs.ts` | `collectReachableArtifactIds`, `rewritePortableArtifactReferences`, `canonicalArtifactReferenceMatches`, `portableAgentTopologyError` |
| `static-content.ts` | `contentTypeForStatic`, `cacheControlForStatic`, `contentTypeForArtifact`, `acceptsGzip`, `utf8Page`, `utf8PageEnd`, `boundedUtf8Preview` |
| `runtime-selection.ts` | `runtimeSelectionError`, `normalizedRuntimeSelection`, `concreteRuntimeSelection`, `providerSessionContractHash` |
| `conversation-titles.ts` | `conciseConversationTitle`, `semanticConversationTitle` |
| `notification-routing.ts` | `notificationKindForCommunication`, `notificationPreferenceMatches`, `workspaceAgentEventCategory` |

The other 18 are ungrouped — assess each yourself. Rough clusters to evaluate, not to trust: path/filesystem safety (`pathExists`, `readScopedPath`, `safeRelativePath`, `isProjectFileReferenceAllowed`); SSE and events (`writeSse`, `envelope`, `isAgentStreamEvent`); external content (`externalFaviconTarget`, `loadExternalFavicon`, `normalizeExternalCitations`); communication scoping (`canonicalAudienceIncludes`, `organizationalMasterMessages`, `recipientCollaborationMessages`, `agentMessageEndpoint`); unclustered (`derivedRunActionKey`, `parseTokenUsageRange`, `secretEqual`, `sendInspectorJson`).

⚠️ **`secretEqual` is security-sensitive** — almost certainly a timing-safe comparison guarding a credential check. Move it verbatim or leave it. Do not touch its body, do not "simplify" it to `===`, and state in your report what you did with it.

**`packages/agents/src/coordination-v3-store.ts`** — 12 module-scope functions before `class CoordinationV3Store` (line 801); `PendingActivationCapacityError` at line 591.

**`packages/agents/src/store.ts`** — 16 module-scope functions before `class AgentStore` (line 525); `AgentDeletionConflictError` at line 341, which is exported and may be caught by consumers — verify every consumer still resolves it through the original import path.

### B.3 `packages/core/src/dto.ts` — split by domain

199 exported declarations, exactly one function. Types have no runtime behavior, so this is the safest extraction in the set.

Split into `packages/core/src/dto/` by what the types describe (agents, projects, conversations, runs, artifacts/assets, triggers, workspace, provider/engine, events) and make `dto.ts` a barrel re-exporting all of them. **The barrel is not optional** — every existing `import { XDto } from ".../dto.js"` across all five packages must resolve unchanged. Verify by building every package, not by reasoning about it.

Keep imports between the new modules acyclic. If two domains genuinely reference each other, put the shared types in `dto/common.ts` rather than creating a cycle.

### B.4 The hard extractions — now in scope

These are why Phase A exists. Attempt them **only** with the suite green, and take them in this order, smallest risk first.

**1. Store classes.** For `CoordinationV3Store` and `AgentStore`, before moving anything, produce for yourself:

- A method inventory by responsibility cluster.
- A private-state map: every private field, and which clusters touch it. A cluster touching state nothing else touches is a split candidate; one sharing state with three others is not.
- A transaction-boundary map: which methods open, participate in, or assume an ambient SQLite transaction. **This decides whether a split is safe at all** — a method group that looks independent but shares a transaction scope cannot move without changing correctness.

Then split only the clusters the state and transaction maps show are genuinely independent. Delegation from the original class is acceptable so callers do not change. **"This class should not be split" is an acceptable and useful verdict** if the analysis supports it — say so and stop, rather than forcing a split the evidence does not support.

**2. Routes out of `createServer`.** Design and implement a `ServerContext` carrying the closure state routes depend on (`store`, `coordinationV3`, `coordinationV3Scheduler`, `activeRuns`, `runtimeAuthorities`, `assets`, `appendWorkspace`, `deletingAgentIds`, `providerUsage`, and the rest you find). Extract route domains into sibling modules that receive it.

Go **one domain per commit**, with the full suite green after each. Order by the capture analysis: fewest captures and read-only first, most entangled last. Stop when the remaining domains are genuinely entangled rather than forcing them — a partial extraction that keeps the suite green is a better outcome than a complete one that does not.

Hazards to check as you go: shared mutable state written from more than one domain, ordering dependencies between registrations, Fastify hooks that must run before or after specific routes, closure variables captured by both routes and the run executor, and anything wired into the daemon's pending-work counter or shutdown drain.

### B.5 React components

Four files, ~8,100 lines total:

| File | Lines |
|---|---|
| `apps/web/src/components/AgentDetail.tsx` | 2,492 |
| `apps/web/src/components/ConversationView.tsx` | 2,231 |
| `apps/web/src/components/chat/Composer.tsx` | 1,770 |
| `apps/web/src/components/WorkspaceSidebar.tsx` | 1,666 |

This is the least mechanical work in the task. React components are not pure motion — hook order is semantically load-bearing, and a subcomponent split changes render and memoization boundaries. **Take each file in three passes, in this order, easiest and safest first.** Commit after each pass with the web build, `pnpm typecheck`, and `pnpm test` green.

**Pass 1 — pure helpers.** Formatters, predicates, label/sort/filter builders, type guards — anything in the file that neither calls a hook nor touches component scope. These are genuine pure motion; move them to a sibling `*.helpers.ts` and apply the B.1 rules and byte-identity evidence exactly as for B.2.

**Pass 2 — presentational subcomponents.** JSX chunks that render from props and call no hooks (or only `useMemo`/`useCallback` over their own props). Extract to sibling files.
- Props must be passed explicitly. **Do not introduce context to avoid prop threading** — that changes update semantics.
- Preserve `key` props and list identity exactly; a changed key changes reconciliation and remount behavior.
- If the chunk was inside a `useMemo`, keep it inside one.

**Pass 3 — custom hooks.** Stateful logic groups extracted to `use*.ts` siblings. This is the risky pass:
- **Hook call order must be identical.** React identifies hook state by call order, so a reordered, conditional, or newly-branched hook call is a behavior change, not a refactor. Extracting several `useState` calls into one custom hook is fine only if the resulting call order matches the original exactly.
- Never place a hook call behind a condition or an early return.
- Preserve every dependency array verbatim. If a dependency array looks wrong, **leave it and report it** — a "fixed" dependency array changes when effects fire.
- Keep effect cleanup functions attached to the same effect.

**If a pass on a given file cannot be done without changing behavior, stop at the previous pass for that file and report it.** Three files fully decomposed and one stopped at Pass 2 is a good outcome; four files with a subtly changed render path is not.

### B.7 Out of scope

- Behavior changes, bug fixes, performance changes, dependency changes.
- Renaming exports or changing any module's public surface.
- Restyling, restructuring JSX, or "modernizing" component patterns while extracting.

If you believe one is necessary, **stop and report** instead of doing it.

### B.6 Proving pure motion

For B.2 and B.3, your report must demonstrate motion, not assert it. A workable method: extract each moved declaration's text from `git show <base>:<original path>` and from the new module and confirm byte-identity apart from leading indentation. State your method and result. For `dto.ts`, state how you verified the barrel preserves every export name.

For B.4, byte-identity will not hold where a signature genuinely changes. Instead, list every signature that changed and why, and lean on the suite as the evidence.

---

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

All must pass. Additionally confirm the exported surface of all eight target files is unchanged — same symbols, same types, same import paths. For the four React components, the default export and its props type must be unchanged.

## Report

**Phase A**
1. Triage table: per package, how many recovered / passed / cheap-fixed / behavior-changed / deleted-stale.
2. Every "behavior changed" test: file, old assertion, new assertion, and the commit or feature you believe changed it.
3. Every test you quarantined with `it.skip`, and the suspected source bug behind it.
4. Every test you deleted as stale, with the reason.
5. **Your assessment of the net's coverage against the work in B.4** — which parts of the recovered suite genuinely protect what you are moving, and where it does not.
6. The A.5 characterization tests you wrote: what each pins, and any cluster you found untestable without restructuring (which means it should not be split).
7. Final `pnpm test` output per package.

**Phase B**
8. Before/after line counts for all eight files.
9. Per new module: what moved, and the byte-identity evidence. What you did with `secretEqual`.
10. For `dto.ts`: how you verified the barrel preserves every export and consumer path.
11. **Every structurally-coupled test you edited under B.1 rule 6**, showing that the assertion itself is unchanged and only the import or seam moved.
12. For the store classes: the private-state and transaction-boundary maps, and your verdict per class — including "should not be split" if that is the answer.
13. For routes: which domains you extracted, which you did not, and why. The `ServerContext` you implemented.
14. For each React file: which of the three passes it reached, and if it stopped early, the specific behavior change that would have been required to continue. Every dependency array or `key` you left alone despite thinking it wrong.
15. Anything you declined to move and precisely why.
16. Anything that looked wrong but you deliberately did not change. List it; do not fix it.

**Delegation**
17. Which agents you dispatched per wave and the file each owned. Confirm no file was touched by two agents.
18. Any wave that did not land green on the first integration attempt, and what the conflict or failure was.

**Git hygiene:** branch, base commit, head commit, `git status` clean. Phase A commits must contain no source changes.

Do not open the PR until you have reported and been told to proceed.
