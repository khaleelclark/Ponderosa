# Ponderosa Next operations findings

This append-only experiment ledger records product and operating friction observed while using Ponderosa. `Confirmed` means the behavior was observed directly by the operator or Product Lead; it does not mean the root cause or fix has been reviewed.

## 2026-08-24T05:00:00Z — UI-001 — Initial no-Agent send-failure observation (superseded)

- Severity: None — evidence correction
- Classification: Initial observation; not a confirmed defect
- Confirmed: No. UI Integration reproduced the path in a genuinely fresh zero-Agent Project on the isolated `:20443` service: ordinary first Send correctly created an Agent, started its Run, and cleared the draft. This controlled reproduction supersedes the earlier report that Send failed with “There are no active Agents to notify.”
- Initial observation:
  1. A new Chat displayed: “Send a request to start your first agent — its completed answer returns here.”
  2. An attempted Send was reported to fail with “There are no active Agents to notify” while preserving the draft.
  3. Product Lead could not independently reproduce that failure because UI-002's hidden `#new-agent` intent contaminated the available Projects.
- Superseding reproduction:
  1. Open a genuinely fresh Project with zero Agents and its initial `New Chat`.
  2. Enter an ordinary request without injecting `#new-agent` intent and press Send.
  3. Ponderosa creates the first Agent, starts its Run, and clears the successfully submitted draft as advertised.
- Impact: No current first-Send defect is established. Treating the initial observation as confirmed could cause a regression in the working managed-Agent creation path.
- Recommended action: Make no UI-001 product change. Preserve the working ordinary first-Send behavior during UI-002 fixes and requalify it after integration.
- Owner: Closed as superseded evidence; UI Integration retains regression responsibility only.

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

## 2026-08-24T05:18:37Z — REL-001 — Data-directory lock release and launcher cleanup can delete a replacement live lock

- Severity: High
- Classification: Confirmed safety defect; corrected Phase A head not approved
- Confirmed: Yes — fresh independent adversarial rereview of exact head `c6a4d3ac888aa1e423eccbae9617c8a54c6edc54` found two destructive check/use races and one directory-identity gap.
- Reproduction:
  1. Owned-lock release reads and token-checks `.ponderosa-daemon.lock`; replace that pathname with another process's live lock before the subsequent `rmSync`. Release deletes the replacement lock because the decision used the earlier read.
  2. Launcher cleanup reads a matching PID from the daemon lock; replace the pathname before its subsequent `rmSync`. Cleanup deletes the replacement lock, and PID reuse can independently make the old equality check match a later process.
  3. Point the data-directory pathname through a symlink to directory A, acquire A's lock, then retarget the symlink to directory B before layout inspection. The lexical path check still passes while Ponderosa inspects and opens B without holding B's lock.
- Impact: A live owner can lose its lock, allowing a third process to acquire the data directory concurrently; or the process can inspect/open a directory different from the one it locked. Either violates the fail-closed startup invariant and can expose canonical state to concurrent writers.
- Recommended fix: Use one bounded exact-identity lock protocol for acquisition and release, with no separate read-then-pathname-unlink decision; remove PID-only launcher lock deletion and delegate to the same authority or fail closed; canonicalize and bind the data-directory identity once before every locked operation. A prepared nonempty owner directory claimed atomically and released by removing only the token-specific child plus nonrecursive `rmdir` is one candidate, but the corrected implementation must prove its platform semantics rather than rely on prose. Require disposable contention/symlink exercises and exact-head rereview before Phase B.
- Owner: Reliability/Mobile. Phase B remains frozen.

## 2026-08-24T05:19:30Z — VOICE-001 — Voice MVP can lose dictated text, speak from hidden surfaces, and read system notices

- Severity: High
- Classification: Confirmed Voice MVP defects; frozen head not approved
- Confirmed: Yes — independent read-only adversarial review of exact head `3edc4aa36024e4b144fed96af213ee0f5bd9fd9d` found two high-severity lifecycle failures and one medium authorship-gating failure.
- Reproduction:
  1. Start dictation, finalize one phrase, begin another, and press Send before the second phrase finalizes. Submission snapshots only the first phrase; recognition inserts the second while the request is pending; successful Send clears the post-snapshot draft mutation, so the second phrase is neither sent nor retained.
  2. Start read-aloud on a long Agent message, then switch to a Project Chat subview or preserved Agent detail panel that hides the source without unmounting it. Audio continues while its pause/stop control is no longer visible.
  3. Produce a durable system-authored notice and open All Messages. The item receives Agent read-aloud controls because the gate checks only “not user” rather than `author.kind === "agent"`.
- Impact: User-authored text can be lost during an ordinary Send; speech can continue unexpectedly after in-app navigation, including potentially sensitive content; and system notices are misrepresented as Agent speech.
- Recommended fix: Coordinate recognition shutdown/final flush with submission or preserve every post-snapshot draft mutation without auto-sending speech; stop the active synthesis owner when its message surface becomes inactive/hidden, not only on unmount/pagehide; gate All Messages read-aloud strictly on Agent authorship. Requalify drafts, explicit Send, cross-view cleanup, and authorship before exact-head rereview.
- Owner: Voice Conversation MVP. Branch remains frozen until overlapping UI-002 composer changes are finalized and sequenced.

## 2026-08-24T05:30:16Z — DOCS-001 — System articulation overstates current safety and conflates durable and live lifecycles

- Severity: High
- Classification: Confirmed documentation and provider-contract accuracy defects; frozen head not approved
- Confirmed: Yes — independent read-only factual-contract review of exact head `0b963adcecf5c42681126d33ed3fdc1d05d400cd` found one high-, three medium-, and two low-severity inaccuracies.
- Reproduction:
  1. Compare `docs/system-model.md`'s claim that unknown or damaged legacy state fails closed with the baseline data-layout path: layout inspection occurs before ownership and a missing/unknown marker triggers recursive deletion. Only the SQLite launch-baseline check fails closed at this head.
  2. Compare the statement that Project files are outside the data directory with new-folder Projects, which are created under `<dataDir>/workspaces`; only selected existing folders are necessarily external.
  3. Compare the described pre-Activation Automation “managed artifact” with the implemented durable occurrence row containing identity, provenance, hash, and run-scoped retrieval.
  4. Compare durable Agent Decision responses, which create response Activations, with live provider elicitations, whose values normally return directly through an in-memory broker to the waiting provider call; only free-form diversion creates an Activation.
  5. Follow rollover sequencing: provider runtime/process teardown before replacement and accepted-session snapshot switching after low-water verification are distinct events, but the docs call both “session retirement.”
  6. Compare trusted Project browser profiles, which persist cookies/storage by design, with deployment wording that says every browser always uses a fresh temporary profile and credentials are never stored.
- Impact: Operators could rely on a destructive baseline startup path as though it were fail-closed, omit managed workspaces from backups, misunderstand durable Automation and Decision boundaries, or misjudge browser credential persistence. Ambiguous rollover wording also obscures the actual session-acceptance boundary.
- Recommended fix: Narrow the safety statement to the current SQLite schema check until the separately reviewed layout fix is integrated; distinguish managed and external Project folders in location/backup guidance; describe the Automation occurrence record precisely; split durable Decisions from live elicitations; name runtime teardown and accepted-session switching separately; and scope disposable-browser claims while documenting trusted-profile persistence. Preserve the independently approved conditional `ponderosa_history` and removed `ponderosa_docs` wording. Require exact-head factual rereview before integration.
- Owner: Documentation/System Articulation. Integration remains blocked for this slice.

## 2026-08-24T05:31:16Z — UI-002 follow-up — Explicit Agent creation fix frozen for review

- Status: Corrected in the UI Integration branch; independent approval pending.
- Exact correction: `e221edbe23b50ad554aa07e63b3e8982906207b4` on `experiment/next-ui-integration`, one commit over baseline and clean.
- Result: The prominent `New Agent` control now opens the existing managed Create Agent flow, has no pressed/hidden composer mode, does not rewrite the draft, and scopes the callback to the active conversation. The change is limited to `ConversationView.tsx` and `Composer.parts.tsx`; it does not change server semantics.
- Qualification: Repository-wide strict typecheck and production build passed. Temporary exact-build desktop/mobile exercises confirmed dialog open/cancel, unchanged drafts, no cross-conversation state leak, and ordinary zero-Agent first Send creating one Agent/Run and clearing the submitted draft.
- Remaining gate: Exact head is frozen in a filesystem read-only detached worktree for independent adversarial review, including compatibility analysis against the frozen Voice slice. Do not integrate or deploy until approved; any confirmed finding must be corrected and rereviewed at the new exact head.

## 2026-08-24T05:33:30Z — WC-001 — Working-copy identity is not consistently fenced, owned, visible, or preserved

- Severity: Critical
- Classification: Confirmed Agent Working Copies defects; frozen head not approved
- Confirmed: Yes — independent adversarial review of exact head `496b0dea10091965823e6308e47292d05a2feed8` found three P1 and three P2 defects.
- Reproduction and impact:
  1. Pause Run preparation after it snapshots the old working-copy identity but before `activeRuns` claims the Agent; change mode, then resume. The mode API reports success while the Run starts in the old folder. Transient structured-command sessions have the same unfenced gap.
  2. Pre-create the deterministic `ponderosa/<agent>` branch or replace a retained root with another repository on the expected branch. Provision/resolve accepts the unproven branch or repository because it does not persist and verify Git common-directory/worktree-admin ownership.
  3. Remove, move, chmod, or change the branch/metadata of a ready Separate root. Resolution fails, but durable Agent state and the Settings chip remain `Ready` rather than transitioning to visible `Unavailable`.
  4. Enable Separate as Agent Alpha, switch Shared, rename to Beta, then re-enable Separate. The retained root remains on Alpha's branch while the newly derived Beta branch is required, leaving no repair/reconnect path.
  5. Click a relative file link emitted by a Separate Agent. The client omits Agent identity, so the viewer reads Shared and returns the wrong same-named file or 404.
  6. Change the same relative path in Shared and Separate Runs. Canonical file-change and artifact provenance omit working-copy identity, merging histories that must remain distinguishable.
- Recommended fix: Fence mode changes, Run admission, and command authority together; persist and validate exact Git ownership; durably invalidate failed retained identities; preserve/reconnect retained metadata across mode/title changes; carry Agent working-copy routing for Agent-authored links; and add immutable identity to file/artifact provenance. Keep broad scheduler checkpoint/executor work deferred and require exact-head rereview.
- Owner: Agent Working Copies. No integration or deployment until corrected and approved.

## 2026-08-24T05:33:39Z — REL-001 follow-up — Canonical paths still do not pin the locked directory identity

- Severity: High
- Classification: Confirmed remaining Phase A safety defect; third frozen head not approved
- Confirmed: Yes — same-reviewer rereview of exact head `37921f18047305d409b2f738fb67dc8bb582718c` reproduced one high- and one medium-severity pathname-displacement failure.
- Reproduction:
  1. Acquire the lock in canonical directory D, rename D to D.old, and create a replacement D before layout inspection. Lexical ownership still matches, Ponderosa writes the V1 marker and opens state in replacement D, and another process can acquire replacement D's lock while the first lock remains in D.old.
  2. During release, after owner A removes its token child, externally displace its now-empty lock directory. Let contender B create the original lock directory and pause before publishing its owner child. A's subsequent nonrecursive `rmdir` removes B's partially published claim.
- Impact: Directory replacement can restore concurrent writers despite the canonical-path correction. Release can also destroy another contender's in-progress claim, producing an avoidable fail-stop.
- Confirmed corrections retained: Launcher no longer deletes daemon locks; input-symlink retargeting is fixed; stable-path protocol contenders receive atomic no-replace acquisition; missing/malformed/unknown layout markers fail closed; safe stable-directory first run remains intact.
- Recommended fix: Bind lock and all store operations to stable directory identity and make release identity-atomic under displacement. If Node and repository constraints cannot provide this without native locking, descriptor-relative I/O, a dependency, or a broad rewrite, stop with a precise design blocker rather than landing another incomplete correction. Phase B remains frozen.
- Owner: Reliability/Mobile.

## 2026-08-24T05:36:16Z — DOCS-001 follow-up — Reviewed system-boundary corrections frozen

- Status: All six confirmed documentation findings are corrected in exact head `2fa7ee946875f0c2b40f52e32dc8af1cf5db0d5a`; independent same-reviewer approval pending.
- Correction: The docs now scope fail-closed behavior to SQLite launch-baseline/schema checks and explicitly disclose the still-destructive baseline layout cutover; distinguish external selected folders from Ponderosa-created `<dataDir>/workspaces` in location and backup guidance; describe Trigger occurrence rows precisely; split durable Agent Decisions from live in-memory provider elicitations; separate runtime teardown from accepted-session snapshot switching; and distinguish disposable browser profiles from trusted persistent Project profiles.
- Preserved evidence: The independently approved conditional `ponderosa_history` and removed `ponderosa_docs` wording is byte-unchanged, as are `README.md` and `packages/core/src/managed-tools.ts` from the previously reviewed head.
- Qualification: The correction is one clean Markdown-only commit over the rejected head; parent and full-range `git diff --check` passed. Parent frozen install, strict typecheck, and production build evidence remains applicable because no source/tool bytes changed.
- Remaining gate: Exact head is frozen in a fresh filesystem read-only detached worktree for rereview by the same factual-contract reviewer. Do not integrate or deploy until approved.

## 2026-08-24T05:38:43Z — UI-002 follow-up — Agent creation transition can discard unsaved composer payloads

- Severity: High
- Classification: Confirmed data-loss defect in the first UI-002 correction; frozen head not approved
- Confirmed: Yes — independent adversarial review of exact head `e221edbe23b50ad554aa07e63b3e8982906207b4` traced the route transition through composer unmount and the existing draft/attachment lifecycles.
- Reproduction:
  1. In a zero-Agent Project Chat, paste more than 10,000 characters so the component-only `Pasted text` card is staged, or attach a file while its durable draft write/upload is queued, in flight, or inside the 500 ms debounce window.
  2. Click the prominent `New Agent` action, which opens the route-based creation surface and unmounts the composer.
  3. Cancel Agent creation and return to the Chat.
  4. The long-paste payload and/or staged attachment is gone: long paste is not part of normal local/server text draft writes, and unmount aborts queued/in-flight attachment work before the delayed durable snapshot is guaranteed.
- Impact: A user can lose authored content merely by inspecting and canceling the advertised creation flow, contradicting the draft-preservation invariant.
- Confirmed positives: The action is accessible, opens the existing managed creation path, no longer injects hidden `#new-agent`, does not leak mode across conversations, and does not change ordinary first-Send server semantics. Frozen Voice changes merge without a textual conflict.
- Recommended fix: Preserve the exact live composer instance while the creation surface is active, or durably snapshot and restore the complete composed state—including component-only pasted text and queued/in-flight/resolved attachments—before transition. Sequence or disable the action during Send. Keep Voice-owned composer files untouched; if that boundary makes the fix impossible, report the overlap rather than creating concurrent edits. Require desktop/mobile and same-reviewer exact-head rereview.
- Owner: UI Integration. Do not integrate or deploy the current head.

## 2026-08-24T05:39:36Z — REL-002 — Exact data-directory identity requires a native or isolated store boundary

- Severity: Critical
- Classification: Confirmed design blocker; requested invariant cannot be completed within the authorized portable Node/core scope
- Confirmed: Yes — bounded design audit left the clean branch unchanged at `37921f18047305d409b2f738fb67dc8bb582718c` and reproduced directory, ancestor, and partial-release rebinding outside the repository.
- Evidence:
  1. AgentStore layout, projects, journal, SQLite, and component authorities retain pathname strings across many modules and descendants.
  2. Node 22 directory handles support identity observation but expose no portable descriptor-relative `openat`/`mkdirat`/`renameat`/`unlinkat` family or compare-and-remove-directory primitive. Stat/watch checks cannot close the name-resolution race.
  3. `better-sqlite3` opens from a filename or serialized buffer; it cannot bind its database, journal, and WAL operations to the already acquired directory handle without a custom VFS or an identity-bound store process.
  4. Canonical-directory and ancestor displacement redirected marker/journal writes into replacement trees while the held descriptor still identified the original. Partial claim replacement during release reproduced deletion of the contender's empty claim.
- Impact: Another bounded pathname-lock correction cannot prove the required identity invariant. Landing one would misrepresent safety; removing clean release would force unsafe manual reclamation on every restart.
- Recommended architecture: A platform-native process-lifetime directory lease released only by kernel unlock/handle close; descriptor/handle-relative no-follow filesystem primitives for every child operation; and either a rooted SQLite VFS or a dedicated AgentStore subprocess bootstrapped from the acquired identity and exposed through bounded RPC. POSIX and Windows semantics require explicit qualification. A lock-only dependency is insufficient.
- Decision required: Authorize the native/isolated-store scope with a revised milestone, explicitly narrow the supported threat model to stable configured path/ancestors, or defer the safety slice as a documented blocker. Phase B remains frozen; reverting `37921f1` is unsafe because it restores confirmed launcher and symlink defects.
- Owner: Product Lead decision; Reliability/Mobile remains frozen.

## 2026-08-24T05:41:22Z — DOCS-001 disposition — Corrected System Articulation approved and integrated

- Status: Resolved and independently approved with no remaining severity-ranked findings.
- Reviewed source head: `2fa7ee946875f0c2b40f52e32dc8af1cf5db0d5a` against baseline `29d395352a5b8382103f568936afde4d75c0d692`.
- Integration commits: `f84b0a58` (`docs: explain the durable Ponderosa system`), `f49c0d60` (`docs: correct provider retrieval contracts`), and `656d7240` (`docs: correct reviewed system boundaries`) on `experiment/project-rail-runtime`.
- Evidence: Same reviewer confirmed all six prior findings corrected; conditional `ponderosa_history`, removed `ponderosa_docs`, provider-contract hash consequences, proposed-Next limits, browser authority, persistence, and upgrade wording match current source contracts. Base-to-head and correction-only `git diff --check` passed; the detached review worktree remained clean and read-only.
- Residual limitation: The destructive baseline layout-marker behavior is documented accurately but remains an unintegrated runtime blocker tracked by REL-001/REL-002. Documentation approval does not approve that runtime path.
- Rollback: Revert the three integration commits newest-first. No schema or data rollback is involved.

## 2026-08-24T05:42:04Z — REL-002 decision — Native identity scope authorized

- Authority: The operator selected `Authorize native scope` for the confirmed data-directory identity blocker.
- Revised milestone: Reliability Phase A-Native may add the minimum production native directory-lease layer and bounded rooted AgentStore/VFS or identity-bound process boundary required to pin filesystem and SQLite operations to one acquired directory identity. Projection-checkpointing, provider-executor rewrites, unrelated store redesign, automated-test work, and Phase B remain outside authority.
- Sequence: Freeze an architecture/platform contract first; then implement in small dependency-ordered commits only if the design provides kernel-managed lease release without namespace deletion, descriptor/handle-relative no-follow filesystem operations, and SQLite journal/WAL binding to the same identity. An incomplete pathname-based safety patch must not land.
- Review gate: Require frozen-install, strict typecheck, full production build, exact diff/security review, disposable external runtime exercises including rebind/contention/crash/SQLite cases, and fresh same-reviewer exact-head approval before integration. Phase B remains frozen.
- Owner: Reliability/Mobile under the expanded Phase A-Native authority.

## 2026-08-24T05:49:58Z — OPS-006 — Activity cards lose tool-result association

- Severity: Medium
- Classification: Confirmed operational UI defect
- Confirmed: Yes — operator observed Product Lead activity cards render `Unmatched tool result` for both execution and Decision activity while the underlying work continued successfully.
- Reproduction: Run Product Lead work that emits an execution result and opens a `ponderosa_decision`; inspect the corresponding activity cards. The result payload is present in the workflow, but the card cannot associate it with the initiating tool activity and labels it unmatched.
- Impact: The visible activity stream falsely suggests broken execution, obscures which action produced a result, and makes debugging or auditing a live orchestration materially harder even when the workflow succeeds.
- Recommended fix: Persist and project one stable activity/call/result identity through execution, Decision creation/response, retries, compaction, and rendering. When association fails, show the durable IDs and recovery state rather than a generic unmatched label, and add a visible completion association once reconciled.
- Owner: Ponderosa activity projection and Work-log UI.

## 2026-08-24T05:49:58Z — OPS-007 — Needs Your Attention lacks completion receipts and retains superseded failures

- Severity: Medium
- Classification: Confirmed operational lifecycle/UI defect; related to OPS-003 rather than a duplicate provider-failure finding
- Confirmed: Yes — after the operator answered the native-architecture choice, `Needs Your Attention` showed no clear completion receipt and continued to surface stale `outcome_unknown` items belonging to superseded, revoked, or replaced work.
- Reproduction: Accumulate provider `outcome_unknown` items, revoke/replace their writer, then answer a later blocking architecture Decision. Reopen `Needs Your Attention`: the answered item lacks an unambiguous resolved receipt while obsolete earlier alerts remain actionable-looking.
- Impact: Operators cannot reliably tell whether a consequential choice was accepted, and stale alerts compete with real current decisions. Repeated provider/ownership evidence remains tracked in OPS-003; this finding concerns attention-item resolution and presentation.
- Recommended fix: Project an explicit accepted/resolved receipt with answer, timestamp, affected workflow, and next state. Auto-resolve items when their Request/Agent is cancelled, superseded, revoked, or replaced; retain them in history with lineage. Provide explicit select/bulk-dismiss for eligible historical items and issue a durable dismissal receipt.
- Owner: Ponderosa Decision/attention projection and client UI.

## 2026-08-24T05:49:58Z — OPS-008 — Subagents roster obscures current ownership and lineage

- Severity: Medium
- Classification: Confirmed information-architecture defect
- Confirmed: Yes — operator observed a flat 15-row Subagents list mixing active replacements, failed originals, reviewers, revoked writers, and completed Agents.
- Reproduction: Run a staged experiment with writer failure/replacement and exact-head reviewers; open Subagents after several slices complete. All lifecycle roles appear in one undifferentiated flat list.
- Impact: The current owner of a slice is difficult to identify, failed originals continue to look peer-equivalent to replacements, and reviewer/worker history consumes the same visual priority as active work. This compounds the delayed ownership-transfer problem recorded in OPS-003.
- Recommended fix: Group by `Active ownership`, `Awaiting/reviewing`, `Completed`, and `History/failed/revoked`; show slice/role, manager, replacement-of/replaced-by lineage, current Request/Run state, and exact review target. Default to current ownership while retaining searchable audit history.
- Owner: Ponderosa organization projection and Subagents UI.

## 2026-08-24T05:49:58Z — OPS-009 — Direct Agent chat buries updates beneath repeated full prompts

- Severity: Low
- Classification: Confirmed usability defect, not merely a visual preference
- Confirmed: Yes — operator observed direct Agent chats repeatedly render full assignment and canonical handoff prompts ahead of the useful status, diff, finding, or decision content.
- Reproduction: Open a writer or reviewer Agent chat after an opening assignment, correction Request, and handoff. The full instruction payloads are expanded inline and repeated, forcing the operator to scan past large blocks to find what changed.
- Impact: High-value progress and review signals are buried; comparisons across correction rounds become slow and error-prone, especially for long safety assignments.
- Recommended fix: Render assignment/handoff envelopes as collapsed summaries by default: role/slice, state, exact base/head, changed files, verification, findings, decision needed, and lineage. Preserve the immutable full payload behind an expand/copy action and highlight only the diff from the prior assignment or handoff.
- Owner: Ponderosa direct-Agent conversation projection and client UI.

## 2026-08-24T05:54:07Z — UI-002 follow-up — Composer-preserving correction frozen for rereview

- Status: The confirmed Cancel/data-loss defect is corrected in exact head `9b8974c7bcf90252b7d2d28b56d8656ba482292b`; same-reviewer approval pending.
- Correction: The existing composer remains mounted behind a locally presented, accessibly labeled `AgentCreateSurface`; Cancel removes only the creation surface. The prominent action is disabled while Send is pending and still never injects `#new-agent`. Create/import retain the existing managed creation contract.
- Scope: Two new commits over rejected head `e221edbe`, limited to `ConversationView.tsx` and `Composer.parts.tsx`; Voice-owned files and server contracts are unchanged. Baseline-to-head has no path overlap with the frozen Voice slice and a read-only merge-tree completed without conflicts.
- Qualification: Repository strict typecheck and production build passed. Temporary exact-build desktop/mobile exercises confirmed preservation of ordinary text, 12,050/10,050-character paste cards, queued/uploading/ready attachments, cross-conversation isolation, disabled creation during held Send, and unchanged ordinary zero-Agent first Send. No deployment occurred.
- Remaining gate: Exact head is frozen in a fresh filesystem read-only detached worktree for same-reviewer rereview. Combined UI/Voice live qualification remains required after both slices are individually approved and integrated.

## 2026-08-24T06:00:27Z — WC-001 follow-up — Broad dirty correction requires a per-finding scope map

- Severity: High
- Classification: Confirmed implementation-scope risk; pre-freeze intervention
- Confirmed: Yes — operator observed 38 dirty files; Product Lead immediately re-audited the active worktree and found 40 modified files, 292 insertions / 95 deletions, spanning server routes, web views/hooks/routing, projections/schema/store, and core DTOs/events.
- Risk: The breadth may be justified by the six confirmed findings, but without an exact file-to-finding map, unrelated redesign or opportunistic cleanup can hide inside provenance/file-link work. It also makes the two P1 runtime/identity fixes difficult to review independently.
- Required pre-freeze evidence: Map every changed file to exactly one of: P1 admission/command fencing; P1 Git branch/repository ownership; P1 durable unavailable state; P2 retained-copy recovery; P2 Agent-authored relative file routing; or P2 immutable file/artifact provenance. For each cluster state the invariant, dependency order, necessity of every file, and exact commit boundary; explicitly disclose unavoidable cross-cluster files.
- Required disposition: Split the P1 runtime/identity corrections ahead of file-link/provenance work; drop or revert unrelated redesign/refactors/migration expansion; attribute typecheck/build/manual evidence per cluster; and do not freeze until the worktree is clean and the map matches the exact diff.
- Gate: Independent exact-head review and the repository no-tests policy remain unchanged. Product Lead delivered this scope gate to the running writer immediately; no file in the writer worktree was changed by Product Lead.
- Owner: Agent Working Copies writer, with Product Lead pre-freeze audit.

## 2026-08-24T06:01:55Z — REL-002 follow-up — Native authority architecture frozen before implementation

- Status: Phase A0 design is frozen at exact head `4b2e743620935d3a78946beee371141b82107f10`; Phase A1 and Phase B have not begun.
- Selected design: Extend the existing `@ponderosa/native-host` N-API boundary with one retained identity-keyed OS lease; kernel unlock/handle close is the only clean release. Protected filesystem operations become descriptor/handle-relative and no-follow, and the AgentStore SQLite connection uses a rooted native VFS so the database, journal, WAL, and shared-memory files remain bound to the same directory identity.
- Platform contract: POSIX uses a lease on the retained root descriptor; Windows uses a same-user Global mutex keyed by volume/file identity plus a root handle that withholds delete sharing. Linux local filesystems, macOS/APFS, and Windows/NTFS require exact-host qualification; unknown/network filesystems fail before protected mutation. The document claims design, not current runtime support.
- Scope: One new 383-line architecture document over unsafe runtime parent `37921f1`; no source, manifest, lockfile, dependency, generated material, configuration, A1, or Phase B change. Strict typecheck, full production build, and exact diff checks passed; worktree is clean.
- Remaining gate: Same independent safety reviewer is reviewing lease/platform semantics, rooted VFS escape resistance, protected-domain completeness, compatibility fencing, migration/rollback ordering, and A1 commit boundaries. A0 approval permits implementation planning only, never runtime integration. A1 remains forbidden until disposition.
- Owner: Reliability/Mobile under authorized Phase A-Native scope.

## 2026-08-24T06:08:02Z — UI-002 follow-up — Dismissed create/import can navigate later from stale Chat context

- Severity: High
- Classification: Confirmed managed-operation lifecycle defect; corrected UI head not approved
- Confirmed: Yes — same-reviewer rereview of exact head `9b8974c7bcf90252b7d2d28b56d8656ba482292b` found that modal dismissal is not fenced to in-flight Create/Import authority.
- Reproduction:
  1. In Chat A, stage text plus a long-paste card or attachment; open `New Agent`, start Create or Import, and hold the endpoint response.
  2. Press Escape/click the backdrop while Create is pending, or use Import's still-enabled visible Cancel. The modal closes although the managed request remains live.
  3. Reopen the surface or navigate to Chat/Project B before the first request succeeds.
  4. The late success callback retains Chat A's navigation authority and can pull the operator to the created/imported Agent, unmount the apparently preserved composer, or coexist with a second submitted operation.
- Impact: Apparent cancellation does not cancel work, can cause duplicate managed operations, and can navigate from stale conversation context into another Project/Chat without a current user action.
- Confirmed positives: The exact composer now remains mounted during idle modal use, preserving typed text, long paste, and queued/uploading/ready attachments; ordinary idle Cancel, accessibility, no hidden `#new-agent`, first Send, failure restoration, and Voice textual compatibility remain correct.
- Recommended fix: Once Create/Import submission begins, disable Escape, backdrop, visible Cancel, and reopening; expose pending state accessibly. Fence late success to the exact active modal instance and origin conversation/Project so dismissed, superseded, or stale callbacks cannot navigate or clear another Chat. Do not imply UI dismissal cancels server work or broaden server semantics.
- Owner: UI Integration. Same-reviewer exact-head approval remains required.

## 2026-08-24T06:12:16Z — WC-001 follow-up — Exact clean head still mixes P1 state with broad P2 projection work

- Severity: High
- Classification: Confirmed pre-review scope/commit-boundary defect; clean status is not acceptance
- Confirmed: Yes — Product Lead audited exact head `b876f811` against prior frozen head `496b0dea`: 54 paths, 755 insertions / 306 deletions across three commits. The branch subsequently advanced to `1786a819`, adding a one-file failure-transition guard, without resolving the broad commit boundary.
- Commit audit:
  1. `3a698799` changes 8 files (+307/-86) for Separate Git ownership and related durable identity/recovery authority.
  2. `f438e1ae` changes 6 files (+138/-114) for Run admission and command fencing.
  3. `b876f811` changes 43 files (+313/-109) across documentation, assets/server routes, 17 web paths, schema/projections/store, and core events/DTOs. It combines the P1 durable-unavailable surface with P2 relative file-link routing and immutable file/artifact provenance.
  4. Later `1786a819` changes one catalog-authority file (+42/-14) but does not make the 43-file predecessor independently reviewable.
- Required mapping: Before any rewrite or freeze, provide a complete table for all 54 `b876f811` paths assigning each to exactly one reviewer finding, plus invariant, necessity, and exact commit; disclose unavoidable overlaps and list the post-`b876f811` delta separately.
- Product Lead disposition: The broad provenance/link commit must be split before independent review or integration. Isolate Git ownership/retained identity, admission/command fencing, durable unavailable transitions, Agent-authored relative-link routing, and canonical file/artifact provenance as reviewable units; isolate retained-copy recovery or justify its exact shared authority. Drop unrelated redesign or cleanup. Preserve the no-tests policy and exact-head review gate.
- Owner: Agent Working Copies writer; current branch is not frozen or accepted.

## 2026-08-24T06:19:04Z — REL-003 — Native authority design overclaims descendant mutation safety and omits protected authorities

- Severity: Critical
- Classification: Confirmed Phase A0 architecture/security defects; A1 not approved
- Confirmed: Yes — same independent safety reviewer rejected exact A0 head `4b2e743620935d3a78946beee371141b82107f10` with three high- and four medium-severity design findings.
- Findings:
  1. POSIX `unlinkat`/rename remain name-relative after identity verification. A same-user actor can replace an opened child before deletion/replacement, so the contract cannot promise exact identity-conditioned descendant mutation under its declared threat model. Fix requires either an explicit trust boundary or immutable/no-replace names plus non-destructive/offline reclamation.
  2. The protected inventory omits `asset-authority.sqlite` and its journal/WAL/temp/shm files even though that database owns artifact reservations, usage, associations, and audit authority. Root displacement could split artifact bytes from their authority ledger.
  3. The frozen SQLite driver exposes ATTACH URI `vfs=`, `VACUUM INTO`, backup destinations, extension loading, unsafe/raw handle access, and `.name`; these can bypass or reveal the rooted VFS. A process-wide native open barrier and restricted database port/authorizer are required for every rooted connection.
  4. POSIX lease release is last-duplicate-close, not simply parent death; fork/exec inheritance must be prevented and exercised. Windows mutex ownership is thread-affine, requiring non-inheritable handles and one native owner thread with correct abandonment/finalizer behavior.
  5. Filesystem capability detection currently follows possible pathname creation, and mount/reparse crossing enforcement is underspecified. Detection must precede mutation and use platform handle-based equivalents such as Linux `openat2` no-cross/no-symlink resolution.
  6. The permanent compatibility fence lacks an encoding guaranteed to be rejected by known destructive legacy launcher parsers. Upgrade/shutdown must be exercised with the old launcher binary, not only the new no-touch path.
  7. Proposed A1 commits lack one atomic activation boundary: partial heads could enable rooted AgentStore while AssetStore, `projects/**` consumers, or workers still reopen pathname roots. Groundwork must stay dormant until one version-gated cutover; protected worker I/O cannot receive serialized `dataDir`.
- Decision required: Defending configured-root/ancestor rebinding and cooperative Ponderosa contenders is implementable, but defending active same-user descendant namespace replacement requires a stronger privilege/sandbox boundary. Choose an explicit bounded trust model, expand to privileged isolation, or defer Phase A. This decision must precede A0 correction and A1 remains forbidden.
- Confirmed positives: Kernel-managed no-namespace lease direction, retained-root handling for root/ancestor displacement, fail-closed marker contract, stable first run, and explicit macOS/Windows stop gates remain sound design foundations.
- Owner: Product Lead decision, then Reliability/Mobile A0 correction and same-reviewer rereview.

## 2026-08-24T06:20:22Z — OPS-010 — Overflowed review result is poorly discoverable across Agent scope

- Severity: High
- Classification: Confirmed cross-Agent result-discoverability and Chat-summary defect; related to OPS-006 but not a duplicate association failure
- Confirmed: Yes — expanding the Layout Safety Rereviewer message with `Show Full Message` reveals the complete consequential report inline, so the bytes are durably stored and readable. The collapsed Chat projection still shows only `Full result: ponderosa://artifact/text-…`, without its `NOT APPROVED` verdict, summary, or visible artifact action. Product Lead's Files & Results simultaneously reports no result because the managed artifact belongs to the reviewer Agent rather than Product Lead.
- Reproduction: Complete a long exact-head review whose handoff overflows into a reviewer-owned managed text artifact. In Product Lead Chat, observe the opaque raw URI in the collapsed message; expand `Show Full Message` to reveal the report inline. Then open Product Lead Files & Results and observe that the result is absent because that view is Agent-scoped, even though the visible conversation contains the reviewer result.
- Impact: An operator can miss a blocking safety disposition, mistake a raw transport URI for the complete handoff, or search the receiving Agent's Files & Results and conclude that no result exists. The defect is not artifact loss: it is missing compact Chat articulation plus undisclosed cross-Agent ownership/routing that makes the durable result difficult to rediscover.
- Recommended fix: Project a compact structured envelope before overflow: verdict/status, severity counts, top findings, exact reviewed head, required next action, artifact title/size, owning Agent, and a keyboard/screen-reader-accessible `Open full result` action that resolves the owner-scoped artifact from the receiving conversation. Files & Results should either offer conversation-visible cross-Agent results with clear ownership or provide an explicit route to the reviewer Agent's result. Keep the raw transport reference only in expanded diagnostics/copy metadata, and show an explicit receipt if artifact loading fails.
- Owner: Ponderosa correlated-result projection, cross-Agent artifact routing/scope, Files & Results, and Chat UI.

## 2026-08-24T06:22:08Z — REL-003 decision — Explicit bounded root trust selected

- Authority: The operator chose the bounded trust model and explicitly declined privileged isolation/sandbox expansion.
- Protected boundary: Phase A-Native must resist configured-root and ancestor rebinding, accidental namespace changes, and cooperative or competing Ponderosa processes. It must fail closed for unsupported filesystem semantics and preserve the missing/malformed/unknown-marker safety invariant.
- Explicit non-goal: The design must not claim resistance to an actively hostile same-user process mutating descendants inside the already acquired protected root. Such direct host tampering is outside the authority boundary and may cause denial/fail-stop; this is consistent with the product statement that isolation is not a sandbox.
- Required A0 correction: Add the asset-authority database and sidecars; restrict SQLite to a safe port behind a process-wide open barrier; define descriptor/handle non-inheritance and Windows owner-thread behavior; detect filesystem capability before mutation with handle-based no-cross resolution; prove a legacy-rejected compatibility fence; and require dormant groundwork plus one version-gated atomic activation boundary.
- Gate: Corrected A0 documentation only, then same-reviewer exact-head rereview. A1 and Phase B remain forbidden until explicit A0 approval.
- Owner: Reliability/Mobile.
