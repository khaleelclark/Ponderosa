# Ponderosa — `app.ts` Decomposition, Phase 1

You are a coding agent working in the Ponderosa repository. You have no prior context; this document is self-contained.

This is **not a rewrite**. A rewrite was considered and explicitly rejected: the architecture is sound, `pnpm typecheck` passes clean, and there are zero `as any`, zero `@ts-ignore`, and zero TODO/FIXME across 66k lines. The single defect is that one file is too large. You are fixing that defect and nothing else.

**Measurements in this document were taken at `master` = `3de2688` (the PR #322 merge). Re-measure before you start** — if the numbers below are off by more than a few lines, something landed in between; report that and confirm before proceeding.

---

## 1. Context

Ponderosa is a self-hosted web workbench that runs organizations of AI agents through subscription-backed provider CLIs. Layout:

| Path | Role |
|---|---|
| `packages/core` | Shared types and DTOs. |
| `packages/engines` | Provider adapters (Codex, Claude). |
| `packages/agents` | SQLite runtime state and event-log projections. |
| `apps/server` | Fastify daemon. **`src/app.ts` is 15,376 lines — the subject of this work.** |
| `apps/web` | React + MUI client. |

Read `AGENTS.md` at the repo root and follow it: branch, PR, independent reviewer, never commit to `master`. (It links to several governing documents that no longer exist — ignore the dead links; they are pre-existing and not your concern.)

Build order: `core → agents → engines → server → web`.

**There is no test suite.** It was deleted deliberately on 2026-07-24. `pnpm test` failing for that reason is pre-existing. Do not add a test framework. Your safety net is the TypeScript compiler and the fact that this work is pure code motion.

## 2. The shape of the problem

```
apps/server/src/app.ts          15,376 lines total
├── lines 1–1,797               module scope: 76 standalone functions
└── lines 1,798–15,376          export function createServer(...) { ... }
                                one ~13,578-line closure holding ~190 route registrations
```

The closure is the hard problem: routes capture closure state (`store`, `coordinationV3`, `activeRuns`, and dozens more), so extracting them requires designing a context seam first — real refactoring, not motion.

The module scope is the easy problem: those 76 functions are already outside the closure. Moving them is **pure code motion** — cut, paste, add imports, done.

**Phase 1 (this document) does the easy problem, and produces the analysis needed to plan the hard one.** You are not extracting routes.

## 3. Deliverable 1 — extract module-scope helpers (code)

Move the standalone functions in lines 1–1,797 out of `app.ts` into cohesive sibling modules under `apps/server/src/`.

### Rules — read carefully, these are the whole job

1. **Pure motion only.** Do not rename anything. Do not change a signature, a parameter order, a default, a return type, or a single line of a function body. Do not "clean up," "simplify," "modernize," or add JSDoc. If you are tempted to improve something, don't — note it in your report instead.
2. **Verify closure-freedom before moving each function.** A function qualifies only if it references nothing defined inside `createServer`. Check every identifier in its body. If a function turns out to capture closure state, **leave it in `app.ts`** and list it in your report.
3. **Preserve every `export`.** Several of these are exported only because now-deleted tests imported them. Keep the exports — future tests will want them, and removing them is a behavior change to the module's public surface.
4. **Preserve comments** attached to moved functions, verbatim, including the ones referencing `SPEC §`. Do not update or delete them.
5. **One module per commit**, each with `pnpm --filter @ponderosa/server build` and `pnpm typecheck` green before you move on. If a module's extraction goes wrong, that commit is trivially revertible.
6. **Do not touch anything at or below line 1,798** (`createServer` and its body) except to add import statements at the top of the file and to delete the moved function definitions.

### Suggested grouping

Verify actual dependencies before committing to this — it is a starting proposal, not a specification. Group by cohesion, not by size; a module of three closely-related functions is better than a grab-bag of twelve. **All 58 functions in the table below were confirmed present at `3de2688`.**

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

**The remaining 18 module-scope functions** are not in the table above. Assess each one yourself — some may belong in the modules above, some may form their own, some may capture closure state and have to stay. Rough clusters to evaluate, not to trust:

| Apparent cluster | Functions |
|---|---|
| Path and filesystem safety | `pathExists`, `readScopedPath`, `safeRelativePath`, `isProjectFileReferenceAllowed` |
| SSE and event streaming | `writeSse`, `envelope`, `isAgentStreamEvent` |
| External content fetching | `externalFaviconTarget`, `loadExternalFavicon`, `normalizeExternalCitations` |
| Communication scoping | `canonicalAudienceIncludes`, `organizationalMasterMessages`, `recipientCollaborationMessages`, `agentMessageEndpoint` |
| Unclustered | `derivedRunActionKey`, `parseTokenUsageRange`, `secretEqual`, `sendInspectorJson` |

⚠️ **`secretEqual` is security-sensitive** — it is almost certainly a timing-safe comparison guarding a credential or token check. Move it verbatim or leave it in place. Do not touch its body, do not "simplify" it to `===`, and state in your report exactly what you did with it.

Anything that doesn't fit a cohesive group: leave it in `app.ts` and say so. A leftover is better than a junk-drawer module.

### Proving it was pure motion

Your report must demonstrate this, not assert it. A workable method: for each moved function, extract its body from `git show <base>:apps/server/src/app.ts` and from the new module, and confirm the text is byte-identical apart from leading indentation. State the method you used and the result.

**Expected outcome:** `app.ts` drops to roughly 13,700–13,900 lines with zero behavior change.

## 4. Deliverable 2 — closure decomposition map (document, no code)

Write `docs/APP_TS_DECOMPOSITION_MAP.md`. This is analysis to make the *next* phase safe. **Change no code for this deliverable.**

It must contain:

1. **Route inventory.** Every route registration inside `createServer` (~190 at `3de2688`; count them yourself), grouped into coherent domains (e.g. projects, conversations, agents, agent-tools, triggers, assets/artifacts, workspace, browser, launcher/deployment, wiki, provider usage). For each domain: the route paths, the approximate line range, and the route count.
2. **Capture analysis per domain.** The specific `createServer`-scope identifiers each domain reads or mutates — `store`, `coordinationV3`, `coordinationV3Scheduler`, `activeRuns`, `runtimeAuthorities`, `assets`, `appendWorkspace`, `deletingAgentIds`, `providerUsage`, and so on. This is the critical section: it is what determines whether a domain can be extracted behind a context object or whether it is entangled.
3. **Mutable-state map.** Every mutable structure declared in the closure (the `Map`s and `Set`s tracking active runs, runtime authority, deletion state, scheduled rollovers, capability tokens, provider-usage caching, and the rest). For each: which domains read it, which mutate it, and whether mutation is confined to one domain or spread across several. **Anything mutated from more than one domain is an extraction hazard** — call it out explicitly.
4. **Risk-ranked extraction order.** Which domains can move first (few captures, read-only, self-contained), which need a context seam designed first, and which should not be attempted until later. Justify the ranking with the capture data, not with intuition.
5. **Proposed `ServerContext` shape.** A TypeScript interface sketch of what a route module would need to receive. Do not implement it — sketch it.
6. **Explicit hazards.** Anything you find that would make naive extraction unsafe: shared mutable state, ordering dependencies between route registrations, Fastify hooks that must run before/after specific routes, closure variables captured by both routes and the run executor, and anything wired into the daemon's pending-work counter or shutdown drain.

Be honest where the answer is "this domain is too entangled to extract cleanly." That finding is more valuable than an optimistic plan.

## 5. Out of scope — do not do these

- Extracting any route from `createServer`.
- Extracting the run executor or the runtime-authority registry.
- Implementing `ServerContext`.
- Any behavior change, bug fix, performance change, or dependency change.
- Adding tests or a test framework.
- Touching `apps/web`, `packages/*`, or any file other than `apps/server/src/app.ts`, the new sibling modules, and the new doc.
- Renaming exports or changing the module's public surface.

If you believe one of these is necessary, **stop and report** instead of doing it.

## 6. Verification

```bash
pnpm --filter @ponderosa/core build && \
pnpm --filter @ponderosa/agents build && \
pnpm --filter @ponderosa/engines build && \
pnpm --filter @ponderosa/server build && \
pnpm --filter @ponderosa/web build
pnpm typecheck
git diff --check
```

All must pass. Additionally, confirm by inspection that the server's exported surface from `app.ts` is unchanged — the same symbols are exported, with the same types.

## 7. Report

1. Branch, base commit, head commit, `git status` (clean).
2. Line count of `app.ts` before and after, and the module-scope function count before and after.
3. Per new module: which functions moved, and the byte-identity evidence for the move.
4. Any function you **declined to move** and precisely why (closure capture, no cohesive home, or other). State explicitly what you did with `secretEqual`.
5. Anything you noticed that looked wrong but deliberately did not change — dead code, suspicious logic, duplicated helpers. List it; do not fix it.
6. The decomposition map, plus your headline judgment: which domains are genuinely extractable next, and which are entangled.
7. Verification command output.

Do not open the PR until you have reported and been told to proceed.
