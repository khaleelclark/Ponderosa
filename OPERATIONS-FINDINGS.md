# Ponderosa Next operations findings

This append-only experiment ledger records product and operating friction observed while using Ponderosa. `Confirmed` means the behavior was observed directly by the operator or Product Lead; it does not mean the root cause or fix has been reviewed.

## 2026-08-24T05:00:00Z — UI-001 — New Chat promise conflicts with no-Agent send failure

- Severity: High
- Classification: Defect
- Confirmed: Yes — operator reproduction on the isolated `:20443` service; Product Lead source inspection confirmed the empty state promises that sending starts the first Agent. A fresh no-Agent-state recheck is required immediately before the fix because the Product Lead's first live attempt was contaminated by the adjacent New Agent toggle described in UI-002.
- Reproduction:
  1. Open a Project with zero active Agents and its initial `New Chat`.
  2. Observe: “Send a request to start your first agent — its completed answer returns here.”
  3. Enter a request and press Send without selecting an Agent.
  4. Send fails with “There are no active Agents to notify”; the draft remains intact.
- Impact: The primary first-run path contradicts its own guidance and blocks a new user at the moment they expect Ponderosa to start working.
- Recommended fix: Make the advertised first-send path atomically create the first managed Agent and opening Request, or change the empty-state/composer interaction to require and visibly guide Agent creation before Send. Preserve the draft on every failed path. Resolve the product choice within the existing reviewed managed-Agent creation contract, not with a second assignment mechanism.
- Owner: UI Integration, with server contract inspection as read-only evidence; escalate before changing creation semantics beyond the reviewed contract.

## 2026-08-24T05:00:00Z — UI-002 — Prominent New Agent control does not open Agent creation

- Severity: High
- Classification: Defect (interaction and state visibility)
- Confirmed: Yes — operator reproduction and Product Lead live reproduction on `:20443`.
- Reproduction:
  1. Open a new Chat with no Agents.
  2. Click the prominent `New Agent` control beside the composer.
  3. The URL does not change and no Agent-creation dialog or destination is presented. The control silently toggles composer intent; in the Product Lead exercise, no visible semantic snapshot changed.
  4. Enter and send a draft. The latent selection creates an Agent and starts its first Run, demonstrating that the click changed consequential state without making the next action clear.
  5. By contrast, open Chat settings and choose `Create Agent`; that path opens the expected creation flow.
- Impact: A creation-looking control appears inert, hides consequential send behavior, and makes safe reproduction difficult. It can cause users to create/start an Agent unintentionally.
- Recommended fix: Give the prominent control one explicit, visible outcome consistent with its label. Prefer opening the existing Create Agent flow; if inline first-Agent intent is retained, label it as a send destination/mode, expose selected state and consequence accessibly, scope it to the current Chat, and never let it leak across Projects.
- Owner: UI Integration.

## 2026-08-24T05:00:00Z — OPS-001 — Project workspace opened without the designated checkout

- Severity: Low
- Classification: Operational defect
- Confirmed: Yes — Product Lead reproduced at run start.
- Reproduction: Start the managed Run with the Project workspace as cwd; `pwd` resolves to the run workspace, but it is empty and is not a Git repository. The actual checkout is `/home/phoenix/ponderosa-project-rail-runtime/source`.
- Impact: Baseline verification initially fails and an Agent could wrongly conclude that source is missing.
- Recommended fix: Register or expose the authoritative checkout as the Project workspace root and include it in the run's structured filesystem context.
- Owner: Ponderosa Engine/runtime.

## 2026-08-24T05:00:00Z — OPS-002 — Common Project Chat reply required an undocumented explicit intent

- Severity: Low
- Classification: Operational defect
- Confirmed: Yes — Product Lead reproduced while publishing the required pre-implementation plan.
- Reproduction: In a Project Chat manager request with a stated inferred Project reply, call the common `ponderosa_message({text})` form. The capability rejects it with “this Run has no unambiguous reply route”; retrying with explicit `intent: "broadcast"` succeeds.
- Impact: The documented common path fails in a normal top-level Project Chat and costs an avoidable recovery attempt.
- Recommended fix: Make the active capability expose one canonical reply route for this activation, or have the prompt explicitly require the resolved intent from the outset.
- Owner: Ponderosa communication capability/runtime.

## 2026-08-24T05:01:23Z — OPS-003 — Provider failures surfaced only as outcome unknown after automatic retry

- Severity: Medium
- Classification: Operational defect
- Confirmed: Yes — both Claude-backed specialist openings reproduced the same terminal state, and each automatic recovery attempt produced another `provider_outcome_unknown` result.
- Reproduction:
  1. Create tracked managed Agents with valid opening Requests and aggregate Joins.
  2. Observe the Working Copies and System Articulation Agents become idle without a canonical result while their Joins terminate as impossible with `outcome_unknown`.
  3. Allow Ponderosa's recovery Request to audit and retry the original assignment.
  4. Observe the retry also terminate as `provider_outcome_unknown` without a user-facing provider failure summary.
  5. Audit both assigned Git worktrees: each remains clean at the exact baseline, proving no repository side effect but not explaining the provider failure.
- Impact: The manager receives no actionable cause, cannot distinguish pre-execution provider failure from lost post-write acknowledgment without a separate filesystem audit, and must manually reconstruct safe retry state.
- Recommended fix: Persist and surface a redacted provider exit/failure summary with execution phase, whether a provider session was established, last durable side-effect boundary, and an explicit safe-to-retry assessment. Preserve the exact Request lineage while preventing unbounded automatic retries.
- Owner: Ponderosa scheduler/provider-session runtime.
- Follow-up, 2026-08-24T05:03:11Z: only after the third `outcome_unknown` result and writer revocation did a separate managed-child failure surface the actionable cause “Provider rejected the request.” The delayed, disconnected diagnostic confirms that the canonical Join outcome omitted information already available elsewhere in the runtime. The original worktree was re-audited clean and ownership was transferred to a Codex-backed replacement Agent.
- Follow-up, 2026-08-24T05:13:10Z: the same delayed `Provider rejected the request` event later arrived for System Articulation after its recovery Request had already become terminal `outcome_unknown`. The Agent remained visibly named as the slice owner while idle, so Product Lead had to re-audit the clean docs worktree, explicitly revoke ownership, rename it `Revoked — System Articulation`, and create a Codex replacement. Recommended ownership fix: a terminal failed/outcome-unknown writer should automatically lose the active ownership badge while preserving its audit identity, and a replacement assignment should atomically transfer the visible owner.

## 2026-08-24T05:04:22Z — OPS-004 — Completed managed work became an impossible Join without a terminal handoff

- Severity: Medium
- Classification: Operational defect
- Confirmed: Yes — Product Lead audited the Reliability/Mobile worktree after its opening Join reported `run_completed_without_request_update`.
- Reproduction:
  1. Assign a managed Agent a staged implementation Request with a required exact-commit handoff.
  2. The Agent creates clean commit `3d06908233b1b44615ef0f3f4373166d11099f0c` implementing the requested Phase A safety change and ends its Run.
  3. The Agent does not call the canonical Request-update capability before ending.
  4. The manager receives an impossible Join with `outcome_unknown` rather than the commit, verification, or a recoverable incomplete-handoff state.
  5. The manager must inspect Git manually, freeze the discovered commit, notify the Agent to stop Phase B, and create a second Request solely to recover evidence.
- Impact: Correct completed work is indistinguishable from lost or partial work at the coordination layer; sequencing gates can be missed and duplicate execution becomes likely.
- Recommended fix: Before closing a managed Run with an attached nonterminal Request, require a terminal update or synthesize a durable `handoff_missing` state containing the observed side-effect manifest (branch, head, dirty state, artifacts) and a one-action recovery path. Do not classify it as an impossible Join when the Request can still be resumed.
- Owner: Ponderosa managed-Agent execution and coordination runtime.
- Follow-up, 2026-08-24T05:07:14Z: a second tracked Request successfully recovered the canonical handoff without changing the frozen branch. Because the original Run left no durable command evidence, the Agent had to regenerate strict typecheck, production build, exact-diff, and disposable runtime-fixture evidence. This confirms recoverability but also the avoidable duplicate qualification cost.

## 2026-08-24T05:08:35Z — OPS-005 — Read-only reviewer persisted a forbidden reproduction harness, then failed without a handoff

- Severity: High
- Classification: Operational defect and Agent noncompliance
- Confirmed: Yes — the operator observed `ponderosa-layout-lock-race-repro.mjs` inside the detached review worktree despite explicit read-only and external-temporary-fixture instructions. Product Lead inspected the exact path immediately afterward; the file was already absent, `git status --porcelain=v1 --untracked-files=all` was empty, and `git diff --check` passed at frozen commit `3d06908233b1b44615ef0f3f4373166d11099f0c`.
- Reproduction:
  1. Assign a managed reviewer a detached exact-commit worktree with explicit instructions not to edit source or persist a review harness in the repository.
  2. The reviewer creates an untracked `ponderosa-layout-lock-race-repro.mjs` inside that worktree while reproducing a lock race.
  3. The operator intervenes and directs cleanup.
  4. By the time Product Lead inspects, the file has been removed and the worktree is clean, so no commit-level evidence remains.
  5. After reviewer write authority is revoked, the managed reviewer terminates with `Provider execution failed` and no canonical review handoff.
- Impact: A read-only reviewer mutated the evidence worktree, violated the repository's no-persisted-harness policy, and then lost its canonical handoff. The serious race finding survived only through the operator's intervention.
- Recommended fix: Enforce reviewer worktrees as read-only at the capability/filesystem layer; provide an explicit run-scoped temporary directory for manual repro scripts; retain an audited manifest of temporary and untracked file creation/removal; and require the review finding to be durably published before provider teardown.
- Owner: Ponderosa managed-Agent workspace authority and provider-session runtime.
