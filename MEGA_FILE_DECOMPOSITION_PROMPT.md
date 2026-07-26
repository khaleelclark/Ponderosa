# Ponderosa — Mega-File Decomposition

You are a coding agent working in the Ponderosa repository. You have no prior context; this document is self-contained.

**This supersedes `APP_TS_DECOMPOSITION_PHASE1_PROMPT.md`.** That document covered one file; this covers all four and is the version to follow.

This is **not a rewrite**. A rewrite was considered and explicitly rejected: the architecture is sound, `pnpm typecheck` passes clean, and there are zero `as any`, zero `@ts-ignore`, and zero TODO/FIXME across 66k lines. The defect is that four files are too large. You are fixing that and nothing else.

**Measurements below were taken at `master` = `998ae0b` (the PR #323 merge). Re-measure before you start.** If any number is off by more than a few lines, something landed in between — report it and confirm before proceeding.

---

## 1. Context

Ponderosa is a self-hosted web workbench that runs organizations of AI agents through subscription-backed provider CLIs.

| Path | Role |
|---|---|
| `packages/core` | Shared types and DTOs. |
| `packages/engines` | Provider adapters (Codex, Claude). |
| `packages/agents` | SQLite runtime state and event-log projections. |
| `apps/server` | Fastify daemon. |
| `apps/web` | React + MUI client. |

Read `AGENTS.md` at the repo root and follow it: branch, PR, independent reviewer, never commit to `master`. It links to several governing documents that no longer exist — ignore the dead links; they are pre-existing and not your concern.

Build order: `core → agents → engines → server → web`.

**There is no test suite.** It was deleted deliberately on 2026-07-24. `pnpm test` failing for that reason is pre-existing. Do not add a test framework. Your safety net is the TypeScript compiler and the fact that everything you are asked to move is pure code motion.

## 2. The four targets

| File | Lines | Shape |
|---|---|---|
| `apps/server/src/app.ts` | 15,376 | Lines 1–1,797: 76 module-scope functions. Line 1,798+: `createServer` — one ~13,578-line closure holding ~190 route registrations. |
| `packages/agents/src/coordination-v3-store.ts` | 7,009 | ~800 lines of module scope (12 functions, plus `PendingActivationCapacityError` at line 591). Line 801+: `class CoordinationV3Store` — ~159 methods. |
| `packages/agents/src/store.ts` | 5,403 | ~520 lines of module scope (16 functions, plus `AgentDeletionConflictError` at line 341). Line 525+: `class AgentStore` — ~175 methods. |
| `packages/core/src/dto.ts` | 2,031 | 199 exported interfaces/types/enums/consts. Exactly one function. Essentially pure type declarations. |

## 3. What is in scope, and what is deliberately not

**In scope — all of this is pure motion:**

- Module-scope functions in `app.ts`, `coordination-v3-store.ts`, and `store.ts` that do not capture enclosing state.
- Splitting `dto.ts` by domain behind a barrel that preserves every existing import path.
- Class methods that never reference `this` (see §5.3).

**Explicitly out of scope — do not attempt these, in this PR or any follow-up you invent:**

- **Extracting routes from `createServer`.** They capture closure state (`store`, `coordinationV3`, `activeRuns`, `runtimeAuthorities`, `providerUsage`, and dozens more). Extraction requires designing a context seam first. That is real refactoring, not motion.
- **Splitting `CoordinationV3Store` or `AgentStore` into multiple classes.** Their methods share private state across SQLite transaction boundaries. Mixins, delegation, or state-splitting are all design decisions with real correctness risk, and there is no test suite to catch a regression. Do not do it mechanically.
- **Decomposing React components** (`AgentDetail.tsx` 2,492, `ConversationView.tsx` 2,231, `Composer.tsx` 1,770, `WorkspaceSidebar.tsx` 1,666). Hook ordering and prop threading make this behavior-affecting. Separate work.

If you believe an out-of-scope item is necessary, **stop and report** instead of doing it. Deliverable 2 exists so the excluded work can be planned properly.

## 4. Universal rules — these are the whole job

1. **Pure motion only.** Do not rename anything. Do not change a signature, a parameter order, a default, a return type, or a single line of a function body. Do not "clean up," "simplify," "modernize," or add JSDoc. If you are tempted to improve something, don't — note it in your report.
2. **Verify closure-freedom before moving each function.** A function qualifies only if it references nothing defined inside the enclosing scope you are moving it out of. Check every identifier in its body. If it captures, **leave it where it is** and list it in your report.
3. **Preserve every `export`.** Several exist only because now-deleted tests imported them. Keep them — removing an export is a behavior change to the module's public surface.
4. **Preserve comments** attached to moved code, verbatim, including ones referencing `SPEC §`. Do not update or delete them.
5. **Preserve every existing import path.** No consumer outside these four files may need editing. Where a file is split, re-export from the original path.
6. **One module per commit**, each with the affected package's build and `pnpm typecheck` green before you move on. If an extraction goes wrong, that commit is trivially revertible.
7. **Do not touch the closure or class bodies** except to delete definitions you moved out and add imports at the top of the file.

## 5. Deliverable 1 — the extractions

### 5.1 `apps/server/src/app.ts` — 76 module-scope functions

**All 58 functions in this table were confirmed present at `998ae0b`.** Verify actual dependencies before committing to the grouping — it is a starting proposal, not a specification. Group by cohesion, not size; three closely-related functions beat a grab-bag of twelve.

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

**The remaining 18** are not grouped above. Assess each yourself — some belong in the modules above, some form their own, some may capture state and have to stay. Rough clusters to evaluate, not to trust:

| Apparent cluster | Functions |
|---|---|
| Path and filesystem safety | `pathExists`, `readScopedPath`, `safeRelativePath`, `isProjectFileReferenceAllowed` |
| SSE and event streaming | `writeSse`, `envelope`, `isAgentStreamEvent` |
| External content fetching | `externalFaviconTarget`, `loadExternalFavicon`, `normalizeExternalCitations` |
| Communication scoping | `canonicalAudienceIncludes`, `organizationalMasterMessages`, `recipientCollaborationMessages`, `agentMessageEndpoint` |
| Unclustered | `derivedRunActionKey`, `parseTokenUsageRange`, `secretEqual`, `sendInspectorJson` |

⚠️ **`secretEqual` is security-sensitive** — almost certainly a timing-safe comparison guarding a credential or token check. Move it verbatim or leave it in place. Do not touch its body, do not "simplify" it to `===`, and state in your report exactly what you did with it.

Anything without a cohesive home: leave it in `app.ts` and say so. A leftover beats a junk-drawer module.

**Expected:** `app.ts` drops to roughly 13,700–13,900 lines.

### 5.2 `packages/agents/src/coordination-v3-store.ts` and `store.ts`

Same operation, smaller surface. Extract the module-scope functions (12 and 16 respectively) that precede each class, into cohesive sibling modules under `packages/agents/src/`.

Both files also declare error classes at module scope — `PendingActivationCapacityError` (coordination-v3-store.ts:591) and `AgentDeletionConflictError` (store.ts:341). Move these only if they are referenced by code you are also moving, or if they have a clear home; `AgentDeletionConflictError` is exported and may be caught by consumers, so **verify every consumer still resolves it through the original import path**.

**Do not touch the class bodies.**

**Expected:** `coordination-v3-store.ts` to roughly 6,200 lines; `store.ts` to roughly 4,900.

### 5.3 Bonus category — `this`-free class methods

While working in the two store files, check whether any `CoordinationV3Store` or `AgentStore` method never references `this`. Such a method is a free function wearing a method's clothes, and moving it out is genuinely pure motion.

**Only if the move is exactly this:** the method body is unchanged, it becomes a module-scope function in a sibling file, and the class keeps a one-line delegating method with the identical signature so no caller changes. If a method references `this` even once — including through a helper it calls — leave it. If the count is zero, say so and move on; do not manufacture candidates.

### 5.4 `packages/core/src/dto.ts` — split by domain

199 exported declarations, one function. Types have no runtime behavior, which makes this the safest extraction in the set and the one with the best ratio of lines removed to risk taken.

Split into domain modules under `packages/core/src/dto/` — grouped by what they describe (agents, projects, conversations, runs, artifacts/assets, triggers, workspace, provider/engine, events) — and make `packages/core/src/dto.ts` a barrel that re-exports all of them.

**The barrel is not optional.** Every existing `import { XDto } from ".../dto.js"` across all five packages must keep resolving with no edit. Verify this by building every package, not by reasoning about it.

Watch for cross-domain type references — a DTO in one domain referencing a type in another is normal and fine; just ensure the imports between the new modules are acyclic. If two domains genuinely reference each other, put the shared types in a `dto/common.ts` rather than creating a cycle.

**Expected:** `dto.ts` becomes a barrel of roughly 20–60 lines.

### 5.5 Proving it was pure motion

Your report must demonstrate this, not assert it. A workable method: for each moved declaration, extract its text from `git show <base>:<original path>` and from the new module, and confirm the two are byte-identical apart from leading indentation. State the method you used and the result. For `dto.ts`, also state how you verified the barrel preserves every export name.

## 6. Deliverable 2 — decomposition map (document, no code)

Write `docs/MEGA_FILE_DECOMPOSITION_MAP.md`. This is the analysis that makes the excluded work plannable. **Change no code for this deliverable.**

### 6.1 `createServer` route analysis

1. **Route inventory.** Every route registration inside `createServer` (~190; count them yourself — note most use the `app.get<{...}>` generic form, so a naive `app.get(` grep undercounts badly). Group into coherent domains (projects, conversations, agents, agent-tools, triggers, assets/artifacts, workspace, browser, launcher/deployment, wiki, provider usage). Per domain: route paths, approximate line range, route count.
2. **Capture analysis per domain.** The specific `createServer`-scope identifiers each domain reads or mutates — `store`, `coordinationV3`, `coordinationV3Scheduler`, `activeRuns`, `runtimeAuthorities`, `assets`, `appendWorkspace`, `deletingAgentIds`, `providerUsage`, and so on. **This is the critical section:** it determines whether a domain can move behind a context object or is entangled.
3. **Mutable-state map.** Every mutable structure declared in the closure (the `Map`s and `Set`s tracking active runs, runtime authority, deletion state, scheduled rollovers, capability tokens, provider-usage caching, and the rest). Per structure: which domains read it, which mutate it, and whether mutation is confined to one domain or spread. **Anything mutated from more than one domain is an extraction hazard** — call it out explicitly.
4. **Risk-ranked extraction order**, justified with the capture data rather than intuition.
5. **Proposed `ServerContext` shape** — a TypeScript interface sketch of what a route module would need to receive. Sketch it; do not implement it.
6. **Explicit hazards:** shared mutable state, ordering dependencies between registrations, Fastify hooks that must run before or after specific routes, closure variables captured by both routes and the run executor, and anything wired into the daemon's pending-work counter or shutdown drain.

### 6.2 Store class analysis

For `CoordinationV3Store` (~159 methods) and `AgentStore` (~175 methods):

1. **Method inventory by responsibility cluster**, with approximate line ranges and method counts.
2. **Private-state map.** Every private field, and which clusters touch it. A cluster touching state no other cluster touches is a genuine split candidate; one sharing state with three others is not.
3. **Transaction boundaries.** Which methods open, participate in, or assume an ambient SQLite transaction. **This is the section that decides whether a split is safe at all** — a method group that looks independent but shares a transaction scope cannot move without changing correctness.
4. **Your verdict per class:** is a split viable, and if so what is the seam? "This class should not be split" is an acceptable and useful answer if the state analysis supports it.

Be honest where the answer is "too entangled to extract cleanly." That finding is worth more than an optimistic plan.

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

All must pass. Additionally confirm by inspection that the exported surface of all four files is unchanged — the same symbols exported, with the same types, resolvable through the same import paths.

## 8. Report

1. Branch, base commit, head commit, `git status` (clean).
2. Before/after line counts for all four files, and before/after module-scope declaration counts.
3. Per new module: what moved, and the byte-identity evidence.
4. Anything you **declined to move** and precisely why (state capture, no cohesive home, transaction coupling, other). State explicitly what you did with `secretEqual`, and how many `this`-free class methods you found (zero is a fine answer).
5. For `dto.ts`: how you verified the barrel preserves every export and every consumer import path.
6. Anything you noticed that looked wrong but deliberately did not change — dead code, suspicious logic, duplicated helpers. List it; do not fix it.
7. The decomposition map, plus your headline judgment: which route domains are genuinely extractable next, and whether either store class can be split at all.
8. Verification command output.

Do not open the PR until you have reported and been told to proceed.
